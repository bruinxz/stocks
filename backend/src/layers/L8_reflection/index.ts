/**
 * Layer L8 — Reflection Layer (复盘 / 归因 / 研究严谨性)
 *
 * 每笔交易关闭后的复盘 + 整体研究质量审查 (PBO / DSR / lookahead).
 * 不影响实时下单 (那是 L5+L6+L7), 但反过来给 L2/L3 提供 feedback (kill switch).
 *
 * 依赖: L1..L7 全可读
 * 被依赖: 无 (最顶层 / sink)
 */

// Research Integrity facade (v1)
export * from '../../services/research/ResearchIntegrityService';

// MLfAM + AFML Ch.6/9 (Sprint 19)
export * from '../../services/research/mlfam-afml-complete';

// AFML Advanced (Sprint 8)
export * from '../../services/research/afml-advanced';

// Aronson + Bulkowski (Sprint 13)
export * from '../../services/research/aronson-bulkowski';

// CPCV (v2)
export * from '../../services/research/cpcv';

// Bootstrap CI for PBO (v3)
export * from '../../services/research/bootstrap-ci';

// Causal inference for alpha (v5)
export * from '../../services/research/causal-inference';

// PCA + Fama-French (v6)
export * from '../../services/research/pca-fama-french';

// Volatility models GARCH/EGARCH/HAR-RV (v6)
export * from '../../services/research/volatility-models';

// Term Structure (v6)
export * from '../../services/research/term-structure';

// Bayesian Model Averaging (v6)
export * from '../../services/research/bayesian-model-averaging';

// Ilmanen + QEPM (Sprint 12)
export * from '../../services/research/ilmanen-qepm';

// Trade compliance wrapper (Sprint 24)
export * from '../../services/TradeComplianceChecker';
