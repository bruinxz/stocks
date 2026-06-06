import { QuantStrategy } from '../strategies/QuantStrategy';
import { MovingAverageTrendStrategy } from '../strategies/MovingAverageTrendStrategy';
import { MacdTrendStrategy } from '../strategies/MacdTrendStrategy';
import { RsiMeanReversionStrategy } from '../strategies/RsiMeanReversionStrategy';
import { BollingerReversionStrategy } from '../strategies/BollingerReversionStrategy';
import { RelativeStrengthMomentumStrategy } from '../strategies/RelativeStrengthMomentumStrategy';
import { BreakoutAtrStrategy } from '../strategies/BreakoutAtrStrategy';
import { MultiFactorRankingStrategy } from '../strategies/MultiFactorRankingStrategy';
import { LowVolatilityQualityStrategy } from '../strategies/LowVolatilityQualityStrategy';
import { VolumePriceConfirmationStrategy } from '../strategies/VolumePriceConfirmationStrategy';
import { DonchianTrendStrategy } from '../strategies/DonchianTrendStrategy';
import { TurtleBreakoutStrategy } from '../strategies/TurtleBreakoutStrategy';
import { MinerviniTrendTemplateStrategy } from '../strategies/MinerviniTrendTemplateStrategy';
import { VolatilityContractionBreakoutStrategy } from '../strategies/VolatilityContractionBreakoutStrategy';
import { DualMomentumRotationStrategy } from '../strategies/DualMomentumRotationStrategy';
import { QualityMomentumBlendStrategy } from '../strategies/QualityMomentumBlendStrategy';
import { TrendPullbackReentryStrategy } from '../strategies/TrendPullbackReentryStrategy';
import { MultiFactorAlphaStrategy } from '../strategies/MultiFactorAlphaStrategy';
import { DragonHeadMomentumStrategy } from '../strategies/DragonHeadMomentumStrategy';
import { EarningsSurpriseStrategy } from '../strategies/EarningsSurpriseStrategy';
import { QuantStrategyDefinition } from '../types/QuantTypes';

export class StrategyRegistry {
  private strategies = new Map<string, QuantStrategy>();

  constructor() {
    this.register(new MovingAverageTrendStrategy());
    this.register(new MacdTrendStrategy());
    this.register(new RsiMeanReversionStrategy());
    this.register(new BollingerReversionStrategy());
    this.register(new RelativeStrengthMomentumStrategy());
    this.register(new BreakoutAtrStrategy());
    this.register(new MultiFactorRankingStrategy());
    this.register(new LowVolatilityQualityStrategy());
    this.register(new VolumePriceConfirmationStrategy());
    this.register(new DonchianTrendStrategy());
    this.register(new TurtleBreakoutStrategy());
    this.register(new MinerviniTrendTemplateStrategy());
    this.register(new VolatilityContractionBreakoutStrategy());
    this.register(new DualMomentumRotationStrategy());
    this.register(new QualityMomentumBlendStrategy());
    this.register(new TrendPullbackReentryStrategy());
    this.register(new MultiFactorAlphaStrategy());
    this.register(new DragonHeadMomentumStrategy());
    this.register(new EarningsSurpriseStrategy());
  }

  register(strategy: QuantStrategy) {
    this.strategies.set(strategy.definition.strategy_key, strategy);
  }

  get(strategy_key: string): QuantStrategy | undefined {
    return this.strategies.get(strategy_key);
  }

  list(): QuantStrategyDefinition[] {
    return [...this.strategies.values()].map(strategy => strategy.definition);
  }

  enabled(): QuantStrategy[] {
    return [...this.strategies.values()].filter(strategy => strategy.definition.enabled);
  }

  resolve(strategy_keys?: string[]): QuantStrategy[] {
    if (!strategy_keys?.length) return this.enabled();
    return strategy_keys.map(key => this.get(key)).filter(Boolean) as QuantStrategy[];
  }
}

export const strategyRegistry = new StrategyRegistry();
