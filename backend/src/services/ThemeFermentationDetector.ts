/**
 * ThemeFermentationDetector — PR-O5 (2026-06-30)
 *
 * 题材发酵 5 阶段 detector. 把每个板块按"萌芽 / 启动 / 爆发 / 高潮 / 退潮"分类,
 * 给推荐 service 用 — 学术 + 大 V 共识 (PR-I-v2 §6.4 板块/题材轮动战法):
 *
 *  🌱 germinate (萌芽) — 1-3 只票轻微异动, 涨幅 < +2%, 无涨停; 信号弱不推
 *  🚀 launch    (启动) — 首只涨停, 涨停数 1-3 板块涨幅 +2~5%; 推次龙头 + 跟风 (T+1)
 *  🔥 outbreak  (爆发) — 涨停数 5+, 连板 ≥ 2, 涨幅 +5~10%; 推中军 + 龙头接力 (T+0/T+1)
 *  💥 climax    (高潮) — 涨停数 10+, 连板 ≥ 4, 涨幅 +10%+; **不推 (顶部博弈), 持仓 reduce**
 *  📉 recession (退潮) — 涨停数 < 5 且 (炸板率 > 50% 或 较昨日 lim_up 减半); 推主线切换
 *
 * **数据来源**:
 *   - industry_sentiment_indices (PR-M3 — 每日 16:00 写完)
 *   - 同表昨日行 (用于 phase_changed_from + recession 判定 + 主线切换检测)
 *
 * **本服务**: 每日 16:30 (工作日) cron 跑一次:
 *   1. 拉今日 + 昨日 industry_sentiment_indices
 *   2. per industry classifyPhase(today, yesterday) → 'germinate' | ... | 'recession'
 *   3. detectMainlineSwitch(today, yesterday) → mainline_switch_event[]
 *   4. upsert 写 theme_fermentation_phases (一行一行业)
 *
 * **fail-OPEN 原则** (3 层):
 *   - 整次 runOnce 永不 throw → 失败返 { ok: false, errors: [...] }
 *   - 单 industry 失败不阻塞其它 → log warn + 计入 errors
 *   - 昨日数据缺失 → recession 判定退化 (只看炸板率), phase_changed_from = null
 *
 * **不写 RiskAlert / AIInvestmentSignal**:
 *   - 与 PR-M3 / PR-M4 一致 — soft decision layer, 由推荐 service consume 本表后决定加权 / skip
 *   - climax 阶段也仅写本表 (推荐 service 看到 phase='climax' 自行 skip 或 reduce)
 *   - 这避免本 service 跟 alert dispatcher 强耦合; 未来真要推送 (climax → 持仓减仓建议)
 *     可在 enrichSignal / RecommendationLoopPolicy / dedicated UI 中 derive.
 *
 * **PHASE_THRESHOLDS 全 export 可调** — 后续 settings.json 可覆盖 (本 PR 不实现).
 */

import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FermentationPhase = 'germinate' | 'launch' | 'outbreak' | 'climax' | 'recession';

export const FERMENTATION_PHASES: readonly FermentationPhase[] = Object.freeze([
  'germinate',
  'launch',
  'outbreak',
  'climax',
  'recession',
]);

export const FERMENTATION_PHASE_LABELS: Record<FermentationPhase, string> = Object.freeze({
  germinate: '萌芽',
  launch: '启动',
  outbreak: '爆发',
  climax: '高潮',
  recession: '退潮',
}) as Record<FermentationPhase, string>;

export const FERMENTATION_PHASE_ICONS: Record<FermentationPhase, string> = Object.freeze({
  germinate: '🌱',
  launch: '🚀',
  outbreak: '🔥',
  climax: '💥',
  recession: '📉',
}) as Record<FermentationPhase, string>;

/** PR-M3 industry_sentiment_indices 一行的精简视图 (本 service 消费的字段). */
export interface IndustrySentimentSnapshot {
  trade_date: string;
  industry: string;
  lim_up_count: number;
  consecutive_max: number;
  /** 封板率 [0,1] */
  seal_rate: number;
  /** 炸板率 [0,1] */
  lim_up_failure_rate: number;
  /** 30 日动量 z-score (相对全市场); null = 数据不足 */
  industry_momentum_30d: number | null;
  /** composite_score [-5, +5] */
  composite_score: number;
  /** 前 3 只涨停代表股 (按连板从高到低) */
  top_codes: string[];
}

/** classifyPhase 输出 — 阶段 + 派生判定字段, 全 export 给单测 / debug. */
export interface PhaseClassification {
  phase: FermentationPhase;
  /** 判定时用到的关键 stat (raw_payload 透传) */
  decision_inputs: {
    lim_up_count: number;
    consecutive_max: number;
    seal_rate: number;
    lim_up_failure_rate: number;
    composite_score: number;
    yesterday_lim_up_count: number | null;
    yesterday_phase: FermentationPhase | null;
  };
}

/** 主线切换事件: 昨日某主线退潮, 今日新主线启动 / 爆发. */
export interface MainlineSwitchEvent {
  /** 老主线 (昨日 outbreak/climax 今日 recession 或显著回落) */
  old_industry: string;
  old_industry_yesterday_phase: FermentationPhase;
  old_industry_today_phase: FermentationPhase;
  /** 新主线 (今日 launch/outbreak, 昨日 germinate/无数据) */
  new_industry: string;
  new_industry_yesterday_phase: FermentationPhase | null;
  new_industry_today_phase: FermentationPhase;
  /** 新主线 top_codes 前 3 (给推荐 service 用) */
  new_industry_top_codes: string[];
}

/** detectorResult.runOnce 落库 / 返回的一行 record. */
export interface ThemeFermentationRecord {
  trade_date: string;
  industry: string;
  phase: FermentationPhase;
  lim_up_count: number;
  consecutive_max: number;
  lim_up_failure_rate: number | null;
  composite_heat: number | null;
  momentum_30d_z: number | null;
  phase_changed_from: FermentationPhase | null;
  is_mainline: boolean;
  top_codes: string[];
  raw_payload: Record<string, any>;
}

export interface DetectorRunOptions {
  /** 测试 — 覆盖 now / tradeDate 决策 */
  now?: Date;
  /** 测试 — 显式指定 tradeDate (跳过 now 自动推算) */
  trade_date?: string;
  /** 测试 / CLI — 不写库 */
  dry_run?: boolean;
}

export interface DetectorRunResult {
  ok: boolean;
  trade_date: string;
  industries_scanned: number;
  industries_written: number;
  phase_distribution: Record<FermentationPhase, number>;
  mainline_switch_events: MainlineSwitchEvent[];
  errors: Array<{ where: string; reason: string }>;
}

export interface ThemeFermentationDataSource {
  /** 拉指定日期 industry_sentiment_indices 全表 (一行 = 一行业) */
  listSentimentByDate(tradeDate: string): Promise<IndustrySentimentSnapshot[]>;
  /** 拉昨日 (上一交易日) theme_fermentation_phases — 用于 phase_changed_from + recession 判定 */
  listPreviousPhases(beforeTradeDate: string): Promise<
    Array<{ industry: string; phase: FermentationPhase; lim_up_count: number }>
  >;
  /** upsert 一行 theme_fermentation_phases */
  upsertPhase(rec: ThemeFermentationRecord): Promise<void>;
}

// ---------------------------------------------------------------------------
// PHASE_THRESHOLDS — 全 export, 后续可调
// ---------------------------------------------------------------------------

/**
 * 5 阶段判定阈值. 全部 export, 测试 / settings 可覆盖.
 *
 * **顺序很重要** (classifyPhase 内按 climax → outbreak → launch → recession → germinate 顺序判断,
 * 命中一个就返回, 避免 climax 票被判成 outbreak).
 *
 * recession 判定 (双触发任一):
 *   1. 今日 lim_up_count < recession_lim_up_max AND 今日 lim_up_failure_rate > recession_failure_rate_min
 *   2. 今日 lim_up_count < recession_lim_up_max AND
 *      昨日 lim_up_count >= recession_yesterday_lim_up_min AND
 *      今日 lim_up_count < 昨日 * recession_decay_ratio (即"较昨日减半")
 *
 * climax 判定 (双触发都满足):
 *   - 今日 lim_up_count >= climax_lim_up_min
 *   - 今日 consecutive_max >= climax_consecutive_min
 *
 * outbreak 判定:
 *   - 今日 lim_up_count ∈ [outbreak_lim_up_min, climax_lim_up_min)
 *   - 且 (今日 consecutive_max >= outbreak_consecutive_min OR composite_score > outbreak_composite_min)
 *
 * launch 判定:
 *   - 今日 lim_up_count ∈ [launch_lim_up_min, outbreak_lim_up_min)
 *
 * germinate 兜底:
 *   - lim_up_count = 0 都归 germinate (无涨停 = 信号弱)
 */
export const PHASE_THRESHOLDS = Object.freeze({
  // climax: 高潮顶部博弈区
  climax_lim_up_min: 10,
  climax_consecutive_min: 4,

  // outbreak: 爆发, 推中军 + 龙头接力
  outbreak_lim_up_min: 5,
  outbreak_consecutive_min: 2,
  outbreak_composite_min: 2.5,

  // launch: 启动, 推次龙头 + 跟风
  launch_lim_up_min: 1,

  // recession: 退潮, 推主线切换
  recession_lim_up_max: 5,
  recession_failure_rate_min: 0.5,
  recession_yesterday_lim_up_min: 5,
  /** 今日 / 昨日 < 此比例视为"明显回落"(0.5 = 减半) */
  recession_decay_ratio: 0.5,

  // mainline: 当日 composite_score top-3 板块 (且 phase ∈ {launch, outbreak, climax})
  mainline_top_n: 3,
});

// ---------------------------------------------------------------------------
// Pure helpers — 全 export 单测
// ---------------------------------------------------------------------------

/** 安全 number 转换, 失败 → 0 */
export function safeNum(v: any, fallback = 0): number {
  if (v === null || v === undefined) return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 给定一行业的今日 sentiment + 昨日的 (lim_up_count + phase), 判定相位.
 * 纯函数 — 不依赖 DataSource. 全 export 给单测.
 */
export function classifyPhase(
  today: Pick<
    IndustrySentimentSnapshot,
    'lim_up_count' | 'consecutive_max' | 'seal_rate' | 'lim_up_failure_rate' | 'composite_score'
  >,
  yesterday?: { lim_up_count: number | null; phase: FermentationPhase | null } | null
): PhaseClassification {
  const limUp = safeNum(today.lim_up_count);
  const consMax = safeNum(today.consecutive_max);
  const seal = safeNum(today.seal_rate);
  const fail = safeNum(today.lim_up_failure_rate);
  const comp = safeNum(today.composite_score);
  const yLimUp = yesterday && yesterday.lim_up_count !== null ? safeNum(yesterday.lim_up_count) : null;
  const yPhase = yesterday && yesterday.phase ? yesterday.phase : null;

  const inputs = {
    lim_up_count: limUp,
    consecutive_max: consMax,
    seal_rate: seal,
    lim_up_failure_rate: fail,
    composite_score: comp,
    yesterday_lim_up_count: yLimUp,
    yesterday_phase: yPhase,
  };

  // -- climax 优先 (顶部博弈区) --
  if (
    limUp >= PHASE_THRESHOLDS.climax_lim_up_min &&
    consMax >= PHASE_THRESHOLDS.climax_consecutive_min
  ) {
    return { phase: 'climax', decision_inputs: inputs };
  }

  // -- recession 第二优先 (退潮 — 需要在 outbreak 之前判断, 否则今日"涨停 6 只但炸板 60%"
  //    会被误判 outbreak; 实际是退潮已经开始的板块) --
  //    触发 1: 今日 lim_up 少 + 高炸板率
  //    触发 2: 今日 lim_up 少 + 较昨日明显回落
  if (limUp < PHASE_THRESHOLDS.recession_lim_up_max) {
    if (fail > PHASE_THRESHOLDS.recession_failure_rate_min && limUp > 0) {
      return { phase: 'recession', decision_inputs: inputs };
    }
    if (
      yLimUp !== null &&
      yLimUp >= PHASE_THRESHOLDS.recession_yesterday_lim_up_min &&
      limUp < yLimUp * PHASE_THRESHOLDS.recession_decay_ratio
    ) {
      return { phase: 'recession', decision_inputs: inputs };
    }
  }

  // -- outbreak (爆发) --
  if (limUp >= PHASE_THRESHOLDS.outbreak_lim_up_min) {
    if (
      consMax >= PHASE_THRESHOLDS.outbreak_consecutive_min ||
      comp >= PHASE_THRESHOLDS.outbreak_composite_min
    ) {
      return { phase: 'outbreak', decision_inputs: inputs };
    }
    // 涨停数够但 cons + comp 都不够 → 仍归 launch (基础启动)
    return { phase: 'launch', decision_inputs: inputs };
  }

  // -- launch (启动) --
  if (limUp >= PHASE_THRESHOLDS.launch_lim_up_min) {
    return { phase: 'launch', decision_inputs: inputs };
  }

  // -- germinate 兜底 (无涨停) --
  return { phase: 'germinate', decision_inputs: inputs };
}

/**
 * 给定今日 + 昨日的所有 (industry, phase) 数据, 找出主线切换事件.
 * 主线 = 当日 composite_score top-N 板块 (默认 3).
 *
 * 切换条件: 昨日是主线 (outbreak/climax) 今日跌入 recession/germinate, 同时今日新主线 launch/outbreak.
 * 输出 cross-product 配对, caller 可直接落 raw_payload.
 *
 * **空昨日 (第一日 / 数据缺失) → 返空数组**, 不报错.
 */
export function detectMainlineSwitch(
  todaySentiments: IndustrySentimentSnapshot[],
  todayClassifications: Map<string, FermentationPhase>,
  yesterdayPhases: Map<string, FermentationPhase>
): MainlineSwitchEvent[] {
  if (!todaySentiments || todaySentiments.length === 0) return [];
  if (!yesterdayPhases || yesterdayPhases.size === 0) return [];

  const events: MainlineSwitchEvent[] = [];

  // 1. 找退潮的老主线 = 昨日 outbreak/climax, 今日 recession 或 germinate
  const oldMainlines: Array<{ industry: string; yPhase: FermentationPhase; tPhase: FermentationPhase }> = [];
  for (const [industry, yPhase] of yesterdayPhases) {
    if (yPhase !== 'outbreak' && yPhase !== 'climax') continue;
    const tPhase = todayClassifications.get(industry);
    if (!tPhase) continue;
    if (tPhase === 'recession' || tPhase === 'germinate') {
      oldMainlines.push({ industry, yPhase, tPhase });
    }
  }
  if (oldMainlines.length === 0) return [];

  // 2. 找新主线 = 今日 launch/outbreak, 昨日 germinate (或没记录).
  //    用 composite_score 排序取 top mainline_top_n.
  const todayByIndustry = new Map<string, IndustrySentimentSnapshot>();
  for (const s of todaySentiments) {
    if (!s.industry) continue;
    todayByIndustry.set(s.industry, s);
  }
  const newMainlineCandidates = todaySentiments
    .filter(s => {
      const p = todayClassifications.get(s.industry);
      if (p !== 'launch' && p !== 'outbreak') return false;
      const yPhase = yesterdayPhases.get(s.industry);
      // 昨日无记录, 或昨日是 germinate/recession 才算 "新崛起"; 昨日已经 launch/outbreak/climax 不算新主线
      if (yPhase === 'launch' || yPhase === 'outbreak' || yPhase === 'climax') return false;
      return true;
    })
    .sort((a, b) => safeNum(b.composite_score) - safeNum(a.composite_score))
    .slice(0, PHASE_THRESHOLDS.mainline_top_n);

  if (newMainlineCandidates.length === 0) return [];

  // 3. cross-product 配对 (老主线 × 新主线候选)
  for (const old of oldMainlines) {
    for (const ns of newMainlineCandidates) {
      events.push({
        old_industry: old.industry,
        old_industry_yesterday_phase: old.yPhase,
        old_industry_today_phase: old.tPhase,
        new_industry: ns.industry,
        new_industry_yesterday_phase: yesterdayPhases.get(ns.industry) ?? null,
        new_industry_today_phase: todayClassifications.get(ns.industry) as FermentationPhase,
        new_industry_top_codes: Array.isArray(ns.top_codes) ? ns.top_codes : [],
      });
    }
  }

  return events;
}

/**
 * 给一组今日 sentiments, 按 composite_score 降序排序后取 top-N.
 * 用于 is_mainline 标记 (主线判定 = top-N + phase ∈ launch/outbreak/climax).
 */
export function rankIndustriesByHeat(
  sentiments: IndustrySentimentSnapshot[],
  n: number = PHASE_THRESHOLDS.mainline_top_n
): IndustrySentimentSnapshot[] {
  return (sentiments || [])
    .slice()
    .sort((a, b) => safeNum(b.composite_score) - safeNum(a.composite_score))
    .slice(0, Math.max(0, n));
}

// ---------------------------------------------------------------------------
// Production DataSource (lazy require — 避免顶部 import 重模型)
// ---------------------------------------------------------------------------

class DefaultThemeFermentationDataSource implements ThemeFermentationDataSource {
  async listSentimentByDate(tradeDate: string): Promise<IndustrySentimentSnapshot[]> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { IndustrySentimentIndex } = require('../models/IndustrySentimentIndex');
      const rows: any[] = await IndustrySentimentIndex.findAll({
        attributes: [
          'trade_date',
          'industry',
          'lim_up_count',
          'consecutive_max',
          'seal_rate',
          'lim_up_failure_rate',
          'industry_momentum_30d',
          'composite_score',
          'top_codes',
        ],
        where: { trade_date: tradeDate },
        raw: true,
      });
      return (rows || []).map((r: any) => ({
        trade_date: typeof r.trade_date === 'string' ? r.trade_date : new Date(r.trade_date).toISOString().slice(0, 10),
        industry: String(r.industry || ''),
        lim_up_count: safeNum(r.lim_up_count),
        consecutive_max: safeNum(r.consecutive_max),
        seal_rate: safeNum(r.seal_rate),
        lim_up_failure_rate: safeNum(r.lim_up_failure_rate),
        industry_momentum_30d: r.industry_momentum_30d == null ? null : safeNum(r.industry_momentum_30d),
        composite_score: safeNum(r.composite_score),
        top_codes: Array.isArray(r.top_codes) ? r.top_codes.map((x: any) => String(x)) : [],
      }));
    } catch (e: any) {
      logger.warn(`[ThemeFermentationDetector] listSentimentByDate failed: ${e?.message || e}`);
      return [];
    }
  }

  async listPreviousPhases(beforeTradeDate: string): Promise<
    Array<{ industry: string; phase: FermentationPhase; lim_up_count: number }>
  > {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const sequelizeModule = require('../config/database');
      const sequelize = sequelizeModule.default || sequelizeModule.sequelize;
      // 取最近一个 < beforeTradeDate 的 trade_date 全部行
      const sql = `
        WITH last_date AS (
          SELECT MAX(trade_date) AS d FROM theme_fermentation_phases WHERE trade_date < :beforeDate
        )
        SELECT tfp.industry, tfp.phase, tfp.lim_up_count
        FROM theme_fermentation_phases tfp
        JOIN last_date ld ON tfp.trade_date = ld.d
        WHERE ld.d IS NOT NULL;
      `;
      const [rows] = await sequelize.query(sql, { replacements: { beforeDate: beforeTradeDate } });
      return ((rows as any[]) || []).map((r: any) => ({
        industry: String(r.industry || ''),
        phase: String(r.phase || 'germinate') as FermentationPhase,
        lim_up_count: safeNum(r.lim_up_count),
      }));
    } catch (e: any) {
      logger.warn(`[ThemeFermentationDetector] listPreviousPhases failed: ${e?.message || e}`);
      return [];
    }
  }

  async upsertPhase(rec: ThemeFermentationRecord): Promise<void> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { ThemeFermentationPhase } = require('../models/ThemeFermentationPhase');
      await ThemeFermentationPhase.upsert({
        trade_date: rec.trade_date,
        industry: rec.industry,
        phase: rec.phase,
        lim_up_count: rec.lim_up_count,
        consecutive_max: rec.consecutive_max,
        lim_up_failure_rate: rec.lim_up_failure_rate,
        composite_heat: rec.composite_heat,
        momentum_30d_z: rec.momentum_30d_z,
        phase_changed_from: rec.phase_changed_from,
        is_mainline: rec.is_mainline,
        top_codes: rec.top_codes,
        raw_payload: rec.raw_payload,
      });
    } catch (e: any) {
      logger.warn(
        `[ThemeFermentationDetector] upsert failed industry=${rec.industry}: ${e?.message || e}`
      );
      throw e;
    }
  }
}

export const DEFAULT_THEME_FERMENTATION_DATA_SOURCE: ThemeFermentationDataSource =
  new DefaultThemeFermentationDataSource();

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface ThemeFermentationDetectorDeps {
  dataSource?: ThemeFermentationDataSource;
}

export class ThemeFermentationDetector {
  private readonly ds: ThemeFermentationDataSource;

  constructor(deps: ThemeFermentationDetectorDeps = {}) {
    this.ds = deps.dataSource ?? DEFAULT_THEME_FERMENTATION_DATA_SOURCE;
  }

  /** 主入口. fail-OPEN — 永不 throw, 整次失败也返 ok=false + errors[]. */
  async runOnce(options: DetectorRunOptions = {}): Promise<DetectorRunResult> {
    const dryRun = options.dry_run === true;
    const tradeDate = options.trade_date || this.resolveTradeDate(options.now || new Date());

    const result: DetectorRunResult = {
      ok: true,
      trade_date: tradeDate,
      industries_scanned: 0,
      industries_written: 0,
      phase_distribution: {
        germinate: 0,
        launch: 0,
        outbreak: 0,
        climax: 0,
        recession: 0,
      },
      mainline_switch_events: [],
      errors: [],
    };

    // Step 1: 拉今日 sentiment
    let todaySent: IndustrySentimentSnapshot[] = [];
    try {
      todaySent = await this.ds.listSentimentByDate(tradeDate);
    } catch (e: any) {
      result.errors.push({ where: 'listSentimentByDate', reason: e?.message || String(e) });
      result.ok = false;
      return result;
    }

    if (!todaySent || todaySent.length === 0) {
      logger.info(
        `[ThemeFermentationDetector] trade_date=${tradeDate} no industry_sentiment_indices rows, nothing to classify`
      );
      return result;
    }
    result.industries_scanned = todaySent.length;

    // Step 2: 拉昨日 phase (用于 phase_changed_from + recession 判定)
    let yPhases = new Map<string, { phase: FermentationPhase; lim_up_count: number }>();
    try {
      const prevRows = await this.ds.listPreviousPhases(tradeDate);
      for (const r of prevRows || []) {
        yPhases.set(r.industry, { phase: r.phase, lim_up_count: r.lim_up_count });
      }
    } catch (e: any) {
      // fail-open: 昨日数据缺失不阻塞主流程
      result.errors.push({ where: 'listPreviousPhases', reason: e?.message || String(e) });
      logger.warn(
        `[ThemeFermentationDetector] listPreviousPhases failed; degrading to no-history classify: ${e?.message || e}`
      );
    }

    // Step 3: classify per industry
    const todayClassMap = new Map<string, FermentationPhase>();
    const classificationByIndustry = new Map<string, PhaseClassification>();
    for (const s of todaySent) {
      const y = yPhases.get(s.industry);
      const cls = classifyPhase(s, y ? { lim_up_count: y.lim_up_count, phase: y.phase } : null);
      todayClassMap.set(s.industry, cls.phase);
      classificationByIndustry.set(s.industry, cls);
      result.phase_distribution[cls.phase] += 1;
    }

    // Step 4: 主线切换检测 (整盘视角)
    let switchEvents: MainlineSwitchEvent[] = [];
    try {
      const yPhaseMap = new Map<string, FermentationPhase>();
      for (const [ind, v] of yPhases) yPhaseMap.set(ind, v.phase);
      switchEvents = detectMainlineSwitch(todaySent, todayClassMap, yPhaseMap);
    } catch (e: any) {
      result.errors.push({ where: 'detectMainlineSwitch', reason: e?.message || String(e) });
      logger.warn(
        `[ThemeFermentationDetector] detectMainlineSwitch failed; continuing without switch events: ${e?.message || e}`
      );
    }
    result.mainline_switch_events = switchEvents;

    // Step 5: 算 is_mainline (heat top-N 且 phase ∈ launch/outbreak/climax)
    const mainlineSet = new Set<string>();
    for (const s of rankIndustriesByHeat(todaySent, PHASE_THRESHOLDS.mainline_top_n)) {
      const p = todayClassMap.get(s.industry);
      if (p === 'launch' || p === 'outbreak' || p === 'climax') {
        mainlineSet.add(s.industry);
      }
    }

    // Step 6: upsert per industry
    // 把每个 industry 涉及的 switch events 提到 raw_payload, 避免每行存全量
    const switchByIndustry = new Map<string, MainlineSwitchEvent[]>();
    for (const ev of switchEvents) {
      const a = switchByIndustry.get(ev.old_industry) || [];
      a.push(ev);
      switchByIndustry.set(ev.old_industry, a);
      const b = switchByIndustry.get(ev.new_industry) || [];
      b.push(ev);
      switchByIndustry.set(ev.new_industry, b);
    }

    for (const s of todaySent) {
      try {
        const cls = classificationByIndustry.get(s.industry);
        if (!cls) continue;
        const y = yPhases.get(s.industry);
        const rec: ThemeFermentationRecord = {
          trade_date: tradeDate,
          industry: s.industry,
          phase: cls.phase,
          lim_up_count: s.lim_up_count,
          consecutive_max: s.consecutive_max,
          lim_up_failure_rate: s.lim_up_failure_rate,
          composite_heat: s.composite_score,
          momentum_30d_z: s.industry_momentum_30d,
          phase_changed_from: y ? y.phase : null,
          is_mainline: mainlineSet.has(s.industry),
          top_codes: s.top_codes,
          raw_payload: {
            decision_inputs: cls.decision_inputs,
            seal_rate: s.seal_rate,
            mainline_switch_events: switchByIndustry.get(s.industry) || [],
          },
        };
        if (!dryRun) {
          await this.ds.upsertPhase(rec);
        }
        result.industries_written += 1;
      } catch (e: any) {
        result.errors.push({
          where: `industry:${s.industry}`,
          reason: e?.message || String(e),
        });
        logger.warn(
          `[ThemeFermentationDetector] industry=${s.industry} failed: ${e?.message || e}`
        );
      }
    }

    if (result.errors.length > 0) result.ok = false;
    return result;
  }

  /** 给定 now (Asia/Shanghai), 取 YYYY-MM-DD. 16:30 cron 触发时 now = 当天. */
  private resolveTradeDate(now: Date): string {
    try {
      const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
      const parts = fmt.formatToParts(now);
      const y = parts.find(p => p.type === 'year')?.value;
      const m = parts.find(p => p.type === 'month')?.value;
      const d = parts.find(p => p.type === 'day')?.value;
      if (y && m && d) return `${y}-${m}-${d}`;
    } catch {
      // ignore
    }
    return now.toISOString().slice(0, 10);
  }
}

export const themeFermentationDetector = new ThemeFermentationDetector();
