import { Sequelize } from 'sequelize-typescript';
import { Stock } from '../models/Stock';
import { DailyBar } from '../models/DailyBar';
import { BacktestResult } from '../models/BacktestResult';
import { Trade } from '../models/Trade';
import { User } from '../models/User';
import { FavoriteStock } from '../models/FavoriteStock';
import { DataUpdateLog } from '../models/DataUpdateLog';
import { ScheduledTask } from '../models/ScheduledTask';
import { TaskExecutionLog } from '../models/TaskExecutionLog';
import { DailyScreener } from '../models/DailyScreener';
import { PaperTradingPortfolio } from '../models/PaperTradingPortfolio';
import { PaperTradingPosition } from '../models/PaperTradingPosition';
import { PaperTradingTrade } from '../models/PaperTradingTrade';
import { PaperTradingSnapshot } from '../models/PaperTradingSnapshot';
import { PaperTradingOrderIntent } from '../models/PaperTradingOrderIntent';
import { PaperTradingOrderIntentOutcome } from '../models/PaperTradingOrderIntentOutcome';
import { PaperTradingCanaryReviewSnapshot } from '../models/PaperTradingCanaryReviewSnapshot';
import { RiskAlert } from '../models/RiskAlert';
import { TradingJournal } from '../models/TradingJournal';
import { PortfolioSimulation } from '../models/PortfolioSimulation';
import { DataSourceHealth } from '../models/DataSourceHealth';
import { AIInvestmentSignal } from '../models/AIInvestmentSignal';
import { RecommendationTradeOutcome } from '../models/RecommendationTradeOutcome';
import { RecommendationLoopPolicySnapshot } from '../models/RecommendationLoopPolicySnapshot';
import { BudgetPolicyVersionSnapshot } from '../models/BudgetPolicyVersionSnapshot';
import { QuantStrategyModel } from '../models/QuantStrategyModel';
import { QuantBacktestTask } from '../models/QuantBacktestTask';
import { QuantBacktestResult } from '../models/QuantBacktestResult';
import { QuantBacktestTrade } from '../models/QuantBacktestTrade';
import { QuantSignal } from '../models/QuantSignal';
import { QuantStrategyPerformanceSnapshot } from '../models/QuantStrategyPerformanceSnapshot';
import { QuantStrategyWeight } from '../models/QuantStrategyWeight';
import { QuantStrategyExperiment } from '../models/QuantStrategyExperiment';
import { QuantResearchExperiment } from '../models/QuantResearchExperiment';
import { QuantResearchArtifact } from '../models/QuantResearchArtifact';
import { QuantStrategyParamVersion } from '../models/QuantStrategyParamVersion';
import { QuantStrategyParamValidation } from '../models/QuantStrategyParamValidation';
import { QuantFusionAudit } from '../models/QuantFusionAudit';
import { TaskParameterAuditLog } from '../models/TaskParameterAuditLog';
import { RealtimeQuote } from '../models/RealtimeQuote';
import { StockFundamentalFactor } from '../models/StockFundamentalFactor';
import { StockMoneyFlowFactor } from '../models/StockMoneyFlowFactor';
import { StockValuationFactor } from '../models/StockValuationFactor';
import { NorthboundHolding } from '../models/NorthboundHolding';
import { DragonTigerBoard } from '../models/DragonTigerBoard';
import { LimitUpStock } from '../models/LimitUpStock';
import { IndustryFlow } from '../models/IndustryFlow';
import { IndustryFlowIntraday } from '../models/IndustryFlowIntraday';
import { FactorScore } from '../models/FactorScore';
import { EarningsForecast } from '../models/EarningsForecast';
import { IndexComponent } from '../models/IndexComponent';
import { DividendHistory } from '../models/DividendHistory';
import { FinancialReport } from '../models/FinancialReport';
import { AnalystForecast } from '../models/AnalystForecast';
import { StockSentiment } from '../models/StockSentiment';
import { ShareholderCount } from '../models/ShareholderCount';
import { OptimizationRun } from '../models/OptimizationRun';
import { OptimizationResult } from '../models/OptimizationResult';
import { WalkForwardResult } from '../models/WalkForwardResult';
import { RegimeBacktestResult } from '../models/RegimeBacktestResult';
import { CostSensitivityResult } from '../models/CostSensitivityResult';
import { FactorICResult } from '../models/FactorICResult';
import { FactorCorrelationResult } from '../models/FactorCorrelationResult';
import { MonteCarloResult } from '../models/MonteCarloResult';
import { StrategyPortfolioResult } from '../models/StrategyPortfolioResult';
import { BenchmarkAttributionResult } from '../models/BenchmarkAttributionResult';
import { IndustryAttributionResult } from '../models/IndustryAttributionResult';
import { DailyAttributionReport } from '../models/DailyAttributionReport';
import { AIDiaryEntry } from '../models/AIDiaryEntry';
import { ErrorPatternReport } from '../models/ErrorPatternReport';
import { ImprovementSuggestion } from '../models/ImprovementSuggestion';
import { PersonalityStrategyMatchReport } from '../models/PersonalityStrategyMatchReport';
import { BlackSwanEvent } from '../models/BlackSwanEvent';
import { BlackSwanPostmortemReport } from '../models/BlackSwanPostmortemReport';
import { WebhookFallbackLog } from '../models/WebhookFallbackLog';
import { MorningRiskCheckup } from '../models/MorningRiskCheckup';
import { AIStockAnalysisReport } from '../models/AIStockAnalysisReport';
import { KOLOpinion } from '../models/KOLOpinion';
import { MarketSentimentIndex } from '../models/MarketSentimentIndex';
import { MarketBrief } from '../models/MarketBrief';
import { SnowballHotKeyword } from '../models/SnowballHotKeyword';
import { AnnouncementSummary } from '../models/AnnouncementSummary';
import { AnnouncementEventRelation } from '../models/AnnouncementEventRelation';
import { EastMoneyQATopic } from '../models/EastMoneyQATopic';
import { EastMoneyQAStat } from '../models/EastMoneyQAStat';
import { KOLAuthorStat } from '../models/KOLAuthorStat';
import { TechnicalAnalysisReport } from '../models/TechnicalAnalysisReport';
import { RestrictedShareRelease } from '../models/RestrictedShareRelease';
import { ShareholderTradeRecord } from '../models/ShareholderTradeRecord';
import { MarginTradingBalance } from '../models/MarginTradingBalance';
import { ETFFlow } from '../models/ETFFlow';
import { ETFCreationRedemption } from '../models/ETFCreationRedemption';
// PR-M1 (2026-06-29) — 隔夜信号矩阵
import { OvernightSignal } from '../models/OvernightSignal';
import { MarketNews } from '../models/MarketNews';
import { SocialSentimentSnapshot } from '../models/SocialSentimentSnapshot';
import { MarketHotSearch } from '../models/MarketHotSearch';
// 2026-06-11 新增 4 个数据维度
import { MacroIndicator } from '../models/MacroIndicator';
import { FundTopHolding } from '../models/FundTopHolding';
import { OptionQvix } from '../models/OptionQvix';
import { BlockTrade } from '../models/BlockTrade';
import { LiveBrokerAccount } from '../models/LiveBrokerAccount';
import { LiveAccountSnapshot } from '../models/LiveAccountSnapshot';
import { LivePosition } from '../models/LivePosition';
import { LiveOrderDraft } from '../models/LiveOrderDraft';
import { LiveOrder } from '../models/LiveOrder';
import { LiveTrade } from '../models/LiveTrade';
import { LiveExecutionAuditLog } from '../models/LiveExecutionAuditLog';
import { LiveKillSwitchState } from '../models/LiveKillSwitchState';
import { LiveBrokerCommand } from '../models/LiveBrokerCommand';
import { LiveBrokerCommandDispatch } from '../models/LiveBrokerCommandDispatch';
import { LiveBrokerEvent } from '../models/LiveBrokerEvent';
import { LiveBrokerBridgeHeartbeat } from '../models/LiveBrokerBridgeHeartbeat';
import { LiveBridgeNonce } from '../models/LiveBridgeNonce';
// Sprint 1-3 五大新模块 models
import { ResearchIntegrityAudit } from '../models/ResearchIntegrityAudit';
import { ExecutionFeasibilityRecord } from '../models/ExecutionFeasibilityRecord';
import { MetaLabelDecision } from '../models/MetaLabelDecision';
import { PortfolioConstructionResult } from '../models/PortfolioConstructionResult';
import { EquityCurveGovernorState } from '../models/EquityCurveGovernorState';
import { StrategyTcaMultiplier } from '../models/StrategyTcaMultiplier';
// Batch AL (2026-06-21) — SystemWorkspace 用户反馈闭环 model
import { UserFeedback } from '../models/UserFeedback';
// docs viewer 评论系统 (飞书式) — 2026-07-01
import { DocumentComment } from '../models/DocumentComment';
// Batch CE-C (2026-06-25) — 实时机会推送审计 model
import { IntradayOpportunityPush } from '../models/IntradayOpportunityPush';
// PR-M2 (2026-06-29) — 集合竞价快照 + 盘中 30-min K 线 (A 股最 robust 日内 alpha)
import { AuctionSnapshot } from '../models/AuctionSnapshot';
import { IntradayKline30Min } from '../models/IntradayKline30Min';
// PR-M3 (2026-06-29) — 板块情绪指数日度聚合
import { IndustrySentimentIndex } from '../models/IndustrySentimentIndex';
// PR-O5 (2026-06-30) — 题材发酵 5 阶段日度分类
import { ThemeFermentationPhase } from '../models/ThemeFermentationPhase';
import dotenv from 'dotenv';

dotenv.config();

const sequelize = new Sequelize({
  database: process.env.DB_NAME || 'stock_backtest',
  username: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  dialect: 'postgres',
  dialectOptions: {
    ssl:
      process.env.DB_SSL === 'true'
        ? {
            require: true,
            rejectUnauthorized: false,
          }
        : false,
  },
  models: [
    Stock,
    DailyBar,
    BacktestResult,
    Trade,
    User,
    FavoriteStock,
    DataUpdateLog,
    ScheduledTask,
    TaskExecutionLog,
    DailyScreener,
    PaperTradingPortfolio,
    PaperTradingPosition,
    PaperTradingTrade,
    PaperTradingSnapshot,
    PaperTradingOrderIntent,
    PaperTradingOrderIntentOutcome,
    PaperTradingCanaryReviewSnapshot,
    RiskAlert,
    TradingJournal,
    PortfolioSimulation,
    DataSourceHealth,
    AIInvestmentSignal,
    RecommendationTradeOutcome,
    RecommendationLoopPolicySnapshot,
    BudgetPolicyVersionSnapshot,
    QuantStrategyModel,
    QuantBacktestTask,
    QuantBacktestResult,
    QuantBacktestTrade,
    QuantSignal,
    QuantStrategyPerformanceSnapshot,
    QuantStrategyWeight,
    QuantStrategyExperiment,
    QuantResearchExperiment,
    QuantResearchArtifact,
    QuantStrategyParamVersion,
    QuantStrategyParamValidation,
    QuantFusionAudit,
    TaskParameterAuditLog,
    RealtimeQuote,
    StockFundamentalFactor,
    StockMoneyFlowFactor,
    StockValuationFactor,
    NorthboundHolding,
    DragonTigerBoard,
    LimitUpStock,
    IndustryFlow,
    IndustryFlowIntraday,
    FactorScore,
    EarningsForecast,
    IndexComponent,
    DividendHistory,
    FinancialReport,
    AnalystForecast,
    StockSentiment,
    ShareholderCount,
    OptimizationRun,
    OptimizationResult,
    WalkForwardResult,
    RegimeBacktestResult,
    CostSensitivityResult,
    FactorICResult,
    FactorCorrelationResult,
    MonteCarloResult,
    StrategyPortfolioResult,
    BenchmarkAttributionResult,
    IndustryAttributionResult,
    DailyAttributionReport,
    AIDiaryEntry,
    ErrorPatternReport,
    ImprovementSuggestion,
    PersonalityStrategyMatchReport,
    BlackSwanEvent,
    BlackSwanPostmortemReport,
    WebhookFallbackLog,
    MorningRiskCheckup,
    AIStockAnalysisReport,
    KOLOpinion,
    MarketSentimentIndex,
    MarketBrief,
    SnowballHotKeyword,
    AnnouncementSummary,
    AnnouncementEventRelation,
    EastMoneyQATopic,
    EastMoneyQAStat,
    KOLAuthorStat,
    TechnicalAnalysisReport,
    RestrictedShareRelease,
    ShareholderTradeRecord,
    MarginTradingBalance,
    ETFFlow,
    ETFCreationRedemption,
    OvernightSignal,
    MarketNews,
    SocialSentimentSnapshot,
    MarketHotSearch,
    // 2026-06-11 新增 4 个数据维度
    MacroIndicator,
    FundTopHolding,
    OptionQvix,
    BlockTrade,
    LiveBrokerAccount,
    LiveAccountSnapshot,
    LivePosition,
    LiveOrderDraft,
    LiveOrder,
    LiveTrade,
    LiveExecutionAuditLog,
    LiveKillSwitchState,
    LiveBrokerCommand,
    LiveBrokerCommandDispatch,
    LiveBrokerEvent,
    LiveBrokerBridgeHeartbeat,
    LiveBridgeNonce,
    // Sprint 1-3 五大新模块
    ResearchIntegrityAudit,
    ExecutionFeasibilityRecord,
    MetaLabelDecision,
    PortfolioConstructionResult,
    EquityCurveGovernorState,
    StrategyTcaMultiplier,
    // Batch AL (2026-06-21) — SystemWorkspace 用户反馈闭环
    UserFeedback,
    // docs 评论系统 — 2026-07-01
    DocumentComment,
    // Batch CE-C (2026-06-25) — 实时机会推送审计
    IntradayOpportunityPush,
    // PR-M2 (2026-06-29) — 集合竞价快照 + 盘中 30-min K 线
    AuctionSnapshot,
    IntradayKline30Min,
    // PR-M3 (2026-06-29) — 板块情绪指数日度聚合
    IndustrySentimentIndex,
    // PR-O5 (2026-06-30) — 题材发酵 5 阶段日度分类
    ThemeFermentationPhase,
  ],
  logging: process.env.NODE_ENV === 'development' ? console.log : false,
  pool: {
    max: 10,
    min: 0,
    acquire: 30000,
    idle: 10000,
  },
});

/**
 * AR-1 (2026-06-21): cold-path model registration guard.
 *
 * 症状: standalone 脚本 / 测试 / cold-path service 直接 `require('../models/X')`
 *       不触发 `config/database.ts` 的副作用导入, 模型保持 un-initialized,
 *       第一次访问报 `"X" needs to be added to a Sequelize instance`.
 *
 * 方案: 每个会走 cold path 的 service entry (e.g. PaperTradingAutomationService) 在
 *       文件顶部 `import '../../config/database';` 触发本模块加载, 构造函数
 *       内 `new Sequelize({...models: [...]})` 已把所有模型 addModels 一次.
 *       本 helper 做防御性 idempotent 兜底: 若发现 sequelize.models 为空
 *       (异常 boot order), 显式再 addModels 一次, 不会因二次注册抛错
 *       (sequelize-typescript 允许同一 model 多次 addModels — initialize
 *        本身是 idempotent 写入 attributes/options).
 *
 * 不需要在每个 service entry 显式调本函数 — 仅做"出问题时一行兜底".
 */
export function ensureModelsRegistered(): void {
  if (Object.keys(sequelize.models).length > 0) return;
  // Defensive: should never hit in normal flow, but recovers from any future
  // boot-order regression without re-throwing.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const opts = (sequelize as any).options;
  if (opts && Array.isArray(opts.models) && opts.models.length > 0) {
    sequelize.addModels(opts.models);
  }
}

export { sequelize };
export default sequelize;
