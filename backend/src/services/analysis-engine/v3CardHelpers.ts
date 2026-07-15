/**
 * V3 抖音风推荐卡片 — 8 维 → 4 维聚合 helper (CA-1).
 *
 * 截图产品形态: 用户一眼看 4 个分数 (人气 50 / 逻辑 80 / 资金 86 / 结构 40),
 * 比看 8 个分数轻量, 但保留信息密度 (8 维 underlying 仍可在 Modal 查).
 *
 * 映射规则 (与 [[DecisionAggregator.DEFAULT_ANALYZER_WEIGHTS]] 同源):
 *
 *   人气 (popularity) = sentiment 100%
 *     — 散户情绪 / 雪球热度 / 龙虎榜 散户席位
 *
 *   逻辑 (logic) = fundamental 50% + industry_regime 30% + event 20%
 *     — 基本面 + 行业景气 + 事件催化, 共同构成"为什么这只票应该涨"的故事
 *
 *   资金 (capital) = capital 100%
 *     — 北向 / 主力 / 融资 / 大单
 *
 *   结构 (structure) = technical 70% + risk × -1 30%
 *     — 技术面正向 - 风险负向, "图形结构是否健康".
 *     按 spec 字面实施 (weight=-0.3): contribution = score × weight, 让 caller
 *     在 risk score 维持"正=利多 负=利空" 跨 analyzer 通用约定下, 把 risk 维度
 *     在结构里以"负权重"形式贡献 — 与 spec 注释一致, 实际效果是 risk.score 越正
 *     (低风险=利多) 会"减小" structure 得分, 这与 product 视角"risk × -1"完全对齐.
 *
 * news 维度不进 4 维 (避免与 logic 重复, news 更短期 / 事件驱动, 已含在 event 子项),
 *   但保留在 evidence/highlights 给详情区展示.
 */

export type V3DimensionKey = 'popularity' | 'logic' | 'capital' | 'structure';

export const V3_DIMENSION_KEYS: ReadonlyArray<V3DimensionKey> = Object.freeze([
  'popularity',
  'logic',
  'capital',
  'structure',
] as const);

export const V3_DIMENSION_LABEL: Readonly<Record<V3DimensionKey, string>> = Object.freeze({
  popularity: '人气',
  logic: '逻辑',
  capital: '资金',
  structure: '结构',
});

/**
 * 4 维子映射权重 — 与 DEFAULT_ANALYZER_WEIGHTS 同款 Object.freeze, sum_abs ≈ 1 per dim
 * (structure 的 risk 负权重故意保留, sum_abs = 0.7 + 0.3 = 1.0).
 */
export const V3_SUB_WEIGHTS: Readonly<Record<V3DimensionKey, Readonly<Record<string, number>>>> =
  Object.freeze({
    popularity: Object.freeze({ sentiment: 1.0 }),
    logic: Object.freeze({ fundamental: 0.5, industry_regime: 0.3, event: 0.2 }),
    capital: Object.freeze({ capital: 1.0 }),
    structure: Object.freeze({ technical: 0.7, risk: -0.3 }),
  });

/**
 * score [-100,+100] → bar [0,100] (与 frontend aiStockAnalysisModalV2Helpers.scoreToBarValue 同款).
 * 非 finite (NaN/Infinity/null/undefined) → 50 (中性, 兜底).
 */
export function scoreToBarValue(score: number | null | undefined): number {
  if (typeof score !== 'number' || !Number.isFinite(score)) return 50;
  return Math.round(Math.max(0, Math.min(100, (score + 100) / 2)));
}

/**
 * 4 维 V3DimensionScore. raw_score ∈ [-100,+100] 让调用方算 tier; bar_value ∈ [0,100]
 * 是 UI 进度条直接喂的值; confidence 是子维 confidence 简单平均.
 */
export interface V3DimensionScore {
  key: V3DimensionKey;
  label: string;
  /** 0-100 (UI 直接用) */
  bar_value: number;
  /** 原始加权 score ∈ [-100,+100], 让调用方算 tier */
  raw_score: number;
  /** 0-1, 子维 confidence 的简单平均 */
  confidence: number;
  /** 该维度有几个子 analyzer 命中 (0 = 全缺, raw_score 兜底 0) */
  subs_present: number;
}

interface PerDimensionInput {
  analyzer_key: string;
  score: number;
  confidence: number;
}

function safeNumber(x: unknown, fallback = 0): number {
  if (typeof x !== 'number' || !Number.isFinite(x)) return fallback;
  return x;
}

/**
 * 把 8 维 AnalyzerOutput[] 折叠成 4 维 V3DimensionScore[].
 * - 子维 score 缺失 (找不到 analyzer_key) → 该子维贡献 0, 且不算入 sumAbsWeight 分母
 * - risk 子维负权重: contribution = score × (-0.3) (与 spec 字面一致)
 * - 全部子维都缺 → raw_score=0, bar=50 (中性), subs_present=0
 * - score / confidence 非 finite → 安全 fallback 到 0 (而非整维退化)
 */
export function aggregateToV3Dimensions(
  perDimension: ReadonlyArray<PerDimensionInput>
): V3DimensionScore[] {
  const byKey = new Map<string, PerDimensionInput>();
  for (const item of perDimension) {
    if (item && typeof item.analyzer_key === 'string') {
      byKey.set(item.analyzer_key, item);
    }
  }
  return V3_DIMENSION_KEYS.map<V3DimensionScore>(dimKey => {
    const subWeights = V3_SUB_WEIGHTS[dimKey];
    let sumWeighted = 0;
    let sumAbsWeight = 0;
    let sumConfidence = 0;
    let nPresent = 0;
    for (const [subKey, weight] of Object.entries(subWeights)) {
      const sub = byKey.get(subKey);
      if (!sub) continue;
      const score = safeNumber(sub.score, 0);
      const conf = Math.max(0, Math.min(1, safeNumber(sub.confidence, 0)));
      sumWeighted += score * weight;
      sumAbsWeight += Math.abs(weight);
      sumConfidence += conf;
      nPresent += 1;
    }
    const rawScore = sumAbsWeight > 0 ? sumWeighted / sumAbsWeight : 0;
    const bar = scoreToBarValue(rawScore);
    const confidence = nPresent > 0 ? sumConfidence / nPresent : 0;
    return {
      key: dimKey,
      label: V3_DIMENSION_LABEL[dimKey],
      bar_value: bar,
      raw_score: Math.round(rawScore * 100) / 100,
      confidence: Math.round(confidence * 100) / 100,
      subs_present: nPresent,
    };
  });
}

// ---------------------------------------------------------------------------
//  高亮标签 — 顶部 3 个 tag (千亿大盘 / 关联题材 / 放量突破 等)
// ---------------------------------------------------------------------------

/**
 * 单条 evidence — buildHighlightTags 用, 与 EvidenceItem 同字段子集.
 */
export interface HighlightEvidence {
  label: string;
  direction: string;
}

export interface HighlightDimension {
  analyzer_key: string;
  score: number;
  evidence?: ReadonlyArray<HighlightEvidence>;
}

export interface HighlightStockInfo {
  circulating_market_cap?: number | null;
  total_market_cap?: number | null;
}

/** 元 — 1e8 (人民币习惯). 1000亿 = 1e11 元. */
const CAP_BUCKETS: ReadonlyArray<{ threshold: number; label: string }> = Object.freeze([
  { threshold: 1e11, label: '超大市值' }, // >= 1000亿
  { threshold: 5e10, label: '千亿大盘' }, // [500亿, 1000亿)
  { threshold: 1e10, label: '中盘股' }, // [100亿, 500亿)
  { threshold: 0, label: '小盘股' }, // < 100亿
]);

const SCORE_TAG_THRESHOLDS: Readonly<Record<string, { threshold: number; label: string }>> =
  Object.freeze({
    capital: { threshold: 60, label: '资金流入' },
    sentiment: { threshold: 60, label: '题材活跃' },
    technical: { threshold: 60, label: '放量突破' },
    event: { threshold: 40, label: '事件催化' },
    industry_regime: { threshold: 60, label: '行业景气' },
  });

const TECHNICAL_BREAKOUT_KEYWORDS: ReadonlyArray<string> = Object.freeze(['放量', '突破']);

/**
 * 按 spec priority 顺序追加:
 *   市值类 (1) → capital (2) → sentiment (3) → technical (4) → event (5) → industry (6)
 *
 * technical 还要求 evidence 含 "放量" 或 "突破" 字样才生效 ("放量突破" 不能仅看分数).
 */
export function buildHighlightTags(
  stock: HighlightStockInfo | null | undefined,
  perDimension: ReadonlyArray<HighlightDimension>,
  maxTags = 3
): string[] {
  const out: string[] = [];

  // 1. 市值标签 (用 circulating 优先, 缺则 total)
  const capRaw = stock?.circulating_market_cap ?? stock?.total_market_cap ?? null;
  const cap = typeof capRaw === 'number' && Number.isFinite(capRaw) && capRaw > 0 ? capRaw : null;
  if (cap !== null) {
    for (const bucket of CAP_BUCKETS) {
      if (cap >= bucket.threshold) {
        out.push(bucket.label);
        break;
      }
    }
  }

  const byKey = new Map<string, HighlightDimension>();
  for (const item of perDimension) {
    if (item && typeof item.analyzer_key === 'string') {
      byKey.set(item.analyzer_key, item);
    }
  }

  const tagPriority: Array<{ key: string; checker: (d: HighlightDimension) => boolean }> = [
    {
      key: 'capital',
      checker: d => safeNumber(d.score, -1e9) > SCORE_TAG_THRESHOLDS.capital.threshold,
    },
    {
      key: 'sentiment',
      checker: d => safeNumber(d.score, -1e9) > SCORE_TAG_THRESHOLDS.sentiment.threshold,
    },
    {
      key: 'technical',
      checker: d => {
        if (safeNumber(d.score, -1e9) <= SCORE_TAG_THRESHOLDS.technical.threshold) return false;
        const evs = d.evidence ?? [];
        return evs.some(ev =>
          TECHNICAL_BREAKOUT_KEYWORDS.some(
            kw => typeof ev?.label === 'string' && ev.label.includes(kw)
          )
        );
      },
    },
    {
      key: 'event',
      checker: d => safeNumber(d.score, -1e9) > SCORE_TAG_THRESHOLDS.event.threshold,
    },
    {
      key: 'industry_regime',
      checker: d => safeNumber(d.score, -1e9) > SCORE_TAG_THRESHOLDS.industry_regime.threshold,
    },
  ];

  for (const { key, checker } of tagPriority) {
    if (out.length >= maxTags) break;
    const dim = byKey.get(key);
    if (!dim) continue;
    if (checker(dim)) {
      const cfg = SCORE_TAG_THRESHOLDS[key];
      if (cfg && !out.includes(cfg.label)) out.push(cfg.label);
    }
  }

  return out.slice(0, maxTags);
}

// ---------------------------------------------------------------------------
//  V3 confidence_tier — 4 维 bar 平均三档
// ---------------------------------------------------------------------------

/**
 * 4 维 → confidence_tier — 与 pickConfidenceTier 同款 high/medium/low 三档.
 * 取 4 维 bar_value 简单平均: ≥70 high / ≥40 medium / else low. 全缺 → low.
 * 任何 NaN / Infinity / 异常输入 fail-safe 到 'low' (与 critical→0 同款最安全档兜底).
 */
export function pickV3ConfidenceTier(
  dimensions: ReadonlyArray<V3DimensionScore>
): 'high' | 'medium' | 'low' {
  if (!Array.isArray(dimensions) || dimensions.length === 0) return 'low';
  let sum = 0;
  let n = 0;
  for (const d of dimensions) {
    const v = typeof d?.bar_value === 'number' && Number.isFinite(d.bar_value) ? d.bar_value : null;
    if (v === null) continue;
    sum += v;
    n += 1;
  }
  if (n === 0) return 'low';
  const avg = sum / n;
  if (!Number.isFinite(avg)) return 'low';
  if (avg >= 70) return 'high';
  if (avg >= 40) return 'medium';
  return 'low';
}
