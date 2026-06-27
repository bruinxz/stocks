/**
 * US-055 [FE-016] PortfolioWorkspace 日归因卡 — 纯函数 helper.
 *
 * 把"最近一个交易日的资金/交易归因"渲染逻辑抽到独立 module 让它真可
 * 单测 — 与 [[前端 pure helper 模板]] (US-057 industryConcentrationKpi /
 * US-051 shadowRun / US-052 overfitMetrics) 同款思路.
 *
 * 设计取舍 (US-055 [FE-016] 文档输出消费):
 *   - **数据源复用 PortfolioWorkspace 已加载的 snapshots + trades**:
 *     不再单独打 attribution API — ATTR-007 backend 尚未提供 daily endpoint
 *     (依赖标记 "ATTR-007", 但 backend 仅有跨期 getAttribution), 用本地
 *     snapshot 差分 + 当日 trade aggregate 已经足够回答 "今天赚了多少
 *     / 谁贡献最多 / 谁拖累最多" 三个问题. 等 ATTR-007 backend 落地后,
 *     可以再加 followup helper 复用同款 view model 形态.
 *   - **most recent snapshot 是 anchor date**: 不写死 today, 因为周末 /
 *     节假日 snapshot 不会写; 取 snapshots 最后一条 date 作 anchor, 与
 *     EquityCurveTab 的 "最近交易日" 语义一致.
 *   - **日 P&L = anchor.total_value - prev.total_value**: 资金曲线已经
 *     扣净外部入金 (snapshot 是结算后净值), 这里直接差分即可.
 *   - **realized vs unrealized 分解**: 当日 SELL trades 的 realized_pnl
 *     之和 = realized; 日 P&L - realized = unrealized 变动 (含市值波动
 *     + 当日 BUY 部分的浮盈/亏). 与 backend PaperTradingAttributionService
 *     的 total_pnl = realized + unrealized 同款拆解, 让 UI 与 backend
 *     dashboard 三套口径一致.
 *   - **top contributor / detractor 仅看 SELL realized_pnl**: 因 BUY
 *     当日不结算 realized, 把 BUY 列进 top 列表会让用户误读 "买就是赚".
 *     未来若想加 mark-to-market open position 贡献度, 走 backend
 *     ATTR-007 真值, 不要在前端瞎算 (会与持仓表的 unrealized_pnl 漂移).
 *   - **空集 → hidden=true 不渲染**: snapshots < 2 或者 anchor 日没
 *     trade → card 仍渲染 (显示日 P&L), trade 区块空态显示 "今日无成交"
 *     避免空 panel 占位.
 *
 * 纯函数, 不依赖 React / antd / fetch, 单测在
 * backend/tests/services/daily-attribution-helpers.test.ts
 * (跨 monorepo import, 与 US-049/US-054/US-057 同款模式).
 */

import type { SnapshotRow, TradeRow } from '../../services/portfolioWorkspaceService';

// ---------- 常量与颜色 ----------

/** 上涨色 — antd `3f8600` 主绿, 与持仓盈亏同色 */
export const DAILY_PNL_POSITIVE_COLOR = '#16a34a';
/** 下跌色 — antd `cf1322` 主红, 与持仓盈亏同色 */
export const DAILY_PNL_NEGATIVE_COLOR = '#dc2626';
/** 中性灰 — flat 0 时 */
export const DAILY_PNL_NEUTRAL_COLOR = '#1f1f1f';

/** top contributor / detractor 列表显示条数 */
export const DAILY_TOP_TRADE_LIMIT = 3;

// ---------- View model ----------

/** 单笔贡献度行 (SELL realized_pnl) */
export interface DailyAttributionTradeRow {
  id: number;
  symbol: string;
  name: string;
  /** 与 trade.realized_pnl 同符号 (正=盈, 负=亏) */
  realized_pnl: number;
  /** 成交金额 (= execute_price * quantity), 用于排序 tie-break / tooltip */
  amount: number;
}

export interface DailyAttributionViewModel {
  /** true = 不渲染整个 card (snapshots 不足 2 条无法算日变化) */
  hidden: boolean;
  /** anchor 日 (最近 snapshot 的 date), e.g. "2026-06-19"; hidden=true 时为 '' */
  anchorDate: string;
  /** 前一天的 snapshot date, hidden=true 时为 '' */
  prevDate: string;
  /** 日 P&L = anchor.total_value - prev.total_value (¥) */
  dailyPnl: number;
  /** 日收益率 = dailyPnl / prev.total_value * 100 (%); prev.total_value=0 时为 0 */
  dailyReturnPct: number;
  /** 当日 SELL trades realized_pnl 之和 (¥) */
  realizedPnl: number;
  /** 日 P&L - realized = 浮动变化部分 (含持仓 mark-to-market + 当日 BUY 的浮盈/亏) */
  unrealizedChange: number;
  /** anchor 日成交笔数 (BUY + SELL) */
  tradeCount: number;
  /** 当日 BUY 笔数 */
  buyCount: number;
  /** 当日 SELL 笔数 */
  sellCount: number;
  /** Top N 正贡献 (按 realized_pnl 降序, 仅 SELL realized_pnl > 0) */
  topContributors: DailyAttributionTradeRow[];
  /** Top N 负贡献 (按 realized_pnl 升序, 仅 SELL realized_pnl < 0) */
  topDetractors: DailyAttributionTradeRow[];
  /** dailyPnl 显示色 (绿/红/灰) */
  pnlColor: string;
}

// ---------- 工具函数 ----------

/** 安全转 number, 非数兜底 fallback */
function safeNumber(value: unknown, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

/** trade.created_at → 'YYYY-MM-DD'; 非法返 '' */
export function extractTradeDate(createdAt: string | null | undefined): string {
  if (!createdAt) return '';
  const str = String(createdAt);
  // ISO 字符串 / 'YYYY-MM-DD HH:mm:ss' / 'YYYY-MM-DD' 都直接取前 10 位
  if (str.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(str)) {
    return str.slice(0, 10);
  }
  // Date 对象 .toISOString() / .toString() 兜底
  const d = new Date(str);
  if (!Number.isNaN(d.getTime())) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  }
  return '';
}

/** dailyPnl → 颜色 (正绿, 负红, 0 中性) */
export function pickDailyPnlColor(dailyPnl: number): string {
  if (!Number.isFinite(dailyPnl) || dailyPnl === 0) return DAILY_PNL_NEUTRAL_COLOR;
  return dailyPnl > 0 ? DAILY_PNL_POSITIVE_COLOR : DAILY_PNL_NEGATIVE_COLOR;
}

/**
 * 把 snapshots 排序后取 anchor (最后一条) + prev (倒数第二条).
 *
 * 排序: 按 date 字典序升序 (snapshot.date 是 'YYYY-MM-DD', 字典序==时间序).
 *
 * snapshots.length < 2 → null (无法算日变化).
 */
export function pickAnchorSnapshots(
  snapshots: SnapshotRow[] | null | undefined
): { anchor: SnapshotRow; prev: SnapshotRow } | null {
  if (!Array.isArray(snapshots) || snapshots.length < 2) return null;
  const sorted = [...snapshots].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const anchor = sorted[sorted.length - 1];
  const prev = sorted[sorted.length - 2];
  if (!anchor || !prev) return null;
  return { anchor, prev };
}

/**
 * 过滤出 anchor 日的 trades (按 created_at YYYY-MM-DD 匹配).
 *
 * trades 为空 / 非数组 → [].
 */
export function filterTradesOnDate(
  trades: TradeRow[] | null | undefined,
  anchorDate: string
): TradeRow[] {
  if (!Array.isArray(trades) || !anchorDate) return [];
  return trades.filter(t => extractTradeDate(t?.created_at) === anchorDate);
}

/**
 * 把日内 SELL trades 按 realized_pnl 排序, 切出 top contributors / detractors.
 *
 * - contributors: realized_pnl > 0, 降序 (赚最多在前)
 * - detractors: realized_pnl < 0, 升序 (亏最多在前)
 * - 仅 SELL 参与 (BUY realized_pnl 应为 null/0, 但额外 guard)
 * - realized_pnl == 0 / null / 非数 → 全跳过 (不算贡献)
 * - 每边 limit=DAILY_TOP_TRADE_LIMIT
 */
export function buildTopTrades(trades: TradeRow[]): {
  contributors: DailyAttributionTradeRow[];
  detractors: DailyAttributionTradeRow[];
} {
  const sellOnly = trades.filter(t => t?.direction === 'SELL');
  const rows: DailyAttributionTradeRow[] = sellOnly
    .map(t => {
      const pnlRaw = t?.realized_pnl;
      const pnl = pnlRaw === null || pnlRaw === undefined ? NaN : Number(pnlRaw);
      const amount =
        safeNumber(t?.amount) || safeNumber(t?.execute_price) * safeNumber(t?.quantity);
      return {
        id: Number(t?.id),
        symbol: String(t?.symbol || ''),
        name: String(t?.name || t?.symbol || ''),
        realized_pnl: pnl,
        amount,
      };
    })
    .filter(r => Number.isFinite(r.realized_pnl) && r.realized_pnl !== 0);

  const contributors = rows
    .filter(r => r.realized_pnl > 0)
    .sort((a, b) => b.realized_pnl - a.realized_pnl)
    .slice(0, DAILY_TOP_TRADE_LIMIT);

  const detractors = rows
    .filter(r => r.realized_pnl < 0)
    .sort((a, b) => a.realized_pnl - b.realized_pnl)
    .slice(0, DAILY_TOP_TRADE_LIMIT);

  return { contributors, detractors };
}

/**
 * 主入口: snapshots + trades → 完整 view model.
 *
 * 任何缺数据 / 非法输入返 `hidden=true` 兜底 view model — 永远不抛, 让
 * component 零 try/catch.
 */
export function buildDailyAttributionViewModel(
  snapshots: SnapshotRow[] | null | undefined,
  trades: TradeRow[] | null | undefined
): DailyAttributionViewModel {
  const anchors = pickAnchorSnapshots(snapshots);
  if (!anchors) {
    return {
      hidden: true,
      anchorDate: '',
      prevDate: '',
      dailyPnl: 0,
      dailyReturnPct: 0,
      realizedPnl: 0,
      unrealizedChange: 0,
      tradeCount: 0,
      buyCount: 0,
      sellCount: 0,
      topContributors: [],
      topDetractors: [],
      pnlColor: DAILY_PNL_NEUTRAL_COLOR,
    };
  }
  const { anchor, prev } = anchors;
  const anchorTotal = safeNumber(anchor.total_value);
  const prevTotal = safeNumber(prev.total_value);
  const dailyPnl = anchorTotal - prevTotal;
  const dailyReturnPct = prevTotal > 0 ? (dailyPnl / prevTotal) * 100 : 0;

  const anchorDate = String(anchor.date);
  const todayTrades = filterTradesOnDate(trades, anchorDate);
  const sellTrades = todayTrades.filter(t => t.direction === 'SELL');
  const buyTrades = todayTrades.filter(t => t.direction === 'BUY');

  const realizedPnl = sellTrades.reduce((sum, t) => {
    const pnl =
      t.realized_pnl === null || t.realized_pnl === undefined ? 0 : Number(t.realized_pnl);
    return sum + (Number.isFinite(pnl) ? pnl : 0);
  }, 0);

  const unrealizedChange = dailyPnl - realizedPnl;

  const { contributors, detractors } = buildTopTrades(todayTrades);

  return {
    hidden: false,
    anchorDate,
    prevDate: String(prev.date),
    dailyPnl,
    dailyReturnPct,
    realizedPnl,
    unrealizedChange,
    tradeCount: todayTrades.length,
    buyCount: buyTrades.length,
    sellCount: sellTrades.length,
    topContributors: contributors,
    topDetractors: detractors,
    pnlColor: pickDailyPnlColor(dailyPnl),
  };
}
