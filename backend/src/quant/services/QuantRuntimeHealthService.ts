import { Op } from 'sequelize';
import { ScheduledTask } from '../../models/ScheduledTask';
import { runtimeSchemaHealthService } from '../../services/RuntimeSchemaHealthService';
import { realtimeQuoteService } from '../../data/services/RealtimeQuoteService';
import { quantStrategyService } from './QuantStrategyService';
import { quantDataFreshnessService } from './QuantDataFreshnessService';
import { quantStrategyParamVersionService } from './QuantStrategyParamVersionService';
import { stockFactorService } from '../../data/services/StockFactorService';

function toNumber(value: any, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function mapStatusToCheck(status: string | undefined): 'ok' | 'warn' | 'risk' {
  const normalized = String(status || '').toLowerCase();
  if (['healthy', 'ok', 'ready', 'fresh'].includes(normalized)) return 'ok';
  if (['critical', 'risk', 'unhealthy', 'missing'].includes(normalized)) return 'risk';
  return 'warn';
}

function round(value: number, precision = 1): number {
  const factor = 10 ** precision;
  return Math.round((Number(value) || 0) * factor) / factor;
}

class QuantRuntimeHealthService {
  async getHealth(options: { user_id?: number } = {}) {
    const [
      schemaHealth,
      strategies,
      quoteSummary,
      dataFreshness,
      activeScanParams,
      factorCoverage,
      tasks,
    ] = await Promise.all([
        runtimeSchemaHealthService.getHealth().catch(error => ({
          status: 'critical',
          summary: { critical_issues: 1, warnings: 0, missing_columns: 0 },
          issues: [
            {
              level: 'critical',
              code: 'runtime_schema_health_failed',
              message: `数据库运行时健康检查失败：${error?.message || error}`,
            },
          ],
        })),
        quantStrategyService.listStrategies().catch(error => {
          throw new Error(`量化策略注册读取失败：${error?.message || error}`);
        }),
        realtimeQuoteService.getPersistenceSummary().catch(error => ({
          persisted: false,
          freshness_status: 'missing',
          error: error?.message || String(error),
        })),
        quantDataFreshnessService.getSnapshot().catch(error => ({
          status: 'risk',
          summary: {
            risk_count: 1,
            warn_count: 0,
            conclusion: `量化数据新鲜度读取失败：${error?.message || error}`,
          },
          checks: {},
          issues: [],
        })),
        quantStrategyParamVersionService.getActiveParamsForScan().catch(error => ({
          summary: {
            adopted_strategy_count: 0,
            conclusion: `开盘参数版本读取失败：${error?.message || error}`,
          },
          selections: [],
        })),
        stockFactorService
          .getCoverage({
            scope: 'market',
            limit: toNumber(process.env.RUNTIME_HEALTH_FACTOR_SAMPLE_LIMIT, 180),
            user_id: options.user_id,
          })
          .catch(error => ({
            error: error?.message || String(error),
            coverage_rate: { valuation: 0, money_flow: 0, fundamental: 0 },
            source_quality: { real_provider_rate: 0 },
            next_actions: ['因子覆盖读取失败，请检查因子表与日线数据。'],
          })),
        ScheduledTask.findAll({
          where: { type: { [Op.in]: ['QUANT_DAILY_PIPELINE', 'QUANT_OPEN_WATCHDOG'] } },
          order: [['cron_expression', 'ASC']],
        }).catch(() => [] as ScheduledTask[]),
      ]);

    const enabledStrategies = strategies.filter((item: any) => item.enabled !== false);
    const policyReadyCount = enabledStrategies.filter((item: any) => {
      const executionPolicy = item.execution_policy || {};
      const lifecyclePolicy = item.lifecycle_policy || {};
      return (
        Number.isFinite(Number(executionPolicy.min_score)) &&
        Number.isFinite(Number(executionPolicy.max_position_pct)) &&
        lifecyclePolicy.auto_promote !== undefined &&
        lifecyclePolicy.auto_rollback !== undefined
      );
    }).length;
    const runtimeIssues = Array.isArray((schemaHealth as any).issues)
      ? (schemaHealth as any).issues
      : [];
    const missingRuntimeColumns = runtimeIssues.filter((issue: any) =>
      String(issue.code || '').includes('column_missing')
    );
    const openTasks = tasks.filter(
      task =>
        task.type === 'QUANT_DAILY_PIPELINE' &&
        task.is_active &&
        String(task.name || '').includes('开盘')
    );
    const closeTasks = tasks.filter(
      task =>
        task.type === 'QUANT_DAILY_PIPELINE' &&
        task.is_active &&
        String(task.name || '').includes('全市场')
    );
    const watchdogTasks = tasks.filter(
      task => task.type === 'QUANT_OPEN_WATCHDOG' && task.is_active
    );
    const adoptedCount = toNumber((activeScanParams as any)?.summary?.adopted_strategy_count);
    const factorCoverageRates = (factorCoverage as any)?.coverage_rate || {};
    const factorMinCoverage = Math.min(
      toNumber(factorCoverageRates.valuation),
      toNumber(factorCoverageRates.money_flow),
      toNumber(factorCoverageRates.fundamental)
    );
    const factorRealProviderRate = toNumber((factorCoverage as any)?.source_quality?.real_provider_rate);
    const factorCoverageStatus = String((factorCoverage as any)?.coverage_status || '');
    const factorStatus =
      (factorCoverage as any)?.error || factorMinCoverage < 45
        ? 'risk'
        : factorMinCoverage < 70 || factorCoverageStatus === 'limited'
        ? 'warn'
        : 'ok';
    const checks = [
      {
        key: 'schema_columns',
        label: '数据库字段',
        status:
          (schemaHealth as any).status === 'critical'
            ? 'risk'
            : missingRuntimeColumns.length > 0
            ? 'risk'
            : (schemaHealth as any).status === 'warning'
            ? 'warn'
            : 'ok',
        metric: `${(schemaHealth as any)?.summary?.existing_columns ?? 0}/${
          (schemaHealth as any)?.summary?.required_columns ?? 0
        }`,
        conclusion: missingRuntimeColumns.length
          ? `缺少 ${missingRuntimeColumns.length} 个关键字段，会影响量化策略/推荐链路。`
          : `关键运行字段齐全；表健康状态 ${(schemaHealth as any).status || 'unknown'}。`,
      },
      {
        key: 'strategy_registry',
        label: '策略注册',
        status:
          enabledStrategies.length > 0 && policyReadyCount === enabledStrategies.length
            ? 'ok'
            : enabledStrategies.length > 0
            ? 'warn'
            : 'risk',
        metric: `${policyReadyCount}/${enabledStrategies.length}`,
        conclusion:
          enabledStrategies.length > 0
            ? `已启用 ${enabledStrategies.length} 个策略，${policyReadyCount} 个具备执行/生命周期策略。`
            : '没有启用的量化策略，开盘不会产生有效候选。',
      },
      {
        key: 'quote_persistence',
        label: '实时行情',
        status: (quoteSummary as any).persisted
          ? (quoteSummary as any).is_fresh
            ? 'ok'
            : 'warn'
          : 'risk',
        metric: String((quoteSummary as any).latest_trade_date_symbol_count || 0),
        conclusion: (quoteSummary as any).persisted
          ? `最新行情 ${(quoteSummary as any).latest_quote_time || '-'}，覆盖 ${
              (quoteSummary as any).latest_trade_date_symbol_count || 0
            } 只股票，状态 ${(quoteSummary as any).freshness_status || 'unknown'}。`
          : '实时行情尚未落盘，开盘扫描会降级或无法给出可信价格。',
      },
      {
        key: 'factor_coverage',
        label: '真实因子',
        status: factorStatus,
        metric: `${round(factorMinCoverage)}%`,
        conclusion: (factorCoverage as any)?.error
          ? `因子覆盖读取失败：${(factorCoverage as any).error}`
          : factorRealProviderRate >= 10
          ? `因子最低覆盖 ${round(factorMinCoverage)}%，真实源占比 ${round(
              factorRealProviderRate
            )}%，可支撑多因子评分。`
          : factorCoverageStatus === 'derived_ready'
          ? `因子最低覆盖 ${round(
              factorMinCoverage
            )}%，当前以本地派生为主；可运行，但优先落地东方财富/Tushare 真实快照。`
          : `因子最低覆盖 ${round(factorMinCoverage)}%，真实源占比 ${round(
              factorRealProviderRate
            )}%，建议先补充因子后再加大买入。`,
      },
      {
        key: 'data_freshness',
        label: '闭环新鲜度',
        status: mapStatusToCheck((dataFreshness as any).status),
        metric: `风险 ${(dataFreshness as any)?.summary?.risk_count || 0}`,
        conclusion:
          (dataFreshness as any)?.summary?.conclusion || '量化信号/归档/模拟收益新鲜度待检查。',
      },
      {
        key: 'active_params',
        label: '自动参数',
        status: adoptedCount > 0 ? 'ok' : 'warn',
        metric: String(adoptedCount),
        conclusion:
          (activeScanParams as any)?.summary?.conclusion ||
          (adoptedCount > 0
            ? `开盘扫描将采用 ${adoptedCount} 组已验证参数。`
            : '暂无晋级参数，开盘扫描会使用策略默认参数。'),
      },
      {
        key: 'schedule',
        label: '自动任务',
        status:
          openTasks.length > 0 && watchdogTasks.length > 0
            ? 'ok'
            : openTasks.length > 0 || watchdogTasks.length > 0
            ? 'warn'
            : 'risk',
        metric: `${openTasks.length}/${watchdogTasks.length}`,
        conclusion:
          openTasks.length > 0 && watchdogTasks.length > 0
            ? `开盘扫描与看门狗已启用；收盘复扫 ${closeTasks.length} 个。`
            : '开盘扫描或看门狗未完整启用，自动推荐闭环不够稳。',
      },
    ];

    const riskCount = checks.filter(item => item.status === 'risk').length;
    const warnCount = checks.filter(item => item.status === 'warn').length;
    const status = riskCount > 0 ? 'risk' : warnCount > 0 ? 'warn' : 'ready';
    const score = Math.round(
      ((checks.length - riskCount - warnCount * 0.45) / checks.length) * 100
    );

    return {
      generated_at: new Date().toISOString(),
      status,
      score: Math.max(0, Math.min(100, score)),
      summary: {
        risk_count: riskCount,
        warn_count: warnCount,
        check_count: checks.length,
        enabled_strategy_count: enabledStrategies.length,
        policy_ready_strategy_count: policyReadyCount,
        open_task_count: openTasks.length,
        watchdog_task_count: watchdogTasks.length,
        factor_min_coverage_rate: round(factorMinCoverage),
        factor_real_provider_rate: round(factorRealProviderRate),
        conclusion:
          status === 'ready'
            ? '量化运行时健康：字段、策略、行情、参数和开盘任务均已就绪。'
            : status === 'warn'
            ? '量化运行时可运行但有观察项，开盘前建议关注行情新鲜度/参数样本。'
            : '量化运行时存在风险项，可能影响明日开盘自动荐股。',
      },
      checks,
      runtime_schema: {
        status: (schemaHealth as any).status,
        summary: (schemaHealth as any).summary,
        critical_issues: runtimeIssues
          .filter((issue: any) => issue.level === 'critical')
          .slice(0, 8),
      },
      quote_persistence: quoteSummary,
      factor_coverage: factorCoverage,
      data_freshness: dataFreshness,
      active_scan_params: {
        summary: (activeScanParams as any).summary,
        selections: ((activeScanParams as any).selections || []).slice(0, 8),
      },
      tasks: tasks.map(task => ({
        id: task.id,
        name: task.name,
        type: task.type,
        cron_expression: task.cron_expression,
        is_active: task.is_active,
        last_run_at: task.last_run_at,
        last_run_status: task.last_run_status,
      })),
    };
  }
}

export const quantRuntimeHealthService = new QuantRuntimeHealthService();
