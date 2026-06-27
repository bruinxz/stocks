/**
 * US-075 [FE-036] AIStockAnalysisModal v2 — 纯函数 helper.
 *
 * v2 vs v1 区别:
 *   - v1 (legacy): 5 维 dimensions (fundamental/technical/capital/news/sentiment) +
 *     综合建议 + per-dim key_points; 数据从 TradingAgents 来.
 *   - v2 (multi_dim_v1): 8 dim analyzer (前 5 + industry_regime/risk/event) + 每维
 *     standardized score [-100, +100] + confidence [0,1] + data_missing + entry_zone /
 *     stop_loss / take_profit / suggested_position_pct + risk_warnings.
 *
 * 触发条件: `result.metadata.engine_variant === 'multi_dim_v1'` 或 result.metadata
 * .per_dimension 是非空数组 (hard mode 短路 / shadow archive 都会写 per_dimension).
 *
 * v1 modal 继续接收 result 渲染旧 UI; v2 helper 把 metadata 拆成结构化 view model
 * 喂 v2 子组件 (US-076: AnalyzerScoreBar / ConfidenceRing / EvidenceList;
 *           US-077: DataMissingBanner / ActionPlanCard).
 *
 * 设计 (沿用 [[shadowRunHelpers]] / [[todoSuggestionsHelpers]] / [[analysisEngineWeightHelpers]]):
 *   - 8 dim 顺序 + label + 颜色全 frozen export, 单测守 sanity;
 *   - 主入口 `buildV2ViewModel(result | null | undefined)` 返 `V2ViewModel | null`
 *     — null 强制 modal fall-back v1 (不破坏 US-055 现有路径);
 *   - 各 helper 纯函数 pure (输入相同必返同输出 → React useMemo 安全);
 *   - 无 React / antd 依赖, 单测在 backend/tests/services/ai-stock-analysis-modal-v2-helpers
 *     .test.ts 跨 monorepo ts-node --transpile-only 跑.
 *
 * 与 backend 解耦: 完全消费已有 metadata.per_dimension / entry_zone / stop_loss /
 * take_profit / suggested_position_pct / risk_warnings / data_quality 字段, 不新加 API.
 * 上游 backend 在 hard mode (US-022 hardShortCircuit) + shadow archive (US-021) 都已写入
 * metadata, 见 backend/src/services/analysis-engine/hardShortCircuit.ts line 282-300.
 */

import type { AnalyzeSingleStockResult } from '../../services/aiStockAnalysisService';

// ===========================================================================
// 类型定义 — 8 dim analyzer (与 backend AnalyzerKey 一致)
// ===========================================================================

/** 8 个 analyzer key — 与 backend AnalyzerKey 一致 */
export type AnalyzerKeyV2 =
  | 'fundamental'
  | 'technical'
  | 'capital'
  | 'sentiment'
  | 'news'
  | 'industry_regime'
  | 'risk'
  | 'event';

/**
 * 8 dim 顺序 — 与 [[analysisEngineWeightHelpers]] ANALYZER_DIMENSIONS 默认顺序一致,
 * 让用户在 v2 modal / Settings tab 看到的 dim 排序相同 (跨页面认知零迁移).
 */
export const ANALYZER_KEYS_V2: ReadonlyArray<AnalyzerKeyV2> = Object.freeze([
  'fundamental',
  'technical',
  'capital',
  'sentiment',
  'news',
  'industry_regime',
  'risk',
  'event',
] as const);

/** 8 dim 中文 label — 与 [[analysisEngineWeightHelpers]] 同步, "(英文)" 后缀去掉 v2 modal 节省空间 */
export const ANALYZER_LABELS_V2: Readonly<Record<AnalyzerKeyV2, string>> = Object.freeze({
  fundamental: '基本面',
  technical: '技术面',
  capital: '资金面',
  sentiment: '情绪面',
  news: '消息面',
  industry_regime: '行业景气',
  risk: '风险',
  event: '事件',
});

/** 8 dim 简短描述 — 给 v2 modal Tooltip / 当数据缺失时显示 */
export const ANALYZER_HINTS_V2: Readonly<Record<AnalyzerKeyV2, string>> = Object.freeze({
  fundamental: 'ROE / 毛利 / 营收增速 / PE PB 估值分位',
  technical: 'MA / MACD / KDJ / 量价背离',
  capital: '北向 / 主力净流入 / 融资余额',
  sentiment: '换手率 / 涨停 / 龙虎榜 / 雪球热度',
  news: '研报 / 公告 / 行业新闻 / 招标',
  industry_regime: '行业景气 / 龙头共振 / 板块轮动',
  risk: '波动 / 回撤 / ST / 商誉 / 大股东减持',
  event: '业绩预告 / 减持 / 解禁 / 分红 / 退市',
});

/**
 * data_quality 4 档颜色 — 与 [[shadowRunHelpers]] HEALTH_LEVEL_COLOR 风格保持一致
 * (good=绿 / partial=蓝 / degraded=橙 / critical=红 / unknown=灰).
 */
export const DATA_QUALITY_COLOR: Readonly<Record<string, string>> = Object.freeze({
  good: 'green',
  partial: 'blue',
  degraded: 'orange',
  critical: 'red',
  unknown: 'default',
});

export const DATA_QUALITY_LABEL: Readonly<Record<string, string>> = Object.freeze({
  good: '数据完整',
  partial: '部分缺失',
  degraded: '降级',
  critical: '严重缺失',
  unknown: '未知',
});

/** action 7 档 — 与 backend RecommendationAction 一致 */
export type ActionV2 = 'strong_buy' | 'buy' | 'add' | 'hold' | 'reduce' | 'sell' | 'strong_sell';

/** action 中文 label */
export const ACTION_LABELS_V2: Readonly<Record<ActionV2, string>> = Object.freeze({
  strong_buy: '强烈买入',
  buy: '买入',
  add: '加仓',
  hold: '持有 / 观望',
  reduce: '减仓',
  sell: '卖出',
  strong_sell: '强烈卖出',
});

/** action 颜色 — 红=买 (中股惯例) / 绿=卖 / 蓝=持 */
export const ACTION_COLORS_V2: Readonly<Record<ActionV2, string>> = Object.freeze({
  strong_buy: '#9b1f00',
  buy: '#dc2626',
  add: '#fa541c',
  hold: '#1890ff',
  reduce: '#73d13d',
  sell: '#16a34a',
  strong_sell: '#135200',
});

// ===========================================================================
// score → 0-100 进度 / 颜色映射
// ===========================================================================

/**
 * 把 [-100, +100] 标准分映射成 [0, 100] 进度条值 (50 = 中性).
 * 非数字 / NaN / Infinity 返 50 (中性, 兜底).
 */
export function scoreToBarValue(score: number | null | undefined): number {
  if (typeof score !== 'number' || !Number.isFinite(score)) return 50;
  const clamped = Math.max(-100, Math.min(100, score));
  // [-100, +100] → [0, 100]
  return Math.round((clamped + 100) / 2);
}

/**
 * 标准分颜色 — 高利多=红 / 高利空=绿 / 中性=蓝 (与 ACTION_COLORS_V2 同方向).
 * 阈值与 [[hardShortCircuit.pickHardRiskLevel]] 对齐 (±50 强信号, ±20 弱信号).
 */
export function scoreToColor(score: number | null | undefined): string {
  if (typeof score !== 'number' || !Number.isFinite(score)) return '#bfbfbf';
  if (score >= 50) return '#dc2626'; // 强利多
  if (score >= 20) return '#fa541c'; // 弱利多
  if (score <= -50) return '#16a34a'; // 强利空
  if (score <= -20) return '#73d13d'; // 弱利空
  return '#1890ff'; // 中性
}

/**
 * confidence [0,1] → 颜色 — < 0.3 红 / < 0.6 橙 / ≥ 0.6 绿.
 * 给 ConfidenceRing 子组件用 (US-076), 单测固化在本 helper.
 */
export function confidenceToColor(confidence: number | null | undefined): string {
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return '#bfbfbf';
  if (confidence < 0.3) return '#dc2626';
  if (confidence < 0.6) return '#fa8c16';
  return '#16a34a';
}

// ===========================================================================
// 单 dim 视图模型
// ===========================================================================

/**
 * 单条 evidence — 与 backend EvidenceItem 一致, 但 weight 可选 (旧 archive 可能没填).
 * direction 缺失走 inferDirection (score>0 = bullish, score<0 = bearish).
 */
export interface EvidenceViewItemV2 {
  label: string;
  detail: string;
  direction: 'bullish' | 'bearish' | 'neutral';
  weight: number;
}

/** 8 dim 视图模型 — UI 直接 render */
export interface AnalyzerDimensionViewModelV2 {
  key: AnalyzerKeyV2;
  label: string;
  hint: string;
  score: number | null;
  /** scoreToBarValue(score) 预算好让 UI 直接喂 Progress percent */
  bar_value: number;
  color: string;
  confidence: number | null;
  confidence_color: string;
  data_missing: string[];
  error: string | null;
  /** evidence 按 weight desc 排, 顶 N 条 */
  evidence: EvidenceViewItemV2[];
  /** 是否完全失败 (error 非空 OR confidence===0) */
  failed: boolean;
}

/**
 * 把 backend per_dimension 单项 → V2 view model. 未知 analyzer_key 返 null (caller 应过滤).
 */
export function buildAnalyzerDimensionViewModelV2(
  raw: unknown
): AnalyzerDimensionViewModelV2 | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const key = r.analyzer_key;
  if (typeof key !== 'string' || !ANALYZER_KEYS_V2.includes(key as AnalyzerKeyV2)) {
    return null;
  }
  const k = key as AnalyzerKeyV2;
  const scoreRaw = r.score;
  const score =
    typeof scoreRaw === 'number' && Number.isFinite(scoreRaw)
      ? Math.max(-100, Math.min(100, scoreRaw))
      : null;
  const confRaw = r.confidence;
  const confidence =
    typeof confRaw === 'number' && Number.isFinite(confRaw)
      ? Math.max(0, Math.min(1, confRaw))
      : null;
  const dataMissingRaw = Array.isArray(r.data_missing) ? r.data_missing : [];
  const data_missing = dataMissingRaw
    .map(s => (typeof s === 'string' ? s.trim() : ''))
    .filter(s => s.length > 0);
  const errorObj = r.error;
  let error: string | null = null;
  if (errorObj && typeof errorObj === 'object') {
    const eo = errorObj as Record<string, unknown>;
    if (typeof eo.message === 'string' && eo.message.length > 0) error = eo.message;
  } else if (typeof errorObj === 'string' && errorObj.length > 0) {
    error = errorObj;
  }
  const evidenceRaw = Array.isArray(r.evidence) ? r.evidence : [];
  const evidence = evidenceRaw
    .map((e: unknown) => buildEvidenceItemV2(e, score))
    .filter((e): e is EvidenceViewItemV2 => e !== null)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 5);
  const failed = error !== null || (confidence !== null && confidence === 0);
  return {
    key: k,
    label: ANALYZER_LABELS_V2[k],
    hint: ANALYZER_HINTS_V2[k],
    score,
    bar_value: scoreToBarValue(score),
    color: scoreToColor(score),
    confidence,
    confidence_color: confidenceToColor(confidence),
    data_missing,
    error,
    evidence,
    failed,
  };
}

/**
 * 单条 evidence → view item. label 必填 (空返 null), direction 缺失走 score 推断.
 */
export function buildEvidenceItemV2(
  raw: unknown,
  parentScore: number | null
): EvidenceViewItemV2 | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const labelRaw = r.label;
  const label = typeof labelRaw === 'string' ? labelRaw.trim() : '';
  if (label.length === 0) return null;
  const detailRaw = r.detail;
  const detail = typeof detailRaw === 'string' ? detailRaw : '';
  const directionRaw = r.direction;
  let direction: 'bullish' | 'bearish' | 'neutral' = 'neutral';
  if (directionRaw === 'bullish' || directionRaw === 'bearish' || directionRaw === 'neutral') {
    direction = directionRaw;
  } else if (typeof parentScore === 'number' && Number.isFinite(parentScore)) {
    if (parentScore > 5) direction = 'bullish';
    else if (parentScore < -5) direction = 'bearish';
  }
  const weightRaw = r.weight;
  const weight =
    typeof weightRaw === 'number' && Number.isFinite(weightRaw)
      ? Math.max(0, Math.min(1, weightRaw))
      : 0;
  return { label, detail, direction, weight };
}

// ===========================================================================
// 行动计划 (entry_zone / stop_loss / take_profit / position_pct)
// ===========================================================================

/** 行动计划 view model — 喂 US-077 ActionPlanCard 用 */
export interface ActionPlanViewModelV2 {
  action: ActionV2 | 'unknown';
  action_label: string;
  action_color: string;
  /** [low, high] 价格区间; 缺失 null */
  entry_zone: [number, number] | null;
  stop_loss: number | null;
  take_profit: number | null;
  /** [0, 1] → percent (e.g. 0.15 → 15); 缺失 null */
  suggested_position_pct: number | null;
  /**
   * BA-A (用户清单 #14) — 4 档仓位动作:
   *   - 'open': 显示具体仓位 % (suggested_position_pct)
   *   - 'maintain': 显示"维持当前仓位"文案 (不显示 %)
   *   - 'close': 显示"卖出 / 减仓"文案
   *   - 'avoid': 显示"不建议建仓"文案
   *   - 'unknown': 旧 archive 没写, fallback 走 suggested_position_pct
   *
   * UI 必须用 position_action 而不是直接判 suggested_position_pct == 0,
   * 因为 hold + 持仓 → maintain (pct=0 但语义"维持"), hold + 无持仓 → avoid
   * (pct=0 且语义"不建仓"). 两者前端显示完全不同.
   */
  position_action: 'open' | 'maintain' | 'close' | 'avoid' | 'unknown';
  /** position_action 对应的中文展示文案 (UI 直接渲染) */
  position_action_label: string;
  /** 风险提示 (RiskAnalyzer + EventAnalyzer negative evidence 全集) */
  risk_warnings: string[];
}

/**
 * position_action 中文文案表 (与 backend AnalyzerTypes.PositionAction 同源).
 */
export const POSITION_ACTION_LABELS: Readonly<
  Record<'open' | 'maintain' | 'close' | 'avoid', string>
> = Object.freeze({
  open: '建议建仓',
  maintain: '维持当前仓位',
  close: '建议卖出',
  avoid: '不建议建仓',
});

/** action 字符串 → 枚举; 未知返 'unknown' */
export function normalizeAction(raw: unknown): ActionV2 | 'unknown' {
  if (typeof raw !== 'string') return 'unknown';
  if ((ACTION_LABELS_V2 as Record<string, string>)[raw]) return raw as ActionV2;
  return 'unknown';
}

/**
 * 把 backend metadata 拼成 ActionPlanViewModel.
 * 单字段缺失走 null 兜底, 不抛.
 */
export function buildActionPlanViewModelV2(
  metadata: Record<string, unknown> | null | undefined
): ActionPlanViewModelV2 {
  const m: Record<string, unknown> = metadata && typeof metadata === 'object' ? metadata : {};
  // action 从 hard_short_circuit_action / metadata.action / 顶层 recommendation (旧字段)
  // 三个候选里挨个尝试, 让 helper 对历史 archive 兼容.
  const actionRaw = m.hard_short_circuit_action ?? m.action ?? null;
  const action = normalizeAction(actionRaw);
  // entry_zone 必须 2-元素数组, 都是有限数; 否则 null.
  const entryRaw = m.entry_zone;
  let entry_zone: [number, number] | null = null;
  if (Array.isArray(entryRaw) && entryRaw.length === 2) {
    const lo = Number(entryRaw[0]);
    const hi = Number(entryRaw[1]);
    if (Number.isFinite(lo) && Number.isFinite(hi)) {
      entry_zone = lo <= hi ? [lo, hi] : [hi, lo];
    }
  }
  const stopRaw = m.stop_loss;
  const stop_loss = typeof stopRaw === 'number' && Number.isFinite(stopRaw) ? stopRaw : null;
  const tpRaw = m.take_profit;
  const take_profit = typeof tpRaw === 'number' && Number.isFinite(tpRaw) ? tpRaw : null;
  const posRaw = m.suggested_position_pct;
  const suggested_position_pct =
    typeof posRaw === 'number' && Number.isFinite(posRaw) ? Math.max(0, Math.min(1, posRaw)) : null;
  // BA-A (用户清单 #14) — position_action 透传 + fallback
  // 旧 archive 未写 position_action 时根据 (action, suggested_position_pct, has_open_position 缺失)
  // fallback: action=hold + pct=0 → avoid (保守兜底, 与默认 has_open_position=false 一致),
  // action=买入类 → open, action=卖出类 → close (前端不知道是否持仓, 默认 close 提示需操作).
  const paRaw = m.position_action;
  let position_action: 'open' | 'maintain' | 'close' | 'avoid' | 'unknown' = 'unknown';
  if (paRaw === 'open' || paRaw === 'maintain' || paRaw === 'close' || paRaw === 'avoid') {
    position_action = paRaw;
  } else if (action === 'strong_buy' || action === 'buy' || action === 'add') {
    position_action = 'open';
  } else if (action === 'hold') {
    position_action = 'avoid';
  } else if (action === 'reduce' || action === 'sell' || action === 'strong_sell') {
    position_action = 'close';
  }
  const position_action_label =
    position_action === 'unknown'
      ? ''
      : (POSITION_ACTION_LABELS as Record<string, string>)[position_action] || '';
  const warningsRaw = Array.isArray(m.risk_warnings) ? m.risk_warnings : [];
  const risk_warnings = warningsRaw
    .map(w => (typeof w === 'string' ? w.trim() : ''))
    .filter(w => w.length > 0)
    .slice(0, 10);
  return {
    action,
    action_label:
      action === 'unknown'
        ? '暂无明确建议'
        : ACTION_LABELS_V2[action as ActionV2] || String(action),
    action_color: action === 'unknown' ? '#8c8c8c' : ACTION_COLORS_V2[action as ActionV2],
    entry_zone,
    stop_loss,
    take_profit,
    suggested_position_pct,
    position_action,
    position_action_label,
    risk_warnings,
  };
}

// ===========================================================================
// data_quality view model
// ===========================================================================

export interface DataQualityViewModelV2 {
  level: string;
  level_label: string;
  level_color: string;
  /** 必备字段缺失 — 任一存在则展示严重 banner */
  missing_critical: string[];
  /** 可选字段缺失 — 展示信息条 */
  missing_optional: string[];
  /** 系数 [0,1], 乘到 overall_confidence */
  coefficient: number;
}

/** 把 metadata.data_quality 拼成 view model */
export function buildDataQualityViewModelV2(
  metadata: Record<string, unknown> | null | undefined
): DataQualityViewModelV2 | null {
  const m: Record<string, unknown> = metadata && typeof metadata === 'object' ? metadata : {};
  const dqRaw = m.data_quality;
  if (!dqRaw || typeof dqRaw !== 'object') return null;
  const dq = dqRaw as Record<string, unknown>;
  const levelRaw = dq.level;
  const level = typeof levelRaw === 'string' && DATA_QUALITY_LABEL[levelRaw] ? levelRaw : 'unknown';
  const critRaw = Array.isArray(dq.missing_critical) ? dq.missing_critical : [];
  const missing_critical = critRaw
    .map(s => (typeof s === 'string' ? s.trim() : ''))
    .filter(s => s.length > 0);
  const optRaw = Array.isArray(dq.missing_optional) ? dq.missing_optional : [];
  const missing_optional = optRaw
    .map(s => (typeof s === 'string' ? s.trim() : ''))
    .filter(s => s.length > 0);
  const coefRaw = dq.coefficient;
  const coefficient =
    typeof coefRaw === 'number' && Number.isFinite(coefRaw) ? Math.max(0, Math.min(1, coefRaw)) : 1;
  return {
    level,
    level_label: DATA_QUALITY_LABEL[level] || '未知',
    level_color: DATA_QUALITY_COLOR[level] || 'default',
    missing_critical,
    missing_optional,
    coefficient,
  };
}

// ===========================================================================
// 主入口 — buildV2ViewModel
// ===========================================================================

/** v2 整体视图模型 — 喂 v2 modal layout */
export interface V2ViewModel {
  /** 8 dim per analyzer view model — 顺序按 ANALYZER_KEYS_V2 (跨页面一致) */
  dimensions: AnalyzerDimensionViewModelV2[];
  /** 行动计划 */
  action_plan: ActionPlanViewModelV2;
  /** 数据质量 (可能 null 如果 metadata 没带) */
  data_quality: DataQualityViewModelV2 | null;
  /** overall confidence [0, 100] — UI 直接渲染 */
  overall_confidence: number | null;
  /** engine variant — 用于 footer 显示 */
  engine_variant: string;
  /**
   * Batch AW (2026-06-22): TradingAgents 5 段研报式叙事 (可选).
   * 引擎决策是量化, narrative 是叙述, 两者互补.
   * null = TA 调用失败或 timeout, UI 隐藏整段不报错.
   */
  tradingagents_narrative: {
    fundamental?: string;
    technical?: string;
    capital?: string;
    news?: string;
    sentiment?: string;
    raw_text?: string;
    generated_at?: string;
  } | null;
}

/**
 * 判定 result 是否走 v2 layout. true → caller 调 buildV2ViewModel(result),
 * false → caller 继续走 v1 (legacy 5 dim).
 *
 * 触发条件 (任一满足):
 *   - metadata.engine_variant === 'multi_dim_v1'
 *   - metadata.per_dimension 是非空数组 (hard mode / shadow archive 都写)
 *   - metadata.hard_short_circuit === true (hard 短路兜底标记)
 */
export function isV2Result(result: AnalyzeSingleStockResult | null | undefined): boolean {
  if (!result || !result.metadata) return false;
  const m = result.metadata as Record<string, unknown>;
  if (m.engine_variant === 'multi_dim_v1') return true;
  if (m.hard_short_circuit === true) return true;
  if (Array.isArray(m.per_dimension) && m.per_dimension.length > 0) return true;
  return false;
}

/**
 * 主入口 — 把 AnalyzeSingleStockResult 拆成 V2ViewModel.
 * result 不是 v2 形态返 null (caller 走 v1).
 */
export function buildV2ViewModel(
  result: AnalyzeSingleStockResult | null | undefined
): V2ViewModel | null {
  if (!isV2Result(result)) return null;
  const r = result as AnalyzeSingleStockResult;
  const m = (r.metadata || {}) as Record<string, unknown>;
  const perDimRaw = Array.isArray(m.per_dimension) ? m.per_dimension : [];
  // 8 dim 顺序固定 — 按 ANALYZER_KEYS_V2 排, 缺失的 analyzer 也建占位 (data_missing=['整个 dim 未跑'])
  const byKey = new Map<AnalyzerKeyV2, AnalyzerDimensionViewModelV2>();
  for (const item of perDimRaw) {
    const vm = buildAnalyzerDimensionViewModelV2(item);
    if (vm) byKey.set(vm.key, vm);
  }
  const dimensions: AnalyzerDimensionViewModelV2[] = ANALYZER_KEYS_V2.map(k => {
    const existing = byKey.get(k);
    if (existing) return existing;
    return {
      key: k,
      label: ANALYZER_LABELS_V2[k],
      hint: ANALYZER_HINTS_V2[k],
      score: null,
      bar_value: 50,
      color: '#bfbfbf',
      confidence: null,
      confidence_color: '#bfbfbf',
      data_missing: ['analyzer 未执行'],
      error: null,
      evidence: [],
      failed: false,
    };
  });
  const action_plan = buildActionPlanViewModelV2(m);
  const data_quality = buildDataQualityViewModelV2(m);
  const overallRaw = m.overall_confidence;
  let overall_confidence: number | null = null;
  if (typeof overallRaw === 'number' && Number.isFinite(overallRaw)) {
    // overall_confidence 是 [0,1], UI 显示 0-100
    overall_confidence = Math.round(Math.max(0, Math.min(1, overallRaw)) * 100);
  } else if (typeof r.confidence_score === 'number' && Number.isFinite(r.confidence_score)) {
    // 兜底: 走顶层 confidence_score (已经是 0-100 整数)
    overall_confidence = Math.max(0, Math.min(100, Math.round(r.confidence_score)));
  }
  const engine_variant = typeof m.engine_variant === 'string' ? m.engine_variant : 'multi_dim_v1';
  // Batch AW (2026-06-22): 拼装 TradingAgents 5 段叙事 (来自 metadata.tradingagents_narrative)
  const naRaw = m.tradingagents_narrative;
  let tradingagents_narrative: V2ViewModel['tradingagents_narrative'] = null;
  if (naRaw && typeof naRaw === 'object') {
    const na = naRaw as Record<string, unknown>;
    const pick = (k: string) => (typeof na[k] === 'string' ? (na[k] as string) : undefined);
    const hasAny = ['fundamental', 'technical', 'capital', 'news', 'sentiment', 'raw_text'].some(
      k => typeof na[k] === 'string' && (na[k] as string).length > 0
    );
    if (hasAny) {
      tradingagents_narrative = {
        fundamental: pick('fundamental'),
        technical: pick('technical'),
        capital: pick('capital'),
        news: pick('news'),
        sentiment: pick('sentiment'),
        raw_text: pick('raw_text'),
        generated_at: pick('generated_at'),
      };
    }
  }
  return {
    dimensions,
    action_plan,
    data_quality,
    overall_confidence,
    engine_variant,
    tradingagents_narrative,
  };
}
