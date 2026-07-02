/**
 * quant/etf — ETF 因子轮动主线基础设施 (信号优先重构 §4.1)
 *
 * 组成:
 *   - etfIndexMap: ETF → 跟踪指数高置信映射 (index_components 展开的 keystone)
 *   - ETFConstituentExpander: ETF → 成分股权重展开 (主 index_components / fallback fund_top_holdings)
 *   - ETFFactorService: 四因子打分 (Value 0.40 / Quality 0.30 / LowVol 0.30 / Momentum 0.0 shadow)
 *   - ETFRankingService: 排名 → BUY/SELL/HOLD + 70% 硬顶仓位分配
 */
export * from './etfIndexMap';
export * from './ETFConstituentExpander';
export * from './ETFFactorService';
export * from './ETFRankingService';
