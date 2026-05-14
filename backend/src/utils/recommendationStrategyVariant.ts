function toNumber(value: any, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function toPositiveInt(value: any, fallback: number, max?: number): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  const normalized = Math.floor(num);
  return max ? Math.min(normalized, max) : normalized;
}

function roundNumber(value: any, digits = 2): number {
  const num = toNumber(value, 0);
  const base = 10 ** digits;
  return Math.round(num * base) / base;
}

function normalizeStyle(value: any): string {
  const style = String(value || '').trim();
  return ['balanced', 'momentum', 'value', 'low_risk'].includes(style) ? style : 'balanced';
}

export interface RecommendationStrategyVariant {
  strategy_key: string;
  strategy_bucket_label: string;
  style: string;
  min_score: number;
  score_bucket: string;
  default_position_pct: number;
  position_bucket: string;
  max_position_pct: number;
  max_position_bucket: string;
  paper_trade_limit: number;
  loop_run_id?: string;
  source?: string;
  generated_at?: string;
  policy_version_feedback_applied?: boolean;
  strategy_experiment_feedback_applied?: boolean;
  outcome_feedback_enabled?: boolean;
}

export function recommendationScoreBucket(value: any): string {
  const score = toNumber(value);
  if (score >= 85) return 'score_85_plus';
  if (score >= 78) return 'score_78_84';
  if (score >= 72) return 'score_72_77';
  return 'score_below_72';
}

export function recommendationPositionBucket(value: any): string {
  const pct = toNumber(value);
  if (pct >= 8) return 'position_8_plus';
  if (pct >= 5) return 'position_5_8';
  if (pct >= 3) return 'position_3_5';
  return 'position_below_3';
}

export function recommendationBucketLabel(key?: string): string {
  const labels: Record<string, string> = {
    balanced: '均衡',
    momentum: '动量',
    value: '价值',
    low_risk: '低风险',
    market: '全市场',
    favorites: '自选池',
    score_85_plus: '评分≥85',
    score_78_84: '评分78-84',
    score_72_77: '评分72-77',
    score_below_72: '评分<72',
    position_8_plus: '仓位≥8%',
    position_5_8: '仓位5-8%',
    position_3_5: '仓位3-5%',
    position_below_3: '仓位<3%',
    unknown: '未标注',
  };
  return labels[String(key || '')] || key || '未标注';
}

export function recommendationScorePositionKey(score: any, positionPct: any): string {
  return `score:${recommendationScoreBucket(score)}|pos:${recommendationPositionBucket(
    positionPct
  )}`;
}

export function recommendationScorePositionLabel(key?: string): string {
  const parsed = parseRecommendationStrategyKey(key || '');
  const score = parsed.score || 'unknown';
  const pos = parsed.pos || 'unknown';
  return `${recommendationBucketLabel(score)} · ${recommendationBucketLabel(pos)}`;
}

export function buildRecommendationStrategyVariant(
  policy: Record<string, any> = {},
  options: { loop_run_id?: string; source?: string; generated_at?: string } = {}
): RecommendationStrategyVariant {
  const style = normalizeStyle(policy.effective_style || policy.style || policy.base_style);
  const min_score = roundNumber(policy.effective_min_score ?? policy.min_score ?? policy.score, 2);
  const default_position_pct = roundNumber(
    policy.effective_default_position_pct ??
      policy.default_position_pct ??
      policy.position_pct ??
      policy.suggested_position_pct,
    2
  );
  const max_position_pct = roundNumber(
    policy.effective_max_position_pct ?? policy.max_position_pct ?? default_position_pct,
    2
  );
  const paper_trade_limit = toPositiveInt(
    policy.effective_paper_trade_limit ?? policy.paper_trade_limit,
    0,
    50
  );
  const score_bucket = recommendationScoreBucket(min_score);
  const position_bucket = recommendationPositionBucket(default_position_pct);
  const max_position_bucket = recommendationPositionBucket(max_position_pct);
  const strategy_key = [
    `style:${style}`,
    `score:${score_bucket}`,
    `pos:${position_bucket}`,
    `max:${max_position_bucket}`,
    `limit:${paper_trade_limit || 'na'}`,
  ].join('|');

  return {
    strategy_key,
    strategy_bucket_label: recommendationStrategyKeyLabel(strategy_key),
    style,
    min_score,
    score_bucket,
    default_position_pct,
    position_bucket,
    max_position_pct,
    max_position_bucket,
    paper_trade_limit,
    loop_run_id: options.loop_run_id,
    source: options.source,
    generated_at: options.generated_at,
    policy_version_feedback_applied:
      policy.policy_version_feedback_applied === undefined
        ? undefined
        : Boolean(policy.policy_version_feedback_applied),
    strategy_experiment_feedback_applied:
      policy.strategy_experiment_feedback_applied === undefined
        ? undefined
        : Boolean(policy.strategy_experiment_feedback_applied),
    outcome_feedback_enabled:
      policy.outcome_feedback_enabled === undefined
        ? undefined
        : Boolean(policy.outcome_feedback_enabled),
  };
}

export function parseRecommendationStrategyKey(key?: string): Record<string, string> {
  const result: Record<string, string> = {};
  String(key || '')
    .split('|')
    .map(part => part.trim())
    .filter(Boolean)
    .forEach(part => {
      const [name, ...rest] = part.split(':');
      if (!name || rest.length === 0) return;
      result[name] = rest.join(':');
    });
  return result;
}

export function recommendationStrategyKeyLabel(key?: string): string {
  if (!key || key === 'unknown') return '未标注参数组合';
  const parsed = parseRecommendationStrategyKey(key);
  const chunks = [
    recommendationBucketLabel(parsed.style),
    recommendationBucketLabel(parsed.score),
    recommendationBucketLabel(parsed.pos),
    parsed.limit && parsed.limit !== 'na' ? `跟单${parsed.limit}` : '',
  ].filter(Boolean);
  return chunks.length ? chunks.join(' · ') : key;
}
