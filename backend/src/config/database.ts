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
import { QuantBacktestTask } from '../models/QuantBacktestTask';
import { QuantBacktestResult } from '../models/QuantBacktestResult';
import { QuantBacktestTrade } from '../models/QuantBacktestTrade';
import { TaskParameterAuditLog } from '../models/TaskParameterAuditLog';
import { RealtimeQuote } from '../models/RealtimeQuote';
import { NorthboundHolding } from '../models/NorthboundHolding';
import { DragonTigerBoard } from '../models/DragonTigerBoard';
import { LimitUpStock } from '../models/LimitUpStock';
import { IndustryFlow } from '../models/IndustryFlow';
import { FactorScore } from '../models/FactorScore';
import { EarningsForecast } from '../models/EarningsForecast';
import { IndexComponent } from '../models/IndexComponent';
import { DividendHistory } from '../models/DividendHistory';
import { FinancialReport } from '../models/FinancialReport';
import { StockValuationFactor } from '../models/StockValuationFactor';
import { StockFundamentalFactor } from '../models/StockFundamentalFactor';
import { StockMoneyFlowFactor } from '../models/StockMoneyFlowFactor';
import { AnalystForecast } from '../models/AnalystForecast';
import { OptimizationRun } from '../models/OptimizationRun';
import { OptimizationResult } from '../models/OptimizationResult';
import { WalkForwardResult } from '../models/WalkForwardResult';
import { RegimeBacktestResult } from '../models/RegimeBacktestResult';
import { CostSensitivityResult } from '../models/CostSensitivityResult';
import { FactorICResult } from '../models/FactorICResult';
import { FactorCorrelationResult } from '../models/FactorCorrelationResult';
import { MonteCarloResult } from '../models/MonteCarloResult';
import { BenchmarkAttributionResult } from '../models/BenchmarkAttributionResult';
import { IndustryAttributionResult } from '../models/IndustryAttributionResult';
import { DailyAttributionReport } from '../models/DailyAttributionReport';
import { AIDiaryEntry } from '../models/AIDiaryEntry';
import { ErrorPatternReport } from '../models/ErrorPatternReport';
import { ImprovementSuggestion } from '../models/ImprovementSuggestion';
import { BlackSwanEvent } from '../models/BlackSwanEvent';
import { BlackSwanPostmortemReport } from '../models/BlackSwanPostmortemReport';
import { WebhookFallbackLog } from '../models/WebhookFallbackLog';
import { MorningRiskCheckup } from '../models/MorningRiskCheckup';
import { AIStockAnalysisReport } from '../models/AIStockAnalysisReport';
import { MarketSentimentIndex } from '../models/MarketSentimentIndex';
import { MarketBrief } from '../models/MarketBrief';
import { AnnouncementSummary } from '../models/AnnouncementSummary';
import { AnnouncementEventRelation } from '../models/AnnouncementEventRelation';
import { TechnicalAnalysisReport } from '../models/TechnicalAnalysisReport';
import { ETFFlow } from '../models/ETFFlow';
import { ETFCreationRedemption } from '../models/ETFCreationRedemption';
// PR-M1 (2026-06-29) — 隔夜信号矩阵
import { MarketNews } from '../models/MarketNews';
// 2026-06-11 新增 4 个数据维度
import { MacroIndicator } from '../models/MacroIndicator';
import { FundTopHolding } from '../models/FundTopHolding';
import { OptionQvix } from '../models/OptionQvix';
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
// Batch AL (2026-06-21) — SystemWorkspace 用户反馈闭环 model
import { UserFeedback } from '../models/UserFeedback';
// docs viewer 评论系统 (飞书式) — 2026-07-01
import { DocumentComment } from '../models/DocumentComment';
// Batch CE-C (2026-06-25) — 实时机会推送审计 model
// PR-M2 (2026-06-29) — 集合竞价快照 + 盘中 30-min K 线 (A 股最 robust 日内 alpha)
// PR-M3 (2026-06-29) — 板块情绪指数日度聚合
import { IndustrySentimentIndex } from '../models/IndustrySentimentIndex';
// PR-O5 (2026-06-30) — 题材发酵 5 阶段日度分类
import { ThemeFermentationPhase } from '../models/ThemeFermentationPhase';
// 2026-07-08 — 交易日历 (§D4.G2 契约 · PR #96 DDL landed @ 6299a3d4)
import { TradingCalendar } from '../models/TradingCalendar';
import { JpkrSecurityMaster } from '../models/JpkrSecurityMaster';
import { JpkrDailyKline } from '../models/JpkrDailyKline';
import { JpkrDisclosureEvent } from '../models/JpkrDisclosureEvent';
import { JpkrFinancialSnapshot } from '../models/JpkrFinancialSnapshot';
import { JpkrFxObservation } from '../models/JpkrFxObservation';
import { MultibaggerUniverse } from '../models/MultibaggerUniverse';
import { MultibaggerTextHit } from '../models/MultibaggerTextHit';
import { MultibaggerCandidateSnapshot } from '../models/MultibaggerCandidateSnapshot';
import { BacktestPitSnapshot } from '../models/BacktestPitSnapshot';
import { BacktestPitHolding } from '../models/BacktestPitHolding';
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
    QuantBacktestTask,
    QuantBacktestResult,
    QuantBacktestTrade,
    TaskParameterAuditLog,
    RealtimeQuote,
    NorthboundHolding,
    DragonTigerBoard,
    LimitUpStock,
    IndustryFlow,
    FactorScore,
    EarningsForecast,
    IndexComponent,
    DividendHistory,
    FinancialReport,
    StockValuationFactor,
    StockFundamentalFactor,
    StockMoneyFlowFactor,
    AnalystForecast,
    OptimizationRun,
    OptimizationResult,
    WalkForwardResult,
    RegimeBacktestResult,
    CostSensitivityResult,
    FactorICResult,
    FactorCorrelationResult,
    MonteCarloResult,
    BenchmarkAttributionResult,
    IndustryAttributionResult,
    DailyAttributionReport,
    AIDiaryEntry,
    ErrorPatternReport,
    ImprovementSuggestion,
    BlackSwanEvent,
    BlackSwanPostmortemReport,
    WebhookFallbackLog,
    MorningRiskCheckup,
    AIStockAnalysisReport,
    MarketSentimentIndex,
    MarketBrief,
    AnnouncementSummary,
    AnnouncementEventRelation,
    TechnicalAnalysisReport,
    ETFFlow,
    ETFCreationRedemption,
    MarketNews,
    // 2026-06-11 新增 4 个数据维度
    MacroIndicator,
    FundTopHolding,
    OptionQvix,
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
    // Batch AL (2026-06-21) — SystemWorkspace 用户反馈闭环
    UserFeedback,
    // docs 评论系统 — 2026-07-01
    DocumentComment,
    // Batch CE-C (2026-06-25) — 实时机会推送审计
    // PR-M2 (2026-06-29) — 集合竞价快照 + 盘中 30-min K 线
    // PR-M3 (2026-06-29) — 板块情绪指数日度聚合
    IndustrySentimentIndex,
    // PR-O5 (2026-06-30) — 题材发酵 5 阶段日度分类
    ThemeFermentationPhase,
    // 2026-07-08 — 交易日历 (§D4.G2 契约 · PR #96 DDL landed @ 6299a3d4)
    TradingCalendar,
    // Sprint 3 Phase 1 — JP/KR, multibagger, and normalized PIT storage.
    JpkrSecurityMaster,
    JpkrDailyKline,
    JpkrDisclosureEvent,
    JpkrFinancialSnapshot,
    JpkrFxObservation,
    MultibaggerUniverse,
    MultibaggerTextHit,
    MultibaggerCandidateSnapshot,
    BacktestPitSnapshot,
    BacktestPitHolding,
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
