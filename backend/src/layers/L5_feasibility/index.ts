/**
 * Layer L5 — Execution Feasibility Layer (执行可行性)
 *
 * 给定 L4 target weights → 检查每只票当下能否真的成交 (涨跌停 / 停牌 / T+1 /
 * 流动性 / 集合竞价 / ATR/手数 / 冲击成本). 输出 fillable_score + 调整后
 * order quantity. 这一层 *不* 撮合, 只算 "能不能 + 多少 slippage".
 *
 * 依赖: L1, L2, L3, L4
 * 被依赖: L6 / L7 (实盘下单, 在控制器层 instantiate)
 */

// Execution feasibility facade (v1)
export * from '../../services/execution/ExecutionFeasibilityService';

// Almgren-Chriss optimal execution (v2)
export * from '../../services/execution/almgren-chriss';

// Bouchaud square-root impact (v6)
export * from '../../services/execution/bouchaud-impact';

// Microstructure: Kyle Lambda / Glosten-Milgrom / PIN (v4)
export * from '../../services/execution/microstructure';

// Carver-Johnson-Chan execution (Sprint 14)
export * from '../../services/execution/carver-johnson-chan';

// Harris auctions / orders / vol traders / PIN (Sprint 17)
export * from '../../services/execution/harris-full';

// TCA — Transaction Cost Analysis (v4)
export * from '../../services/execution/tca';

// RL execution scheduling (v5)
export * from '../../services/execution/rl-execution';
