import api from './api';

/**
 * CA-1 v3 推荐 (抖音风刷卡片) 前端 API 客户端.
 *
 * 调用 2 个后端端点 (backend/src/api/controllers/V3RecommendationController.ts):
 *   GET /api/today/v3-recommendations?limit=N&date=YYYY-MM-DD  → getV3Recommendations()
 *   GET /api/today/v3-funnel?date=YYYY-MM-DD                   → getV3Funnel()
 *
 * Service 边界与 todayWorkspaceService 一致:
 *   - 响应封套 `{ success, data, message? }` 在 service 层解开, 直接返 `data`;
 *   - `success === false` 抛 JS Error (component try/catch 接);
 *   - 不在 service 层做格式化 / colorize — UI 自己挑色.
 */

// ---------------------------------------------------------------------------
//  类型 — 字段名严格匹配 V3RecommendationController.enrichSignal() 输出
// ---------------------------------------------------------------------------

/** 4 维评分单项 (人气 / 逻辑 / 资金 / 结构), 由 aggregateToV3Dimensions 折叠 8 维 analyzer 而来. */
export interface V3DimensionItem {
  /** 维度 key — 'popularity' / 'logic' / 'capital' / 'structure'. */
  key: 'popularity' | 'logic' | 'capital' | 'structure';
  /** 中文 label — '人气' / '逻辑' / '资金' / '结构'. */
  label: string;
  /** UI 进度条直接用的归一值 ∈ [0,100]. */
  bar_value: number;
  /** 原始加权分 ∈ [-100,+100], 让上层算 tier 用. */
  raw_score: number;
  /** 子维 confidence 简单平均 ∈ [0,1]. */
  confidence: number;
  /** 命中的子 analyzer 数 (0 = 全缺数据, raw_score 兜底 0). */
  subs_present: number;
}

/** 20d sparkline 点 — backend 升序排列 (oldest → newest). */
export interface V3SparklinePoint {
  date: string;
  close: number;
}

/** 决策子对象 — analysis_engine archive metadata + decision 字段透传. */
export interface V3RecommendationDecision {
  /** 引擎原始 action — strong_buy / buy / add / ... */
  action: string;
  /** Normalize 后的 decision ('buy' / 'strong_buy' / ...). */
  normalized_decision: string;
  /** 0-100 标度 confidence_score (analysis_engine 落库时已乘 100). */
  confidence_score: number | null;
  /** 'high' / 'medium' / 'low' / null. */
  risk_level: string | null;
  /** [低, 高] 入场区间, 缺数据 null. */
  entry_zone: [number, number] | null;
  /** 单一止损价, 缺数据 null. */
  stop_loss: number | null;
  /** 单一止盈价, 缺数据 null. */
  take_profit: number | null;
  /** 建议仓位百分比 ∈ [0,1]. */
  suggested_position_pct: number | null;
  /** 'open' / 'maintain' / 'close' / 'avoid'. */
  position_action: string | null;
  /** 引擎自定义 tier (与 confidence_tier 同义, 透传防 UI 双计算). */
  confidence_tier_engine: 'high' | 'medium' | 'low' | null;
  /** 风险提示文本数组, 卡片侧栏 / detail modal 用. */
  risk_warnings: string[];
}

/** 单条 v3 推荐. */
export interface V3RecommendationItem {
  symbol: string;
  name: string | null;
  industry: string | null;
  /** 单位: 元 (1e8 = 1 亿). UI 自己换算. */
  circulating_market_cap: number | null;
  total_market_cap: number | null;
  current_price: number | null;
  change_pct: number | null;
  turnover_rate: number | null;
  amplitude_pct: number | null;
  /** 20d 累计涨跌 %. */
  cumulative_change_pct_20d: number | null;
  sparkline: V3SparklinePoint[];
  dimensions: V3DimensionItem[];
  /** 4 维 bar_value 平均归类 — UI 卡片左上角徽标用. */
  confidence_tier: 'high' | 'medium' | 'low';
  /** 引擎 overall_confidence ∈ [0,1], 缺数据 null. */
  overall_confidence: number | null;
  /** 最多 3 个高亮 tag — ['超大市值','题材活跃','放量突破']. */
  highlight_tags: string[];
  /** 一句话推荐理由, 缺数据 null. */
  recommend_reason: string | null;
  decision: V3RecommendationDecision;
  /** AIInvestmentSignal.id, 跳详情用. */
  signal_id: number;
  /** 后端归档时的 signal_date (YYYY-MM-DD). */
  signal_date: string;
  /** enrichSignal 失败兜底视图标记 — UI 可选显示 "数据加载部分失败" 提示. */
  enrich_failed?: boolean;
}

/** 漏斗统计 — 顶部条 "今日筛选 X 只候选 / Y 只达标 / 推荐 Z 只" 用. */
export interface V3FunnelStats {
  /** 全市场上市股票数 — Daily Screener universe 同口径. */
  scanned: number;
  /** 当日所有 AI 生成 signal 数 (analysis_engine + quant_recommendation + tradingagents). */
  candidate: number;
  /** 当日 BUY/STRONG_BUY 数. */
  selected: number;
  /** 'YYYY-MM-DD'. */
  as_of: string;
}

export interface V3RecommendationData {
  as_of: string;
  recommendations: V3RecommendationItem[];
  funnel: V3FunnelStats;
}

export interface V3RecommendationResponse {
  success: boolean;
  data: V3RecommendationData;
  message?: string;
}

// ---------------------------------------------------------------------------
//  API
// ---------------------------------------------------------------------------

export async function getV3Recommendations(
  opts: {
    limit?: number;
    date?: string;
  } = {}
): Promise<V3RecommendationData> {
  const res = await api.get('/today/v3-recommendations', {
    params: {
      ...(opts.limit ? { limit: opts.limit } : {}),
      ...(opts.date ? { date: opts.date } : {}),
    },
  });
  if (!res.data?.success) {
    throw new Error(res.data?.message || '获取 v3 推荐失败');
  }
  return res.data.data as V3RecommendationData;
}

export async function getV3Funnel(date?: string): Promise<V3FunnelStats> {
  const res = await api.get('/today/v3-funnel', {
    params: date ? { date } : undefined,
  });
  if (!res.data?.success) {
    throw new Error(res.data?.message || '获取 v3 漏斗失败');
  }
  return res.data.data as V3FunnelStats;
}

// ---------------------------------------------------------------------------
//  bundled export
// ---------------------------------------------------------------------------

export const v3RecommendationService = {
  getV3Recommendations,
  getV3Funnel,
};

export default v3RecommendationService;
