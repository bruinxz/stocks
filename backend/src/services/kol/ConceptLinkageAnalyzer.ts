/**
 * ConceptLinkageAnalyzer — US-141 KOL-008 同板块联动分析.
 *
 * 把 `kol_opinions` 表中 `kol_source='xq_hot_concept'` 的 (stock_code, concept_name)
 * 关系当作"概念板块成员表", JOIN DailyBar 取最近一日成员股的日内涨跌, 算每个
 * 概念的:
 *   - 平均日收益 (avg_return_pct);
 *   - 收益方差 (std_dev_pct);
 *   - 方向一致度 (directional_cohesion = 与均值同向的成员占比, ∈ [0,1]);
 *   - 联动分 (linkage_score = directional_cohesion, AC §"输出"事实源).
 *
 * 用途: 量化操盘手发现"今天哪些概念真正在联动" — 当某概念成员股有 ≥ N 只 +
 * 同向占比 ≥ 70%, 即视为"板块联动确认", 可作为 NewsAnalyzer / 主题轮动策略
 * 的辅助信号 (本 story 仅产分析层, 接入由未来 KOL-011 / 因子层 story 落地).
 *
 * **核心契约**:
 *   - analyzeLinkages({as_of_date?, lookback_days?, min_members_per_concept?,
 *     dry_run?}): 返 `AnalyzeLinkagesResult` 含 ConceptLinkageStatRecord[]
 *     (排序: linkage_score desc + sample_size desc + concept_name asc);
 *   - identifyStrongLinkages(stats, {min_samples, min_score, limit?}): pure helper
 *     接 stats 数组返过滤后按 linkage_score desc 排序的 ConceptLinkageStatRecord[]
 *     (AC §"输出" 主验收事实源);
 *   - 全部 pure helpers export (computeDailyReturn / computeReturnStats /
 *     computeDirectionalCohesion / computeConceptLinkageStat /
 *     identifyStrongLinkages) 便于单测.
 *
 * **fail-OPEN 契约** (与 [[KOLAuthorTrackingService]] 同款):
 *   - DataSource 失败 → analyzeLinkages 返 status='failed' + error, 不抛;
 *   - 单 concept 数据缺失 / 成员不足 → 跳过该 concept, 不影响其它;
 *   - 计算 daily return 时单股缺数据 → 跳过该成员, 不影响 concept 整体.
 *   - 与 risk guard fail-CLOSED 对偶 — 本 service 是分析/可视化层, DB 故障不应
 *     阻塞主流程.
 *
 * **DataSource DI** (与 [[KOLAggregatorService]] / [[KOLAuthorTrackingService]] 同款):
 *   - `ConceptLinkageDataSource` interface (2 方法: loadConceptMembers /
 *     loadDailyBarsForStocks);
 *   - `DefaultConceptLinkageDataSource` 实现 lazy require KOLOpinion + DailyBar +
 *     Stock 模型;
 *   - 单测注入 fake source 完全绕开 DB.
 *
 * 与既有相关 service 边界:
 *   - **KOLOpinion (US-056)**: 数据源 — 读 kol_source='xq_hot_concept' 行, 不写;
 *   - **KOLAggregatorService**: 那边把 concept 当 "代理 KOL 观点" 写入 KOLOpinion;
 *     本 service 把同样的数据反过来按 concept 聚合算联动度, 互补不重复;
 *   - **KOLAuthorTrackingService (US-140)**: 按 firm 聚合命中率; 本 service 按
 *     concept 聚合联动度. 两者都用 `kol/` 子目录, 同款 DataSource DI 范式;
 *   - **factor 体系**: 本 service 不参与因子打分, 仅给 caller 看. 未来 KOL-011
 *     NewsAnalyzer 接入时, linkage_score 可作"主题热度真实性"权重.
 */

import { Op } from 'sequelize';
import { logger } from '../../utils/logger';

// ---------------------------------------------------------------------------
// 默认值常量
// ---------------------------------------------------------------------------

/** 默认 lookback 天数 (查找 concept 成员关系的回看窗口). */
export const DEFAULT_LINKAGE_LOOKBACK_DAYS = 7;

/** 默认每个 concept 至少需要 N 个成员才输出 (防小样本巧合). */
export const DEFAULT_MIN_MEMBERS_PER_CONCEPT = 3;

/** identifyStrongLinkages 默认 min_samples (与 analyzeLinkages min_members 对齐). */
export const DEFAULT_STRONG_LINKAGE_MIN_SAMPLES = 3;

/** identifyStrongLinkages 默认 min_score (AC: ≥70% 方向一致 ⇒ "板块联动确认"). */
export const DEFAULT_STRONG_LINKAGE_MIN_SCORE = 0.7;

/** identifyStrongLinkages 默认输出上限. */
export const DEFAULT_STRONG_LINKAGE_LIMIT = 20;

/** "市场热议·<concept>" 前缀 (与 [[KOLAggregatorService]] mapHotConceptsToOpinions 一致). */
export const HOT_CONCEPT_KOL_NAME_PREFIX = '市场热议·';

/** kol_opinions.kol_source 值 (与 [[KOLAggregatorService.KOL_SOURCES.XQ_HOT_CONCEPT]] 一致). */
export const XQ_HOT_CONCEPT_SOURCE = 'xq_hot_concept';

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/** 单条 daily bar (close + 日期), 与 [[KOLAuthorTrackingService.ForwardReturnBar]] 同款简化版. */
export interface DailyBarRow {
  /** YYYY-MM-DD */
  trade_date: string;
  close: number;
}

/** 上游一条 concept 成员关系 (subset of KOLOpinion where kol_source='xq_hot_concept') */
export interface ConceptMemberRow {
  concept_name: string;
  stock_code: string;
  /** opinion_date (YYYY-MM-DD), 用于按 lookback 窗口截取 */
  opinion_date: string;
}

/** 上游 daily bars 按 stock_code 分组的 map */
export type StockBarsMap = Map<string, DailyBarRow[]>;

/** 聚合后的单 concept linkage stat */
export interface ConceptLinkageStatRecord {
  /** 概念名 (e.g. "白酒" / "AI 芯片") */
  concept_name: string;
  /** 统计截止日 (YYYY-MM-DD) */
  as_of_date: string;
  /** 成员股数 (已过滤掉缺数据的) */
  sample_size: number;
  /** 平均日收益 (小数, 0.012 = 1.2%) */
  avg_return_pct: number | null;
  /** 收益标准差 (小数) */
  std_dev_pct: number | null;
  /** 方向一致度 ∈ [0, 1]: 与 avg 同向的成员占比; avg=0 时退化为 NaN → 返 0 */
  directional_cohesion: number;
  /** 联动分 (本版本 = directional_cohesion; 未来可扩展为 cohesion × magnitude) */
  linkage_score: number;
  /** 抽样最多 20 条成员 stock_code 放 audit payload (防 payload 爆) */
  member_stock_codes: string[];
  /** raw_payload 审计字段 */
  raw_payload: {
    member_count_total: number;
    skipped_no_bars: number;
    skipped_invalid_close: number;
    returns_distribution: Array<{ stock_code: string; return_pct: number }>;
  };
}

// ---------------------------------------------------------------------------
// Pure helpers — daily return / 统计 / 联动度
// ---------------------------------------------------------------------------

/**
 * 计算最近一日 close vs 前一日 close 的收益.
 *
 * 算法:
 *   1. bars 按 trade_date asc 排好 (caller 责任);
 *   2. 找 ≤ asOfDate 的最后一条 bar (settle), 与其前一条 (prev_settle);
 *   3. return = settle / prev_settle - 1;
 *   4. 任一端缺数据 / 无效 close → 返 null.
 *
 * 与 [[computeForwardReturn]] 对偶 — 那个是"基准 + N 天后", 这个是"当天 + 前一日".
 */
export function computeDailyReturn(bars: DailyBarRow[], asOfDate: string): number | null {
  if (!Array.isArray(bars) || bars.length < 2) return null;
  if (typeof asOfDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) return null;

  // 找 ≤ asOfDate 的最后一条 bar
  let settleIdx = -1;
  for (let i = bars.length - 1; i >= 0; i -= 1) {
    if (bars[i].trade_date <= asOfDate) {
      settleIdx = i;
      break;
    }
  }
  if (settleIdx < 1) return null; // 无可用 settle 或没有 prev_settle

  const settle = bars[settleIdx];
  const prev = bars[settleIdx - 1];
  if (!Number.isFinite(settle.close) || settle.close <= 0) return null;
  if (!Number.isFinite(prev.close) || prev.close <= 0) return null;

  return settle.close / prev.close - 1;
}

/**
 * 计算一组收益的 mean + sample stddev (Bessel's correction, n-1).
 *
 * 空数组返 {mean:null, std:null}; 单个元素返 {mean:x, std:0} (标准差未定义但 0 最安全).
 */
export function computeReturnStats(returns: number[]): {
  mean: number | null;
  std: number | null;
} {
  if (!Array.isArray(returns) || returns.length === 0) return { mean: null, std: null };
  let sum = 0;
  for (const r of returns) {
    if (!Number.isFinite(r)) return { mean: null, std: null };
    sum += r;
  }
  const mean = sum / returns.length;
  if (returns.length === 1) return { mean, std: 0 };

  let sqDiff = 0;
  for (const r of returns) sqDiff += (r - mean) * (r - mean);
  const variance = sqDiff / (returns.length - 1);
  return { mean, std: Math.sqrt(variance) };
}

/**
 * 方向一致度: 与 avg 同向的成员占比 ∈ [0, 1].
 *
 * 规则:
 *   - avg > 0: 占比 = count(r > 0) / n;
 *   - avg < 0: 占比 = count(r < 0) / n;
 *   - avg === 0: 占比 = 0 (无方向, 不算联动);
 *   - returns 为空 / avg null: 返 0.
 *
 * 注意: r === 0 不计入"同向" (不动算不上联动信号).
 */
export function computeDirectionalCohesion(returns: number[], avg: number | null): number {
  if (avg == null || !Array.isArray(returns) || returns.length === 0) return 0;
  if (avg === 0) return 0;
  let sameDir = 0;
  for (const r of returns) {
    if (avg > 0 && r > 0) sameDir += 1;
    else if (avg < 0 && r < 0) sameDir += 1;
  }
  return sameDir / returns.length;
}

/**
 * 单 concept 成员列表 + bars map → 聚合输出 1 条 stat.
 *
 * 成员股缺 bars / close 无效 → 跳过该股, 计入 skipped 但不影响 concept 整体.
 */
export function computeConceptLinkageStat(input: {
  concept_name: string;
  as_of_date: string;
  member_stock_codes: string[];
  bars_by_stock: StockBarsMap;
}): ConceptLinkageStatRecord {
  const returns: number[] = [];
  const returnsDist: Array<{ stock_code: string; return_pct: number }> = [];
  const validStocks: string[] = [];
  let skippedNoBars = 0;
  let skippedInvalidClose = 0;

  for (const code of input.member_stock_codes) {
    const bars = input.bars_by_stock.get(code);
    if (!bars || bars.length < 2) {
      skippedNoBars += 1;
      continue;
    }
    const r = computeDailyReturn(bars, input.as_of_date);
    if (r == null) {
      skippedInvalidClose += 1;
      continue;
    }
    returns.push(r);
    validStocks.push(code);
    returnsDist.push({ stock_code: code, return_pct: roundTo4(r) });
  }

  const { mean, std } = computeReturnStats(returns);
  const cohesion = computeDirectionalCohesion(returns, mean);
  const linkageScore = roundTo4(cohesion);

  // member_stock_codes 抽样最多 20 条 (与 KOLAuthorStat 同款 audit 上限)
  const sampleMembers = validStocks.slice(0, 20);
  // returns_distribution 也抽样最多 20 条 (防 payload 爆)
  const sampleReturnsDist = returnsDist.slice(0, 20);

  return {
    concept_name: input.concept_name,
    as_of_date: input.as_of_date,
    sample_size: returns.length,
    avg_return_pct: mean == null ? null : roundTo4(mean),
    std_dev_pct: std == null ? null : roundTo4(std),
    directional_cohesion: roundTo4(cohesion),
    linkage_score: linkageScore,
    member_stock_codes: sampleMembers,
    raw_payload: {
      member_count_total: input.member_stock_codes.length,
      skipped_no_bars: skippedNoBars,
      skipped_invalid_close: skippedInvalidClose,
      returns_distribution: sampleReturnsDist,
    },
  };
}

/** 量化到 4 位小数 (与 KOLAuthorStat 同款). */
export function roundTo4(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 10000) / 10000;
}

// ---------------------------------------------------------------------------
// AC 主验收: identifyStrongLinkages (pure helper)
// ---------------------------------------------------------------------------

export interface IdentifyStrongLinkagesOptions {
  /** 最少样本数 (默认 3) — 与 analyzeLinkages min_members 对齐 */
  min_samples?: number;
  /** 最低 linkage_score (默认 0.7) — AC §"输出"事实源阈值 */
  min_score?: number;
  /** 输出上限 (默认 20) */
  limit?: number;
}

/**
 * 从 stats 数组挑出"满足最低样本 + 最低联动分"的 concept, 按 linkage_score desc +
 * sample_size desc 排序, 取 top N.
 *
 * 这是 PRD AC §"输出" 的事实源 — caller 拿到这个输出数组即视为"今天联动确认
 * 的板块清单".
 */
export function identifyStrongLinkages(
  stats: ConceptLinkageStatRecord[],
  options: IdentifyStrongLinkagesOptions = {}
): ConceptLinkageStatRecord[] {
  const minSamples = Math.max(
    1,
    Math.floor(options.min_samples ?? DEFAULT_STRONG_LINKAGE_MIN_SAMPLES)
  );
  const minScore = Math.max(0, Math.min(1, options.min_score ?? DEFAULT_STRONG_LINKAGE_MIN_SCORE));
  const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_STRONG_LINKAGE_LIMIT));

  return stats
    .filter(s => s.sample_size >= minSamples && s.linkage_score >= minScore)
    .sort((a, b) => {
      if (a.linkage_score !== b.linkage_score) return b.linkage_score - a.linkage_score;
      if (a.sample_size !== b.sample_size) return b.sample_size - a.sample_size;
      return a.concept_name < b.concept_name ? -1 : a.concept_name > b.concept_name ? 1 : 0;
    })
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// DataSource DI 接口
// ---------------------------------------------------------------------------

export interface ConceptLinkageDataSource {
  /**
   * 拉 [sinceDate, asOfDate] 区间内的 concept 成员关系 (kol_source='xq_hot_concept').
   *
   * 返按 (concept_name → stock_codes[]) 分组的 map. 同一 (concept, stock) 出现
   * 多次只保留一次 (Set dedupe).
   */
  loadConceptMembers(sinceDate: string, asOfDate: string): Promise<Map<string, string[]>>;

  /**
   * 拉这些股票在 [sinceDate, asOfDate] 区间内的 daily bars.
   *
   * 返按 stock_code 分组的 map, 每组按 trade_date asc.
   * 注: 至少需要 2 个 bar (settle + prev_settle) 才能算 daily return — DataSource
   * 自己不预过滤, 让 computeDailyReturn 兜底.
   */
  loadDailyBarsForStocks(
    stockCodes: string[],
    sinceDate: string,
    asOfDate: string
  ): Promise<StockBarsMap>;
}

/**
 * 生产实现 — lazy require 模型避免单测进程拽起 sequelize.
 * 与 [[KOLAuthorTrackingService.DefaultKOLAuthorTrackingDataSource]] 同款.
 */
export class DefaultConceptLinkageDataSource implements ConceptLinkageDataSource {
  async loadConceptMembers(sinceDate: string, asOfDate: string): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { KOLOpinion } = require('../../models/KOLOpinion');
      const rows = await KOLOpinion.findAll({
        where: {
          kol_source: XQ_HOT_CONCEPT_SOURCE,
          opinion_date: { [Op.gte]: sinceDate, [Op.lte]: asOfDate },
        },
        attributes: ['stock_code', 'kol_name', 'opinion_date'],
        raw: true,
      });

      // kol_name = "市场热议·<concept_name>" — 去掉前缀提取 concept_name
      const seen = new Map<string, Set<string>>();
      for (const r of rows as Array<{
        stock_code: string;
        kol_name: string;
        opinion_date: string;
      }>) {
        const kolName = typeof r.kol_name === 'string' ? r.kol_name : '';
        if (!kolName.startsWith(HOT_CONCEPT_KOL_NAME_PREFIX)) continue;
        const conceptName = kolName.slice(HOT_CONCEPT_KOL_NAME_PREFIX.length).trim();
        if (!conceptName) continue;
        let set = seen.get(conceptName);
        if (!set) {
          set = new Set();
          seen.set(conceptName, set);
        }
        set.add(r.stock_code);
      }
      for (const [concept, codes] of seen) {
        result.set(concept, Array.from(codes));
      }
      return result;
    } catch (err: any) {
      logger.error(`ConceptLinkage.loadConceptMembers failed: ${err.message || String(err)}`);
      return result;
    }
  }

  async loadDailyBarsForStocks(
    stockCodes: string[],
    sinceDate: string,
    asOfDate: string
  ): Promise<StockBarsMap> {
    const map: StockBarsMap = new Map();
    if (stockCodes.length === 0) return map;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { DailyBar } = require('../../models/DailyBar');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Stock } = require('../../models/Stock');

      // 先把 stock_code 映射到 stock_id (DailyBar 用 stock_id PK)
      const stocks = await Stock.findAll({
        where: { code: { [Op.in]: stockCodes } },
        attributes: ['id', 'code'],
        raw: true,
      });
      const codeById = new Map<number, string>();
      const ids: number[] = [];
      for (const s of stocks as Array<{ id: number; code: string }>) {
        codeById.set(s.id, s.code);
        ids.push(s.id);
      }
      if (ids.length === 0) return map;

      const sinceTs = new Date(sinceDate + 'T00:00:00Z');
      const untilTs = new Date(asOfDate + 'T23:59:59Z');
      const bars = await DailyBar.findAll({
        where: {
          stock_id: { [Op.in]: ids },
          time: { [Op.gte]: sinceTs, [Op.lte]: untilTs },
        },
        attributes: ['stock_id', 'time', 'close'],
        order: [['time', 'ASC']],
        raw: true,
      });

      for (const b of bars as Array<{ stock_id: number; time: Date; close: number }>) {
        const code = codeById.get(b.stock_id);
        if (!code) continue;
        const dt = (b.time instanceof Date ? b.time : new Date(b.time)).toISOString().slice(0, 10);
        const close =
          typeof b.close === 'string' ? parseFloat(b.close as unknown as string) : b.close;
        if (!Number.isFinite(close)) continue;
        let arr = map.get(code);
        if (!arr) {
          arr = [];
          map.set(code, arr);
        }
        arr.push({ trade_date: dt, close });
      }
      return map;
    } catch (err: any) {
      logger.error(`ConceptLinkage.loadDailyBarsForStocks failed: ${err.message || String(err)}`);
      return map;
    }
  }
}

export const PRODUCTION_CONCEPT_LINKAGE_DATA_SOURCE: ConceptLinkageDataSource =
  new DefaultConceptLinkageDataSource();

// ---------------------------------------------------------------------------
// Service-level 入口
// ---------------------------------------------------------------------------

export interface AnalyzeLinkagesOptions {
  /** 截止日 (YYYY-MM-DD); 默认今天 (UTC) */
  as_of_date?: string;
  /** concept 成员关系回看窗口 (默认 7 天 — concept 热度通常一周内多次刷新) */
  lookback_days?: number;
  /** 每个 concept 至少需要 N 成员才输出 (默认 3) */
  min_members_per_concept?: number;
  /**
   * dry_run 仅做计算不带任何副作用 (本 service 本身无 DB 写, dry_run 仅为
   * 未来扩展 saveStats 留 API 兼容; 当前 dry_run/非 dry_run 行为相同 +
   * reason 字段区分).
   */
  dry_run?: boolean;
}

export type AnalyzeLinkagesStatus = 'ok' | 'skipped' | 'failed';

export interface AnalyzeLinkagesResult {
  status: AnalyzeLinkagesStatus;
  as_of_date: string;
  total_concepts: number;
  total_members_evaluated: number;
  total_skipped_concepts: number;
  stats: ConceptLinkageStatRecord[];
  error?: string;
  reason?: string;
}

export class ConceptLinkageAnalyzer {
  private readonly dataSource: ConceptLinkageDataSource;

  constructor(dataSource: ConceptLinkageDataSource = PRODUCTION_CONCEPT_LINKAGE_DATA_SOURCE) {
    this.dataSource = dataSource;
  }

  /**
   * 主入口 — 拉 concept 成员 + 拉 bars + 算每 concept linkage_score.
   *
   * **fail-OPEN 3 层**:
   *   1. PRODUCTION DataSource 内 try/catch + 返 Map() / Map() — 单 query 错误不阻塞;
   *   2. 主入口顶层 try/catch — 返 {status:'failed', error} 不抛;
   *   3. 单 concept 数据缺失 / 成员不足 → 跳过, 不影响其它.
   */
  async analyzeLinkages(options: AnalyzeLinkagesOptions = {}): Promise<AnalyzeLinkagesResult> {
    const asOfDate = options.as_of_date || this.todayUTC();
    const lookbackDays = Math.max(
      1,
      Math.floor(options.lookback_days ?? DEFAULT_LINKAGE_LOOKBACK_DAYS)
    );
    const minMembers = Math.max(
      1,
      Math.floor(options.min_members_per_concept ?? DEFAULT_MIN_MEMBERS_PER_CONCEPT)
    );
    const sinceDate = addDays(asOfDate, -lookbackDays);

    try {
      const membersMap = await this.dataSource.loadConceptMembers(sinceDate, asOfDate);
      if (membersMap.size === 0) {
        return {
          status: 'skipped',
          as_of_date: asOfDate,
          total_concepts: 0,
          total_members_evaluated: 0,
          total_skipped_concepts: 0,
          stats: [],
          reason: 'no_concept_members_in_window',
        };
      }

      // 拉 bars: 需 ≥ 2 个交易日 (settle + prev_settle), 用 lookbackDays + 7 兜底
      // 防止 asOfDate 是周日 → 实际 settle 是 周五, prev_settle 周四, 需要往前再
      // 留几天兜底.
      const allStockCodes = new Set<string>();
      for (const codes of membersMap.values()) {
        for (const c of codes) allStockCodes.add(c);
      }
      const barsSince = addDays(sinceDate, -7);
      const barsMap = await this.dataSource.loadDailyBarsForStocks(
        Array.from(allStockCodes),
        barsSince,
        asOfDate
      );

      const stats: ConceptLinkageStatRecord[] = [];
      let totalSkippedConcepts = 0;
      let totalMembersEvaluated = 0;

      for (const [concept, members] of membersMap) {
        // 成员不足直接跳过
        if (members.length < minMembers) {
          totalSkippedConcepts += 1;
          continue;
        }
        const stat = computeConceptLinkageStat({
          concept_name: concept,
          as_of_date: asOfDate,
          member_stock_codes: members,
          bars_by_stock: barsMap,
        });
        // 算完成员有效数仍不足 → 跳过 (避免 6 成员里只 1 个有 bars 的伪联动)
        if (stat.sample_size < minMembers) {
          totalSkippedConcepts += 1;
          continue;
        }
        totalMembersEvaluated += stat.sample_size;
        stats.push(stat);
      }

      // 排序: linkage_score desc + sample_size desc + concept_name asc
      stats.sort((a, b) => {
        if (a.linkage_score !== b.linkage_score) return b.linkage_score - a.linkage_score;
        if (a.sample_size !== b.sample_size) return b.sample_size - a.sample_size;
        return a.concept_name < b.concept_name ? -1 : a.concept_name > b.concept_name ? 1 : 0;
      });

      logger.info(
        `ConceptLinkage: as_of=${asOfDate} concepts=${stats.length} ` +
          `members=${totalMembersEvaluated} skipped_concepts=${totalSkippedConcepts}`
      );

      return {
        status: 'ok',
        as_of_date: asOfDate,
        total_concepts: stats.length,
        total_members_evaluated: totalMembersEvaluated,
        total_skipped_concepts: totalSkippedConcepts,
        stats,
        ...(options.dry_run === true ? { reason: 'dry_run' } : {}),
      };
    } catch (err: any) {
      logger.error(`ConceptLinkage.analyzeLinkages failed: ${err.message || String(err)}`);
      return {
        status: 'failed',
        as_of_date: asOfDate,
        total_concepts: 0,
        total_members_evaluated: 0,
        total_skipped_concepts: 0,
        stats: [],
        error: err.message || String(err),
      };
    }
  }

  private todayUTC(): string {
    return new Date().toISOString().slice(0, 10);
  }
}

/** 生产 singleton */
export const conceptLinkageAnalyzer = new ConceptLinkageAnalyzer();

/** 加自然日 (YYYY-MM-DD → YYYY-MM-DD), 跨月/跨年自动 handle. */
export function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
