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
  paper_trade_initial_capital?: number;
  paper_trade_force_new_portfolio?: boolean;
  paper_trade_min_score?: number;
  paper_trade_max_positions?: number;
  paper_trade_default_position_pct?: number;
  paper_trade_max_position_pct?: number;
  paper_trade_min_trade_amount?: number;
  paper_trade_risk_profile_gate?: any;
  strategy_allocation_policy?: any;
  strategy_allocation_pct?: number;
  strategy_max_single_trade_pct?: number;
  quant_agent_fusion?: boolean;
  current_price?: number;
  price_change_pct?: number;
  data_quality_score?: number;
  data_quality_bucket?: string;
  data_quality?: any;
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
