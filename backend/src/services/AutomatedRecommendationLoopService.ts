import moment from 'moment-timezone';
import { quantRecommendationService } from './QuantRecommendationService';
import { aiInvestmentSignalService } from './AIInvestmentSignalService';
import { paperTradingAutomationService } from './PaperTradingAutomationService';
import { feishuTaskReportService } from './FeishuTaskReportService';
import { logger } from '../utils/logger';
import { AISignalSourceType } from '../models/AIInvestmentSignal';

export interface AutomatedRecommendationLoopOptions {
  username?: string;
  universe?: 'favorites' | 'market';
  style?: 'balanced' | 'momentum' | 'value' | 'low_risk';
  candidate_limit?: number;
  candidate_pool_limit?: number;
  lookback_days?: number;
  min_bars?: number;
  exclude_st?: boolean;
  min_market_cap_yi?: number;
  archive_limit?: number;
  verify_signals?: boolean;
  run_paper_trading?: boolean;
  dry_run?: boolean;
  paper_trade_limit?: number;
  paper_trade_scan_limit?: number;
  min_score?: number;
  max_positions?: number;
  default_position_pct?: number;
  max_position_pct?: number;
  min_trade_amount?: number;
  use_profit_gate?: boolean;
  profit_gate_horizon?: string;
  profit_gate_min_samples?: number;
  profit_gate_min_quality_score?: number;
  report_to_feishu?: boolean;
  record_type?: string;
}

function toPositiveInt(value: any, fallback: number, max?: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  const normalized = Math.floor(parsed);
  return max ? Math.min(normalized, max) : normalized;
}

class AutomatedRecommendationLoopService {
  async run(options: AutomatedRecommendationLoopOptions = {}) {
    const universe = options.universe === 'favorites' ? 'favorites' : 'market';
    const style = ['balanced', 'momentum', 'value', 'low_risk'].includes(options.style || '')
      ? options.style!
      : 'balanced';
    const candidateLimit = toPositiveInt(options.candidate_limit, universe === 'market' ? 30 : 20, 100);
    const archiveLimit = toPositiveInt(options.archive_limit, candidateLimit, 100);
    const lookbackDays = toPositiveInt(options.lookback_days, 120, 360);
    const generated = await quantRecommendationService.generateRecommendations({
      universe,
      style,
      limit: candidateLimit,
      lookback_days: lookbackDays,
      min_bars: toPositiveInt(options.min_bars, 35, lookbackDays),
      include_trend: true,
      candidate_pool_limit: toPositiveInt(
        options.candidate_pool_limit,
        universe === 'market' ? Math.max(candidateLimit * 12, 240) : Math.max(candidateLimit * 6, 60),
        1000
      ),
      exclude_st: options.exclude_st !== false,
      min_market_cap_yi:
        options.min_market_cap_yi === undefined ? 30 : Number(options.min_market_cap_yi),
    });

    const archiveCandidates = (generated.recommendations || []).slice(0, archiveLimit);
    const archive = await aiInvestmentSignalService.archiveQuantRecommendations({
      candidates: archiveCandidates,
      universe,
      style,
      as_of: generated.as_of,
    });

    let verification: any = null;
    if (options.verify_signals !== false) {
      verification = await aiInvestmentSignalService.verifySignals({
        source_type: AISignalSourceType.QUANT_RECOMMENDATION,
        limit: Math.max(archive.total || 0, 50),
      });
      (archive as any).verification = verification;
    }

    let paper_trading: any = null;
    if (options.run_paper_trading) {
      paper_trading = await paperTradingAutomationService.runAutoSync({
        username: options.username,
        refresh_recommendations: false,
        source_type: AISignalSourceType.QUANT_RECOMMENDATION,
        limit: toPositiveInt(options.paper_trade_limit, 3, 20),
        scan_limit: toPositiveInt(options.paper_trade_scan_limit, Math.max(archive.total, 100), 500),
        min_score: Number(options.min_score || 72),
        max_positions: toPositiveInt(options.max_positions, 8, 30),
        default_position_pct: Number(options.default_position_pct || 5),
        max_position_pct: Number(options.max_position_pct || 10),
        min_trade_amount: Number(options.min_trade_amount || 3000),
        allowed_risk_levels: ['low', 'medium'],
        require_action_buy: true,
        use_attribution_feedback: true,
        use_profit_gate: options.use_profit_gate !== false,
        profit_gate_horizon: options.profit_gate_horizon || '5d',
        profit_gate_min_samples: toPositiveInt(options.profit_gate_min_samples, 5, 100),
        profit_gate_min_quality_score: Number(options.profit_gate_min_quality_score || 45),
        profit_gate_allow_deprioritized: false,
        dry_run: Boolean(options.dry_run),
        report_to_feishu: false,
      });
    }

    const quality_report = await aiInvestmentSignalService.getSignalQualityReport({
      source_type: AISignalSourceType.QUANT_RECOMMENDATION,
      horizon: options.profit_gate_horizon || '5d',
      lookback_days: 60,
      min_samples: toPositiveInt(options.profit_gate_min_samples, 5, 100),
      limit: 5000,
      verify_before_report: false,
      auto_repair_missing_data: false,
      report_to_feishu: false,
    });

    const result = {
      generated_at: moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss'),
      universe,
      style,
      generated,
      archive,
      verification,
      paper_trading,
      quality_report: {
        overview: quality_report.overview,
        best_segments: quality_report.best_segments,
        worst_segments: quality_report.worst_segments,
      },
    };

    if (options.report_to_feishu !== false) {
      await feishuTaskReportService.reportAutomatedRecommendationLoop(result, {
        record_type: options.record_type || '全市场荐股闭环',
      });
    }

    logger.info(
      `荐股闭环完成：${universe}/${style} 候选 ${generated.analyzed_candidates}/${generated.total_candidates}，归档 ${archive.total}，模拟盘 ${
        paper_trading?.executed ?? paper_trading?.planned ?? 0
      }`
    );

    return result;
  }
}

export const automatedRecommendationLoopService = new AutomatedRecommendationLoopService();
