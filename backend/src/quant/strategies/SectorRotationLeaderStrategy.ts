import { Op } from 'sequelize';
import { QuantStrategy } from './QuantStrategy';
import {
  QuantSignalResult,
  QuantStockContext,
  QuantStrategyDefinition,
  QuantStrategyRuntimeOptions,
} from '../types/QuantTypes';
import { IndustryFlow } from '../../models/IndustryFlow';
import { Stock } from '../../models/Stock';
import { DailyBar } from '../../models/DailyBar';
import { logger } from '../../utils/logger';
import { isSTName } from '../../utils/stNameUtils';

/**
 * SectorRotationLeaderStrategy — 行业龙头轮动（US-021）
 *
 * 两步法：
 *   Step 1：在 IndustryFlow 表按"近 lookbackDays(5) 个交易日累计主力净流入"
 *           取 top topIndustries (默认 10) 的强势行业。
 *   Step 2：在每个强势行业内挑当日涨幅最大、流通市值 ≥ minCirculatingMarketCap
 *           (默认 50 亿) 的 stocksPerIndustry (默认 2) 只龙头。
 *
 * 出场条件（按优先级 A → C）：
 *   A. 持有 ≥ holdingDaysLimit (默认 10 自然日) → SELL
 *   B. 行业掉出 top exitIndustryTopN (默认 15) → SELL
 *      (注意：阈值 15 比入场 10 宽，给行业轮动留余地；连续 5 名滑落才出局)
 *   C. 个股跌出行业 top exitStockTopN (默认 5) → SELL
 *      (注意：阈值 5 比入场 2 宽，给个股短期回撤留余地)
 *   D. 默认 HOLD
 *
 * 与 NorthboundFollow (US-019) 的关键差异：
 *   - **两阶段筛选**：先选行业再选股，不是全市场扫描；候选规模 ~20 而非 5000+。
 *   - **入场依赖 entry_industry**：position 必须携带 entry_industry 以便 exit
 *     时判定"我所属行业是否还在 top 15"。Industry 字段月内变化稀少，可视为
 *     persistent metadata（同 CTA100MomentumStrategy 的 index 受限模式）。
 *   - **5 日累计 main_inflow** 是真正的"行业资金流向"信号，比 NorthboundFollow
 *     的"个股北向加仓"信号粒度更粗，胜率更稳定，但 alpha 也更平。
 *
 * 与 DragonHeadMomentumStrategy (US-012) 的关键差异：
 *   - DragonHead 是 **短线情绪交易**（涨停 + 游资席位 + 1-3 板 + 3 日内退出）；
 *     本策略是 **中线行业轮动**（5 日累计资金流 + 行业龙头 + 10 日持有）。
 *   - 没有"涨停"硬条件，不需要 LimitUpStock；没有"游资席位"硬条件，不需要
 *     DragonTigerBoard；本策略只用 IndustryFlow + Stock + DailyBar。
 *
 * evaluate() 兼容性：组合级策略，evaluate 返回信息性 hold；真正入口是
 * generateSignals(date, options)。
 *
 * 默认参数（AC 指定）：
 *   topIndustries=10  stocksPerIndustry=2  lookbackDays=5
 *   minCirculatingMarketCap=50亿  holdingDaysLimit=10
 *   exitIndustryTopN=15  exitStockTopN=5  excludeST=true
 */

export const DEFAULT_SECTOR_ROTATION_LEADER_PARAMS: Readonly<Required<SectorRotationLeaderParams>> =
  Object.freeze({
    topIndustries: 10,
    stocksPerIndustry: 2,
    lookbackDays: 5,
    minCirculatingMarketCap: 50 * 1e8,
    holdingDaysLimit: 10,
    exitIndustryTopN: 15,
    exitStockTopN: 5,
    excludeST: true,
  });

export interface SectorRotationLeaderParams {
  /** Step 1 入选强势行业数（AC 默认 10） */
  topIndustries: number;
  /** Step 2 每个行业内选龙头股数（AC 默认 2） */
  stocksPerIndustry: number;
  /** 累计主力净流入 lookback 交易日数（默认 5） */
  lookbackDays: number;
  /** 流通市值下限 (元)（AC 默认 50 亿） */
  minCirculatingMarketCap: number;
  /** 持有 N 自然日到期 SELL（AC 默认 10） */
  holdingDaysLimit: number;
  /** 出场行业排名阈值，行业掉出此名次 SELL（AC 默认 15，比入场 top 10 宽 5 位） */
  exitIndustryTopN: number;
  /** 出场个股行业内排名阈值，个股跌出本行业前 N SELL（AC 默认 5，比入场 top 2 宽 3 位） */
  exitStockTopN: number;
  /** 是否剔除 ST/*ST */
  excludeST: boolean;
}

/**
 * 持仓记录 — 出场规则需要 entry_date / entry_industry。
 *
 * entry_industry 是当时所属行业的名称，与 exit 检查时点的 Stock.industry
 * 可能不同（极少情况下行业归类有重分类）；但调仓决策应以 entry_industry
 * 为准——"我当时买的就是这个行业的龙头，行业还在我就还在"。
 */
export interface SectorRotationPosition {
  stock_code: string;
  /** 进场日 ISO YYYY-MM-DD */
  entry_date: string;
  /** 进场价（debug + 未来扩展 stop-loss 用） */
  entry_price: number;
  /** 进场时的所属行业名称（决定 exit 阶段查哪个行业的 top N） */
  entry_industry: string;
}

export interface SectorRotationSignal {
  stock_code: string;
  name?: string | null;
  industry?: string | null;
  signal: 'buy' | 'sell' | 'hold';
  reason: string;
  reference_price?: number;
  industry_rank?: number;
  stock_rank_in_industry?: number;
  change_pct?: number;
}

export interface SectorRotationFilteredStats {
  /** Step 1 行业池大小 (有 main_inflow 数据的行业总数) */
  industry_pool_size: number;
  /** 已持仓不重复 BUY 剔除数 */
  fail_already_held: number;
  /** 流通市值不足剔除数 */
  fail_market_cap_low: number;
  /** ST 名称剔除数 */
  fail_st: number;
  /** 缺日行情数据剔除数（无 change_pct / 无 close） */
  fail_metric_missing: number;
}

export interface SectorRotationSignalsResult {
  trade_date: string;
  /** 调仓后目标持仓 */
  target_positions: SectorRotationPosition[];
  /** 全部增量信号 */
  signals: SectorRotationSignal[];
  /** Step 1 选出的 top topIndustries 行业（按 cumulative_inflow 降序，含排名） */
  top_industries: Array<{ industry_name: string; cumulative_inflow: number; rank: number }>;
  filtered: SectorRotationFilteredStats;
  params: SectorRotationLeaderParams;
  /** 通过全部入场维度后的候选数（即最终入选龙头数；未受 maxPositions cap） */
  eligible_count: number;
}

export interface SectorRotationGenerateOptions {
  params?: Partial<SectorRotationLeaderParams>;
  /** 当前持仓 */
  currentPositions?: SectorRotationPosition[];
}

// ---------------------------------------------------------------------------
// DataSource 接口（便于测试用 fake 注入）
// ---------------------------------------------------------------------------

/**
 * 3 个 loader — 把所有 Sequelize 查询从策略主体抽离。
 *
 * 设计要点：
 *   1. `loadIndustryRanking` 返回 **全部** 有 cumulative_inflow 的行业（按降序），
 *      caller 自己 slice top N；这样 entry 用 top 10 / exit 用 top 15 共享同份数据。
 *   2. `loadIndustryConstituentMetrics` 同样返回 **全部** 行业内股票（按 change_pct 降序），
 *      caller 自己 slice top stocksPerIndustry / top exitStockTopN 共享同份数据。
 *   3. `loadDailyClose` 仅给 BUY 入场参考价；exit 阶段如果需要 close (未来扩展止损) 也走它。
 */
export interface SectorRotationLeaderDataSource {
  /**
   * 给定 (asOfDate, lookbackDays)，返回行业近 N 日累计主力净流入。
   *
   * 计算：sum(IndustryFlow.main_inflow) WHERE trade_date IN (asOfDate - lookback ~ asOfDate)
   *        GROUP BY industry_name；按累计降序排好。
   *
   * 行业行数日内变化稀少；若 asOfDate 当日还没 sync，应回退到最近一个有数据的日期为锚点。
   */
  loadIndustryRanking(
    asOfDate: string,
    lookbackDays: number
  ): Promise<Array<{ industry_name: string; cumulative_inflow: number }>>;

  /**
   * 给定 (asOfDate, industryNames)，返回每个行业内的成份股 + 当日 change_pct +
   * 流通市值 + 名称 + 是否 ST。
   *
   * 每个 industry_name 的 list 按 change_pct 降序排好；caller 自己 slice top N。
   * 缺 change_pct 的股票不出现在 list 中（统一在 strategy 层补 fail_metric_missing）。
   *
   * 为什么把 sort 放在 DataSource：避免每次入场/出场都重新 sort 同份数据（生产环境
   * 一个行业可能 50-200 只成份股）。
   */
  loadIndustryConstituentMetrics(
    asOfDate: string,
    industryNames: string[]
  ): Promise<Map<string, SectorRotationStockMetric[]>>;

  /**
   * 给定 (asOfDate, stockCodes) 当日 close 快照。
   * 仅用于 BUY 入场参考价；缺数据的股票可以不出现。
   */
  loadDailyClose(asOfDate: string, stockCodes: string[]): Promise<Map<string, number>>;
}

export interface SectorRotationStockMetric {
  stock_code: string;
  name?: string | null;
  change_pct: number;
  circulating_market_cap?: number | null;
}

// ---------------------------------------------------------------------------
// 生产 DataSource 实现
// ---------------------------------------------------------------------------

export class DefaultSectorRotationLeaderDataSource implements SectorRotationLeaderDataSource {
  async loadIndustryRanking(
    asOfDate: string,
    lookbackDays: number
  ): Promise<Array<{ industry_name: string; cumulative_inflow: number }>> {
    if (lookbackDays <= 0) return [];

    // 拉过去 ~3 倍 lookbackDays 自然日范围的所有 IndustryFlow 行（覆盖周末 + 节假日 gap）；
    // 按 industry_name 分组求 sum 然后取最近 lookbackDays 个 distinct trade_date。
    const lookbackStart = new Date(`${asOfDate}T00:00:00Z`);
    lookbackStart.setUTCDate(lookbackStart.getUTCDate() - lookbackDays * 3);
    const startIso = lookbackStart.toISOString().slice(0, 10);

    const rows = (await IndustryFlow.findAll({
      attributes: ['industry_name', 'trade_date', 'main_inflow'],
      where: {
        trade_date: { [Op.gte]: startIso, [Op.lte]: asOfDate },
        main_inflow: { [Op.not]: null },
      },
      raw: true,
    })) as unknown as Array<{
      industry_name: string;
      trade_date: string;
      main_inflow: number | string;
    }>;

    // 取最近 lookbackDays 个唯一 trade_date（升序时取尾部）
    const allDates = Array.from(new Set(rows.map(r => r.trade_date))).sort();
    const recentDates = new Set(allDates.slice(-lookbackDays));

    const byIndustry = new Map<string, number>();
    for (const r of rows) {
      if (!recentDates.has(r.trade_date)) continue;
      const v = typeof r.main_inflow === 'string' ? Number(r.main_inflow) : r.main_inflow;
      if (!Number.isFinite(v)) continue;
      byIndustry.set(r.industry_name, (byIndustry.get(r.industry_name) ?? 0) + v);
    }

    return Array.from(byIndustry.entries())
      .map(([industry_name, cumulative_inflow]) => ({ industry_name, cumulative_inflow }))
      .sort((a, b) => {
        if (a.cumulative_inflow !== b.cumulative_inflow) {
          return b.cumulative_inflow - a.cumulative_inflow;
        }
        return a.industry_name.localeCompare(b.industry_name);
      });
  }

  async loadIndustryConstituentMetrics(
    asOfDate: string,
    industryNames: string[]
  ): Promise<Map<string, SectorRotationStockMetric[]>> {
    const out = new Map<string, SectorRotationStockMetric[]>();
    if (!industryNames.length) return out;

    // 一次性查所有目标行业的 Stock；每个行业内会有几十~一百多只
    const stocks = (await Stock.findAll({
      attributes: ['id', 'symbol', 'name', 'industry', 'circulating_market_cap'],
      where: { industry: { [Op.in]: industryNames } },
      raw: true,
    })) as unknown as Array<{
      id: number;
      symbol: string;
      name: string;
      industry: string;
      circulating_market_cap: number | string | null;
    }>;
    if (!stocks.length) {
      for (const ind of industryNames) out.set(ind, []);
      return out;
    }

    const stockIds = stocks.map(s => s.id);
    const idToStock = new Map<number, (typeof stocks)[number]>();
    for (const s of stocks) idToStock.set(s.id, s);

    // 一次性查 [asOf - 7 天, asOf] 范围的 DailyBar 用于计算 change_pct。
    // 我们需要 close + prev_close，前 7 天自然日窗口足够覆盖单交易日 + 周末。
    const lookbackStart = new Date(`${asOfDate}T00:00:00Z`);
    lookbackStart.setUTCDate(lookbackStart.getUTCDate() - 7);
    const bars = (await DailyBar.findAll({
      attributes: ['stock_id', 'time', 'close'],
      where: {
        stock_id: { [Op.in]: stockIds },
        time: { [Op.gte]: lookbackStart.toISOString(), [Op.lte]: `${asOfDate}T23:59:59Z` },
      },
      raw: true,
    })) as unknown as Array<{
      stock_id: number;
      time: Date | string;
      close: number | string;
    }>;

    // 按 stock_id 分组 + 按时间升序，change_pct = (today_close - prev_close) / prev_close
    const byStockId = new Map<number, Array<{ timeIso: string; close: number }>>();
    for (const b of bars) {
      const close = Number(b.close);
      if (!Number.isFinite(close)) continue;
      const tIso =
        b.time instanceof Date ? b.time.toISOString().slice(0, 10) : String(b.time).slice(0, 10);
      const arr = byStockId.get(b.stock_id) ?? [];
      arr.push({ timeIso: tIso, close });
      byStockId.set(b.stock_id, arr);
    }

    const byIndustry = new Map<string, SectorRotationStockMetric[]>();
    for (const ind of industryNames) byIndustry.set(ind, []);

    for (const [stockId, arr] of byStockId.entries()) {
      const stock = idToStock.get(stockId);
      if (!stock) continue;
      arr.sort((a, b) => a.timeIso.localeCompare(b.timeIso));
      if (arr.length < 2) continue;
      const today = arr[arr.length - 1];
      const prev = arr[arr.length - 2];
      if (today.timeIso !== asOfDate) continue; // 当日缺 bar → 不算入候选
      if (!prev.close || prev.close === 0) continue;
      const change_pct = (today.close - prev.close) / prev.close;
      if (!Number.isFinite(change_pct)) continue;
      const cap =
        typeof stock.circulating_market_cap === 'string'
          ? Number(stock.circulating_market_cap)
          : stock.circulating_market_cap;
      const list = byIndustry.get(stock.industry);
      if (!list) continue;
      list.push({
        stock_code: stripSuffix(stock.symbol),
        name: stock.name ?? null,
        change_pct,
        circulating_market_cap: cap != null && Number.isFinite(cap) ? cap : null,
      });
    }

    // 每个行业内按 change_pct 降序 + stock_code 升序稳定 tie-break
    for (const [ind, list] of byIndustry.entries()) {
      list.sort((a, b) => {
        if (a.change_pct !== b.change_pct) return b.change_pct - a.change_pct;
        return a.stock_code.localeCompare(b.stock_code);
      });
      out.set(ind, list);
    }
    return out;
  }

  async loadDailyClose(asOfDate: string, stockCodes: string[]): Promise<Map<string, number>> {
    if (!stockCodes.length) return new Map();
    const symbols = stockCodes.map(c => guessStockSymbol(c));

    const stocks = (await Stock.findAll({
      attributes: ['id', 'symbol'],
      where: { symbol: { [Op.in]: symbols } },
      raw: true,
    })) as unknown as Array<{ id: number; symbol: string }>;
    if (!stocks.length) return new Map();
    const idToCode = new Map<number, string>();
    const stockIds: number[] = [];
    for (const s of stocks) {
      idToCode.set(s.id, stripSuffix(s.symbol));
      stockIds.push(s.id);
    }

    const lookbackStart = new Date(`${asOfDate}T00:00:00Z`);
    lookbackStart.setUTCDate(lookbackStart.getUTCDate() - 5);
    const bars = (await DailyBar.findAll({
      attributes: ['stock_id', 'time', 'close'],
      where: {
        stock_id: { [Op.in]: stockIds },
        time: { [Op.gte]: lookbackStart.toISOString(), [Op.lte]: `${asOfDate}T23:59:59Z` },
      },
      raw: true,
    })) as unknown as Array<{ stock_id: number; time: Date | string; close: number | string }>;

    const byStockId = new Map<number, Array<{ timeIso: string; close: number }>>();
    for (const b of bars) {
      const close = Number(b.close);
      if (!Number.isFinite(close)) continue;
      const tIso =
        b.time instanceof Date ? b.time.toISOString().slice(0, 10) : String(b.time).slice(0, 10);
      const arr = byStockId.get(b.stock_id) ?? [];
      arr.push({ timeIso: tIso, close });
      byStockId.set(b.stock_id, arr);
    }

    const out = new Map<string, number>();
    for (const [stockId, arr] of byStockId.entries()) {
      const code = idToCode.get(stockId);
      if (!code) continue;
      const today = arr.find(b => b.timeIso === asOfDate);
      if (today) {
        out.set(code, today.close);
        continue;
      }
      arr.sort((a, b) => a.timeIso.localeCompare(b.timeIso));
      if (arr.length) out.set(code, arr[arr.length - 1].close);
    }
    return out;
  }
}

const PRODUCTION_DATA_SOURCE: SectorRotationLeaderDataSource =
  new DefaultSectorRotationLeaderDataSource();

// ---------------------------------------------------------------------------
// 策略主体
// ---------------------------------------------------------------------------

export class SectorRotationLeaderStrategy extends QuantStrategy {
  readonly definition: QuantStrategyDefinition = {
    strategy_key: 'sector_rotation_leader',
    name: '行业龙头轮动',
    description:
      '先选近 5 日累计主力净流入排名 top 10 的强势行业，再在每个行业内挑当日涨幅最大' +
      '且流通市值 ≥ 50 亿的 2 只龙头持有，每行业 2 只共 20 只组合；行业掉出 top 15 / ' +
      '个股跌出行业 top 5 / 持有 10 自然日三条出场线。',
    category: 'multi_factor',
    default_params: { ...DEFAULT_SECTOR_ROTATION_LEADER_PARAMS },
    enabled: true,
    risk_level: 'medium',
    tags: ['行业轮动', '龙头', '主力资金', '中线'],
    style: 'sector_rotation',
    edge_hypothesis: {
      thesis:
        '行业龙头轮动：行业 5 日累计 main_inflow top-10 → 行业内 change_pct top-2 龙头，每日扫描，掉出 top 15 / top 5 时退出',
      category: 'momentum',
      expected_edge_pct: 10.0,
      expected_holding_days: 20,
      key_factors: ['industry_5d_main_inflow', 'stock_change_pct_in_industry'],
      failure_modes: [
        '热门行业切换',
        '行业内龙头切换 (今日龙头明日不再是)',
        '主力资金统计偏差',
      ],
      kill_switch_metric: 'win_rate_30d',
      kill_switch_threshold: 0.45,
    },
  };

  private readonly dataSource: SectorRotationLeaderDataSource;

  constructor(dataSource: SectorRotationLeaderDataSource = PRODUCTION_DATA_SOURCE) {
    super();
    this.dataSource = dataSource;
  }

  /**
   * QuantStrategy 抽象基类要求的 per-stock evaluate()。
   *
   * 本策略是组合级，不通过单股 pipeline 工作；返回信息性 hold。
   */
  evaluate(context: QuantStockContext, _options?: QuantStrategyRuntimeOptions): QuantSignalResult {
    const latestClose = context.bars?.length ? context.bars[context.bars.length - 1].close : 0;
    return {
      strategy_key: this.definition.strategy_key,
      symbol: context.symbol,
      name: context.name,
      signal: 'hold',
      score: 0,
      confidence: 0,
      entry_price: latestClose,
      target_holding_days: this.definition.default_params.holdingDaysLimit,
      reasons: ['SectorRotationLeader 是组合级策略，请使用 generateSignals(date) 获得调仓信号'],
      risk_flags: [],
      factors: {
        note: 'use_generateSignals_instead',
      },
    };
  }

  /**
   * 组合级调仓信号生成 — US-021 主入口。
   *
   * @param tradeDate ISO YYYY-MM-DD，当日交易日
   * @param options.params 覆盖 default_params 的部分字段
   * @param options.currentPositions 当前持仓
   */
  async generateSignals(
    tradeDate: string,
    options: SectorRotationGenerateOptions = {}
  ): Promise<SectorRotationSignalsResult> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) {
      throw new Error(`generateSignals: invalid trade_date (expected YYYY-MM-DD): ${tradeDate}`);
    }

    const params = this.resolveParams(options.params);
    const currentPositions = options.currentPositions ?? [];

    // === Step 1: 一次性拉行业 ranking 全集（entry top 10 / exit top 15 共享同份数据）
    const industryRanking = await this.dataSource.loadIndustryRanking(
      tradeDate,
      params.lookbackDays
    );

    // 入场用 top topIndustries；出场判定用 top exitIndustryTopN
    // —— 需要 exit 阶段比 entry 宽，所以拿大的那份做 constituent fetch
    const exitIndustrySet = new Set(
      industryRanking.slice(0, params.exitIndustryTopN).map(r => r.industry_name)
    );

    // 入场目标行业 = top topIndustries（且包含在 exit 容忍域里 — 必然成立）
    const entryIndustries = industryRanking.slice(0, params.topIndustries);

    // === Step 2: 一次性拉这些行业的成份股 + 当日 change_pct（用大的那份覆盖 exit 判定需要）
    // 行业全集 = exit 容忍域并集（已经覆盖 entry 因为 top 10 ⊂ top 15）。
    const targetIndustries = Array.from(exitIndustrySet);
    const constituentMetrics = await this.dataSource.loadIndustryConstituentMetrics(
      tradeDate,
      targetIndustries
    );

    // === Step 3: Exit 流程 — 用 industryRanking + constituentMetrics 判定行业 / 个股是否还在容忍域
    const exitResults = await this.evaluateExits(
      tradeDate,
      currentPositions,
      params,
      industryRanking,
      constituentMetrics
    );

    // === Step 4: 入场流程 — 在 top topIndustries 内挑 stocksPerIndustry 个龙头
    const heldCodes = new Set(
      exitResults.signals.filter(s => s.signal === 'hold').map(s => s.stock_code)
    );
    const entryEvaluation = this.evaluateEntries(
      params,
      entryIndustries,
      constituentMetrics,
      heldCodes
    );

    // === Step 5: 拉 BUY 候选的入场参考价
    const buyCodes = entryEvaluation.candidates.map(c => c.stock_code);
    const closeMap = await this.dataSource.loadDailyClose(tradeDate, buyCodes);

    // === Step 6: 构造 target_positions = HOLD（保留）+ 新 BUY（cap by topIndustries × stocksPerIndustry implicit）
    const kept: SectorRotationPosition[] = [];
    const exitMap = new Map(exitResults.signals.map(s => [s.stock_code, s]));
    for (const pos of currentPositions) {
      const sig = exitMap.get(pos.stock_code);
      if (!sig || sig.signal === 'hold') {
        kept.push(pos);
      }
    }

    // 隐式 max positions = topIndustries × stocksPerIndustry（AC 没有显式 maxPositions 参数；
    // 强势行业 × 每行业 N 只就是天然 cap）。若 HOLD 已经占满，新 BUY 数 = 0。
    const implicitCap = params.topIndustries * params.stocksPerIndustry;
    const remainingSlots = Math.max(0, implicitCap - kept.length);
    const buyCandidates = entryEvaluation.candidates.slice(0, remainingSlots);

    const buySignals: SectorRotationSignal[] = buyCandidates.map(c => ({
      stock_code: c.stock_code,
      name: c.name ?? null,
      industry: c.industry_name,
      signal: 'buy',
      reason:
        `行业 "${c.industry_name}" 排名第 ${c.industry_rank}，行业内涨幅排名第 ${c.stock_rank_in_industry}，` +
        `当日涨幅 ${(c.change_pct * 100).toFixed(2)}%，流通市值 ` +
        `${((c.circulating_market_cap ?? 0) / 1e8).toFixed(2)} 亿`,
      reference_price: closeMap.get(c.stock_code) ?? 0,
      industry_rank: c.industry_rank,
      stock_rank_in_industry: c.stock_rank_in_industry,
      change_pct: c.change_pct,
    }));

    const newPositions: SectorRotationPosition[] = buyCandidates.map(c => ({
      stock_code: c.stock_code,
      entry_date: tradeDate,
      entry_price: closeMap.get(c.stock_code) ?? 0,
      entry_industry: c.industry_name,
    }));

    const targetPositions = [...kept, ...newPositions];
    const allSignals = [...exitResults.signals, ...buySignals];

    logger.info(
      `SectorRotationLeader.generateSignals(${tradeDate}): ` +
        `industry_pool=${industryRanking.length} ` +
        `entry_industries=${entryIndustries.length} ` +
        `eligible=${entryEvaluation.candidates.length} ` +
        `held_kept=${kept.length} buy=${buySignals.length} ` +
        `sell=${allSignals.filter(s => s.signal === 'sell').length} ` +
        `hold=${allSignals.filter(s => s.signal === 'hold').length}`
    );

    return {
      trade_date: tradeDate,
      target_positions: targetPositions,
      signals: allSignals,
      top_industries: entryIndustries.map((r, i) => ({
        industry_name: r.industry_name,
        cumulative_inflow: r.cumulative_inflow,
        rank: i + 1,
      })),
      filtered: entryEvaluation.filtered,
      params,
      eligible_count: entryEvaluation.candidates.length,
    };
  }

  // -------------------------------------------------------------------------
  // 内部步骤
  // -------------------------------------------------------------------------

  /**
   * 入场候选：在 entryIndustries 内每个行业挑 stocksPerIndustry 个龙头。
   * 已持仓代码自动剔除。
   *
   * 同步方法（无 DB 调用）— industryRanking + constituentMetrics 已经在主流程拉好。
   */
  private evaluateEntries(
    params: SectorRotationLeaderParams,
    entryIndustries: Array<{ industry_name: string; cumulative_inflow: number }>,
    constituentMetrics: Map<string, SectorRotationStockMetric[]>,
    excludeStockCodes: Set<string>
  ): {
    candidates: Array<{
      stock_code: string;
      industry_name: string;
      industry_rank: number;
      stock_rank_in_industry: number;
      change_pct: number;
      circulating_market_cap?: number | null;
      name?: string | null;
    }>;
    filtered: SectorRotationFilteredStats;
  } {
    const filtered: SectorRotationFilteredStats = {
      industry_pool_size: entryIndustries.length,
      fail_already_held: 0,
      fail_market_cap_low: 0,
      fail_st: 0,
      fail_metric_missing: 0,
    };

    const candidates: Array<{
      stock_code: string;
      industry_name: string;
      industry_rank: number;
      stock_rank_in_industry: number;
      change_pct: number;
      circulating_market_cap?: number | null;
      name?: string | null;
    }> = [];

    for (let i = 0; i < entryIndustries.length; i++) {
      const industry = entryIndustries[i];
      const industryRank = i + 1;
      const list = constituentMetrics.get(industry.industry_name) ?? [];

      // 在已排序的 list 中按 change_pct 降序 walk，过滤掉不合格的，取前 stocksPerIndustry 个
      let pickedInThisIndustry = 0;
      let stockRankInIndustry = 0;
      for (const stock of list) {
        if (pickedInThisIndustry >= params.stocksPerIndustry) break;
        stockRankInIndustry += 1;

        if (excludeStockCodes.has(stock.stock_code)) {
          filtered.fail_already_held += 1;
          continue;
        }
        if (
          stock.circulating_market_cap == null ||
          !Number.isFinite(stock.circulating_market_cap)
        ) {
          filtered.fail_metric_missing += 1;
          continue;
        }
        if (stock.circulating_market_cap < params.minCirculatingMarketCap) {
          filtered.fail_market_cap_low += 1;
          continue;
        }
        if (params.excludeST && stock.name && isSTName(stock.name)) {
          filtered.fail_st += 1;
          continue;
        }
        candidates.push({
          stock_code: stock.stock_code,
          industry_name: industry.industry_name,
          industry_rank: industryRank,
          stock_rank_in_industry: stockRankInIndustry,
          change_pct: stock.change_pct,
          circulating_market_cap: stock.circulating_market_cap,
          name: stock.name,
        });
        pickedInThisIndustry += 1;
      }
    }

    return { candidates, filtered };
  }

  /** Exit 流程：对每只 currentPositions 计算 signal */
  private async evaluateExits(
    tradeDate: string,
    currentPositions: SectorRotationPosition[],
    params: SectorRotationLeaderParams,
    industryRanking: Array<{ industry_name: string; cumulative_inflow: number }>,
    constituentMetrics: Map<string, SectorRotationStockMetric[]>
  ): Promise<{ signals: SectorRotationSignal[] }> {
    if (currentPositions.length === 0) return { signals: [] };

    // 行业名 → rank（1-based）映射
    const industryRankMap = new Map<string, number>();
    industryRanking.forEach((r, i) => industryRankMap.set(r.industry_name, i + 1));

    const signals: SectorRotationSignal[] = [];
    for (const pos of currentPositions) {
      const holdingDays = naturalDaysBetween(pos.entry_date, tradeDate);

      // A. 持有 ≥ holdingDaysLimit → SELL（最高优先级）
      if (holdingDays >= params.holdingDaysLimit) {
        signals.push({
          stock_code: pos.stock_code,
          name: null,
          industry: pos.entry_industry,
          signal: 'sell',
          reason: `持有 ${holdingDays} 自然日 ≥ holdingDaysLimit(${params.holdingDaysLimit})，到期 SELL`,
        });
        continue;
      }

      // B. 行业掉出 top exitIndustryTopN → SELL
      const indRank = industryRankMap.get(pos.entry_industry) ?? -1;
      if (indRank === -1 || indRank > params.exitIndustryTopN) {
        const rankDesc = indRank === -1 ? '无主力净流入数据' : `第 ${indRank} 名`;
        signals.push({
          stock_code: pos.stock_code,
          name: null,
          industry: pos.entry_industry,
          signal: 'sell',
          reason: `行业 "${pos.entry_industry}" ${rankDesc}，超出 exitIndustryTopN(${params.exitIndustryTopN})，SELL`,
          industry_rank: indRank === -1 ? undefined : indRank,
        });
        continue;
      }

      // C. 个股跌出本行业 top exitStockTopN → SELL
      const indConstituents = constituentMetrics.get(pos.entry_industry) ?? [];
      if (indConstituents.length === 0) {
        // 行业还在排名里但成份股 metric 缺失 → 兜底 HOLD（不当作出场，避免 metric pipeline 抖动赶人）
        signals.push({
          stock_code: pos.stock_code,
          name: null,
          industry: pos.entry_industry,
          signal: 'hold',
          reason: `行业 "${pos.entry_industry}" 当日成份股 metric 数据缺失，HOLD 等下一交易日`,
          industry_rank: indRank,
        });
        continue;
      }

      // 同入场口径：先过滤 market_cap + ST，再按 change_pct 排序取 top exitStockTopN
      const eligibleStocks = indConstituents.filter(s => {
        if (s.circulating_market_cap == null || !Number.isFinite(s.circulating_market_cap)) {
          return false;
        }
        if (s.circulating_market_cap < params.minCirculatingMarketCap) return false;
        if (params.excludeST && s.name && isSTName(s.name)) return false;
        return true;
      });

      // 已排序状态保留：DataSource 保证 change_pct 降序，再 slice top
      const topNCodes = new Set(
        eligibleStocks.slice(0, params.exitStockTopN).map(s => s.stock_code)
      );

      if (!topNCodes.has(pos.stock_code)) {
        // 找一下我目前在自己行业的什么位置（用于 reason 信息更清晰）
        const myIdx = eligibleStocks.findIndex(s => s.stock_code === pos.stock_code);
        const myRank = myIdx === -1 ? '未入榜' : `第 ${myIdx + 1} 名`;
        signals.push({
          stock_code: pos.stock_code,
          name: null,
          industry: pos.entry_industry,
          signal: 'sell',
          reason: `个股在行业 "${pos.entry_industry}" 内排名 ${myRank}，跌出 exitStockTopN(${params.exitStockTopN})，SELL`,
          industry_rank: indRank,
          stock_rank_in_industry: myIdx === -1 ? undefined : myIdx + 1,
        });
        continue;
      }

      // D. 默认 HOLD
      const myIdx = eligibleStocks.findIndex(s => s.stock_code === pos.stock_code);
      const stockMeta = indConstituents.find(s => s.stock_code === pos.stock_code);
      signals.push({
        stock_code: pos.stock_code,
        name: stockMeta?.name ?? null,
        industry: pos.entry_industry,
        signal: 'hold',
        reason: `继续持有（行业第 ${indRank} 名，个股第 ${myIdx + 1} 名，持有 ${holdingDays} 日）`,
        industry_rank: indRank,
        stock_rank_in_industry: myIdx + 1,
        change_pct: stockMeta?.change_pct,
      });
    }

    return { signals };
  }

  private resolveParams(
    override?: Partial<SectorRotationLeaderParams>
  ): SectorRotationLeaderParams {
    const def = this.definition.default_params as Required<SectorRotationLeaderParams>;
    return {
      topIndustries: override?.topIndustries ?? def.topIndustries,
      stocksPerIndustry: override?.stocksPerIndustry ?? def.stocksPerIndustry,
      lookbackDays: override?.lookbackDays ?? def.lookbackDays,
      minCirculatingMarketCap: override?.minCirculatingMarketCap ?? def.minCirculatingMarketCap,
      holdingDaysLimit: override?.holdingDaysLimit ?? def.holdingDaysLimit,
      exitIndustryTopN: override?.exitIndustryTopN ?? def.exitIndustryTopN,
      exitStockTopN: override?.exitStockTopN ?? def.exitStockTopN,
      excludeST: override?.excludeST ?? def.excludeST,
    };
  }
}

// ---------------------------------------------------------------------------
// 内部 helpers
// ---------------------------------------------------------------------------

/** 自然日差（不算交易日，简单 ISO 日期相减）。entry=tradeDate 时返回 0 */
export function naturalDaysBetween(entryDate: string, tradeDate: string): number {
  const a = new Date(`${entryDate}T00:00:00Z`).getTime();
  const b = new Date(`${tradeDate}T00:00:00Z`).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  const diff = (b - a) / (1000 * 60 * 60 * 24);
  return Math.max(0, Math.round(diff));
}

/**
 * ST 名称判定 — 重新导出自 `backend/src/utils/stNameUtils.ts`（US-025 抽取）。
 * 任何判定逻辑变更只改共享模块。
 */
export { isSTName };

function stripSuffix(symbol: string | null | undefined): string {
  if (!symbol) return '';
  const s = symbol.trim();
  if (!s) return '';
  const i = s.indexOf('.');
  if (i < 0) return s;
  const before = s.slice(0, i);
  const after = s.slice(i + 1);
  // 前缀格式 (sh./sz./bj.) — 2 字母 alpha + 数字
  if (/^[a-zA-Z]{2}$/.test(before)) return after;
  // 后缀格式 (.SH/.SZ/.BJ)
  return before;
}

function guessStockSymbol(stockCode: string): string {
  if (!stockCode) return '';
  if (stockCode.includes('.')) return stockCode;
  const head = stockCode[0];
  // stocks 表存的是 sh./sz./bj. 前缀格式
  if (head === '6') return `sh.${stockCode}`;
  if (head === '0' || head === '3') return `sz.${stockCode}`;
  if (head === '4' || head === '8' || head === '9') return `bj.${stockCode}`;
  return `sz.${stockCode}`;
}
