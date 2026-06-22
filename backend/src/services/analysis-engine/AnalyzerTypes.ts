/**
 * AnalyzerTypes — 多维分析引擎 (analysis-engine) v1 接口契约
 *
 * 详见 `docs/audit/analysis_engine_design_2026_06_18.md` §2.2.
 *
 * 设计原则:
 *   - TypeScript strict 全字段, 禁 any.
 *   - score 统一 [-100, +100] 范围, 负=利空 / 正=利多 / 0=中性.
 *   - confidence 统一 [0, 1].
 *   - data_missing 显式枚举缺失字段; **禁止隐式 fallback 到中性 50 分**.
 *   - 失败 (analyzer 抛 / 超时 / 数据 ≥50% 缺) 返回 `{ error, confidence:0 }`, 不抛.
 */

export type AnalyzerKey =
  | 'fundamental'
  | 'technical'
  | 'capital'
  | 'news'
  | 'sentiment'
  | 'industry_regime'
  | 'risk'
  | 'event';

export type MarketSegment = 'main' | 'chinext' | 'star' | 'bj';

export type EvidenceDirection = 'bullish' | 'bearish' | 'neutral';

export type RecommendationAction =
  | 'strong_buy'
  | 'buy'
  | 'add'
  | 'hold'
  | 'reduce'
  | 'sell'
  | 'strong_sell';

export type DataQualityLevel = 'good' | 'partial' | 'degraded' | 'critical';

/**
 * confidence_tier — 把 `overall_confidence ∈ [0,1]` 分桶到三档 (US-114 / AE-008).
 *
 * - `high` ≥ 0.7   → UI 强提示 / 飞书 push 走优先级队列 / autoBuy 视情况放大仓位
 * - `medium` ≥ 0.4 → UI 普通提示 / 默认仓位
 * - `low` < 0.4    → UI 弱提示 / autoBuy 默认跳过 (与 hold/critical 合流)
 *
 * 分桶规则与阈值常量同源于 `DecisionAggregator.pickConfidenceTier`,
 * 改阈值时必须同时改 `CONFIDENCE_TIER_HIGH_MIN` / `CONFIDENCE_TIER_MEDIUM_MIN`
 * 与单测 sanity (`HIGH_MIN > MEDIUM_MIN > 0`).
 */
export type ConfidenceTier = 'high' | 'medium' | 'low';

/**
 * position_action — 把 `RecommendationDecision.action` + `has_open_position` 折叠成
 * 4 档"仓位动作"语义 (BA-A / 用户清单 #14), 解决 hold + suggested_position=0% 在 UI
 * 上歧义的问题 — 用户看到 "confidence 84% / 仓位 0%" 时不知道是"高信心维持"还是
 * "高信心不建仓".
 *
 * 取值与映射 (单一事实源, 与 DecisionAggregator.derivePositionAction 同源):
 *
 * | action            | has_open_position=true | has_open_position=false |
 * |-------------------|------------------------|-------------------------|
 * | strong_buy / buy / add | open              | open                    |
 * | hold              | maintain               | avoid                   |
 * | reduce / sell / strong_sell | close          | avoid                   |
 *
 * UI 渲染契约 (前端 aiStockAnalysisModalV2Components 必须遵守):
 *   - open    → 显示具体仓位 % (suggested_position_pct)
 *   - maintain → 显示"维持当前仓位"文案 (不显示 %)
 *   - close   → 显示"卖出 / 减仓"文案 (按 action 细化)
 *   - avoid   → 显示"不建议建仓"文案 (不显示 %)
 */
export type PositionAction = 'open' | 'maintain' | 'close' | 'avoid';

/**
 * 数据质量判定结果. critical → aggregator 直接 hold + overall_confidence=0.
 */
export interface DataQualityVerdict {
  level: DataQualityLevel;
  missing_critical: string[];
  missing_optional: string[];
  notes: string[];
  /** [0,1] 乘到 overall_confidence 上 */
  coefficient: number;
}

/**
 * 单条 evidence — 必须可视化 (label/detail/direction/weight).
 */
export interface EvidenceItem {
  label: string;
  detail?: string;
  metric_value?: number;
  threshold?: number;
  direction: EvidenceDirection;
  /** 该 evidence 在所属 analyzer 内的相对权重 [0,1] */
  weight: number;
}

export interface DataSourceRef {
  name: string;
  as_of: string;
  is_realtime: boolean;
}

/**
 * Analyzer 入参 context. context build (Phase 1) 一次, 8 个 analyzer 并发消费同 ctx.
 */
export interface AnalyzerContext {
  stock: {
    code: string;
    name: string | null;
    industry: string | null;
    market_segment: MarketSegment;
  };
  /** YYYY-MM-DD */
  as_of: string;
  /** 截止 as_of 收盘后的日 K, 时间升序 */
  daily_bars: Array<{
    time: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    turnover?: number | null;
  }>;
  /** 实时行情 (可选, 缺失 → RiskAnalyzer 标 stale) */
  realtime_quote?: {
    price: number;
    bid?: number | null;
    ask?: number | null;
    volume?: number | null;
    as_of_ts: string;
  };
  /** 复用 MarketEnvironmentService.getEnvironmentForStock 输出 (取 snapshot 子集) */
  market_env?: unknown;
  /** factor_scores 按 factor_name 索引 (FactorScore.z_score) */
  factor_snapshot: Record<string, number | null>;
  user_profile?: {
    user_id: number;
    risk_config?: Record<string, unknown> | null;
  };
}

/**
 * 单个 analyzer 的标准化输出.
 */
export interface AnalyzerOutput {
  analyzer_key: AnalyzerKey;
  /** [-100, +100], 标准化跨 analyzer 直接比较 */
  score: number;
  evidence: EvidenceItem[];
  data_sources: DataSourceRef[];
  /** [0, 1] */
  confidence: number;
  /** 显式枚举缺失字段; 禁止隐式 fallback */
  data_missing: string[];
  /** 失败时填; 失败 = confidence=0 */
  error: { code: string; message: string } | null;
  elapsed_ms: number;
  /** EventAnalyzer 才会有: veto/dampen/delay/allow/boost 透传给 aggregator */
  event_action?: 'allow' | 'boost' | 'dampen' | 'veto' | 'delay';
  /** EventAnalyzer dampen 时给 aggregator 的 score_multiplier (默认 1) */
  event_score_multiplier?: number;
}

/**
 * Aggregator 输出 — Phase 3 的核心产物.
 */
export interface RecommendationDecision {
  action: RecommendationAction;
  /**
   * 建议仓位百分比 ∈ [0, 1]. 0 = 不建议建仓 / 持有不动 / 已被 veto;
   * 0 < x ≤ 1 = 建议买入到该仓位 (1 = 100% 满仓).
   *
   * **注意**: action='hold' 时此字段 = 0, 但语义因 `position_action` 不同而异:
   *   - position_action='maintain' (有持仓) → 维持当前仓位 (UI 不显示 %)
   *   - position_action='avoid' (无持仓) → 不建议建仓 (UI 显示"不建议建仓")
   * 不要直接读 suggested_position_pct=0 就把它当"无意义". 走 position_action.
   */
  suggested_position_pct: number;
  /**
   * 4 档仓位动作 (BA-A / 用户清单 #14) — open / maintain / close / avoid.
   * 由 `derivePositionAction(action, has_open_position)` 计算, 让前端不再
   * 反复 `if (action==='hold' && pct===0)` 散落判断 hold 的两种语义.
   * 必填 — aggregator 3 个 return 路径全部填.
   */
  position_action: PositionAction;
  /** entry 区间 (含涨跌停修正); 无法给则 null */
  entry_zone: [number, number] | null;
  stop_loss: number | null;
  take_profit: number | null;
  /** 按 |score × weight × confidence| 排 top 5 */
  key_reasons: string[];
  /** RiskAnalyzer + EventAnalyzer 的 negative evidence 全集 */
  risk_warnings: string[];
  /** [0, 1] */
  overall_confidence: number;
  /**
   * confidence_tier — `overall_confidence` 三档分桶 (US-114 / AE-008).
   * 由 `pickConfidenceTier(overall_confidence)` 计算, aggregator 在 3 个返回路径
   * (critical hold / veto / 正常加权) 全部填写, 让下游 UI / 飞书 push / autoBuy
   * 走 tier 而非反复 if (overall_confidence >= 0.7) 散落, 阈值改一处生效.
   */
  confidence_tier: ConfidenceTier;
  per_dimension: AnalyzerOutput[];
  data_quality: DataQualityVerdict;
  engine_variant: 'multi_dim_v1';
  shadow_of_report_id?: string | null;
  /** YYYY-MM-DD */
  as_of: string;
  stock_code: string;
}
