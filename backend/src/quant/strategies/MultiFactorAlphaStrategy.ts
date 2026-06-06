import { Op } from 'sequelize';
import { QuantStrategy } from './QuantStrategy';
import {
  QuantSignalResult,
  QuantStockContext,
  QuantStrategyDefinition,
  QuantStrategyRuntimeOptions,
} from '../types/QuantTypes';
import { FactorScore } from '../../models/FactorScore';
import { Stock } from '../../models/Stock';
import { logger } from '../../utils/logger';

/**
 * MultiFactorAlphaStrategy — 8 因子加权多因子选股策略（US-011）
 *
 * 与现有 `MultiFactorRankingStrategy`（per-stock evaluate）的关键区别：
 *
 *   - 数据源：本策略**直接读 factor_scores 表**（US-009 Pipeline 产出），
 *     使用横截面 z_score 加权合成，**不**重新计算技术指标。
 *   - 工作模式：**组合级 generateSignals(date)** 一次性产出当日全市场
 *     top-N 调仓建议，而不是单股逐一打分。
 *   - 触发频率：默认月度调仓（rebalancePeriod='monthly'），调用方负责
 *     在每月第一个交易日触发 generateSignals(date)，并传入当前持仓
 *     `previousSelection` 来计算 BUY / SELL / HOLD 增量信号。
 *
 * 与现有 QuantStrategy 基类的 evaluate() 兼容性：
 *   evaluate() 被实现为"信息性 hold"——本策略本质是组合级，不通过
 *   per-stock pipeline 工作。任何 backtest engine 调用 evaluate() 会
 *   收到一条 'hold' 信号 + 提示信息"请使用 generateSignals(date)"。
 *
 * 默认权重（AC 要求）：
 *   value=0.15  quality=0.15  growth=0.15  momentum=0.15
 *   low_vol=0.10  northbound=0.10  money_flow=0.10  dragon_tiger=0.10
 *
 * 过滤规则：
 *   - excludeST（默认 true）：股票名以 'ST' / '*ST' / 'S' 开头剔除
 *   - excludeNew60d（默认 true）：listing_date 在 as_of 前 60 自然日内剔除
 *   - industryNeutral（默认 true）：行业中性，每行业最多 maxPerIndustry（默认 3）只
 *
 * 设计要点：
 *   1. 通过 dataSource 接口注入数据读取，便于单元测试 mock（见 .test.ts）
 *   2. 权重归一化：用户可传未归一化权重，策略内部 sum-normalize 到 1.0
 *   3. 缺失因子的处理：用 z_score=0 中性补全（与 Pipeline 中性行语义一致）
 *   4. 排序稳定性：composite_score 相同时按 stock_code 升序定序，
 *      保证同一日重跑结果完全一致（重要：用于审计与对账）
 */

/** 因子默认权重（AC 指定值，总和 = 1.0） */
export const DEFAULT_MULTI_FACTOR_ALPHA_WEIGHTS: Readonly<Record<string, number>> = Object.freeze({
  value: 0.15,
  quality: 0.15,
  growth: 0.15,
  momentum: 0.15,
  low_vol: 0.1,
  northbound: 0.1,
  money_flow: 0.1,
  dragon_tiger: 0.1,
});

export type MultiFactorAlphaRebalancePeriod = 'daily' | 'weekly' | 'monthly';

export interface MultiFactorAlphaParams {
  /** Top-N 持股数量（AC 默认 30） */
  topN: number;
  /** 调仓频率（仅用于策略元数据；触发时点由调用方决定） */
  rebalancePeriod: MultiFactorAlphaRebalancePeriod;
  /** 行业中性开关（true = 单行业最多 maxPerIndustry 只） */
  industryNeutral: boolean;
  /** industryNeutral=true 时单行业上限（AC 默认 3） */
  maxPerIndustry: number;
  /** 剔除 ST / *ST 股票 */
  excludeST: boolean;
  /** 剔除上市 60 自然日内的次新股 */
  excludeNew60d: boolean;
  /** 因子权重 (factor_name → weight)。未指定的因子权重默认 0 */
  weights: Record<string, number>;
}

/** 单只股票的调仓信号 */
export interface MultiFactorAlphaSignal {
  stock_code: string;
  name?: string | null;
  industry?: string | null;
  signal: 'buy' | 'sell' | 'hold';
  /** 加权合成后的总分（z_score 加权求和；未归一化） */
  composite_score: number;
  /** 各因子的 z_score（debug / 审计用） */
  factor_z_scores: Record<string, number>;
  /** 一句话原因 */
  reason: string;
}

/** generateSignals 的完整结果 */
export interface MultiFactorAlphaSignalsResult {
  trade_date: string;
  /** 调仓后目标组合（top-N stock_code 列表，已应用行业中性） */
  target_portfolio: string[];
  /** 全部增量信号：BUY 新进 + SELL 剔除 + HOLD 保留 */
  signals: MultiFactorAlphaSignal[];
  /** 各过滤维度被剔除的股票数（调试 / UI 展示用） */
  filtered: {
    /** ST 过滤剔除数 */
    st: number;
    /** 次新股（< 60 日）剔除数 */
    new60d: number;
    /** 行业中性 cap 剔除数（候选中已挤掉的） */
    industry_capped: number;
    /** 因子覆盖率 = 0（全 8 因子 z_score 全部为中性 0）剔除数 */
    no_factor_data: number;
  };
  /** 实际生效的参数（合并 default + override 后） */
  params: MultiFactorAlphaParams;
  /** 候选池规模（过滤前） */
  universe_size: number;
  /** 通过所有过滤的有效候选数 */
  eligible_count: number;
}

export interface MultiFactorAlphaGenerateOptions {
  /** override default_params 中的部分参数 */
  params?: Partial<MultiFactorAlphaParams>;
  /** 当前持仓（stock_code 数组）；用于计算 BUY/SELL/HOLD 增量。
   *  不传则全部 target_portfolio 视为 BUY（首次开仓场景）。 */
  previousSelection?: string[];
}

/**
 * 数据源接口 — 把 Sequelize 查询从策略主体抽离，便于测试。
 *
 * 生产环境用 DefaultMultiFactorAlphaDataSource（基于 FactorScore + Stock）；
 * 单元测试传入实现该接口的 FakeDataSource（见 .test.ts）。
 */
export interface MultiFactorAlphaDataSource {
  /**
   * 读取指定交易日 + 指定因子集合的全市场 z_score。
   * 返回 Map<stock_code, Map<factor_name, z_score>>。
   * 中性行（raw_value=null）的 z_score 应正常返回 0。
   */
  loadFactorScores(
    tradeDate: string,
    factorNames: string[]
  ): Promise<Map<string, Map<string, number>>>;

  /**
   * 读取给定 stock_code 集合的元数据（name / industry / listing_date）。
   * 缺失的 stock_code 不需要出现在返回 Map 中。
   */
  loadStockMeta(stockCodes: string[]): Promise<Map<string, StockMeta>>;
}

export interface StockMeta {
  name?: string | null;
  industry?: string | null;
  /** 上市日期 ISO YYYY-MM-DD；null 表示未知 */
  listing_date?: string | null;
}

/**
 * 生产环境数据源 — 直接走 Sequelize。
 *
 * factor_scores 表：(trade_date, stock_code, factor_name) 复合 PK，每个
 * (date, factor) 都写了 universe 全集（含中性行），所以一次性查 N 个因子
 * = N × universe 行（5000 只 × 8 因子 = 40k 行/日，单查询毫秒级）。
 */
export class DefaultMultiFactorAlphaDataSource implements MultiFactorAlphaDataSource {
  async loadFactorScores(
    tradeDate: string,
    factorNames: string[]
  ): Promise<Map<string, Map<string, number>>> {
    if (!factorNames.length) return new Map();
    const rows = (await FactorScore.findAll({
      attributes: ['stock_code', 'factor_name', 'z_score'],
      where: {
        trade_date: tradeDate,
        factor_name: { [Op.in]: factorNames },
      },
      raw: true,
    })) as unknown as Array<{ stock_code: string; factor_name: string; z_score: number | string }>;

    const out = new Map<string, Map<string, number>>();
    for (const r of rows) {
      const code = r.stock_code;
      const factor = r.factor_name;
      const z = typeof r.z_score === 'string' ? Number(r.z_score) : r.z_score;
      if (!Number.isFinite(z)) continue;
      let inner = out.get(code);
      if (!inner) {
        inner = new Map();
        out.set(code, inner);
      }
      inner.set(factor, z);
    }
    return out;
  }

  async loadStockMeta(stockCodes: string[]): Promise<Map<string, StockMeta>> {
    if (!stockCodes.length) return new Map();
    // Stock.symbol 形如 "600519.SH"；factor_scores.stock_code 形如 "600519"。
    // 用 LIKE 'CODE.%' 一次性查回会更准（避免子串误配），但 IN 已足够安全：
    // 我们用前缀回填 .SH/.SZ/.BJ 反向推 symbol。
    const symbols = stockCodes.map(code => guessStockSymbol(code));
    const rows = (await Stock.findAll({
      attributes: ['symbol', 'name', 'industry', 'listing_date'],
      where: { symbol: { [Op.in]: symbols } },
      raw: true,
    })) as unknown as Array<{
      symbol: string;
      name: string;
      industry: string | null;
      listing_date: Date | string | null;
    }>;
    const out = new Map<string, StockMeta>();
    for (const r of rows) {
      const code = stripSuffix(r.symbol);
      out.set(code, {
        name: r.name ?? null,
        industry: r.industry ?? null,
        listing_date: normalizeIsoDate(r.listing_date),
      });
    }
    return out;
  }
}

const PRODUCTION_DATA_SOURCE: MultiFactorAlphaDataSource = new DefaultMultiFactorAlphaDataSource();

export class MultiFactorAlphaStrategy extends QuantStrategy {
  readonly definition: QuantStrategyDefinition = {
    strategy_key: 'multi_factor_alpha',
    name: '多因子 Alpha 月度轮动',
    description:
      '读取 factor_scores 表的 8 因子横截面 z_score，按权重合成总分，月度调仓选 top-N（行业中性）。',
    category: 'multi_factor',
    default_params: {
      topN: 30,
      rebalancePeriod: 'monthly' as MultiFactorAlphaRebalancePeriod,
      industryNeutral: true,
      maxPerIndustry: 3,
      excludeST: true,
      excludeNew60d: true,
      weights: { ...DEFAULT_MULTI_FACTOR_ALPHA_WEIGHTS },
    },
    enabled: true,
    risk_level: 'medium',
    tags: ['多因子', 'alpha', '月度轮动', 'factor_scores'],
  };

  private readonly dataSource: MultiFactorAlphaDataSource;

  constructor(dataSource: MultiFactorAlphaDataSource = PRODUCTION_DATA_SOURCE) {
    super();
    this.dataSource = dataSource;
  }

  /**
   * QuantStrategy 抽象基类要求的 per-stock evaluate()。
   *
   * 本策略是组合级，不通过单股 pipeline 工作；这里返回一条信息性 'hold'
   * 信号，让现有 per-stock backtest engine 不至于崩溃，但调用方应当走
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
      target_holding_days: 20,
      reasons: ['MultiFactorAlpha 是组合级策略，请使用 generateSignals(date) 获得调仓信号'],
      risk_flags: [],
      factors: {
        note: 'use_generateSignals_instead',
      },
    };
  }

  /**
   * 组合级调仓信号生成 — US-011 主入口。
   *
   * @param tradeDate ISO YYYY-MM-DD，作为 factor_scores 查询的 as-of 截面日
   * @param options.params 覆盖 default_params 的部分字段（topN/weights 等）
   * @param options.previousSelection 当前持仓 stock_code 数组（用于算 BUY/SELL/HOLD 增量）
   */
  async generateSignals(
    tradeDate: string,
    options: MultiFactorAlphaGenerateOptions = {}
  ): Promise<MultiFactorAlphaSignalsResult> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) {
      throw new Error(`generateSignals: invalid trade_date (expected YYYY-MM-DD): ${tradeDate}`);
    }

    const params = this.resolveParams(options.params);
    const factorNames = Object.keys(params.weights).filter(name => params.weights[name] > 0);
    if (factorNames.length === 0) {
      throw new Error('generateSignals: no factors with positive weight');
    }
    const normalizedWeights = normalizeWeights(params.weights);

    // 1) 读因子打分（FactorScore 表）—— 中性行 z_score=0 已经在 Pipeline 写入
    const factorMap = await this.dataSource.loadFactorScores(tradeDate, factorNames);
    const universe = Array.from(factorMap.keys());

    if (universe.length === 0) {
      logger.warn(
        `MultiFactorAlpha.generateSignals(${tradeDate}): empty factor universe; ` +
          `did FactorPipeline run for this date?`
      );
    }

    // 2) 读股票元数据（name / industry / listing_date）
    const stockMeta = await this.dataSource.loadStockMeta(universe);

    // 3) 计算每只股票的 composite_score + 过滤
    const filtered = { st: 0, new60d: 0, industry_capped: 0, no_factor_data: 0 };
    const candidates: Array<{
      stock_code: string;
      meta: StockMeta;
      composite_score: number;
      factor_z_scores: Record<string, number>;
    }> = [];

    for (const stockCode of universe) {
      const meta = stockMeta.get(stockCode) ?? {};
      const factorZScores: Record<string, number> = {};
      let composite = 0;
      let coveredFactorCount = 0;
      const innerMap = factorMap.get(stockCode);
      for (const factorName of factorNames) {
        const z = innerMap?.get(factorName) ?? 0;
        factorZScores[factorName] = z;
        composite += z * normalizedWeights[factorName];
        if (z !== 0) coveredFactorCount += 1;
      }

      // 全 0 = 该股票所有 8 因子都缺数据（横截面中性补全），剔除不让它占名额
      if (coveredFactorCount === 0) {
        filtered.no_factor_data += 1;
        continue;
      }

      // ST 过滤
      if (params.excludeST && isSTName(meta.name)) {
        filtered.st += 1;
        continue;
      }

      // 次新股过滤（上市 < 60 自然日）
      if (params.excludeNew60d && isNewerThan(meta.listing_date, tradeDate, 60)) {
        filtered.new60d += 1;
        continue;
      }

      candidates.push({
        stock_code: stockCode,
        meta,
        composite_score: composite,
        factor_z_scores: factorZScores,
      });
    }

    // 4) 按 composite_score 降序 + stock_code 升序（稳定排序，便于回放对账）
    candidates.sort((a, b) => {
      if (a.composite_score !== b.composite_score) return b.composite_score - a.composite_score;
      return a.stock_code.localeCompare(b.stock_code);
    });

    // 5) 行业中性 cap，取 top-N
    const selected: typeof candidates = [];
    const industryCount = new Map<string, number>();
    const FALLBACK_INDUSTRY_KEY = '__未知行业__';
    for (const candidate of candidates) {
      if (selected.length >= params.topN) break;
      if (params.industryNeutral) {
        const industryKey = candidate.meta.industry || FALLBACK_INDUSTRY_KEY;
        const current = industryCount.get(industryKey) ?? 0;
        if (current >= params.maxPerIndustry) {
          filtered.industry_capped += 1;
          continue;
        }
        industryCount.set(industryKey, current + 1);
      }
      selected.push(candidate);
    }

    const targetPortfolio = selected.map(c => c.stock_code);
    const targetSet = new Set(targetPortfolio);
    const previousSet = new Set(options.previousSelection ?? []);

    // 6) 计算 BUY / SELL / HOLD 增量信号
    const signals: MultiFactorAlphaSignal[] = [];

    // BUY = 新进（target ∩ ¬previous）；HOLD = 仍在（target ∩ previous）
    for (const candidate of selected) {
      const isHeld = previousSet.has(candidate.stock_code);
      signals.push({
        stock_code: candidate.stock_code,
        name: candidate.meta.name ?? null,
        industry: candidate.meta.industry ?? null,
        signal: isHeld ? 'hold' : 'buy',
        composite_score: candidate.composite_score,
        factor_z_scores: candidate.factor_z_scores,
        reason: isHeld
          ? `保留持仓：composite=${candidate.composite_score.toFixed(3)}`
          : `新进入选：composite=${candidate.composite_score.toFixed(3)}`,
      });
    }

    // SELL = 剔除（previous ∩ ¬target）
    for (const prevCode of previousSet) {
      if (targetSet.has(prevCode)) continue;
      const meta = stockMeta.get(prevCode) ?? {};
      const innerMap = factorMap.get(prevCode);
      const factorZScores: Record<string, number> = {};
      let composite = 0;
      for (const factorName of factorNames) {
        const z = innerMap?.get(factorName) ?? 0;
        factorZScores[factorName] = z;
        composite += z * normalizedWeights[factorName];
      }
      signals.push({
        stock_code: prevCode,
        name: meta.name ?? null,
        industry: meta.industry ?? null,
        signal: 'sell',
        composite_score: composite,
        factor_z_scores: factorZScores,
        reason: `跌出 top-${params.topN}：composite=${composite.toFixed(3)}`,
      });
    }

    logger.info(
      `MultiFactorAlpha.generateSignals(${tradeDate}): universe=${universe.length} ` +
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
      universe_size: universe.length,
      eligible_count: candidates.length,
    };
  }

  /**
   * 合并 default_params + override，返回完整 typed params。
   *
   * **权重合并语义注意**：如果 override.weights 提供了任何因子，那么用户
   * 的 weights 整体**替换** default weights —— 不做 spread 合并。原因：
   * 量化用户期望 "我列出的权重就是全部"，不希望 default 里的 8 个因子
   * 偷偷叠在自定义权重之上把比例搅乱。
   */
  private resolveParams(override?: Partial<MultiFactorAlphaParams>): MultiFactorAlphaParams {
    const def = this.definition.default_params as MultiFactorAlphaParams;
    const weights =
      override?.weights && Object.keys(override.weights).length > 0
        ? { ...override.weights }
        : { ...def.weights };
    return {
      topN: override?.topN ?? def.topN,
      rebalancePeriod: override?.rebalancePeriod ?? def.rebalancePeriod,
      industryNeutral: override?.industryNeutral ?? def.industryNeutral,
      maxPerIndustry: override?.maxPerIndustry ?? def.maxPerIndustry,
      excludeST: override?.excludeST ?? def.excludeST,
      excludeNew60d: override?.excludeNew60d ?? def.excludeNew60d,
      weights,
    };
  }
}

// ---------- 内部 helpers（仅本文件 + .test.ts 复用，未导出到 quant/strategies 之外） ----------

/** 把权重 sum-normalize 到 1.0；过滤掉 ≤ 0 的项。空集兜底返回原 weights */
function normalizeWeights(weights: Record<string, number>): Record<string, number> {
  const positive: Record<string, number> = {};
  let sum = 0;
  for (const [name, w] of Object.entries(weights)) {
    if (typeof w === 'number' && w > 0) {
      positive[name] = w;
      sum += w;
    }
  }
  if (sum === 0) return positive;
  const out: Record<string, number> = {};
  for (const [name, w] of Object.entries(positive)) {
    out[name] = w / sum;
  }
  return out;
}

/**
 * 名称 ST 判定（粗粒度，足够多因子选股层使用）：
 *
 *   - "ST华信"     → true
 *   - "*ST天夏"    → true（退市风险警示）
 *   - "S*ST石岘"   → true（既未股改 + 退市风险警示，2007 前历史样本）
 *   - "SST 海能达" → true（罕见组合，兜底）
 *   - "S 石化"     → true（旧 S 股，未股改）
 *   - "贵州茅台"   → false
 *
 * 实现思路：去掉空格 + toUpperCase 后，凡是包含 "ST" 子串且开头是
 * S / * 的（即非 "FSTQUERY" 之类正常英文名），都视为 ST。A 股股票名
 * 几乎全为中文，含 "ST" 子串的几乎一定是 ST 类。
 */
export function isSTName(name?: string | null): boolean {
  if (!name) return false;
  const compact = name.replace(/\s+/g, '');
  if (!compact) return false;
  const upper = compact.toUpperCase();
  // 直接前缀命中（最常见）
  if (upper.startsWith('ST')) return true;
  if (upper.startsWith('*ST')) return true;
  if (upper.startsWith('S') && upper.indexOf('ST') >= 0 && upper.indexOf('ST') <= 3) {
    // "S*ST..." / "SST..." / "S ST..."（已 compact 掉空格）
    return true;
  }
  // 旧 S 股（"S 石化"），紧跟非 ASCII 字母（避免误判 SAMSUNG）
  if (/^S[^A-Z0-9]/.test(upper)) return true;
  return false;
}

/** listing_date 距 tradeDate ≤ thresholdDays 自然日视为次新股 */
export function isNewerThan(
  listingDate: string | null | undefined,
  tradeDate: string,
  thresholdDays: number
): boolean {
  if (!listingDate) return false;
  const listed = new Date(`${listingDate}T00:00:00Z`).getTime();
  const trade = new Date(`${tradeDate}T00:00:00Z`).getTime();
  if (!Number.isFinite(listed) || !Number.isFinite(trade)) return false;
  if (listed > trade) return true; // 还没上市，肯定剔除
  const ageDays = (trade - listed) / (1000 * 60 * 60 * 24);
  return ageDays < thresholdDays;
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

function normalizeIsoDate(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'string') {
    // already ISO?
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  }
  return null;
}
