/**
 * Layer L7 — Equity Curve Governor Layer (资金曲线治理)
 *
 * 监控实盘/纸盘表现 → 自动加风险 (赚钱期) / 降权 (连续失效) / 暂停 (回撤过深).
 * Kelly + fractional + Vince Optimal-f + Carver-style 资金管理.
 *
 * 依赖: L1, L4 (持仓), L6 (alerts)
 * 被依赖: L8
 */

// Equity Curve Governor (v1)
export * from '../../services/governor/EquityCurveGovernorService';

// Carver extensions (forecast scaling / FDM / vol target) (v2)
export * from '../../services/governor/carver-extensions';

// Vince Money Management (Sprint 9)
export * from '../../services/governor/vince-money-mgmt';

// Decision Quality Score + Freeman-Shor 7 (Sprint 10)
export * from '../../services/governor/decision-quality';

// Trader Mind Deep — Reason Triplet + 5 Wizards + Postmortem (Sprint 22)
export * from '../../services/governor/trader-mind-deep';
