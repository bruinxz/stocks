import moment from 'moment-timezone';
import { Op } from 'sequelize';
import { ScheduledTask } from '../models/ScheduledTask';
import { TaskExecutionLog } from '../models/TaskExecutionLog';
import { stockFactorService } from '../data/services/StockFactorService';
import { realtimeQuoteService } from '../data/services/RealtimeQuoteService';
import { quantStrategyParamVersionService } from '../quant/services/QuantStrategyParamVersionService';
import { quantDataFreshnessService } from '../quant/services/QuantDataFreshnessService';
import { quantFusionService } from '../quant/services/QuantFusionService';

function toNumber(value: any, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function checkStatus(ok: boolean, warn = false) {
  if (ok) return 'ok';
  return warn ? 'warn' : 'risk';
}

interface QuantOpeningPreflightOptions {
  user_id?: number;
  factor_limit?: number;
  use_cache?: boolean;
  cache_ttl_ms?: number;
  force_refresh?: boolean;
}

interface PreflightCacheEntry {
  expires_at: number;
  value: Record<string, any>;
}

class QuantOpeningPreflightService {
  private preflightCache = new Map<string, PreflightCacheEntry>();
  private inflightChecks = new Map<string, Promise<Record<string, any>>>();

  async check(options: QuantOpeningPreflightOptions = {}): Promise<Record<string, any>> {
    const tradeDate = moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
    const factorLimit = Math.min(Math.max(Number(options.factor_limit || 180), 20), 1000);
    const useCache = options.use_cache !== false;
    const cacheTtlMs = Math.min(Math.max(Number(options.cache_ttl_ms || 90_000), 15_000), 300_000);
    const cacheKey = `${tradeDate}:${options.user_id || 'anon'}:${factorLimit}`;
    const now = Date.now();

    if (useCache && !options.force_refresh) {
      const cached = this.preflightCache.get(cacheKey);
      if (cached && cached.expires_at > now) {
        return this.withCacheMetadata(cached.value, {
          hit: true,
          shared_inflight: false,
          key: cacheKey,
          ttl_ms_remaining: cached.expires_at - now,
          ttl_ms: cacheTtlMs,
        });
      }
      if (cached) {
        this.preflightCache.delete(cacheKey);
      }

      const inflight = this.inflightChecks.get(cacheKey);
      if (inflight) {
        const value = await inflight;
        const latest = this.preflightCache.get(cacheKey);
        return this.withCacheMetadata(value, {
          hit: false,
          shared_inflight: true,
          key: cacheKey,
          ttl_ms_remaining: latest ? Math.max(0, latest.expires_at - Date.now()) : cacheTtlMs,
          ttl_ms: cacheTtlMs,
        });
      }
    }

    const computePromise = this.computeCheck({
      trade_date: tradeDate,
      user_id: options.user_id,
      factor_limit: factorLimit,
    });

    if (useCache) {
      this.inflightChecks.set(cacheKey, computePromise);
    }

    try {
      const value = await computePromise;
      if (useCache) {
        this.preflightCache.set(cacheKey, {
          expires_at: Date.now() + cacheTtlMs,
          value,
        });
      }
      return this.withCacheMetadata(value, {
        hit: false,
        shared_inflight: false,
        key: cacheKey,
        ttl_ms_remaining: useCache ? cacheTtlMs : 0,
        ttl_ms: useCache ? cacheTtlMs : 0,
        force_refresh: Boolean(options.force_refresh),
      });
    } finally {
      if (useCache && this.inflightChecks.get(cacheKey) === computePromise) {
        this.inflightChecks.delete(cacheKey);
      }
    }
  }

  private withCacheMetadata(
    value: Record<string, any>,
    cache: {
      hit: boolean;
      shared_inflight: boolean;
      key: string;
      ttl_ms_remaining: number;
      ttl_ms: number;
      force_refresh?: boolean;
    }
  ): Record<string, any> {
    return {
      ...value,
      cached: cache.hit,
      cache: {
        hit: cache.hit,
        shared_inflight: cache.shared_inflight,
        key: cache.key,
        ttl_ms_remaining: Math.max(0, Math.round(cache.ttl_ms_remaining)),
        ttl_ms: cache.ttl_ms,
        force_refresh: Boolean(cache.force_refresh),
      },
    };
  }

  private async computeCheck(options: {
    trade_date: string;
    user_id?: number;
    factor_limit: number;
  }): Promise<Record<string, any>> {
    const tradeDate = options.trade_date;
    const [tasks, latestLogs, factorCoverage, quoteSummary, activeScanParams, dataFreshness] =
      await Promise.all([
        ScheduledTask.findAll({
          where: {
            type: {
              [Op.in]: ['QUANT_DAILY_PIPELINE', 'QUANT_OPEN_WATCHDOG', 'REALTIME_QUOTE_SYNC'],
            },
          },
          order: [['updated_at', 'DESC']],
        }).catch(() => [] as ScheduledTask[]),
        TaskExecutionLog.findAll({
          where: { task_name: { [Op.iLike]: '%量化%' } },
          order: [['created_at', 'DESC']],
          limit: 10,
        }).catch(() => [] as TaskExecutionLog[]),
        stockFactorService.getCoverage({
          scope: 'market',
          limit: options.factor_limit,
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
    const factorSmoke = await stockFactorService
      .runProviderSmokeTest({ provider: 'auto', symbol: 'sh.600000', as_of: tradeDate })
      .catch(error => ({
        ok: false,
        provider: 'tushare',
        enabled: false,
        error: error?.message || String(error),
        conclusion: `因子真实源烟测失败：${error?.message || error}`,
      }));

    const quantTask =
      tasks.find(
        task =>
          task.type === 'QUANT_DAILY_PIPELINE' &&
          task.is_active &&
          String(task.name || '').includes('开盘')
      ) || tasks.find(task => task.type === 'QUANT_DAILY_PIPELINE');
    const watchdogTask = tasks.find(task => task.type === 'QUANT_OPEN_WATCHDOG');
    const quoteSyncTask = tasks.find(task => task.type === 'REALTIME_QUOTE_SYNC' && task.is_active);
    const minFactorCoverage = Math.min(
      toNumber(factorCoverage.coverage_rate.valuation),
      toNumber(factorCoverage.coverage_rate.money_flow),
      toNumber(factorCoverage.coverage_rate.fundamental)
    );
    const feishuTableConfigured = Boolean(
      process.env.FEISHU_APP_TOKEN ||
        process.env.FEISHU_BITABLE_APP_TOKEN ||
        process.env.FEISHU_BASE_APP_TOKEN
    );
    const feishuBotConfigured = Boolean(process.env.FEISHU_RECOMMENDATION_BOT_WEBHOOK);
    const feishuBotDisabled = process.env.DISABLE_FEISHU_BOT_WEBHOOK === 'true';
    const adoptedCount = toNumber((activeScanParams as any)?.summary?.adopted_strategy_count);
    const dataFreshnessIssues = Array.isArray((dataFreshness as any).issues)
      ? (dataFreshness as any).issues
      : [];
    const dataFreshnessHardRisk = dataFreshnessIssues.some((item: any) =>
      ['realtime_quotes', 'quant_signals'].includes(String(item.key || ''))
    );

    const hardRiskKeys = new Set(['quant_task']);
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
        status: checkStatus(minFactorCoverage >= 70, minFactorCoverage >= 15),
        ok: minFactorCoverage >= 70,
        degraded: minFactorCoverage >= 15 && minFactorCoverage < 70,
        min_coverage_rate: minFactorCoverage,
        latest_trade_date: factorCoverage.latest_trade_date,
        latest_factor_date: (factorCoverage as any).latest_factor_date || null,
        coverage_rate: factorCoverage.coverage_rate,
        source_breakdown: factorCoverage.source_breakdown,
        conclusion:
          minFactorCoverage >= 70
            ? `因子覆盖可用，最低覆盖率 ${minFactorCoverage.toFixed(1)}%，因子日期 ${
                (factorCoverage as any).latest_factor_date || '-'
              }。`
            : minFactorCoverage >= 15
            ? `因子覆盖不足但有真实源样本，最低覆盖率 ${minFactorCoverage.toFixed(
                1
              )}%，开盘可降仓小样本验证。`
            : `因子覆盖偏低，最低覆盖率 ${minFactorCoverage.toFixed(1)}%，开盘前建议同步因子。`,
      },
      factor_provider: {
        status: checkStatus(Boolean((factorSmoke as any).ok), true),
        ok: Boolean((factorSmoke as any).ok),
        provider: (factorSmoke as any).provider,
        symbol: (factorSmoke as any).symbol,
        enabled: Boolean((factorSmoke as any).enabled),
        checks: (factorSmoke as any).checks || {},
        errors: (factorSmoke as any).errors || [],
        conclusion: (factorSmoke as any).conclusion || '真实因子源烟测未执行。',
      },
      realtime_quote: {
        status: checkStatus(
          Boolean((quoteSummary as any).persisted) &&
            (Boolean((quoteSummary as any).is_fresh) || Boolean(quoteSyncTask)),
          true
        ),
        ok:
          Boolean((quoteSummary as any).persisted) &&
          (Boolean((quoteSummary as any).is_fresh) || Boolean(quoteSyncTask)),
        ...quoteSummary,
        conclusion: (quoteSummary as any).persisted
          ? `实时行情已有落盘，最新时间 ${
              (quoteSummary as any).latest_quote_time || '-'
            }；盘中刷新任务 ${quoteSyncTask ? '已启用' : '未启用'}。`
          : '实时行情未落盘或读取失败，开盘扫描会尝试刷新。',
      },
      quote_sync_task: {
        status: checkStatus(Boolean(quoteSyncTask), true),
        ok: Boolean(quoteSyncTask),
        task_id: quoteSyncTask?.id,
        name: quoteSyncTask?.name,
        cron_expression: quoteSyncTask?.cron_expression,
        last_run_at: quoteSyncTask?.last_run_at,
        last_run_status: quoteSyncTask?.last_run_status,
        conclusion: quoteSyncTask
          ? `盘中实时行情快照刷新已启用：${quoteSyncTask.cron_expression}。`
          : '未启用独立实时行情快照刷新任务，盘中价格可能只依赖开盘扫描即时刷新。',
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
          (dataFreshness as any).status === 'risk' && dataFreshnessHardRisk
            ? 'risk'
            : (dataFreshness as any).status === 'warn'
            ? 'warn'
            : (dataFreshness as any).status === 'risk'
            ? 'warn'
            : 'ok',
        ok: (dataFreshness as any).status !== 'risk',
        degraded: (dataFreshness as any).status === 'risk' && !dataFreshnessHardRisk,
        summary: (dataFreshness as any).summary,
        checks: (dataFreshness as any).checks,
        issues: (dataFreshness as any).issues || [],
        conclusion:
          (dataFreshness as any).summary?.conclusion || '量化数据闭环新鲜度检查暂未生成。',
      },
      feishu: {
        status: checkStatus(
          feishuTableConfigured && feishuBotConfigured && !feishuBotDisabled,
          true
        ),
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
    const hardRiskCount = issueList.filter(
      item => item.status === 'risk' && hardRiskKeys.has(item.key)
    ).length;
    const riskCount = issueList.filter(item => item.status === 'risk').length;
    const warnCount = issueList.filter(item => item.status === 'warn').length;
    const status = hardRiskCount > 0 ? 'risk' : riskCount > 0 || warnCount > 0 ? 'warn' : 'ready';

    return {
      generated_at: new Date().toISOString(),
      trade_date: tradeDate,
      status,
      summary: {
        risk_count: riskCount,
        warn_count: warnCount,
        hard_risk_count: hardRiskCount,
        issue_count: issueList.length,
        conclusion:
          status === 'ready'
            ? '明日/今日开盘量化链路自检通过，可等待定时任务自动执行。'
            : status === 'warn'
            ? '开盘链路可运行但需要降仓/观察，建议继续补因子覆盖与闭环样本。'
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

  async runDryRun(
    options: {
      user_id?: number;
      username?: string;
      trade_date?: string;
      limit?: number;
      min_score?: number;
      factor_provider?: 'auto' | 'local_derived' | 'tushare' | 'eastmoney';
    } = {}
  ): Promise<Record<string, any>> {
    const tradeDate = options.trade_date || moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
    const startedAt = Date.now();
    const preflight = await this.check({
      user_id: options.user_id,
      factor_limit: 120,
      use_cache: true,
      cache_ttl_ms: 90_000,
    });
    const result = await quantFusionService.runDailyPipeline({
      user_id: options.user_id,
      username: options.username,
      trade_date: tradeDate,
      universe: 'market',
      candidate_limit: Math.min(Math.max(Number(options.limit || 80), 20), 180),
      archive_limit: Math.min(Math.max(Number(options.limit || 12), 5), 30),
      min_score: Number(options.min_score || 60),
      submit_agent_analysis: false,
      run_paper_trading: false,
      dry_run: true,
      report_to_feishu: false,
      notify_to_feishu_bot: false,
      refresh_realtime_quotes: true,
      quote_sync_limit: Math.min(Math.max(Number(options.limit || 80), 20), 180),
      realtime_quote_source: 'auto',
      sync_factors_before_scan: true,
      factor_sync_scope: 'market',
      factor_sync_limit: Math.min(Math.max(Number(options.limit || 80), 20), 220),
      factor_provider: options.factor_provider || 'auto',
      factor_sync_skip_if_coverage_rate_gte: 0,
      factor_sync_skip_if_real_provider_rate_gte: 0,
      block_buy_on_runtime_risk: true,
    });
    const runtimeBlocked = Boolean((result as any).runtime_risk_blocked);
    const candidateCount = Number((result as any).fusion?.candidate_count || 0);
    const selectedCount = Number((result as any).fusion?.selected_count || 0);
    const signalCount = Number((result as any).generated?.signal_count || 0);

    return {
      generated_at: new Date().toISOString(),
      trade_date: tradeDate,
      status: runtimeBlocked ? 'watch_only' : candidateCount > 0 ? 'ready' : 'warn',
      dry_run: true,
      duration_ms: Date.now() - startedAt,
      summary: {
        preflight_status: preflight.status,
        runtime_risk_blocked: runtimeBlocked,
        scanned_stocks: (result as any).generated?.scanned_stocks || 0,
        signal_count: signalCount,
        candidate_count: candidateCount,
        selected_count: selectedCount,
        archived_signal_count: (result as any).archive?.total || 0,
        conclusion: runtimeBlocked
          ? '开盘演练完成：可生成候选但运行时风险阻断买入，明日将只归档观察。'
          : candidateCount > 0
          ? `开盘演练完成：已生成 ${candidateCount} 个候选、精选 ${selectedCount} 个，未触发真实买入/飞书发送。`
          : '开盘演练完成：未形成有效候选，请关注因子覆盖、行情与策略阈值。',
      },
      preflight,
      result,
    };
  }
}

export const quantOpeningPreflightService = new QuantOpeningPreflightService();
