import { Op, fn, col } from 'sequelize';
import { QuantStrategy } from './QuantStrategy';
import {
  QuantSignalResult,
  QuantStockContext,
  QuantStrategyDefinition,
  QuantStrategyRuntimeOptions,
} from '../types/QuantTypes';
import { LimitUpStock } from '../../models/LimitUpStock';
import { IndustryFlow } from '../../models/IndustryFlow';
import { DragonTigerBoard } from '../../models/DragonTigerBoard';
import { Stock } from '../../models/Stock';
import { DailyBar } from '../../models/DailyBar';
import { logger } from '../../utils/logger';

/**
 * DragonHeadMomentumStrategy — 短线龙头战法（US-012）
 *
 * 抓取强势行业内首板 / 低连板（1-3 板）梯队龙头：当日涨停 + 知名游资席位
 * 净买入 + 流通市值 30-200 亿 + 所属行业当日资金流排名前 10。次日开盘
 * 高开 5%+ 减半、炸板 / 持仓 3 日强制平。
 *
 * 与 MultiFactorAlphaStrategy 的关键区别：
 *   - 调仓**事件驱动**（每个交易日触发，不依赖月度边界）。
 *   - **currentPositions 比 string[] 复杂**：必须携带每只股票的 entry_date /
 *     entry_price（exit 规则要算 holding_days / stop_loss）。这是 schema diff
 *     从 MultiFactorAlpha 的合理扩展；调用方需在 PaperTrading 层把 BUY 时刻的
 *     date+price 记下，下一日传回。
 *
 * 与现有 QuantStrategy 基类的 evaluate() 兼容性：
 *   evaluate() 实现为 "信息性 hold"——本策略本质是组合级，不通过单股
 *   pipeline 工作。任何 backtest engine 调用 evaluate() 会收到一条 'hold'
 *   信号 + 提示信息 "请使用 generateSignals(date)"。
 *
 * 默认参数（AC 指定值）：
 *   maxPositions=5  minContinuousDays=1  maxContinuousDays=3  stopLossPct=-0.07
 *
 * 入场 5 条件（全部 AND）：
 *   1. 当日涨停（LimitUpStock 表存在记录）
 *   2. 连板数 ∈ [minContinuousDays, maxContinuousDays]
 *   3. 所属行业当日 main_inflow 排名 ∈ top topIndustries（默认 10）
 *   4. 龙虎榜出现知名游资席位且 famous_yz 净买入 > 0
 *   5. 流通市值 ∈ [minCirculatingMarketCap, maxCirculatingMarketCap]（默认 30-200 亿）
 *
 * 出场优先级（最先命中即触发；持仓状态决定）：
 *   A. 持有 ≥ holdingDaysLimit（默认 3）个自然日 → SELL 全部
 *   B. 当日跌幅（close - entry_price）/ entry_price ≤ stopLossPct → SELL 全部
 *   C. 次日炸板：今日不再涨停（不在 LimitUpStock 当日记录）→ SELL 全部
 *   D. 次日开盘高开 ≥ highOpenSellHalfPct（默认 5%）→ SELL 一半（sell_half）
 *   E. 否则 HOLD
 */

/** 默认参数（AC 指定值） */
export const DEFAULT_DRAGON_HEAD_PARAMS: Readonly<Required<DragonHeadParams>> = Object.freeze({
  maxPositions: 5,
  minContinuousDays: 1,
  maxContinuousDays: 3,
  stopLossPct: -0.07,
  topIndustries: 10,
  minCirculatingMarketCap: 30 * 1e8, // 30 亿
  maxCirculatingMarketCap: 200 * 1e8, // 200 亿
  holdingDaysLimit: 3, // 持有 N 自然日强制 SELL
  highOpenSellHalfPct: 0.05, // 次日开盘高开阈值
  excludeOneWordBoard: true, // 一字板不参与（买不到）
});

export interface DragonHeadParams {
  /** 最大同时持仓数（AC 默认 5） */
  maxPositions: number;
  /** 入选最小连板数（AC 默认 1：首板） */
  minContinuousDays: number;
  /** 入选最大连板数（AC 默认 3：三板封顶） */
  maxContinuousDays: number;
  /** 个股止损阈值（AC 默认 -0.07 = -7%） */
  stopLossPct: number;
  /** 行业强度 top-N 入围（默认 10） */
  topIndustries: number;
  /** 流通市值下限（元；默认 30 亿） */
  minCirculatingMarketCap: number;
  /** 流通市值上限（元；默认 200 亿） */
  maxCirculatingMarketCap: number;
  /** 持有 N 自然日强制 SELL（默认 3） */
  holdingDaysLimit: number;
  /** 次日开盘高开 SELL 一半的阈值（默认 0.05 = 5%） */
  highOpenSellHalfPct: number;
  /** 是否排除一字板（默认 true：一字板抢不到货） */
  excludeOneWordBoard: boolean;
}

/** 单只持仓的结构化记录（exit 规则需要 entry_date / entry_price） */
export interface DragonHeadPosition {
  stock_code: string;
  /** 进场日 ISO YYYY-MM-DD */
  entry_date: string;
  /** 进场价（用于止损与盈亏计算） */
  entry_price: number;
  /** 进场时的连板数（首板=1，二板=2，三板=3）；debug 用 */
  entry_continuous_days?: number;
  /** 是否已减半（high_open_sell_half 触发后置 true，防止重复减半） */
  half_exited?: boolean;
}

/** 单笔调仓信号 */
export interface DragonHeadSignal {
  stock_code: string;
  name?: string | null;
  industry?: string | null;
  /** buy=新进入选；sell=全平；sell_half=减半；hold=保留 */
  signal: 'buy' | 'sell' | 'sell_half' | 'hold';
  reason: string;
  /** 期望成交价（BUY=当日收盘；SELL/SELL_HALF=次日开盘/盘中价） */
  reference_price?: number;
  continuous_days?: number;
  industry_rank?: number;
  famous_yz_net_buy?: number;
  circulating_market_cap?: number;
}

/** 入场候选过滤维度统计 */
export interface DragonHeadFilteredStats {
  /** 当日涨停池规模（过滤前） */
  limit_up_pool_size: number;
  /** 一字板剔除数（excludeOneWordBoard=true 时） */
  one_word_board: number;
  /** 连板数范围外剔除数 */
  fail_continuous_days: number;
  /** 行业不在 top-N 剔除数 */
  fail_industry_top: number;
  /** 无行业数据 / 行业未知剔除数 */
  fail_industry_unknown: number;
  /** 缺元数据 / 没流通市值数据剔除数 */
  fail_meta_missing: number;
  /** 流通市值不在范围剔除数 */
  fail_market_cap: number;
  /** 没有知名游资净买入剔除数 */
  fail_famous_yz: number;
}

export interface DragonHeadSignalsResult {
  trade_date: string;
  /** 调仓后目标持仓（含已持有保留 + 新进 BUY；不含 SELL/SELL_HALF 剔除项） */
  target_positions: DragonHeadPosition[];
  /** 增量信号（BUY/SELL/SELL_HALF/HOLD） */
  signals: DragonHeadSignal[];
  /** 候选过滤维度统计 */
  filtered: DragonHeadFilteredStats;
  /** 实际生效参数（合并 default + override 后） */
  params: DragonHeadParams;
  /** 当日 eligible 入场候选总数（未受 maxPositions cap 前） */
  eligible_count: number;
}

export interface DragonHeadGenerateOptions {
  params?: Partial<DragonHeadParams>;
  /** 当前持仓（包含每只股票的 entry_date + entry_price）；不传视为首次评估（无 exit 流程） */
  currentPositions?: DragonHeadPosition[];
}

// ---------------------------------------------------------------------------
// DataSource 接口（便于测试用 fake 注入）
// ---------------------------------------------------------------------------

/**
 * 5 个 loader 方法 — 把所有 Sequelize 查询从策略主体抽离，便于单元测试 mock。
 *
 * 生产环境使用 DefaultDragonHeadDataSource（基于 LimitUpStock/IndustryFlow/
 * DragonTigerBoard/Stock/DailyBar）；单元测试传入 FakeDataSource。
 */
export interface DragonHeadDataSource {
  /** 当日涨停股池（含 continuous_days / industry / is_one_word_board） */
  loadLimitUpStocks(tradeDate: string): Promise<DragonHeadLimitUpRow[]>;

  /**
   * 当日行业 main_inflow 排名 top-N 的 industry_name 集合。
   * 返回 Set 便于 O(1) 命中检查；按主力净流入降序排，缺数据时返回空 Set。
   */
  loadTopIndustries(tradeDate: string, topN: number): Promise<Set<string>>;

  /**
   * 给定 (date, stockCodes)，返回每只股票的 famous_yz 净买入聚合值。
   * 只统计 is_famous_yz=true 的 row，按 stock_code 求 SUM(net_amount)。
   * 净买入 ≤ 0 的股票应当出现在 Map 中 (服务层只过滤 > 0)。
   */
  loadFamousYzNetBuy(tradeDate: string, stockCodes: string[]): Promise<Map<string, number>>;

  /**
   * 给定 stock_codes 集合的元数据（name / industry / circulating_market_cap）。
   * 缺失的 stock_code 可以不出现在返回 Map 中。
   */
  loadStockMeta(stockCodes: string[]): Promise<Map<string, DragonHeadStockMeta>>;

  /**
   * 给定 (tradeDate, stockCodes) 的当日行情快照（open/close/prev_close + 是否触及涨停）。
   * 用于 exit 规则的 high_open_sell_half / stop_loss / break_limit_up 判定。
   * 缺数据的 stock_code 可以不出现在返回 Map 中（出场逻辑会兜底跳过）。
   */
  loadDailyQuote(tradeDate: string, stockCodes: string[]): Promise<Map<string, DragonHeadQuote>>;
}

export interface DragonHeadLimitUpRow {
  stock_code: string;
  stock_name?: string | null;
  continuous_days: number;
  industry?: string | null;
  is_one_word_board: boolean;
  limit_up_time?: string | null;
}

export interface DragonHeadStockMeta {
  name?: string | null;
  industry?: string | null;
  circulating_market_cap?: number | null;
}

export interface DragonHeadQuote {
  open: number;
  close: number;
  high: number;
  low: number;
  prev_close: number;
  /** 当日是否触及涨停（涨幅 ≥ 9.9%）。用于 break_limit_up 判定 */
  hit_limit_up: boolean;
}

// ---------------------------------------------------------------------------
// 生产 DataSource 实现
// ---------------------------------------------------------------------------

/**
 * 默认数据源：直接走 Sequelize 模型。生产环境通过 PRODUCTION_DATA_SOURCE 单例
 * 使用；测试不应触碰这个类。
 */
export class DefaultDragonHeadDataSource implements DragonHeadDataSource {
  async loadLimitUpStocks(tradeDate: string): Promise<DragonHeadLimitUpRow[]> {
    const rows = (await LimitUpStock.findAll({
      attributes: [
        'stock_code',
        'stock_name',
        'continuous_days',
        'industry',
        'is_one_word_board',
        'limit_up_time',
      ],
      where: { trade_date: tradeDate },
      raw: true,
    })) as unknown as Array<{
      stock_code: string;
      stock_name?: string | null;
      continuous_days: number | string;
      industry?: string | null;
      is_one_word_board: boolean;
      limit_up_time?: string | null;
    }>;
    return rows.map(r => ({
      stock_code: r.stock_code,
      stock_name: r.stock_name ?? null,
      continuous_days:
        typeof r.continuous_days === 'string' ? Number(r.continuous_days) : r.continuous_days,
      industry: r.industry ?? null,
      is_one_word_board: Boolean(r.is_one_word_board),
      limit_up_time: r.limit_up_time ?? null,
    }));
  }

  async loadTopIndustries(tradeDate: string, topN: number): Promise<Set<string>> {
    if (topN <= 0) return new Set();
    const rows = (await IndustryFlow.findAll({
      attributes: ['industry_name', 'main_inflow'],
      where: {
        trade_date: tradeDate,
        main_inflow: { [Op.not]: null },
      },
      order: [[col('main_inflow'), 'DESC']],
      limit: topN,
      raw: true,
    })) as unknown as Array<{ industry_name: string; main_inflow: number | string }>;
    return new Set(rows.map(r => r.industry_name).filter(Boolean));
  }

  async loadFamousYzNetBuy(tradeDate: string, stockCodes: string[]): Promise<Map<string, number>> {
    if (!stockCodes.length) return new Map();
    // 用 SUM 聚合：famous_yz=true 的 row 按 stock_code 求和 net_amount
    const rows = (await DragonTigerBoard.findAll({
      attributes: ['stock_code', [fn('SUM', col('net_amount')), 'net_buy']],
      where: {
        trade_date: tradeDate,
        stock_code: { [Op.in]: stockCodes },
        is_famous_yz: true,
      },
      group: ['stock_code'],
      raw: true,
    })) as unknown as Array<{ stock_code: string; net_buy: number | string | null }>;
    const out = new Map<string, number>();
    for (const r of rows) {
      const v = typeof r.net_buy === 'string' ? Number(r.net_buy) : r.net_buy;
      if (v != null && Number.isFinite(v)) out.set(r.stock_code, v);
    }
    return out;
  }

  async loadStockMeta(stockCodes: string[]): Promise<Map<string, DragonHeadStockMeta>> {
    if (!stockCodes.length) return new Map();
    const symbols = stockCodes.map(c => guessStockSymbol(c));
    const rows = (await Stock.findAll({
      attributes: ['symbol', 'name', 'industry', 'circulating_market_cap'],
      where: { symbol: { [Op.in]: symbols } },
      raw: true,
    })) as unknown as Array<{
      symbol: string;
      name: string;
      industry: string | null;
      circulating_market_cap: number | string | null;
    }>;
    const out = new Map<string, DragonHeadStockMeta>();
    for (const r of rows) {
      const code = stripSuffix(r.symbol);
      const cap =
        typeof r.circulating_market_cap === 'string'
          ? Number(r.circulating_market_cap)
          : r.circulating_market_cap;
      out.set(code, {
        name: r.name ?? null,
        industry: r.industry ?? null,
        circulating_market_cap: cap != null && Number.isFinite(cap) ? cap : null,
      });
    }
    return out;
  }

  async loadDailyQuote(
    tradeDate: string,
    stockCodes: string[]
  ): Promise<Map<string, DragonHeadQuote>> {
    if (!stockCodes.length) return new Map();
    const symbols = stockCodes.map(c => guessStockSymbol(c));

    // 先拿到 stock_id → stock_code 映射
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

    // 拉 [as_of - 10 自然日, as_of] 的所有 bar，按 stock_id 分组挑当日 + 前一交易日。
    // 一次性查询代替 N 次 round-trip（之前每只股票一次 ORDER BY DESC LIMIT 1）。
    const lookbackStart = new Date(`${tradeDate}T00:00:00Z`);
    lookbackStart.setUTCDate(lookbackStart.getUTCDate() - 10);
    const bars = (await DailyBar.findAll({
      attributes: ['stock_id', 'time', 'open', 'high', 'low', 'close', 'change_percent'],
      where: {
        stock_id: { [Op.in]: stockIds },
        time: {
          [Op.gte]: lookbackStart.toISOString(),
          [Op.lte]: `${tradeDate}T23:59:59Z`,
        },
      },
      raw: true,
    })) as unknown as Array<{
      stock_id: number;
      time: Date | string;
      open: number | string;
      high: number | string;
      low: number | string;
      close: number | string;
      change_percent: number | string | null;
    }>;

    // 按 stock_id 分组 + 升序排
    const barsByStockId = new Map<
      number,
      Array<{
        timeMs: number;
        timeIso: string;
        open: number;
        high: number;
        low: number;
        close: number;
        change_percent: number | null;
      }>
    >();
    for (const b of bars) {
      const open = Number(b.open);
      const close = Number(b.close);
      if (!Number.isFinite(open) || !Number.isFinite(close)) continue;
      const tMs = b.time instanceof Date ? b.time.getTime() : new Date(b.time).getTime();
      if (!Number.isFinite(tMs)) continue;
      const tIso =
        b.time instanceof Date ? b.time.toISOString().slice(0, 10) : String(b.time).slice(0, 10);
      const arr = barsByStockId.get(b.stock_id) ?? [];
      arr.push({
        timeMs: tMs,
        timeIso: tIso,
        open,
        high: Number.isFinite(Number(b.high)) ? Number(b.high) : close,
        low: Number.isFinite(Number(b.low)) ? Number(b.low) : close,
        close,
        change_percent:
          b.change_percent != null && Number.isFinite(Number(b.change_percent))
            ? Number(b.change_percent)
            : null,
      });
      barsByStockId.set(b.stock_id, arr);
    }

    const out = new Map<string, DragonHeadQuote>();
    for (const [stockId, arr] of barsByStockId.entries()) {
      const code = idToCode.get(stockId);
      if (!code) continue;
      arr.sort((a, b) => a.timeMs - b.timeMs);
      // 找当日 bar：精确匹配 tradeDate
      const todayIdx = arr.findIndex(b => b.timeIso === tradeDate);
      if (todayIdx < 0) continue;
      const today = arr[todayIdx];
      // 找前一交易日：todayIdx - 1
      const prevIdx = todayIdx - 1;
      if (prevIdx < 0) continue;
      const prevClose = arr[prevIdx].close;
      if (!Number.isFinite(prevClose) || prevClose <= 0) continue;

      // 涨停判定：优先用 change_percent 字段；缺则用 (close-prev)/prev 算
      const changePct =
        today.change_percent != null
          ? today.change_percent / 100
          : (today.close - prevClose) / prevClose;
      out.set(code, {
        open: today.open,
        high: today.high,
        low: today.low,
        close: today.close,
        prev_close: prevClose,
        hit_limit_up: changePct >= 0.099,
      });
    }
    return out;
  }
}

const PRODUCTION_DATA_SOURCE: DragonHeadDataSource = new DefaultDragonHeadDataSource();

// ---------------------------------------------------------------------------
// 策略主体
// ---------------------------------------------------------------------------

export class DragonHeadMomentumStrategy extends QuantStrategy {
  readonly definition: QuantStrategyDefinition = {
    strategy_key: 'dragon_head_momentum',
    name: '短线龙头战法',
    description:
      '抓取强势行业内首板/低连板梯队龙头（涨停 + 连板 1-3 + 行业 top10 + 知名游资 + 流通市值 30-200 亿）。',
    category: 'momentum',
    default_params: { ...DEFAULT_DRAGON_HEAD_PARAMS },
    enabled: true,
    risk_level: 'high',
    tags: ['短线', '龙头', '梯队', '游资', '涨停板'],
  };

  private readonly dataSource: DragonHeadDataSource;

  constructor(dataSource: DragonHeadDataSource = PRODUCTION_DATA_SOURCE) {
    super();
    this.dataSource = dataSource;
  }

  /**
   * QuantStrategy 抽象基类要求的 per-stock evaluate()。
   *
   * 本策略是组合级，不通过单股 pipeline 工作；这里返回一条信息性 'hold'
   * 信号，让 per-stock backtest engine 不至于崩溃，但调用方应当走
   * generateSignals(date) 来获得真正的调仓信号。
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
      reasons: ['DragonHeadMomentum 是组合级策略，请使用 generateSignals(date) 获得调仓信号'],
      risk_flags: [],
      factors: {
        note: 'use_generateSignals_instead',
      },
    };
  }

  /**
   * 组合级调仓信号生成 — US-012 主入口。
   *
   * @param tradeDate ISO YYYY-MM-DD，当日交易日
   * @param options.params 覆盖 default_params 的部分字段
   * @param options.currentPositions 当前持仓（含 entry_date + entry_price）
   */
  async generateSignals(
    tradeDate: string,
    options: DragonHeadGenerateOptions = {}
  ): Promise<DragonHeadSignalsResult> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) {
      throw new Error(`generateSignals: invalid trade_date (expected YYYY-MM-DD): ${tradeDate}`);
    }

    const params = this.resolveParams(options.params);
    const currentPositions = options.currentPositions ?? [];

    // === Step A: Exit 流程（先处理出场，因为 BUY 用的 slot 数 = maxPositions - 保留 HOLD 数）
    const exitResults = await this.evaluateExits(tradeDate, currentPositions, params);

    // === Step B: 入场流程 —— 全市场扫描涨停股 → 5 维 AND 过滤 → 排序 → cap
    const entryEvaluation = await this.evaluateEntries(
      tradeDate,
      params,
      // 已经 HOLD 的 stock_code 集合：避免重复 BUY
      new Set(
        exitResults.signals
          .filter(s => s.signal === 'hold' || s.signal === 'sell_half')
          .map(s => s.stock_code)
      )
    );

    // === Step C: target_positions = HOLD + SELL_HALF（保留剩余仓位） + 新 BUY，cap 在 maxPositions
    // 出场动作映射：sell → 移除该 position；sell_half → 保留但标 half_exited=true；
    //              hold → 保留；buy → 新增。
    const kept: DragonHeadPosition[] = [];
    const sellMap = new Map(exitResults.signals.map(s => [s.stock_code, s]));
    for (const pos of currentPositions) {
      const sig = sellMap.get(pos.stock_code);
      if (!sig) {
        // 不应发生（exit 流程会给每只持仓一个 signal），兜底保留
        kept.push(pos);
        continue;
      }
      if (sig.signal === 'sell') continue; // 全平 → 移出
      if (sig.signal === 'sell_half') {
        kept.push({ ...pos, half_exited: true });
        continue;
      }
      // hold
      kept.push(pos);
    }

    // 剩余可用槽位
    const remainingSlots = Math.max(0, params.maxPositions - kept.length);
    const buyCandidates = entryEvaluation.candidates.slice(0, remainingSlots);

    const buySignals: DragonHeadSignal[] = buyCandidates.map(c => ({
      stock_code: c.stock_code,
      name: c.meta.name ?? null,
      industry: c.meta.industry ?? null,
      signal: 'buy',
      reason:
        `涨停 + 连板${c.limit_up_row.continuous_days}板 + 行业${c.industry_rank}名` +
        ` + 游资净买入${formatYi(c.famous_yz_net_buy)}亿 + 流通市值${formatYi(
          c.meta.circulating_market_cap ?? 0
        )}亿`,
      reference_price: c.reference_price,
      continuous_days: c.limit_up_row.continuous_days,
      industry_rank: c.industry_rank,
      famous_yz_net_buy: c.famous_yz_net_buy,
      circulating_market_cap: c.meta.circulating_market_cap ?? undefined,
    }));

    const newPositions: DragonHeadPosition[] = buyCandidates.map(c => ({
      stock_code: c.stock_code,
      entry_date: tradeDate,
      entry_price: c.reference_price,
      entry_continuous_days: c.limit_up_row.continuous_days,
      half_exited: false,
    }));

    const targetPositions = [...kept, ...newPositions];
    const allSignals = [...exitResults.signals, ...buySignals];

    logger.info(
      `DragonHeadMomentum.generateSignals(${tradeDate}): ` +
        `limit_up_pool=${entryEvaluation.filtered.limit_up_pool_size} ` +
        `eligible=${entryEvaluation.candidates.length} ` +
        `held_kept=${kept.length} buy=${buySignals.length} ` +
        `sell=${allSignals.filter(s => s.signal === 'sell').length} ` +
        `sell_half=${allSignals.filter(s => s.signal === 'sell_half').length} ` +
        `hold=${allSignals.filter(s => s.signal === 'hold').length}`
    );

    return {
      trade_date: tradeDate,
      target_positions: targetPositions,
      signals: allSignals,
      filtered: entryEvaluation.filtered,
      params,
      eligible_count: entryEvaluation.candidates.length,
    };
  }

  // -------------------------------------------------------------------------
  // 内部步骤
  // -------------------------------------------------------------------------

  /** 入场候选过滤 + 排序，不做 cap（cap 在主流程里基于 remainingSlots 做） */
  private async evaluateEntries(
    tradeDate: string,
    params: DragonHeadParams,
    excludeStockCodes: Set<string>
  ): Promise<{
    candidates: Array<{
      stock_code: string;
      limit_up_row: DragonHeadLimitUpRow;
      meta: DragonHeadStockMeta;
      industry_rank: number;
      famous_yz_net_buy: number;
      reference_price: number;
    }>;
    filtered: DragonHeadFilteredStats;
  }> {
    const filtered: DragonHeadFilteredStats = {
      limit_up_pool_size: 0,
      one_word_board: 0,
      fail_continuous_days: 0,
      fail_industry_top: 0,
      fail_industry_unknown: 0,
      fail_meta_missing: 0,
      fail_market_cap: 0,
      fail_famous_yz: 0,
    };

    // 1) 当日涨停池
    const limitUpRows = await this.dataSource.loadLimitUpStocks(tradeDate);
    filtered.limit_up_pool_size = limitUpRows.length;
    if (limitUpRows.length === 0) {
      return { candidates: [], filtered };
    }

    // 2) Top 行业 Set + industry → rank Map (1-based)
    const topSet = await this.dataSource.loadTopIndustries(tradeDate, params.topIndustries);
    const industryRank = new Map<string, number>();
    let rank = 1;
    for (const ind of topSet) industryRank.set(ind, rank++);

    // 3) 一字板过滤 + 连板范围过滤 + 行业过滤
    const stage1: DragonHeadLimitUpRow[] = [];
    for (const row of limitUpRows) {
      if (excludeStockCodes.has(row.stock_code)) continue;
      if (params.excludeOneWordBoard && row.is_one_word_board) {
        filtered.one_word_board += 1;
        continue;
      }
      const cd = row.continuous_days;
      if (cd < params.minContinuousDays || cd > params.maxContinuousDays) {
        filtered.fail_continuous_days += 1;
        continue;
      }
      if (!row.industry) {
        filtered.fail_industry_unknown += 1;
        continue;
      }
      if (!industryRank.has(row.industry)) {
        filtered.fail_industry_top += 1;
        continue;
      }
      stage1.push(row);
    }
    if (stage1.length === 0) {
      return { candidates: [], filtered };
    }

    // 4) 拉元数据（市值过滤）+ 龙虎榜净买入（游资过滤）
    const stockCodes = stage1.map(r => r.stock_code);
    const [metaMap, famousYzMap] = await Promise.all([
      this.dataSource.loadStockMeta(stockCodes),
      this.dataSource.loadFamousYzNetBuy(tradeDate, stockCodes),
    ]);

    const candidates: Array<{
      stock_code: string;
      limit_up_row: DragonHeadLimitUpRow;
      meta: DragonHeadStockMeta;
      industry_rank: number;
      famous_yz_net_buy: number;
      reference_price: number;
    }> = [];

    for (const row of stage1) {
      const meta = metaMap.get(row.stock_code);
      if (!meta || meta.circulating_market_cap == null) {
        filtered.fail_meta_missing += 1;
        continue;
      }
      const cap = meta.circulating_market_cap;
      if (cap < params.minCirculatingMarketCap || cap > params.maxCirculatingMarketCap) {
        filtered.fail_market_cap += 1;
        continue;
      }
      const netBuy = famousYzMap.get(row.stock_code);
      if (netBuy == null || netBuy <= 0) {
        filtered.fail_famous_yz += 1;
        continue;
      }
      // industry 已在 stage1 校验 → 安全访问
      const irank = industryRank.get(row.industry as string) ?? Number.MAX_SAFE_INTEGER;
      candidates.push({
        stock_code: row.stock_code,
        limit_up_row: row,
        meta,
        industry_rank: irank,
        famous_yz_net_buy: netBuy,
        // reference_price 用当日涨停价的近似：买不到只能等次日；我们用当日 stock.price
        // 作 fallback；缺数据时为 0（不影响信号生成，仅影响后续止损基准）。
        reference_price: 0, // 真实买入价由 PaperTrading 撮合时回填
      });
    }

    // 5) 排序：游资净买入降序 + tie-break stock_code 升序（稳定 + 可审计）
    candidates.sort((a, b) => {
      if (a.famous_yz_net_buy !== b.famous_yz_net_buy) {
        return b.famous_yz_net_buy - a.famous_yz_net_buy;
      }
      return a.stock_code.localeCompare(b.stock_code);
    });

    return { candidates, filtered };
  }

  /** Exit 流程：对每只 currentPositions 计算 signal */
  private async evaluateExits(
    tradeDate: string,
    currentPositions: DragonHeadPosition[],
    params: DragonHeadParams
  ): Promise<{ signals: DragonHeadSignal[] }> {
    if (currentPositions.length === 0) return { signals: [] };

    const codes = currentPositions.map(p => p.stock_code);
    const [quotes, todayLimitUp, metaMap] = await Promise.all([
      this.dataSource.loadDailyQuote(tradeDate, codes),
      this.dataSource.loadLimitUpStocks(tradeDate),
      this.dataSource.loadStockMeta(codes),
    ]);
    const todayLimitUpSet = new Set(todayLimitUp.map(r => r.stock_code));

    const signals: DragonHeadSignal[] = [];
    for (const pos of currentPositions) {
      const quote = quotes.get(pos.stock_code);
      const meta = metaMap.get(pos.stock_code);

      const holdingDays = naturalDaysBetween(pos.entry_date, tradeDate);

      // A. 持有 ≥ holdingDaysLimit → SELL（最高优先级）
      if (holdingDays >= params.holdingDaysLimit) {
        signals.push({
          stock_code: pos.stock_code,
          name: meta?.name ?? null,
          industry: meta?.industry ?? null,
          signal: 'sell',
          reason: `持有 ${holdingDays} 自然日 ≥ holdingDaysLimit(${params.holdingDaysLimit})，强制平仓`,
          reference_price: quote?.close,
        });
        continue;
      }

      // 缺当日行情数据 → 安全起见 HOLD（next day 会重新评估）
      if (!quote) {
        signals.push({
          stock_code: pos.stock_code,
          name: meta?.name ?? null,
          industry: meta?.industry ?? null,
          signal: 'hold',
          reason: '当日缺行情数据，HOLD 等下一交易日',
        });
        continue;
      }

      // B. 止损：(close - entry) / entry ≤ stopLossPct
      const pnlPct = (quote.close - pos.entry_price) / pos.entry_price;
      if (Number.isFinite(pnlPct) && pnlPct <= params.stopLossPct) {
        signals.push({
          stock_code: pos.stock_code,
          name: meta?.name ?? null,
          industry: meta?.industry ?? null,
          signal: 'sell',
          reason: `跌幅 ${(pnlPct * 100).toFixed(2)}% ≤ stopLossPct(${(
            params.stopLossPct * 100
          ).toFixed(2)}%)，止损`,
          reference_price: quote.close,
        });
        continue;
      }

      // C. 次日炸板：当日不在涨停池（首板/二板第二天没继续封板）
      // 注意：进场首日不触发此判定（hold 第 0 日 = 当日涨停日本身）
      if (holdingDays >= 1 && !todayLimitUpSet.has(pos.stock_code)) {
        signals.push({
          stock_code: pos.stock_code,
          name: meta?.name ?? null,
          industry: meta?.industry ?? null,
          signal: 'sell',
          reason: `次日未涨停（炸板/接力失败），SELL 全部`,
          reference_price: quote.close,
        });
        continue;
      }

      // D. 次日高开 ≥ highOpenSellHalfPct → sell_half（且未减半过）
      if (holdingDays >= 1 && !pos.half_exited) {
        const openPct = (quote.open - quote.prev_close) / quote.prev_close;
        if (Number.isFinite(openPct) && openPct >= params.highOpenSellHalfPct) {
          signals.push({
            stock_code: pos.stock_code,
            name: meta?.name ?? null,
            industry: meta?.industry ?? null,
            signal: 'sell_half',
            reason: `次日开盘高开 ${(openPct * 100).toFixed(2)}% ≥ ${(
              params.highOpenSellHalfPct * 100
            ).toFixed(2)}%，SELL 一半`,
            reference_price: quote.open,
          });
          continue;
        }
      }

      // E. 都不触发 → HOLD
      signals.push({
        stock_code: pos.stock_code,
        name: meta?.name ?? null,
        industry: meta?.industry ?? null,
        signal: 'hold',
        reason: `继续持有（持有 ${holdingDays} 日，pnl=${(pnlPct * 100).toFixed(2)}%）`,
      });
    }

    return { signals };
  }

  /**
   * 合并 default_params + override。
   *
   * 与 MultiFactorAlpha 的差异：本策略没有 Record 类型参数（全是标量），
   * 所以直接 spread 合并是安全的，不会踩 "spread merge 偷藏 default" 的坑。
   */
  private resolveParams(override?: Partial<DragonHeadParams>): DragonHeadParams {
    const def = this.definition.default_params as Required<DragonHeadParams>;
    return {
      maxPositions: override?.maxPositions ?? def.maxPositions,
      minContinuousDays: override?.minContinuousDays ?? def.minContinuousDays,
      maxContinuousDays: override?.maxContinuousDays ?? def.maxContinuousDays,
      stopLossPct: override?.stopLossPct ?? def.stopLossPct,
      topIndustries: override?.topIndustries ?? def.topIndustries,
      minCirculatingMarketCap: override?.minCirculatingMarketCap ?? def.minCirculatingMarketCap,
      maxCirculatingMarketCap: override?.maxCirculatingMarketCap ?? def.maxCirculatingMarketCap,
      holdingDaysLimit: override?.holdingDaysLimit ?? def.holdingDaysLimit,
      highOpenSellHalfPct: override?.highOpenSellHalfPct ?? def.highOpenSellHalfPct,
      excludeOneWordBoard: override?.excludeOneWordBoard ?? def.excludeOneWordBoard,
    };
  }
}

// ---------------------------------------------------------------------------
// 内部 helpers（仅本文件 + .test.ts 复用）
// ---------------------------------------------------------------------------

/** 自然日差（不算交易日，简单 ISO 日期相减）。entry=tradeDate 时返回 0 */
export function naturalDaysBetween(entryDate: string, tradeDate: string): number {
  const a = new Date(`${entryDate}T00:00:00Z`).getTime();
  const b = new Date(`${tradeDate}T00:00:00Z`).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  const diff = (b - a) / (1000 * 60 * 60 * 24);
  return Math.max(0, Math.round(diff));
}

/** 元 → 亿 简化显示（reason 字符串用） */
function formatYi(amountInYuan: number): string {
  if (!Number.isFinite(amountInYuan)) return '0';
  return (amountInYuan / 1e8).toFixed(2);
}

function stripSuffix(symbol: string | null | undefined): string {
  if (!symbol) return '';
  const i = symbol.indexOf('.');
  return i < 0 ? symbol : symbol.slice(0, i);
}

function guessStockSymbol(stockCode: string): string {
  if (!stockCode) return '';
  if (stockCode.includes('.')) return stockCode;
  const head = stockCode[0];
  if (head === '6') return `${stockCode}.SH`;
  if (head === '0' || head === '3') return `${stockCode}.SZ`;
  if (head === '4' || head === '8') return `${stockCode}.BJ`;
  return `${stockCode}.SZ`;
}
