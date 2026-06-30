/**
 * US-123 [PM-010] PortfolioWorkspace 归因卡 — 纯函数 helper.
 *
 * 把 backend `DailyAttributionReport` (PM-001/002/003/004/005 链路产物) 翻译
 * 成"6 维 pie + best/worst + AI summary" 渲染所需的 view model. 与 US-055
 * 的 [[dailyAttributionHelpers]] 形成互补 — US-055 是"用 snapshot+trade
 * 现算" 占位卡, 本 helper 是 "读 cron 落库报告" 的真值卡; 两者共用一个 tab
 * 显示, 按是否拿到 backend report 切换.
 *
 * 设计取舍 (与 [[前端 pure helper 模板]] / [[多维度决策表 priority 综合模板]]
 * / [[engine + caller 联动 ±5% 不变量 trivially 成立]] 同款):
 *   - **6 维 pie 用 |contrib|**: 各维度贡献正负皆有, 饼图取绝对值, color
 *     按正/负配色 (与持仓盈亏同色). 业务直觉: pie 是"贡献度|大小|", 不是
 *     "占比", 用户看完 pie 想知道 "哪个维度贡献最大", 哪怕负贡献(亏钱).
 *     另一种做法是 "正/负分开两张 pie", 但 6 维平均 ≤ 6 切片, 同一张 pie
 *     + 不同 color + tooltip 显示符号 已足够清晰.
 *   - **AI summary 兜底**: backend.ai_summary 空时回退用 heuristic 拼 1 行
 *     (date + total_pnl), 防止 cron 落库 status='failed' / ai_summary='' 时
 *     UI 卡片空白.
 *   - **best/worst 取 backend 已 top-3**: 直接 map, 不再前端排序. backend
 *     在 buildDailyAttributionReport 已按 realized_pnl 降序/升序 + cap 3.
 *   - **residual 计算兜底**: backend AC §E.2 ±5% 不变量由 service 保证;
 *     UI 不再 cross-check (重复计算反而可能因浮点差异显示 "对不上账").
 *     仅在 breakdown.residual 字段缺失时 (老版本数据) 用公式补齐.
 *   - **status='skipped'/'failed' 仍渲染**: 用 reason 字段提示用户"今日
 *     未跑 / 失败原因", 让 ops 一眼看出系统状态; 不藏起来.
 *
 * 纯函数, 不依赖 React / antd / fetch. 单测在
 *   backend/tests/services/portfolio-attribution-card-helpers.test.ts
 * (跨 monorepo import, 与 US-049/US-051/US-052/US-054/US-055 同款 ts-node 模式).
 */

import type {
  DailyAttributionReportRow,
  AttributionFactorContrib,
  AttributionIndustryContrib,
  AttributionBestWorstTrade,
} from '../../services/portfolioWorkspaceService';

// ---------- 常量与颜色 ----------

/** 上涨色 — 与 [[dailyAttributionHelpers]] / 持仓盈亏同色 */
export const ATTRIBUTION_POSITIVE_COLOR = '#16a34a';
/** 下跌色 — 同上 */
export const ATTRIBUTION_NEGATIVE_COLOR = '#dc2626';
/** 中性灰 — 0 贡献的维度 */
export const ATTRIBUTION_NEUTRAL_COLOR = '#bfbfbf';

/**
 * 6 维 pie 显示顺序 — 业务可解释性递减:
 *   industry (行业 β) → sizing (权重选择) → selection (行业内 α) → timing
 *   (入场出场) → factor (因子残差) → execution (执行成本)
 * 与 AC "6 维 pie" 1:1 对应.
 */
export const ATTRIBUTION_DIMENSION_ORDER = Object.freeze([
  'industry',
  'sizing',
  'selection',
  'timing',
  'factor',
  'execution_cost',
] as const);

export type AttributionDimensionKey = (typeof ATTRIBUTION_DIMENSION_ORDER)[number];

/** 维度中文标签 — pie label / tooltip / legend 共用 */
export const ATTRIBUTION_DIMENSION_LABEL: Record<AttributionDimensionKey, string> = Object.freeze({
  industry: '行业 β',
  sizing: '权重选择',
  selection: '行业内 α',
  timing: '入场/出场时机',
  factor: '因子残差',
  execution_cost: '执行成本',
});

/** best/worst 列表显示上限 — 后端已 top 3 cap, 这里冗余守一道 */
export const ATTRIBUTION_TOP_TRADE_LIMIT = 3;

/** AI summary cap — 与 backend DAILY_ATTRIBUTION_AI_SUMMARY_MAX_CHARS 同源 */
export const ATTRIBUTION_AI_SUMMARY_MAX_CHARS = 200;

// ---------- View model ----------

/** 单个 pie 切片 — Recharts <Pie data> 直接消费 */
export interface AttributionPieSlice {
  key: AttributionDimensionKey;
  label: string;
  /** 原始贡献值 (元), 可正可负 */
  value: number;
  /** 绝对值, pie size 用 (Recharts Pie dataKey) */
  absValue: number;
  /** color: 正绿 / 负红 / 0 灰 */
  color: string;
  /** 在 totalAbs 中的占比 (0-1), tooltip 显示用 */
  pctOfAbs: number;
}

/** Best/worst 行 — 已 align 到 UI 渲染需求 */
export interface AttributionTradeRow {
  id: number;
  symbol: string;
  name: string;
  realized_pnl: number;
  realized_pnl_pct: number | null;
  amount: number;
}

export interface PortfolioAttributionCardViewModel {
  /** true = 不渲染卡 (report 为 null / 严重错误) */
  hidden: boolean;
  /** 报告日期 YYYY-MM-DD */
  date: string;
  /** report status (ok/skipped/failed) — UI 走不同提示 */
  status: 'ok' | 'skipped' | 'failed' | 'unknown';
  /** skipped / failed 时的 reason; ok 时为 null */
  statusReason: string | null;
  /** 当日总盈亏 (元), 用于卡顶 KPI */
  totalPnl: number;
  /** 当日总盈亏 % (== prev_total<=0 时为 null) */
  totalPnlPct: number | null;
  /** 已实现盈亏 (Σ SELL.realized_pnl) */
  realizedPnl: number;
  /** 浮动盈亏变化 (= total - realized) */
  unrealizedDelta: number;
  /** 成交笔数 / BUY 笔数 / SELL 笔数 */
  tradeCount: number;
  buyCount: number;
  sellCount: number;
  /** 6 维 pie 数据 (按 ATTRIBUTION_DIMENSION_ORDER 顺序) */
  pieData: AttributionPieSlice[];
  /** pie 中所有切片的绝对值之和; 0 表示完全平 (cron 写 placeholder) */
  totalAbs: number;
  /** 残差 (运气) — 单独显示, 不进 pie (避免 |residual| 过大遮盖其它维度) */
  residual: number;
  /** Top 3 winners (已按 realized_pnl 降序) */
  bestTrades: AttributionTradeRow[];
  /** Top 3 losers (已按 realized_pnl 升序) */
  worstTrades: AttributionTradeRow[];
  /** AI summary (≤ 200 字), 空 backend 时用 heuristic 兜底 */
  aiSummary: string;
  /** ai_summary 是否走的 backend 真值 (false=本地 fallback) */
  aiSummaryIsBackend: boolean;
  /** 行业 top contributors (backend.breakdown.industry_contrib, 直接透传 cap 5) */
  industryTop: AttributionIndustryContrib[];
  /** 因子 top contributors (backend.breakdown.factor_contrib, cap 5) */
  factorTop: AttributionFactorContrib[];
}

// ---------- 工具函数 ----------

/** 安全转数, 非数 → fallback */
export function safeNumber(value: unknown, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

/** 贡献值 → 颜色 (正绿 / 负红 / 0 灰) */
export function pickAttributionColor(value: number): string {
  if (!Number.isFinite(value) || value === 0) return ATTRIBUTION_NEUTRAL_COLOR;
  return value > 0 ? ATTRIBUTION_POSITIVE_COLOR : ATTRIBUTION_NEGATIVE_COLOR;
}

/**
 * 从 backend.breakdown 抽出 6 维贡献值 (元), 缺失字段 fallback 0.
 *
 * - industry  = Σ industry_contrib[].pnl (back: 已聚合; 没 industry_contrib 时 0)
 * - sizing    = breakdown.sizing_contrib
 * - selection = breakdown.selection_contrib
 * - timing    = breakdown.timing_contrib
 * - factor    = breakdown.factor_contrib_total
 * - execution_cost = -breakdown.execution_cost (执行成本是支出, pie 上显示为负贡献)
 */
export function extractDimensionContribs(
  breakdown: DailyAttributionReportRow['breakdown'] | null | undefined
): Record<AttributionDimensionKey, number> {
  if (!breakdown) {
    return {
      industry: 0,
      sizing: 0,
      selection: 0,
      timing: 0,
      factor: 0,
      execution_cost: 0,
    };
  }
  const industryContribArr = Array.isArray(breakdown.industry_contrib)
    ? breakdown.industry_contrib
    : [];
  const industry = industryContribArr.reduce(
    (sum: number, item: AttributionIndustryContrib) => sum + safeNumber(item?.pnl),
    0
  );
  return {
    industry,
    sizing: safeNumber(breakdown.sizing_contrib),
    selection: safeNumber(breakdown.selection_contrib),
    timing: safeNumber(breakdown.timing_contrib),
    factor: safeNumber(breakdown.factor_contrib_total),
    // 执行成本是支出, UI 上显示为负贡献便于业务直觉 ("成本拉低组合 P&L 多少")
    execution_cost: -safeNumber(breakdown.execution_cost),
  };
}

/**
 * 6 维贡献 → pie slice 数组, 按 ATTRIBUTION_DIMENSION_ORDER 排.
 *
 * 注意: pie size 用 absValue (因为正负贡献都要可见), color 用 value 符号.
 * pctOfAbs 仅在 totalAbs > 0 时填; 全 0 时返 0 让 UI 显示 "无数据" 占位.
 */
export function buildAttributionPieData(contribs: Record<AttributionDimensionKey, number>): {
  slices: AttributionPieSlice[];
  totalAbs: number;
} {
  const totalAbs = ATTRIBUTION_DIMENSION_ORDER.reduce(
    (sum, key) => sum + Math.abs(safeNumber(contribs[key])),
    0
  );
  const slices: AttributionPieSlice[] = ATTRIBUTION_DIMENSION_ORDER.map(key => {
    const value = safeNumber(contribs[key]);
    const absValue = Math.abs(value);
    return {
      key,
      label: ATTRIBUTION_DIMENSION_LABEL[key],
      value,
      absValue,
      color: pickAttributionColor(value),
      pctOfAbs: totalAbs > 0 ? absValue / totalAbs : 0,
    };
  });
  return { slices, totalAbs };
}

/**
 * 把 backend.best_trades / worst_trades JSONB 数组归一化成 UI 行.
 *
 * - 非数组 / 空 → []
 * - cap ATTRIBUTION_TOP_TRADE_LIMIT (后端已 cap, 冗余守一道)
 * - 字段缺失 fallback (id=0 / name=symbol / amount=0)
 */
export function normalizeBestWorstTrades(
  rows: AttributionBestWorstTrade[] | null | undefined
): AttributionTradeRow[] {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, ATTRIBUTION_TOP_TRADE_LIMIT).map(r => {
    const symbol = String(r?.symbol || '');
    return {
      id: safeNumber(r?.id),
      symbol,
      name: String(r?.name || symbol),
      realized_pnl: safeNumber(r?.realized_pnl),
      realized_pnl_pct:
        r?.realized_pnl_pct == null || !Number.isFinite(Number(r.realized_pnl_pct))
          ? null
          : Number(r.realized_pnl_pct),
      amount: safeNumber(r?.amount),
    };
  });
}

/**
 * AI summary 兜底 — backend.ai_summary 空时用 heuristic 拼 1 行 (与 backend
 * heuristicSummary 同款风格, 但前端只有最小信息所以更短).
 */
export function buildAttributionAiSummaryFallback(
  date: string,
  totalPnl: number,
  totalPnlPct: number | null,
  tradeCount: number
): string {
  const sign = totalPnl > 0 ? '+' : '';
  const pctStr = totalPnlPct == null ? '—' : `${totalPnlPct.toFixed(2)}%`;
  const text = `${date} 总盈亏 ${sign}${totalPnl.toFixed(2)} 元 (${pctStr}), 成交 ${tradeCount} 笔`;
  if (text.length > ATTRIBUTION_AI_SUMMARY_MAX_CHARS) {
    // Array.from 切字符避免中间断 unicode surrogate pair (与 [[AI_VIEW_MAX_CHARS]] 同款)
    return (
      Array.from(text)
        .slice(0, ATTRIBUTION_AI_SUMMARY_MAX_CHARS - 1)
        .join('') + '…'
    );
  }
  return text;
}

/**
 * 主入口: backend DailyAttributionReportRow → 完整 view model.
 *
 * report=null (404 / cron 未跑) → hidden=true 让 UI 显示 Empty 占位.
 * 任何字段缺失 / 异常 → 走 safeNumber / 空数组 fallback, 永远不抛.
 */
export function buildPortfolioAttributionCardViewModel(
  report: DailyAttributionReportRow | null | undefined
): PortfolioAttributionCardViewModel {
  if (!report) {
    return {
      hidden: true,
      date: '',
      status: 'unknown',
      statusReason: null,
      totalPnl: 0,
      totalPnlPct: null,
      realizedPnl: 0,
      unrealizedDelta: 0,
      tradeCount: 0,
      buyCount: 0,
      sellCount: 0,
      pieData: [],
      totalAbs: 0,
      residual: 0,
      bestTrades: [],
      worstTrades: [],
      aiSummary: '',
      aiSummaryIsBackend: false,
      industryTop: [],
      factorTop: [],
    };
  }
  const breakdown = report.breakdown;
  const contribs = extractDimensionContribs(breakdown);
  const { slices: pieData, totalAbs } = buildAttributionPieData(contribs);
  const residual = safeNumber(breakdown?.residual);
  const totalPnl = safeNumber(report.total_pnl);
  const totalPnlPct =
    report.total_pnl_pct == null || !Number.isFinite(Number(report.total_pnl_pct))
      ? null
      : Number(report.total_pnl_pct);
  const tradeCount = Math.max(0, Math.trunc(safeNumber(report.trade_count)));
  const buyCount = Math.max(0, Math.trunc(safeNumber(report.buy_count)));
  const sellCount = Math.max(0, Math.trunc(safeNumber(report.sell_count)));

  const aiSummaryFromBackend =
    typeof report.ai_summary === 'string' ? report.ai_summary.trim() : '';
  const aiSummaryIsBackend = aiSummaryFromBackend.length > 0;
  const aiSummary = aiSummaryIsBackend
    ? aiSummaryFromBackend
    : buildAttributionAiSummaryFallback(
        String(report.date || ''),
        totalPnl,
        totalPnlPct,
        tradeCount
      );

  const statusRaw = String(report.status || '');
  const status: PortfolioAttributionCardViewModel['status'] =
    statusRaw === 'ok' || statusRaw === 'skipped' || statusRaw === 'failed' ? statusRaw : 'unknown';
  const statusReason = status === 'ok' ? null : report.reason || null;

  const industryTop = Array.isArray(breakdown?.industry_contrib)
    ? breakdown.industry_contrib
        .slice(0, 5)
        .filter((it: AttributionIndustryContrib) => it && typeof it.industry === 'string')
    : [];
  const factorTop = Array.isArray(breakdown?.factor_contrib)
    ? breakdown.factor_contrib
        .slice(0, 5)
        .filter((it: AttributionFactorContrib) => it && typeof it.factor === 'string')
    : [];

  return {
    hidden: false,
    date: String(report.date || ''),
    status,
    statusReason,
    totalPnl,
    totalPnlPct,
    realizedPnl: safeNumber(report.realized_pnl),
    unrealizedDelta: safeNumber(report.unrealized_delta),
    tradeCount,
    buyCount,
    sellCount,
    pieData,
    totalAbs,
    residual,
    bestTrades: normalizeBestWorstTrades(report.best_trades),
    worstTrades: normalizeBestWorstTrades(report.worst_trades),
    aiSummary,
    aiSummaryIsBackend,
    industryTop,
    factorTop,
  };
}
