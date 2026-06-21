/**
 * ReconciliationAlertService — BETA-2 (2026-06-18, audit S-12)
 *
 * 之前对账只在用户 GET `/api/live-trading/reconciliation` 页面时触发，**没有任何
 * 主动告警**；live_only / paper_only 漂移可能数日无人发现。本服务定时跑对账
 * + 阈值评估，把"高漂移 / 高数量差 / 快照过期"转写为 RiskAlert HIGH/MEDIUM，
 * 让 RiskAlert.afterCreate hook 自动 fire RealtimeAlertDispatcher 推送飞书。
 *
 * AC 阈值（见 audit S-12）：
 *  - alignment_score < 70  →  HIGH
 *  - live_only + paper_only > 3  →  HIGH
 *  - snapshot_age_minutes > LIVE_RECONCILIATION_STALE_MINUTES → HIGH (status='stale')
 *  - alignment_score in [70, 85) 或差异在 1-3 → MEDIUM
 *
 * 设计要点（与 risk/ 一致）：
 *  - 每用户独立 try/catch 隔离（一个用户 paper-only / 数据异常不阻塞其它）
 *  - paper-only 用户（无 live position 且账户未绑定）自动 skip，不消耗 alert 配额
 *  - dedup：30 min 同 (symbols_hash, severity) 不重复告警（用 risk_config 持久化）
 *  - 失败 fail-OPEN：getReconciliation 抛错时记 warning + 跳过该 user
 *  - RealtimeAlertDispatcher dedup 由 RiskAlert.rule_id='live_reconciliation' 自动接管
 */

import crypto from 'crypto';
import { logger } from '../../utils/logger';
import {
  incrementReconciliationAlert,
  recordReconciliationSnapshot,
} from '../../metrics/PrometheusRegistry';
import { liveTradingService } from './LiveTradingService';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { LiveBrokerAccount } = require('../../models/LiveBrokerAccount');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { RiskAlert } = require('../../models/RiskAlert');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { User } = require('../../models/User');

export type ReconciliationAlertSeverity = 'HIGH' | 'MEDIUM' | 'NONE';

export interface ReconciliationAlertOptions {
  /** 时间窗口标签 — 仅用于 alert message，不影响计算 */
  window?: 'intraday' | 'eod';
  /** 限定单一 user_id（默认扫所有绑定 live account 的用户） */
  user_id?: number;
  /** dry_run=true 只评估不写 RiskAlert */
  dry_run?: boolean;
  /** dedup 时窗（ms），默认 30 分钟 */
  dedupe_window_ms?: number;
}

export interface ReconciliationAlertUserResult {
  user_id: number;
  scanned: boolean;
  severity: ReconciliationAlertSeverity;
  alignment_score: number | null;
  live_only_count: number;
  paper_only_count: number;
  snapshot_age_minutes: number | null;
  alert_written: boolean;
  alert_id?: number;
  deduped?: boolean;
  signature?: string;
  reason?: string;
  error?: string;
}

export interface ReconciliationAlertRunResult {
  evaluated_at: string;
  window: 'intraday' | 'eod';
  dry_run: boolean;
  total_users: number;
  scanned_users: number;
  high_count: number;
  medium_count: number;
  deduped_count: number;
  alerts_written: number;
  per_user: ReconciliationAlertUserResult[];
}

const DEDUPE_WINDOW_MS_DEFAULT = 30 * 60 * 1000;
const RULE_ID = 'live_reconciliation';
const SYMBOL_HIGH = 'SYSTEM:LIVE_RECONCILIATION_HIGH';
const SYMBOL_MEDIUM = 'SYSTEM:LIVE_RECONCILIATION_MEDIUM';
const SYMBOL_STALE = 'SYSTEM:LIVE_RECONCILIATION_STALE';

// ---------------------------------------------------------------------------
//  US-137 [EX-012] — ReconciliationAlertConfig 阈值持久化
// ---------------------------------------------------------------------------

/**
 * 用户级 reconciliation 告警阈值. US-137 [EX-012] 之前阈值硬编码 (HIGH<70 /
 * MEDIUM<85 / drift>3 / drift>=1), 操盘手没法把"日内 3 仓位漂移"调成"日内 5
 * 仓位漂移" 类的容差. 本配置把 4 个阈值 + 启用 + dedup 窗口持久化到
 * User.risk_config.live_reconciliation_alert JSONB, 与 US-047 / US-048 / US-052
 * 等 8 个 guard 同款 "lenient normalize + JSONB + getConfig/updateConfig"
 * 范式 (RiskParametersCenterTab 一站编辑).
 *
 * 决策表 (保持与 v1 hardcoded 同语义 — 用户没改 → DEFAULT_* 后行为不变):
 *  - severity=HIGH ↔ alignment_score < alignment_score_high_threshold
 *                  OR drift_sum > drift_count_high_threshold
 *  - severity=MEDIUM ↔ alignment_score < alignment_score_medium_threshold
 *                   OR drift_sum >= drift_count_medium_threshold
 *  - 否则 NONE.
 * Stale 路由 (snapshot_age_minutes > stale_threshold_minutes 由 LiveTrading
 * 自身参数控制) 不在此 config 范围.
 */
export interface ReconciliationAlertConfig {
  /** 主开关 — false 时整 user 跳过, runForUser 直接返 NONE+reason=disabled. */
  enabled: boolean;
  /** alignment_score < 此值 → HIGH (与 drift_count_high_threshold OR). 默认 70. */
  alignment_score_high_threshold: number;
  /** alignment_score < 此值 → MEDIUM (与 drift_count_medium_threshold OR). 默认 85. */
  alignment_score_medium_threshold: number;
  /** live_only+paper_only > 此值 → HIGH. 默认 3 (严格 >; 4 仓漂移触发). */
  drift_count_high_threshold: number;
  /** live_only+paper_only >= 此值 → MEDIUM. 默认 1 (>=; 1 仓漂移触发). */
  drift_count_medium_threshold: number;
  /** 同 (symbols_hash, severity) signature 多久内不重复告警 (分钟). 默认 30. */
  dedupe_window_minutes: number;
}

/**
 * US-137 [EX-012] — Object.freeze 与 8 个 guard 同款; 用户没改 → 走默认行为
 * 与 v1 hardcoded 完全一致 (回归 zero-cost).
 */
export const DEFAULT_RECONCILIATION_ALERT_CONFIG: ReconciliationAlertConfig = Object.freeze({
  enabled: true,
  alignment_score_high_threshold: 70,
  alignment_score_medium_threshold: 85,
  drift_count_high_threshold: 3,
  drift_count_medium_threshold: 1,
  dedupe_window_minutes: 30,
});

/**
 * US-137 [EX-012] lenient normalize — 与 US-047 normalizePositionLimitsConfig
 * / US-053 normalizeBlackSwanConfig 同款 "非法值沉默回退默认, 不抛 4xx".
 * UI InputNumber 软提示 min/max, backend 兜底.
 */
export function normalizeReconciliationAlertConfig(raw: any): ReconciliationAlertConfig {
  const safeBool = (v: any, fb: boolean): boolean => (typeof v === 'boolean' ? v : fb);
  const safeNumber = (
    v: any,
    fb: number,
    opts: { min?: number; max?: number; integer?: boolean } = {}
  ): number => {
    const num = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(num)) return fb;
    if (opts.integer && !Number.isInteger(num)) return fb;
    if (opts.min !== undefined && num < opts.min) return fb;
    if (opts.max !== undefined && num > opts.max) return fb;
    return num;
  };
  // 容错: object/null 都允许 (老 user 没设过 → raw=undefined)
  const r = raw && typeof raw === 'object' ? raw : {};
  const normalized: ReconciliationAlertConfig = {
    enabled: safeBool(r.enabled, DEFAULT_RECONCILIATION_ALERT_CONFIG.enabled),
    alignment_score_high_threshold: safeNumber(
      r.alignment_score_high_threshold,
      DEFAULT_RECONCILIATION_ALERT_CONFIG.alignment_score_high_threshold,
      { min: 0, max: 100 }
    ),
    alignment_score_medium_threshold: safeNumber(
      r.alignment_score_medium_threshold,
      DEFAULT_RECONCILIATION_ALERT_CONFIG.alignment_score_medium_threshold,
      { min: 0, max: 100 }
    ),
    drift_count_high_threshold: safeNumber(
      r.drift_count_high_threshold,
      DEFAULT_RECONCILIATION_ALERT_CONFIG.drift_count_high_threshold,
      { min: 0, max: 100, integer: true }
    ),
    drift_count_medium_threshold: safeNumber(
      r.drift_count_medium_threshold,
      DEFAULT_RECONCILIATION_ALERT_CONFIG.drift_count_medium_threshold,
      { min: 0, max: 100, integer: true }
    ),
    dedupe_window_minutes: safeNumber(
      r.dedupe_window_minutes,
      DEFAULT_RECONCILIATION_ALERT_CONFIG.dedupe_window_minutes,
      { min: 1, max: 24 * 60, integer: true }
    ),
  };
  // 内部一致性兜底: medium 阈值不应小于 high (high<70/medium<85 才有梯度), 反过来
  // medium <= high 会让 MEDIUM 永远先被 HIGH 决策覆盖。用户写错 → 静默 swap.
  if (normalized.alignment_score_medium_threshold < normalized.alignment_score_high_threshold) {
    normalized.alignment_score_medium_threshold = normalized.alignment_score_high_threshold;
  }
  if (normalized.drift_count_medium_threshold > normalized.drift_count_high_threshold) {
    normalized.drift_count_medium_threshold = normalized.drift_count_high_threshold;
  }
  return normalized;
}

/**
 * 按对账结果生成 (severity, symbol, hash signature)。
 *
 *  - HIGH: alignment_score<70 / live_only+paper_only>3 (用户可调阈值, US-137)
 *  - HIGH stale: snapshot_age_minutes>stale_threshold
 *  - MEDIUM: 70 ≤ alignment_score < 85 或 漂移 1-3 (用户可调阈值, US-137)
 *  - NONE: 健康
 *
 * US-137 [EX-012] thresholds 参数可选 — 缺省走 DEFAULT_RECONCILIATION_ALERT_CONFIG,
 * 行为与 v1 hardcoded 完全等价 (单测既有 case 0 改动).
 */
export function classifyReconciliation(input: {
  alignment_score: number | null;
  live_only_count: number;
  paper_only_count: number;
  snapshot_age_minutes: number | null;
  stale_threshold_minutes: number;
  status: string;
  thresholds?: ReconciliationAlertConfig;
}): { severity: ReconciliationAlertSeverity; reason: string; symbol: string } {
  const driftSum = (input.live_only_count || 0) + (input.paper_only_count || 0);
  const ageOk =
    input.snapshot_age_minutes === null ||
    input.snapshot_age_minutes <= input.stale_threshold_minutes;
  if (input.status === 'stale' || !ageOk) {
    return {
      severity: 'HIGH',
      reason: `快照过期 (${input.snapshot_age_minutes}m > ${input.stale_threshold_minutes}m)`,
      symbol: SYMBOL_STALE,
    };
  }
  if (input.alignment_score === null) {
    // not_bound / no_snapshot 不当 alert（paper-only 用户）
    return { severity: 'NONE', reason: 'not_bound / no_snapshot', symbol: SYMBOL_HIGH };
  }
  const cfg = input.thresholds || DEFAULT_RECONCILIATION_ALERT_CONFIG;
  if (
    input.alignment_score < cfg.alignment_score_high_threshold ||
    driftSum > cfg.drift_count_high_threshold
  ) {
    return {
      severity: 'HIGH',
      reason: `alignment_score=${input.alignment_score} drift=${driftSum}`,
      symbol: SYMBOL_HIGH,
    };
  }
  if (
    input.alignment_score < cfg.alignment_score_medium_threshold ||
    driftSum >= cfg.drift_count_medium_threshold
  ) {
    return {
      severity: 'MEDIUM',
      reason: `alignment_score=${input.alignment_score} drift=${driftSum}`,
      symbol: SYMBOL_MEDIUM,
    };
  }
  return { severity: 'NONE', reason: 'aligned', symbol: SYMBOL_MEDIUM };
}

/**
 * 把 position_matches 的 symbol 列表稳定 hash → dedup signature 一部分。
 * 同一组差异 symbols 30 min 内不重复告警；调仓后 symbols 变 → signature 变 → 重新告警。
 */
export function computeSymbolsHash(
  positionMatches: Array<{ symbol: string; status: string }>
): string {
  const driftSyms = positionMatches
    .filter(p =>
      ['live_only', 'paper_only', 'live_overweight', 'live_underweight'].includes(p.status)
    )
    .map(p => `${p.status}:${p.symbol}`)
    .sort();
  if (driftSyms.length === 0) return 'aligned';
  return crypto.createHash('sha1').update(driftSyms.join('|')).digest('hex').slice(0, 12);
}

/** 拉某用户 risk_config.live_reconciliation_seen LRU，每条 {sig, pushed_at_ms}。 */
async function loadSeen(user_id: number): Promise<Array<{ sig: string; pushed_at_ms: number }>> {
  try {
    const user = await User.findByPk(user_id, { attributes: ['id', 'risk_config'] });
    if (!user) return [];
    const cfg = (user as any).risk_config || {};
    const seen = cfg.live_reconciliation_seen;
    return Array.isArray(seen) ? seen.slice(0, 200) : [];
  } catch (e: any) {
    logger.warn(
      `[ReconciliationAlert] loadSeen user=${user_id} failed (fail-open dedup=false): ${
        e?.message || e
      }`
    );
    return [];
  }
}

async function saveSeen(
  user_id: number,
  seen: Array<{ sig: string; pushed_at_ms: number }>
): Promise<void> {
  try {
    const user = await User.findByPk(user_id);
    if (!user) return;
    const cfg = { ...(((user as any).risk_config as Record<string, any>) || {}) };
    cfg.live_reconciliation_seen = seen.slice(-200);
    (user as any).risk_config = cfg;
    user.changed('risk_config', true);
    await user.save();
  } catch (e: any) {
    logger.warn(
      `[ReconciliationAlert] saveSeen user=${user_id} failed (fail-open): ${e?.message || e}`
    );
  }
}

/** 在 seen LRU 中查 signature 是否在 dedup 窗口内已推送过。 */
export function isSignatureFresh(
  seen: Array<{ sig: string; pushed_at_ms: number }>,
  signature: string,
  windowMs: number,
  nowMs: number
): boolean {
  for (const entry of seen) {
    if (entry.sig === signature && nowMs - entry.pushed_at_ms < windowMs) return true;
  }
  return false;
}

export class ReconciliationAlertService {
  /**
   * 跑单 user 评估 + 写告警。所有 try/catch 包好，失败返回 {error}。
   */
  async runForUser(
    user_id: number,
    options: ReconciliationAlertOptions = {}
  ): Promise<ReconciliationAlertUserResult> {
    const window = options.window || 'intraday';
    // US-137 [EX-012] — 先拉用户阈值, dedupe_window_ms 优先级:
    //   1) options.dedupe_window_ms (调用方显式 override)
    //   2) cfg.dedupe_window_minutes (持久化的用户偏好)
    //   3) DEDUPE_WINDOW_MS_DEFAULT (老硬编码 30min, fail-OPEN)
    let cfg: ReconciliationAlertConfig = DEFAULT_RECONCILIATION_ALERT_CONFIG;
    try {
      cfg = await this.getConfig(user_id);
    } catch (e: any) {
      // fail-OPEN — 配置拉失败仍走默认阈值, 不阻塞告警 cron
      logger.warn(
        `[ReconciliationAlert] loadConfig user=${user_id} failed (fail-open use default): ${
          e?.message || e
        }`
      );
    }
    if (!cfg.enabled) {
      return {
        user_id,
        scanned: false,
        severity: 'NONE',
        alignment_score: null,
        live_only_count: 0,
        paper_only_count: 0,
        snapshot_age_minutes: null,
        alert_written: false,
        reason: 'disabled by user config (US-137 EX-012)',
      };
    }
    const dedupeWindowMs =
      options.dedupe_window_ms || cfg.dedupe_window_minutes * 60 * 1000 || DEDUPE_WINDOW_MS_DEFAULT;
    const dryRun = options.dry_run === true;
    try {
      const reconciliation = await liveTradingService.getReconciliation(user_id, {});
      const summary: any = reconciliation.summary || {};
      const alignmentScore = Number.isFinite(summary.alignment_score)
        ? Number(summary.alignment_score)
        : null;
      const liveOnly = Number(summary.live_only_count || 0);
      const paperOnly = Number(summary.paper_only_count || 0);
      const snapshotAge = Number.isFinite(reconciliation.snapshot_age_minutes as any)
        ? Number(reconciliation.snapshot_age_minutes)
        : null;
      const staleThreshold = Number(reconciliation.stale_threshold_minutes || 180);

      const classification = classifyReconciliation({
        alignment_score: alignmentScore,
        live_only_count: liveOnly,
        paper_only_count: paperOnly,
        snapshot_age_minutes: snapshotAge,
        stale_threshold_minutes: staleThreshold,
        status: String(reconciliation.status || ''),
        thresholds: cfg, // US-137 [EX-012] 真用用户阈值, 缺省 fallback DEFAULT
      });

      // US-017 [EX-003]: 把当前对账快照写入 Prometheus gauge 系列（无论 severity 如何，
      // 让 Grafana 即使 NONE 也有曲线）。recordReconciliationSnapshot 已 fail-OPEN
      // (内部 try/catch)，主流程不会被 metric 拖死.
      // 漂移按 4 个 side 聚合：position_matches.filter(status).reduce(...).
      // live_only / paper_only 用 summary 中已聚合的 count；overweight / underweight
      // 走 position_matches 二次聚合 (LiveTradingService 不在 summary 暴露).
      try {
        const driftBySide: Record<string, number> = {
          live_only: liveOnly,
          paper_only: paperOnly,
          live_overweight: 0,
          live_underweight: 0,
        };
        for (const pm of reconciliation.position_matches || []) {
          if (pm.status === 'live_overweight') driftBySide.live_overweight += 1;
          else if (pm.status === 'live_underweight') driftBySide.live_underweight += 1;
        }
        recordReconciliationSnapshot(user_id, alignmentScore, driftBySide, snapshotAge);
      } catch (e: any) {
        logger.warn(
          `[ReconciliationAlert] metric record user=${user_id} failed (fail-open): ${
            e?.message || e
          }`
        );
      }

      if (classification.severity === 'NONE') {
        // US-017 [EX-003]: 健康跑过也记 counter，让 Grafana 看"上次 evaluate 是几分钟前"
        // (e.g. `time() - (max(rate(reconciliation_alerts_total[1h])) > 0)` 报警 cron 卡死).
        incrementReconciliationAlert('NONE', window);
        return {
          user_id,
          scanned: true,
          severity: 'NONE',
          alignment_score: alignmentScore,
          live_only_count: liveOnly,
          paper_only_count: paperOnly,
          snapshot_age_minutes: snapshotAge,
          alert_written: false,
          reason: classification.reason,
        };
      }

      const symbolsHash = computeSymbolsHash(reconciliation.position_matches || []);
      const signature = `${classification.severity}::${symbolsHash}::${window}`;

      // dedup 评估
      const seen = await loadSeen(user_id);
      const nowMs = Date.now();
      const deduped = isSignatureFresh(seen, signature, dedupeWindowMs, nowMs);

      if (deduped || dryRun) {
        return {
          user_id,
          scanned: true,
          severity: classification.severity,
          alignment_score: alignmentScore,
          live_only_count: liveOnly,
          paper_only_count: paperOnly,
          snapshot_age_minutes: snapshotAge,
          alert_written: false,
          deduped,
          signature,
          reason: deduped
            ? `dedup hit within ${dedupeWindowMs / 60000}m`
            : `dry_run, would alert ${classification.severity}`,
        };
      }

      // 构造 message: 包含差异 symbol 列表 (前 10) 让 ops 一眼看清
      const driftSyms = (reconciliation.position_matches || [])
        .filter((p: any) =>
          ['live_only', 'paper_only', 'live_overweight', 'live_underweight'].includes(p.status)
        )
        .slice(0, 10);
      const driftStr = driftSyms
        .map(
          (p: any) =>
            `${p.symbol}(${p.status},live=${p.live_quantity || 0},paper=${p.paper_quantity || 0})`
        )
        .join('; ');
      const message =
        `🧮 实盘/模拟对账 [${window}] ` +
        `${classification.severity}: ${classification.reason}. ` +
        `详情: ${driftStr}${driftSyms.length === 10 ? '; +more' : ''}`;

      const alert = await RiskAlert.create({
        user_id,
        symbol: classification.symbol,
        name: '实盘/模拟对账漂移告警',
        level: classification.severity,
        rule_id: RULE_ID,
        message,
        metadata: {
          window,
          alignment_score: alignmentScore,
          live_only_count: liveOnly,
          paper_only_count: paperOnly,
          snapshot_age_minutes: snapshotAge,
          stale_threshold_minutes: staleThreshold,
          drift_symbols: driftSyms.map((p: any) => ({
            symbol: p.symbol,
            status: p.status,
            live_quantity: p.live_quantity,
            paper_quantity: p.paper_quantity,
            weight_gap_pct: p.weight_gap_pct,
          })),
          signature,
        },
      });

      seen.push({ sig: signature, pushed_at_ms: nowMs });
      await saveSeen(user_id, seen);

      // US-017 [EX-003]: 写出告警的 severity 计数（HIGH / MEDIUM），window 维度区分
      // 盘中 vs 收盘后告警风暴.
      incrementReconciliationAlert(classification.severity, window);

      return {
        user_id,
        scanned: true,
        severity: classification.severity,
        alignment_score: alignmentScore,
        live_only_count: liveOnly,
        paper_only_count: paperOnly,
        snapshot_age_minutes: snapshotAge,
        alert_written: true,
        alert_id: alert?.id,
        signature,
        reason: classification.reason,
      };
    } catch (err: any) {
      logger.warn(
        `[ReconciliationAlert] runForUser user=${user_id} failed: ${err?.message || err}`
      );
      return {
        user_id,
        scanned: false,
        severity: 'NONE',
        alignment_score: null,
        live_only_count: 0,
        paper_only_count: 0,
        snapshot_age_minutes: null,
        alert_written: false,
        error: err?.message || String(err),
      };
    }
  }

  /**
   * 主入口 — 扫所有绑定 live account 的用户 (paper-only 自动 skip)。
   */
  async runOnce(options: ReconciliationAlertOptions = {}): Promise<ReconciliationAlertRunResult> {
    const window = options.window || 'intraday';
    const dryRun = options.dry_run === true;
    const perUser: ReconciliationAlertUserResult[] = [];

    let userIds: number[] = [];
    if (options.user_id) {
      userIds = [Number(options.user_id)];
    } else {
      try {
        const accounts = await LiveBrokerAccount.findAll({
          where: { is_active: true },
          attributes: ['user_id'],
          raw: true,
        });
        userIds = Array.from(
          new Set(accounts.map((a: any) => Number(a.user_id)).filter((n: number) => n > 0))
        );
      } catch (e: any) {
        logger.warn(`[ReconciliationAlert] LiveBrokerAccount.findAll failed: ${e?.message || e}`);
      }
    }

    for (const uid of userIds) {
      const r = await this.runForUser(uid, options);
      perUser.push(r);
    }

    const high = perUser.filter(r => r.severity === 'HIGH').length;
    const medium = perUser.filter(r => r.severity === 'MEDIUM').length;
    const deduped = perUser.filter(r => r.deduped).length;
    const written = perUser.filter(r => r.alert_written).length;

    return {
      evaluated_at: new Date().toISOString(),
      window,
      dry_run: dryRun,
      total_users: userIds.length,
      scanned_users: perUser.filter(r => r.scanned).length,
      high_count: high,
      medium_count: medium,
      deduped_count: deduped,
      alerts_written: written,
      per_user: perUser,
    };
  }

  /**
   * US-137 [EX-012] — 读用户当前 reconciliation 告警阈值配置. 与 8 个 risk guard
   * 同款 (US-047 / US-048 / US-049 / US-050 / US-051 / US-052 / US-053 / US-054)
   * "normalize 后返默认值兜底" 模式: 老 user 没设过 / risk_config.live_reconciliation_alert
   * 为 null → 返 DEFAULT_RECONCILIATION_ALERT_CONFIG 副本, UI 显示 default 占位.
   */
  async getConfig(user_id: number): Promise<ReconciliationAlertConfig> {
    const user = await User.findByPk(user_id, { attributes: ['id', 'risk_config'] });
    const raw = (user as any)?.risk_config?.live_reconciliation_alert;
    return normalizeReconciliationAlertConfig(raw);
  }

  /**
   * US-137 [EX-012] — 持久化 reconciliation 阈值. lenient normalize (非法字段
   * 沉默回退) 与 US-047 / US-053 等同款; 调用方在 UI InputNumber 软提示 min/max,
   * backend 不抛 4xx. JSONB 写法用 `changed('risk_config', true)` (Sequelize
   * JSONB 列必须显式 mark dirty, 与 US-017 lesson 同).
   */
  async updateConfig(user_id: number, raw: any): Promise<ReconciliationAlertConfig> {
    const normalized = normalizeReconciliationAlertConfig(raw);
    const user = await User.findByPk(user_id);
    if (!user) {
      throw new Error(`updateConfig: user ${user_id} not found`);
    }
    const merged = {
      ...((user as any).risk_config || {}),
      live_reconciliation_alert: {
        ...(((user as any).risk_config || {}).live_reconciliation_alert || {}),
        ...normalized,
      },
    };
    (user as any).risk_config = merged;
    user.changed('risk_config', true);
    await user.save();
    return { ...normalized };
  }
}

export const reconciliationAlertService = new ReconciliationAlertService();
