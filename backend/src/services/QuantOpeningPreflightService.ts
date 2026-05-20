import moment from 'moment-timezone';
import { Op } from 'sequelize';
import { ScheduledTask } from '../models/ScheduledTask';
import { TaskExecutionLog } from '../models/TaskExecutionLog';
import { stockFactorService } from '../data/services/StockFactorService';
import { realtimeQuoteService } from '../data/services/RealtimeQuoteService';
import { quantStrategyParamVersionService } from '../quant/services/QuantStrategyParamVersionService';
import { quantDataFreshnessService } from '../quant/services/QuantDataFreshnessService';

function toNumber(value: any, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function checkStatus(ok: boolean, warn = false) {
  if (ok) return 'ok';
  return warn ? 'warn' : 'risk';
}

class QuantOpeningPreflightService {
  async check(options: { user_id?: number; factor_limit?: number } = {}) {
    const tradeDate = moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
    const [tasks, latestLogs, factorCoverage, quoteSummary, activeScanParams, dataFreshness] =
      await Promise.all([
        ScheduledTask.findAll({
          where: { type: { [Op.in]: ['QUANT_DAILY_PIPELINE', 'QUANT_OPEN_WATCHDOG'] } },
          order: [['updated_at', 'DESC']],
        }).catch(() => [] as ScheduledTask[]),
        TaskExecutionLog.findAll({
          where: { task_name: { [Op.iLike]: '%量化%' } },
          order: [['created_at', 'DESC']],
          limit: 10,
        }).catch(() => [] as TaskExecutionLog[]),
        stockFactorService.getCoverage({
          scope: 'market',
          limit: Math.min(Math.max(Number(options.factor_limit || 180), 20), 1000),
          user_id: options.user_id,
        }),
        realtimeQuoteService.getPersistenceSummary().catch(error => ({
          persisted: false,
          error: error?.message || String(error),
        })),
        quantStrategyParamVersionService.getActiveParamsForScan().catch(error => ({
          summary: {
            adopted_strategy_count: 0,
            conclusion: `参数版本读取失败：${error?.message || error}`,
          },
          selections: [],
        })),
        quantDataFreshnessService.getSnapshot({ trade_date: tradeDate }).catch(error => ({
          status: 'warn',
          summary: {
            warn_count: 1,
            conclusion: `量化数据闭环新鲜度读取失败：${error?.message || error}`,
          },
          checks: {},
          issues: [],
        })),
      ]);

    const quantTask = tasks.find(task => task.type === 'QUANT_DAILY_PIPELINE');
    const watchdogTask = tasks.find(task => task.type === 'QUANT_OPEN_WATCHDOG');
    const minFactorCoverage = Math.min(
      toNumber(factorCoverage.coverage_rate.valuation),
      toNumber(factorCoverage.coverage_rate.money_flow),
      toNumber(factorCoverage.coverage_rate.fundamental)
    );
    const feishuTableConfigured = Boolean(
      process.env.FEISHU_APP_TOKEN || process.env.FEISHU_BITABLE_APP_TOKEN || process.env.FEISHU_BASE_APP_TOKEN
    );
    const feishuBotConfigured = Boolean(process.env.FEISHU_RECOMMENDATION_BOT_WEBHOOK);
    const feishuBotDisabled = process.env.DISABLE_FEISHU_BOT_WEBHOOK === 'true';
    const adoptedCount = toNumber((activeScanParams as any)?.summary?.adopted_strategy_count);

    const checks = {
      quant_task: {
        status: checkStatus(Boolean(quantTask?.is_active)),
        ok: Boolean(quantTask?.is_active),
        task_id: quantTask?.id,
        name: quantTask?.name,
        cron_expression: quantTask?.cron_expression,
        last_run_at: quantTask?.last_run_at,
        last_run_status: quantTask?.last_run_status,
        conclusion: quantTask?.is_active
          ? '量化日扫任务已启用。'
          : '未找到启用的 QUANT_DAILY_PIPELINE 定时任务。',
      },
      watchdog_task: {
        status: checkStatus(Boolean(watchdogTask?.is_active), true),
        ok: Boolean(watchdogTask?.is_active),
        task_id: watchdogTask?.id,
        name: watchdogTask?.name,
        cron_expression: watchdogTask?.cron_expression,
        conclusion: watchdogTask?.is_active
          ? '开盘看门狗已启用。'
          : '未启用开盘看门狗，建议开启以监控日扫是否准时完成。',
      },
      factor_coverage: {
        status: checkStatus(minFactorCoverage >= 70, minFactorCoverage >= 45),
        ok: minFactorCoverage >= 70,
        min_coverage_rate: minFactorCoverage,
        latest_trade_date: factorCoverage.latest_trade_date,
        latest_factor_date: (factorCoverage as any).latest_factor_date || null,
        coverage_rate: factorCoverage.coverage_rate,
        source_breakdown: factorCoverage.source_breakdown,
        conclusion:
          minFactorCoverage >= 70
            ? `因子覆盖可用，最低覆盖率 ${minFactorCoverage.toFixed(1)}%，因子日期 ${(factorCoverage as any).latest_factor_date || '-'}。`
            : `因子覆盖偏低，最低覆盖率 ${minFactorCoverage.toFixed(1)}%，开盘前建议同步因子。`,
      },
      realtime_quote: {
        status: checkStatus(Boolean((quoteSummary as any).persisted), true),
        ok: Boolean((quoteSummary as any).persisted),
        ...quoteSummary,
        conclusion: (quoteSummary as any).persisted
          ? `实时行情已有落盘，最新时间 ${(quoteSummary as any).latest_quote_time || '-' }。`
          : '实时行情未落盘或读取失败，开盘扫描会尝试刷新。',
      },
      active_scan_params: {
        status: checkStatus(adoptedCount > 0, true),
        ok: adoptedCount > 0,
        summary: (activeScanParams as any).summary,
        selections: ((activeScanParams as any).selections || []).slice(0, 12),
        conclusion: (activeScanParams as any).summary?.conclusion || '暂无参数版本选择结果。',
      },
      data_freshness: {
        status:
          (dataFreshness as any).status === 'risk'
            ? 'risk'
            : (dataFreshness as any).status === 'warn'
            ? 'warn'
            : 'ok',
        ok: (dataFreshness as any).status !== 'risk',
        summary: (dataFreshness as any).summary,
        checks: (dataFreshness as any).checks,
        issues: (dataFreshness as any).issues || [],
        conclusion:
          (dataFreshness as any).summary?.conclusion || '量化数据闭环新鲜度检查暂未生成。',
      },
      feishu: {
        status: checkStatus(feishuTableConfigured && feishuBotConfigured && !feishuBotDisabled, true),
        ok: feishuTableConfigured && feishuBotConfigured && !feishuBotDisabled,
        table_configured: feishuTableConfigured,
        bot_configured: feishuBotConfigured,
        bot_disabled: feishuBotDisabled,
        conclusion:
          feishuTableConfigured && feishuBotConfigured && !feishuBotDisabled
            ? '飞书多维表格和机器人摘要配置可用。'
            : '飞书配置不完整或机器人被禁用，请检查环境变量。',
      },
    };

    const issueList = Object.entries(checks)
      .filter(([, value]: any) => value.status !== 'ok')
      .map(([key, value]: any) => ({ key, status: value.status, conclusion: value.conclusion }));
    const riskCount = issueList.filter(item => item.status === 'risk').length;
    const warnCount = issueList.filter(item => item.status === 'warn').length;
    const status = riskCount > 0 ? 'risk' : warnCount > 0 ? 'warn' : 'ready';

    return {
      generated_at: new Date().toISOString(),
      trade_date: tradeDate,
      status,
      summary: {
        risk_count: riskCount,
        warn_count: warnCount,
        issue_count: issueList.length,
        conclusion:
          status === 'ready'
            ? '明日/今日开盘量化链路自检通过，可等待定时任务自动执行。'
            : status === 'warn'
            ? '开盘链路有轻微告警，但可继续运行；建议关注告警项。'
            : '开盘链路存在风险项，建议先修复再等待自动推荐。',
      },
      checks,
      issues: issueList,
      recent_logs: latestLogs.map(log => ({
        id: log.id,
        task_id: log.task_id,
        task_name: log.task_name,
        status: log.status,
        total_items: log.total_items,
        completed_items: log.completed_items,
        failed_items: log.failed_items,
        error_message: log.error_message,
        started_at: log.started_at,
        completed_at: log.completed_at,
        created_at: log.created_at,
      })),
    };
  }
}

export const quantOpeningPreflightService = new QuantOpeningPreflightService();
