/**
 * LimitUpBoardDetector — PR-O2 (2026-06-29)
 *
 * 实现 PR-I-v2 战法库 §1 涨停板战法 (流派 1, 落地率 0% → 50%). 每日 15:30 跑
 * (盘后 T+1 推荐); 对今日 limit_up_stocks 中的每只票运行 20+ 战法 classifier,
 * 命中即写 RiskAlert (level=MEDIUM, rule_id='limit_up_<pattern>') + 写
 * AIInvestmentSignal (source_type='limit_up_board', metadata.timing_tag='overnight').
 *
 * ============================================================================
 *  20+ classifier (按 PR-I-v2 §1.1-1.7 分组), 全 export 纯函数:
 * ============================================================================
 * §1.1 首板 (6)
 *   classifyOneWord           — 一字板: is_one_word_board=true (开盘即封, 无炸板)
 *   classifyTWord             — T 字板: 9:30 前封, 炸板 ≥ 1 但再封
 *   classifyBroken            — 烂板: 炸板次数 ≥ 3
 *   classifyStrongFirstBoard  — 强势板: 9:30 前封 + 封单 > 阈值, 首板
 *   classifyWeakToStrong      — 弱转强: 早盘弱 (无 limit_up_time ≤ 11:30) → 午后封 (≥ 13:00)
 *   classifyZhongjun          — 中军股: 同行业涨停数 ≥ 3 (板块龙头候选)
 * §1.2 二板 (4)
 *   classifySecondBoardAccelerate — 二板加速: continuous_days=2 + 9:30 内秒板
 *   classifySecondBoardRefill     — 二板回封: continuous_days=2 + 炸板 ≥ 1 + 仍封
 *   classifySecondBoardFilling    — 二板填谷: continuous_days=2 + 当日阴线 (open > close 涨停价附近)
 *   classifyTwoToThree            — 二进三 (前日已是二板, 今日 continuous_days=3)
 * §1.3 高位连板 (3)
 *   classifyHighConsecutiveAccelerate — 三板+ 当日 spread 收窄 (high/open 涨停)
 *   classifyConsecutiveHeightPlay     — 同板块当前最高板 (industry 龙头)
 *   classifyConsecutiveLadder         — 全市场连板天梯前 5
 * §1.4 反包 (3)
 *   classifyDiTian            — 地天板: 当日 low ≤ 跌停, close = 涨停
 *   classifyBrokenRefillNextDay — 前日烂板 → 今日反包涨停
 *   classifyLimitDownRefill   — 前日跌停 → 今日反包涨停
 * §1.5 炸板 (2)
 *   classifyBrokenRefill              — 炸板回封: 炸板 1-2 次 + 最终封 (与烂板区分)
 *   classifyBrokenRefillWithTurnover  — 炸板换手二次封板 (炸板 + 当日换手 > 15%)
 * §1.6 接力 (2)
 *   classifyLeaderTakeover  — 龙头退潮日, 接力次龙头 (同行业前日有 ≥ 5 板, 今日掉队)
 *   classifyFollowPlay      — 跟风接力: 同行业龙头前 30min 已封, 本票后封
 *
 * 单条票可命中多个 pattern (e.g. 一字 + 强势 + 中军). 全部 RiskAlert + Signal 都写.
 *
 * ============================================================================
 *  fail-OPEN 3 层
 * ============================================================================
 *   1. universe 加载失败 → 返空 result, 不抛
 *   2. batch (single classifier loop) 失败 → 仅 warn, 跳过该 batch
 *   3. per-stock 写入失败 → per-row try/catch, 单条失败仅 warn 累计 errors[].
 *
 * ============================================================================
 *  约束 (硬)
 * ============================================================================
 *   - 不引新 npm
 *   - 不修改 PR-L/H/M-star/N 已 merge 代码 (仅新增文件)
 *   - 纯函数 classifier 全 export, 单测覆盖
 *   - RiskAlert rule_id: limit_up_<pattern>
 *   - AIInvestmentSignal source_type='limit_up_board'; metadata.timing_tag='overnight';
 *     metadata.pattern=<pattern>; metadata.continuous_days=N
 */

import { logger } from '../utils/logger';
import { normalizeSymbol } from '../utils/stockSymbol';
import { isAShareTradeDay } from '../utils/tradingCalendar';
import moment from 'moment-timezone';
import { ensureModelsRegistered } from '../config/database';

// PR-Q (2026-06-30): cold-path Model not initialized hot-fix (AR-1 范式).
ensureModelsRegistered();

// ===========================================================================
//  Types
// ===========================================================================

/** 20+ 战法 pattern key. 与 rule_id 后缀 + metadata.pattern 严格一致. */
export type LimitUpPattern =
  // 1.1 首板
  | 'one_word'
  | 't_word'
  | 'broken'
  | 'strong_first_board'
  | 'weak_to_strong'
  | 'zhongjun'
  // 1.2 二板
  | 'second_board_accelerate'
  | 'second_board_refill'
  | 'second_board_filling'
  | 'two_to_three'
  // 1.3 高位连板
  | 'high_consecutive_accelerate'
  | 'consecutive_height_play'
  | 'consecutive_ladder'
  // 1.4 反包
  | 'di_tian'
  | 'broken_refill_next_day'
  | 'limit_down_refill'
  // 1.5 炸板
  | 'broken_refill'
  | 'broken_refill_with_turnover'
  // 1.6 接力
  | 'leader_takeover'
  | 'follow_play';

export const LIMIT_UP_PATTERNS: readonly LimitUpPattern[] = Object.freeze([
  'one_word',
  't_word',
  'broken',
  'strong_first_board',
  'weak_to_strong',
  'zhongjun',
  'second_board_accelerate',
  'second_board_refill',
  'second_board_filling',
  'two_to_three',
  'high_consecutive_accelerate',
  'consecutive_height_play',
  'consecutive_ladder',
  'di_tian',
  'broken_refill_next_day',
  'limit_down_refill',
  'broken_refill',
  'broken_refill_with_turnover',
  'leader_takeover',
  'follow_play',
]);

/** 用于 UI badge 显示的中文名 (PR-I-v2 战法名). */
export const LIMIT_UP_PATTERN_LABELS: Record<LimitUpPattern, string> = Object.freeze({
  one_word: '一字板',
  t_word: 'T 字板',
  broken: '烂板',
  strong_first_board: '强势板',
  weak_to_strong: '弱转强',
  zhongjun: '中军股',
  second_board_accelerate: '二板加速',
  second_board_refill: '二板回封',
  second_board_filling: '二板填谷',
  two_to_three: '二进三',
  high_consecutive_accelerate: '高位连板加速',
  consecutive_height_play: '板块最高板',
  consecutive_ladder: '连板天梯',
  di_tian: '地天板',
  broken_refill_next_day: '烂板反包',
  limit_down_refill: '跌停反包',
  broken_refill: '炸板回封',
  broken_refill_with_turnover: '炸板换手回封',
  leader_takeover: '龙头接力',
  follow_play: '跟风接力',
}) as Record<LimitUpPattern, string>;

/** 命中起步置信度 (写入 AIInvestmentSignal.confidence_score 用). 越成熟的战法越高. */
export const LIMIT_UP_PATTERN_BASE_SCORE: Record<LimitUpPattern, number> = Object.freeze({
  // 一字 / T 字最强 (开盘即被资金抢)
  one_word: 88,
  t_word: 80,
  // 烂板风险高
  broken: 50,
  strong_first_board: 82,
  weak_to_strong: 78,
  zhongjun: 75,
  // 二板加速最强 (强势确认)
  second_board_accelerate: 82,
  second_board_refill: 72,
  second_board_filling: 68,
  two_to_three: 78,
  // 高位风险溢价
  high_consecutive_accelerate: 70,
  consecutive_height_play: 76,
  consecutive_ladder: 70,
  // 反包带情绪转折
  di_tian: 82,
  broken_refill_next_day: 70,
  limit_down_refill: 68,
  // 炸板回封
  broken_refill: 68,
  broken_refill_with_turnover: 72,
  // 接力
  leader_takeover: 70,
  follow_play: 65,
}) as Record<LimitUpPattern, number>;

/** 单只票今日的涨停信息 (从 limit_up_stocks 拿). */
export interface LimitUpRow {
  trade_date: string;
  stock_code: string; // 6 位 bare
  stock_name: string | null;
  limit_up_time: string | null; // HH:MM:SS
  limit_up_amount: number | null;
  limit_up_open_times: number | null; // 炸板次数
  continuous_days: number;
  industry: string | null;
  is_one_word_board: boolean;
}

/** 当日 / 昨日 daily_bar (用来判反包 / 地天 / spread 收窄 / 换手率). */
export interface DailyBarLite {
  stock_code: string; // 6 位 bare
  trade_date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  prev_close: number | null; // 用来算涨跌停价
  turnover_rate: number | null; // %
  change_percent: number | null; // %
}

/** ST / 注册制板 5pct/20pct 涨跌停规则的简化判定. */
export function limitUpPct(stock_code: string, stock_name?: string | null): number {
  const code = String(stock_code || '').trim();
  const name = String(stock_name || '').trim();
  if (name.includes('ST') || name.includes('*ST')) return 5;
  // 创业板 (300) / 科创板 (688) / 北交所 (8/4) 20%
  if (code.startsWith('300') || code.startsWith('688') || code.startsWith('8') || code.startsWith('4')) {
    return 20;
  }
  // 北交所注册制存在 30% 弹性, 这里简化 — 后续可扩
  return 10;
}

/** 涨停价 (四舍五入到 2 位 — 与交易所规则一致). */
export function limitUpPrice(prev_close: number, pct: number): number {
  if (!Number.isFinite(prev_close) || prev_close <= 0) return NaN;
  return Math.round(prev_close * (1 + pct / 100) * 100) / 100;
}

export function limitDownPrice(prev_close: number, pct: number): number {
  if (!Number.isFinite(prev_close) || prev_close <= 0) return NaN;
  return Math.round(prev_close * (1 - pct / 100) * 100) / 100;
}

/** "HH:MM:SS" → minute-of-day. 不可解析返 null. */
export function parseHMSToMinute(hms: string | null | undefined): number | null {
  if (!hms) return null;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(hms).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(mm)) return null;
  return h * 60 + mm;
}

/** 9:30 = 570. 接近 9:25-9:30 = 一字 / 秒板; ≤ 9:45 = 强势开盘. */
export const MORNING_OPEN_MIN = 9 * 60 + 30; // 570
export const SECOND_BREAK_MIN = 11 * 60 + 30; // 690 上午收盘
export const AFTERNOON_OPEN_MIN = 13 * 60; // 780
export const STRONG_BOARD_CUTOFF_MIN = MORNING_OPEN_MIN; // 9:30 即为"秒板"
export const SECOND_BOARD_ACCELERATE_CUTOFF_MIN = MORNING_OPEN_MIN; // 二板要"秒板"
export const ZHONGJUN_INDUSTRY_LIMIT_UP_THRESHOLD = 3;
export const STRONG_BOARD_AMOUNT_THRESHOLD_YUAN = 100_000_000; // 1 亿封单为强 (粗阈值)
export const BROKEN_TIMES_LIMIT = 3; // 炸板 ≥ 3 = 烂板
export const TURNOVER_HIGH_PCT = 15; // 换手率 ≥ 15% (炸板回封强势)
export const LADDER_TOP_N = 5; // 全市场连板天梯前 N 名

// ===========================================================================
//  1.1 首板 classifier
// ===========================================================================

export function classifyOneWord(row: LimitUpRow): boolean {
  if (!row) return false;
  // 直接采用 LimitUpStock.is_one_word_board (Python 端预计算: 首封 ≤ 09:30 且 炸板=0)
  return row.is_one_word_board === true && row.continuous_days >= 1;
}

export function classifyTWord(row: LimitUpRow): boolean {
  if (!row) return false;
  const minute = parseHMSToMinute(row.limit_up_time);
  if (minute === null) return false;
  if (minute > MORNING_OPEN_MIN + 5) return false; // 首封必须在 9:35 前
  const openTimes = Number(row.limit_up_open_times || 0);
  // 早盘封 + 炸过 (≥ 1) + 最终仍封 = T 字
  return openTimes >= 1 && openTimes < BROKEN_TIMES_LIMIT;
}

export function classifyBroken(row: LimitUpRow): boolean {
  if (!row) return false;
  return Number(row.limit_up_open_times || 0) >= BROKEN_TIMES_LIMIT;
}

export function classifyStrongFirstBoard(row: LimitUpRow): boolean {
  if (!row) return false;
  if (row.continuous_days !== 1) return false; // 首板专属
  const minute = parseHMSToMinute(row.limit_up_time);
  if (minute === null) return false;
  if (minute > STRONG_BOARD_CUTOFF_MIN) return false;
  const amount = Number(row.limit_up_amount || 0);
  if (!Number.isFinite(amount)) return false;
  return amount >= STRONG_BOARD_AMOUNT_THRESHOLD_YUAN;
}

export function classifyWeakToStrong(row: LimitUpRow): boolean {
  if (!row) return false;
  const minute = parseHMSToMinute(row.limit_up_time);
  if (minute === null) return false;
  // 午后才封 (≥ 13:00) → 早盘必弱
  return minute >= AFTERNOON_OPEN_MIN;
}

/**
 * 中军: 同行业今日涨停数 ≥ 阈值. 需要 industryLimitUpCount(industry) 注入.
 * (因为 zhongjun 需要全市场视角)
 */
export function classifyZhongjun(
  row: LimitUpRow,
  industryLimitUpCount: number
): boolean {
  if (!row) return false;
  if (!row.industry) return false;
  return industryLimitUpCount >= ZHONGJUN_INDUSTRY_LIMIT_UP_THRESHOLD;
}

// ===========================================================================
//  1.2 二板 classifier
// ===========================================================================

export function classifySecondBoardAccelerate(row: LimitUpRow): boolean {
  if (!row) return false;
  if (row.continuous_days !== 2) return false;
  const minute = parseHMSToMinute(row.limit_up_time);
  if (minute === null) return false;
  return minute <= SECOND_BOARD_ACCELERATE_CUTOFF_MIN;
}

export function classifySecondBoardRefill(row: LimitUpRow): boolean {
  if (!row) return false;
  if (row.continuous_days !== 2) return false;
  const openTimes = Number(row.limit_up_open_times || 0);
  return openTimes >= 1 && openTimes < BROKEN_TIMES_LIMIT;
}

/**
 * 二板填谷: continuous_days=2 + 阴线 (open > close 涨停价的最后封板).
 * 需要 today bar 来判断阴/阳线; 没有 bar 数据时不命中 (保守).
 */
export function classifySecondBoardFilling(
  row: LimitUpRow,
  todayBar: DailyBarLite | null
): boolean {
  if (!row) return false;
  if (row.continuous_days !== 2) return false;
  if (!todayBar) return false;
  const open = Number(todayBar.open);
  const close = Number(todayBar.close);
  if (!Number.isFinite(open) || !Number.isFinite(close)) return false;
  // 阴线封板: open > close (虽收涨停, 但开高走低再勉强封)
  return open > close;
}

/** 二进三: 今日 continuous_days = 3 (即昨日已是二板). */
export function classifyTwoToThree(row: LimitUpRow): boolean {
  if (!row) return false;
  return row.continuous_days === 3;
}

// ===========================================================================
//  1.3 高位连板 classifier
// ===========================================================================

/**
 * 高位加速: ≥ 3 板 + 当日 high/open 都在涨停 (开盘即冲顶, spread 窄).
 * 没 bar 时按 continuous_days ≥ 3 兜底命中.
 */
export function classifyHighConsecutiveAccelerate(
  row: LimitUpRow,
  todayBar: DailyBarLite | null
): boolean {
  if (!row) return false;
  if (row.continuous_days < 3) return false;
  if (!todayBar) return true; // 兜底
  const high = Number(todayBar.high);
  const close = Number(todayBar.close);
  const prevClose = Number(todayBar.prev_close);
  if (!Number.isFinite(high) || !Number.isFinite(close) || !Number.isFinite(prevClose) || prevClose <= 0) return true;
  const pct = limitUpPct(row.stock_code, row.stock_name);
  const limit = limitUpPrice(prevClose, pct);
  if (!Number.isFinite(limit)) return true;
  // high 与 close 同价 (= 涨停) 视为"全天封板, spread 窄"
  return Math.abs(high - limit) < 0.01 && Math.abs(close - limit) < 0.01;
}

/**
 * 板块最高板: 本票连板数 = 同行业今日最高 (industry leader).
 */
export function classifyConsecutiveHeightPlay(
  row: LimitUpRow,
  industryMaxContinuousDays: number
): boolean {
  if (!row) return false;
  if (!row.industry) return false;
  if (row.continuous_days < 2) return false; // 首板不算"高度龙头"
  return row.continuous_days >= industryMaxContinuousDays;
}

/**
 * 全市场连板天梯: 本票排在 top N (前 5) 高度.
 * 注: 同高度可并列 (e.g. 3 个 5 板 + 5 个 4 板, 前 5 都算).
 */
export function classifyConsecutiveLadder(
  row: LimitUpRow,
  marketRankedHeights: number[] // 已按降序去重的"全市场出现过的连板高度"
): boolean {
  if (!row) return false;
  if (row.continuous_days < 2) return false;
  const topHeights = marketRankedHeights.slice(0, LADDER_TOP_N);
  return topHeights.includes(row.continuous_days);
}

// ===========================================================================
//  1.4 反包 classifier
// ===========================================================================

/** 地天板: 当日 low 触及跌停 + close = 涨停. */
export function classifyDiTian(
  row: LimitUpRow,
  todayBar: DailyBarLite | null
): boolean {
  if (!row || !todayBar) return false;
  const low = Number(todayBar.low);
  const close = Number(todayBar.close);
  const prevClose = Number(todayBar.prev_close);
  if (!Number.isFinite(low) || !Number.isFinite(close) || !Number.isFinite(prevClose) || prevClose <= 0) return false;
  const pct = limitUpPct(row.stock_code, row.stock_name);
  const lp = limitDownPrice(prevClose, pct);
  const up = limitUpPrice(prevClose, pct);
  if (!Number.isFinite(lp) || !Number.isFinite(up)) return false;
  return low <= lp + 0.01 && Math.abs(close - up) < 0.01;
}

/** 前日烂板 → 今日反包涨停 (前日 broken_count ≥ 3 + 今日 continuous_days=1). */
export function classifyBrokenRefillNextDay(
  row: LimitUpRow,
  prevDayLimitUpRow: LimitUpRow | null
): boolean {
  if (!row) return false;
  if (row.continuous_days !== 1) return false;
  if (!prevDayLimitUpRow) return false;
  return Number(prevDayLimitUpRow.limit_up_open_times || 0) >= BROKEN_TIMES_LIMIT;
}

/** 前日跌停 → 今日涨停反包. 需要前日 daily_bar (close vs prev_close 算跌停). */
export function classifyLimitDownRefill(
  row: LimitUpRow,
  yesterdayBar: DailyBarLite | null
): boolean {
  if (!row || !yesterdayBar) return false;
  const close = Number(yesterdayBar.close);
  const prevClose = Number(yesterdayBar.prev_close);
  if (!Number.isFinite(close) || !Number.isFinite(prevClose) || prevClose <= 0) return false;
  const pct = limitUpPct(row.stock_code, row.stock_name);
  const ld = limitDownPrice(prevClose, pct);
  if (!Number.isFinite(ld)) return false;
  // 昨日收盘 ≤ 跌停价 + 0.01 (允许小数浮动)
  return close <= ld + 0.01;
}

// ===========================================================================
//  1.5 炸板 classifier
// ===========================================================================

/** 炸板回封: 炸板 1-2 次 + 最终封 (与"烂板 ≥ 3" 区分). */
export function classifyBrokenRefill(row: LimitUpRow): boolean {
  if (!row) return false;
  const openTimes = Number(row.limit_up_open_times || 0);
  return openTimes >= 1 && openTimes < BROKEN_TIMES_LIMIT;
}

/** 炸板换手二次封板: 炸板 ≥ 1 + 当日 turnover_rate > 15%. */
export function classifyBrokenRefillWithTurnover(
  row: LimitUpRow,
  todayBar: DailyBarLite | null
): boolean {
  if (!row || !todayBar) return false;
  const openTimes = Number(row.limit_up_open_times || 0);
  if (openTimes < 1) return false;
  const turnover = Number(todayBar.turnover_rate);
  if (!Number.isFinite(turnover)) return false;
  return turnover >= TURNOVER_HIGH_PCT;
}

// ===========================================================================
//  1.6 接力 classifier
// ===========================================================================

/**
 * 龙头接力: 同行业前日存在 ≥ 5 板的龙头, 今日该龙头掉队 (今日 limit_up_stocks 里
 * 该行业最高板 < 前日龙头高度). 本票今日 ≥ 2 板 (次龙头候选).
 */
export function classifyLeaderTakeover(
  row: LimitUpRow,
  prevDayIndustryMaxHeight: number,
  todayIndustryMaxHeight: number
): boolean {
  if (!row) return false;
  if (row.continuous_days < 2) return false;
  if (prevDayIndustryMaxHeight < 5) return false;
  return todayIndustryMaxHeight < prevDayIndustryMaxHeight;
}

/**
 * 跟风接力: 同行业今日已有 ≥ 1 票 9:30 前秒板的龙头 + 本票在 30min 内 (≤ 10:00) 跟封.
 * 本票自己不能就是 9:30 前那只 (用 limit_up_time 排除).
 */
export function classifyFollowPlay(
  row: LimitUpRow,
  industryHasEarlyLeader: boolean
): boolean {
  if (!row || !industryHasEarlyLeader) return false;
  const minute = parseHMSToMinute(row.limit_up_time);
  if (minute === null) return false;
  // 本票自己不能就是 9:30 前那只 (避免对自己 follow); 在 9:30 - 10:00 间跟封
  return minute > MORNING_OPEN_MIN && minute <= MORNING_OPEN_MIN + 30;
}

// ===========================================================================
//  Aggregator — 对一只票运行全部 classifier, 返回命中 pattern 集
// ===========================================================================

export interface ClassifyContext {
  /** 今日 daily_bar (含 turnover_rate / change_percent). 可空. */
  todayBar: DailyBarLite | null;
  /** 昨日 daily_bar (用于 limit_down_refill). 可空. */
  yesterdayBar: DailyBarLite | null;
  /** 昨日 limit_up_stocks 同 stock 行 (用于 broken_refill_next_day). 可空. */
  prevDayLimitUpRow: LimitUpRow | null;
  /** 同行业今日涨停数. */
  industryLimitUpCount: number;
  /** 同行业今日最高板. */
  industryMaxContinuousDays: number;
  /** 同行业前日最高板 (leader_takeover 用). */
  prevDayIndustryMaxHeight: number;
  /** 同行业今日是否存在 9:30 前秒板的龙头 (follow_play 用). */
  industryHasEarlyLeader: boolean;
  /** 全市场连板高度 ranking (从高到低去重). */
  marketRankedHeights: number[];
}

/** 对单只票运行全部 20+ classifier, 返命中 pattern 集 (有序去重). */
export function classifyAll(row: LimitUpRow, ctx: ClassifyContext): LimitUpPattern[] {
  const hits = new Set<LimitUpPattern>();
  const tryHit = (p: LimitUpPattern, hit: boolean): void => {
    if (hit) hits.add(p);
  };
  // 1.1
  tryHit('one_word', classifyOneWord(row));
  tryHit('t_word', classifyTWord(row));
  tryHit('broken', classifyBroken(row));
  tryHit('strong_first_board', classifyStrongFirstBoard(row));
  tryHit('weak_to_strong', classifyWeakToStrong(row));
  tryHit('zhongjun', classifyZhongjun(row, ctx.industryLimitUpCount));
  // 1.2
  tryHit('second_board_accelerate', classifySecondBoardAccelerate(row));
  tryHit('second_board_refill', classifySecondBoardRefill(row));
  tryHit('second_board_filling', classifySecondBoardFilling(row, ctx.todayBar));
  tryHit('two_to_three', classifyTwoToThree(row));
  // 1.3
  tryHit('high_consecutive_accelerate', classifyHighConsecutiveAccelerate(row, ctx.todayBar));
  tryHit('consecutive_height_play', classifyConsecutiveHeightPlay(row, ctx.industryMaxContinuousDays));
  tryHit('consecutive_ladder', classifyConsecutiveLadder(row, ctx.marketRankedHeights));
  // 1.4
  tryHit('di_tian', classifyDiTian(row, ctx.todayBar));
  tryHit('broken_refill_next_day', classifyBrokenRefillNextDay(row, ctx.prevDayLimitUpRow));
  tryHit('limit_down_refill', classifyLimitDownRefill(row, ctx.yesterdayBar));
  // 1.5
  tryHit('broken_refill', classifyBrokenRefill(row));
  tryHit('broken_refill_with_turnover', classifyBrokenRefillWithTurnover(row, ctx.todayBar));
  // 1.6
  tryHit(
    'leader_takeover',
    classifyLeaderTakeover(row, ctx.prevDayIndustryMaxHeight, ctx.industryMaxContinuousDays)
  );
  tryHit('follow_play', classifyFollowPlay(row, ctx.industryHasEarlyLeader));
  return Array.from(hits);
}

// ===========================================================================
//  Pure helpers (Aggregator support)
// ===========================================================================

/** 按 industry 聚合 limit_up 数量. */
export function buildIndustryLimitUpCount(rows: LimitUpRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows || []) {
    if (!r || !r.industry) continue;
    out.set(r.industry, (out.get(r.industry) || 0) + 1);
  }
  return out;
}

/** 按 industry 聚合最大 continuous_days. */
export function buildIndustryMaxHeight(rows: LimitUpRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows || []) {
    if (!r || !r.industry) continue;
    const cur = out.get(r.industry) || 0;
    if (r.continuous_days > cur) out.set(r.industry, r.continuous_days);
  }
  return out;
}

/** 按 industry 判定"是否存在 9:30 前秒板的龙头". */
export function buildIndustryEarlyLeaderMap(rows: LimitUpRow[]): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const r of rows || []) {
    if (!r || !r.industry) continue;
    const minute = parseHMSToMinute(r.limit_up_time);
    if (minute !== null && minute <= MORNING_OPEN_MIN) {
      out.set(r.industry, true);
    } else if (!out.has(r.industry)) {
      out.set(r.industry, false);
    }
  }
  return out;
}

/** 全市场连板高度 — 去重降序. */
export function buildMarketRankedHeights(rows: LimitUpRow[]): number[] {
  const heights = new Set<number>();
  for (const r of rows || []) {
    if (r && Number.isFinite(r.continuous_days) && r.continuous_days >= 1) {
      heights.add(r.continuous_days);
    }
  }
  return Array.from(heights).sort((a, b) => b - a);
}

/** ISO 日期 = today (Asia/Shanghai). */
export function todayInShanghai(now: Date = new Date()): string {
  return moment(now).tz('Asia/Shanghai').format('YYYY-MM-DD');
}

/** ISO 日期 - N 天. */
export function shiftIsoDate(iso: string, deltaDays: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

// ===========================================================================
//  DataSource (DI seam — 单测注入 fake 完全脱 DB)
// ===========================================================================

export interface LimitUpBoardDataSource {
  /** 加载某日 limit_up_stocks 全表. */
  loadLimitUpRows(trade_date: string): Promise<LimitUpRow[]>;
  /** 加载今日 + 昨日 daily_bars (key = stock_code), 给 bar-context 判定用. */
  loadDailyBars(stock_codes: string[], trade_date: string): Promise<{
    today: Map<string, DailyBarLite>;
    yesterday: Map<string, DailyBarLite>;
  }>;
  /** 加载前一交易日 limit_up_stocks (broken_refill_next_day 用). */
  loadPrevDayLimitUpRows(trade_date: string): Promise<LimitUpRow[]>;
  /** 加载 active user_ids (写 RiskAlert 时 fan-out). */
  listActiveUserIds(): Promise<number[]>;
  /** 已写过的 (stock, pattern, date) dedup key 集 (24h 窗). */
  loadRecentDedupKeys(sinceHours: number): Promise<Set<string>>;
  /** 写 RiskAlert per user. fail-OPEN per-user. */
  writeRiskAlerts(input: {
    user_ids: number[];
    symbol: string; // 带前缀
    name: string;
    level: 'MEDIUM';
    rule_id: string;
    message: string;
  }): Promise<{ created_ids: number[]; failed: number }>;
  /** 写 AIInvestmentSignal source_type='limit_up_board'. idempotent on (source_type, source_id). */
  writeLimitUpSignal(input: {
    stock_code: string; // 6 位 bare
    prefixed_symbol: string;
    name: string;
    signal_date: string;
    pattern: LimitUpPattern;
    pattern_label: string;
    reason: string;
    score: number;
    continuous_days: number;
    industry: string | null;
  }): Promise<{ signal_id: number | null; created: boolean }>;
}

// ===========================================================================
//  Production DataSource (lazy require — 避免顶层 import 重量级 model)
// ===========================================================================

class DefaultLimitUpBoardDataSource implements LimitUpBoardDataSource {
  async loadLimitUpRows(trade_date: string): Promise<LimitUpRow[]> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { LimitUpStock } = require('../models/LimitUpStock');
      const rows: any[] = await LimitUpStock.findAll({
        where: { trade_date },
        raw: true,
      });
      return (rows || []).map(toLimitUpRow);
    } catch (e: any) {
      logger.warn(`[LimitUpBoardDetector] loadLimitUpRows failed: ${e?.message || e}`);
      return [];
    }
  }

  async loadDailyBars(
    stock_codes: string[],
    trade_date: string
  ): Promise<{ today: Map<string, DailyBarLite>; yesterday: Map<string, DailyBarLite> }> {
    const today = new Map<string, DailyBarLite>();
    const yesterday = new Map<string, DailyBarLite>();
    if (!stock_codes || stock_codes.length === 0) return { today, yesterday };
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Stock } = require('../models/Stock');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { DailyBar } = require('../models/DailyBar');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Op } = require('sequelize');

      // 1. stock_code (bare) → stock_id 反查
      const symbolPatterns = stock_codes.map(c => `%${c}`);
      const stocks: any[] = await Stock.findAll({
        attributes: ['id', 'symbol', 'name'],
        where: { symbol: { [Op.or]: symbolPatterns.map((p: string) => ({ [Op.like]: p })) } },
        raw: true,
      });
      const stockIdToBare = new Map<number, string>();
      for (const s of stocks || []) {
        const bare = bareFromAny(String(s.symbol || ''));
        if (bare) stockIdToBare.set(Number(s.id), bare);
      }
      const stockIds = Array.from(stockIdToBare.keys());
      if (stockIds.length === 0) return { today, yesterday };

      // 2. 拉今日 + 近 3 个交易日的 daily_bars (Asia/Shanghai 边界)
      const endTime = moment.tz(`${trade_date} 23:59:59`, 'YYYY-MM-DD HH:mm:ss', 'Asia/Shanghai').toDate();
      const startTime = moment.tz(`${trade_date} 00:00:00`, 'YYYY-MM-DD HH:mm:ss', 'Asia/Shanghai')
        .subtract(7, 'days')
        .toDate();
      const bars: any[] = await DailyBar.findAll({
        attributes: [
          'stock_id', 'time', 'open', 'high', 'low', 'close',
          'turnover_rate', 'change_percent',
        ],
        where: {
          stock_id: { [Op.in]: stockIds },
          time: { [Op.between]: [startTime, endTime] },
        },
        order: [['time', 'ASC']],
        raw: true,
      });

      // 3. 按 stock 分组 → 取最后 2 根 (today + yesterday)
      const byStock = new Map<number, any[]>();
      for (const b of bars || []) {
        const sid = Number(b.stock_id);
        if (!byStock.has(sid)) byStock.set(sid, []);
        byStock.get(sid)!.push(b);
      }
      for (const [sid, arr] of byStock) {
        const bare = stockIdToBare.get(sid);
        if (!bare) continue;
        arr.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
        const last = arr[arr.length - 1];
        const prev = arr.length >= 2 ? arr[arr.length - 2] : null;
        if (last) {
          today.set(bare, {
            stock_code: bare,
            trade_date: moment(last.time).tz('Asia/Shanghai').format('YYYY-MM-DD'),
            open: numberOrNull(last.open),
            high: numberOrNull(last.high),
            low: numberOrNull(last.low),
            close: numberOrNull(last.close),
            prev_close: prev ? numberOrNull(prev.close) : null,
            turnover_rate: numberOrNull(last.turnover_rate),
            change_percent: numberOrNull(last.change_percent),
          });
        }
        if (prev) {
          const prev2 = arr.length >= 3 ? arr[arr.length - 3] : null;
          yesterday.set(bare, {
            stock_code: bare,
            trade_date: moment(prev.time).tz('Asia/Shanghai').format('YYYY-MM-DD'),
            open: numberOrNull(prev.open),
            high: numberOrNull(prev.high),
            low: numberOrNull(prev.low),
            close: numberOrNull(prev.close),
            prev_close: prev2 ? numberOrNull(prev2.close) : null,
            turnover_rate: numberOrNull(prev.turnover_rate),
            change_percent: numberOrNull(prev.change_percent),
          });
        }
      }
    } catch (e: any) {
      logger.warn(`[LimitUpBoardDetector] loadDailyBars failed: ${e?.message || e}`);
    }
    return { today, yesterday };
  }

  async loadPrevDayLimitUpRows(trade_date: string): Promise<LimitUpRow[]> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { LimitUpStock } = require('../models/LimitUpStock');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Op } = require('sequelize');
      // 取过去 5 自然日里"小于 trade_date" 的最近一条 trade_date 全部 row.
      const cutoffStart = shiftIsoDate(trade_date, -7);
      const rows: any[] = await LimitUpStock.findAll({
        where: {
          trade_date: { [Op.gte]: cutoffStart, [Op.lt]: trade_date },
        },
        raw: true,
      });
      if (!rows || rows.length === 0) return [];
      // 找最近一个有数据的日期
      const latestDate = rows
        .map(r => String(r.trade_date))
        .sort()
        .reverse()[0];
      return rows.filter(r => String(r.trade_date) === latestDate).map(toLimitUpRow);
    } catch (e: any) {
      logger.warn(`[LimitUpBoardDetector] loadPrevDayLimitUpRows failed: ${e?.message || e}`);
      return [];
    }
  }

  async listActiveUserIds(): Promise<number[]> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { PaperTradingPortfolio } = require('../models/PaperTradingPortfolio');
      const rows: any[] = await PaperTradingPortfolio.findAll({
        attributes: ['user_id'],
        where: { is_active: true },
        group: ['user_id'],
        raw: true,
      });
      return (rows || [])
        .map((r: any) => Number(r?.user_id))
        .filter((n: number) => Number.isFinite(n) && n > 0);
    } catch (e: any) {
      logger.warn(`[LimitUpBoardDetector] listActiveUserIds failed: ${e?.message || e}`);
      return [];
    }
  }

  async loadRecentDedupKeys(sinceHours: number): Promise<Set<string>> {
    const out = new Set<string>();
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { RiskAlert } = require('../models/RiskAlert');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Op } = require('sequelize');
      const cutoff = new Date(Date.now() - sinceHours * 60 * 60 * 1000);
      const rows: any[] = await RiskAlert.findAll({
        attributes: ['message'],
        where: {
          rule_id: { [Op.like]: 'limit_up_%' },
          created_at: { [Op.gte]: cutoff },
        },
        raw: true,
      });
      const re = /\[dedup_key:([^\]]+)\]/;
      for (const r of rows || []) {
        const m = re.exec(String(r.message || ''));
        if (m && m[1]) out.add(m[1]);
      }
    } catch (e: any) {
      logger.warn(`[LimitUpBoardDetector] loadRecentDedupKeys failed: ${e?.message || e}`);
    }
    return out;
  }

  async writeRiskAlerts(input: {
    user_ids: number[];
    symbol: string;
    name: string;
    level: 'MEDIUM';
    rule_id: string;
    message: string;
  }): Promise<{ created_ids: number[]; failed: number }> {
    const created_ids: number[] = [];
    let failed = 0;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { RiskAlert } = require('../models/RiskAlert');
      for (const uid of input.user_ids) {
        try {
          const row = await RiskAlert.create({
            user_id: uid,
            symbol: input.symbol,
            name: input.name,
            level: input.level,
            message: input.message,
            rule_id: input.rule_id,
          });
          if (row?.id) created_ids.push(Number(row.id));
        } catch (e: any) {
          failed += 1;
          logger.warn(
            `[LimitUpBoardDetector] write RiskAlert user=${uid} symbol=${input.symbol} failed: ${e?.message || e}`
          );
        }
      }
    } catch (e: any) {
      logger.warn(`[LimitUpBoardDetector] writeRiskAlerts top throw: ${e?.message || e}`);
    }
    return { created_ids, failed };
  }

  async writeLimitUpSignal(input: {
    stock_code: string;
    prefixed_symbol: string;
    name: string;
    signal_date: string;
    pattern: LimitUpPattern;
    pattern_label: string;
    reason: string;
    score: number;
    continuous_days: number;
    industry: string | null;
  }): Promise<{ signal_id: number | null; created: boolean }> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { AIInvestmentSignal, AISignalDecision } = require('../models/AIInvestmentSignal');
      const source_type = 'limit_up_board';
      const source_id = `limit_up_${input.pattern}_${input.stock_code}_${input.signal_date}`;
      const score = Math.max(0, Math.min(100, Math.round(Number(input.score) || 70)));
      const payload = {
        source_type,
        source_id,
        symbol: input.prefixed_symbol,
        name: input.name,
        signal_date: input.signal_date,
        decision: 'BUY',
        normalized_decision: AISignalDecision.BUY,
        confidence_score: score,
        risk_level: 'medium',
        rationale: input.reason,
        detail: JSON.stringify({
          source: 'limit_up_board_detector',
          pattern: input.pattern,
          pattern_label: input.pattern_label,
          continuous_days: input.continuous_days,
          industry: input.industry,
          reason: input.reason,
        }),
        metadata: {
          // PR-O2 — 涨停板战法 pattern. 前端 enrichSignal 透传 metadata.* 给 UI badge.
          source: 'limit_up_board_detector',
          pattern: input.pattern,
          pattern_label: input.pattern_label,
          continuous_days: input.continuous_days,
          industry: input.industry,
          // timing_tag='overnight' — 盘后 15:30 跑 → 次日开盘买入语义 (与 PR-H 既有约定一致)
          timing_tag: 'overnight',
          recommend_reason: input.reason,
        },
      };
      const [record, isCreated] = await AIInvestmentSignal.findOrCreate({
        where: { source_type, source_id },
        defaults: payload,
      });
      if (!isCreated) {
        // 已存在 → 不覆盖 metadata; 仅在新 score 更高时升级
        try {
          if ((record.confidence_score ?? 0) < score) {
            await record.update({ confidence_score: score, rationale: input.reason });
          }
        } catch (e: any) {
          logger.warn(
            `[LimitUpBoardDetector] writeLimitUpSignal update failed: ${e?.message || e}`
          );
        }
      }
      return { signal_id: record?.id ?? null, created: isCreated };
    } catch (e: any) {
      logger.warn(`[LimitUpBoardDetector] writeLimitUpSignal failed: ${e?.message || e}`);
      return { signal_id: null, created: false };
    }
  }
}

export const DEFAULT_LIMIT_UP_BOARD_DATA_SOURCE: LimitUpBoardDataSource =
  new DefaultLimitUpBoardDataSource();

// ---------- production-side helpers ----------

function numberOrNull(v: any): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function bareFromAny(s: string): string {
  const t = String(s || '').trim();
  if (/^\d{6}$/.test(t)) return t;
  const m = t.match(/(?:sh|sz|bj)\.?(\d{6})/i);
  return m ? m[1] : '';
}

function toLimitUpRow(r: any): LimitUpRow {
  return {
    trade_date: String(r.trade_date),
    stock_code: String(r.stock_code),
    stock_name: r.stock_name ? String(r.stock_name) : null,
    limit_up_time: r.limit_up_time ? String(r.limit_up_time) : null,
    limit_up_amount: numberOrNull(r.limit_up_amount),
    limit_up_open_times: numberOrNull(r.limit_up_open_times),
    continuous_days: Number(r.continuous_days || 1),
    industry: r.industry ? String(r.industry) : null,
    is_one_word_board: r.is_one_word_board === true,
  };
}

// ===========================================================================
//  Service
// ===========================================================================

export interface LimitUpBoardDetectorDeps {
  dataSource?: LimitUpBoardDataSource;
}

export interface LimitUpBoardRunOptions {
  /** ISO 日期 — 默认今天 Asia/Shanghai. */
  trade_date?: string;
  /** 测试 — 不写 RiskAlert + 不写 Signal. */
  dry_run?: boolean;
  /** 测试 — 强制跑 (跳过 isAShareTradeDay 守卫). */
  force?: boolean;
  /** 覆盖 now (单测). */
  now?: Date;
}

export interface LimitUpBoardRunResult {
  ok: boolean;
  dry_run: boolean;
  trade_date: string;
  scanned: number;
  /** 总命中数 (跨股 + 跨 pattern). */
  total_hits: number;
  /** 真写 RiskAlert / Signal 的命中数 (dedup 后). */
  pushed: number;
  /** dedup 跳过的命中数. */
  deduped: number;
  by_pattern: Record<string, number>;
  errors: Array<{ where: string; reason: string }>;
  skipped_reason: string | null;
}

const DEDUP_LOOKBACK_HOURS = 24;

export class LimitUpBoardDetectorService {
  private readonly ds: LimitUpBoardDataSource;

  constructor(deps: LimitUpBoardDetectorDeps = {}) {
    this.ds = deps.dataSource ?? DEFAULT_LIMIT_UP_BOARD_DATA_SOURCE;
  }

  /** 主入口. 整次永不 throw — 失败计入 result.errors. */
  async runOnce(options: LimitUpBoardRunOptions = {}): Promise<LimitUpBoardRunResult> {
    const now = options.now || new Date();
    const dryRun = options.dry_run === true;
    const tradeDate = options.trade_date || todayInShanghai(now);
    const result: LimitUpBoardRunResult = {
      ok: true,
      dry_run: dryRun,
      trade_date: tradeDate,
      scanned: 0,
      total_hits: 0,
      pushed: 0,
      deduped: 0,
      by_pattern: {},
      errors: [],
      skipped_reason: null,
    };

    if (!options.force && !isAShareTradeDay(now)) {
      result.skipped_reason = 'not_trading_day';
      return result;
    }

    // ---- Step 1: load today limit_up_stocks ----
    let rows: LimitUpRow[] = [];
    try {
      rows = await this.ds.loadLimitUpRows(tradeDate);
    } catch (e: any) {
      result.errors.push({ where: 'load_limit_up_rows', reason: e?.message || String(e) });
      rows = [];
    }
    result.scanned = rows.length;
    if (rows.length === 0) {
      result.skipped_reason = 'empty_limit_up_pool';
      return result;
    }

    // ---- Step 2: aggregate industry / market context ----
    const industryLimitUpCount = buildIndustryLimitUpCount(rows);
    const industryMaxHeight = buildIndustryMaxHeight(rows);
    const industryEarlyLeader = buildIndustryEarlyLeaderMap(rows);
    const marketRankedHeights = buildMarketRankedHeights(rows);

    // ---- Step 3: prev day context for 反包 / 接力 ----
    let prevDayRows: LimitUpRow[] = [];
    try {
      prevDayRows = await this.ds.loadPrevDayLimitUpRows(tradeDate);
    } catch (e: any) {
      result.errors.push({ where: 'load_prev_day_limit_up_rows', reason: e?.message || String(e) });
    }
    const prevDayRowByCode = new Map<string, LimitUpRow>();
    for (const r of prevDayRows) prevDayRowByCode.set(r.stock_code, r);
    const prevDayIndustryMaxHeight = buildIndustryMaxHeight(prevDayRows);

    // ---- Step 4: bar context (today + yesterday daily_bar) ----
    const stockCodes = rows.map(r => r.stock_code).filter(Boolean);
    let bars: { today: Map<string, DailyBarLite>; yesterday: Map<string, DailyBarLite> } = {
      today: new Map(),
      yesterday: new Map(),
    };
    try {
      bars = await this.ds.loadDailyBars(stockCodes, tradeDate);
    } catch (e: any) {
      result.errors.push({ where: 'load_daily_bars', reason: e?.message || String(e) });
    }

    // ---- Step 5: load active users + recent dedup keys ----
    let activeUsers: number[] = [];
    try {
      activeUsers = await this.ds.listActiveUserIds();
    } catch (e: any) {
      result.errors.push({ where: 'list_active_users', reason: e?.message || String(e) });
    }
    let recentDedupKeys: Set<string>;
    try {
      recentDedupKeys = await this.ds.loadRecentDedupKeys(DEDUP_LOOKBACK_HOURS);
    } catch (e: any) {
      result.errors.push({ where: 'load_dedup', reason: e?.message || String(e) });
      recentDedupKeys = new Set();
    }

    // ---- Step 6: per-stock classify + dedup + write ----
    const seenInThisRun = new Set<string>();
    for (const row of rows) {
      try {
        const ctx: ClassifyContext = {
          todayBar: bars.today.get(row.stock_code) || null,
          yesterdayBar: bars.yesterday.get(row.stock_code) || null,
          prevDayLimitUpRow: prevDayRowByCode.get(row.stock_code) || null,
          industryLimitUpCount: row.industry ? (industryLimitUpCount.get(row.industry) || 0) : 0,
          industryMaxContinuousDays: row.industry ? (industryMaxHeight.get(row.industry) || 0) : 0,
          prevDayIndustryMaxHeight: row.industry ? (prevDayIndustryMaxHeight.get(row.industry) || 0) : 0,
          industryHasEarlyLeader: row.industry ? !!industryEarlyLeader.get(row.industry) : false,
          marketRankedHeights,
        };
        const patterns = classifyAll(row, ctx);
        result.total_hits += patterns.length;
        for (const pattern of patterns) {
          result.by_pattern[pattern] = (result.by_pattern[pattern] || 0) + 1;
          const dedupKey = buildLimitUpDedupKey(row.stock_code, pattern, tradeDate);
          if (seenInThisRun.has(dedupKey)) {
            result.deduped += 1;
            continue;
          }
          seenInThisRun.add(dedupKey);
          if (recentDedupKeys.has(dedupKey)) {
            result.deduped += 1;
            continue;
          }
          if (dryRun) {
            result.pushed += 1;
            continue;
          }
          await this.writeHit(row, pattern, dedupKey, tradeDate, activeUsers, result);
          result.pushed += 1;
        }
      } catch (e: any) {
        // per-stock fail-OPEN
        result.errors.push({
          where: `per_stock:${row.stock_code}`,
          reason: e?.message || String(e),
        });
      }
    }

    return result;
  }

  private async writeHit(
    row: LimitUpRow,
    pattern: LimitUpPattern,
    dedupKey: string,
    tradeDate: string,
    activeUsers: number[],
    result: LimitUpBoardRunResult
  ): Promise<void> {
    const label = LIMIT_UP_PATTERN_LABELS[pattern];
    const score = LIMIT_UP_PATTERN_BASE_SCORE[pattern];
    const name = row.stock_name || row.stock_code;
    const reason = buildLimitUpReason(row, pattern);
    const message = appendLimitUpDedupTag(
      `【涨停 - ${label}】${name} (${row.continuous_days}板) - ${reason}`,
      dedupKey
    );
    const prefixedSymbol = normalizeSymbol(row.stock_code);

    // (a) RiskAlert per active user
    if (activeUsers.length > 0) {
      try {
        await this.ds.writeRiskAlerts({
          user_ids: activeUsers,
          symbol: prefixedSymbol,
          name,
          level: 'MEDIUM',
          rule_id: `limit_up_${pattern}`,
          message,
        });
      } catch (e: any) {
        result.errors.push({
          where: `write_risk_alert:${row.stock_code}:${pattern}`,
          reason: e?.message || String(e),
        });
      }
    }

    // (b) AIInvestmentSignal — 让前端 /home 推荐卡显示 pattern badge
    try {
      await this.ds.writeLimitUpSignal({
        stock_code: row.stock_code,
        prefixed_symbol: prefixedSymbol,
        name,
        signal_date: tradeDate,
        pattern,
        pattern_label: label,
        reason,
        score,
        continuous_days: row.continuous_days,
        industry: row.industry,
      });
    } catch (e: any) {
      result.errors.push({
        where: `write_limit_up_signal:${row.stock_code}:${pattern}`,
        reason: e?.message || String(e),
      });
    }
  }
}

export const limitUpBoardDetectorService = new LimitUpBoardDetectorService();

// ===========================================================================
//  Public helpers (dedup key + reason text)
// ===========================================================================

export function buildLimitUpDedupKey(
  stock_code: string,
  pattern: LimitUpPattern,
  trade_date: string
): string {
  return `${stock_code}:limit_up:${pattern}:${trade_date}`;
}

export function appendLimitUpDedupTag(message: string, dedup_key: string): string {
  return `${message}\n\n[dedup_key:${dedup_key}]`;
}

export function buildLimitUpReason(row: LimitUpRow, pattern: LimitUpPattern): string {
  const parts: string[] = [];
  parts.push(`${row.continuous_days}板`);
  if (row.limit_up_time) parts.push(`首封 ${row.limit_up_time}`);
  if (row.limit_up_open_times && row.limit_up_open_times > 0) {
    parts.push(`炸板 ${row.limit_up_open_times} 次`);
  }
  if (row.is_one_word_board) parts.push('一字');
  if (row.industry) parts.push(`板块 ${row.industry}`);
  const amount = Number(row.limit_up_amount);
  if (Number.isFinite(amount) && amount > 0) {
    parts.push(`封单 ${(amount / 1e8).toFixed(2)} 亿`);
  }
  return `${LIMIT_UP_PATTERN_LABELS[pattern]} - ${parts.join(' / ')}`;
}
