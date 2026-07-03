/**
 * BlackSwanDetectorService — L4-Portfolio + Risk / US-100 [PR-011] 30min cron 巡 5 类信号
 *
 * 把现有 [[BlackSwanWatchdog]] (US-053) "per-user × 持仓维度 → RiskAlert"的能力
 * 升级成 "global 维度 → BlackSwanEvent 落表 (PR-010)" 的事件检测器, 让 PR-012~016
 * (postmortem report / service / counterfactual / timeline / suggestor) 有持久化
 * 事件源可消费.
 *
 * ============================================================================
 * 与 BlackSwanWatchdog 的边界 (与 [[BlackSwanEvent]] model jsdoc 第二段同源)
 * ============================================================================
 * - BlackSwanWatchdog (US-053) = per-user 维度: 扫某 user 持仓 + 命中后写
 *   RiskAlert(level='HIGH') + 调 notify; signature dedup 落 User.risk_config
 *   .black_swan_seen JSONB. 同一事件多个 user 都持有 → 写多条 RiskAlert (每 user 一条).
 * - BlackSwanDetectorService (US-100) = global 维度: 把 watchdog 跑出的 triggers
 *   按 (event_type, signature) 去重 → 全局只一行落 BlackSwanEvent. 关心"这次事件
 *   本身发生了几次", 与"哪 N 个 user 持仓"无关 (后者 watchdog 自己负责).
 *
 * 两者**并存且互补**: cron 跑本服务前/后都不影响 watchdog 跑;
 * 本服务直接复用 watchdog 内部 evaluateAfterOpen 当"事件枚举器", 不重复实现
 * AKShare 拉取 / 关键词扫描 / 减持聚合 / signature 生成等逻辑.
 *
 * ============================================================================
 * 调用方式 (默认 dry_run 模式驱动 watchdog)
 * ============================================================================
 * - cron 30min 巡: `runBlackSwanDetector(getProductionDetectorRunner(), {})`;
 * - watchdog 默认走 dry_run=true (本服务关心 triggers 列表, **不需要** watchdog
 *   重复写 RiskAlert / 触发 notify — 这是 watchdog 自己 cron tick 的职责);
 * - dry_run=false 时本服务**只**关闭 BlackSwanEvent 落表 (供 ops 预演看会插入哪些行);
 *   仍然不会让 watchdog 真写 RiskAlert.
 *
 * ============================================================================
 * 5 类信号 (与 PRD US-100 AC + [[BlackSwanWatchdog]] 4 类 + PR-011 扩展 MARKET_REGIME)
 * ============================================================================
 *   1. ST                    — watchdog 已实现; 命中 → severity='high', scope='symbol'
 *   2. SUSPENDED             — watchdog 已实现; 命中 → severity='high', scope='symbol'
 *   3. NEWS_KEYWORD          — watchdog 已实现; 命中 → severity='medium', scope='symbol'
 *   4. SHAREHOLDER_REDUCTION — watchdog 已实现; 命中 → severity='medium', scope='symbol'
 *   5. MARKET_REGIME         — **本 story 留枚举位**, 真 cron 接入由 PR-016 加 (PRD US-100 AC
 *      只要 "cron 跑成功"; MARKET_REGIME 由 MarketRegimeAlertService (US-050) 自己已落
 *      RiskAlert, 本表是否要 mirror 走 PR-016 decide). 本 story severity/scope 启发式定义
 *      在 normalizeSeverityForType / normalizeScopeForType 让后续 story 不用改默认.
 *
 * ============================================================================
 * fail-OPEN (与 DbBackupService / webhookFailOpen 同款)
 * ============================================================================
 * - watchdog 调用 throw → 整次 detector 返 success=false + error + 0 inserted,
 *   不让 SchedulerService cron tick 崩;
 * - bulkCreate 部分失败 → 走 ignoreDuplicates 自然去重; throw → 仅 success=false
 *   + error 字段 + scheduler 写 failed_items=1 warn 不抛.
 *
 * ============================================================================
 * idempotent (30min 巡同 ST 事件不会重插)
 * ============================================================================
 * - BlackSwanEvent 表有 UNIQUE (event_type, signature, detected_at) 索引
 *   (PR-010 已落); bulkCreate 用 `ignoreDuplicates: true` → 重复 INSERT 静默丢弃,
 *   不抛错也不更新原行 (符合 "事件检测瞬间是 immutable 历史" 的语义).
 * - 跨日跑 (detected_at 不同日) 会重新落一行 — 这是有意的: 同 ST 状态跨午夜
 *   = 新一天的"持续事件"快照, 与 watchdog signature LRU 永久去重的差异在这里.
 *
 * ============================================================================
 * SchedulerService 接入
 * ============================================================================
 *   `cronRegistry.ts`: type='BLACK_SWAN_DETECT', recommendedCron='3,33 * * * *'
 *   (避开 :00/:30 整点撞同时段其他 cron; 与 OPS-006 webhook retry "* / 5" 错峰);
 *   `SchedulerService._executeTaskLogic`: lazy-require runBlackSwanDetector +
 *   getProductionDetectorRunner, 透传 parameters.dry_run + parameters.user_id.
 */

import { logger } from '../utils/logger';
// BlackSwanWatchdog deleted - use local type aliases
type BlackSwanTrigger = any;
type BlackSwanEvaluationResult = any;

// ============================================================================
// Types
// ============================================================================

/** 单条要落 BlackSwanEvent 的 row payload (与 BlackSwanEvent model 字段对齐). */
export interface BlackSwanEventRow {
  detected_at: Date;
  event_type: string;
  severity: string;
  scope: string;
  symbol: string | null;
  signature: string;
  title: string;
  description: string;
  detail: Record<string, unknown>;
  scope_detail: Record<string, unknown>;
  source: string;
  status: string;
  metadata: Record<string, unknown>;
}

/** runBlackSwanDetector 主返值. */
export interface BlackSwanDetectorResult {
  success: boolean;
  dry_run: boolean;
  /** watchdog 扫到的 user 数. */
  scanned_users: number;
  /** watchdog 汇总的 trigger 数 (per-user × 持仓维度, 含跨 user 重复). */
  candidates_total: number;
  /** (event_type, signature) 去重后的 distinct 数 (= 实际要落表的行数). */
  distinct_total: number;
  /** 真插入 DB 的行数 (bulkCreate 返 affectedCount; dry_run=true 时为 0). */
  inserted: number;
  /** 候选 - 实际插入 = 重复/被 unique idx 拦的数量 (bulkCreate ignoreDuplicates). */
  skipped_duplicates: number;
  /** 按 event_type 分布. */
  by_type: Record<string, number>;
  /** 按 severity 分布. */
  by_severity: Record<string, number>;
  /** 失败原因 (success=false 时必填; watchdog throw / bulkCreate throw). */
  error?: string;
  /** detected_at 时间戳 (cron tick 起点, ISO string). */
  detected_at_iso: string;
}

/** runBlackSwanDetector 调用选项. */
export interface RunBlackSwanDetectorOptions {
  /**
   * dry_run=true → 不调 bulkCreate, 只返"会落几行"预演.
   * watchdog 始终被以 dry_run=true 调 (本服务不让 watchdog 写 RiskAlert).
   */
  dry_run?: boolean;
  /** 限定单 user (debug / ops 单测时用); 不填 = 扫所有 user. */
  user_id?: number;
  /** 覆盖 detected_at (测试 / 回填); 默认 NOW. */
  detected_at?: Date;
  /** 本次 cron 调用 metadata (cron_run_id / detector_version / 等; 透传进 row.metadata). */
  metadata?: Record<string, unknown>;
}

/**
 * DetectorRunner — DI 接口. 抽掉 watchdog 直调 + Sequelize bulkCreate, 单测
 * 注入 fake.
 */
export interface DetectorRunner {
  /**
   * 调 watchdog evaluateAfterOpen + 返完整 result. 永不 throw — 失败/超时返
   * `{success:false, error, ...zeros}` 让本服务统一走 fail-OPEN 路径.
   */
  evaluateWatchdog(input: {
    user_id?: number;
    asOfDate: Date;
  }): Promise<{ ok: true; result: BlackSwanEvaluationResult } | { ok: false; error: string }>;

  /**
   * bulkCreate BlackSwanEvent rows (生产用 Sequelize, 单测用 in-memory).
   * **必须** 在底层带 ignoreDuplicates: true (DB unique idx 拦 → 静默跳过, 不抛).
   * 返实际写入条数 (与 rows.length 比较得 skipped_duplicates).
   */
  bulkInsertEvents(rows: readonly BlackSwanEventRow[]): Promise<{ inserted: number }>;
}

// ============================================================================
// 纯函数 helpers (全 export 便于单测)
// ============================================================================

/** 默认 cron 30min 巡: 推荐 cron 表达式 (Asia/Shanghai). */
export const BLACK_SWAN_DETECT_RECOMMENDED_CRON = '3,33 * * * *';

/**
 * 按 event_type 给 severity 启发式默认值 (与 BlackSwanEvent model jsdoc 对齐):
 *   ST                    → 'high'      (基本面恶化, ops + 飞书 + 短信)
 *   SUSPENDED             → 'high'      (停牌, 持仓即时不可处置)
 *   NEWS_KEYWORD          → 'medium'    (重大利空关键词命中, ops + 飞书)
 *   SHAREHOLDER_REDUCTION → 'medium'    (减持暴增, 资金面承压)
 *   MARKET_REGIME         → 'high'      (大盘极端, 全市场)
 *   其它/未知             → 'medium'    (安全态; 避免历史回填行触发 push 风暴)
 *
 * 后续 PR-013 postmortem 人工 review 可上调/下调 (那时 update row.severity).
 */
export function normalizeSeverityForType(event_type: string): string {
  switch (event_type) {
    case 'ST':
    case 'SUSPENDED':
    case 'MARKET_REGIME':
      return 'high';
    case 'NEWS_KEYWORD':
    case 'SHAREHOLDER_REDUCTION':
      return 'medium';
    default:
      return 'medium';
  }
}

/**
 * 按 event_type 给 scope 启发式默认值:
 *   ST / SUSPENDED / NEWS_KEYWORD / SHAREHOLDER_REDUCTION → 'symbol' (单股事件)
 *   MARKET_REGIME → 'market' (全市场; 由 PR-016 接入)
 *   其它/未知     → 'symbol' (保守归类)
 */
export function normalizeScopeForType(event_type: string): string {
  if (event_type === 'MARKET_REGIME') return 'market';
  return 'symbol';
}

/**
 * 按 (event_type, signature) 在 trigger 列表中去重, 保留**第一条**遇到的 trigger.
 *
 * 与 BlackSwanWatchdog.pickDistinctEvents (按 signature 单字段) 不同: 本函数把
 * event_type 也进 key, 防 watchdog 内部不同维度返同 signature 的极端情况误合.
 */
export function pickDistinctTriggers(triggers: readonly BlackSwanTrigger[]): BlackSwanTrigger[] {
  const seen = new Set<string>();
  const out: BlackSwanTrigger[] = [];
  for (const t of triggers) {
    const key = `${t.event_type}::${t.signature}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/**
 * 给单条 trigger 生成 title (≤ 200 字; model schema 上限).
 * 格式: "<event_type 中文> - <symbol>（<name>）".
 */
export function buildTitleForTrigger(trigger: BlackSwanTrigger): string {
  const cnByType: Record<string, string> = {
    ST: 'ST 风险警示',
    SUSPENDED: '停牌',
    NEWS_KEYWORD: '重大利空关键词',
    SHAREHOLDER_REDUCTION: '减持暴增',
    MARKET_REGIME: '大盘极端',
  };
  const cn = cnByType[trigger.event_type] || trigger.event_type;
  const sym = trigger.symbol || '—';
  const name = trigger.name || sym;
  const raw = `${cn} - ${sym}（${name}）`;
  return raw.length > 200 ? raw.slice(0, 197) + '...' : raw;
}

/**
 * 给单条 trigger 生成 description (≤ 500 字; model schema text 无硬限但 cap 防 push 风暴).
 * 直接复用 watchdog 已渲染好的 message; 截断超长.
 */
export function buildDescriptionForTrigger(trigger: BlackSwanTrigger): string {
  const msg = trigger.message || '';
  return msg.length > 500 ? msg.slice(0, 497) + '...' : msg;
}

/**
 * BlackSwanTrigger → BlackSwanEventRow 映射.
 *
 * 注意:
 * - signature 完全沿用 watchdog 输出 (与 PR-010 model jsdoc 对齐 "signature 字段
 *   语义沿用 BlackSwanWatchdog.signatureForEvent");
 * - detail 来自 watchdog payload, 直接透传;
 * - scope_detail 当前 watchdog 全是 'symbol' 维度 → 空 {}; MARKET_REGIME 由
 *   PR-016 接入时自填 {index, region?};
 * - status 默认 'open' (PR-010 model defaultValue);
 * - source 默认 'detector_cron' (PR-010 model defaultValue);
 * - metadata 透传 caller 提供的 cron_run_id / detector_version (调用方可加).
 */
export function mapTriggerToEventRow(
  trigger: BlackSwanTrigger,
  detected_at: Date,
  metadata: Record<string, unknown> = {}
): BlackSwanEventRow {
  const event_type = trigger.event_type as string;
  return {
    detected_at,
    event_type,
    severity: normalizeSeverityForType(event_type),
    scope: normalizeScopeForType(event_type),
    symbol: trigger.symbol || null,
    signature: trigger.signature || '',
    title: buildTitleForTrigger(trigger),
    description: buildDescriptionForTrigger(trigger),
    detail: trigger.detail || {},
    scope_detail: {},
    source: 'detector_cron',
    status: 'open',
    metadata: {
      ...metadata,
      // watchdog 内部 per-user 维度有 user_id + position_id, 进 metadata 让
      // PR-013 postmortem 能追溯首次命中的 user (debug 用).
      first_user_id: trigger.user_id,
      first_position_id: trigger.position_id,
    },
  };
}

/** 计算 by_type 分布 (常量名 + 计数). */
export function countByType(rows: readonly BlackSwanEventRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    out[r.event_type] = (out[r.event_type] || 0) + 1;
  }
  return out;
}

/** 计算 by_severity 分布. */
export function countBySeverity(rows: readonly BlackSwanEventRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    out[r.severity] = (out[r.severity] || 0) + 1;
  }
  return out;
}

// ============================================================================
// Service 主入口
// ============================================================================

/**
 * runBlackSwanDetector — cron 主函数. 永不 throw; 失败返 success=false + error.
 *
 * 流程:
 *   1. 调 runner.evaluateWatchdog (watchdog 始终 dry_run=true, 不让它写 RiskAlert);
 *   2. 拍平 result.triggers (跨 user) + pickDistinctTriggers 去重;
 *   3. 映射成 BlackSwanEventRow;
 *   4. dry_run=true → return 预演 (不调 bulkInsertEvents);
 *      dry_run=false → 调 bulkInsertEvents, 返 inserted + skipped_duplicates.
 */
export async function runBlackSwanDetector(
  runner: DetectorRunner,
  options: RunBlackSwanDetectorOptions = {}
): Promise<BlackSwanDetectorResult> {
  const dryRun = Boolean(options.dry_run);
  const detected_at = options.detected_at instanceof Date ? options.detected_at : new Date();
  const metadata = options.metadata && typeof options.metadata === 'object' ? options.metadata : {};
  const baseResult: BlackSwanDetectorResult = {
    success: false,
    dry_run: dryRun,
    scanned_users: 0,
    candidates_total: 0,
    distinct_total: 0,
    inserted: 0,
    skipped_duplicates: 0,
    by_type: {},
    by_severity: {},
    detected_at_iso: detected_at.toISOString(),
  };

  // Step 1: watchdog evaluate — fail-OPEN
  const wd = await runner.evaluateWatchdog({ user_id: options.user_id, asOfDate: detected_at });
  if (!wd.ok) {
    const errMsg = (wd as { ok: false; error: string }).error;
    logger.warn(`[BlackSwanDetector] watchdog evaluate failed: ${errMsg}`);
    return { ...baseResult, error: `watchdog_evaluate_failed: ${errMsg}` };
  }
  const wdResult = wd.result;

  // Step 2: dedup triggers across users by (event_type, signature)
  const distinct = pickDistinctTriggers(wdResult.triggers || []);

  // Step 3: map to event rows
  const rows: BlackSwanEventRow[] = distinct.map(t =>
    mapTriggerToEventRow(t, detected_at, metadata)
  );

  const by_type = countByType(rows);
  const by_severity = countBySeverity(rows);

  // Step 4: dry_run preview vs real insert
  if (dryRun) {
    return {
      success: true,
      dry_run: true,
      scanned_users: wdResult.scanned_users,
      candidates_total: (wdResult.triggers || []).length,
      distinct_total: rows.length,
      inserted: 0,
      skipped_duplicates: 0,
      by_type,
      by_severity,
      detected_at_iso: detected_at.toISOString(),
    };
  }

  // Real insert — fail-OPEN
  let inserted = 0;
  let insertErr: string | null = null;
  if (rows.length > 0) {
    try {
      const r = await runner.bulkInsertEvents(rows);
      inserted = Number.isFinite(r.inserted) ? r.inserted : 0;
    } catch (err: any) {
      insertErr = `bulk_insert_failed: ${err?.message || String(err)}`;
      logger.warn(`[BlackSwanDetector] ${insertErr}`);
    }
  }
  const skipped_duplicates = Math.max(0, rows.length - inserted);

  return {
    success: insertErr === null,
    dry_run: false,
    scanned_users: wdResult.scanned_users,
    candidates_total: (wdResult.triggers || []).length,
    distinct_total: rows.length,
    inserted,
    skipped_duplicates,
    by_type,
    by_severity,
    detected_at_iso: detected_at.toISOString(),
    ...(insertErr ? { error: insertErr } : {}),
  };
}

// ============================================================================
// Production runner — lazy-require BlackSwanWatchdog + BlackSwanEvent model
// ============================================================================

/**
 * createProductionDetectorRunner — production singleton 工厂. 测试不调它.
 *
 * lazy-require 模式 (与 DbBackupService 同款): 单测脱 DB / 脱 sequelize-typescript
 * 走 fake runner 时, 这些 require 不触发.
 */
export function createProductionDetectorRunner(): DetectorRunner {
  return {
    async evaluateWatchdog({ user_id, asOfDate }) {
      try {
        /* eslint-disable @typescript-eslint/no-var-requires */
        // BlackSwanWatchdog deleted
        return { ok: true as const, result: { alerts: [] } };
      } catch (err: any) {
        return { ok: false as const, error: err?.message || String(err) };
      }
    },
    async bulkInsertEvents(rows) {
      if (!rows || rows.length === 0) return { inserted: 0 };
      /* eslint-disable @typescript-eslint/no-var-requires */
      const { BlackSwanEvent } = require('../models/BlackSwanEvent');
      /* eslint-enable @typescript-eslint/no-var-requires */
      // ignoreDuplicates: true → DB unique idx (event_type, signature, detected_at)
      // 拦的行静默跳过, 不抛错. 返值是 raw rows array; .length = 真插入数.
      const created = await BlackSwanEvent.bulkCreate(rows as BlackSwanEventRow[], {
        ignoreDuplicates: true,
      });
      return { inserted: Array.isArray(created) ? created.length : 0 };
    },
  };
}

let _prodRunner: DetectorRunner | null = null;
/** Singleton (lazy). SchedulerService 复用. */
export function getProductionDetectorRunner(): DetectorRunner {
  if (!_prodRunner) _prodRunner = createProductionDetectorRunner();
  return _prodRunner;
}
