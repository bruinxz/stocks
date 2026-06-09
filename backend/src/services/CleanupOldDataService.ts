/**
 * US-097 — 旧数据清理服务 (CleanupOldDataService)
 *
 * 把 4 张"会爆库"的表按可配置阈值清理: 旧回测 / 数据同步日志 / 定时任务日志 /
 * 已读告警。**默认 dry-run** — 调用方必须显式传 `dryRun=false` 才真正 DELETE。
 *
 * ============================================================================
 * 设计点
 * ============================================================================
 *
 * 1. **DataSource 注入式架构** (与 US-094 FactorDetailDataSource / US-081
 *    MultiFactorAlphaStrategy IC source 同款) — `CleanupDataSource` 接口
 *    抽 5 个 method (count / delete 各张表), production singleton 接 Sequelize;
 *    测试注入 fake `Map<table, rows[]>` 完全脱 DB.
 *
 * 2. **dryRun 默认 true** — 与 US-086 RebalanceEngine 同款风险面: "破坏性 +
 *    多张表 + 可能上万行 DELETE", caller 必须显式 `dryRun=false` 才真正执行;
 *    与 US-052 IndustryConcentrationGuard (系统应急触发, 默认执行) 形成对比.
 *    CLI 层通过 `--confirm` flag 翻转默认值 (默认 dry-run → 用户加 `--confirm`
 *    才删).
 *
 * 3. **白名单按 strategy_key 跳过回测** — 对 `quant_backtest_tasks` 表生效:
 *    若 task.strategy_keys 与 whitelist 有交集 → 该 task 整条 (含 results +
 *    trades) 跳过. 白名单空 = 不豁免 (全按 cutoff 清). 同 US-083 dryRun set
 *    semantics: 空集合 = default-allow (按 cutoff 清).
 *
 * 4. **per-target try/catch fail-isolation** (与 US-018 TodaySignalsService /
 *    US-096 SystemHealthDetailService 同款) — 任一 target 清理失败 (DB 锁 /
 *    constraint violation), 其他 target 仍继续, 最终 result 带 `errors[]`
 *    列清失败的 target.
 *
 * 5. **cascade DELETE 按业务顺序而非 DB constraint** — quant_backtest_tasks
 *    没有 FK CASCADE 到 results/trades (历史原因, 早期未加), 服务层必须
 *    1) 先取所有 stale task_ids, 2) DELETE trades WHERE task_id IN (...),
 *    3) DELETE results WHERE task_id IN (...), 4) DELETE tasks. 顺序反了
 *    会留下孤儿 results/trades.
 *
 * 6. **阈值正整数 normalize** — `normalizeThresholdDays(value, default)` 把
 *    `'90'` / `90` / `90.5` 都转成 `Math.max(1, Math.floor(Number(value)))`;
 *    非法 / NaN / Infinity / ≤0 → fallback 默认值. 同 US-039 isoDateAddMonths
 *    + US-083 boolean coerce 风格 (严格白名单 + safe default).
 *
 * 7. **cutoff 算法** — `computeCutoffDate(asOf, days)` 返回 `asOf - days`
 *    的 ISO date (`YYYY-MM-DD`); 调用方按 cutoff 删 `created_at < cutoff`.
 *    边界 strict `<` (与 US-082 闸门"合格线"同款语义): cutoff=2026-03-01
 *    的行 (2026-03-01 当日创建的) **不删**, 只删 2026-02-28 及之前; 避免
 *    跨日精度 (DATE vs DATETIME)对齐失误.
 *
 * 8. **报告条数 + cascade 明细分开** — `CleanupResult.targets[].count` 是
 *    该 target 主表 DELETE 行数, `cascade_count` 是 cascade 表 DELETE 总行
 *    数 (回测场景: count=N tasks / cascade_count=M results+trades). 让用户
 *    一眼看出"会清 10 个 task + 自动带走 5000 个 trade".
 *
 * ============================================================================
 * 与既有清理工具的关系
 * ============================================================================
 *
 * - `scripts/backup-db.sh` 自动清 30 天前 .sql.gz 备份 (US-071) — 只管文件,
 *   不管 DB 行; 与本服务正交.
 * - `WalkForwardValidator.cleanupOlderThan` (US-039) 清 walk-forward 嵌套
 *   父子 optimization_runs — 只管"嵌入式优化器"产物; 与本服务的"通用回测任务"
 *   不重叠.
 * - `SchedulerService.reconcileStaleRunningTasks` 把启动时 IN_PROGRESS
 *   的僵死任务标记 FAILED — 是状态修复, 不删行; 与本服务的"按时间清"互补.
 *
 * ============================================================================
 * 使用
 * ============================================================================
 *
 *   import { CleanupOldDataService } from './services/CleanupOldDataService';
 *   const service = new CleanupOldDataService();
 *
 *   // dry-run (默认): 报告 "将清理 N 条" 但不删
 *   const preview = await service.cleanup({});
 *
 *   // 真正执行
 *   const result = await service.cleanup({ dryRun: false });
 *
 *   // 自定义阈值 + 白名单
 *   await service.cleanup({
 *     backtestRetentionDays: 60,
 *     logRetentionDays: 90,
 *     alertRetentionDays: 14,
 *     whitelistStrategies: ['multi_factor_alpha', 'dragon_head'],
 *     dryRun: false,
 *   });
 *
 * CLI: `backend/src/scripts/cleanup-old-data.ts` (`npm run cleanup:old-data`)
 * Scheduler: 每周日凌晨 3 点跑 (CLEANUP_OLD_DATA task type, cron '0 3 * * 0')
 */

import { Op } from 'sequelize';
import { QuantBacktestTask } from '../models/QuantBacktestTask';
import { QuantBacktestResult } from '../models/QuantBacktestResult';
import { QuantBacktestTrade } from '../models/QuantBacktestTrade';
import { DataUpdateLog } from '../models/DataUpdateLog';
import { TaskExecutionLog } from '../models/TaskExecutionLog';
import { RiskAlert } from '../models/RiskAlert';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CleanupOptions {
  /**
   * 回测 (quant_backtest_tasks + 级联 results/trades) 保留天数. 默认 90.
   * 调用者传任何非正整数 / NaN / 字符串 → fallback 90.
   */
  backtestRetentionDays?: number | string;

  /**
   * 数据同步日志 (data_update_logs) 与定时任务日志 (task_execution_logs)
   * 保留天数. 默认 180.
   */
  logRetentionDays?: number | string;

  /**
   * 已读告警 (risk_alerts where is_read=true) 保留天数. 默认 30.
   * 未读告警永不清 (用户可能还没看到, 自动删 = 数据丢失).
   */
  alertRetentionDays?: number | string;

  /**
   * 白名单策略 key 列表 — 若 backtest task.strategy_keys 与此交集非空,
   * 该 task (含 results + trades) 跳过清理. 默认 [] (不豁免).
   */
  whitelistStrategies?: string[];

  /**
   * dry-run 模式. true (默认) → 只统计将清理的条数, 不真正 DELETE;
   * false → 真正 DELETE.
   *
   * **默认 true 是安全选择** — 与 US-086 RebalanceEngine 同款"破坏性多张
   * 表 + 默认 dry-run" 风险面.
   */
  dryRun?: boolean;

  /**
   * 基准时间 (asOf), 默认当前时刻. 测试用; 生产不传.
   */
  asOfDate?: Date;
}

export interface TargetCleanupResult {
  /** target 名 (人类可读) */
  target: string;
  /** 主表预清/已清行数 */
  count: number;
  /**
   * 级联表清理行数 (回测场景: results + trades 合计;
   * 其他 target = 0)
   */
  cascade_count: number;
  /** cutoff ISO date (`YYYY-MM-DD`); 删 `created_at < cutoff` 的行 */
  cutoff: string;
  /** 该 target 是否真正执行 (dryRun=false) — true 表示已 DELETE */
  executed: boolean;
  /**
   * 由于 whitelist 而跳过的行数 (仅回测 target 有效, 其他 target = 0)
   */
  whitelist_skipped: number;
  /** 失败原因 (该 target 失败时填; 其他 target 继续) */
  error?: string;
}

export interface CleanupResult {
  /** 基准时间 ISO */
  as_of: string;
  /** dryRun=true → 'dry_run' / false → 'executed' */
  mode: 'dry_run' | 'executed';
  /** 各 target 清理报告 (4 条) */
  targets: TargetCleanupResult[];
  /** 跨 target 总主表清理行数 (回测/日志/告警 主表合计, 不含 cascade) */
  total_count: number;
  /** 跨 target 总 cascade 行数 (回测 cascade = results+trades) */
  total_cascade_count: number;
  /** 哪些 target 失败了 (target 名 list); 空数组 = 全部成功 */
  errors: string[];
  /**
   * 白名单跳过总行数 (跨 target, 实际只回测 target 会非 0)
   */
  whitelist_skipped_total: number;
}

// ---------------------------------------------------------------------------
// DataSource interface (DI for testing)
// ---------------------------------------------------------------------------

export interface CleanupDataSource {
  /**
   * 找所有 created_at < cutoff 的 backtest tasks, 返回 `{id, strategy_keys}[]`
   * 让 service 层做 whitelist 过滤后决定哪些要删.
   */
  findStaleBacktestTasks(cutoff: Date): Promise<Array<{ id: number; strategy_keys: string[] }>>;

  /**
   * cascade DELETE: trades + results + tasks (按 task_ids list).
   * 返回 `{trades_deleted, results_deleted, tasks_deleted}`.
   */
  deleteBacktestTasksCascade(
    taskIds: number[]
  ): Promise<{ trades_deleted: number; results_deleted: number; tasks_deleted: number }>;

  /**
   * 统计 data_update_logs WHERE created_at < cutoff 的行数
   */
  countStaleDataUpdateLogs(cutoff: Date): Promise<number>;

  /** 真删 data_update_logs WHERE created_at < cutoff, 返回行数 */
  deleteStaleDataUpdateLogs(cutoff: Date): Promise<number>;

  /** 统计 task_execution_logs WHERE created_at < cutoff 的行数 */
  countStaleTaskExecutionLogs(cutoff: Date): Promise<number>;

  /** 真删 task_execution_logs WHERE created_at < cutoff, 返回行数 */
  deleteStaleTaskExecutionLogs(cutoff: Date): Promise<number>;

  /** 统计 risk_alerts WHERE is_read=true AND created_at < cutoff 的行数 */
  countStaleReadRiskAlerts(cutoff: Date): Promise<number>;

  /** 真删 risk_alerts WHERE is_read=true AND created_at < cutoff, 返回行数 */
  deleteStaleReadRiskAlerts(cutoff: Date): Promise<number>;
}

/** Production singleton — 走真实 Sequelize 模型 */
export class DefaultCleanupDataSource implements CleanupDataSource {
  async findStaleBacktestTasks(
    cutoff: Date
  ): Promise<Array<{ id: number; strategy_keys: string[] }>> {
    const rows = await QuantBacktestTask.findAll({
      where: { created_at: { [Op.lt]: cutoff } },
      attributes: ['id', 'strategy_keys'],
      raw: true,
    });
    return rows.map(r => ({
      id: r.id as number,
      strategy_keys: Array.isArray(r.strategy_keys) ? (r.strategy_keys as string[]) : [],
    }));
  }

  async deleteBacktestTasksCascade(taskIds: number[]) {
    if (taskIds.length === 0) {
      return { trades_deleted: 0, results_deleted: 0, tasks_deleted: 0 };
    }
    const trades_deleted = await QuantBacktestTrade.destroy({
      where: { task_id: { [Op.in]: taskIds } },
    });
    const results_deleted = await QuantBacktestResult.destroy({
      where: { task_id: { [Op.in]: taskIds } },
    });
    const tasks_deleted = await QuantBacktestTask.destroy({
      where: { id: { [Op.in]: taskIds } },
    });
    return { trades_deleted, results_deleted, tasks_deleted };
  }

  async countStaleDataUpdateLogs(cutoff: Date): Promise<number> {
    return DataUpdateLog.count({ where: { created_at: { [Op.lt]: cutoff } } });
  }

  async deleteStaleDataUpdateLogs(cutoff: Date): Promise<number> {
    return DataUpdateLog.destroy({ where: { created_at: { [Op.lt]: cutoff } } });
  }

  async countStaleTaskExecutionLogs(cutoff: Date): Promise<number> {
    return TaskExecutionLog.count({ where: { created_at: { [Op.lt]: cutoff } } });
  }

  async deleteStaleTaskExecutionLogs(cutoff: Date): Promise<number> {
    return TaskExecutionLog.destroy({ where: { created_at: { [Op.lt]: cutoff } } });
  }

  async countStaleReadRiskAlerts(cutoff: Date): Promise<number> {
    return RiskAlert.count({
      where: { is_read: true, created_at: { [Op.lt]: cutoff } },
    });
  }

  async deleteStaleReadRiskAlerts(cutoff: Date): Promise<number> {
    return RiskAlert.destroy({
      where: { is_read: true, created_at: { [Op.lt]: cutoff } },
    });
  }
}

const PRODUCTION_DATA_SOURCE: CleanupDataSource = new DefaultCleanupDataSource();

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export const DEFAULT_BACKTEST_RETENTION_DAYS = 90;
export const DEFAULT_LOG_RETENTION_DAYS = 180;
export const DEFAULT_ALERT_RETENTION_DAYS = 30;

/**
 * 把 raw 阈值规范成正整数. 接受 number / numeric string;
 * NaN / Infinity / ≤0 / 非法 string → fallback.
 */
export function normalizeThresholdDays(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.floor(parsed));
}

/**
 * 计算 cutoff Date: asOf - days. 用 UTC 避免本地时区漂移
 * (Sequelize TIMESTAMP WITH TIME ZONE 内部存 UTC).
 */
export function computeCutoffDate(asOf: Date, days: number): Date {
  const out = new Date(asOf);
  out.setUTCDate(out.getUTCDate() - days);
  return out;
}

/**
 * ISO `YYYY-MM-DD` 截取 (UTC).
 */
export function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * 检查 strategy_keys 是否与 whitelist 有交集.
 * - whitelist 空 → 永远返回 false (不豁免)
 * - strategy_keys 空 → false
 * - 任一 strategy_key 在 whitelist 中 → true
 */
export function isWhitelistedTask(
  strategyKeys: string[],
  whitelist: ReadonlyArray<string>
): boolean {
  if (whitelist.length === 0) return false;
  if (strategyKeys.length === 0) return false;
  const set = new Set(whitelist);
  return strategyKeys.some(k => set.has(k));
}

/**
 * 把传入的 whitelist 规范化: 去空 / trim / dedup. 接受 undefined / [] /
 * mixed-case (不做 lowercase, strategy_key 大小写敏感, 与 US-083
 * pickDryRunStrategyKeysFromRecords 同款约定).
 */
export function normalizeWhitelistStrategies(raw: ReadonlyArray<string> | undefined): string[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * 把多个 stale tasks 按 whitelist 分两组. 返回 `{toDelete, skipped}` 都是
 * id 数组, 服务层只对 toDelete 真正调 deleteBacktestTasksCascade.
 */
export function partitionBacktestTasksByWhitelist(
  tasks: Array<{ id: number; strategy_keys: string[] }>,
  whitelist: ReadonlyArray<string>
): { toDelete: number[]; skipped: number[] } {
  const toDelete: number[] = [];
  const skipped: number[] = [];
  for (const t of tasks) {
    if (isWhitelistedTask(t.strategy_keys, whitelist)) {
      skipped.push(t.id);
    } else {
      toDelete.push(t.id);
    }
  }
  return { toDelete, skipped };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class CleanupOldDataService {
  private readonly dataSource: CleanupDataSource;

  constructor(dataSource: CleanupDataSource = PRODUCTION_DATA_SOURCE) {
    this.dataSource = dataSource;
  }

  /**
   * 执行清理 (默认 dry-run). 返回每张表的预清/已清行数 + cascade 明细.
   * 任一 target 失败不阻塞其他, 失败的 target 在 `errors[]` 列出.
   */
  async cleanup(options: CleanupOptions = {}): Promise<CleanupResult> {
    const dryRun = options.dryRun !== false; // 默认 true
    const asOf = options.asOfDate || new Date();
    const backtestDays = normalizeThresholdDays(
      options.backtestRetentionDays,
      DEFAULT_BACKTEST_RETENTION_DAYS
    );
    const logDays = normalizeThresholdDays(options.logRetentionDays, DEFAULT_LOG_RETENTION_DAYS);
    const alertDays = normalizeThresholdDays(
      options.alertRetentionDays,
      DEFAULT_ALERT_RETENTION_DAYS
    );
    const whitelist = normalizeWhitelistStrategies(options.whitelistStrategies);

    const backtestCutoff = computeCutoffDate(asOf, backtestDays);
    const logCutoff = computeCutoffDate(asOf, logDays);
    const alertCutoff = computeCutoffDate(asOf, alertDays);

    logger.info(
      `[CleanupOldDataService] start mode=${dryRun ? 'dry_run' : 'executed'} ` +
        `backtest_cutoff=${toIsoDate(backtestCutoff)} log_cutoff=${toIsoDate(logCutoff)} ` +
        `alert_cutoff=${toIsoDate(alertCutoff)} whitelist=[${whitelist.join(',')}]`
    );

    const targets: TargetCleanupResult[] = [];
    const errors: string[] = [];

    // 1. quant_backtest_tasks + cascade results/trades
    const backtestTarget = await this.cleanupBacktest(backtestCutoff, whitelist, dryRun);
    targets.push(backtestTarget);
    if (backtestTarget.error) errors.push(backtestTarget.target);

    // 2. data_update_logs
    const dulTarget = await this.cleanupSimpleTable(
      'data_update_logs',
      logCutoff,
      dryRun,
      d => this.dataSource.countStaleDataUpdateLogs(d),
      d => this.dataSource.deleteStaleDataUpdateLogs(d)
    );
    targets.push(dulTarget);
    if (dulTarget.error) errors.push(dulTarget.target);

    // 3. task_execution_logs
    const telTarget = await this.cleanupSimpleTable(
      'task_execution_logs',
      logCutoff,
      dryRun,
      d => this.dataSource.countStaleTaskExecutionLogs(d),
      d => this.dataSource.deleteStaleTaskExecutionLogs(d)
    );
    targets.push(telTarget);
    if (telTarget.error) errors.push(telTarget.target);

    // 4. risk_alerts (已读 + cutoff)
    const alertTarget = await this.cleanupSimpleTable(
      'risk_alerts',
      alertCutoff,
      dryRun,
      d => this.dataSource.countStaleReadRiskAlerts(d),
      d => this.dataSource.deleteStaleReadRiskAlerts(d)
    );
    targets.push(alertTarget);
    if (alertTarget.error) errors.push(alertTarget.target);

    const total_count = targets.reduce((sum, t) => sum + t.count, 0);
    const total_cascade_count = targets.reduce((sum, t) => sum + t.cascade_count, 0);
    const whitelist_skipped_total = targets.reduce((sum, t) => sum + t.whitelist_skipped, 0);

    logger.info(
      `[CleanupOldDataService] done mode=${dryRun ? 'dry_run' : 'executed'} ` +
        `total_count=${total_count} total_cascade=${total_cascade_count} ` +
        `whitelist_skipped=${whitelist_skipped_total} errors=${errors.length}`
    );

    return {
      as_of: asOf.toISOString(),
      mode: dryRun ? 'dry_run' : 'executed',
      targets,
      total_count,
      total_cascade_count,
      errors,
      whitelist_skipped_total,
    };
  }

  private async cleanupBacktest(
    cutoff: Date,
    whitelist: ReadonlyArray<string>,
    dryRun: boolean
  ): Promise<TargetCleanupResult> {
    const target = 'quant_backtest_tasks';
    try {
      const stale = await this.dataSource.findStaleBacktestTasks(cutoff);
      const { toDelete, skipped } = partitionBacktestTasksByWhitelist(stale, whitelist);

      if (dryRun) {
        // dry-run 模式下无法 count cascade rows (要查 trades + results 表统计),
        // 这里为了不引入额外 DB query, cascade_count = 0; CLI / scheduler 报告
        // 写明 "dry-run cascade_count=0 仅预清主表条数, 实际执行后才有 cascade
        // 行数".
        return {
          target,
          count: toDelete.length,
          cascade_count: 0,
          cutoff: toIsoDate(cutoff),
          executed: false,
          whitelist_skipped: skipped.length,
        };
      }

      if (toDelete.length === 0) {
        // 真执行模式但无 stale (或全被白名单豁免) — 仍 executed=true
        // 反映"已执行清理决策"而非"实际 DELETE 行数 > 0".
        return {
          target,
          count: 0,
          cascade_count: 0,
          cutoff: toIsoDate(cutoff),
          executed: true,
          whitelist_skipped: skipped.length,
        };
      }

      const { trades_deleted, results_deleted, tasks_deleted } =
        await this.dataSource.deleteBacktestTasksCascade(toDelete);
      return {
        target,
        count: tasks_deleted,
        cascade_count: trades_deleted + results_deleted,
        cutoff: toIsoDate(cutoff),
        executed: true,
        whitelist_skipped: skipped.length,
      };
    } catch (err: any) {
      logger.error(`[CleanupOldDataService] backtest cleanup failed: ${err?.message || err}`);
      return {
        target,
        count: 0,
        cascade_count: 0,
        cutoff: toIsoDate(cutoff),
        executed: false,
        whitelist_skipped: 0,
        error: err?.message || String(err),
      };
    }
  }

  private async cleanupSimpleTable(
    target: string,
    cutoff: Date,
    dryRun: boolean,
    countFn: (cutoff: Date) => Promise<number>,
    deleteFn: (cutoff: Date) => Promise<number>
  ): Promise<TargetCleanupResult> {
    try {
      const count = dryRun ? await countFn(cutoff) : await deleteFn(cutoff);
      return {
        target,
        count,
        cascade_count: 0,
        cutoff: toIsoDate(cutoff),
        executed: !dryRun,
        whitelist_skipped: 0,
      };
    } catch (err: any) {
      logger.error(`[CleanupOldDataService] ${target} cleanup failed: ${err?.message || err}`);
      return {
        target,
        count: 0,
        cascade_count: 0,
        cutoff: toIsoDate(cutoff),
        executed: false,
        whitelist_skipped: 0,
        error: err?.message || String(err),
      };
    }
  }
}

export const cleanupOldDataService = new CleanupOldDataService();
