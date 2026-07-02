import { QuantStrategy } from '../strategies/QuantStrategy';
import { MultiFactorAlphaStrategy } from '../strategies/MultiFactorAlphaStrategy';
import { DragonHeadMomentumStrategy } from '../strategies/DragonHeadMomentumStrategy';
import { EarningsSurpriseStrategy } from '../strategies/EarningsSurpriseStrategy';
import { QuantStrategyDefinition } from '../types/QuantTypes';

export class StrategyRegistry {
  private strategies = new Map<string, QuantStrategy>();

  constructor() {
    // 批3 (2026-07): 信号优先重构 — 29 策略削至 3 个保留策略.
    // multi_factor_alpha (enabled) + 龙头动量 + 业绩超预期, 均被 TodaySignalsService 直接消费.
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
    const enabledKeys = new Set(records.filter(r => r.enabled === true).map(r => r.strategy_key));
    if (!strategy_keys?.length) {
      return [...this.strategies.values()].filter(s => enabledKeys.has(s.definition.strategy_key));
    }
    return strategy_keys
      .map(key => (enabledKeys.has(key) ? this.get(key) : undefined))
      .filter(Boolean) as QuantStrategy[];
  }
}

export const strategyRegistry = new StrategyRegistry();
