import moment from 'moment-timezone';
import { Op } from 'sequelize';
import { ScheduledTask } from '../models/ScheduledTask';
import { TaskExecutionLog } from '../models/TaskExecutionLog';
import { DataSourceHealthService } from '../data/services/DataSourceHealthService';
import { quantRuntimeHealthService } from '../quant/health/internal/QuantRuntimeHealthService';
import { quantOpeningPreflightService } from './QuantOpeningPreflightService';
import { paperTradingRiskProfileService } from '../portfolio/internal/PaperTradingRiskProfileService';
import { taskAutomationHealthService } from './TaskAutomationHealthService';
import { AUTONOMOUS_PORTFOLIO_NAME } from '../portfolio/internal/PaperTradingPortfolioFamilies';
import { logger } from '../utils/logger';

type ReadinessStatus = 'ready' | 'degraded' | 'blocked';
type ActionLevel = 'ok' | 'watch' | 'warn' | 'risk';

interface OpeningReadinessOptions {
  user_id?: number;
  username?: string;
  trade_date?: string;
  factor_limit?: number;
  use_cache?: boolean;
  cache_ttl_ms?: number;
  force_refresh?: boolean;
}

function toNumber(value: any, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundNumber(value: any, digits = 2): number {
  const parsed = toNumber(value, 0);
  const base = 10 ** digits;
  return Math.round(parsed * base) / base;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function asPlainObject(value: any): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function toPlain<T = any>(record: any): T {
  if (!record) return record;
  return typeof record.toJSON === 'function' ? record.toJSON() : record;
}

function boolEnv(value: any, fallback = false): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function isTaskActive(task: any): boolean {
  return Boolean(task && task.is_active !== false);
}

function taskParam(task: any, key: string, fallback?: any): any {
  const params = asPlainObject(task?.parameters);
  return params[key] !== undefined ? params[key] : fallback;
}

function providerReady(provider: any): boolean {
  const status = String(provider?.status || '').toLowerCase();
  return ['healthy', 'degraded', 'ok', 'ready'].includes(status);
}

function statusLabel(status: ReadinessStatus): string {
  if (status === 'ready') return '今日可按纪律自动运行';
  if (status === 'degraded') return '今日降仓运行';
  return '今日暂停新增买入';
}

function statusTone(status: ReadinessStatus): 'success' | 'warning' | 'error' {
  if (status === 'ready') return 'success';
  if (status === 'degraded') return 'warning';
  return 'error';
}

function buildAction(
  key: string,
  level: ActionLevel,
  title: string,
  description: string,
  action_label: string
) {
  return { key, level, title, description, action_label };
}

class OpeningReadinessService {
  async getReadiness(options: OpeningReadinessOptions = {}) {
    const tradeDate = options.trade_date || moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
    const factorLimit = clamp(toNumber(options.factor_limit, 220), 50, 1000);

    const [
      runtimeHealth,
      preflight,
      riskProfile,
      automationHealth,
      tasks,
      providers,
      latestFeishuLog,
    ] = await Promise.all([
      quantRuntimeHealthService.getHealth({ user_id: options.user_id }).catch(error => {
        logger.warn(`开盘可信检查读取量化运行健康失败: ${error?.message || error}`);
        return {
          status: 'risk',
          summary: { conclusion: `量化运行健康读取失败：${error?.message || error}` },
          buy_gate: {
            blocked: true,
            action: 'pause',
            position_multiplier: 0,
            conclusion: `量化运行健康读取失败：${error?.message || error}`,
          },
          next_actions: [],
          checks: [],
        };
      }),
      quantOpeningPreflightService
        .check({
          user_id: options.user_id,
          factor_limit: factorLimit,
          use_cache: options.use_cache !== false,
          cache_ttl_ms: options.cache_ttl_ms || 90_000,
          force_refresh: options.force_refresh,
        })
        .catch(error => {
          logger.warn(`开盘可信检查读取开盘自检失败: ${error?.message || error}`);
          return {
            status: 'risk',
            summary: {
              hard_risk_count: 1,
              conclusion: `开盘自检读取失败：${error?.message || error}`,
            },
            checks: {},
            issues: [
              {
                key: 'opening_preflight',
                status: 'risk',
                conclusion: `开盘自检读取失败：${error?.message || error}`,
              },
            ],
          };
        }),
      options.user_id
        ? paperTradingRiskProfileService
            .getRiskProfile({
              user_id: options.user_id,
              portfolio_name: AUTONOMOUS_PORTFOLIO_NAME,
              include_family: true,
            })
            .catch(error => {
              logger.warn(`开盘可信检查读取模拟盘风险画像失败: ${error?.message || error}`);
              return null;
            })
        : Promise.resolve(null),
      taskAutomationHealthService.getHealth().catch(error => {
        logger.warn(`开盘可信检查读取自动化健康失败: ${error?.message || error}`);
        return null;
      }),
      ScheduledTask.findAll({
        where: {
          type: {
            [Op.in]: [
              'QUANT_DAILY_PIPELINE',
              'QUANT_OPEN_WATCHDOG',
              'REALTIME_QUOTE_SYNC',
              'QUANT_PARAM_MAINTENANCE',
              'RECOMMENDATION_TRADE_OUTCOME_REFRESH',
              'PAPER_TRADING_DAILY_PLAN',
            ],
          },
        },
        order: [
          ['is_active', 'DESC'],
          ['cron_expression', 'ASC'],
          ['id', 'ASC'],
        ],
      })
        .then(rows => rows.map(row => toPlain<any>(row)))
        .catch(error => {
          logger.warn(`开盘可信检查读取定时任务失败: ${error?.message || error}`);
          return [] as any[];
        }),
      DataSourceHealthService.getHealthSnapshots().catch(error => {
        logger.warn(`开盘可信检查读取数据源健康失败: ${error?.message || error}`);
        return [] as any[];
      }),
      this.getLatestFeishuLog().catch(error => {
        logger.warn(`开盘可信检查读取最近飞书日志失败: ${error?.message || error}`);
        return null;
      }),
    ]);

    const runtime = asPlainObject(runtimeHealth);
    const preflightData = asPlainObject(preflight);
    const checks = asPlainObject(preflightData.checks);
    const runtimeBuyGate = asPlainObject(runtime.buy_gate);
    const runtimeSummary = asPlainObject(runtime.summary);
    const factorCoverage = asPlainObject(checks.factor_coverage || runtime.factor_coverage);
    const realtimeQuote = asPlainObject(checks.realtime_quote || runtime.quote_persistence);
    const dataFreshness = asPlainObject(checks.data_freshness || runtime.data_freshness);
    const factorRate = Math.min(
      toNumber(asPlainObject(factorCoverage.coverage_rate).valuation),
      toNumber(asPlainObject(factorCoverage.coverage_rate).money_flow),
      toNumber(asPlainObject(factorCoverage.coverage_rate).fundamental)
    );
    const realProviderRate = toNumber(
      asPlainObject((factorCoverage as any).source_quality).real_provider_rate,
      toNumber(runtimeSummary.factor_real_provider_rate, 0)
    );
    const latestTradeDate =
      factorCoverage.latest_trade_date ||
      asPlainObject(dataFreshness.checks)?.daily_bars?.latest_trade_date ||
      null;
    const latestFactorDate =
      factorCoverage.effective_factor_date ||
      factorCoverage.latest_factor_date ||
      factorCoverage.latest_landed_factor_date ||
      null;

    const openingTask =
      tasks.find(
        task =>
          task.type === 'QUANT_DAILY_PIPELINE' &&
          isTaskActive(task) &&
          String(task.name || '').includes('开盘')
      ) ||
      tasks.find(task => task.type === 'QUANT_DAILY_PIPELINE' && isTaskActive(task)) ||
      null;
    const quantTask = tasks.find(
      task => task.type === 'QUANT_DAILY_PIPELINE' && isTaskActive(task)
    );
    const quoteSyncTask = tasks.find(
      task => task.type === 'REALTIME_QUOTE_SYNC' && isTaskActive(task)
    );
    const paramMaintenanceTask = tasks.find(
      task => task.type === 'QUANT_PARAM_MAINTENANCE' && isTaskActive(task)
    );
    const watchdogTask = tasks.find(
      task => task.type === 'QUANT_OPEN_WATCHDOG' && isTaskActive(task)
    );
    const outcomeRefreshTask = tasks.find(
      task => task.type === 'RECOMMENDATION_TRADE_OUTCOME_REFRESH' && isTaskActive(task)
    );
    const paperPlanTask = tasks.find(
      task => task.type === 'PAPER_TRADING_DAILY_PLAN' && isTaskActive(task)
    );

    const riskLevel = String((riskProfile as any)?.status?.level || 'safe').toLowerCase();
    const riskMetrics = asPlainObject((riskProfile as any)?.risk_metrics);
    const riskLimits = asPlainObject((riskProfile as any)?.limits);
    const cashPct = toNumber(riskMetrics.cash_pct);
    const exposurePct = toNumber(riskMetrics.exposure_pct);
    const drawdownPct = Math.abs(toNumber(riskMetrics.drawdown_pct));

    const feishuTableReady = Boolean(
      process.env.FEISHU_BITABLE_URL ||
        process.env.FEISHU_BITABLE_APP_TOKEN ||
        process.env.FEISHU_BASE_APP_TOKEN ||
        process.env.FEISHU_APP_TOKEN
    );
    const feishuBotReady =
      Boolean(process.env.FEISHU_RECOMMENDATION_BOT_WEBHOOK || process.env.FEISHU_BOT_WEBHOOK) &&
      !boolEnv(process.env.DISABLE_FEISHU_BOT_WEBHOOK, false);
    const tradingAgentsProvider = providers.find(
      provider => String(provider.provider_name || '').toLowerCase() === 'tradingagents'
    );
    const tradingAgentsReady = providerReady(tradingAgentsProvider);

    const runtimeBlocked = Boolean(runtimeBuyGate.blocked);
    const preflightHardRisk = toNumber(asPlainObject(preflightData.summary).hard_risk_count) > 0;
    const riskProfileBlocked =
      riskLevel === 'danger' ||
      (cashPct > 0 && cashPct < toNumber(riskLimits.min_cash_reserve_pct, 8) * 0.7) ||
      exposurePct > Math.max(toNumber(riskLimits.max_total_exposure_pct, 60) + 20, 88);
    const dataBlocked =
      !openingTask ||
      !quantTask ||
      realtimeQuote.status === 'risk' ||
      (factorRate > 0 && factorRate < 10);
    const blocked = runtimeBlocked || preflightHardRisk || riskProfileBlocked || dataBlocked;

    const degraded =
      !blocked &&
      (runtime.status !== 'ready' ||
        preflightData.status !== 'ready' ||
        riskLevel === 'watch' ||
        cashPct < 12 ||
        exposurePct > 75 ||
        factorRate < 70 ||
        realProviderRate < 10 ||
        realtimeQuote.ok === false ||
        !tradingAgentsReady ||
        !feishuBotReady ||
        !feishuTableReady ||
        automationHealth?.status !== 'healthy');

    const status: ReadinessStatus = blocked ? 'blocked' : degraded ? 'degraded' : 'ready';
    const runtimeMultiplier = toNumber(
      runtimeBuyGate.position_multiplier,
      status === 'ready' ? 1 : 0.55
    );
    const defaultPositionPct = toNumber(taskParam(openingTask, 'default_position_pct'), 3);
    const maxPositionPct = toNumber(taskParam(openingTask, 'max_position_pct'), 6);
    const taskMaxNewPositions = toNumber(taskParam(openingTask, 'max_daily_new_positions'), 2);
    const positionMultiplier =
      status === 'blocked'
        ? 0
        : status === 'degraded'
        ? clamp(runtimeMultiplier || 0.55, 0.2, 0.75)
        : clamp(runtimeMultiplier || 1, 0.6, 1.2);
    const maxNewPositions =
      status === 'blocked'
        ? 0
        : status === 'degraded'
        ? Math.min(1, Math.max(0, taskMaxNewPositions))
        : Math.min(3, Math.max(1, taskMaxNewPositions || 2));
    const buyAllowed = status !== 'blocked' && maxNewPositions > 0;
    const defaultPosition = roundNumber(defaultPositionPct * positionMultiplier, 2);
    const maxSinglePosition = roundNumber(maxPositionPct * positionMultiplier, 2);

    const issues = this.buildIssues({
      runtime,
      preflight: preflightData,
      riskProfile,
      factorRate,
      realProviderRate,
      realtimeQuote,
      tasks: {
        openingTask,
        quoteSyncTask,
        paramMaintenanceTask,
        watchdogTask,
        outcomeRefreshTask,
      },
      integrations: {
        tradingAgentsReady,
        feishuTableReady,
        feishuBotReady,
      },
    });
    const nextActions = this.buildNextActions({
      status,
      issues,
      runtime,
      preflight: preflightData,
      factorRate,
      realProviderRate,
      realtimeQuote,
      riskProfile,
      buyAllowed,
      maxNewPositions,
      defaultPosition,
      maxSinglePosition,
    });

    const conclusion =
      status === 'ready'
        ? `开盘可信检查通过：可新增 ${maxNewPositions} 只，默认仓位 ${defaultPosition}%，单票上限 ${maxSinglePosition}%。`
        : status === 'degraded'
        ? `开盘链路可运行但需降仓：最多新增 ${maxNewPositions} 只，默认仓位 ${defaultPosition}%，优先等行情/因子确认。`
        : `开盘链路存在阻断：暂停新增买入，先修复 ${
            issues
              .filter(item => item.level === 'risk')
              .slice(0, 2)
              .map(item => item.title)
              .join('、') || '关键链路'
          }。`;

    return {
      generated_at: moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss'),
      trade_date: tradeDate,
      status,
      status_label: statusLabel(status),
      status_tone: statusTone(status),
      conclusion,
      buy_gate: {
        allowed: buyAllowed,
        action: status === 'blocked' ? 'pause' : status === 'degraded' ? 'reduce' : 'allow',
        reason:
          runtimeBuyGate.conclusion ||
          (buyAllowed ? '运行时未触发硬阻断，按仓位纪律执行。' : '运行时或数据链路触发硬阻断。'),
        max_new_positions: maxNewPositions,
        default_position_pct: defaultPosition,
        max_single_position_pct: maxSinglePosition,
        position_multiplier: roundNumber(positionMultiplier, 3),
        min_cash_reserve_pct: toNumber(riskLimits.min_cash_reserve_pct, 8),
        max_total_exposure_pct: toNumber(riskLimits.max_total_exposure_pct, 60),
      },
      data: {
        daily_bar_ready: Boolean(latestTradeDate),
        realtime_quote_ready: Boolean(realtimeQuote.ok ?? realtimeQuote.persisted),
        realtime_quote_fresh: Boolean(realtimeQuote.is_fresh),
        realtime_quote_status: realtimeQuote.status || realtimeQuote.freshness_status || 'unknown',
        latest_quote_time: realtimeQuote.latest_quote_time || null,
        quote_symbol_count: toNumber(
          realtimeQuote.latest_trade_date_symbol_count,
          toNumber(realtimeQuote.latest_trade_date_snapshot_count)
        ),
        factor_ready: factorRate >= 70,
        factor_coverage_pct: roundNumber(factorRate, 2),
        real_provider_rate_pct: roundNumber(realProviderRate, 2),
        latest_trade_date: latestTradeDate,
        latest_factor_date: latestFactorDate,
        data_freshness_status: dataFreshness.status || runtime.data_freshness?.status || 'unknown',
      },
      tasks: {
        quant_daily_pipeline_ready: Boolean(quantTask),
        opening_scan_ready: Boolean(openingTask),
        realtime_quote_sync_ready: Boolean(quoteSyncTask),
        param_maintenance_ready: Boolean(paramMaintenanceTask),
        watchdog_ready: Boolean(watchdogTask),
        recommendation_outcome_refresh_ready: Boolean(outcomeRefreshTask),
        paper_trading_plan_ready: Boolean(paperPlanTask),
        automation_status: automationHealth?.status || 'unknown',
        opening_scan: this.formatTask(openingTask),
        quote_sync: this.formatTask(quoteSyncTask),
        param_maintenance: this.formatTask(paramMaintenanceTask),
        watchdog: this.formatTask(watchdogTask),
        outcome_refresh: this.formatTask(outcomeRefreshTask),
      },
      portfolio: {
        risk_level: riskLevel || 'safe',
        risk_label: (riskProfile as any)?.status?.label || '安全',
        cash_pct: roundNumber(cashPct, 2),
        exposure_pct: roundNumber(exposurePct, 2),
        drawdown_pct: roundNumber(drawdownPct, 2),
        open_position_count: toNumber((riskProfile as any)?.portfolio?.open_position_count),
        warnings: ((riskProfile as any)?.warnings || []).slice(0, 5),
      },
      integrations: {
        tradingagents_ready: tradingAgentsReady,
        tradingagents_status: tradingAgentsProvider?.status || 'unknown',
        tradingagents_latency_ms: tradingAgentsProvider?.last_latency_ms || null,
        feishu_table_ready: feishuTableReady,
        feishu_bot_ready: feishuBotReady,
        feishu_bot_disabled: boolEnv(process.env.DISABLE_FEISHU_BOT_WEBHOOK, false),
        latest_feishu: latestFeishuLog,
      },
      issues,
      next_actions: nextActions,
      source_snapshots: {
        runtime_health: {
          status: runtime.status,
          score: runtime.score,
          summary: runtime.summary,
          buy_gate: runtime.buy_gate,
        },
        opening_preflight: {
          status: preflightData.status,
          summary: preflightData.summary,
          issues: (preflightData.issues || []).slice(0, 8),
        },
      },
    };
  }

  private buildIssues(payload: {
    runtime: Record<string, any>;
    preflight: Record<string, any>;
    riskProfile: any;
    factorRate: number;
    realProviderRate: number;
    realtimeQuote: Record<string, any>;
    tasks: Record<string, any>;
    integrations: Record<string, boolean>;
  }) {
    const issues: Array<{
      key: string;
      level: ActionLevel;
      title: string;
      detail: string;
    }> = [];
    const add = (key: string, level: ActionLevel, title: string, detail: string) => {
      issues.push({ key, level, title, detail });
    };

    if (payload.runtime?.buy_gate?.blocked) {
      add(
        'runtime_buy_gate',
        'risk',
        '运行时买入门禁阻断',
        payload.runtime?.buy_gate?.conclusion || '量化运行时健康触发硬阻断。'
      );
    }
    if (toNumber(payload.preflight?.summary?.hard_risk_count) > 0) {
      add(
        'opening_preflight_hard_risk',
        'risk',
        '开盘自检存在硬风险',
        payload.preflight?.summary?.conclusion || '开盘前需先修复硬风险。'
      );
    }
    if (!payload.tasks.openingTask) {
      add('opening_task_missing', 'risk', '开盘扫描任务缺失', '未找到启用的量化开盘扫描任务。');
    }
    if (!payload.tasks.quoteSyncTask) {
      add('quote_sync_missing', 'warn', '盘中行情刷新任务缺失', '没有独立实时行情快照刷新任务。');
    }
    if (!payload.tasks.paramMaintenanceTask) {
      add('param_maintenance_missing', 'warn', '参数后验维护缺失', '参数收益刷新与晋级可能延迟。');
    }
    if (payload.realtimeQuote.ok === false || payload.realtimeQuote.status === 'risk') {
      add(
        'realtime_quote_not_ready',
        'risk',
        '实时行情不可信',
        payload.realtimeQuote.conclusion || '实时行情未落盘或不新鲜。'
      );
    } else if (!payload.realtimeQuote.is_fresh) {
      add(
        'realtime_quote_stale',
        'warn',
        '实时行情需要刷新',
        payload.realtimeQuote.conclusion || '行情存在但不是最新快照。'
      );
    }
    if (payload.factorRate < 10) {
      add(
        'factor_missing',
        'risk',
        '因子覆盖严重不足',
        `最低覆盖率 ${roundNumber(payload.factorRate)}%。`
      );
    } else if (payload.factorRate < 70) {
      add(
        'factor_low',
        'warn',
        '因子覆盖不足',
        `最低覆盖率 ${roundNumber(payload.factorRate)}%，只能降仓验证。`
      );
    }
    if (payload.realProviderRate < 10 && payload.factorRate >= 70) {
      add(
        'real_factor_low',
        'watch',
        '真实因子占比偏低',
        `真实源占比 ${roundNumber(payload.realProviderRate)}%，多为本地派生因子。`
      );
    }
    const riskLevel = String(payload.riskProfile?.status?.level || '').toLowerCase();
    if (riskLevel === 'danger') {
      add(
        'portfolio_risk_danger',
        'risk',
        '组合风险过高',
        payload.riskProfile?.status?.conclusion || '模拟盘风险画像已进入危险区。'
      );
    } else if (riskLevel === 'watch') {
      add(
        'portfolio_risk_watch',
        'warn',
        '组合进入观察区',
        payload.riskProfile?.status?.conclusion || '建议降低新增仓位。'
      );
    }
    if (!payload.integrations.tradingAgentsReady) {
      add(
        'tradingagents_not_ready',
        'warn',
        'Agent复核不可用',
        'TradingAgents 健康状态异常或未探测。'
      );
    }
    if (!payload.integrations.feishuTableReady || !payload.integrations.feishuBotReady) {
      add('feishu_not_ready', 'warn', '飞书通知不完整', '多维表格或机器人摘要配置不完整。');
    }

    return issues.slice(0, 12);
  }

  private buildNextActions(payload: {
    status: ReadinessStatus;
    issues: Array<{ key: string; level: ActionLevel; title: string; detail: string }>;
    runtime: Record<string, any>;
    preflight: Record<string, any>;
    factorRate: number;
    realProviderRate: number;
    realtimeQuote: Record<string, any>;
    riskProfile: any;
    buyAllowed: boolean;
    maxNewPositions: number;
    defaultPosition: number;
    maxSinglePosition: number;
  }) {
    const actions: ReturnType<typeof buildAction>[] = [];
    const hardIssues = payload.issues.filter(item => item.level === 'risk');
    if (payload.status === 'blocked') {
      actions.push(
        buildAction(
          'pause_new_entries',
          'risk',
          '暂停新增买入',
          `先修复 ${
            hardIssues
              .map(item => item.title)
              .slice(0, 3)
              .join('、') || '开盘链路'
          }，只保留持仓风控。`,
          '暂停买入'
        )
      );
    } else if (payload.status === 'degraded') {
      actions.push(
        buildAction(
          'small_position_run',
          'warn',
          '降仓小样本运行',
          `最多新增 ${payload.maxNewPositions} 只，默认 ${payload.defaultPosition}%，单票不超过 ${payload.maxSinglePosition}%。`,
          '降仓运行'
        )
      );
    } else {
      actions.push(
        buildAction(
          'normal_open_scan',
          'ok',
          '等待开盘扫描',
          `最多新增 ${payload.maxNewPositions} 只，默认 ${payload.defaultPosition}%，执行后看模拟盘收益。`,
          '正常运行'
        )
      );
    }

    if (!payload.realtimeQuote.is_fresh) {
      actions.push(
        buildAction(
          'refresh_quotes',
          payload.realtimeQuote.ok === false ? 'risk' : 'watch',
          '刷新实时行情',
          '等盘中行情快照任务完成后再采信买入价，避免使用旧价格。',
          '补价格'
        )
      );
    }
    if (payload.factorRate < 70 || payload.realProviderRate < 10) {
      actions.push(
        buildAction(
          'refresh_factors',
          payload.factorRate < 45 ? 'warn' : 'watch',
          '补因子覆盖',
          `当前因子覆盖 ${roundNumber(payload.factorRate)}%，真实源 ${roundNumber(
            payload.realProviderRate
          )}%；补齐后再放大仓位。`,
          '补因子'
        )
      );
    }
    const runtimeActions = Array.isArray(payload.runtime.next_actions)
      ? payload.runtime.next_actions
      : [];
    runtimeActions.slice(0, 2).forEach((item: any, index: number) => {
      actions.push(
        buildAction(
          `runtime_${item.key || index}`,
          item.level || 'watch',
          item.title || '观察运行时健康',
          item.description || item.action_label || '继续观察运行时健康。',
          item.action_label || '观察'
        )
      );
    });

    const seen = new Set<string>();
    return actions
      .filter(item => {
        if (seen.has(item.key)) return false;
        seen.add(item.key);
        return true;
      })
      .slice(0, 5);
  }

  private formatTask(task: any) {
    if (!task) return null;
    return {
      id: task.id,
      name: task.name,
      type: task.type,
      cron_expression: task.cron_expression,
      is_active: task.is_active,
      last_run_at: task.last_run_at,
      last_run_status: task.last_run_status,
      parameters: {
        candidate_limit: taskParam(task, 'candidate_limit'),
        factor_sync_limit: taskParam(task, 'factor_sync_limit'),
        quote_sync_limit: taskParam(task, 'quote_sync_limit'),
        default_position_pct: taskParam(task, 'default_position_pct'),
        max_position_pct: taskParam(task, 'max_position_pct'),
        max_daily_new_positions: taskParam(task, 'max_daily_new_positions'),
      },
    };
  }

  private async getLatestFeishuLog() {
    const log = await TaskExecutionLog.findOne({
      where: {
        task_name: {
          [Op.or]: [
            { [Op.iLike]: '%量化策略%' },
            { [Op.iLike]: '%全市场荐股%' },
            { [Op.iLike]: '%飞书%' },
            { [Op.iLike]: '%推荐交易收益闭环%' },
          ],
        },
      },
      order: [['started_at', 'DESC']],
      raw: true,
    });
    if (!log) return null;
    return {
      id: (log as any).id,
      task_id: (log as any).task_id,
      task_name: (log as any).task_name,
      status: (log as any).status,
      started_at: (log as any).started_at,
      completed_at: (log as any).completed_at,
      error_message: (log as any).error_message || '',
    };
  }
}

export const openingReadinessService = new OpeningReadinessService();
