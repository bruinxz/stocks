/**
 * @fileoverview SeededRandom · Park-Miller LCG 简易确定性随机源
 *
 * 承接位: Task #35 · US-038 直修红线之 SeededRandom API 通用位挪位（A1 α-strict 定稿）
 *
 * 权威锚:
 *   ADR-0002 §2.2.1 v1.2.1 · US-038 直修红线段（M-2/M-3 SeededRandom default 承接位）
 *   ADR-0001 §附录 v1.3.1 · 16 处清单 3 直修红线事件位
 *   Orchestrator msg=1d512bc7 · 独占裁 A1 定稿采纳
 *
 * 权威源 origin: backend/src/quant/backtest/BayesianOptimizer.ts:174 (Task #35 前定义位)
 *
 * 目的:
 *   同 seed 完全可复现 · 避免引入 Math.random 让测试 / 回测 / 论文复现都失败。
 *   周期 2^31 - 1 · 对贝叶斯优化 / Monte Carlo / factor discovery 等 O(1e2-1e4)
 *   次采样完全足够。
 *
 * 语义等价保:
 *   API shape 与原 BayesianOptimizer 内定义 100% 等价（class + constructor(seed=42)
 *   + next(): number in [0,1) + nextRange(min, max): number in [min,max)）·
 *   Task #35 承接 caller migration (BayesianOptimizer.ts / MonteCarloStressTest.ts
 *   / PortfolioOptimizer.ts) import path 单向下依赖至本 utils 层。
 *
 * §Layer-Separation:
 *   utils 层通用位 · services/research + services/execution + quant/backtest
 *   等上层单向下依赖 · 避免跨层 import (services → quant/backtest)。
 */

/**
 * Park-Miller LCG 简易随机源。同 seed 完全可复现，避免引入 Math.random 让
 * 测试 / 回测 / 论文复现都失败。返回 [0, 1) 的浮点。
 *
 * 周期 2^31 - 1，对贝叶斯优化的 ~100 次采样完全足够。
 */
export class SeededRandom {
  private state: number;

  constructor(seed = 42) {
    // 初始 state 不能为 0，否则 LCG 永远卡在 0
    const s = Math.floor(Math.abs(seed)) % 2147483647;
    this.state = s === 0 ? 1 : s;
  }

  /** 返回 [0, 1) 的浮点 */
  next(): number {
    // Park-Miller "minimal standard" minstd_rand0：a = 16807, m = 2^31-1
    this.state = (this.state * 16807) % 2147483647;
    return (this.state - 1) / 2147483646;
  }

  /** [min, max) 浮点 */
  nextRange(min: number, max: number): number {
    return min + (max - min) * this.next();
  }
}
