/**
 * Layer L3 — Meta Decision Layer (元决策 / 标签 / 仓位)
 *
 * 对 L2 raw signal 做二次过滤 + 标签 + 仓位 sizing.
 * 核心问题: "这个 L2 信号到底要不要做? 做多大?"
 *
 * 依赖: L1, L2
 * 被依赖: L4 / L5 / L6 / L7 / L8
 */

// Meta-labeling (v1)
export * from '../../services/meta/MetaLabelService';

// Triple Barrier labeling (v2)
export * from '../../services/meta/triple-barrier';

// Purged K-Fold CV (v2)
export * from '../../services/meta/purged-k-fold';

// AFML Bet Sizing (Sprint 7/10)
export * from '../../services/meta/afml-bet-sizing';

// Sample weights (Sprint 7)
export * from '../../services/meta/afml-sample-weights';

// Feature importance MDA/SFI (Sprint 7)
export * from '../../services/meta/afml-feature-importance';

// AFML Strategy Stats (Sprint 7)
export * from '../../services/meta/afml-strategy-stats';

// Fractional differentiation (v3)
export * from '../../services/meta/fractional-diff';

// Information bars (v3)
export * from '../../services/meta/information-bars';

// Online learning (v3)
export * from '../../services/meta/online-learning';
