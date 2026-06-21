/**
 * DailyAttributionCronRunner — US-083 [PM-006] DAILY_ATTRIBUTION_GENERATE cron 主入口
 *
 * 工作日 17:00 (盘后 + DAILY_UPDATE 18:00 前) 给所有 active paper trading portfolio
 * 生成 6 维归因 (factor / industry / timing / selection / sizing / execution_cost)
 * 报告并 upsert 到 `daily_attribution_reports` (单 portfolio 一天一行, status='ok'/
 * 'skipped'/'failed' 全部落库做留痕).
 *
 * 设计遵循 services/CLAUDE.md 的 "多通道 dispatcher / fail-OPEN" 模板:
 *   (1) DailyAttributionCronDataSource interface 把所有 I/O 抽干净
 *       - listActivePortfolios(): 枚举待归因 portfolio
 *       - persistReport(row): upsert 一行到 daily_attribution_reports
 *   (2) PRODUCTION_DAILY_ATTRIBUTION_CRON_DATA_SOURCE singleton lazy-require
 *       PaperTradingPortfolio / DailyAttributionReport
 *   (3) 单测注入 fake DataSource 完整覆盖 happy + skipped + failed + dry_run +
 *       persist 失败 fail-OPEN 不需起 DB
 *   (4) 主入口 try/catch 顶层兜底 + per-portfolio try/catch — 单 portfolio 失败
 *       continue 不阻塞 batch (与 PAPER_TRADING_DAILY_SNAPSHOT cron 同模式)
 *
 * 与 DailyAttributionService 的边界:
 *   - DailyAttributionService.generateDailyReport() 是单 portfolio 归因生成主入口
 *     (本身已 fail-OPEN, 返 {status, report, reason?}).
 *   - 本 runner 是 cron 批量驱动 + 持久化层, 把 service 输出落 DailyAttributionReport
 *     表 (PM-003 schema), 并按 portfolio 维度聚合 ok/skipped/failed 统计返
 *     SchedulerService 写 execution_log.
 *
 * 关键不变量:
 *   - dry_run=true 时**不**调 persistReport (仅返聚合结果 + 触发 service 算数)
 *   - persist 失败计入 failed 计数但不 throw (永不阻塞下个 portfolio)
 *   - 单 portfolio service 内部 throw 已被 fail-OPEN 转 status='failed', 极端
 *     程序错误 (e.g. 顶层 service 实例 require 失败) 由 per-portfolio try/catch 兜
 */

import { logger } from '../../utils/logger';
import {
  DAILY_ATTRIBUTION_STATUS,
  DailyAttributionDataSource,
  DailyAttributionReport,
  DailyAttributionRunResult,
  DailyAttributionStatus,
  GenerateDailyReportOptions,
  dailyAttributionService,
  normalizeAttributionDate,
} from './DailyAttributionService';
import {
  DailyAttributionFeishuPushService,
  DailyAttributionPushOptions,
  DailyAttributionPushResult,
  dailyAttributionFeishuPushService,
} from './DailyAttributionFeishuPushService';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 默认 cron 触发的 `source` 值, 写入 DailyAttributionReport.source */
export const DAILY_ATTRIBUTION_CRON_SOURCE = 'cron';

/** dry_run 默认值 — cron 默认实际写入, 与 PAPER_TRADING_DAILY_SNAPSHOT 对齐 */
export const DEFAULT_DAILY_ATTRIBUTION_CRON_DRY_RUN = false;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 一条 cron 触发的 portfolio 处理结果 (供 SchedulerService 写 execution_log) */
export interface DailyAttributionCronPortfolioResult {
  portfolio_id: number;
  status: DailyAttributionStatus | 'persist_failed';
  reason?: string;
  /** persist 失败 / service 失败时的错误信息, 不含 stack */
  error?: string;
  /** 是否真正写入了 daily_attribution_reports (dry_run / persist_failed → false) */
  persisted: boolean;
}

/** 整批 cron 运行聚合结果 */
export interface DailyAttributionCronRunSummary {
  total_portfolios: number;
  ok_count: number;
  skipped_count: number;
  failed_count: number;
  /** 真正落库 (status=ok + 非 dry_run + persist 成功) 的笔数 */
  persisted_count: number;
  date: string;
  dry_run: boolean;
  /** 单 portfolio 明细 (调用方按需写 execution_log.result_summary) */
  per_portfolio: DailyAttributionCronPortfolioResult[];
  /**
   * US-086 [PM-009] — 当 enable_feishu_push !== false 时, 把当日 status='ok' 且
   * persist 成功的 portfolio report 顺序 fan-out 到 OPS 飞书群; 失败 fail-OPEN
   * 不影响 ok/skipped/failed 计数. push=null 表示本批未触发推送 (e.g. 显式关闭 /
   * dry_run / 没有可推送的 portfolio).
   */
  feishu_push: DailyAttributionPushResult | null;
}

/** cron 入口 options — 透传给 DailyAttributionService + 控制 dry_run / portfolio 范围 */
export interface RunDailyAttributionGenerateOptions {
  /** 'YYYY-MM-DD'; 默认今日 (Asia/Shanghai) — 透传给 generateDailyReport */
  date?: string;
  /** 显式 list portfolio_id; 空 / undefined 时枚举所有 is_active=true */
  portfolio_ids?: number[];
  /** dry_run=true 时不调 persistReport, 仅返聚合结果 */
  dry_run?: boolean;
  /**
   * 单测 / 灰度时可注入 fake cron-side DataSource, 默认走 PRODUCTION lazy-require.
   */
  cron_data_source?: DailyAttributionCronDataSource;
  /**
   * 单测 / 灰度时可注入 fake service-side DataSource (透传给 generateDailyReport).
   */
  service_data_source?: DailyAttributionDataSource;
  /**
   * 透传给 generateDailyReport — caller 准备好 Brinson-Fachler input 时填.
   * 默认 cron 不准备(各 portfolio benchmark 配置散落, PM-005 后续优化).
   */
  attribution_engine_input?: GenerateDailyReportOptions['attribution_engine_input'];
  /**
   * 透传给 generateDailyReport — 默认 cron 跑零 AI 链路走 heuristic
   * ('off' 强制关闭), caller 显式传 source 时启 LLM.
   */
  ai_summary_source?: GenerateDailyReportOptions['ai_summary_source'];
  /** override DailyAttributionReport.source 字段 (默认 'cron') */
  source?: string;
  /**
   * US-086 [PM-009] — 整批 cron 跑完后是否触发飞书 push (status=ok+persisted).
   * 默认 true (cron 跑完即推, 与 PRD AC §E.1 "17:35 前送达" 时窗对齐);
   * 显式 false → 跳过 push 通道 (灰度 / 演练); dry_run=true 时 push 自然 skip.
   */
  enable_feishu_push?: boolean;
  /** override OPS 飞书 webhook 配置 / cap, 默认走 env OPS_ALERT_FEISHU_WEBHOOK */
  feishu_push_options?: DailyAttributionPushOptions;
  /** 单测 / 灰度时可注入 fake push service, 默认走 PRODUCTION singleton */
  feishu_push_service?: DailyAttributionFeishuPushService;
}

/** Cron-side DataSource — 独立于 DailyAttributionService 的 service-side DataSource */
export interface DailyAttributionCronDataSource {
  /** 枚举待归因 portfolio_id; cron 默认 is_active=true 全部 */
  listActivePortfolios(): Promise<Array<{ id: number; user_id: number }>>;
  /**
   * Upsert 一行到 daily_attribution_reports (date, portfolio_id) 唯一.
   * 返 {ok:true} / {ok:false, reason, error?} — 永不 throw, fail-OPEN 由 caller 兜底.
   */
  persistReport(input: {
    portfolio_id: number;
    date: string;
    source: string;
    result: DailyAttributionRunResult;
  }): Promise<{ ok: boolean; reason?: string; error?: string }>;
}

// ---------------------------------------------------------------------------
// PRODUCTION DataSource — lazy require 让单测进程不需要 sequelize 起 DB
// ---------------------------------------------------------------------------

export function createProductionDailyAttributionCronDataSource(): DailyAttributionCronDataSource {
  return {
    async listActivePortfolios() {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { PaperTradingPortfolio } = require('../../models/PaperTradingPortfolio');
        const rows = await PaperTradingPortfolio.findAll({
          where: { is_active: true },
          attributes: ['id', 'user_id'],
          raw: true,
        });
        return (rows as Array<{ id: number; user_id: number }>).map(r => ({
          id: Number(r.id),
          user_id: Number(r.user_id),
        }));
      } catch (err) {
        logger.warn(
          `[daily-attribution-cron] listActivePortfolios failed: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        return [];
      }
    },
    async persistReport({ portfolio_id, date, source, result }) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { DailyAttributionReport } = require('../../models/DailyAttributionReport');
        const row = buildPersistRow({ portfolio_id, date, source, result });
        // (portfolio_id, date) 唯一; updateOnDuplicate 覆盖最新结果(idempotent 重跑)
        await DailyAttributionReport.upsert(row);
        return { ok: true };
      } catch (err) {
        logger.warn(
          `[daily-attribution-cron] persistReport portfolio=${portfolio_id} date=${date} failed: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        return {
          ok: false,
          reason: 'persist_failed',
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

const PRODUCTION_DAILY_ATTRIBUTION_CRON_DATA_SOURCE: DailyAttributionCronDataSource =
  createProductionDailyAttributionCronDataSource();

// ---------------------------------------------------------------------------
// pure helper — service result → DailyAttributionReport 行映射
// ---------------------------------------------------------------------------

/**
 * 把 DailyAttributionRunResult 映射成 daily_attribution_reports 表一行.
 * - status='ok' 时 report 字段齐, 直接抽 6 维 + best/worst + ai_summary
 * - status='skipped'/'failed' 时 report=null, 用占位 0 / '' 写一行做"今日未跑"留痕
 *   (与 PRD US-080 AC "表里有当日记录" 对齐 — 哪怕跳过 / 失败也有行).
 */
export function buildPersistRow(input: {
  portfolio_id: number;
  date: string;
  source: string;
  result: DailyAttributionRunResult;
}): Record<string, unknown> {
  const { portfolio_id, date, source, result } = input;
  const report = result.report;
  const now = new Date();
  if (report) {
    return {
      portfolio_id,
      date,
      total_pnl: report.total_pnl,
      total_pnl_pct: report.total_pnl_pct,
      realized_pnl: report.realized_pnl,
      unrealized_delta: report.unrealized_delta,
      trade_count: report.trade_count,
      buy_count: report.buy_count,
      sell_count: report.sell_count,
      breakdown: report.breakdown,
      best_trades: report.best_trades,
      worst_trades: report.worst_trades,
      ai_summary: report.ai_summary,
      bias_findings: [],
      recommendations: [],
      status: result.status,
      reason: result.reason ?? null,
      metadata: {
        generated_at: report.generated_at,
        source,
      },
      generated_at: report.generated_at ? new Date(report.generated_at) : now,
      source,
    };
  }
  // skipped / failed 留痕行 — 全零 + status + reason
  return {
    portfolio_id,
    date,
    total_pnl: 0,
    total_pnl_pct: null,
    realized_pnl: 0,
    unrealized_delta: 0,
    trade_count: 0,
    buy_count: 0,
    sell_count: 0,
    breakdown: {},
    best_trades: [],
    worst_trades: [],
    ai_summary: '',
    bias_findings: [],
    recommendations: [],
    status: result.status,
    reason: result.reason ?? null,
    metadata: {
      source,
      error: result.error ?? null,
    },
    generated_at: now,
    source,
  };
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * Cron 入口 — 枚举所有 active portfolio, 逐个 generateDailyReport + persistReport.
 *
 * fail-OPEN 双层:
 *   1. service 内部已 fail-OPEN (report.status='failed') — caller 拿到 result 一律走 persist
 *   2. persist 失败 → status='persist_failed' 计入 failed_count 但 continue 下一个 portfolio
 *
 * dry_run=true 时跳过 persistReport, 仅返聚合结果做 cron preview 用.
 */
export async function runDailyAttributionGenerate(
  options: RunDailyAttributionGenerateOptions = {}
): Promise<DailyAttributionCronRunSummary> {
  const cronSource = options.cron_data_source || PRODUCTION_DAILY_ATTRIBUTION_CRON_DATA_SOURCE;
  const date = normalizeAttributionDate(options.date);
  const dryRun = options.dry_run === true;
  const source =
    typeof options.source === 'string' && options.source.length > 0
      ? options.source
      : DAILY_ATTRIBUTION_CRON_SOURCE;

  // 枚举 portfolio 范围 — 显式 list 优先, 否则枚举 active
  let targets: Array<{ id: number; user_id: number }> = [];
  if (Array.isArray(options.portfolio_ids) && options.portfolio_ids.length > 0) {
    targets = options.portfolio_ids
      .filter(id => Number.isFinite(id) && Number(id) > 0)
      .map(id => ({ id: Number(id), user_id: 0 }));
  } else {
    try {
      targets = await cronSource.listActivePortfolios();
    } catch (err) {
      logger.warn(
        `[daily-attribution-cron] listActivePortfolios threw (treat as empty): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      targets = [];
    }
  }

  const summary: DailyAttributionCronRunSummary = {
    total_portfolios: targets.length,
    ok_count: 0,
    skipped_count: 0,
    failed_count: 0,
    persisted_count: 0,
    date,
    dry_run: dryRun,
    per_portfolio: [],
    feishu_push: null,
  };

  // US-086 PM-009 — 累计 status=ok+persisted 的 portfolio report, 收尾批量 push.
  const pushItems: Array<{ portfolio_id: number; report: DailyAttributionReport }> = [];

  for (const target of targets) {
    const portfolioId = target.id;
    let result: DailyAttributionRunResult;
    try {
      result = await dailyAttributionService.generateDailyReport(portfolioId, {
        date,
        ...(options.service_data_source ? { data_source: options.service_data_source } : {}),
        ...(options.attribution_engine_input !== undefined
          ? { attribution_engine_input: options.attribution_engine_input }
          : {}),
        // cron 默认零 AI 链路 (heuristic 已足)
        ai_summary_source: options.ai_summary_source ?? 'off',
      });
    } catch (err) {
      // service 自身 fail-OPEN 不该 throw — 兜底转 failed
      logger.warn(
        `[daily-attribution-cron] generateDailyReport portfolio=${portfolioId} threw: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      result = {
        status: DAILY_ATTRIBUTION_STATUS.FAILED,
        report: null,
        reason: 'service_threw',
        error: err instanceof Error ? err.message : String(err),
      };
    }

    let persisted = false;
    let persistReason: string | undefined;
    let persistError: string | undefined;
    if (!dryRun) {
      try {
        const persistRes = await cronSource.persistReport({
          portfolio_id: portfolioId,
          date,
          source,
          result,
        });
        if (persistRes.ok) {
          persisted = true;
        } else {
          persistReason = persistRes.reason || 'persist_failed';
          persistError = persistRes.error;
        }
      } catch (err) {
        logger.warn(
          `[daily-attribution-cron] persistReport portfolio=${portfolioId} threw: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        persistReason = 'persist_threw';
        persistError = err instanceof Error ? err.message : String(err);
      }
    }

    // 最终 status 优先级: persist 失败 > service status — 单 portfolio 单计一次
    const finalStatus: DailyAttributionCronPortfolioResult['status'] = persistReason
      ? 'persist_failed'
      : result.status;
    if (finalStatus === DAILY_ATTRIBUTION_STATUS.OK) summary.ok_count += 1;
    else if (finalStatus === DAILY_ATTRIBUTION_STATUS.SKIPPED) summary.skipped_count += 1;
    else summary.failed_count += 1;
    if (persisted) summary.persisted_count += 1;
    // 仅 status=ok 且持久化成功的 portfolio 才入 push 队列 (skipped/failed/persist_failed
    // 一律不推, 避免空报告 push 风暴; dry_run 时 persisted=false 自然跳过)
    if (persisted && finalStatus === DAILY_ATTRIBUTION_STATUS.OK && result.report) {
      pushItems.push({ portfolio_id: portfolioId, report: result.report });
    }

    summary.per_portfolio.push({
      portfolio_id: portfolioId,
      status: finalStatus,
      reason: persistReason ?? result.reason,
      error: persistError ?? result.error,
      persisted,
    });
  }

  // US-086 PM-009 — 收尾批量飞书 push (顺序 fan-out). 仅 status=ok+persisted
  // 入队; enable_feishu_push !== false 默认 true; dry_run 路径 pushItems=空也走 push
  // service 让其内部走 no_records skip 分支 (统一可观测性). push fail-OPEN 不
  // 影响 ok/skipped/failed 计数 (本通道只是通知, 失败 ops 仍可走表查).
  if (options.enable_feishu_push !== false) {
    try {
      const pushService = options.feishu_push_service || dailyAttributionFeishuPushService;
      const pushResult = await pushService.pushBatch(
        pushItems,
        // dry_run 透传给 push 让其内部走 dry_run skip 分支不真发
        { ...(options.feishu_push_options || {}), ...(dryRun ? { dry_run: true } : {}) }
      );
      summary.feishu_push = pushResult;
    } catch (err) {
      // pushService.pushBatch 自身已 fail-OPEN 不抛, 但防 caller 注入 fake 抛异常
      logger.warn(
        `[daily-attribution-cron] feishu push threw (treat as fail-OPEN): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      summary.feishu_push = {
        scanned: pushItems.length,
        attempted: 0,
        succeeded: 0,
        failed: 0,
        skipped_reason: 'top_level_error',
        items: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return summary;
}

// 测试 / 调试用 — 暴露 PRODUCTION singleton 让外部 wiring 测试可拿到默认实例
export const __PRODUCTION_DAILY_ATTRIBUTION_CRON_DATA_SOURCE_FOR_TEST =
  PRODUCTION_DAILY_ATTRIBUTION_CRON_DATA_SOURCE;

// re-export 让 caller 单 import 完整 cron entry + service report 类型
export type { DailyAttributionReport };
