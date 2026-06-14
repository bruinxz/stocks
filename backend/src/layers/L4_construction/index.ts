/**
 * Layer L4 — Portfolio Construction Layer (组合构建)
 *
 * 从 L3 已 meta-labeled & sized 的 signals → portfolio weights.
 * 风险预算 / Black-Litterman / NCO / HRP / 行业-风格 cap / 波动率目标.
 *
 * 依赖: L1, L2, L3
 * 被依赖: L5 / L6 / L7 / L8
 */

// Portfolio Construction facade (v1)
export * from '../../services/portfolio/PortfolioConstructionService';

// HRP (v2)
export * from '../../services/portfolio/hrp';

// Ledoit-Wolf shrinkage (v2)
export * from '../../services/portfolio/ledoit-wolf';

// Black-Litterman (v3)
export * from '../../services/portfolio/black-litterman';

// Brinson + MCR + Style + Crowding + Vol Target (Sprint 20)
export * from '../../services/portfolio/brinson-mcr-style-crowding';

// Risk Parity with Tikhonov (v4)
export * from '../../services/portfolio/risk-parity-regularized';

// Boyd Convex Full (Sprint 16)
export * from '../../services/portfolio/boyd-convex-full';

// OSQP-style QP solver (v5)
export * from '../../services/portfolio/qp-solver';

// Thompson Sampling for strategy weight allocation (v5)
export * from '../../services/portfolio/thompson-sampling';
