import { QuantStrategy } from './QuantStrategy';
import {
  QuantSignalResult,
  QuantStockContext,
  QuantStrategyDefinition,
  QuantStrategyRuntimeOptions,
} from '../types/QuantTypes';
import { logger } from '../../utils/logger';
import {
  marketEnvironmentService,
  MarketEnvironmentSnapshot,
} from '../../services/MarketEnvironmentService';
import {
  MultiFactorAlphaStrategy,
  MultiFactorAlphaSignalsResult,
} from './MultiFactorAlphaStrategy';
import { DragonHeadMomentumStrategy, DragonHeadSignalsResult } from './DragonHeadMomentumStrategy';
import { BreakoutStrategy, BreakoutSignalsResult } from './BreakoutStrategy';
import {
  HighDividendValueStrategy,
  HighDividendValueSignalsResult,
} from './HighDividendValueStrategy';
import {
  SectorRotationLeaderStrategy,
  SectorRotationSignalsResult,
} from './SectorRotationLeaderStrategy';
import {
  LeftSideReversalStrategy,
  LeftSideReversalSignalsResult,
} from './LeftSideReversalStrategy';
import {
  EarningsSurpriseStrategy,
  EarningsSurpriseSignalsResult,
} from './EarningsSurpriseStrategy';
import { GARPStrategy, GARPSignalsResult } from './GARPStrategy';

/**
 * EnsembleStrategy — 多策略融合（US-028）。
 *
 * 第 13 个组合级策略。**不**继承其他组合级策略的"单一选股逻辑"设计，
 * 而是作为 **meta-strategy** —— 根据当日市场环境（bull / bear / range /
 * volatile）选择一组子策略 + 权重，把它们的 target_portfolio 按权重融合
 * 成一个统一的 target。
 *
 * ## 4 种市场环境的策略组合（AC 指定）
 *
 *   | 环境       | 子策略 + 权重                                         |
 *   |------------|------------------------------------------------------|
 *   | bull       | MultiFactorAlpha 0.40 + DragonHead 0.30 + Breakout 0.30 |
 *   | bear       | HighDividendValue 0.60 + LowVol 0.40                  |
 *   | range      | SectorRotationLeader 0.40 + LeftSideReversal 0.30 + EarningsSurprise 0.30 |
 *   | volatile   | GARPStrategy 0.50 + HighDividendValue 0.50            |
 *
 * **LowVol 策略未实现**（计划在 US-029+ 加入）。在那之前，bear 环境的
 * LowVol 权重会被 *合并* 到 HighDividendValue（合计 1.0），并通过
 * `degraded_substitutions` 字段告知调用方此次降级。
 *
 * ## 市场环境识别
 *
 * 复用 `MarketEnvironmentService.getEnvironmentForStock(symbol)`，传入
 * 默认基准（沪深 300）。该 service 返回 6 种 regime：
 *   - bull / bear / range / rebound / stress / unknown
 *
 * EnsembleStrategy 把它们映射到 AC 的 4 种环境：
 *   - 'bull'     → bull
 *   - 'bear'     → bear
 *   - 'range'    → range
 *   - 'rebound'  → range（弱反弹按震荡处理 —— 趋势未确认）
 *   - 'stress'   → volatile（压力 / 大幅回撤当作"高波动"看待，给 GARP + HighDividend 防守）
 *   - 'unknown'  → range（数据不足时按震荡，最中性的策略组合）
 *
 * ## "融合"的语义 —— BUY 列表加权投票
 *
 * 每个子策略产出 `target_portfolio: string[]`（或对结构化 `target_positions`
 * 取 stock_code）。EnsembleStrategy 给每只入选股一个**加权得票** =
 * sum(weight 当该股出现在子策略 target 内)，再按得票降序取 top-N。
 *
 * 这种"加权投票"比"按权重分配仓位 quota"更稳健：
 *   - 处理子策略输出股票数不等：MFA 30 只 vs DragonHead 5 只
 *   - 处理子策略全空（数据缺失）：自动回退到其他子策略
 *   - 处理 target overlap（多策略同时推荐同一只）：加分而非重复
 *
 * ## 对外只暴露 generateSignals(date)
 *
 * 与其他组合级策略一致：evaluate() 退化为信息性 hold（让 backtest engine
 * 不崩）；真正入口是 async generateSignals(tradeDate, {params?, previousSelection?})。
 *
 * ## 子策略 DataSource 注入
 *
 * EnsembleStrategy 构造时**默认创建子策略实例**（使用各自的 PRODUCTION
 * DataSource）。测试场景下可通过 `substrategies` 参数注入 mock 子策略
 * 完全脱离 DB / FactorScore 表。
 *
 * 推荐生产用法：传入项目级 strategyRegistry 中已注册的子策略实例，
 * 复用 DataSource 单例。
 */

/** AC 指定的 4 种市场环境 */
export type EnsembleMarketRegime = 'bull' | 'bear' | 'range' | 'volatile';

/** 单一子策略在某个市场环境下的权重配置 */
export interface EnsembleSubstrategyWeight {
  strategy_key: string;
  weight: number;
}

/** 4 种环境下的子策略组合（权重和必为 1.0；策略缺失时降级） */
export type EnsembleAllocationMap = Record<EnsembleMarketRegime, EnsembleSubstrategyWeight[]>;

/** AC 指定的默认分配（权重和 = 1.0 每行） */
export const DEFAULT_ENSEMBLE_ALLOCATION: EnsembleAllocationMap = Object.freeze({
  bull: [
    { strategy_key: 'multi_factor_alpha', weight: 0.4 },
    { strategy_key: 'dragon_head_momentum', weight: 0.3 },
    { strategy_key: 'breakout_strategy', weight: 0.3 },
  ],
  bear: [
    { strategy_key: 'high_dividend_value', weight: 0.6 },
    // LowVol 策略未实现（US-029+ 计划）；置 weight: 0.4 以表达 AC 意图，
    // generateSignals 内部会侦测 LowVol 缺失，把权重合并到 high_dividend_value
    // 并通过 degraded_substitutions 报告该降级。
    { strategy_key: 'low_vol_strategy', weight: 0.4 },
  ],
  range: [
    { strategy_key: 'sector_rotation_leader', weight: 0.4 },
    { strategy_key: 'left_side_reversal', weight: 0.3 },
    { strategy_key: 'earnings_surprise', weight: 0.3 },
  ],
  volatile: [
    { strategy_key: 'garp_strategy', weight: 0.5 },
    { strategy_key: 'high_dividend_value', weight: 0.5 },
  ],
}) as EnsembleAllocationMap;

export interface EnsembleParams {
  /** Top-N 持股（默认 30） */
  topN: number;
  /** 自定义环境 → 子策略分配。空则用 DEFAULT_ENSEMBLE_ALLOCATION */
  allocation?: EnsembleAllocationMap;
  /**
   * 计算市场环境时所用的 benchmark symbol（沪深 300）。
   * 默认 'sh.000300'；测试或自定义场景可以覆盖。
   */
  benchmarkSymbol: string;
  /**
   * 是否在 EnsembleStrategy 内部把子策略不可用的权重"按比例重新归一化"
   * 给剩余子策略。默认 true（degraded 模式）。设为 false 则缺失子策略 =
   * 权重作废（剩余权重不补偿）。
   */
  rebalanceMissingWeights: boolean;
}

/** 默认参数 */
export const DEFAULT_ENSEMBLE_PARAMS: Required<EnsembleParams> = Object.freeze({
  topN: 30,
  allocation: DEFAULT_ENSEMBLE_ALLOCATION,
  benchmarkSymbol: 'sh.000300',
  rebalanceMissingWeights: true,
}) as Required<EnsembleParams>;

/** 子策略输出（fused 信号） */
export interface EnsembleSignal {
  stock_code: string;
  signal: 'buy' | 'sell' | 'hold';
  /** 加权得票（sum of contributing weights）；越高 = 多个子策略一致看好 */
  vote_score: number;
  /** 贡献了这一票的子策略 keys（debug / 审计用） */
  contributing_substrategies: string[];
  reason: string;
}

/** 单个子策略调用的诊断结果 */
export interface EnsembleSubstrategyDiagnostic {
  strategy_key: string;
  weight_used: number;
  /** 该子策略产出的 target_portfolio 大小（融合前） */
  target_size: number;
  /** 实际取回耗时（ms） */
  elapsed_ms: number;
  /** 子策略调用失败信息（null 表示成功） */
  error?: string;
}

/** generateSignals 完整结果 */
export interface EnsembleSignalsResult {
  trade_date: string;
  /** 当日检测到的市场环境（映射到 AC 4 种之一） */
  market_regime: EnsembleMarketRegime;
  /** MarketEnvironmentService 原始 regime（debug / 审计用） */
  raw_market_regime: MarketEnvironmentSnapshot['market_regime'];
  /** 实际使用的子策略 → 权重（已归一化，含降级合并） */
  effective_weights: Record<string, number>;
  /** 配置中存在但运行时未生效的子策略（缺失或失败时降级合并的权重路径） */
  degraded_substitutions: Array<{
    missing_strategy: string;
    original_weight: number;
    /** 该权重被合并到了哪些子策略（按比例分配） */
    redistributed_to: string[];
  }>;
  /** 调仓后目标组合（top-N stock_code 列表） */
  target_portfolio: string[];
  /** 全部增量信号：BUY / SELL / HOLD */
  signals: EnsembleSignal[];
  /** 各子策略调用诊断 */
  substrategy_diagnostics: EnsembleSubstrategyDiagnostic[];
  /** 实际生效的参数（合并 default + override） */
  params: Required<EnsembleParams>;
}

export interface EnsembleGenerateOptions {
  /** override default_params 中的部分参数 */
  params?: Partial<EnsembleParams>;
  /**
   * 当前持仓 stock_code 数组；用于计算 BUY/SELL/HOLD 增量。
   * 不传则全部 target_portfolio 视为 BUY（首次开仓场景）。
   */
  previousSelection?: string[];
  /**
   * 覆盖市场环境检测；测试用 fake regime 跳过 MarketEnvironmentService。
   * 生产环境不应传此参数。
   */
  marketRegimeOverride?: MarketEnvironmentSnapshot['market_regime'];
}

/**
 * Substrategy 契约 —— 每个子策略需实现的 generateSignals(date) 接口。
 *
 * 所有现有组合级策略都符合此 shape（不论返回 target_portfolio: string[]
 * 还是 target_positions: Position[]）。EnsembleStrategy 通过
 * `substrategyTargetExtractor` 函数从两种 shape 中统一抽出 stock_code 数组。
 *
 * 测试可以传入 fake substrategy 完全脱离子策略的 DB 依赖。
 */
export type EnsembleSubstrategyResult =
  | MultiFactorAlphaSignalsResult
  | DragonHeadSignalsResult
  | BreakoutSignalsResult
  | HighDividendValueSignalsResult
  | SectorRotationSignalsResult
  | LeftSideReversalSignalsResult
  | EarningsSurpriseSignalsResult
  | GARPSignalsResult;

export interface EnsembleSubstrategy {
  strategy_key: string;
  generateSignals(
    tradeDate: string,
    options?: { previousSelection?: string[] }
  ): Promise<EnsembleSubstrategyResult>;
}

export class EnsembleStrategy extends QuantStrategy {
  readonly definition: QuantStrategyDefinition = {
    strategy_key: 'ensemble_strategy',
    name: '多策略融合（市场环境自适应）',
    description:
      '根据市场环境（bull/bear/range/volatile）切换子策略组合 + 权重，把多个子策略的 target 用加权投票融合成统一持仓。',
    category: 'multi_factor',
    default_params: { ...DEFAULT_ENSEMBLE_PARAMS },
    enabled: true,
    risk_level: 'medium',
    tags: ['集成', '元策略', '市场环境', '自适应权重', '加权投票'],
  };

  /** 子策略实例池（key → instance）。默认创建生产实例；测试可注入 fakes。 */
  private readonly substrategies: Map<string, EnsembleSubstrategy>;

  constructor(substrategies?: EnsembleSubstrategy[]) {
    super();
    this.substrategies = new Map();
    const instances = substrategies ?? this.buildDefaultSubstrategies();
    for (const sub of instances) {
      if (this.substrategies.has(sub.strategy_key)) {
        throw new Error(
          `EnsembleStrategy: duplicate substrategy_key "${sub.strategy_key}" in constructor`
        );
      }
      this.substrategies.set(sub.strategy_key, sub);
    }
  }

  /**
   * 默认子策略实例化 —— 7 个目前可用的组合级策略，使用各自的 PRODUCTION DataSource。
   *
   * **LowVol 策略尚未实现**（US-029+ 计划），所以 bear 环境的 `low_vol_strategy`
   * 权重会被 generateSignals 检测为缺失 → 触发 degraded_substitutions 路径。
   */
  private buildDefaultSubstrategies(): EnsembleSubstrategy[] {
    return [
      adaptStrategy(new MultiFactorAlphaStrategy()),
      adaptStrategy(new DragonHeadMomentumStrategy()),
      adaptStrategy(new BreakoutStrategy()),
      adaptStrategy(new HighDividendValueStrategy()),
      adaptStrategy(new SectorRotationLeaderStrategy()),
      adaptStrategy(new LeftSideReversalStrategy()),
      adaptStrategy(new EarningsSurpriseStrategy()),
      adaptStrategy(new GARPStrategy()),
    ];
  }

  /**
   * QuantStrategy 抽象基类要求的 per-stock evaluate()。
   *
   * EnsembleStrategy 是 meta-策略，不通过 per-stock pipeline 工作；这里返
   * 回信息性 hold，提示调用方走 generateSignals(date)。
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
      reasons: ['EnsembleStrategy 是 meta-策略，请使用 generateSignals(date) 获得调仓信号'],
      risk_flags: [],
      factors: {
        note: 'use_generateSignals_instead',
      },
    };
  }

  /**
   * 组合级 meta-策略 入口 —— US-028 主接口。
   *
   * 流程：
   *   1) 探测市场环境（regime）
   *   2) 根据 regime 选 allocation
   *   3) 检测子策略可用性 → 缺失子策略 + degraded 重新归一化权重
   *   4) 并发调用所有可用子策略的 generateSignals(tradeDate)
   *   5) 加权投票融合 target_portfolio
   *   6) 与 previousSelection 算 BUY / SELL / HOLD
   */
  async generateSignals(
    tradeDate: string,
    options: EnsembleGenerateOptions = {}
  ): Promise<EnsembleSignalsResult> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) {
      throw new Error(`generateSignals: invalid trade_date (expected YYYY-MM-DD): ${tradeDate}`);
    }

    const params = this.resolveParams(options.params);
    if (params.topN <= 0) {
      throw new Error(`generateSignals: topN must be > 0, got ${params.topN}`);
    }

    // 1) 探测市场环境
    const rawRegime = options.marketRegimeOverride
      ? options.marketRegimeOverride
      : await this.detectMarketRegime(tradeDate, params.benchmarkSymbol);
    const regime = mapToEnsembleRegime(rawRegime);

    // 2) 选 allocation
    const requestedAllocation = params.allocation[regime] ?? [];
    if (requestedAllocation.length === 0) {
      logger.warn(
        `EnsembleStrategy.generateSignals(${tradeDate}): regime=${regime} has empty allocation; ` +
          `returning empty target.`
      );
      return this.buildEmptyResult(tradeDate, regime, rawRegime, params, options.previousSelection);
    }

    // 3) 子策略可用性 + 降级
    const { effectiveAllocation, degraded } = resolveEffectiveAllocation(
      requestedAllocation,
      this.substrategies,
      params.rebalanceMissingWeights
    );
    if (effectiveAllocation.length === 0) {
      logger.warn(
        `EnsembleStrategy.generateSignals(${tradeDate}): regime=${regime} has no available substrategies ` +
          `after degradation (requested=${requestedAllocation.length})`
      );
      return this.buildEmptyResult(
        tradeDate,
        regime,
        rawRegime,
        params,
        options.previousSelection,
        degraded
      );
    }

    // 4) 并发调用子策略
    const diagnostics: EnsembleSubstrategyDiagnostic[] = [];
    const substrategyTargets = new Map<string, Set<string>>(); // strategy_key → Set<stock_code>

    const callPromises = effectiveAllocation.map(async entry => {
      const sub = this.substrategies.get(entry.strategy_key);
      if (!sub) {
        // 不应发生：resolveEffectiveAllocation 已过滤；防御性日志
        diagnostics.push({
          strategy_key: entry.strategy_key,
          weight_used: entry.weight,
          target_size: 0,
          elapsed_ms: 0,
          error: 'substrategy_missing_in_pool',
        });
        substrategyTargets.set(entry.strategy_key, new Set());
        return;
      }
      const start = Date.now();
      try {
        const result = await sub.generateSignals(tradeDate, {
          previousSelection: options.previousSelection,
        });
        const targetCodes = extractTargetStockCodes(result);
        substrategyTargets.set(entry.strategy_key, new Set(targetCodes));
        diagnostics.push({
          strategy_key: entry.strategy_key,
          weight_used: entry.weight,
          target_size: targetCodes.length,
          elapsed_ms: Date.now() - start,
        });
      } catch (error: any) {
        diagnostics.push({
          strategy_key: entry.strategy_key,
          weight_used: entry.weight,
          target_size: 0,
          elapsed_ms: Date.now() - start,
          error: error?.message ?? String(error),
        });
        substrategyTargets.set(entry.strategy_key, new Set());
        logger.warn(
          `EnsembleStrategy.generateSignals(${tradeDate}): substrategy ${entry.strategy_key} ` +
            `failed: ${error?.message ?? error}`
        );
      }
    });
    await Promise.all(callPromises);

    // 5) 加权投票融合 target
    const voteScores = new Map<string, number>();
    const contributorMap = new Map<string, string[]>();

    for (const entry of effectiveAllocation) {
      const targets = substrategyTargets.get(entry.strategy_key) ?? new Set<string>();
      for (const stockCode of targets) {
        voteScores.set(stockCode, (voteScores.get(stockCode) ?? 0) + entry.weight);
        if (!contributorMap.has(stockCode)) contributorMap.set(stockCode, []);
        contributorMap.get(stockCode)!.push(entry.strategy_key);
      }
    }

    // 6) 按 vote_score 降序 + stock_code 升序 稳定排序，取 top-N
    const ranked = Array.from(voteScores.entries())
      .map(([stock_code, vote_score]) => ({ stock_code, vote_score }))
      .sort((a, b) => {
        if (a.vote_score !== b.vote_score) return b.vote_score - a.vote_score;
        return a.stock_code.localeCompare(b.stock_code);
      });

    const targetPortfolio = ranked.slice(0, params.topN).map(r => r.stock_code);
    const targetSet = new Set(targetPortfolio);
    const previousSet = new Set(options.previousSelection ?? []);

    // 7) 增量信号 BUY / HOLD / SELL
    const signals: EnsembleSignal[] = [];
    for (const stockCode of targetPortfolio) {
      const voteScore = voteScores.get(stockCode) ?? 0;
      const contributors = contributorMap.get(stockCode) ?? [];
      const isHeld = previousSet.has(stockCode);
      signals.push({
        stock_code: stockCode,
        signal: isHeld ? 'hold' : 'buy',
        vote_score: voteScore,
        contributing_substrategies: contributors,
        reason: isHeld
          ? `保留持仓：${regime} 环境综合得票 ${voteScore.toFixed(3)}（${
              contributors.length
            } 个子策略）`
          : `新进入选：${regime} 环境综合得票 ${voteScore.toFixed(3)}（${
              contributors.length
            } 个子策略）`,
      });
    }
    // SELL = previous ∩ ¬target
    for (const prevCode of previousSet) {
      if (targetSet.has(prevCode)) continue;
      const voteScore = voteScores.get(prevCode) ?? 0;
      const contributors = contributorMap.get(prevCode) ?? [];
      signals.push({
        stock_code: prevCode,
        signal: 'sell',
        vote_score: voteScore,
        contributing_substrategies: contributors,
        reason:
          contributors.length === 0
            ? `跌出所有子策略目标：${regime} 环境无子策略推荐`
            : `跌出 top-${params.topN}：得票 ${voteScore.toFixed(3)} 不足以入选`,
      });
    }

    const effectiveWeights: Record<string, number> = {};
    for (const entry of effectiveAllocation) effectiveWeights[entry.strategy_key] = entry.weight;

    logger.info(
      `EnsembleStrategy.generateSignals(${tradeDate}): regime=${regime} (raw=${rawRegime}) ` +
        `effective_subs=${effectiveAllocation.length} target=${targetPortfolio.length} ` +
        `buy=${signals.filter(s => s.signal === 'buy').length} ` +
        `sell=${signals.filter(s => s.signal === 'sell').length} ` +
        `hold=${signals.filter(s => s.signal === 'hold').length} ` +
        `degraded=${degraded.length}`
    );

    return {
      trade_date: tradeDate,
      market_regime: regime,
      raw_market_regime: rawRegime,
      effective_weights: effectiveWeights,
      degraded_substitutions: degraded,
      target_portfolio: targetPortfolio,
      signals,
      substrategy_diagnostics: diagnostics,
      params,
    };
  }

  private async detectMarketRegime(
    tradeDate: string,
    benchmarkSymbol: string
  ): Promise<MarketEnvironmentSnapshot['market_regime']> {
    try {
      const snapshot = await marketEnvironmentService.getEnvironmentForStock(benchmarkSymbol, {
        as_of: tradeDate,
        use_cache: true,
      });
      return snapshot.market_regime;
    } catch (error: any) {
      logger.warn(
        `EnsembleStrategy.detectMarketRegime: failed to detect regime ` +
          `(benchmark=${benchmarkSymbol}, date=${tradeDate}): ${error?.message ?? error}; ` +
          `defaulting to 'unknown'`
      );
      return 'unknown';
    }
  }

  private resolveParams(override?: Partial<EnsembleParams>): Required<EnsembleParams> {
    const def = this.definition.default_params as Required<EnsembleParams>;
    return {
      topN: override?.topN ?? def.topN,
      allocation: override?.allocation ?? def.allocation,
      benchmarkSymbol: override?.benchmarkSymbol ?? def.benchmarkSymbol,
      rebalanceMissingWeights: override?.rebalanceMissingWeights ?? def.rebalanceMissingWeights,
    };
  }

  private buildEmptyResult(
    tradeDate: string,
    regime: EnsembleMarketRegime,
    rawRegime: MarketEnvironmentSnapshot['market_regime'],
    params: Required<EnsembleParams>,
    previousSelection?: string[],
    degraded: EnsembleSignalsResult['degraded_substitutions'] = []
  ): EnsembleSignalsResult {
    // 空 target → 所有 previousSelection 都 SELL
    const sellSignals: EnsembleSignal[] = (previousSelection ?? []).map(code => ({
      stock_code: code,
      signal: 'sell' as const,
      vote_score: 0,
      contributing_substrategies: [],
      reason: `${regime} 环境无可用子策略：清仓`,
    }));
    return {
      trade_date: tradeDate,
      market_regime: regime,
      raw_market_regime: rawRegime,
      effective_weights: {},
      degraded_substitutions: degraded,
      target_portfolio: [],
      signals: sellSignals,
      substrategy_diagnostics: [],
      params,
    };
  }
}

// ---------- helpers ----------

/**
 * 把 MarketEnvironmentService 的 6 种 raw regime 映射到 AC 的 4 种 ensemble regime：
 *   bull    → bull
 *   bear    → bear
 *   range   → range
 *   rebound → range（弱反弹按震荡处理，趋势未确认）
 *   stress  → volatile（高压力 / 大回撤当作高波动）
 *   unknown → range（最中性的策略组合，数据不足时的保守选择）
 */
export function mapToEnsembleRegime(
  raw: MarketEnvironmentSnapshot['market_regime']
): EnsembleMarketRegime {
  switch (raw) {
    case 'bull':
      return 'bull';
    case 'bear':
      return 'bear';
    case 'stress':
      return 'volatile';
    case 'range':
    case 'rebound':
    case 'unknown':
    default:
      return 'range';
  }
}

/**
 * 解析配置 allocation → 运行时 effective allocation：
 *   1) 移除子策略池中不存在的项 → 记入 degraded
 *   2) 如果 rebalance=true：按比例把缺失权重重新分给剩余子策略
 *   3) 重新归一化（已存在的子策略权重总和应当 ≈ 1.0）
 */
export function resolveEffectiveAllocation(
  requested: EnsembleSubstrategyWeight[],
  substrategyPool: Map<string, EnsembleSubstrategy>,
  rebalanceMissing: boolean
): {
  effectiveAllocation: EnsembleSubstrategyWeight[];
  degraded: EnsembleSignalsResult['degraded_substitutions'];
} {
  const present: EnsembleSubstrategyWeight[] = [];
  const missing: EnsembleSubstrategyWeight[] = [];
  for (const entry of requested) {
    if (substrategyPool.has(entry.strategy_key)) {
      present.push({ ...entry });
    } else {
      missing.push({ ...entry });
    }
  }
  if (present.length === 0) {
    return {
      effectiveAllocation: [],
      degraded: missing.map(m => ({
        missing_strategy: m.strategy_key,
        original_weight: m.weight,
        redistributed_to: [],
      })),
    };
  }

  const degraded: EnsembleSignalsResult['degraded_substitutions'] = [];
  if (missing.length === 0) {
    return { effectiveAllocation: normalizeWeightsToOne(present), degraded };
  }

  if (rebalanceMissing) {
    const totalPresentWeight = present.reduce((sum, e) => sum + e.weight, 0);
    if (totalPresentWeight <= 0) {
      // 极端：present 全权重 0，把缺失权重平分给 present
      const each = missing.reduce((sum, m) => sum + m.weight, 0) / present.length;
      for (const m of missing) {
        degraded.push({
          missing_strategy: m.strategy_key,
          original_weight: m.weight,
          redistributed_to: present.map(p => p.strategy_key),
        });
      }
      return {
        effectiveAllocation: normalizeWeightsToOne(present.map(p => ({ ...p, weight: each }))),
        degraded,
      };
    }
    for (const m of missing) {
      const extra = m.weight;
      const distributedTo: string[] = [];
      for (const p of present) {
        const share = (p.weight / totalPresentWeight) * extra;
        p.weight += share;
        distributedTo.push(p.strategy_key);
      }
      degraded.push({
        missing_strategy: m.strategy_key,
        original_weight: m.weight,
        redistributed_to: distributedTo,
      });
    }
    return { effectiveAllocation: normalizeWeightsToOne(present), degraded };
  }

  // rebalanceMissing=false：缺失权重作废
  for (const m of missing) {
    degraded.push({
      missing_strategy: m.strategy_key,
      original_weight: m.weight,
      redistributed_to: [],
    });
  }
  return { effectiveAllocation: normalizeWeightsToOne(present), degraded };
}

/** 把权重归一化到总和 1.0；输入应至少有 1 个正权重项 */
export function normalizeWeightsToOne(
  entries: EnsembleSubstrategyWeight[]
): EnsembleSubstrategyWeight[] {
  const total = entries.reduce((s, e) => s + Math.max(0, e.weight), 0);
  if (total <= 0) return entries.map(e => ({ ...e, weight: 0 }));
  return entries.map(e => ({
    strategy_key: e.strategy_key,
    weight: Math.max(0, e.weight) / total,
  }));
}

/**
 * 从子策略结果中提取 target stock_codes 数组。
 *
 * 处理两种 shape：
 *   - `target_portfolio: string[]`（MFA / HighDividend / GARP / CTA100）
 *   - `target_positions: { stock_code }[]`（DragonHead / Breakout / SectorRotation /
 *     LeftSideReversal / EarningsSurprise / GameTraderRelay / Linkage）
 */
export function extractTargetStockCodes(result: EnsembleSubstrategyResult): string[] {
  if ('target_portfolio' in result && Array.isArray(result.target_portfolio)) {
    return result.target_portfolio.slice();
  }
  if ('target_positions' in result && Array.isArray(result.target_positions)) {
    return (result.target_positions as Array<{ stock_code: string }>).map(p => p.stock_code);
  }
  return [];
}

/**
 * 适配器：把任意子 QuantStrategy 实例包装成 EnsembleSubstrategy（含
 * 顶层 strategy_key + generateSignals method）。
 *
 * 子策略类的 strategy_key 在 definition 里；ensemble pool 需要顶层属性
 * 便于 Map 索引 + 调试。包装层只暴露 generateSignals，把子策略的
 * `evaluate()` 隐藏（ensemble 不调用它）。
 */
function adaptStrategy(
  instance: QuantStrategy & {
    generateSignals(
      tradeDate: string,
      options?: { previousSelection?: string[]; currentPositions?: any[] }
    ): Promise<EnsembleSubstrategyResult>;
  }
): EnsembleSubstrategy {
  return {
    strategy_key: instance.definition.strategy_key,
    generateSignals: (tradeDate, options) => instance.generateSignals(tradeDate, options),
  };
}
