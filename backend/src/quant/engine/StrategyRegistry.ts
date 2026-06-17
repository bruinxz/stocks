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
import { NorthboundFollowStrategy } from '../strategies/NorthboundFollowStrategy';
import { CTA100MomentumStrategy } from '../strategies/CTA100MomentumStrategy';
import { SectorRotationLeaderStrategy } from '../strategies/SectorRotationLeaderStrategy';
import { HighDividendValueStrategy } from '../strategies/HighDividendValueStrategy';
import { BreakoutStrategy } from '../strategies/BreakoutStrategy';
import { GARPStrategy } from '../strategies/GARPStrategy';
import { GameTraderRelayStrategy } from '../strategies/GameTraderRelayStrategy';
import { LeftSideReversalStrategy } from '../strategies/LeftSideReversalStrategy';
import { LinkageStrategy } from '../strategies/LinkageStrategy';
import { EnsembleStrategy } from '../strategies/EnsembleStrategy';
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
    this.register(new NorthboundFollowStrategy());
    this.register(new CTA100MomentumStrategy());
    this.register(new SectorRotationLeaderStrategy());
    this.register(new HighDividendValueStrategy());
    this.register(new BreakoutStrategy());
    this.register(new GARPStrategy());
    this.register(new GameTraderRelayStrategy());
    this.register(new LeftSideReversalStrategy());
    this.register(new LinkageStrategy());
    this.register(new EnsembleStrategy());
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

  /**
   * Batch N (2026-06-17, B3 fix): 异步版 resolve, 用 DB `QuantStrategyModel.enabled`
   * 作为 source of truth. 修复 kill-switch lever 真生效:
   *
   * 之前 `enabled()` / `resolve()` 用 in-memory `definition.enabled` (启动时静态常量),
   * StrategyKillSwitchMonitor 把 DB 改 enabled=false 后, 下一轮 cron 仍跑该策略 →
   * 整条 kill-switch 失灵. 现在 caller (SignalEngine / fusion) 调 resolveFromDb 拿
   * DB 真实状态. 调用频率低 (per-pipeline 一次), 走 DB 不影响性能.
   *
   * fail-CLOSED: DB 失败时 throw 让 caller abort, 而不是 silent 返 in-memory 所有
   * enabled (会绕过 kill-switch).
   */
  async resolveFromDb(strategy_keys?: string[]): Promise<QuantStrategy[]> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { QuantStrategyModel } = require('../../models/QuantStrategyModel');
    const records: Array<{ strategy_key: string; enabled: boolean }> =
      await QuantStrategyModel.findAll({
        attributes: ['strategy_key', 'enabled'],
        raw: true,
      });
    const enabledKeys = new Set(
      records.filter(r => r.enabled === true).map(r => r.strategy_key)
    );
    if (!strategy_keys?.length) {
      return [...this.strategies.values()].filter(s =>
        enabledKeys.has(s.definition.strategy_key)
      );
    }
    return strategy_keys
      .map(key => (enabledKeys.has(key) ? this.get(key) : undefined))
      .filter(Boolean) as QuantStrategy[];
  }
}

export const strategyRegistry = new StrategyRegistry();
