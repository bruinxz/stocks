import Bull from 'bull';
import { logger } from '../utils/logger';

export interface AIPollingJobData {
  taskId: string;
  symbol: string;
  name: string;
  executionLogId?: number;
  scheduler_task_type?: string;
  loopRunId?: string;
  loopPolicySnapshotId?: number;
  taskLabel?: string; // 任务标签，如 "AI优选-早盘分析"
  quant_score?: number;
  quant_factors?: any[];
  quant_reasons?: string[];
  quant_warnings?: string[];
  recommendation_style?: string;
  recommendation_source?: string;
  strategy_key?: string;
  strategy_variant?: any;
  market_environment?: any;
  environment_policy?: any;
  environment_policy_snapshot_id?: string;
  agent_session?: string;
  auto_paper_trade?: boolean;
  paper_trade_username?: string;
  paper_trade_portfolio_name?: string;
  agent_only_auto_paper_trade?: boolean;
  agent_only_paper_trade_portfolio_name?: string;
  agent_only_paper_trade_min_score?: number;
  agent_only_paper_trade_max_positions?: number;
  agent_only_paper_trade_default_position_pct?: number;
  agent_only_paper_trade_max_position_pct?: number;
  agent_only_paper_trade_min_trade_amount?: number;
  agent_only_paper_trade_risk_profile_gate?: any;
  paper_trade_initial_capital?: number;
  paper_trade_force_new_portfolio?: boolean;
  paper_trade_min_score?: number;
  paper_trade_max_positions?: number;
  paper_trade_default_position_pct?: number;
  paper_trade_max_position_pct?: number;
  paper_trade_min_trade_amount?: number;
  paper_trade_risk_profile_gate?: any;
  allow_low_data_quality_for_forced_signals?: boolean;
  strategy_allocation_policy?: any;
  strategy_runtime_policy?: any;
  strategy_allocation_pct?: number;
  strategy_max_single_trade_pct?: number;
  strategy_budget_discipline?: any;
  quant_agent_fusion?: boolean;
  current_price?: number;
  price_change_pct?: number;
  data_quality_score?: number;
  data_quality_bucket?: string;
  data_quality?: any;
  /**
   * Batch N (2026-06-17): 透传 dry_run_strategy_keys 让 worker 在 autoBuyFromSignals
   * 时让 dry-run 策略真正只 plan 不下单. 之前 fusion → archive → submitAgentReview
   * → aiPollingQueue 这条 cron 链路完全不传, dry-run lever 经此路径失效.
   */
  dry_run_strategy_keys?: string[];
}

const aiPollingQueue = new Bull<AIPollingJobData>('ai_polling', {
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD,
    db: parseInt(process.env.REDIS_DB || '0'),
  },
  defaultJobOptions: {
    attempts: 10,
    backoff: {
      type: 'fixed',
      delay: 3 * 60 * 1000, // 3 minutes
    },
    removeOnComplete: 200,
    removeOnFail: false,
  },
});

aiPollingQueue.on('error', error => logger.error('aiPollingQueue 错误:', error));
aiPollingQueue.on('failed', (job, error) =>
  logger.error(`AI 分析轮询任务 ${job?.id} 失败:`, error)
);

export { aiPollingQueue };
