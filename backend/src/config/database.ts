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
import { FactorICResult } from '../models/FactorICResult';
import { FactorCorrelationResult } from '../models/FactorCorrelationResult';
import { MonteCarloResult } from '../models/MonteCarloResult';
import { StrategyPortfolioResult } from '../models/StrategyPortfolioResult';
import { BenchmarkAttributionResult } from '../models/BenchmarkAttributionResult';
import { IndustryAttributionResult } from '../models/IndustryAttributionResult';
import { MorningRiskCheckup } from '../models/MorningRiskCheckup';
import { AIStockAnalysisReport } from '../models/AIStockAnalysisReport';
import { KOLOpinion } from '../models/KOLOpinion';
import { MarketSentimentIndex } from '../models/MarketSentimentIndex';
import { SnowballHotKeyword } from '../models/SnowballHotKeyword';
import { LiveBrokerAccount } from '../models/LiveBrokerAccount';
import { LiveAccountSnapshot } from '../models/LiveAccountSnapshot';
import { LivePosition } from '../models/LivePosition';
import { LiveOrderDraft } from '../models/LiveOrderDraft';
import { LiveOrder } from '../models/LiveOrder';
import { LiveTrade } from '../models/LiveTrade';
import { LiveExecutionAuditLog } from '../models/LiveExecutionAuditLog';
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
    FactorICResult,
    FactorCorrelationResult,
    MonteCarloResult,
    StrategyPortfolioResult,
    BenchmarkAttributionResult,
    IndustryAttributionResult,
    MorningRiskCheckup,
    AIStockAnalysisReport,
    KOLOpinion,
    MarketSentimentIndex,
    SnowballHotKeyword,
    LiveBrokerAccount,
    LiveAccountSnapshot,
    LivePosition,
    LiveOrderDraft,
    LiveOrder,
    LiveTrade,
    LiveExecutionAuditLog,
  ],
  logging: process.env.NODE_ENV === 'development' ? console.log : false,
  pool: {
    max: 10,
    min: 0,
    acquire: 30000,
    idle: 10000,
  },
});

export { sequelize };
export default sequelize;
