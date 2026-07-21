/**
 * MarketRegimeAlertService — US-050 + US-132
 *
 * 大盘市场环境预警 — 每日开盘后扫描上证指数（默认 sh.000001）的关键
 * 风险信号，按 4 类指标输出告警并建议降仓（仅 alert，不强制下单）：
 *
 *   1. **3 日累计跌幅 > 5%**      → MEDIUM  (建议降仓 30%)
 *   2. **月度跌幅 (20 个交易日) > 15%** → HIGH   (建议降仓 30%)
 *   3. **MA20 下穿 MA60 (死叉)**  → MEDIUM  (建议降仓 30%)
 *   4. **连续 N 日 跌停股 > M (US-132 [PR-017])** → CRITICAL (全市场暂停建仓)
 *      默认 N=3 日 / M=100 只。触发后 symbol='SYSTEM:MARKET_REGIME_HALT_BUY'
 *      level=CRITICAL，前端 / preTradeGuards 可按 sentinel symbol 查表后
 *      直接拒绝新 BUY (短期 hard rule, 配置开关 enable_halt_buy_on_panic)。
 *
 * 与 US-047 (PositionLimitGuard) / US-048 (TrailingStopGuard) / US-049
 * (DrawdownCircuitBreaker) 互补的**第 4 类风控形态** —— 不是 per-position /
 * portfolio-level，而是 **market-level**（输入是指数 bars 而非用户持仓）。
 *
 * 触发流程：
 *   (1) `evaluateAfterOpen()` — 每日开盘后定时任务：
 *       - 从 DailyBar 取上证指数最近 ~80 个交易日的 closes（覆盖 60-MA + 缓冲）；
 *       - 依次评估 3 类信号；每个信号独立判定，多个可同时触发；
 *       - 每个触发的信号 → 给所有有 portfolio 的用户写一条 RiskAlert
 *         (symbol='SYSTEM:MARKET_REGIME_<TYPE>', level='MEDIUM'/'HIGH'，
 *         同 US-042 / US-049 SYSTEM: sentinel 约定，前端按 prefix 过滤
 *         区分组合级 / 系统级告警 vs 个股告警)；
 *       - **不**直接调用 facade.placeOrder — 仅写告警让用户决定是否降仓，
 *         与 US-049 LEVEL_2/LEVEL_3 trigger 模式对齐（guard 输出建议 /
 *         caller 决定撮合）；
 *   (2) `getMarketRegimeStatus()` — HTTP endpoint 提供实时查询：
 *       - 同 `evaluateAfterOpen` 的评估流程但只读 + 不写 RiskAlert；
 *       - 供 UI dashboard / 风控面板展示当前指数健康度（return_3d / 20d /
 *         MA20 vs MA60 / 已触发的 alert list）；
 *
 * 设计约束 — 沿用 US-047/US-048/US-049 的 risk-guard 7+11 项 checklist：
 *   - DataSource 接口注入（生产 Sequelize + 测试 fake bag，完全脱离 DB）；
 *   - 纯函数 helper 全 export 让单测无需 DB（computeReturnPct /
 *     computeMovingAverage / detectDeathCross / pickRegimeAlerts /
 *     normalizeMarketRegimeAlertConfig / buildAlertMessage）；
 *   - 配置在 User.risk_config.market_regime JSONB + Object.freeze 默认；
 *   - 写 RiskAlert 失败 try/catch + logger.warn 不掩盖 trigger 返回；
 *   - 单 user 写入失败 try/catch 隔离不阻塞剩余 user（同 US-042 / US-049）；
 *   - HTTP 入口 GET /api/risk/market-regime-status，与现有 risk endpoints
 *     共 namespace；
 *   - SchedulerService 单 task type: PAPER_TRADING_MARKET_REGIME_CHECK
 *     (开盘后 cron, dry_run=true 支持 UI 预演)；
 *   - 不破坏 facade 收敛 — 输出告警 + suggestion，不触发任何 SELL；
 *
 * 边界与坑：
 *   - 多个信号可同时触发（不像 US-049 单一 level，市场综合状态本就需要 N
 *     个独立信号警示而非 cascade pick）。但每个用户最多收 N (≤3) 条告警，
 *     不在同一类型上重复写（同日去重由 RiskAlert 表本身的 read 状态承担，
 *     此处不查 distinct，因日内重跑 cron 是正常的 ops 操作）；
 *   - return_pct 计算用 `(latest - prior) / prior` 而非 `(latest/prior) - 1`
 *     的等价形式 — 防 prior=0 除零；prior <= 0 / NaN / 非有限 → 跳过该信号
 *     (safe HOLD)；
 *   - 跌幅判定用 `≤ -threshold_pct`（与 US-049 ≥ 镜像 — 数字跌得越深越小 / 正
 *     方向阈值要用负值比较 / `≤ -0.05` 包含 boundary，5% 跌幅恰好触发）；
 *   - MA20 / MA60 计算前必须有足够数据点（≥20 / ≥60），不足时 `regime_cross
 *     = 'unknown'`，不算死叉信号；
 *   - 死叉判定需"昨日 MA20 ≥ MA60 + 今日 MA20 < MA60"双边严格穿越（同
 *     US-026 RSI 上穿模式），避免持续低位漂移产生重复告警；
 *   - DataSource 故障 → evaluateAfterOpen 返回 status='error' 但不抛
 *     （task type 不应因风控 DB 故障 crash scheduler，与 US-049
 *     checkBuyAllowed fail-open 同款防御）；
 *   - 不写 RiskAlert 到禁用了配置的用户（config.enabled=false 跳过该用户）；
 *   - dry_run=true 时仍返回完整 status + suggested_user_alerts list 但不写表；
 */

import { Op } from 'sequelize';
import moment from 'moment-timezone';
import { sequelize } from '../../config/database';
import { Stock } from '../../models/Stock';
import { DailyBar } from '../../models/DailyBar';
import { PaperTradingPortfolio } from '../../models/PaperTradingPortfolio';
import { RiskAlert } from '../../models/RiskAlert';
import { User } from '../../models/User';
import { logger } from '../../utils/logger';

// ---------------------------------------------------------------------------
//  Config
// ---------------------------------------------------------------------------

export interface MarketRegimeAlertConfig {
  /** 是否启用（false = 跳过整个评估 + 不写告警）。 */
  enabled: boolean;
  /** 上证指数代码（默认 'sh.000001'）。 */
  benchmark_symbol: string;
  /** 3 日累计跌幅阈值（0-1，e.g. 0.05 = 跌幅 5% 触发 MEDIUM）。 */
  drop_3d_pct: number;
  /** 月度（20 个交易日）累计跌幅阈值（0-1，e.g. 0.15 = 跌幅 15% 触发 HIGH）。 */
  drop_20d_pct: number;
  /** MA20 / MA60 死叉信号 → MEDIUM 告警（true = 开启）。 */
  enable_death_cross: boolean;
  /** 触发后建议降仓比例（0-1，e.g. 0.30 = 30%）— 仅写入 message，guard 不强制下单。 */
  reduce_position_pct: number;
  /**
   * US-132 [PR-017] — 连续 N 日跌停股数量超阈值触发"全市场暂停建仓" CRITICAL 告警。
   * true = 开启检测；false = 跳过该信号（与 enable_death_cross 同款 enabled 三态）。
   */
  enable_halt_buy_on_panic: boolean;
  /**
   * US-132 — 跌停股阈值（每日跌停股数量 > N 算"恐慌"日，e.g. 100 = 默认）。
   * 必须正整数；非法值退化到默认 100。
   */
  halt_buy_limit_down_count_threshold: number;
  /**
   * US-132 — 连续恐慌日数（连续 ≥N 日跌停股数量超阈值触发暂停建仓，e.g. 3 = 默认）。
   * 必须正整数；非法值退化到默认 3。
   */
  halt_buy_consecutive_days: number;
}

/**
 * 默认配置（AC 指定）：上证指数 / 3 日 5% / 20 日 15% / 死叉开启 / 建议降仓 30%。
 *
 * `Object.freeze` 防止模块级常量被意外 mutate（US-037 codebase pattern）。
 */
export const DEFAULT_MARKET_REGIME_ALERT_CONFIG: MarketRegimeAlertConfig = Object.freeze({
  enabled: true,
  benchmark_symbol: 'sh.000001',
  drop_3d_pct: 0.05,
  drop_20d_pct: 0.15,
  enable_death_cross: true,
  reduce_position_pct: 0.3,
  // US-132 — 默认开启暂停建仓检测；阈值 100 跌停股 + 连续 3 日。
  enable_halt_buy_on_panic: true,
  halt_buy_limit_down_count_threshold: 100,
  halt_buy_consecutive_days: 3,
});

// ---------------------------------------------------------------------------
//  Domain types
// ---------------------------------------------------------------------------

/** One bar of the benchmark index. */
export interface BenchmarkBar {
  /** Calendar date 'YYYY-MM-DD'. */
  date: string;
  close: number;
}

/** Death-cross detection result (today's signal). */
export type DeathCrossSignal = 'death_cross' | 'no_cross' | 'unknown';

/** One regime alert (alert type discriminator). */
export type RegimeAlertType = 'DROP_3D' | 'DROP_20D' | 'DEATH_CROSS' | 'HALT_BUY';

/** One regime alert payload. */
export interface RegimeAlert {
  type: RegimeAlertType;
  level: 'MEDIUM' | 'HIGH' | 'CRITICAL';
  message: string;
  /** Sentinel symbol used for RiskAlert.symbol (SYSTEM: prefix). */
  symbol: string;
  /** Human-readable name used for RiskAlert.name. */
  name: string;
  /** Optional contextual details for telemetry / dashboards. */
  detail: Record<string, number | string>;
}

/** Market regime snapshot returned by `getMarketRegimeStatus` / `evaluateAfterOpen`. */
export interface MarketRegimeStatus {
  /** 'YYYY-MM-DD' of the most recent bar examined. */
  as_of: string | null;
  /** Benchmark code that was scanned (echoes config). */
  benchmark_symbol: string;
  /** Most recent close (null if no bars). */
  latest_close: number | null;
  /** 3-day cumulative return (negative = drop). null when fewer than 4 bars. */
  return_3d_pct: number | null;
  /** 20-day cumulative return. null when fewer than 21 bars. */
  return_20d_pct: number | null;
  /** Most recent MA20 (null if fewer than 20 bars). */
  ma20: number | null;
  /** Most recent MA60 (null if fewer than 60 bars). */
  ma60: number | null;
  /** Yesterday's MA20 (used for death-cross detection). */
  ma20_yesterday: number | null;
  /** Yesterday's MA60. */
  ma60_yesterday: number | null;
  /** Whether today crossed below MA60 (death cross). */
  cross_signal: DeathCrossSignal;
  /**
   * US-132 — 最近 N 日（含今日）每日跌停股数量，OLDEST→NEWEST。
   * null = DataSource 未实现 / DB 故障 / 数据不足；空数组 = 数据源返回空。
   * detectConsecutiveLimitDownHalt 用此数组 + config 判定是否触发 HALT_BUY。
   */
  limit_down_counts: number[] | null;
  /** Alerts triggered by this evaluation (0..3). */
  alerts: RegimeAlert[];
  /** Bars examined (debug; from oldest to newest). */
  bar_count: number;
  /** Error message if DB outage / data unavailable. */
  error?: string;
}

/** Result of one user's per-alert write (used by `evaluateAfterOpen`). */
export interface UserAlertWriteResult {
  user_id: number;
  alerts_written: number;
  error?: string;
}

/** Aggregate result of `evaluateAfterOpen`. */
export interface EvaluateAfterOpenResult {
  status: MarketRegimeStatus;
  /** Per-user write results (only populated when alerts triggered + !dry_run). */
  per_user: UserAlertWriteResult[];
  /** Total scanned users (all users with portfolios). */
  scanned_users: number;
  /** Users who received ≥1 alert. */
  alerted_users: number;
  /** True when `dry_run=true` (no DB writes performed). */
  dry_run: boolean;
}

// ---------------------------------------------------------------------------
//  Pure helpers (export for unit tests — no DB)
// ---------------------------------------------------------------------------

/**
 * 计算累计涨跌幅 = (latest - prior) / prior。
 *
 * - prior <= 0 / NaN / 非有限 → null（防御性除零，调用方按 null 跳过该信号）；
 * - latest NaN / 非有限 → null；
 * - 返回值是小数 (e.g. -0.06 = 跌 6%)，不是百分点。
 */
export function computeReturnPct(latest: number, prior: number): number | null {
  if (!Number.isFinite(prior) || prior <= 0) return null;
  if (!Number.isFinite(latest)) return null;
  return (latest - prior) / prior;
}

/**
 * 计算 N 期简单移动均线 (SMA) 最后值。
 *
 * - closes 长度 < period → null（数据不足，调用方按 null 跳过 MA 信号）；
 * - 取最后 N 个 close 做算术平均；
 * - period <= 0 / 非整数 → null（防御性）。
 */
export function computeMovingAverage(closes: number[], period: number): number | null {
  if (!Number.isInteger(period) || period <= 0) return null;
  if (!Array.isArray(closes) || closes.length < period) return null;
  const window = closes.slice(closes.length - period);
  let sum = 0;
  for (const c of window) {
    if (!Number.isFinite(c)) return null;
    sum += c;
  }
  return sum / period;
}

/**
 * 死叉检测 — 昨日 MA20 ≥ MA60 且今日 MA20 < MA60。
 *
 * - 任一 MA 为 null（数据不足） → 'unknown'；
 * - 严格穿越（双边 strict）避免持续低位漂移产生重复告警，同 US-026 RSI 上穿模式；
 * - 仅返回 today 的单次穿越状态，调用方按需写告警（不在此处去重）。
 */
export function detectDeathCross(
  ma20Today: number | null,
  ma60Today: number | null,
  ma20Yesterday: number | null,
  ma60Yesterday: number | null
): DeathCrossSignal {
  if (
    ma20Today === null ||
    ma60Today === null ||
    ma20Yesterday === null ||
    ma60Yesterday === null
  ) {
    return 'unknown';
  }
  if (
    !Number.isFinite(ma20Today) ||
    !Number.isFinite(ma60Today) ||
    !Number.isFinite(ma20Yesterday) ||
    !Number.isFinite(ma60Yesterday)
  ) {
    return 'unknown';
  }
  // Yesterday MA20 ≥ MA60, today MA20 < MA60 = 死叉
  if (ma20Yesterday >= ma60Yesterday && ma20Today < ma60Today) {
    return 'death_cross';
  }
  return 'no_cross';
}

/**
 * US-132 [PR-017] — 连续 N 日跌停股 > M 触发"全市场暂停建仓"判定。
 *
 * 输入 `counts` 为 OLDEST → NEWEST 的每日跌停股数量序列（不含集合竞价 / 停牌
 * 单边股, 由 DataSource 负责合规过滤）。规则:
 *   - 取**最新 N 日**（counts.slice(-N)）；
 *   - 若长度 < N → 'unknown'（数据不足，安全 HOLD 不触发）;
 *   - 若任一日 count 非有限数 / 非正整数 → 'unknown'（数据脏，safe HOLD）;
 *   - 否则 `every(c => c > threshold)` 即所有 N 日**严格大于**阈值才触发。
 *
 * 严格大于 `>` 而非 `≥` —— 与 PRD AC "跌停股 > 100" 字面对齐 + 与 drop_3d_pct
 * 镜像保护 (跌幅 ≤ -threshold 触发即 ≥) 形态相反:
 *   - 跌幅 5% boundary 必须触发 (跌得越深越糟, 5% 是底线);
 *   - 跌停股 100 boundary **不触发** (PRD 写 ">100", 100 仍属边缘观望);
 * 这种"风险方向不对称"的边界选择必须显式记到 jsdoc + 单测同时守 N=100 不触发
 * 与 N=101 触发两 case 防 off-by-one (与 [[ai-view-max-chars]] / [[滑窗 cluster
 * dedupe]] 同款 N/N+1 双边界范式).
 */
export type HaltBuySignal = 'halt_buy' | 'no_halt' | 'unknown';

export function detectConsecutiveLimitDownHalt(
  counts: number[] | null | undefined,
  consecutive_days: number,
  count_threshold: number
): HaltBuySignal {
  if (!Number.isInteger(consecutive_days) || consecutive_days <= 0) return 'unknown';
  if (!Number.isInteger(count_threshold) || count_threshold < 0) return 'unknown';
  if (!Array.isArray(counts) || counts.length < consecutive_days) return 'unknown';
  const window = counts.slice(counts.length - consecutive_days);
  for (const c of window) {
    if (!Number.isFinite(c) || !Number.isInteger(c) || c < 0) return 'unknown';
  }
  // 严格大于 (与 PRD "跌停股 > 100" 字面对齐, 100 不触发 / 101 触发).
  return window.every(c => c > count_threshold) ? 'halt_buy' : 'no_halt';
}

/** Build human-readable alert message (Chinese). */
export function buildAlertMessage(input: {
  type: RegimeAlertType;
  benchmark_name: string;
  return_pct?: number | null;
  threshold_pct?: number;
  ma20?: number | null;
  ma60?: number | null;
  reduce_position_pct: number;
  /** US-132 HALT_BUY only: 每日跌停股数量序列 OLDEST→NEWEST。 */
  limit_down_counts?: number[];
  /** US-132 HALT_BUY only: 触发阈值（单日跌停股数量）。 */
  limit_down_threshold?: number;
  /** US-132 HALT_BUY only: 连续天数阈值。 */
  consecutive_days?: number;
}): string {
  const reducePct = (input.reduce_position_pct * 100).toFixed(0);
  if (input.type === 'DROP_3D') {
    const ret = input.return_pct !== null && input.return_pct !== undefined ? input.return_pct : 0;
    const thr = input.threshold_pct ?? 0;
    return (
      `市场预警：${input.benchmark_name} 3 日累计跌幅 ${(ret * 100).toFixed(2)}%，` +
      `已超过阈值 ${(thr * 100).toFixed(2)}%。建议降仓 ${reducePct}%。`
    );
  }
  if (input.type === 'DROP_20D') {
    const ret = input.return_pct !== null && input.return_pct !== undefined ? input.return_pct : 0;
    const thr = input.threshold_pct ?? 0;
    return (
      `市场预警：${input.benchmark_name} 月度（20 交易日）累计跌幅 ${(ret * 100).toFixed(2)}%，` +
      `已超过阈值 ${(thr * 100).toFixed(2)}%。建议降仓 ${reducePct}%。`
    );
  }
  if (input.type === 'HALT_BUY') {
    const days = input.consecutive_days ?? 0;
    const thr = input.limit_down_threshold ?? 0;
    const countsStr = (input.limit_down_counts ?? []).join('/');
    return (
      `市场恐慌预警：连续 ${days} 日跌停股数量 ${countsStr} 只均超过阈值 ${thr} 只，` +
      `触发全市场暂停建仓 (CRITICAL)。建议持有现金 + 暂停新开仓直至市场企稳。`
    );
  }
  // DEATH_CROSS
  const ma20 = input.ma20 ?? 0;
  const ma60 = input.ma60 ?? 0;
  return (
    `市场预警：${input.benchmark_name} MA20 (${ma20.toFixed(2)}) 下穿 MA60 (${ma60.toFixed(2)})，` +
    `形成死叉信号。建议降仓 ${reducePct}%。`
  );
}

/**
 * 评估 3 类信号并产出 alert 列表。
 *
 * - 多个信号可同时触发（不像 US-049 single-level pick），市场综合状态需要并列；
 * - 跌幅判定用 `≤ -threshold_pct` 包含 boundary（保护性硬触发，与 US-049 ≥ 镜像）；
 * - 死叉信号仅在 config.enable_death_cross=true 时考虑；
 * - return_pct/MA 为 null（数据不足）时该信号自动跳过（safe HOLD）。
 */
export function pickRegimeAlerts(input: {
  config: MarketRegimeAlertConfig;
  benchmark_name: string;
  return_3d_pct: number | null;
  return_20d_pct: number | null;
  ma20_today: number | null;
  ma60_today: number | null;
  ma20_yesterday: number | null;
  ma60_yesterday: number | null;
  /** US-132 — 最近 N 日跌停股数量 OLDEST→NEWEST (null = 数据不可用，跳过 HALT_BUY 检测)。 */
  limit_down_counts?: number[] | null;
}): RegimeAlert[] {
  const alerts: RegimeAlert[] = [];
  const { config } = input;

  // 1. 3 日累计跌幅 → MEDIUM
  if (
    input.return_3d_pct !== null &&
    Number.isFinite(input.return_3d_pct) &&
    input.return_3d_pct <= -config.drop_3d_pct
  ) {
    alerts.push({
      type: 'DROP_3D',
      level: 'MEDIUM',
      symbol: 'SYSTEM:MARKET_REGIME_DROP_3D',
      name: `市场预警 - 3 日跌幅 (${input.benchmark_name})`,
      message: buildAlertMessage({
        type: 'DROP_3D',
        benchmark_name: input.benchmark_name,
        return_pct: input.return_3d_pct,
        threshold_pct: config.drop_3d_pct,
        reduce_position_pct: config.reduce_position_pct,
      }),
      detail: {
        benchmark_symbol: config.benchmark_symbol,
        return_3d_pct: input.return_3d_pct,
        threshold_pct: -config.drop_3d_pct,
      },
    });
  }

  // 2. 月度（20 交易日）累计跌幅 → HIGH
  if (
    input.return_20d_pct !== null &&
    Number.isFinite(input.return_20d_pct) &&
    input.return_20d_pct <= -config.drop_20d_pct
  ) {
    alerts.push({
      type: 'DROP_20D',
      level: 'HIGH',
      symbol: 'SYSTEM:MARKET_REGIME_DROP_20D',
      name: `市场预警 - 月度跌幅 (${input.benchmark_name})`,
      message: buildAlertMessage({
        type: 'DROP_20D',
        benchmark_name: input.benchmark_name,
        return_pct: input.return_20d_pct,
        threshold_pct: config.drop_20d_pct,
        reduce_position_pct: config.reduce_position_pct,
      }),
      detail: {
        benchmark_symbol: config.benchmark_symbol,
        return_20d_pct: input.return_20d_pct,
        threshold_pct: -config.drop_20d_pct,
      },
    });
  }

  // 3. 死叉 → MEDIUM (only when enabled)
  if (config.enable_death_cross) {
    const cross = detectDeathCross(
      input.ma20_today,
      input.ma60_today,
      input.ma20_yesterday,
      input.ma60_yesterday
    );
    if (cross === 'death_cross') {
      alerts.push({
        type: 'DEATH_CROSS',
        level: 'MEDIUM',
        symbol: 'SYSTEM:MARKET_REGIME_DEATH_CROSS',
        name: `市场预警 - MA 死叉 (${input.benchmark_name})`,
        message: buildAlertMessage({
          type: 'DEATH_CROSS',
          benchmark_name: input.benchmark_name,
          ma20: input.ma20_today,
          ma60: input.ma60_today,
          reduce_position_pct: config.reduce_position_pct,
        }),
        detail: {
          benchmark_symbol: config.benchmark_symbol,
          ma20: input.ma20_today ?? 0,
          ma60: input.ma60_today ?? 0,
          ma20_yesterday: input.ma20_yesterday ?? 0,
          ma60_yesterday: input.ma60_yesterday ?? 0,
        },
      });
    }
  }

  // 4. US-132 — 连续 N 日跌停股 > M → CRITICAL "全市场暂停建仓".
  // 不放 `if (config.enabled && config.enable_halt_buy_on_panic)` 分级 — 与 DEATH_CROSS 同款
  // 单 enable_xxx flag 控制 (caller 顶层 enabled flag 已在 service.getMarketRegimeStatus 里
  // 守住, 这里 pure helper 只判子开关), 让单测可独立验证子信号开关.
  if (config.enable_halt_buy_on_panic) {
    const haltSignal = detectConsecutiveLimitDownHalt(
      input.limit_down_counts ?? null,
      config.halt_buy_consecutive_days,
      config.halt_buy_limit_down_count_threshold
    );
    if (haltSignal === 'halt_buy') {
      const counts = input.limit_down_counts as number[];
      alerts.push({
        type: 'HALT_BUY',
        level: 'CRITICAL',
        symbol: 'SYSTEM:MARKET_REGIME_HALT_BUY',
        name: `市场恐慌 - 全市场暂停建仓`,
        message: buildAlertMessage({
          type: 'HALT_BUY',
          benchmark_name: input.benchmark_name,
          reduce_position_pct: config.reduce_position_pct,
          limit_down_counts: counts,
          limit_down_threshold: config.halt_buy_limit_down_count_threshold,
          consecutive_days: config.halt_buy_consecutive_days,
        }),
        detail: {
          benchmark_symbol: config.benchmark_symbol,
          limit_down_threshold: config.halt_buy_limit_down_count_threshold,
          consecutive_days: config.halt_buy_consecutive_days,
          // detail 是 Record<string, number|string>; 序列化数组用逗号分隔避免 type 矛盾.
          recent_counts: counts.join(','),
        },
      });
    }
  }

  return alerts;
}

/**
 * 净化 raw config blob（来自 User.risk_config.market_regime 或 PUT body）。
 *
 * - 非有限数 / 负 / >1 的 pct → 默认；
 * - benchmark_symbol 非字符串 → 默认 'sh.000001'；
 * - 非 boolean 的 enabled / enable_death_cross → 默认；
 *
 * 与 US-047/US-048/US-049 normalize 同款"沉默退回默认不 4xx"的范式。
 */
export function normalizeMarketRegimeAlertConfig(raw: any): MarketRegimeAlertConfig {
  const safePct = (v: any, dflt: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= 1 ? n : dflt;
  };
  const safeBool = (v: any, dflt: boolean) => (typeof v === 'boolean' ? v : dflt);
  const safeStr = (v: any, dflt: string) =>
    typeof v === 'string' && v.trim().length > 0 ? v : dflt;
  // US-132 — 正整数(>0) safe coerce, 负 / 0 / 非整数 / 非有限 → 默认值.
  const safePosInt = (v: any, dflt: number) => {
    const n = Number(v);
    return Number.isFinite(n) && Number.isInteger(n) && n > 0 ? n : dflt;
  };
  return {
    enabled: safeBool(raw?.enabled, DEFAULT_MARKET_REGIME_ALERT_CONFIG.enabled),
    benchmark_symbol: safeStr(
      raw?.benchmark_symbol,
      DEFAULT_MARKET_REGIME_ALERT_CONFIG.benchmark_symbol
    ),
    drop_3d_pct: safePct(raw?.drop_3d_pct, DEFAULT_MARKET_REGIME_ALERT_CONFIG.drop_3d_pct),
    drop_20d_pct: safePct(raw?.drop_20d_pct, DEFAULT_MARKET_REGIME_ALERT_CONFIG.drop_20d_pct),
    enable_death_cross: safeBool(
      raw?.enable_death_cross,
      DEFAULT_MARKET_REGIME_ALERT_CONFIG.enable_death_cross
    ),
    reduce_position_pct: safePct(
      raw?.reduce_position_pct,
      DEFAULT_MARKET_REGIME_ALERT_CONFIG.reduce_position_pct
    ),
    // US-132 — 新增 3 字段, 全 lenient 退默认 (与既有字段同款防御).
    enable_halt_buy_on_panic: safeBool(
      raw?.enable_halt_buy_on_panic,
      DEFAULT_MARKET_REGIME_ALERT_CONFIG.enable_halt_buy_on_panic
    ),
    halt_buy_limit_down_count_threshold: safePosInt(
      raw?.halt_buy_limit_down_count_threshold,
      DEFAULT_MARKET_REGIME_ALERT_CONFIG.halt_buy_limit_down_count_threshold
    ),
    halt_buy_consecutive_days: safePosInt(
      raw?.halt_buy_consecutive_days,
      DEFAULT_MARKET_REGIME_ALERT_CONFIG.halt_buy_consecutive_days
    ),
  };
}

// ---------------------------------------------------------------------------
//  DataSource — DI seam for unit tests
// ---------------------------------------------------------------------------

export interface MarketRegimeAlertDataSource {
  /** Load this user's effective config (defaults if absent). */
  loadConfig(user_id: number): Promise<MarketRegimeAlertConfig>;
  /** Persist this user's config (UPSERT semantics). */
  saveConfig(user_id: number, config: MarketRegimeAlertConfig): Promise<MarketRegimeAlertConfig>;
  /** Load global config (for service-level evaluation that doesn't target one user). */
  loadGlobalConfig(): Promise<MarketRegimeAlertConfig>;
  /**
   * Load the benchmark index bars from [asOfDate - lookbackDays, asOfDate].
   * Returns bars from OLDEST to NEWEST.
   */
  loadBenchmarkBars(
    benchmark_symbol: string,
    asOfDate: Date,
    lookbackDays: number
  ): Promise<BenchmarkBar[]>;
  /** Return the human-readable benchmark name (defaults to the symbol). */
  loadBenchmarkName(benchmark_symbol: string): Promise<string>;
  /** Load all users with a paper-trading portfolio (for batch RiskAlert fan-out). */
  loadAllUserIdsWithPortfolios(): Promise<number[]>;
  /**
   * US-132 — 取最近 N 个交易日（含 asOfDate 当日，OLDEST→NEWEST）的市场跌停股数量。
   * 一个 element 对应一日；返回 length 不足 N 表示数据不足，detect 自动返 'unknown'。
   *
   * 实现方法（生产 PG 路径）— 按 change_percent ≤ -9.8（A 股主板默认 10%，
   * AShareConstraintEngine.DEFAULT_LIMIT_DOWN_PCT 同源），group by 交易日 count
   * distinct symbol。停牌当日不算 (`is_suspended=false` 过滤)。失败 → 返 [] 让
   * caller 视为数据不足 (safe HOLD 不触发 HALT_BUY 误报)。
   */
  loadConsecutiveLimitDownCounts(asOfDate: Date, days: number): Promise<number[]>;
  /** Write a single RiskAlert row (level supplied per-call). */
  writeAlert(input: {
    user_id: number;
    symbol: string;
    name: string;
    level: 'MEDIUM' | 'HIGH' | 'CRITICAL';
    message: string;
  }): Promise<void>;
}

/**
 * Production DataSource — backed by Sequelize.  Cross-table joins live here
 * so the service methods see snapshot bag types only.
 */
export class DefaultMarketRegimeAlertDataSource implements MarketRegimeAlertDataSource {
  async loadConfig(user_id: number): Promise<MarketRegimeAlertConfig> {
    const user = await User.findByPk(user_id);
    const raw = user?.risk_config?.market_regime;
    return normalizeMarketRegimeAlertConfig(raw);
  }

  async saveConfig(
    user_id: number,
    config: MarketRegimeAlertConfig
  ): Promise<MarketRegimeAlertConfig> {
    const user = await User.findByPk(user_id);
    if (!user) {
      throw new Error(`saveConfig: user ${user_id} not found`);
    }
    const merged = {
      ...(user.risk_config || {}),
      market_regime: {
        ...(user.risk_config?.market_regime || {}),
        ...config,
      },
    };
    user.risk_config = merged;
    // JSONB columns require explicit `changed('field', true)` per US-017.
    user.changed('risk_config', true);
    await user.save();
    return { ...config };
  }

  async loadGlobalConfig(): Promise<MarketRegimeAlertConfig> {
    // No global override yet — return the frozen defaults.  Future: pull
    // from a `system_config` table.
    return { ...DEFAULT_MARKET_REGIME_ALERT_CONFIG };
  }

  async loadBenchmarkBars(
    benchmark_symbol: string,
    asOfDate: Date,
    lookbackDays: number
  ): Promise<BenchmarkBar[]> {
    const stock = await Stock.findOne({ where: { symbol: benchmark_symbol } });
    if (!stock) return [];
    const startDate = new Date(asOfDate.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
    const rows = (await DailyBar.findAll({
      where: {
        stock_id: stock.id,
        time: {
          [Op.gte]: startDate,
          [Op.lte]: asOfDate,
        },
      },
      order: [['time', 'ASC']],
      raw: true,
    })) as any[];
    return rows
      .map(r => ({
        date: moment(r.time).format('YYYY-MM-DD'),
        close: Number(r.close),
      }))
      .filter(b => Number.isFinite(b.close) && b.close > 0);
  }

  async loadBenchmarkName(benchmark_symbol: string): Promise<string> {
    const stock = await Stock.findOne({ where: { symbol: benchmark_symbol } });
    return stock?.name || benchmark_symbol;
  }

  async loadAllUserIdsWithPortfolios(): Promise<number[]> {
    const rows = await PaperTradingPortfolio.findAll({
      attributes: ['user_id'],
      group: ['user_id'],
    });
    return rows.map(r => r.user_id);
  }

  async loadConsecutiveLimitDownCounts(asOfDate: Date, days: number): Promise<number[]> {
    // 取最近 ~2x days 个日历日的所有 daily_bars (覆盖周末 / 假期保证至少 days 个交易日),
    // 按 group by 时间 count distinct stock_id 跌停股 (change_percent <= -9.8 + is_suspended=false +
    // is_trading_day=true), 然后取最后 days 个交易日按 OLDEST→NEWEST 输出.
    if (!Number.isInteger(days) || days <= 0) return [];
    try {
      // ~2x days 缓冲 (周末 + 假期); 上限避免极端查询.
      const lookbackCalendarDays = Math.min(days * 4 + 14, 60);
      const startDate = new Date(asOfDate.getTime() - lookbackCalendarDays * 24 * 60 * 60 * 1000);
      const rows = (await DailyBar.findAll({
        attributes: [
          'time',
          [sequelize.fn('COUNT', sequelize.col('stock_id')), 'limit_down_count'],
        ],
        where: {
          time: {
            [Op.gte]: startDate,
            [Op.lte]: asOfDate,
          },
          change_percent: { [Op.lte]: -9.8 },
          is_suspended: false,
          is_trading_day: true,
        },
        group: ['time'],
        order: [['time', 'ASC']],
        raw: true,
      })) as any[];
      const counts = rows
        .map(r => Number((r as any).limit_down_count))
        .filter(n => Number.isFinite(n) && n >= 0);
      // OLDEST → NEWEST 已由 order ASC 保证; slice 最后 days 个交易日.
      return counts.slice(-days);
    } catch (err) {
      // fail-open: 返空让 detect 自动 'unknown' 不触发 HALT_BUY 误报.
      logger.warn(
        `MarketRegimeAlertService.loadConsecutiveLimitDownCounts asOf=${asOfDate.toISOString()} ` +
          `days=${days}: ${(err as Error).message}`
      );
      return [];
    }
  }

  async writeAlert(input: {
    user_id: number;
    symbol: string;
    name: string;
    level: 'MEDIUM' | 'HIGH' | 'CRITICAL';
    message: string;
  }): Promise<void> {
    await RiskAlert.create({
      user_id: input.user_id,
      symbol: input.symbol,
      name: input.name,
      level: input.level,
      message: input.message,
      // US-067 — 给 RealtimeAlertDispatcher dedup signature 用。
      rule_id: 'market_regime_alert',
      is_read: false,
      metadata: {
        ledger_scope: 'account_risk',
        origin: 'market_regime_alert_service',
      },
    } as any);
  }
}

export const PRODUCTION_MARKET_REGIME_ALERT_DATA_SOURCE: MarketRegimeAlertDataSource =
  new DefaultMarketRegimeAlertDataSource();

// ---------------------------------------------------------------------------
//  Service — public entry point
// ---------------------------------------------------------------------------

export interface EvaluateAfterOpenOptions {
  /** Override asOfDate (default = now). */
  asOfDate?: Date;
  /** Override bar lookback window in calendar days (default 120 — ~80 trading days). */
  lookback_days?: number;
  /** If true, skip RiskAlert writes (UI dashboard preview). */
  dry_run?: boolean;
  /** If set, only fan out to this user (otherwise scan all users with portfolios). */
  user_id?: number;
}

export interface GetMarketRegimeStatusOptions {
  /** Override asOfDate (default = now). */
  asOfDate?: Date;
  /** Override bar lookback window (default 120 days). */
  lookback_days?: number;
  /** When set, use this user's config; otherwise use the global config. */
  user_id?: number;
}

export class MarketRegimeAlertService {
  private source: MarketRegimeAlertDataSource;

  constructor(source: MarketRegimeAlertDataSource = PRODUCTION_MARKET_REGIME_ALERT_DATA_SOURCE) {
    this.source = source;
  }

  /**
   * Build the status snapshot WITHOUT writing any RiskAlert.  Used by both
   * the HTTP endpoint and `evaluateAfterOpen` (which then fans the snapshot
   * out to users).
   *
   * Returns `status.error` set if benchmark bars cannot be loaded — caller
   * decides what to do (fail-open vs surface to user).
   */
  async getMarketRegimeStatus(
    options: GetMarketRegimeStatusOptions = {}
  ): Promise<MarketRegimeStatus> {
    const asOfDate = options.asOfDate ?? new Date();
    const lookbackDays =
      Number.isInteger(options.lookback_days) && (options.lookback_days as number) > 0
        ? (options.lookback_days as number)
        : 120;
    const config = options.user_id
      ? await this.source.loadConfig(options.user_id)
      : await this.source.loadGlobalConfig();

    let bars: BenchmarkBar[] = [];
    let benchmarkName = config.benchmark_symbol;
    let error: string | undefined;
    try {
      bars = await this.source.loadBenchmarkBars(config.benchmark_symbol, asOfDate, lookbackDays);
      benchmarkName = await this.source.loadBenchmarkName(config.benchmark_symbol);
    } catch (err) {
      error = (err as Error).message;
      logger.warn(
        `MarketRegimeAlertService.getMarketRegimeStatus benchmark=${config.benchmark_symbol}: ${error}`
      );
    }

    const closes = bars.map(b => b.close);
    const latest = closes.length > 0 ? closes[closes.length - 1] : null;
    const asOf = bars.length > 0 ? bars[bars.length - 1].date : null;

    // 3-day return (need ≥4 bars: latest + 3 prior)
    const return_3d =
      closes.length >= 4 ? computeReturnPct(latest as number, closes[closes.length - 4]) : null;
    // 20-day return (need ≥21 bars)
    const return_20d =
      closes.length >= 21 ? computeReturnPct(latest as number, closes[closes.length - 21]) : null;

    // MA20 today / yesterday (need ≥20 / ≥21 bars)
    const ma20Today = computeMovingAverage(closes, 20);
    const ma20Yesterday =
      closes.length >= 21 ? computeMovingAverage(closes.slice(0, -1), 20) : null;
    // MA60 today / yesterday (need ≥60 / ≥61 bars)
    const ma60Today = computeMovingAverage(closes, 60);
    const ma60Yesterday =
      closes.length >= 61 ? computeMovingAverage(closes.slice(0, -1), 60) : null;

    const cross_signal = detectDeathCross(ma20Today, ma60Today, ma20Yesterday, ma60Yesterday);

    // US-132 — 取最近 N 日跌停股数量 (即使本评估窗口未触发, 也带回让 UI 看曲线).
    // 仅在 enable_halt_buy_on_panic=true 时拉取, 否则 null 占位 (节省 DB 查询).
    let limit_down_counts: number[] | null = null;
    if (config.enable_halt_buy_on_panic) {
      try {
        const counts = await this.source.loadConsecutiveLimitDownCounts(
          asOfDate,
          config.halt_buy_consecutive_days
        );
        // 空数组也视为 "数据不可用" → null 让 detect 返 unknown 不触发误报.
        limit_down_counts = Array.isArray(counts) && counts.length > 0 ? counts : null;
      } catch (err) {
        // fail-open: log + null 占位, 不阻塞其他 3 类信号评估.
        logger.warn(
          `MarketRegimeAlertService.getMarketRegimeStatus loadConsecutiveLimitDownCounts ` +
            `asOf=${asOfDate.toISOString()}: ${(err as Error).message}`
        );
        limit_down_counts = null;
      }
    }

    const alerts = config.enabled
      ? pickRegimeAlerts({
          config,
          benchmark_name: benchmarkName,
          return_3d_pct: return_3d,
          return_20d_pct: return_20d,
          ma20_today: ma20Today,
          ma60_today: ma60Today,
          ma20_yesterday: ma20Yesterday,
          ma60_yesterday: ma60Yesterday,
          limit_down_counts,
        })
      : [];

    return {
      as_of: asOf,
      benchmark_symbol: config.benchmark_symbol,
      latest_close: latest,
      return_3d_pct: return_3d,
      return_20d_pct: return_20d,
      ma20: ma20Today,
      ma60: ma60Today,
      ma20_yesterday: ma20Yesterday,
      ma60_yesterday: ma60Yesterday,
      cross_signal,
      limit_down_counts,
      alerts,
      bar_count: bars.length,
      error,
    };
  }

  /**
   * Evaluate the market regime, then fan out RiskAlert rows to users.
   *
   * - 一次评估同时产 0..3 个并列告警（市场综合状态本就需要 N 个独立信号）；
   * - 每个用户对应每个 alert 写一行 RiskAlert（symbol/level 来自 alert payload，
   *   message 已含 benchmark + 跌幅 + 建议降仓 30%）；
   * - 单 user 写入失败 try/catch 隔离（同 US-042 / US-049）；
   * - dry_run=true 跳过 RiskAlert 写入但仍返回完整 status + per_user list；
   * - benchmark bar load 失败 → status.error 但不抛，scheduler 不该 crash；
   */
  async evaluateAfterOpen(
    options: EvaluateAfterOpenOptions = {}
  ): Promise<EvaluateAfterOpenResult> {
    const dryRun = Boolean(options.dry_run);
    const status = await this.getMarketRegimeStatus({
      asOfDate: options.asOfDate,
      lookback_days: options.lookback_days,
    });

    // No alerts triggered (or breaker disabled / bars missing) → short-circuit
    if (status.alerts.length === 0) {
      return {
        status,
        per_user: [],
        scanned_users: 0,
        alerted_users: 0,
        dry_run: dryRun,
      };
    }

    const userIds = options.user_id
      ? [options.user_id]
      : await this.source.loadAllUserIdsWithPortfolios();

    const per_user: UserAlertWriteResult[] = [];
    let alerted_users = 0;
    for (const user_id of userIds) {
      try {
        // Skip users who have disabled the alert
        const userConfig = await this.source.loadConfig(user_id);
        if (!userConfig.enabled) {
          per_user.push({ user_id, alerts_written: 0 });
          continue;
        }
        if (dryRun) {
          per_user.push({ user_id, alerts_written: status.alerts.length });
          alerted_users += 1;
          continue;
        }
        let written = 0;
        for (const alert of status.alerts) {
          try {
            await this.source.writeAlert({
              user_id,
              symbol: alert.symbol,
              name: alert.name,
              level: alert.level,
              message: alert.message,
            });
            written += 1;
          } catch (err) {
            logger.warn(
              `MarketRegimeAlertService.writeAlert user=${user_id} type=${alert.type}: ` +
                `${(err as Error).message}`
            );
          }
        }
        per_user.push({ user_id, alerts_written: written });
        if (written > 0) alerted_users += 1;
      } catch (err) {
        logger.warn(
          `MarketRegimeAlertService.evaluateAfterOpen user=${user_id}: ` +
            `${(err as Error).message}`
        );
        per_user.push({ user_id, alerts_written: 0, error: (err as Error).message });
      }
    }

    return {
      status,
      per_user,
      scanned_users: userIds.length,
      alerted_users,
      dry_run: dryRun,
    };
  }

  /** Return the user's effective config (defaults if not customized). */
  async getConfig(user_id: number): Promise<MarketRegimeAlertConfig> {
    return this.source.loadConfig(user_id);
  }

  /** Persist a (normalized) updated config for the user. */
  async updateConfig(user_id: number, raw: any): Promise<MarketRegimeAlertConfig> {
    const normalized = normalizeMarketRegimeAlertConfig(raw);
    return this.source.saveConfig(user_id, normalized);
  }
}

/** Singleton — controllers / scheduler reach this instead of `new`-ing per call. */
export const marketRegimeAlertService = new MarketRegimeAlertService();
