/**
 * ETFRotationStrategy (ETF 因子轮动策略) — 信号优先重构 批5-b, §4.1 核心 70%
 *
 * 这是新主线的**唯一核心策略**, 替代旧的 29 个 per-stock 策略 (批3 削至 3,
 * 批5 再删至本策略). 组合级 (非 per-stock), 与 MultiFactorAlphaStrategy 同款结构:
 *   - evaluate() 返回信息性 'hold' (供 per-stock backtest engine 不崩),
 *     真正调仓走 generateSignals(tradeDate).
 *   - generateSignals(): ETF universe → 四因子打分 (ETFFactorService §4.1) →
 *     排名 top4买/top6卖缓冲带 (ETFRankingService) → BUY/SELL/HOLD + 目标权重.
 *
 * universe: constants/etfIndustry.ts 白名单 (46-63 只候选池, §4.1). L1 eligibility
 * (上市≥180天/成交额≥2000万/非停牌/数据完整≥90%) 由 data 完整度在 ETFFactorService
 * 内以 data_incomplete 体现; 更严格的 L1 gate 待批6 ETFRotationService 接入.
 *
 * SELL 机制 (§4.1): 只有月度再平衡触发换仓, 不设单笔止损止盈 (ETF 波动小).
 * 组合级 PR-L 大跌熔断由风控层保留.
 */

import {
  QuantSignalResult,
  QuantStockContext,
  QuantStrategyDefinition,
  QuantStrategyRuntimeOptions,
} from '../types/QuantTypes';
import { QuantStrategy } from './QuantStrategy';
import { ETFFactorService, etfFactorService, ETFFactorScore, ETFFactorWeights } from '../etf/ETFFactorService';
import { ETFRankingService, etfRankingService, ETFRebalanceDecision } from '../etf/ETFRankingService';
import { ETF_PROFILES } from '../../constants/etfIndustry';

export interface ETFRotationSignal {
  strategy_key: string;
  etf_code: string;
  name?: string;
  action: 'buy' | 'sell' | 'hold';
  score: number;
  rank: number;
  target_weight: number;
  factors: {
    value_z: number;
    quality_z: number;
    lowvol_z: number;
    momentum_z: number; // shadow
    value_raw: number | null;
    quality_raw: number | null;
    lowvol_raw: number | null;
    momentum_raw: number | null;
    constituent_source: string;
  };
  reasons: string[];
  data_incomplete: boolean;
}

export interface ETFRotationGenerateOptions {
  /** 权重覆盖 (敏感性网格用); 缺省用 §4.1 V0 (0.4/0.3/0.3/0.0) */
  weights?: Partial<ETFFactorWeights>;
  /** 当前持仓 ETF 6 位代码 (算 BUY/SELL/HOLD 增量) */
  currentHoldings?: string[];
  /** 覆盖 universe (默认 constants/etfIndustry.ts 全白名单) */
  universe?: string[];
}

export class ETFRotationStrategy extends QuantStrategy {
  readonly definition: QuantStrategyDefinition = {
    strategy_key: 'etf_factor_rotation',
    name: 'ETF 因子轮动 (核心 70%)',
    description:
      '按 4 因子 (Value 0.40 / Quality 0.30 / LowVol 0.30 / Momentum 0.0 shadow) 给 46-63 只候选 ETF 打分, 月度再平衡选 top4 买 / top6 卖缓冲带, 稳态持有 4-6 只, 单只≤15% 核心总仓位≤70%。信号优先重构主线核心策略。',
    category: 'multi_factor',
    default_params: {
      rebalancePeriod: 'monthly',
      weights: { value: 0.4, quality: 0.3, lowvol: 0.3, momentum: 0.0 },
      buyBand: 4,
      sellBand: 6,
    },
    enabled: true,
    risk_level: 'low',
    tags: ['ETF', '因子轮动', '核心', '月度再平衡', '价值', '质量', '低波'],
    style: 'low_volatility',
    edge_hypothesis: {
      thesis:
        'ETF 因子轮动核心 alpha: Value/Quality/LowVol 三因子横截面打分, 月度再平衡持有 top4-6 只风格/宽基 ETF, 机械无情绪, A 股高股息+低波长期跑赢 (MSCI 2025), 底线年化 8-10%',
      category: 'structural',
      expected_edge_pct: 9.0,
      expected_holding_days: 22,
      key_factors: ['value', 'quality', 'low_vol'],
      evidence_link: 'S&P Global A-Share Factor / MSCI 2025 China A-Share Factor Investing',
      failure_modes: [
        'ETF 跟踪误差 / 折溢价侵蚀因子超额',
        '成分股调整导致 point-in-time 展开漂移',
        '因子长期失效期 (风格极端切换)',
      ],
      kill_switch_metric: 'cost_after_annual_return',
      kill_switch_threshold: 0.0,
    },
  };

  private readonly factorService: ETFFactorService;
  private readonly rankingService: ETFRankingService;

  constructor(
    factorService: ETFFactorService = etfFactorService,
    rankingService: ETFRankingService = etfRankingService
  ) {
    super();
    this.factorService = factorService;
    this.rankingService = rankingService;
  }

  /**
   * QuantStrategy 抽象基类要求的 per-stock evaluate()。
   * 本策略组合级, 不走单股 pipeline; 返回信息性 'hold' 让旧 per-stock backtest
   * engine 不崩, 真正调仓走 generateSignals(tradeDate)。
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
      target_holding_days: 22,
      reasons: ['ETFRotation 是组合级策略, 请用 generateSignals(tradeDate) 获得月度再平衡信号'],
      risk_flags: [],
      factors: { note: 'use_generateSignals_instead' },
    };
  }

  /**
   * 组合级月度再平衡信号生成 (§4.1 主入口)。
   * @param tradeDate 月末快照日 YYYY-MM-DD (因子计算 as-of 截面)
   */
  async generateSignals(
    tradeDate: string,
    options: ETFRotationGenerateOptions = {}
  ): Promise<ETFRotationSignal[]> {
    const universe = options.universe?.length
      ? options.universe
      : ETF_PROFILES.map(p => p.code);
    const scores = await this.factorService.score(universe, tradeDate, options.weights);
    const ranking = this.rankingService.rank(scores, options.currentHoldings ?? []);

    const scoreByCode = new Map<string, ETFFactorScore>();
    for (const s of scores) scoreByCode.set(s.etf_code, s);
    const nameByCode = new Map<string, string>();
    for (const p of ETF_PROFILES) nameByCode.set(p.code, p.name);

    return ranking.decisions.map((d: ETFRebalanceDecision) => {
      const fs = scoreByCode.get(d.etf_code)!;
      return {
        strategy_key: this.definition.strategy_key,
        etf_code: d.etf_code,
        name: nameByCode.get(d.etf_code),
        action: d.action,
        score: d.total_score,
        rank: d.rank,
        target_weight: d.target_weight,
        factors: {
          value_z: fs.value_z,
          quality_z: fs.quality_z,
          lowvol_z: fs.lowvol_z,
          momentum_z: fs.momentum_z,
          value_raw: fs.value_raw,
          quality_raw: fs.quality_raw,
          lowvol_raw: fs.lowvol_raw,
          momentum_raw: fs.momentum_raw,
          constituent_source: fs.constituent_source,
        },
        reasons: d.reasons,
        data_incomplete: fs.data_incomplete,
      };
    });
  }
}
