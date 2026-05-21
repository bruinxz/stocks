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

type RuntimeCheckStatus = 'ok' | 'warn' | 'risk';

type RuntimeHealthCheck = {
  key: string;
  label: string;
  status: RuntimeCheckStatus;
  metric?: string;
  conclusion?: string;
  severity?: 'blocking' | 'degraded' | 'watch';
  buy_gate_action?: 'allow' | 'reduce' | 'observe' | 'pause';
  position_multiplier?: number;
};

function buildRuntimeNextActions(options: {
  status: string;
  buy_gate_action: string;
  buy_gate_multiplier: number;
  blocking_checks: RuntimeHealthCheck[];
  degraded_checks: RuntimeHealthCheck[];
  warn_count: number;
  quote_summary: any;
  factor_min_coverage: number;
  factor_real_provider_rate: number;
  adopted_count: number;
  execution_discipline_status: string;
}) {
  const actions: Array<{
    key: string;
    level: 'ok' | 'watch' | 'warn' | 'risk';
    title: string;
    description: string;
    action_label: string;
  }> = [];

  if (options.blocking_checks.length > 0 || options.status === 'risk') {
    actions.push({
      key: 'pause_and_fix_blockers',
      level: 'risk',
      title: '暂停新增买入',
      description: `先修复 ${
        options.blocking_checks.map(item => item.label).join('、') || '硬阻断'
      }，未恢复前只看信号不跟单。`,
      action_label: '修复阻断',
    });
  } else if (options.buy_gate_action === 'reduce') {
    actions.push({
      key: 'small_position_validate',
      level: 'warn',
      title: '小仓验证',
      description: `允许自动运行，但按 ${round(
        options.buy_gate_multiplier,
        2
      )}x 仓位执行，优先看模拟盘真实收益。`,
      action_label: '降仓运行',
    });
  } else {
    actions.push({
      key: 'wait_for_open_scan',
      level: 'ok',
      title: '等待开盘扫描',
      description: '字段、任务、行情与执行纪律已就绪，明日开盘可按自动推荐闭环运行。',
      action_label: '正常运行',
    });
  }

  if (
    (options.quote_summary?.persisted && !options.quote_summary?.is_fresh) ||
    !options.quote_summary?.persisted
  ) {
    actions.push({
      key: 'refresh_quote_snapshot',
      level: options.quote_summary?.persisted ? 'watch' : 'risk',
      title: '刷新实时行情',
      description: '行情不新时先等盘中快照任务或手动触发行情刷新，避免用旧价格做买入决策。',
      action_label: '补价格',
    });
  }

  if (options.factor_min_coverage < 90 || options.factor_real_provider_rate < 70) {
    actions.push({
      key: 'refresh_real_factors',
      level: options.factor_min_coverage < 60 ? 'warn' : 'watch',
      title: '补真实因子',
      description: `当前因子覆盖 ${round(options.factor_min_coverage)}%，真实源 ${round(
        options.factor_real_provider_rate
      )}%；保持 360 样本刷新后再扩大仓位。`,
      action_label: '补因子',
    });
  }

  if (options.adopted_count <= 0) {
    actions.push({
      key: 'promote_params',
      level: 'watch',
      title: '沉淀参数版本',
      description: '暂无已采用参数版本时，继续跑历史/模拟样本，让默认参数先进入 A/B 验证再晋级。',
      action_label: '跑样本',
    });
  }

  if (options.execution_discipline_status !== 'ok') {
    actions.push({
      key: 'fix_execution_discipline',
      level: 'warn',
      title: '补执行纪律',
      description: '检查飞书通知、模拟盘、风险阻断、Agent 复核是否全部开启，避免推荐无法闭环。',
      action_label: '补纪律',
    });
  }

  if (options.warn_count > 0 && actions.length < 4) {
    actions.push({
      key: 'observe_warnings',
      level: 'watch',
      title: '观察非致命项',
      description: `当前还有 ${options.warn_count} 个观察项；不阻断买入，但建议继续看收益闭环是否改善。`,
      action_label: '继续观察',
    });
  }

  const seen = new Set<string>();
  return actions
    .filter(item => {
      if (seen.has(item.key)) return false;
      seen.add(item.key);
      return true;
    })
    .slice(0, 4);
}

function classifyRuntimeCheck(check: RuntimeHealthCheck): RuntimeHealthCheck {
  if (check.status === 'ok') {
    return {
      ...check,
      severity: 'watch',
      buy_gate_action: 'allow',
      position_multiplier: 1,
    };
  }

  const key = String(check.key || '');
  const blockingKeys = new Set([
    'schema_columns',
    'strategy_registry',
    'quote_persistence',
    'schedule',
    'execution_discipline',
    'param_maintenance',
  ]);
  const degradedKeys = new Set(['factor_coverage', 'data_freshness', 'active_params']);
  if (check.status === 'risk' && blockingKeys.has(key)) {
    return {
      ...check,
      severity: 'blocking',
      buy_gate_action: 'pause',
      position_multiplier: 0,
    };
  }
  if (check.status === 'risk' && degradedKeys.has(key)) {
    return {
      ...check,
      severity: 'degraded',
      buy_gate_action: key === 'factor_coverage' ? 'reduce' : 'observe',
      position_multiplier: key === 'factor_coverage' ? 0.45 : 0.65,
    };
  }
  if (check.status === 'warn') {
    return {
      ...check,
      severity: degradedKeys.has(key) ? 'degraded' : 'watch',
      buy_gate_action: degradedKeys.has(key) ? 'observe' : 'allow',
      position_multiplier: degradedKeys.has(key) ? 0.75 : 1,
    };
  }
  return {
    ...check,
    severity: 'watch',
    buy_gate_action: 'allow',
    position_multiplier: 1,
  };
}

function boolParam(value: any, fallback = false): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n'].includes(normalized)) return false;
  return Boolean(value);
}

function buildExecutionDiscipline(tasks: ScheduledTask[]) {
  const issues: Array<{
    level: 'risk' | 'warn';
    code: string;
    task_name?: string;
    message: string;
  }> = [];
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
  const pipelineTasks = [...openTasks, ...closeTasks];
  const quoteSyncTasks = tasks.filter(
    task => task.type === 'REALTIME_QUOTE_SYNC' && task.is_active
  );
  const paramMaintenanceTasks = tasks.filter(
    task => task.type === 'QUANT_PARAM_MAINTENANCE' && task.is_active
  );
  const watchdogTasks = tasks.filter(task => task.type === 'QUANT_OPEN_WATCHDOG' && task.is_active);

  const addIssue = (
    level: 'risk' | 'warn',
    code: string,
    message: string,
    task?: ScheduledTask
  ) => {
    issues.push({ level, code, task_name: task?.name, message });
  };

  if (quoteSyncTasks.length === 0) {
    addIssue(
      'warn',
      'quote_sync_task_missing',
      '未启用盘中实时行情快照刷新任务，午间/盘中行情可能滞后。'
    );
  }

  if (paramMaintenanceTasks.length === 0) {
    addIssue(
      'warn',
      'param_maintenance_task_missing',
      '未启用量化参数后验维护任务，A/B 收益刷新和参数晋级可能只依赖扫描顺带执行。'
    );
  }

  for (const task of paramMaintenanceTasks) {
    const params = (task.parameters || {}) as Record<string, any>;
    if (toNumber(params.refresh_limit, 0) < 1000) {
      addIssue('warn', 'param_refresh_limit_low', `${task.name} 收益刷新上限低于 1000，可能无法覆盖待验证样本。`, task);
    }
    if (!Array.isArray(params.horizons) || params.horizons.length < 3) {
      addIssue('warn', 'param_horizons_incomplete', `${task.name} 未覆盖 1/3/5/10 日等多窗口验证。`, task);
    }
    if (boolParam(params.dry_run_lifecycle, false)) {
      addIssue('warn', 'param_lifecycle_dry_run', `${task.name} 生命周期处于 dry-run，不会真正推广/降级/回滚参数。`, task);
    }
  }

  for (const task of pipelineTasks) {
    const params = (task.parameters || {}) as Record<string, any>;
    const taskName = task.name || '量化任务';
    if (!boolParam(params.refresh_realtime_quotes, true)) {
      addIssue('risk', 'quote_refresh_disabled', `${taskName} 未开启实时行情刷新。`, task);
    }
    if (!boolParam(params.sync_factors_before_scan, true)) {
      addIssue('risk', 'factor_sync_disabled', `${taskName} 未开启扫描前因子同步。`, task);
    }
    if (String(params.factor_provider || 'auto') === 'local_derived') {
      addIssue(
        'risk',
        'real_factor_disabled',
        `${taskName} 仅使用本地派生因子，真实源未启用。`,
        task
      );
    }
    if (!boolParam(params.block_buy_on_runtime_risk, true)) {
      addIssue('risk', 'runtime_buy_gate_disabled', `${taskName} 未开启运行时风险阻断买入。`, task);
    }
    if (!boolParam(params.use_entry_risk_guard, true)) {
      addIssue('warn', 'entry_risk_guard_disabled', `${taskName} 未开启入场风控。`, task);
    }
    if (!boolParam(params.run_paper_trading, true)) {
      addIssue('warn', 'paper_trading_disabled', `${taskName} 未开启模拟盘跟单。`, task);
    }
    if (!boolParam(params.submit_agent_analysis, true)) {
      addIssue('warn', 'agent_fusion_disabled', `${taskName} 未开启 Agent 融合分析。`, task);
    }
    if (
      !boolParam(params.report_to_feishu, true) ||
      !boolParam(params.notify_to_feishu_bot, true)
    ) {
      addIssue(
        'warn',
        'feishu_notification_incomplete',
        `${taskName} 飞书报告或机器人通知未完整开启。`,
        task
      );
    }
    if (
      toNumber(params.factor_sync_limit, 0) < Math.min(toNumber(params.candidate_limit, 220), 180)
    ) {
      addIssue('warn', 'factor_sync_limit_low', `${taskName} 因子同步范围小于候选池主样本。`, task);
    }
    if (toNumber(params.factor_sync_limit, 0) < 300) {
      addIssue(
        'warn',
        'factor_sync_limit_below_baseline',
        `${taskName} 因子同步样本低于 300，建议保持 360 以上以覆盖真实源主样本。`,
        task
      );
    }
    if (toNumber(params.quote_sync_limit, 0) < 300) {
      addIssue(
        'warn',
        'quote_sync_limit_below_baseline',
        `${taskName} 实时行情刷新样本低于 300，可能导致候选价格不够新。`,
        task
      );
    }
    if (String(params.realtime_quote_source || 'auto').toLowerCase() !== 'auto') {
      addIssue(
        'warn',
        'quote_source_not_auto',
        `${taskName} 实时行情源未使用 auto，可能缺少 AKShare/腾讯双源兜底。`,
        task
      );
    }
    if (toNumber(params.factor_sync_skip_if_real_provider_rate_gte, 0) < 10) {
      addIssue(
        'warn',
        'real_factor_skip_gate_low',
        `${taskName} 真实源跳过阈值过低，可能过早跳过真实因子刷新。`,
        task
      );
    }
    if (
      toNumber(params.max_daily_new_positions, 0) <= 0 ||
      toNumber(params.paper_trade_limit, 0) <= 0
    ) {
      addIssue(
        'warn',
        'paper_trade_capacity_zero',
        `${taskName} 每日新开仓或模拟交易上限为 0。`,
        task
      );
    }
    if (
      toNumber(params.max_daily_new_exposure_pct, 0) > 20 ||
      toNumber(params.max_total_exposure_pct, 0) > 80
    ) {
      addIssue(
        'warn',
        'exposure_limit_loose',
        `${taskName} 暴露上限偏松，建议保持小仓验证。`,
        task
      );
    }
    if (toNumber(params.min_cash_reserve_pct, 0) < 5) {
      addIssue('warn', 'cash_reserve_low', `${taskName} 现金保留比例偏低。`, task);
    }
  }

  for (const task of watchdogTasks) {
    const params = (task.parameters || {}) as Record<string, any>;
    if (!boolParam(params.require_fresh_quote, true)) {
      addIssue(
        'warn',
        'watchdog_fresh_quote_disabled',
        `${task.name} 未要求检查行情新鲜度。`,
        task
      );
    }
    if (toNumber(params.min_quant_signals, 0) < 1 || toNumber(params.min_archived_signals, 0) < 1) {
      addIssue('warn', 'watchdog_min_signal_low', `${task.name} 信号/归档最低检查阈值过低。`, task);
    }
    if (
      !boolParam(params.report_to_feishu, true) ||
      !boolParam(params.notify_to_feishu_bot, true)
    ) {
      addIssue(
        'warn',
        'watchdog_feishu_disabled',
        `${task.name} 飞书报告或机器人通知未完整开启。`,
        task
      );
    }
  }

  const riskCount = issues.filter(item => item.level === 'risk').length;
  const warnCount = issues.filter(item => item.level === 'warn').length;
  return {
    status: riskCount > 0 ? 'risk' : warnCount > 0 ? 'warn' : 'ok',
    summary: {
      risk_count: riskCount,
      warn_count: warnCount,
      pipeline_task_count: pipelineTasks.length,
      open_task_count: openTasks.length,
      close_task_count: closeTasks.length,
      quote_sync_task_count: quoteSyncTasks.length,
      param_maintenance_task_count: paramMaintenanceTasks.length,
      watchdog_task_count: watchdogTasks.length,
      conclusion:
        riskCount > 0
          ? `执行纪律存在 ${riskCount} 个关键缺口，自动买入应暂停。`
          : warnCount > 0
          ? `执行纪律有 ${warnCount} 个观察项，自动买入可运行但建议复核参数。`
          : '开盘/收盘量化任务已开启真实因子、行情刷新、风险阻断、模拟盘和飞书通知。',
    },
    issues,
  };
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
        where: {
          type: { [Op.in]: ['QUANT_DAILY_PIPELINE', 'QUANT_OPEN_WATCHDOG', 'REALTIME_QUOTE_SYNC', 'QUANT_PARAM_MAINTENANCE'] },
        },
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
    const quoteSyncTasks = tasks.filter(
      task => task.type === 'REALTIME_QUOTE_SYNC' && task.is_active
    );
    const paramMaintenanceTasks = tasks.filter(
      task => task.type === 'QUANT_PARAM_MAINTENANCE' && task.is_active
    );
    const watchdogTasks = tasks.filter(
      task => task.type === 'QUANT_OPEN_WATCHDOG' && task.is_active
    );
    const executionDiscipline = buildExecutionDiscipline(tasks);
    const adoptedCount = toNumber((activeScanParams as any)?.summary?.adopted_strategy_count);
    const factorCoverageRates = (factorCoverage as any)?.coverage_rate || {};
    const factorMinCoverage = Math.min(
      toNumber(factorCoverageRates.valuation),
      toNumber(factorCoverageRates.money_flow),
      toNumber(factorCoverageRates.fundamental)
    );
    const factorRealProviderRate = toNumber(
      (factorCoverage as any)?.source_quality?.real_provider_rate
    );
    const factorCoverageStatus = String((factorCoverage as any)?.coverage_status || '');
    const factorStatus =
      (factorCoverage as any)?.error || factorMinCoverage < 45
        ? 'risk'
        : factorMinCoverage < 70 ||
          factorCoverageStatus === 'limited' ||
          (factorMinCoverage >= 70 && factorRealProviderRate < 10)
        ? 'warn'
        : 'ok';
    const checks: RuntimeHealthCheck[] = [
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
            : quoteSyncTasks.length > 0
            ? 'warn'
            : 'risk'
          : 'risk',
        metric: String((quoteSummary as any).latest_trade_date_symbol_count || 0),
        conclusion: (quoteSummary as any).persisted
          ? `最新行情 ${(quoteSummary as any).latest_quote_time || '-'}，覆盖 ${
              (quoteSummary as any).latest_trade_date_symbol_count || 0
            } 只股票，状态 ${(quoteSummary as any).freshness_status || 'unknown'}；盘中刷新任务 ${
              quoteSyncTasks.length > 0 ? '已启用' : '未启用'
            }。`
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
      {
        key: 'execution_discipline',
        label: '执行纪律',
        status: executionDiscipline.status as RuntimeCheckStatus,
        metric: `${executionDiscipline.summary.risk_count}/${executionDiscipline.summary.warn_count}`,
        conclusion: executionDiscipline.summary.conclusion,
      },
    ];

    const classifiedChecks = checks.map(classifyRuntimeCheck);
    const riskCount = classifiedChecks.filter(item => item.status === 'risk').length;
    const warnCount = classifiedChecks.filter(item => item.status === 'warn').length;
    const blockingChecks = classifiedChecks.filter(item => item.severity === 'blocking');
    const degradedChecks = classifiedChecks.filter(item => item.severity === 'degraded');
    const status =
      blockingChecks.length > 0
        ? 'risk'
        : degradedChecks.length > 0 || warnCount > 0
        ? 'warn'
        : 'ready';
    const buyGateAction =
      blockingChecks.length > 0 ? 'pause' : degradedChecks.length > 0 ? 'reduce' : 'allow';
    const buyGateMultiplier =
      buyGateAction === 'pause'
        ? 0
        : buyGateAction === 'reduce'
        ? Math.max(
            0.2,
            Math.min(
              1,
              degradedChecks.reduce(
                (product, item) => product * toNumber(item.position_multiplier, 0.7),
                1
              )
            )
          )
        : 1;
    const score = Math.round(
      ((checks.length - riskCount - warnCount * 0.45) / checks.length) * 100
    );
    const nextActions = buildRuntimeNextActions({
      status,
      buy_gate_action: buyGateAction,
      buy_gate_multiplier: buyGateMultiplier,
      blocking_checks: blockingChecks,
      degraded_checks: degradedChecks,
      warn_count: warnCount,
      quote_summary: quoteSummary,
      factor_min_coverage: factorMinCoverage,
      factor_real_provider_rate: factorRealProviderRate,
      adopted_count: adoptedCount,
      execution_discipline_status: executionDiscipline.status,
    });

    return {
      generated_at: new Date().toISOString(),
      status,
      score: Math.max(0, Math.min(100, score)),
      summary: {
        risk_count: riskCount,
        warn_count: warnCount,
        blocking_count: blockingChecks.length,
        degraded_count: degradedChecks.length,
        check_count: checks.length,
        enabled_strategy_count: enabledStrategies.length,
        policy_ready_strategy_count: policyReadyCount,
        open_task_count: openTasks.length,
        quote_sync_task_count: quoteSyncTasks.length,
        param_maintenance_task_count: paramMaintenanceTasks.length,
        watchdog_task_count: watchdogTasks.length,
        execution_discipline_status: executionDiscipline.status,
        factor_min_coverage_rate: round(factorMinCoverage),
        factor_real_provider_rate: round(factorRealProviderRate),
        next_action: nextActions[0]?.title || '继续观察',
        next_action_label: nextActions[0]?.action_label || '观察',
        conclusion:
          status === 'ready'
            ? '量化运行时健康：字段、策略、行情、参数和开盘任务均已就绪。'
            : status === 'warn'
            ? buyGateAction === 'reduce'
              ? '量化运行时可运行但需降仓，开盘可小仓验证并继续补因子/闭环样本。'
              : '量化运行时可运行但有观察项，开盘前建议关注行情新鲜度/参数样本。'
            : '量化运行时存在硬阻断风险，暂停自动买入。',
      },
      next_actions: nextActions,
      checks: classifiedChecks,
      buy_gate: {
        action: buyGateAction,
        blocked: blockingChecks.length > 0,
        degraded: degradedChecks.length > 0,
        position_multiplier: round(buyGateMultiplier, 3),
        blocking_checks: blockingChecks.map(item => ({
          key: item.key,
          label: item.label,
          status: item.status,
          metric: item.metric,
          conclusion: item.conclusion,
        })),
        degraded_checks: degradedChecks.map(item => ({
          key: item.key,
          label: item.label,
          status: item.status,
          metric: item.metric,
          conclusion: item.conclusion,
          position_multiplier: item.position_multiplier,
        })),
        conclusion:
          blockingChecks.length > 0
            ? `硬阻断 ${blockingChecks.length} 项：${blockingChecks
                .map(item => item.label)
                .join('、')}。`
            : degradedChecks.length > 0
            ? `非致命降仓 ${degradedChecks.length} 项：${degradedChecks
                .map(item => item.label)
                .join('、')}；建议仓位倍率 ${round(buyGateMultiplier, 2)}x。`
            : '未触发运行时买入阻断。',
      },
      runtime_schema: {
        status: (schemaHealth as any).status,
        summary: (schemaHealth as any).summary,
        critical_issues: runtimeIssues
          .filter((issue: any) => issue.level === 'critical')
          .slice(0, 8),
      },
      quote_persistence: quoteSummary,
      execution_discipline: executionDiscipline,
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
