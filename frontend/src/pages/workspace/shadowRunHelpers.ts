/**
 * shadowRunHelpers — LabWorkspace shadow run 区块 (US-051 / FE-012) 纯函数集合。
 *
 * 这个 tab 把 backend 已实现的 analysis-engine v1 shadow 链路结果可视化:
 *
 *   GET /api/admin/analysis-engine/shadow-stats?since=YYYY-MM-DD
 *
 * 返回结构 (后端 AnalysisEngineShadowController.getShadowStats):
 *   {
 *     since: '2026-06-12',
 *     total_shadow_reports: number,
 *     consistency_rate: {
 *       buy_class: 0-1, sell_class: 0-1, hold_class: 0-1, overall: 0-1
 *     },
 *     analyzer_health: [
 *       { key, error_rate, mean_confidence, data_missing_rate, samples }
 *     ],
 *     forward_return_5d: { samples, mean_pct, note? }
 *   }
 *
 * 业务问题: shadow 链路里多维分析引擎与生产决策的 buy/sell/hold 分类一致率多少? 哪些 analyzer
 *           error_rate 过高 / mean_confidence 过低 / data_missing_rate 异常? 让 ops 在升级
 *           shadow→hard 之前一眼看清健康度.
 *
 * 数据流向:
 *   labService.getAnalysisEngineShadowStats(since?) → buildShadowRunViewModel(stats) → UI
 *
 * 与 backend 解耦: 复用既有 endpoint, 不需要新加 API. 业务逻辑 (健康分级 / consistency 阈值
 * 判定 / "可升级 hard" 综合结论) 全部抽到本文件 pure helper, 单测在 backend/tests/services/
 * 跑 ts-node 不依赖 jsdom (与 [[quarterlyRetrainHelpers]] / [[factorAIWeightHelpers]] /
 * [[etfFlowHelpers]] 同款 frontend pure helper 范式).
 *
 * 设计取舍:
 *  - 阈值常量全部 export 便于运维调参 + 单测守 sanity (e.g. ERROR_RATE_DEGRADED < ERROR_RATE_CRITICAL).
 *  - 三态分级 (healthy / degraded / critical) 与 backend RiskAlert severity 命名风格对齐
 *    (medium / high / critical 一脉相承), 让前端 Tag color 选择有统一直觉.
 *  - "可升级 hard" 结论是 N 个条件的 AND, 任何一条不满足都 hold 并标注原因 — caller 直接渲染
 *    原因列表, 不需要二次推理.
 *  - 空数据 / null 输入一律安全返 'unknown' / 空数组, 不静默 fallback 到 'healthy' (避免空表
 *    被误读为"全绿可升级").
 */

// ===========================================================================
// 类型定义 — 与 backend AnalysisEngineShadowController response 对齐
// ===========================================================================

/** Backend `consistency_rate` 字段, 每项 0-1 (3 位小数) */
export interface ShadowConsistencyRate {
  buy_class: number;
  sell_class: number;
  hold_class: number;
  overall: number;
}

/** Backend `analyzer_health[]` 单项 */
export interface ShadowAnalyzerHealth {
  key: string;
  samples: number;
  error_rate: number; // 0-1
  mean_confidence: number; // 0-1
  data_missing_rate: number; // 0+ (per-sample 平均缺失字段数)
}

/** Backend `forward_return_5d` 字段 */
export interface ShadowForwardReturn {
  samples: number;
  mean_pct: number | null;
  note?: string;
}

/** Backend `/shadow-stats` 完整响应 */
export interface ShadowStatsResponse {
  since: string;
  total_shadow_reports: number;
  consistency_rate: ShadowConsistencyRate;
  analyzer_health: ShadowAnalyzerHealth[];
  forward_return_5d: ShadowForwardReturn;
}

// ===========================================================================
// 阈值常量 — 全 export 让运维一处调参, 单测守 sanity
// ===========================================================================

/**
 * Consistency 阈值. shadow 与生产分类的一致率应 ≥ HIGH 才视为 healthy.
 *
 * 业务依据: 多维分析引擎与生产决策在同一时点应高度对齐, 否则要么模型差异巨大 (有 alpha) 要么
 * shadow 实现有 bug. 0.85 作为可升级 hard 的最低门槛 (与 backend GAMMA 2026-06-18 shadow
 * dashboard PRD 对齐).
 */
export const CONSISTENCY_HEALTHY_MIN = 0.85;
/** Consistency degraded 阈值 — 介于此与 HEALTHY 之间为 degraded, 低于此为 critical */
export const CONSISTENCY_DEGRADED_MIN = 0.7;

/** Analyzer error_rate critical 阈值 — 任何 analyzer error_rate ≥ 此值阻止 shadow→hard 升级 */
export const ERROR_RATE_CRITICAL = 0.1; // 10%
/** Analyzer error_rate degraded 阈值 */
export const ERROR_RATE_DEGRADED = 0.05; // 5%

/** Analyzer mean_confidence 健康下限 (越低越虚) */
export const CONFIDENCE_HEALTHY_MIN = 0.6;
/** Analyzer mean_confidence degraded 下限 */
export const CONFIDENCE_DEGRADED_MIN = 0.4;

/** Analyzer data_missing_rate 健康上限 (per-sample 平均缺失字段数) */
export const DATA_MISSING_HEALTHY_MAX = 1.0;
/** Analyzer data_missing_rate degraded 上限 */
export const DATA_MISSING_DEGRADED_MAX = 3.0;

/** 升级 hard 的最小 shadow 报告样本数 — 样本太少看不出趋势 */
export const PROMOTE_HARD_MIN_SAMPLES = 50;

/** since 默认回看天数 (与后端默认一致) */
export const DEFAULT_SINCE_DAYS = 7;

// ===========================================================================
// 健康分级
// ===========================================================================

export type HealthLevel = 'healthy' | 'degraded' | 'critical' | 'unknown';

/**
 * 把 consistency overall 0-1 ratio 映射到 HealthLevel.
 * 非数 / NaN / Infinity → 'unknown' (UI 渲染 '—' 而非误判为 healthy).
 */
export function classifyConsistencyLevel(overall: number | null | undefined): HealthLevel {
  if (overall == null || !Number.isFinite(Number(overall))) return 'unknown';
  const v = Number(overall);
  if (v >= CONSISTENCY_HEALTHY_MIN) return 'healthy';
  if (v >= CONSISTENCY_DEGRADED_MIN) return 'degraded';
  return 'critical';
}

/**
 * Analyzer 单维度 (error_rate / mean_confidence / data_missing_rate) 分别打分,
 * 取最差档作为整体. samples=0 直接 unknown (避免 0 样本 mean_confidence=0 被误判 critical).
 */
export function classifyAnalyzerLevel(item: ShadowAnalyzerHealth | null | undefined): HealthLevel {
  if (!item || !Number.isFinite(item.samples) || item.samples <= 0) return 'unknown';
  let level: HealthLevel = 'healthy';
  const worsen = (next: HealthLevel) => {
    // healthy < degraded < critical
    if (level === 'critical') return; // 已是最差
    if (next === 'critical') {
      level = 'critical';
      return;
    }
    if (next === 'degraded' && level === 'healthy') level = 'degraded';
  };
  // error_rate
  if (Number.isFinite(item.error_rate)) {
    if (item.error_rate >= ERROR_RATE_CRITICAL) worsen('critical');
    else if (item.error_rate >= ERROR_RATE_DEGRADED) worsen('degraded');
  }
  // mean_confidence (越低越差)
  if (Number.isFinite(item.mean_confidence)) {
    if (item.mean_confidence < CONFIDENCE_DEGRADED_MIN) worsen('critical');
    else if (item.mean_confidence < CONFIDENCE_HEALTHY_MIN) worsen('degraded');
  }
  // data_missing_rate (越高越差)
  if (Number.isFinite(item.data_missing_rate)) {
    if (item.data_missing_rate > DATA_MISSING_DEGRADED_MAX) worsen('critical');
    else if (item.data_missing_rate > DATA_MISSING_HEALTHY_MAX) worsen('degraded');
  }
  return level;
}

/**
 * Tag 颜色映射 (与 antd Tag color token 对齐), 顺手暴露给 UI 直接用.
 */
export const HEALTH_LEVEL_COLOR: Readonly<Record<HealthLevel, string>> = Object.freeze({
  healthy: 'green',
  degraded: 'gold',
  critical: 'red',
  unknown: 'default',
});

/** UI 友好标签 */
export const HEALTH_LEVEL_LABEL: Readonly<Record<HealthLevel, string>> = Object.freeze({
  healthy: '健康',
  degraded: '降级',
  critical: '严重',
  unknown: '—',
});

// ===========================================================================
// "可升级 hard" 综合结论
// ===========================================================================

export interface ShadowPromotionReadiness {
  /** 综合结论 */
  ready: boolean;
  /** 任意未满足的原因 — caller 直接渲染列表; 满足时为空数组 */
  blockers: string[];
  /** 用于 UI 颜色: 'critical' → ready=false 有严重阻断; 'degraded' → ready=false 仅有 degraded; 'healthy' → ready=true */
  level: HealthLevel;
}

/**
 * 综合判断 shadow → hard 是否就绪. AND 5 条:
 *   1. total_shadow_reports >= PROMOTE_HARD_MIN_SAMPLES (样本足够)
 *   2. consistency.overall >= CONSISTENCY_HEALTHY_MIN (与生产决策足够一致)
 *   3. consistency.buy_class >= CONSISTENCY_DEGRADED_MIN (买入侧最敏感, 单独把关)
 *   4. consistency.sell_class >= CONSISTENCY_DEGRADED_MIN (卖出侧)
 *   5. 不存在任何 analyzer level=critical (任何一维 critical 都立刻 block)
 *
 * 任一不满足返 ready=false + 原因列入 blockers. ops 一眼看完原因再决策.
 */
export function evaluateShadowPromotionReadiness(
  stats: ShadowStatsResponse | null | undefined
): ShadowPromotionReadiness {
  if (!stats) {
    return {
      ready: false,
      blockers: ['尚未拉取到 shadow 统计数据'],
      level: 'unknown',
    };
  }
  const blockers: string[] = [];
  let hasCritical = false;

  // 1. 样本量
  if (
    !Number.isFinite(stats.total_shadow_reports) ||
    stats.total_shadow_reports < PROMOTE_HARD_MIN_SAMPLES
  ) {
    blockers.push(
      `shadow 报告样本量 ${stats.total_shadow_reports} < 升级门槛 ${PROMOTE_HARD_MIN_SAMPLES}`
    );
  }

  // 2. overall consistency
  const cr = stats.consistency_rate;
  if (cr && Number.isFinite(cr.overall) && cr.overall < CONSISTENCY_HEALTHY_MIN) {
    blockers.push(
      `整体一致率 ${formatPercent(cr.overall)} < 升级门槛 ${formatPercent(CONSISTENCY_HEALTHY_MIN)}`
    );
    if (cr.overall < CONSISTENCY_DEGRADED_MIN) hasCritical = true;
  }

  // 3 / 4. buy / sell consistency
  if (cr) {
    if (Number.isFinite(cr.buy_class) && cr.buy_class < CONSISTENCY_DEGRADED_MIN) {
      blockers.push(
        `买入侧一致率 ${formatPercent(cr.buy_class)} < 最低门槛 ${formatPercent(
          CONSISTENCY_DEGRADED_MIN
        )}`
      );
      hasCritical = true;
    }
    if (Number.isFinite(cr.sell_class) && cr.sell_class < CONSISTENCY_DEGRADED_MIN) {
      blockers.push(
        `卖出侧一致率 ${formatPercent(cr.sell_class)} < 最低门槛 ${formatPercent(
          CONSISTENCY_DEGRADED_MIN
        )}`
      );
      hasCritical = true;
    }
  }

  // 5. analyzer critical
  const criticalAnalyzers = (stats.analyzer_health || []).filter(
    a => classifyAnalyzerLevel(a) === 'critical'
  );
  if (criticalAnalyzers.length > 0) {
    blockers.push(`analyzer 严重: ${criticalAnalyzers.map(a => a.key).join(', ')}`);
    hasCritical = true;
  }

  const ready = blockers.length === 0;
  let level: HealthLevel = 'healthy';
  if (!ready) level = hasCritical ? 'critical' : 'degraded';
  return { ready, blockers, level };
}

// ===========================================================================
// 主入口: build view model
// ===========================================================================

export interface ShadowAnalyzerRow extends ShadowAnalyzerHealth {
  level: HealthLevel;
}

export interface ShadowRunViewModel {
  /** 透传 since 字符串 (YYYY-MM-DD) */
  since: string;
  /** 总 shadow 报告数 */
  totalShadowReports: number;
  /** consistency 综合分级 */
  consistencyLevel: HealthLevel;
  /** 透传 consistency_rate */
  consistency: ShadowConsistencyRate;
  /** 每个 analyzer 加上 level 字段, 按 level (critical→degraded→healthy→unknown) + key 排序 */
  analyzers: ShadowAnalyzerRow[];
  /** forward return summary */
  forwardReturn: ShadowForwardReturn;
  /** 升级 hard 就绪综合结论 */
  promotion: ShadowPromotionReadiness;
}

/** Analyzer 排序: critical 最前, 让最严重的一眼可见 */
const LEVEL_ORDER: Record<HealthLevel, number> = {
  critical: 0,
  degraded: 1,
  unknown: 2,
  healthy: 3,
};

/**
 * 主入口 — 给定后端 stats 输出 view model. 任何空 / 异常输入返"零数据安全态".
 * caller (LabWorkspace.ShadowRunTab) 拿到 view model 后直接 render, 无二次计算.
 */
export function buildShadowRunViewModel(
  stats: ShadowStatsResponse | null | undefined
): ShadowRunViewModel {
  const fallbackConsistency: ShadowConsistencyRate = {
    buy_class: 0,
    sell_class: 0,
    hold_class: 0,
    overall: 0,
  };
  const fallbackForward: ShadowForwardReturn = { samples: 0, mean_pct: null };
  if (!stats || typeof stats !== 'object') {
    return {
      since: '',
      totalShadowReports: 0,
      consistencyLevel: 'unknown',
      consistency: fallbackConsistency,
      analyzers: [],
      forwardReturn: fallbackForward,
      promotion: evaluateShadowPromotionReadiness(null),
    };
  }
  const consistency = stats.consistency_rate || fallbackConsistency;
  const analyzers: ShadowAnalyzerRow[] = (
    Array.isArray(stats.analyzer_health) ? stats.analyzer_health : []
  )
    .filter((a): a is ShadowAnalyzerHealth => !!a && typeof a.key === 'string' && a.key.length > 0)
    .map(a => ({ ...a, level: classifyAnalyzerLevel(a) }))
    .sort((a, b) => {
      const la = LEVEL_ORDER[a.level] ?? 99;
      const lb = LEVEL_ORDER[b.level] ?? 99;
      if (la !== lb) return la - lb;
      return a.key.localeCompare(b.key);
    });
  return {
    since: typeof stats.since === 'string' ? stats.since : '',
    totalShadowReports: Number(stats.total_shadow_reports) || 0,
    consistencyLevel: classifyConsistencyLevel(consistency?.overall),
    consistency,
    analyzers,
    forwardReturn: stats.forward_return_5d || fallbackForward,
    promotion: evaluateShadowPromotionReadiness(stats),
  };
}

// ===========================================================================
// UI 格式化 helper
// ===========================================================================

/** 0-1 ratio → '85.0%'; null/NaN → '—' */
export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return `${(Number(value) * 100).toFixed(digits)}%`;
}

/**
 * 把 'now - N 天' 转 'YYYY-MM-DD' (UTC). caller 默认请求当前 - DEFAULT_SINCE_DAYS 的 since.
 * UTC 而非本地是因为后端拿 since=YYYY-MM-DD 当 ISO-UTC 解析 (controller 第 37 行 `new Date(\`${sinceStr}T00:00:00.000Z\`)`).
 */
export function formatSinceDate(now: Date, daysAgo: number = DEFAULT_SINCE_DAYS): string {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return '';
  // daysAgo<1 (含 0/负数) 一律 clamp 到 1; > 365 clamp 到 365 防 since 太远把 backend 拖死;
  // 非数 / NaN 用默认值.
  const raw = Number.isFinite(daysAgo) ? Math.floor(Number(daysAgo)) : DEFAULT_SINCE_DAYS;
  const clamped = Math.max(1, Math.min(365, raw < 1 ? 1 : raw));
  const d = new Date(now.getTime() - clamped * 24 * 3600 * 1000);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
