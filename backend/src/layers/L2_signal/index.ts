/**
 * Layer L2 — Signal Layer (信号生成)
 *
 * 策略 / 因子 / 形态识别. 输入 L1 raw data, 输出 quantitative signals
 * (strategy score / factor score / pattern reliability).
 *
 * 依赖: L1
 * 被依赖: L3 / L4 / L5 / L6 / L7 / L8
 */

// Pattern library (Sprint 13/21 + Sprint 24 inferLocalRegime)
export * from '../../services/research/pattern-library';

// Factor discovery (v4)
export * from '../../services/research/factor-discovery';

// Grinold-Kahn fundamental law (v4)
export * from '../../services/research/grinold-kahn';

// ML foundation — ESL/ISL/Hyndman (Sprint 15)
export * from '../../services/research/ml-foundation';

// China research factor models (Sprint 11)
export * from '../../services/research/china-research';
