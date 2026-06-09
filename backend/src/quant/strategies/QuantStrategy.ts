import {
  QuantSignalResult,
  QuantStockContext,
  QuantStrategyDefinition,
  QuantStrategyRuntimeOptions,
} from '../types/QuantTypes';

/**
 * QuantStrategy 抽象基类 —— 所有策略实现的基础。
 *
 * **US-083 dry-run 字段**：
 *   - 实例级 `dryRun: boolean` 字段（默认 false）控制 `applyAutomation` 是否真实下单。
 *   - 持久化存储在 `QuantStrategyModel.lifecycle_policy.dry_run`（JSONB 子字段）。
 *   - StrategyEngine 在 syncRegistry / 调用前会从 DB 读取并 setDryRun()，
 *     PaperTradingFacade.applyAutomation 通过 QuantStrategyModel 查询 dry-run 策略集合
 *     来决定每条信号是真实下单还是仅写信号到 QuantSignal 表（不下单）。
 *   - 仅信号产出与持久化（QuantSignal 写入）不受 dryRun 影响 —— dryRun 只阻止
 *     PaperTradingAutomationService 的 placeOrder/createBuyTrade 调用，信号仍正常入库。
 *   - 也可以通过 runtime options 临时 override（一次性 dry-run 调用）。
 */
export abstract class QuantStrategy {
  abstract readonly definition: QuantStrategyDefinition;

  /**
   * Per-instance dry-run flag.  Default false (live trading).
   * Mutable via setDryRun() so DB-loaded config can be applied at runtime.
   *
   * 当 dryRun=true 时，PaperTradingFacade.applyAutomation 检测到后，
   * 只将策略产生的信号写入 QuantSignal 表，不调用 placeOrder 实际下单。
   */
  public dryRun = false;

  abstract evaluate(
    context: QuantStockContext,
    options?: QuantStrategyRuntimeOptions
  ): QuantSignalResult;

  /**
   * Update dry-run flag at runtime.  Called by StrategyEngine when it loads
   * `lifecycle_policy.dry_run` from QuantStrategyModel.  Coerces non-boolean
   * inputs (string / null / undefined) safely to false.
   */
  setDryRun(value: unknown): void {
    this.dryRun = value === true || value === 'true';
  }

  /**
   * Effective dry-run for this evaluation — runtime override wins if provided,
   * otherwise falls back to the persistent instance flag.
   */
  isDryRun(options?: QuantStrategyRuntimeOptions): boolean {
    if (options && options.dryRun !== undefined) return Boolean(options.dryRun);
    return this.dryRun;
  }

  protected mergeParams(options?: QuantStrategyRuntimeOptions): Record<string, any> {
    return {
      ...(this.definition.default_params || {}),
      ...(options?.params || {}),
    };
  }
}
