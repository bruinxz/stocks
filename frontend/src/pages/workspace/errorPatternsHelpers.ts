/**
 * US-059 [FE-020] PortfolioWorkspace AI 日记 + 错误模式 tab — 纯函数 helper.
 *
 * 把"已成交亏损单的可观察 pattern" 渲染逻辑抽到独立 module 让它真可单测 —
 * 与 [[前端 pure helper 模板]] (US-055 dailyAttribution / US-057
 * industryConcentrationKpi / US-051 shadowRun / US-052 overfitMetrics)
 * 同款思路.
 *
 * **设计取舍** (US-059 [FE-020] 文档输出消费):
 *   - **数据源只用 trades + journalList**: 与 US-055 一样不打新 API.
 *     trades 已经从 PortfolioWorkspace 顶层加载, journalList 同理.
 *     未来若加 backend trade_root_cause endpoint (TradeRootCauseClassifier
 *     已存在), 走 followup helper 复用 view model 形态.
 *   - **错误模式 = SELL realized_pnl < 0 的可聚合特征**: 不依赖 exit_reason
 *     (FE TradeRow 没暴露), 不依赖 holding_days (没暴露). 只用现有字段
 *     symbol/realized_pnl/created_at/execute_price/quantity 推 4 类模式:
 *     (1) 同 symbol 连亏 ≥ 2 次 (反复踩雷)
 *     (2) 大额单笔亏损 (绝对亏损金额 top-3, 且占成交金额 > 5%)
 *     (3) 单日多笔亏损 (同一日 ≥ 2 笔 loss — "情绪化连续止损")
 *     (4) 持仓低于平均收益 - "慢性失血": 累计亏损金额 top symbol
 *   - **AI 日记摘要**: journalList 转 "AI tag 分布" + "近 7 / 30 天日记天数".
 *     AI 自动生成的日记 mood='AI', 用户手写 mood != 'AI'. 让用户一眼看见
 *     "AI 帮我复盘了几天 / 我自己写了几天".
 *   - **空集 → hidden=true 不渲染**: trades=[] 或全部盈利 → patterns
 *     section 隐藏 (不要给用户"系统没问题"假象); journalList=[] → AI 摘要
 *     hidden=true.
 *   - **配色复用 US-044 SellSuggestionCard 业务语义**: critical=红 (反复踩雷),
 *     high=橙 (大额亏损), medium=黄 (单日连亏), low=灰 (慢性失血). 与
 *     已有 priority 色谱一致, 用户跨卡片认色零成本.
 *
 * 纯函数, 不依赖 React / antd / fetch, 单测在
 * `backend/tests/services/error-patterns-helpers.test.ts`
 * (跨 monorepo import, 与 US-049/US-054/US-055/US-057 同款模式).
 */

import type { TradeRow, JournalSummary } from '../../services/portfolioWorkspaceService';
import { extractTradeDate } from './dailyAttributionHelpers';

// ---------- 常量与配色 ----------

/** 大额亏损绝对金额阈值 (¥); 低于此即便占比高也不算 "大额" — 避免 1 块钱亏损上榜 */
export const LARGE_LOSS_ABS_MIN = 200;
/** 大额亏损占成交金额阈值 (0-1); ≥ 此值 + 绝对额 ≥ LARGE_LOSS_ABS_MIN → 入榜 */
export const LARGE_LOSS_RATIO_MIN = 0.05;
/** 同 symbol 连亏阈值 — 累计亏损次数 (SELL realized_pnl < 0 计数) */
export const REPEAT_LOSS_MIN_COUNT = 2;
/** 同日连亏阈值 — 单一交易日内 SELL realized_pnl < 0 次数 */
export const SAME_DAY_LOSS_MIN_COUNT = 2;
/** 慢性失血 — 单 symbol 累计亏损金额阈值 (¥); 低于此不上榜 */
export const CHRONIC_LOSS_MIN_ABS = 500;
/** 每类 pattern 显示条数 */
export const PATTERN_TOP_LIMIT = 5;

/** AI 日记 mood 标识 — 与 EnhancedTradingJournalService.DEFAULT_MOOD_GENERATED 同源 */
export const AI_JOURNAL_MOOD = 'AI';

/** AI 摘要近期窗口 */
export const RECENT_WINDOW_7D = 7;
export const RECENT_WINDOW_30D = 30;

/** Priority 色 — 与 [[前端 pure helper 模板]] / SellSuggestionCard 业务语义一致 */
export const ERROR_PATTERN_PRIORITY_COLOR: Record<ErrorPatternPriority, string> = {
  critical: '#dc2626',
  high: '#fa8c16',
  medium: '#fadb14',
  low: '#8c8c8c',
};

/** Priority 中文标签 */
export const ERROR_PATTERN_PRIORITY_LABEL: Record<ErrorPatternPriority, string> = {
  critical: '严重',
  high: '高',
  medium: '中',
  low: '低',
};

// ---------- 类型 ----------

export type ErrorPatternPriority = 'critical' | 'high' | 'medium' | 'low';

export type ErrorPatternKind =
  | 'repeat_loss' // 同 symbol 连亏 ≥ 2 次
  | 'large_loss' // 单笔大额亏损
  | 'same_day_streak' // 单日多笔亏损
  | 'chronic_loss'; // 慢性失血 (累计亏损 top)

export interface ErrorPatternRow {
  /** 唯一 key, 用于 React render — 'kind-anchor', anchor 可能是 symbol/date/tradeId */
  key: string;
  kind: ErrorPatternKind;
  priority: ErrorPatternPriority;
  /** 主标题 (e.g. "招商银行 (600036) 连亏 3 次") */
  title: string;
  /** 详细描述 — 数字 + 上下文 (e.g. "累计亏损 ¥4,200，最大单笔 ¥1,800") */
  detail: string;
  /** 关联 trade id 列表 (供 UI tooltip / 点击下钻) */
  tradeIds: number[];
  /** anchor 标识 — symbol / date / trade.id */
  anchor: string;
  /** 用于排序的"严重度数值" — 累计亏损绝对金额 (¥), 越大越靠前 */
  sortKey: number;
}

export interface JournalAiSummary {
  /** true = journalList 空 → 整个摘要 section 隐藏 */
  hidden: boolean;
  /** 总日记数 */
  totalCount: number;
  /** AI 自动生成数 (mood == 'AI') */
  aiCount: number;
  /** 用户手写数 (mood != 'AI' 且非空) */
  handCount: number;
  /** mood/tag 未填数 */
  unlabeledCount: number;
  /** 近 7 天日记数 (含今日) */
  last7dCount: number;
  /** 近 30 天日记数 (含今日) */
  last30dCount: number;
  /** AI 自动覆盖率 = aiCount / totalCount (0-1); totalCount=0 时为 0 */
  aiCoverageRatio: number;
  /** 标签出现频次 top-10 [{tag, count}] (大写归一, 空标签跳过) */
  topTags: Array<{ tag: string; count: number }>;
}

export interface ErrorPatternsViewModel {
  /** true = trades=[] 或全盈利 + journalList=[] → 整个 tab 显示 Empty 占位 */
  hidden: boolean;
  /** 错误模式行 (按 priority + sortKey 排序) */
  patterns: ErrorPatternRow[];
  /** AI 日记摘要 */
  journalSummary: JournalAiSummary;
  /** 主 KPI: 已结仓总亏损金额 (¥, 正数) */
  totalRealizedLoss: number;
  /** 主 KPI: 已结仓亏损笔数 */
  lossTradeCount: number;
  /** 主 KPI: SELL 总笔数 */
  sellTradeCount: number;
  /** 主 KPI: 亏损率 = lossTradeCount / sellTradeCount (0-1); 分母 0 时为 0 */
  lossRate: number;
}

// ---------- 工具函数 ----------

function safeNumber(value: unknown, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

/** 取 SELL realized_pnl, null / 非数返 NaN (caller filter) */
function sellPnl(trade: TradeRow): number {
  if (trade.direction !== 'SELL') return NaN;
  const raw = trade.realized_pnl;
  if (raw === null || raw === undefined) return NaN;
  const num = Number(raw);
  return Number.isFinite(num) ? num : NaN;
}

/** 把 trade.amount / execute_price*quantity 安全取数 */
function tradeAmount(trade: TradeRow): number {
  const amt = safeNumber(trade.amount);
  if (amt > 0) return amt;
  return safeNumber(trade.execute_price) * safeNumber(trade.quantity);
}

/** Priority 排序权重 — critical=4, high=3, medium=2, low=1 */
function priorityRank(p: ErrorPatternPriority): number {
  return p === 'critical' ? 4 : p === 'high' ? 3 : p === 'medium' ? 2 : 1;
}

// ---------- 决策表: 计算单条 pattern 的 priority ----------

/**
 * **repeat_loss** priority 决策表:
 *   - count ≥ 4 → critical (反复踩同一只)
 *   - count = 3 → high
 *   - count = 2 → medium
 */
export function computeRepeatLossPriority(count: number): ErrorPatternPriority {
  if (count >= 4) return 'critical';
  if (count >= 3) return 'high';
  return 'medium';
}

/**
 * **large_loss** priority 决策表:
 *   - 亏损占成交金额 > 15% → critical
 *   - 亏损占成交金额 > 10% → high
 *   - 其余 → medium
 */
export function computeLargeLossPriority(lossRatio: number): ErrorPatternPriority {
  if (lossRatio > 0.15) return 'critical';
  if (lossRatio > 0.1) return 'high';
  return 'medium';
}

/**
 * **same_day_streak** priority 决策表:
 *   - 单日 ≥ 4 笔亏损 → critical (情绪化 panic-sell)
 *   - 单日 = 3 笔 → high
 *   - 单日 = 2 笔 → medium
 */
export function computeSameDayStreakPriority(count: number): ErrorPatternPriority {
  if (count >= 4) return 'critical';
  if (count >= 3) return 'high';
  return 'medium';
}

/**
 * **chronic_loss** 始终 low — 累计亏损是"慢性问题"提示, 不抢 critical/high 注意力.
 * 与 [[前端 pure helper 模板]] 的"严重度类字段取最严重" 配合 — 慢性失血上限就是 low.
 */
export function computeChronicLossPriority(): ErrorPatternPriority {
  return 'low';
}

// ---------- builder: 各类 pattern ----------

interface SymbolLossGroup {
  symbol: string;
  name: string;
  losses: TradeRow[];
  totalLoss: number; // 正数, 累计亏损绝对值
  maxLoss: number; // 正数, 单笔最大亏损绝对值
}

/** 按 symbol 聚合所有亏损 SELL */
export function groupLossesBySymbol(trades: TradeRow[]): Map<string, SymbolLossGroup> {
  const map = new Map<string, SymbolLossGroup>();
  for (const t of trades) {
    const pnl = sellPnl(t);
    if (!Number.isFinite(pnl) || pnl >= 0) continue;
    const sym = String(t.symbol || '');
    if (!sym) continue;
    const absLoss = Math.abs(pnl);
    const existing = map.get(sym);
    if (existing) {
      existing.losses.push(t);
      existing.totalLoss += absLoss;
      if (absLoss > existing.maxLoss) existing.maxLoss = absLoss;
      if (!existing.name && t.name) existing.name = String(t.name);
    } else {
      map.set(sym, {
        symbol: sym,
        name: String(t.name || t.symbol || ''),
        losses: [t],
        totalLoss: absLoss,
        maxLoss: absLoss,
      });
    }
  }
  return map;
}

/** repeat_loss 模式 — 同 symbol 累亏 ≥ REPEAT_LOSS_MIN_COUNT */
export function buildRepeatLossPatterns(groupMap: Map<string, SymbolLossGroup>): ErrorPatternRow[] {
  const rows: ErrorPatternRow[] = [];
  groupMap.forEach(g => {
    if (g.losses.length < REPEAT_LOSS_MIN_COUNT) return;
    const priority = computeRepeatLossPriority(g.losses.length);
    rows.push({
      key: `repeat_loss-${g.symbol}`,
      kind: 'repeat_loss',
      priority,
      title: `${g.name || g.symbol} (${g.symbol}) 连亏 ${g.losses.length} 次`,
      detail: `累计亏损 ¥${formatMoney(g.totalLoss)}，最大单笔 ¥${formatMoney(g.maxLoss)}`,
      tradeIds: g.losses.map(t => Number(t.id)),
      anchor: g.symbol,
      sortKey: g.totalLoss,
    });
  });
  return rows;
}

/** large_loss 模式 — 单笔绝对亏损 ≥ LARGE_LOSS_ABS_MIN 且占成交额 ≥ LARGE_LOSS_RATIO_MIN */
export function buildLargeLossPatterns(trades: TradeRow[]): ErrorPatternRow[] {
  const rows: ErrorPatternRow[] = [];
  for (const t of trades) {
    const pnl = sellPnl(t);
    if (!Number.isFinite(pnl) || pnl >= 0) continue;
    const absLoss = Math.abs(pnl);
    if (absLoss < LARGE_LOSS_ABS_MIN) continue;
    const amt = tradeAmount(t);
    const ratio = amt > 0 ? absLoss / amt : 0;
    if (ratio < LARGE_LOSS_RATIO_MIN) continue;
    const priority = computeLargeLossPriority(ratio);
    const ratioPctStr = (ratio * 100).toFixed(2);
    rows.push({
      key: `large_loss-${t.id}`,
      kind: 'large_loss',
      priority,
      title: `${t.name || t.symbol} 单笔亏损 ¥${formatMoney(absLoss)}`,
      detail: `占成交金额 ${ratioPctStr}%，成交日 ${extractTradeDate(t.created_at) || '未知'}`,
      tradeIds: [Number(t.id)],
      anchor: String(t.id),
      sortKey: absLoss,
    });
  }
  return rows;
}

/** same_day_streak — 同日 SELL 亏损笔数 ≥ SAME_DAY_LOSS_MIN_COUNT */
export function buildSameDayStreakPatterns(trades: TradeRow[]): ErrorPatternRow[] {
  const byDate = new Map<string, TradeRow[]>();
  for (const t of trades) {
    const pnl = sellPnl(t);
    if (!Number.isFinite(pnl) || pnl >= 0) continue;
    const date = extractTradeDate(t.created_at);
    if (!date) continue;
    const arr = byDate.get(date);
    if (arr) arr.push(t);
    else byDate.set(date, [t]);
  }
  const rows: ErrorPatternRow[] = [];
  byDate.forEach((dayTrades, date) => {
    if (dayTrades.length < SAME_DAY_LOSS_MIN_COUNT) return;
    const totalLoss = dayTrades.reduce((s, t) => s + Math.abs(sellPnl(t)), 0);
    const priority = computeSameDayStreakPriority(dayTrades.length);
    rows.push({
      key: `same_day_streak-${date}`,
      kind: 'same_day_streak',
      priority,
      title: `${date} 当日连亏 ${dayTrades.length} 笔`,
      detail: `合计亏损 ¥${formatMoney(totalLoss)}`,
      tradeIds: dayTrades.map(t => Number(t.id)),
      anchor: date,
      sortKey: totalLoss,
    });
  });
  return rows;
}

/**
 * chronic_loss — 单 symbol 累计亏损金额 ≥ CHRONIC_LOSS_MIN_ABS 且 **未** 触发
 * repeat_loss (避免与 repeat_loss 重复占位). 用 groupMap 做集合差.
 */
export function buildChronicLossPatterns(
  groupMap: Map<string, SymbolLossGroup>
): ErrorPatternRow[] {
  const rows: ErrorPatternRow[] = [];
  groupMap.forEach(g => {
    if (g.losses.length >= REPEAT_LOSS_MIN_COUNT) return; // repeat_loss 已覆盖
    if (g.totalLoss < CHRONIC_LOSS_MIN_ABS) return;
    rows.push({
      key: `chronic_loss-${g.symbol}`,
      kind: 'chronic_loss',
      priority: computeChronicLossPriority(),
      title: `${g.name || g.symbol} (${g.symbol}) 单笔亏损偏大`,
      detail: `累计亏损 ¥${formatMoney(g.totalLoss)}`,
      tradeIds: g.losses.map(t => Number(t.id)),
      anchor: g.symbol,
      sortKey: g.totalLoss,
    });
  });
  return rows;
}

/**
 * 排序: priority rank 降序 → sortKey 降序 → key 字母序 (稳定).
 * 与 [[前端 pure helper 模板]] 排序 3 段稳定一致 (US-042 todayPlanHelpers).
 */
export function sortPatterns(rows: ErrorPatternRow[]): ErrorPatternRow[] {
  return [...rows].sort((a, b) => {
    const pa = priorityRank(a.priority);
    const pb = priorityRank(b.priority);
    if (pa !== pb) return pb - pa;
    if (a.sortKey !== b.sortKey) return b.sortKey - a.sortKey;
    return a.key.localeCompare(b.key);
  });
}

// ---------- AI 日记摘要 ----------

/** 把 dayjs / Date / 'YYYY-MM-DD' 都归一到 YYYY-MM-DD; 非法返 '' */
function normalizeDate(value: string | null | undefined): string {
  if (!value) return '';
  const s = String(value);
  if (s.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/**
 * 算 anchorDate 往前 N 天 (含 anchorDate) 的日记天数.
 * anchorDate 非法 → 取 journalList 中最新日期作 anchor.
 * journalList 空 → 0.
 */
export function countJournalsInWindow(
  journalList: JournalSummary[],
  windowDays: number,
  anchorDate: string | null = null
): number {
  if (!Array.isArray(journalList) || journalList.length === 0) return 0;
  let anchor = anchorDate ? normalizeDate(anchorDate) : '';
  if (!anchor) {
    const sortedDates = journalList
      .map(j => normalizeDate(j.date))
      .filter(d => !!d)
      .sort();
    anchor = sortedDates[sortedDates.length - 1] || '';
  }
  if (!anchor) return 0;
  // 字典序: 'YYYY-MM-DD' 减 windowDays-1 天
  const anchorDateObj = new Date(`${anchor}T00:00:00`);
  if (Number.isNaN(anchorDateObj.getTime())) return 0;
  const cutoffObj = new Date(anchorDateObj.getTime());
  cutoffObj.setDate(cutoffObj.getDate() - (windowDays - 1));
  const cutoffStr = `${cutoffObj.getFullYear()}-${String(cutoffObj.getMonth() + 1).padStart(
    2,
    '0'
  )}-${String(cutoffObj.getDate()).padStart(2, '0')}`;
  let count = 0;
  for (const j of journalList) {
    const d = normalizeDate(j.date);
    if (!d) continue;
    if (d >= cutoffStr && d <= anchor) count += 1;
  }
  return count;
}

/** 标签聚合 — 大小写归一 (lowercase), 空标签 / 非数组 tags 跳过 */
export function aggregateJournalTags(
  journalList: JournalSummary[]
): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>();
  for (const j of journalList) {
    if (!Array.isArray(j.tags)) continue;
    for (const raw of j.tags) {
      if (raw === null || raw === undefined) continue;
      const tag = String(raw).trim();
      if (!tag) continue;
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }
  const out: Array<{ tag: string; count: number }> = [];
  counts.forEach((count, tag) => out.push({ tag, count }));
  out.sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count;
    return a.tag.localeCompare(b.tag);
  });
  return out.slice(0, 10);
}

/** AI 日记摘要主入口 */
export function buildJournalAiSummary(
  journalList: JournalSummary[] | null | undefined
): JournalAiSummary {
  if (!Array.isArray(journalList) || journalList.length === 0) {
    return {
      hidden: true,
      totalCount: 0,
      aiCount: 0,
      handCount: 0,
      unlabeledCount: 0,
      last7dCount: 0,
      last30dCount: 0,
      aiCoverageRatio: 0,
      topTags: [],
    };
  }
  let ai = 0;
  let hand = 0;
  let unlabeled = 0;
  for (const j of journalList) {
    const mood = j.mood ? String(j.mood).trim() : '';
    if (mood === AI_JOURNAL_MOOD) ai += 1;
    else if (mood) hand += 1;
    else unlabeled += 1;
  }
  return {
    hidden: false,
    totalCount: journalList.length,
    aiCount: ai,
    handCount: hand,
    unlabeledCount: unlabeled,
    last7dCount: countJournalsInWindow(journalList, RECENT_WINDOW_7D),
    last30dCount: countJournalsInWindow(journalList, RECENT_WINDOW_30D),
    aiCoverageRatio: journalList.length > 0 ? ai / journalList.length : 0,
    topTags: aggregateJournalTags(journalList),
  };
}

// ---------- 主入口 ----------

/**
 * trades + journalList → 完整 view model.
 *
 * 任何缺数据 / 非法输入返 `hidden=true` 兜底 — 永远不抛.
 * 与 [[前端 pure helper 模板]] 第 (1) (5) 件一致 — 主入口接 null/undefined +
 * 单 block error 全部容错返兜底 view model, useMemo 安全.
 */
export function buildErrorPatternsViewModel(
  trades: TradeRow[] | null | undefined,
  journalList: JournalSummary[] | null | undefined
): ErrorPatternsViewModel {
  const safeTradesAll = Array.isArray(trades) ? trades : [];
  const sellTrades = safeTradesAll.filter(t => t?.direction === 'SELL');
  const losses = sellTrades.filter(t => {
    const pnl = sellPnl(t);
    return Number.isFinite(pnl) && pnl < 0;
  });

  const totalRealizedLoss = losses.reduce((s, t) => s + Math.abs(sellPnl(t)), 0);
  const lossTradeCount = losses.length;
  const sellTradeCount = sellTrades.length;
  const lossRate = sellTradeCount > 0 ? lossTradeCount / sellTradeCount : 0;

  const groupMap = groupLossesBySymbol(safeTradesAll);
  const repeatRows = buildRepeatLossPatterns(groupMap);
  const largeRows = buildLargeLossPatterns(safeTradesAll);
  const sameDayRows = buildSameDayStreakPatterns(safeTradesAll);
  const chronicRows = buildChronicLossPatterns(groupMap);

  // 每类各自 sort 后 slice top-N, 再合并 + 再 sort 一次
  const repeatTop = sortPatterns(repeatRows).slice(0, PATTERN_TOP_LIMIT);
  const largeTop = sortPatterns(largeRows).slice(0, PATTERN_TOP_LIMIT);
  const sameDayTop = sortPatterns(sameDayRows).slice(0, PATTERN_TOP_LIMIT);
  const chronicTop = sortPatterns(chronicRows).slice(0, PATTERN_TOP_LIMIT);
  const patterns = sortPatterns([...repeatTop, ...largeTop, ...sameDayTop, ...chronicTop]);

  const journalSummary = buildJournalAiSummary(journalList);

  const hidden =
    patterns.length === 0 && journalSummary.hidden && lossTradeCount === 0 && sellTradeCount === 0;

  return {
    hidden,
    patterns,
    journalSummary,
    totalRealizedLoss,
    lossTradeCount,
    sellTradeCount,
    lossRate,
  };
}

// ---------- 格式化辅助 ----------

/** ¥ 金额格式化 — 千分位, 整数显示, 保留 2 位时去尾 0 */
export function formatMoney(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const abs = Math.abs(value);
  if (abs >= 10000) {
    return abs.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
  }
  return abs.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

/** 百分比格式化 — 0.123 → '12.30%'; 非数返 '—' */
export function formatRatioPct(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

/** Pattern kind → 中文标签 */
export const ERROR_PATTERN_KIND_LABEL: Record<ErrorPatternKind, string> = {
  repeat_loss: '反复踩雷',
  large_loss: '大额亏损',
  same_day_streak: '单日连亏',
  chronic_loss: '慢性失血',
};
