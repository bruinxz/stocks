/**
 * marketLimits — A 股市场段 + 涨跌停 + 北交所识别的**单一权威**模块。
 *
 * 历史背景：原本 `inferMarketSegment + getLimitPct` 散落在
 * `services/execution/ExecutionFeasibilityService.ts` 与 `quant/backtest/
 * AShareConstraintEngine.ts` 两处，且 `ExecutionFeasibilityService` 的实现
 * 不含 ST 判定 (没有 name 参数), 而回测引擎只有一个全局 `limit_up_pct`
 * 配置完全不分市场段 —— 创业板 / 科创板涨 12-18% 一律被回测拦截，BJ 涨
 * 25% 几乎天天被拦, ST 涨 4.5% 反而被放行 (实盘 5% 已涨停)。本模块抽出
 * 来作为 audit S-2 + S-3 的修复, 让回测 + paper trading + live trading
 * 三处全部 import 同一函数 + ST 判定统一通过 `isSTName`。
 *
 * 设计约束：
 *   - **纯函数**：所有 export 都是无状态、无 DB、可单测的同步函数。
 *   - **市场段识别由 symbol 唯一决定**，name 仅用于 ST 判定。
 *   - **涨跌停幅度优先级**：ST 总是 5%，与市场段无关（北交所 ST 仍 5%）。
 *   - **lower / upper 价格按 A 股 0.01 元 tick round-half-up**：与中国证监会
 *     涨跌停价定义一致（券商客户端口径）。
 *   - **`isAtLimitUp / isAtLimitDown`** 用 `bar.high/low/close` ≥/≤ 阈值
 *     做判定，阈值放宽 1bp (= 1e-4) 容忍浮点误差；不要直接 `==`。
 */

import { isSTName } from '../utils/stNameUtils';

// ---------------------------------------------------------------- 类型

/** 市场段 (与 A 股交易所板块对齐) */
export type MarketSegment = 'main' | 'chinext' | 'star' | 'bj' | 'unknown';

// ---------------------------------------------------------------- 常量

/** 主板涨跌停 10% (沪 sh.6xx / sh.9xx / 深 sz.0xx / sz.2xx) */
export const MAIN_LIMIT_PCT = 0.1;

/** 创业板涨跌停 20% (sz.3xx) */
export const CHINEXT_LIMIT_PCT = 0.2;

/** 科创板涨跌停 20% (sh.688xxx) */
export const STAR_LIMIT_PCT = 0.2;

/** 北交所涨跌停 30% (bj.4xx / bj.8xx / bj.92xxxx) */
export const BJ_LIMIT_PCT = 0.3;

/** ST 股涨跌停 5% (与市场段无关；北交所 ST 也是 5%, 监管口径) */
export const ST_LIMIT_PCT = 0.05;

/** A 股最小 tick = 0.01 元 (人民币 1 分) */
export const A_SHARE_TICK = 0.01;

/** 浮点容差: 比较涨跌停时放宽 1bp (= 1e-4) 避免 floating-point round 误判 */
const LIMIT_EPSILON = 1e-4;

// ---------------------------------------------------------------- 工具

/**
 * 把 symbol 归一为 "前缀.6位代码" 格式后取出代码部分。
 *
 * 兼容输入:
 *   - "sh.600519" / "sz.300033" / "bj.920003" (前缀格式, akshare/tushare)
 *   - "600519.SH" / "300033.SZ" / "920003.BJ" (后缀格式, 老历史)
 *   - "600519" (纯代码)
 *
 * 返回示例: { code: "600519", prefix: "sh", suffix: undefined }
 *           { code: "300033", prefix: "sz" }
 *           { code: "920003", prefix: "bj" }
 *           { code: "600519", prefix: undefined, suffix: "SH" }
 */
function parseSymbol(symbol: string | null | undefined): {
  code: string;
  prefix: string | undefined;
  suffix: string | undefined;
} {
  if (!symbol) return { code: '', prefix: undefined, suffix: undefined };
  const raw = String(symbol).trim();
  if (!raw) return { code: '', prefix: undefined, suffix: undefined };
  if (!raw.includes('.')) return { code: raw, prefix: undefined, suffix: undefined };
  const [a, b] = raw.split('.', 2);
  // 前缀格式: a 是 "sh" / "sz" / "bj" (2 letters), code = b
  if (/^[a-zA-Z]{2}$/.test(a)) {
    return { code: b || '', prefix: a.toLowerCase(), suffix: undefined };
  }
  // 后缀格式: a 是代码, b 是 "SH" / "SZ" / "BJ"
  return { code: a, prefix: undefined, suffix: (b || '').toUpperCase() };
}

// ---------------------------------------------------------------- 核心 API

/**
 * 按 symbol 推断 A 股市场段。
 *
 * 规则 (优先级从严到松):
 *   1. 显式前缀 / 后缀 "bj" / "BJ"        → bj
 *   2. 显式前缀 / 后缀 "sh" / "SH" + 688xx → star (科创板)
 *   3. 6 位代码开头 "688"                  → star
 *   4. 显式前缀 / 后缀 "sz" / "SZ" + 3xx   → chinext (创业板)
 *   5. 6 位代码开头 "3"                    → chinext
 *   6. 6 位代码开头 "4" / "8" / "92" / "43"→ bj (北交所号段)
 *   7. 6 位代码开头 "6" / "9" / "0" / "2"  → main
 *   8. 其他 (无法识别)                      → unknown
 *
 * 注：5xxxxx 是基金 ETF (非个股, 不在本模块 scope), 返回 unknown。
 */
export function inferMarketSegment(symbol: string | null | undefined): MarketSegment {
  const { code, prefix, suffix } = parseSymbol(symbol);
  if (!code) return 'unknown';

  // 1. 显式 bj 前缀 / 后缀
  if (prefix === 'bj' || suffix === 'BJ') return 'bj';

  // 2. sh + 688 = 科创板
  if ((prefix === 'sh' || suffix === 'SH') && code.startsWith('688')) return 'star';

  // 3. code 开头判别
  if (code.startsWith('688')) return 'star';
  if (code.startsWith('3')) return 'chinext';
  // 北交所号段: 4xx / 8xx / 92xxxx / 43xxxx
  // 注意: 43xxxx 已经 startsWith('4'); 92xxxx 已经 startsWith('9') 但 9 开头还有 sh.9 主板
  if (code.startsWith('92')) return 'bj';
  if (code.startsWith('43')) return 'bj';
  // sz 没有 4xx/8xx 号段; sh 也没有 4xx/8xx 号段 (sh.9xx B 股例外)
  // 所以 4 / 8 开头都是北交所 (除了 4xxxxx 但 4 开头 6 位代码当前只在 BJ 出现)
  if (code.startsWith('4') || code.startsWith('8')) {
    // 但 sh.9xx 是 B 股, 不要在这里误判
    if (prefix === 'sh' || suffix === 'SH') {
      // sh.4xxxxx / sh.8xxxxx 当前不存在; 仍 fallback main
      return 'main';
    }
    return 'bj';
  }
  // sh.6xx / sh.9xx (B 股) / sz.0xx / sz.2xx
  if (
    code.startsWith('6') ||
    code.startsWith('9') ||
    code.startsWith('0') ||
    code.startsWith('2')
  ) {
    return 'main';
  }
  return 'unknown';
}

/**
 * 按市场段 + ST 标志返回涨跌停幅度 (小数)。
 *
 * ST 总是 5%, 不论市场段 (北交所 ST 也是 5%)。
 * unknown 段返回 0.10 兜底 (保守, 与主板等同)。
 */
export function getLimitPct(segment: MarketSegment, isST: boolean): number {
  if (isST) return ST_LIMIT_PCT;
  switch (segment) {
    case 'chinext':
      return CHINEXT_LIMIT_PCT;
    case 'star':
      return STAR_LIMIT_PCT;
    case 'bj':
      return BJ_LIMIT_PCT;
    case 'main':
    case 'unknown':
    default:
      return MAIN_LIMIT_PCT;
  }
}

/**
 * 把价格 round 到 A 股最小 tick (0.01 元) — round-half-up 与券商客户端口径一致。
 *
 * 例:
 *   - 12.345 → 12.35 (half up)
 *   - 12.344 → 12.34
 *   - -1.235 → -1.23 (half away from zero)
 */
export function roundToTick(price: number, tick: number = A_SHARE_TICK): number {
  if (!Number.isFinite(price) || tick <= 0) return price;
  const sign = price < 0 ? -1 : 1;
  const abs = Math.abs(price);
  // Math.round 在 JS 是 round-half-to-positive-infinity, 对正数等价 half-up。
  const rounded = Math.round(abs / tick) * tick;
  // 防止 0.1 + 0.2 = 0.30000000000004 这类浮点尾巴 → 用 fixed-decimal 整理。
  const decimals = Math.max(0, Math.round(-Math.log10(tick)));
  return sign * Number(rounded.toFixed(decimals));
}

/**
 * 按 prev_close + market segment + ST 算涨跌停价格 (含 0.01 tick round)。
 *
 * 返回 { upper, lower } 都是 round 后的实际可成交价。
 * prev_close ≤ 0 或非数字 → 抛 RangeError (业务层兜底)。
 */
export function getLimitPrices(
  prevClose: number,
  segment: MarketSegment,
  isST: boolean
): { upper: number; lower: number } {
  if (!Number.isFinite(prevClose) || prevClose <= 0) {
    throw new RangeError(`getLimitPrices: invalid prev_close ${prevClose}`);
  }
  const pct = getLimitPct(segment, isST);
  const upper = roundToTick(prevClose * (1 + pct));
  const lower = roundToTick(prevClose * (1 - pct));
  return { upper, lower };
}

/**
 * 判定 bar 是否触及涨停。
 *
 * 用 high / close 任一 ≥ upper - 1bp 算 hit (open 单独也算 — 高开涨停)。
 * 这是为了让"盘中触及"和"收盘封板"都能识别，比仅看 close 更严。
 */
export function isAtLimitUp(
  bar: { open?: number | null; high?: number | null; close?: number | null },
  segment: MarketSegment,
  isST: boolean,
  prevClose: number
): boolean {
  if (!Number.isFinite(prevClose) || prevClose <= 0) return false;
  const { upper } = getLimitPrices(prevClose, segment, isST);
  const threshold = upper * (1 - LIMIT_EPSILON);
  const o = Number(bar.open ?? 0);
  const h = Number(bar.high ?? 0);
  const c = Number(bar.close ?? 0);
  return (
    (Number.isFinite(o) && o >= threshold) ||
    (Number.isFinite(h) && h >= threshold) ||
    (Number.isFinite(c) && c >= threshold)
  );
}

/**
 * 判定 bar 是否触及跌停 (用 low / close 任一 ≤ lower + 1bp)。
 */
export function isAtLimitDown(
  bar: { open?: number | null; low?: number | null; close?: number | null },
  segment: MarketSegment,
  isST: boolean,
  prevClose: number
): boolean {
  if (!Number.isFinite(prevClose) || prevClose <= 0) return false;
  const { lower } = getLimitPrices(prevClose, segment, isST);
  const threshold = lower * (1 + LIMIT_EPSILON);
  const o = Number(bar.open ?? 0);
  const l = Number(bar.low ?? 0);
  const c = Number(bar.close ?? 0);
  return (
    (Number.isFinite(o) && o > 0 && o <= threshold) ||
    (Number.isFinite(l) && l > 0 && l <= threshold) ||
    (Number.isFinite(c) && c > 0 && c <= threshold)
  );
}

/**
 * symbol 是否属于北交所 (供 universe filter / strategy override 用)。
 *
 * 用法:
 *   const stocks = await Stock.findAll({...});
 *   const filtered = includeBJ ? stocks : stocks.filter(s => !isBeijingExchange(s.symbol));
 */
export function isBeijingExchange(symbol: string | null | undefined): boolean {
  return inferMarketSegment(symbol) === 'bj';
}

/**
 * 便利封装: 一步算出 (segment + limit_pct + upper + lower)。
 *
 * 用于策略 / 实盘 / 回测三处需要"完整 limit context"的场景, 避免分 3 步调用。
 */
export function describeLimits(
  symbol: string,
  name: string | null | undefined,
  prevClose: number
): {
  segment: MarketSegment;
  is_st: boolean;
  limit_pct: number;
  upper: number | null;
  lower: number | null;
} {
  const segment = inferMarketSegment(symbol);
  const is_st = isSTName(name);
  const limit_pct = getLimitPct(segment, is_st);
  let upper: number | null = null;
  let lower: number | null = null;
  if (Number.isFinite(prevClose) && prevClose > 0) {
    const prices = getLimitPrices(prevClose, segment, is_st);
    upper = prices.upper;
    lower = prices.lower;
  }
  return { segment, is_st, limit_pct, upper, lower };
}

// 重导出 isSTName 以便单文件 import 完成所有判定
export { isSTName };
