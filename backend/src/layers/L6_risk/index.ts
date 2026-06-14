/**
 * Layer L6 — Risk Layer (风控 / Pre-trade guards / Post-trade alerts)
 *
 * 9 个 pre/post-trade guards (US-047..US-089) + DrawdownCircuitBreaker +
 * MarketRegimeAlert + BlackSwanWatchdog 等. 在 placeOrder / EOD 触发, 写
 * RiskAlert 或 block trade.
 *
 * 依赖: L1, L4 (持仓数据), L5 (订单)
 * 被依赖: L7 / L8
 *
 * 注: 9 个 guards 物理位置在 backend/src/portfolio/risk/, 已通过
 * PaperTradingFacade 接入. 本 layer 只 re-export 与"风控类事后分析"相关的纯函数.
 */

// 重排监控 — 容量 / Alpha Decay (Sprint 23)
// 注: ashare-pit-capacity 同时被 L1 re-export, 容量监控属 L6 风控语义
export {
  estimateStrategyCapacity,
  observedHalfLife,
  monitorAlphaDecay,
  recommendHoldingPeriod,
  SIGNAL_HALF_LIVES,
} from '../../services/research/ashare-pit-capacity';

// HMM regime detection (v5) — 用于 regime-aware 风控策略
export * from '../../services/research/hmm-regime';
