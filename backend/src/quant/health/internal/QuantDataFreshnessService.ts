import moment from 'moment-timezone';
import { AIInvestmentSignal } from '../../../models/AIInvestmentSignal';
import { QuantFusionAudit } from '../../../models/QuantFusionAudit';
import { QuantSignal } from '../../../models/QuantSignal';
import { QuantStrategyParamValidation } from '../../../models/QuantStrategyParamValidation';
import { RealtimeQuote } from '../../../models/RealtimeQuote';
import { RecommendationTradeOutcome } from '../../../models/RecommendationTradeOutcome';
import { stockFactorService } from '../../../data/services/StockFactorService';

function toNumber(value: any, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeDate(value: any): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10) || null;
  return date.toISOString();
}

function daysBetween(from?: string | null, to?: string | null) {
  if (!from || !to) return null;
  const start = moment(from.slice(0, 10), 'YYYY-MM-DD');
  const end = moment(to.slice(0, 10), 'YYYY-MM-DD');
  if (!start.isValid() || !end.isValid()) return null;
  return end.diff(start, 'days');
}

class QuantDataFreshnessService {
  async getSnapshot(options: { trade_date?: string } = {}) {
    const today = moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
    const trade_date = options.trade_date || today;
    const [
      latestQuote,
      quoteCountToday,
      latestQuantSignal,
      quantSignalCount,
      latestArchivedSignal,
      archivedSignalCount,
      latestFusionAudit,
      fusionAuditCount,
      latestValidation,
      pendingValidationCount,
      completedValidationCount,
      latestOutcome,
      openOutcomeCount,
      closedOutcomeCount,
      factorCoverage,
    ] = await Promise.all([
      RealtimeQuote.findOne({ order: [['quote_time', 'DESC']] }).catch(() => null),
      RealtimeQuote.count({ where: { trade_date } }).catch(() => 0),
      QuantSignal.findOne({
        order: [
          ['trade_date', 'DESC'],
          ['created_at', 'DESC'],
        ],
      }).catch(() => null),
      QuantSignal.count({ where: { trade_date } }).catch(() => 0),
      AIInvestmentSignal.findOne({
        where: { source_type: 'quant_recommendation' },
        order: [
          ['signal_date', 'DESC'],
          ['updated_at', 'DESC'],
        ],
      }).catch(() => null),
      AIInvestmentSignal.count({
        where: { source_type: 'quant_recommendation', signal_date: trade_date },
      }).catch(() => 0),
      QuantFusionAudit.findOne({
        order: [
          ['signal_date', 'DESC'],
          ['updated_at', 'DESC'],
        ],
      }).catch(() => null),
      QuantFusionAudit.count({ where: { signal_date: trade_date } }).catch(() => 0),
      QuantStrategyParamValidation.findOne({
        order: [
          ['evaluation_date', 'DESC'],
          ['updated_at', 'DESC'],
        ],
      }).catch(() => null),
      QuantStrategyParamValidation.count({ where: { status: 'pending' } }).catch(() => 0),
      QuantStrategyParamValidation.count({ where: { status: 'completed' } }).catch(() => 0),
      RecommendationTradeOutcome.findOne({
        order: [
          ['updated_at', 'DESC'],
          ['id', 'DESC'],
        ],
      }).catch(() => null),
      RecommendationTradeOutcome.count({ where: { trade_status: 'open' } }).catch(() => 0),
      RecommendationTradeOutcome.count({ where: { trade_status: 'closed' } }).catch(() => 0),
      stockFactorService.getCoverage({ scope: 'market', limit: 180 }).catch(() => null as any),
    ]);

    const latestQuoteTime = safeDate(latestQuote?.quote_time);
    const quoteAgeMinutes = latestQuoteTime
      ? Math.max(0, moment().diff(moment(latestQuoteTime), 'minutes'))
      : null;
    const latestSignalDate = latestQuantSignal?.trade_date || null;
    const latestArchivedDate = latestArchivedSignal?.signal_date || null;
    const latestFusionDate = latestFusionAudit?.signal_date || null;
    const latestValidationDate = latestValidation?.evaluation_date || null;
    const quoteThresholdMinutes = toNumber(process.env.REALTIME_QUOTE_FRESHNESS_MINUTES, 30);
    const isMarketHours = this.isAshareMarketHours();
    const quoteFresh =
      quoteAgeMinutes !== null &&
      (quoteAgeMinutes <= quoteThresholdMinutes || (!isMarketHours && quoteCountToday > 0));
    const factorLatestDate = factorCoverage?.latest_factor_date || null;
    const factorLagDays = daysBetween(factorLatestDate, trade_date);
    const factorMinCoverage = Math.min(
      toNumber(factorCoverage?.coverage_rate?.valuation, 0),
      toNumber(factorCoverage?.coverage_rate?.money_flow, 0),
      toNumber(factorCoverage?.coverage_rate?.fundamental, 0)
    );

    const checks = {
      factor_snapshots: {
        status:
          factorCoverage && factorLatestDate && factorMinCoverage >= 70
            ? 'ok'
            : factorCoverage && factorMinCoverage >= 45
            ? 'warn'
            : 'risk',
        latest_factor_date: factorLatestDate,
        lag_days: factorLagDays,
        min_coverage_rate: factorMinCoverage,
        source_breakdown: factorCoverage?.source_breakdown || {},
        conclusion:
          factorCoverage && factorLatestDate
            ? factorMinCoverage >= 70
              ? `因子快照已落盘，最低覆盖率 ${factorMinCoverage.toFixed(
                  1
                )}%，最新因子日 ${factorLatestDate}。`
              : `因子快照覆盖偏低，最低覆盖率 ${factorMinCoverage.toFixed(
                  1
                )}%，建议优先补齐真实/派生因子。`
            : '因子快照暂无有效覆盖，量化分会偏依赖行情特征。',
      },
      realtime_quotes: {
        status: latestQuoteTime && quoteFresh ? 'ok' : latestQuoteTime ? 'warn' : 'risk',
        latest_quote_time: latestQuoteTime,
        quote_age_minutes: quoteAgeMinutes,
        today_count: quoteCountToday,
        source: latestQuote?.source || null,
        conclusion: latestQuoteTime
          ? quoteFresh
            ? `实时行情已落盘，今日 ${quoteCountToday} 条。`
            : `实时行情已落盘但可能过期 ${quoteAgeMinutes} 分钟。`
          : '实时行情暂无落盘记录。',
      },
      quant_signals: {
        status: latestSignalDate ? 'ok' : 'risk',
        latest_trade_date: latestSignalDate,
        today_count: quantSignalCount,
        lag_days: daysBetween(latestSignalDate, trade_date),
        conclusion: latestSignalDate
          ? `最新量化信号日 ${latestSignalDate}，本交易日 ${quantSignalCount} 条。`
          : '尚未生成量化信号。',
      },
      archived_quant_recommendations: {
        status: latestArchivedDate ? 'ok' : 'warn',
        latest_signal_date: latestArchivedDate,
        today_count: archivedSignalCount,
        lag_days: daysBetween(latestArchivedDate, trade_date),
        conclusion: latestArchivedDate
          ? `最新归档推荐日 ${latestArchivedDate}，本交易日 ${archivedSignalCount} 条。`
          : '量化推荐尚未归档到 AI 信号池。',
      },
      agent_fusion_audits: {
        status: latestFusionDate ? 'ok' : 'warn',
        latest_signal_date: latestFusionDate,
        today_count: fusionAuditCount,
        lag_days: daysBetween(latestFusionDate, trade_date),
        conclusion: latestFusionDate
          ? `最新 Agent 融合日 ${latestFusionDate}，本交易日 ${fusionAuditCount} 条。`
          : 'Agent 融合审计暂无记录；若刚触发扫描，需等待异步 Agent 完成。',
      },
      param_validations: {
        status: completedValidationCount > 0 || pendingValidationCount > 0 ? 'ok' : 'warn',
        latest_evaluation_date: latestValidationDate,
        pending_count: pendingValidationCount,
        completed_count: completedValidationCount,
        conclusion:
          completedValidationCount > 0 || pendingValidationCount > 0
            ? `参数 A/B 验证已沉淀：完成 ${completedValidationCount}，待评估 ${pendingValidationCount}。`
            : '参数 A/B 验证尚未产生样本。',
      },
      paper_trade_outcomes: {
        status: openOutcomeCount + closedOutcomeCount > 0 ? 'ok' : 'warn',
        latest_updated_at: safeDate(latestOutcome?.updated_at),
        open_count: openOutcomeCount,
        closed_count: closedOutcomeCount,
        conclusion:
          openOutcomeCount + closedOutcomeCount > 0
            ? `模拟盘收益闭环已有持仓/交易：持仓 ${openOutcomeCount}，已闭环 ${closedOutcomeCount}。`
            : '模拟盘收益闭环暂无交易样本。',
      },
    };
    const issueList = Object.entries(checks)
      .filter(([, value]: any) => value.status !== 'ok')
      .map(([key, value]: any) => ({ key, status: value.status, conclusion: value.conclusion }));
    const riskCount = issueList.filter(item => item.status === 'risk').length;
    const warnCount = issueList.filter(item => item.status === 'warn').length;

    return {
      generated_at: new Date().toISOString(),
      trade_date,
      status: riskCount > 0 ? 'risk' : warnCount > 0 ? 'warn' : 'ok',
      summary: {
        risk_count: riskCount,
        warn_count: warnCount,
        conclusion:
          riskCount > 0
            ? '量化数据闭环存在关键缺口，请优先修复行情/信号链路。'
            : warnCount > 0
            ? '量化数据闭环可运行但仍有观察项，建议关注 Agent 融合与模拟盘收益沉淀。'
            : '量化数据闭环关键表均有数据，开盘链路具备可观测性。',
      },
      checks,
      issues: issueList,
    };
  }

  private isAshareMarketHours() {
    const now = moment().tz('Asia/Shanghai');
    const day = now.isoWeekday();
    if (day > 5) return false;
    const minutes = now.hour() * 60 + now.minute();
    return (
      (minutes >= 9 * 60 + 25 && minutes <= 11 * 60 + 35) ||
      (minutes >= 13 * 60 && minutes <= 15 * 60 + 5)
    );
  }
}

export const quantDataFreshnessService = new QuantDataFreshnessService();
