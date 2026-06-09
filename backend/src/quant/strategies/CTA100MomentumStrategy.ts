import { Op } from 'sequelize';
import { QuantStrategy } from './QuantStrategy';
import {
  QuantSignalResult,
  QuantStockContext,
  QuantStrategyDefinition,
  QuantStrategyRuntimeOptions,
} from '../types/QuantTypes';
import { IndexComponent } from '../../models/IndexComponent';
import { Stock } from '../../models/Stock';
import { DailyBar } from '../../models/DailyBar';
import { logger } from '../../utils/logger';
import { isSTName } from '../../utils/stNameUtils';

/**
 * CTA100MomentumStrategy — 中证 1000 成份股动量策略（US-020）
 *
 * 第 5 个组合级策略（前 4: MultiFactorAlpha / DragonHead / EarningsSurprise /
 * NorthboundFollow）。新增的 "小盘风格 + 指数受限 universe" 范式：
 *
 *   - **股票池受限于指数成份股**（默认中证 1000，index_code='000852'），
 *     而不是全市场扫描——和 MultiFactorAlpha 等"全市场打分"明显区分。
 *   - **动量因子写死在策略内**（60 日涨幅 - 5 日涨幅，剔除短期超涨噪音），
 *     不依赖 factor_scores 表——这条选择让 CTA100 在 factor_scores 还没回填
 *     的历史窗口里也能跑。
 *   - **月度调仓 + 行业中性 cap**（每行业最多 3 只）：与 MultiFactor 模式一致。
 *
 * 动量公式：raw_momentum = close[T-5] / close[T-60] - 1
 *   - 60 日涨幅本身减去最近 5 日涨幅（这是 AC 表述"60 日涨幅 - 5 日涨幅"的
 *     等价写法 — 经典 12-1 / 60-5 学术因子，A 股短期反转尤其强）。
 *   - 数学上：T-5 到 T-60 的反向区间涨幅 = (close[T-5] / close[T-60]) - 1。
 *
 * 入场（每月调仓）：
 *   1. 股票池 = (trade_date, index_code) 的成份股快照；月度调仓拿最新一日成份。
 *   2. 计算每只股票的 raw_momentum；缺历史的剔除（lookbackDays + 5 个交易日不够）。
 *   3. 非 ST（默认 excludeST=true）。
 *   4. 行业中性（默认 industryNeutral=true，单行业 ≤ maxPerIndustry=3）。
 *   5. 取 top-N（默认 30）。
 *
 * 调仓信号 BUY/SELL/HOLD：与 MultiFactorAlpha 同款 string[] previousSelection 差集。
 *
 * 与现有 RelativeStrengthMomentumStrategy（per-stock）的区别：
 *   - RSM 是 per-stock evaluate，按 universe 全集分别打分；
 *   - 本策略限定 universe 到中证 1000，做横截面 top-N — 不可表达成 per-stock。
 *
 * 默认参数（AC 指定）：
 *   indexCode='000852'  topN=30  rebalancePeriod='monthly'
 *   industryNeutral=true  maxPerIndustry=3  excludeST=true
 *   lookbackDays=60  skipRecentDays=5
 */

/** 默认权重不可变冻结，避免被 caller 误修改 */
export const DEFAULT_CTA100_MOMENTUM_PARAMS: Readonly<Required<CTA100MomentumParams>> =
  Object.freeze({
    indexCode: '000852',
    topN: 30,
    rebalancePeriod: 'monthly',
    industryNeutral: true,
    maxPerIndustry: 3,
    excludeST: true,
    lookbackDays: 60,
    skipRecentDays: 5,
  });

export type CTA100MomentumRebalancePeriod = 'daily' | 'weekly' | 'monthly';

export interface CTA100MomentumParams {
  /** 指数代码（默认 '000852' 中证 1000）— 切换 '000905' 可变 CSI 500 动量 */
  indexCode: string;
  /** Top-N 持股（AC 默认 30） */
  topN: number;
  /** 调仓频率（仅元数据；触发时点由调用方决定） */
  rebalancePeriod: CTA100MomentumRebalancePeriod;
  /** 行业中性开关 */
  industryNeutral: boolean;
  /** industryNeutral=true 时单行业上限（AC 默认 3） */
  maxPerIndustry: number;
  /** 剔除 ST / *ST */
  excludeST: boolean;
  /** 动量长窗口（默认 60 交易日） */
  lookbackDays: number;
  /** 短期反转窗口（默认 5 交易日；从 raw_momentum 中剔除） */
  skipRecentDays: number;
}

/** 单只股票的调仓信号 */
export interface CTA100MomentumSignal {
  stock_code: string;
  name?: string | null;
  industry?: string | null;
  signal: 'buy' | 'sell' | 'hold';
  /** 动量值 = close[T-skipRecentDays] / close[T-lookbackDays] - 1 */
  momentum: number;
  reason: string;
}

export interface CTA100MomentumFilteredStats {
  /** 当日指数成份股总数（universe 起点） */
  universe_size: number;
  /** 历史 bar 不足 lookbackDays + skipRecentDays 个交易日剔除数 */
  fail_insufficient_history: number;
  /** 缺当日 close 无法当 reference_price，剔除数 */
  fail_missing_close: number;
  /** ST 剔除数 */
  fail_st: number;
  /** 缺元数据（无 Stock 行）剔除数 */
  fail_meta_missing: number;
  /** 行业中性 cap 已挤掉数 */
  industry_capped: number;
}

export interface CTA100MomentumSignalsResult {
  trade_date: string;
  /** 调仓后目标组合（top-N stock_code 列表，已应用行业中性） */
  target_portfolio: string[];
  /** 全部增量信号：BUY 新进 + SELL 剔除 + HOLD 保留 */
  signals: CTA100MomentumSignal[];
  filtered: CTA100MomentumFilteredStats;
  /** 实际生效的参数（合并 default + override 后） */
  params: CTA100MomentumParams;
  /** 通过所有过滤的有效候选数（在行业中性 cap 之前） */
  eligible_count: number;
}

export interface CTA100MomentumGenerateOptions {
  /** override default_params 中的部分字段 */
  params?: Partial<CTA100MomentumParams>;
  /** 当前持仓 stock_code 数组；不传则全部 target 视为 BUY（首次开仓） */
  previousSelection?: string[];
}

// ---------------------------------------------------------------------------
// DataSource 接口（便于单测注入 fake）
// ---------------------------------------------------------------------------

/**
 * 3 个 loader 方法 — 把 Sequelize 查询从策略主体抽离。
 *
 *   - `loadIndexUniverse`：取 (asOfDate, indexCode) 的最新一日成份股列表。
 *     "最新一日" 而不是 "asOfDate 当日" — 指数成份月内基本不动，allow staleness
 *     避免月初调仓时正好缺当日 sync。具体逻辑：找 ≤ asOfDate 的最大 trade_date。
 *   - `loadMomentumBars`：批量返回每只股票最近 (lookbackDays + skipRecentDays +
 *     buffer) 个交易日的 close 价；缺数据的股票不出现在 Map 中（与
 *     EarningsSurprise loader 同款契约）。
 *   - `loadStockMeta`：与 MultiFactorAlpha 同款（name + industry）。
 */
export interface CTA100MomentumDataSource {
  loadIndexUniverse(asOfDate: string, indexCode: string): Promise<IndexUniverseSnapshot>;
  loadMomentumBars(
    asOfDate: string,
    stockCodes: string[],
    minTradingDays: number
  ): Promise<Map<string, MomentumBar[]>>;
  loadStockMeta(stockCodes: string[]): Promise<Map<string, CTA100StockMeta>>;
}

export interface IndexUniverseSnapshot {
  /** 用作 universe 的快照日（≤ asOfDate 的最大 trade_date；空集时返回 null） */
  snapshot_date: string | null;
  /** 成份股 stock_code 列表（无后缀） */
  stock_codes: string[];
}

export interface MomentumBar {
  /** ISO 日期 YYYY-MM-DD */
  trade_date: string;
  close: number;
}

export interface CTA100StockMeta {
  name?: string | null;
  industry?: string | null;
}

// ---------------------------------------------------------------------------
// 生产 DataSource 实现
// ---------------------------------------------------------------------------

export class DefaultCTA100MomentumDataSource implements CTA100MomentumDataSource {
  async loadIndexUniverse(asOfDate: string, indexCode: string): Promise<IndexUniverseSnapshot> {
    // 查 ≤ asOfDate 的最新一日成份股快照
    const latest = (await IndexComponent.findOne({
      attributes: ['trade_date'],
      where: {
        index_code: indexCode,
        trade_date: { [Op.lte]: asOfDate },
      },
      order: [['trade_date', 'DESC']],
      raw: true,
    })) as unknown as { trade_date: string } | null;

    if (!latest) return { snapshot_date: null, stock_codes: [] };

    const rows = (await IndexComponent.findAll({
      attributes: ['stock_code'],
      where: { index_code: indexCode, trade_date: latest.trade_date },
      raw: true,
    })) as unknown as Array<{ stock_code: string }>;

    return {
      snapshot_date: latest.trade_date,
      stock_codes: rows.map(r => r.stock_code),
    };
  }

  async loadMomentumBars(
    asOfDate: string,
    stockCodes: string[],
    minTradingDays: number
  ): Promise<Map<string, MomentumBar[]>> {
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

    // 拉 [as_of - lookbackCalendarDays, as_of] 范围。
    // minTradingDays 默认 60+5=65 个交易日，A 股节假日折算 + buffer ≈ 2 倍自然日。
    // 取 minTradingDays * 2 + 30 作为日历日窗口，覆盖春节/十一 9-10 天连假。
    const lookbackCalendarDays = minTradingDays * 2 + 30;
    const lookbackStart = new Date(`${asOfDate}T00:00:00Z`);
    lookbackStart.setUTCDate(lookbackStart.getUTCDate() - lookbackCalendarDays);

    const bars = (await DailyBar.findAll({
      attributes: ['stock_id', 'time', 'close'],
      where: {
        stock_id: { [Op.in]: stockIds },
        time: {
          [Op.gte]: lookbackStart.toISOString(),
          [Op.lte]: `${asOfDate}T23:59:59Z`,
        },
      },
      raw: true,
    })) as unknown as Array<{
      stock_id: number;
      time: Date | string;
      close: number | string;
    }>;

    const byCode = new Map<string, MomentumBar[]>();
    for (const b of bars) {
      const close = Number(b.close);
      if (!Number.isFinite(close)) continue;
      const code = idToCode.get(b.stock_id);
      if (!code) continue;
      const tIso =
        b.time instanceof Date ? b.time.toISOString().slice(0, 10) : String(b.time).slice(0, 10);
      const arr = byCode.get(code) ?? [];
      arr.push({ trade_date: tIso, close });
      byCode.set(code, arr);
    }

    // 按 trade_date 升序排序便于策略层 indexing
    for (const arr of byCode.values()) {
      arr.sort((a, b) => a.trade_date.localeCompare(b.trade_date));
    }
    return byCode;
  }

  async loadStockMeta(stockCodes: string[]): Promise<Map<string, CTA100StockMeta>> {
    if (!stockCodes.length) return new Map();
    const symbols = stockCodes.map(c => guessStockSymbol(c));
    const rows = (await Stock.findAll({
      attributes: ['symbol', 'name', 'industry'],
      where: { symbol: { [Op.in]: symbols } },
      raw: true,
    })) as unknown as Array<{
      symbol: string;
      name: string;
      industry: string | null;
    }>;
    const out = new Map<string, CTA100StockMeta>();
    for (const r of rows) {
      const code = stripSuffix(r.symbol);
      out.set(code, { name: r.name ?? null, industry: r.industry ?? null });
    }
    return out;
  }
}

const PRODUCTION_DATA_SOURCE: CTA100MomentumDataSource = new DefaultCTA100MomentumDataSource();

// ---------------------------------------------------------------------------
// 策略主体
// ---------------------------------------------------------------------------

export class CTA100MomentumStrategy extends QuantStrategy {
  readonly definition: QuantStrategyDefinition = {
    strategy_key: 'cta100_momentum',
    name: '中证 1000 动量月度轮动',
    description:
      '在中证 1000 成份股内按 60 日动量（剔除最近 5 日反转）选 top 30，月度调仓，行业中性（单行业 ≤ 3 只）。',
    category: 'momentum',
    default_params: { ...DEFAULT_CTA100_MOMENTUM_PARAMS },
    enabled: true,
    risk_level: 'high',
    tags: ['中证1000', '小盘', '动量', '月度轮动', '行业中性'],
    style: 'small_cap_growth',
  };

  private readonly dataSource: CTA100MomentumDataSource;

  constructor(dataSource: CTA100MomentumDataSource = PRODUCTION_DATA_SOURCE) {
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
      target_holding_days: 20,
      reasons: ['CTA100Momentum 是组合级策略，请使用 generateSignals(date) 获得调仓信号'],
      risk_flags: [],
      factors: {
        note: 'use_generateSignals_instead',
      },
    };
  }

  /**
   * 组合级调仓信号生成 — US-020 主入口。
   *
   * @param tradeDate ISO YYYY-MM-DD，当月调仓决策日
   * @param options.params 覆盖 default_params 的部分字段
   * @param options.previousSelection 当前持仓 stock_code 数组
   */
  async generateSignals(
    tradeDate: string,
    options: CTA100MomentumGenerateOptions = {}
  ): Promise<CTA100MomentumSignalsResult> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) {
      throw new Error(`generateSignals: invalid trade_date (expected YYYY-MM-DD): ${tradeDate}`);
    }

    const params = this.resolveParams(options.params);
    if (params.lookbackDays <= params.skipRecentDays) {
      throw new Error(
        `generateSignals: lookbackDays(${params.lookbackDays}) must be greater than skipRecentDays(${params.skipRecentDays})`
      );
    }

    // 1) 取指数成份股 universe
    const universeSnap = await this.dataSource.loadIndexUniverse(tradeDate, params.indexCode);
    const universe = universeSnap.stock_codes;
    const filtered: CTA100MomentumFilteredStats = {
      universe_size: universe.length,
      fail_insufficient_history: 0,
      fail_missing_close: 0,
      fail_st: 0,
      fail_meta_missing: 0,
      industry_capped: 0,
    };

    if (universe.length === 0) {
      logger.warn(
        `CTA100Momentum.generateSignals(${tradeDate}): empty universe for index ${params.indexCode}; ` +
          `did sync-index-components run?`
      );
      return this.emptyResult(tradeDate, params, filtered);
    }

    // 2) 拉历史 bar + 元数据并发查
    const minTradingDays = params.lookbackDays + params.skipRecentDays + 2; // +2 buffer
    const [barsMap, metaMap] = await Promise.all([
      this.dataSource.loadMomentumBars(tradeDate, universe, minTradingDays),
      this.dataSource.loadStockMeta(universe),
    ]);

    // 3) 计算 momentum + 过滤
    const candidates: Array<{
      stock_code: string;
      meta: CTA100StockMeta;
      momentum: number;
    }> = [];

    for (const stockCode of universe) {
      const bars = barsMap.get(stockCode);
      // 历史不足 lookbackDays + skipRecentDays + 1
      const minBarLen = params.lookbackDays + params.skipRecentDays + 1;
      if (!bars || bars.length < minBarLen) {
        filtered.fail_insufficient_history += 1;
        continue;
      }

      // 从尾部 indexing：bars 已升序，最末一条 = 最新 bar
      // close[T-skipRecentDays] = bars[bars.length - 1 - skipRecentDays].close
      // close[T-lookbackDays]   = bars[bars.length - 1 - lookbackDays].close
      // 这里"T-N"以交易日计（节假日 gap 已被 sorted bars 自然吸收）。
      const closeShort = bars[bars.length - 1 - params.skipRecentDays].close;
      const closeLong = bars[bars.length - 1 - params.lookbackDays].close;
      if (!Number.isFinite(closeShort) || !Number.isFinite(closeLong) || closeLong <= 0) {
        filtered.fail_missing_close += 1;
        continue;
      }
      const momentum = closeShort / closeLong - 1;
      if (!Number.isFinite(momentum)) {
        filtered.fail_missing_close += 1;
        continue;
      }

      const meta = metaMap.get(stockCode);
      if (!meta) {
        filtered.fail_meta_missing += 1;
        continue;
      }

      if (params.excludeST && isSTName(meta.name)) {
        filtered.fail_st += 1;
        continue;
      }

      candidates.push({ stock_code: stockCode, meta, momentum });
    }

    // 4) 排序：momentum 降序 + stock_code 稳定 tie-break
    candidates.sort((a, b) => {
      if (a.momentum !== b.momentum) return b.momentum - a.momentum;
      return a.stock_code.localeCompare(b.stock_code);
    });

    // 5) 行业中性 + top-N
    const selected: typeof candidates = [];
    const industryCount = new Map<string, number>();
    const FALLBACK_INDUSTRY_KEY = '__未知行业__';
    for (const cand of candidates) {
      if (selected.length >= params.topN) break;
      if (params.industryNeutral) {
        const key = cand.meta.industry || FALLBACK_INDUSTRY_KEY;
        const cur = industryCount.get(key) ?? 0;
        if (cur >= params.maxPerIndustry) {
          filtered.industry_capped += 1;
          continue;
        }
        industryCount.set(key, cur + 1);
      }
      selected.push(cand);
    }

    const targetPortfolio = selected.map(c => c.stock_code);
    const targetSet = new Set(targetPortfolio);
    const previousSet = new Set(options.previousSelection ?? []);

    // 6) BUY / HOLD / SELL 增量
    const signals: CTA100MomentumSignal[] = [];

    for (const c of selected) {
      const isHeld = previousSet.has(c.stock_code);
      signals.push({
        stock_code: c.stock_code,
        name: c.meta.name ?? null,
        industry: c.meta.industry ?? null,
        signal: isHeld ? 'hold' : 'buy',
        momentum: c.momentum,
        reason: isHeld
          ? `保留持仓：动量=${(c.momentum * 100).toFixed(2)}%`
          : `新进入选：动量=${(c.momentum * 100).toFixed(2)}%`,
      });
    }

    // SELL = previous ∩ ¬target — 用 candidates Map 反查 momentum，缺时显示 NaN
    const candidateMomentum = new Map(candidates.map(c => [c.stock_code, c.momentum]));
    for (const prevCode of previousSet) {
      if (targetSet.has(prevCode)) continue;
      const meta = metaMap.get(prevCode) ?? {};
      const momentum = candidateMomentum.get(prevCode);
      signals.push({
        stock_code: prevCode,
        name: meta.name ?? null,
        industry: meta.industry ?? null,
        signal: 'sell',
        momentum: momentum ?? 0,
        reason: `跌出 top-${params.topN}${
          momentum !== undefined ? `：动量=${(momentum * 100).toFixed(2)}%` : '（候选池外）'
        }`,
      });
    }

    logger.info(
      `CTA100Momentum.generateSignals(${tradeDate}): index=${params.indexCode} ` +
        `snapshot=${universeSnap.snapshot_date ?? 'none'} universe=${universe.length} ` +
        `eligible=${candidates.length} target=${targetPortfolio.length} ` +
        `buy=${signals.filter(s => s.signal === 'buy').length} ` +
        `sell=${signals.filter(s => s.signal === 'sell').length} ` +
        `hold=${signals.filter(s => s.signal === 'hold').length}`
    );

    return {
      trade_date: tradeDate,
      target_portfolio: targetPortfolio,
      signals,
      filtered,
      params,
      eligible_count: candidates.length,
    };
  }

  /** 空 universe 兜底返回 */
  private emptyResult(
    tradeDate: string,
    params: CTA100MomentumParams,
    filtered: CTA100MomentumFilteredStats
  ): CTA100MomentumSignalsResult {
    return {
      trade_date: tradeDate,
      target_portfolio: [],
      signals: [],
      filtered,
      params,
      eligible_count: 0,
    };
  }

  /** 合并 default_params + override */
  private resolveParams(override?: Partial<CTA100MomentumParams>): CTA100MomentumParams {
    const def = this.definition.default_params as Required<CTA100MomentumParams>;
    return {
      indexCode: override?.indexCode ?? def.indexCode,
      topN: override?.topN ?? def.topN,
      rebalancePeriod: override?.rebalancePeriod ?? def.rebalancePeriod,
      industryNeutral: override?.industryNeutral ?? def.industryNeutral,
      maxPerIndustry: override?.maxPerIndustry ?? def.maxPerIndustry,
      excludeST: override?.excludeST ?? def.excludeST,
      lookbackDays: override?.lookbackDays ?? def.lookbackDays,
      skipRecentDays: override?.skipRecentDays ?? def.skipRecentDays,
    };
  }
}

// ---------------------------------------------------------------------------
// 内部 helpers（exported for tests）
// ---------------------------------------------------------------------------

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
