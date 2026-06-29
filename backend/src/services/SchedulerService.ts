import cron, { ScheduledTask as CronScheduledTask } from 'node-cron';
import { ScheduledTask } from '../models/ScheduledTask';
import {
  buildCronRegistryDump,
  findUnregisteredTypes,
  isRegisteredCronType,
  CRON_REGISTRY,
} from '../constants/cronRegistry';
import { TaskExecutionLog } from '../models/TaskExecutionLog';
import { PaperTradingPortfolio } from '../models/PaperTradingPortfolio';
import { logger } from '../utils/logger';
import { generateTraceId, runWithLoggingContext } from '../utils/loggingContext';
import { computeNextRunAt, isImplausibleNextRun } from '../utils/cronNextRun';
import { LIVE_AUDIT_EVENT_TYPES } from '../live-trading/auditEvents';
import { dataUpdateQueue } from '../jobs/dataUpdateQueue';
import { aiPollingQueue } from '../jobs/aiPollingQueue';
import { buildAIPollingJobOptions } from '../jobs/aiPollingEnqueue';
import { aiAdvisorService } from './AIAdvisorService';
import { quantRecommendationService } from './QuantRecommendationService';
import { quantFusionService } from '../quant/engine/internal/QuantFusionService';
import { quantOpenWatchdogService } from '../quant/health/internal/QuantOpenWatchdogService';
import { quantStrategyFeedbackService } from '../quant/engine/internal/QuantStrategyFeedbackService';
import { quantStrategyParamVersionService } from '../quant/engine/internal/QuantStrategyParamVersionService';
import { quantDataService } from '../quant/engine/internal/QuantDataService';
import { realtimeQuoteService } from '../data/services/RealtimeQuoteService';
import { intradayUniverseService } from './IntradayUniverseService';
import { aiInvestmentSignalService } from './AIInvestmentSignalService';
import { feishuTaskReportService } from './FeishuTaskReportService';
import { paperTradingAutomationService } from '../portfolio/internal/PaperTradingAutomationService';
import { paperTradingAttributionService } from '../portfolio/internal/PaperTradingAttributionService';
import { paperTradingPlanService } from '../portfolio/internal/PaperTradingPlanService';
import { paperTradingOrderIntentService } from '../portfolio/internal/PaperTradingOrderIntentService';
import { paperTradingTuningApplyService } from '../portfolio/internal/PaperTradingTuningApplyService';
import { trailingStopGuard } from '../portfolio/risk/TrailingStopGuard';
import { drawdownCircuitBreaker } from '../portfolio/risk/DrawdownCircuitBreaker';
import { marketRegimeAlertService } from '../portfolio/risk/MarketRegimeAlertService';
import { perStockStopLossGuard } from '../portfolio/risk/PerStockStopLossGuard';
import { industryConcentrationGuard } from '../portfolio/risk/IndustryConcentrationGuard';
import { morningRiskCheckupService } from '../portfolio/risk/MorningRiskCheckupService';
import { restrictedShareWatchdog } from '../portfolio/risk/RestrictedShareWatchdog';
import { executeGuardSells } from '../portfolio/risk/GuardSellExecutor';
// Batch AB (2026-06-18): 行业 / 题材 / 资金面数据 sync — 之前 cron 完全没注册
// 让 industry_flows / limit_up_stocks / northbound_holdings / snowball_keywords /
// stock_sentiments 表全部停在旧日期 → 下游因子 / 策略 / TradingAgents prompt 全失明.
import { industrySyncService } from '../data/services/IndustrySyncService';
import { limitUpSyncService } from '../data/services/LimitUpSyncService';
import { northboundSyncService } from '../data/services/NorthboundSyncService';
import { snowballHotKeywordSyncService } from '../data/services/SnowballHotKeywordSyncService';
import { stockSentimentSyncService } from '../data/services/StockSentimentSyncService';
import { dailyTradingDigestService } from './DailyTradingDigestService';
import { earningsForecastWatcher } from './EarningsForecastWatcher';
import { weeklyReviewReportService } from './WeeklyReviewReportService';
import { marketBriefService } from './MarketBriefService';
import { enhancedTradingJournalService } from './EnhancedTradingJournalService';
import { cleanupOldDataService } from './CleanupOldDataService';
import { benchmarkIndexService } from './BenchmarkIndexService';
import { automatedRecommendationLoopService } from './AutomatedRecommendationLoopService';
import { recommendationTradeOutcomeService } from './RecommendationTradeOutcomeService';
import { taskParameterAuditService } from './TaskParameterAuditService';
import { liveTradingService } from '../live-trading/services/LiveTradingService';
import { User } from '../models/User';
import { openingReadinessService } from './OpeningReadinessService';
import {
  AUTONOMOUS_PORTFOLIO_NAME,
  DEFAULT_AUTONOMOUS_INITIAL_CAPITAL,
} from '../portfolio/internal/PaperTradingDashboardService';
import moment from 'moment-timezone';
import { Op } from 'sequelize';
// US-004 [OPS-004]: scheduler 任务执行计数 / 耗时 metric — 由 _executeTaskLogic
// 在 success / failed / skipped 三个出口收尾时调用. 不感知 task.id / task.name (避免
// label cardinality 爆炸); 只按 CRON_REGISTRY 的 task_type 维度统计.
import { recordSchedulerTaskRun } from '../metrics/PrometheusRegistry';

type TaskRunStatus = 'SUCCESS' | 'FAILED' | 'RUNNING';
type TaskExecutionLogLike = TaskExecutionLog | null;

/**
 * Batch BF-2 (2026-06-23): 抽前 N 行 stack — cron 失败推 Lark 用.
 * 兼容 Error 实例 / 普通 object / string. 完全 stack 太长 (lark card 2k 限制),
 * 取前 5 行通常足够定位.
 */
function errorStackPreview(err: any, maxLines: number): string {
  if (!err) return '';
  const stack = typeof err === 'object' && err && err.stack ? String(err.stack) : '';
  if (!stack) return '';
  return stack
    .split('\n')
    .slice(0, Math.max(1, maxLines))
    .map(line => line.replace(/^\s+/, ''))
    .join('\n');
}

function compactRuntimeHealth(runtimeHealth: any) {
  if (!runtimeHealth) return null;
  return {
    status: runtimeHealth.status,
    score: runtimeHealth.score,
    conclusion: runtimeHealth.summary?.conclusion,
    risk_count: runtimeHealth.summary?.risk_count,
    warn_count: runtimeHealth.summary?.warn_count,
    factor_min_coverage_rate: runtimeHealth.summary?.factor_min_coverage_rate,
    factor_real_provider_rate: runtimeHealth.summary?.factor_real_provider_rate,
    factor_coverage_status: runtimeHealth.factor_coverage?.coverage_status,
    buy_gate: runtimeHealth.buy_gate || null,
    risk_checks: Array.isArray(runtimeHealth.checks)
      ? runtimeHealth.checks
          .filter((item: any) => item.status === 'risk' || item.status === 'warn')
          .slice(0, 6)
          .map((item: any) => ({
            key: item.key,
            label: item.label,
            status: item.status,
            metric: item.metric,
            conclusion: item.conclusion,
          }))
      : [],
  };
}

function buildQuantDailyPipelineLogSummary(
  result: any,
  agentSubmitted: number,
  agentFailed: number
) {
  const archive = result?.archive || {};
  const paper = result?.paper_trading || {};
  const generated = result?.generated || {};
  const runtimeHealth = compactRuntimeHealth(result?.runtime_health);
  return {
    scenario: 'quant_daily_pipeline',
    status: result?.status || 'completed',
    runtime_risk_blocked: Boolean(result?.runtime_risk_blocked),
    runtime_health: runtimeHealth,
    runtime_block_reason: result?.runtime_risk_blocked
      ? runtimeHealth?.conclusion || result?.message || '量化运行时存在风险项，本轮未执行买入。'
      : null,
    trade_date: result?.trade_date,
    scanned_stocks: generated?.scanned_stocks,
    signal_count: generated?.signal_count,
    archived_signal_count: archive?.total,
    agent_submitted: agentSubmitted,
    agent_failed: agentFailed,
    paper_executed: paper?.executed,
    paper_planned: paper?.planned,
    paper_skipped: paper?.skipped,
    message: result?.message,
  };
}

function buildQuantParamMaintenanceLogSummary(result: any) {
  const create = result?.create || {};
  const refresh = result?.refresh || {};
  const lifecycle = result?.lifecycle || {};
  const lifecycleSummary = lifecycle?.lifecycle?.summary || lifecycle?.summary || {};
  const activeScan = result?.active_scan_params || {};
  const activeSummary = activeScan?.summary || {};
  const promoted = Number(lifecycleSummary.promotion_count || 0);
  const degraded = Number(lifecycleSummary.degradation_count || 0);
  const rolledBack = Number(lifecycleSummary.rollback_count || 0);
  const applied = Number(lifecycle?.applied || 0);
  const completed = Number(refresh?.completed || 0);
  const pending = Number(refresh?.pending || 0);
  const noData = Number(refresh?.no_data || 0);
  const created = Number(create?.created || 0);
  const updated = Number(create?.updated || 0);
  return {
    scenario: 'quant_param_maintenance',
    status: result?.status || 'completed',
    trade_date: result?.trade_date,
    signal_window: result?.signal_window,
    horizons: create?.horizons || result?.horizons,
    created_validations: created,
    updated_validations: updated,
    refreshed_validations: Number(refresh?.refreshed || 0),
    completed_validations: completed,
    pending_validations: pending,
    no_data_validations: noData,
    lifecycle_applied: applied,
    lifecycle_promotion_count: promoted,
    lifecycle_degradation_count: degraded,
    lifecycle_rollback_count: rolledBack,
    active_adopted_strategy_count: Number(activeSummary.adopted_strategy_count || 0),
    active_champion_count: Number(activeSummary.champion_count || 0),
    active_candidate_count: Number(activeSummary.active_candidate_count || 0),
    message:
      applied > 0
        ? `参数后验维护完成：应用 ${applied} 个生命周期动作（推广 ${promoted}、降级 ${degraded}、回滚 ${rolledBack}）。`
        : `参数后验维护完成：新增 ${created} 条、更新 ${updated} 条，完成收益 ${completed} 条，待完成 ${pending} 条。`,
  };
}

function buildLiveShadowAutopilotLogSummary(result: any, outcomes: any) {
  const runSummary = result?.summary || {};
  const outcomeSummary = outcomes?.summary || {};
  const skipped = Boolean(result?.skipped);
  const readiness = result?.readiness || {};
  return {
    scenario: 'live_shadow_autopilot',
    status: skipped ? 'skipped' : 'completed',
    mode: result?.mode || 'shadow_only',
    skipped,
    skip_reason: result?.reason || '',
    readiness_status: readiness?.status,
    readiness_conclusion: readiness?.conclusion,
    selected_count: Number(runSummary.selected_count || 0),
    shadow_executed_count: Number(runSummary.shadow_executed_count || 0),
    blocked_count: Number(runSummary.blocked_count || 0),
    real_order_submitted: Number(runSummary.real_order_submitted || 0),
    outcome_trade_count: Number(outcomeSummary.shadow_trade_count || 0),
    outcome_evaluated_count: Number(outcomeSummary.evaluated_count || 0),
    outcome_win_rate_pct: outcomeSummary.win_rate_pct,
    outcome_avg_latest_return_pct: outcomeSummary.avg_latest_return_pct,
    outcome_total_latest_pnl: outcomeSummary.total_latest_pnl,
    paper_baseline_avg_return_pct: outcomeSummary.baseline?.paper_trading?.avg_latest_return_pct,
    paper_baseline_win_rate_pct: outcomeSummary.baseline?.paper_trading?.win_rate_pct,
    signal_baseline_avg_return_pct: outcomeSummary.baseline?.signal_forward_returns?.avg_return_pct,
    baseline_since: outcomeSummary.baseline?.since,
    budget_action: outcomeSummary.budget_decision?.action,
    budget_label: outcomeSummary.budget_decision?.label,
    budget_recommended_limit: outcomeSummary.budget_decision?.recommended_limit,
    budget_reason: outcomeSummary.budget_decision?.reason,
    message:
      outcomeSummary.conclusion ||
      runSummary.conclusion ||
      '无人影子执行完成；真实券商委托提交数为 0。',
  };
}

function buildLiveShadowWeeklyReviewLogSummary(outcomes: any) {
  const summary = outcomes?.summary || {};
  return {
    scenario: 'live_shadow_weekly_review',
    status: 'completed',
    shadow_trade_count: Number(summary.shadow_trade_count || 0),
    evaluated_count: Number(summary.evaluated_count || 0),
    open_count: Number(summary.open_count || 0),
    win_rate_pct: summary.win_rate_pct,
    avg_latest_return_pct: summary.avg_latest_return_pct,
    total_latest_pnl: summary.total_latest_pnl,
    real_order_submitted: Number(summary.real_order_submitted || 0),
    paper_baseline_avg_return_pct: summary.baseline?.paper_trading?.avg_latest_return_pct,
    signal_baseline_avg_return_pct: summary.baseline?.signal_forward_returns?.avg_return_pct,
    baseline_since: summary.baseline?.since,
    budget_action: summary.budget_decision?.action,
    budget_label: summary.budget_decision?.label,
    budget_recommended_limit: summary.budget_decision?.recommended_limit,
    budget_reason: summary.budget_decision?.reason,
    message: summary.conclusion || summary.budget_decision?.reason || '影子执行周度复盘完成。',
  };
}

function buildRealtimeQuoteSyncLogSummary(result: any, persistence: any, options: any = {}) {
  return {
    scenario: 'realtime_quote_sync',
    status: result?.persisted_count > 0 ? 'completed' : 'empty',
    source: options.source || 'auto',
    universe: options.universe || 'market',
    requested_count: result?.requested_count || 0,
    batch_count: result?.batch_count || 0,
    persisted_count: result?.persisted_count || 0,
    updated_stock_count: result?.updated_stock_count || 0,
    latest_quote_time: result?.latest_quote_time || persistence?.latest_quote_time || null,
    freshness_status: persistence?.freshness_status || 'unknown',
    latest_trade_date_symbol_count: persistence?.latest_trade_date_symbol_count || 0,
    is_fresh: Boolean(persistence?.is_fresh),
    message:
      result?.persisted_count > 0
        ? `实时行情快照已刷新 ${result.persisted_count} 条，覆盖 ${
            persistence?.latest_trade_date_symbol_count || 0
          } 只股票。`
        : '实时行情快照未写入，请检查 AKShare/腾讯行情源连通性。',
  };
}

class SchedulerService {
  private activeTasks: Map<number, CronScheduledTask> = new Map();
  /**
   * Batch O (2026-06-17, C-S1 fix): in-flight lock — 防 cron tick overlap.
   * 上一次 task 没跑完下一次 tick 触发会 *同时跑两实例*, 配合 Batch J 真卖路径
   * = 数量翻倍卖. node-cron 没有 noOverlap 原生支持, 自实现一个 task.id Set.
   */
  private inFlightTaskIds: Set<number> = new Set();
  /**
   * Batch O (2026-06-17, C-S5): 周期性 reconcile stale RUNNING task 的 timer.
   * 旧实现只在 boot 跑一次 → IN_PROGRESS 永挂. 现在每 10 分钟扫一次.
   */
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Batch M (2026-06-17): production 启动可观测性.
   * /health/detail 用此 getter 暴露 scheduler_active_tasks 计数,
   * 让运维能感知"进程健康但 0 cron 在跑"这类 silent failure.
   */
  getActiveTaskCount(): number {
    return this.activeTasks.size;
  }
  getActiveTaskIds(): number[] {
    return [...this.activeTasks.keys()];
  }

  async initialize() {
    try {
      await this.reconcileStaleRunningTasks();

      // US-002 (OPS-002, 2026-06-19): 启动时把 CRON_REGISTRY 完整 dump 到日志,
      // 让运维 grep "cron registry" 能秒看到"系统认为自己应该跑哪些 cron 任务"。
      // 这是"代码白名单"侧的事实源 (DB 里有几条 + 实际 schedule 成功几条是另一组数字)。
      this.dumpCronRegistry();

      const tasks = await ScheduledTask.findAll({ where: { is_active: true } });
      logger.info(`Found ${tasks.length} active scheduled tasks`);

      for (const task of tasks) {
        this.scheduleTask(task);
      }
      // Batch M (2026-06-17): 启动后立即 log 实际 schedule 成功的 task 数,
      // 让运维 grep "scheduler initialized" 能秒看到 N vs 期望. 0 = 立即告警.
      logger.info(
        `[scheduler] initialize complete: active_count=${this.activeTasks.size}/${tasks.length} ` +
          `(${tasks.length - this.activeTasks.size} 个未 schedule, 通常是 cron expression 非法)`
      );

      // US-002 (OPS-002, 2026-06-19): schedule 完后 dump 每个 active task 的下一次
      // 触发时间 + 跟 CRON_REGISTRY 对账。让运维一行日志看到"这个 task 下次什么时候触发"
      // (而不是去问 DB / 手算 cron), 同时把"DB 有 type 但代码没登记"的漂移暴露出来。
      this.dumpActiveTaskSchedule(tasks);

      // Batch O (2026-06-17, C-S5): 启动周期性 reconcile timer.
      // 旧实现只在 boot 跑一次, task 卡死后 RUNNING 状态永不清. 现在每 10 分钟扫一次
      // 把 RUNNING 超 30min 的标 FAILED, 让 dashboard 能反映真实状态.
      if (this.reconcileTimer) clearInterval(this.reconcileTimer);
      this.reconcileTimer = setInterval(() => {
        this.reconcileStaleRunningTasks().catch(err =>
          logger.warn(`[scheduler] periodic reconcileStaleRunningTasks failed: ${err?.message}`)
        );
      }, 10 * 60 * 1000).unref();

      // Batch AH review (2026-06-18): catch-up — server 启动 (deploy 重启) 后,
      // 找出 "今日 cron 窗口已过 + last_run_at 是空 / 早于今日凌晨" 的 sync task,
      // 异步立即跑一次, 避免错过当日数据.
      // 仅对白名单 sync task type catch-up, 不对策略/风险类 catch-up.
      void this.catchUpMissedTasks(tasks).catch(err =>
        logger.warn(`[scheduler] catchUpMissedTasks failed: ${err?.message}`)
      );

      // BETA-5 (2026-06-18, audit M-14): boot 巡检 STRATEGY_KILL_SWITCH_CHECK 等
      // "应该真跑"的 task 是否被显式 dry_run=true 覆盖。找到 → 写 RiskAlert MEDIUM
      // 让运维确认。不修改任何配置（read-only）；失败不阻塞 boot。
      void (async () => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { auditTaskParametersDryRun } = require('../scripts/audit-task-parameters-dry-run');
          const res = await auditTaskParametersDryRun();
          if (res.matches.length > 0) {
            logger.warn(
              `[scheduler] boot dry_run audit: ${res.matches.length} task(s) flagged ` +
                `(RiskAlert ${res.alert_written ? 'written' : 'NOT written'})`
            );
          }
        } catch (auditErr: any) {
          logger.warn(`[scheduler] boot dry_run audit failed: ${auditErr?.message || auditErr}`);
        }
      })();
    } catch (error) {
      logger.error('Failed to initialize scheduler:', error);
      // Batch M (2026-06-17): 旧实现 swallow error 让进程"健康"启动但 0 cron 在跑.
      // 现在 re-throw 让 initializeApp 至少能记到 metric, 不强制 process.exit (主进程
      // 自己决定是否 fatal — 见 index.ts catch).
      throw error;
    }
  }

  private scheduleTask(task: ScheduledTask) {
    if (this.activeTasks.has(task.id)) {
      // Batch O (2026-06-17, C-S2 fix): 旧实现只 .stop() 不 .destroy(), node-cron
      // registry 永久泄漏, 长期运行内存膨胀 + 已 stop 的 task 仍占资源. 现在显式
      // destroy 释放 task object 内的 timer 引用.
      const old = this.activeTasks.get(task.id);
      try {
        old?.stop();
        // node-cron@3 类型 def 里没有 destroy, 但 runtime 上有这个方法; 用 any 兜底.
        (old as any)?.destroy?.();
      } catch (destroyErr: any) {
        logger.warn(
          `[scheduler] stop+destroy old task ${task.id} failed (continuing): ${
            destroyErr?.message || destroyErr
          }`
        );
      }
      this.activeTasks.delete(task.id);
    }

    if (!cron.validate(task.cron_expression)) {
      logger.error(`Invalid cron expression for task ${task.id}: ${task.cron_expression}`);
      return;
    }

    const scheduledJob = cron.schedule(
      task.cron_expression,
      async () => {
        // Batch O (2026-06-17, C-S1 fix): in-flight lock 防 overlap. 上一次 task 还在
        // 跑下一次 tick 触发 → 同 task_id 同时跑两实例 → 配合 Batch J guard sell
        // executor 真卖路径 = 数量翻倍卖. 现在 skip + warn.
        if (this.inFlightTaskIds.has(task.id)) {
          logger.warn(
            `[scheduler] task ${task.id} (${task.name}) 上一次 tick 仍在跑, skip 本次 tick 防 overlap`
          );
          return;
        }
        this.inFlightTaskIds.add(task.id);
        // US-097 [OPS-008]: 每个 cron tick 起一个独立 trace_id + module='scheduler',
        // 让该 task 跑时所有 logger.* 全链路自动携带统一字段; grep trace_id 能完整追踪
        // 一次 cron 跑的全部 service / model 子调用 (含异步 fan-out 也覆盖).
        const ctxTraceId = generateTraceId();
        await runWithLoggingContext({ trace_id: ctxTraceId, module: 'scheduler' }, async () => {
          logger.info(`Executing scheduled task: ${task.name} (${task.type})`);
          try {
            await this._executeTaskLogic(task, false);
          } catch (error) {
            logger.error(`Scheduled task ${task.id} (${task.name}) execution failed:`, error);
          } finally {
            this.inFlightTaskIds.delete(task.id);
          }
        });
      },
      {
        timezone: 'Asia/Shanghai',
      }
    );

    this.activeTasks.set(task.id, scheduledJob);
    logger.info(
      `Scheduled task ${task.id} (${task.name}) registered with cron: ${task.cron_expression}`
    );
  }

  /**
   * US-002 (OPS-002, 2026-06-19): 启动时把 CRON_REGISTRY (代码白名单) 完整 dump 到日志。
   * 这是"代码层认为系统应该跑哪些 cron 任务"的事实源, 用于:
   *   - 运维查"我重启完, 系统认为自己会跑些什么", grep "[scheduler] cron registry"
   *   - 跟 /health/detail 里的 scheduler_active_tasks 对照, 漏 schedule 一眼看到
   *   - 新人 onboarding (省去翻 SchedulerService._executeTaskLogic 5000 行)
   * 失败不阻塞 boot — 仅 warn。
   */
  private dumpCronRegistry(): void {
    try {
      const lines = buildCronRegistryDump();
      logger.info(`[scheduler] cron registry: ${lines.length} type(s) declared in code`);
      for (const line of lines) {
        const flags: string[] = [];
        if (line.intraday) flags.push('intraday');
        const tag = flags.length ? ` [${flags.join(',')}]` : '';
        const rec = line.recommendedCron ? ` recommendedCron="${line.recommendedCron}"` : '';
        logger.info(
          `[scheduler] cron registry/${line.category} ${line.type}${tag} owner=${line.owner}${rec} — ${line.description}`
        );
      }
    } catch (err: any) {
      logger.warn(`[scheduler] dumpCronRegistry failed (non-fatal): ${err?.message || err}`);
    }
  }

  /**
   * US-002 (OPS-002, 2026-06-19): 把每个 active scheduled task 的 (id, name, type,
   * cron_expression, nextRunAt) dump 到日志, 并跟 CRON_REGISTRY 对账漂移项。
   *   - nextRunAt: 优先用 node-cron@4 的 getNextRun() (runtime 字段, 类型 def 没有);
   *     缺失就降级为空字符串, 不抛错。
   *   - 漂移项: DB 里 type 不在 CRON_REGISTRY 的, 单独打 warn (UNREGISTERED), 因为
   *     这意味着代码 / 文档没登记但 DB 在跑, 是配置漂移。
   * 失败不阻塞 boot — 仅 warn。
   */
  private dumpActiveTaskSchedule(allTasks: ScheduledTask[]): void {
    try {
      const tz = 'Asia/Shanghai';
      const activeIds = new Set(this.activeTasks.keys());
      const sorted = [...allTasks].sort(
        (a, b) => (a.type || '').localeCompare(b.type || '') || a.id - b.id
      );
      for (const task of sorted) {
        const scheduled = activeIds.has(task.id);
        const cronJob = this.activeTasks.get(task.id) as any;
        let nextRunStr = '';
        // AR-2 (2026-06-21): node-cron@4.2.1 的 getNextRun() 对 DoW-only cron
        // (e.g. "0 10 * * 0" 周日 / "0 9 * * 2" 周二) 返 2027~2034 错误年份
        // (matcher-walker.matchNext bug). 优先用 cron-parser 算下次触发,
        // 仅在 cron-parser 失败时回退到 node-cron 的 getNextRun(). 实际 cron
        // 触发由 runner.js heartBeat (cap 86400000ms) 决定, 不受 getNextRun 影响.
        try {
          const parsed = computeNextRunAt(task.cron_expression, { timezone: tz });
          if (parsed) {
            nextRunStr = moment(parsed).tz(tz).format('YYYY-MM-DD HH:mm:ss z');
          } else {
            const next = cronJob?.getNextRun?.();
            if (next instanceof Date && !Number.isNaN(next.getTime()) && !isImplausibleNextRun(next)) {
              nextRunStr = moment(next).tz(tz).format('YYYY-MM-DD HH:mm:ss z');
            }
          }
        } catch {
          /* 全失败降级为空, 不打断 dump */
        }
        const registered = isRegisteredCronType(task.type);
        const prefix = scheduled ? '[scheduler] cron task' : '[scheduler] cron task NOT_SCHEDULED';
        logger.info(
          `${prefix} id=${task.id} type=${task.type} name="${task.name}" cron="${
            task.cron_expression
          }" nextRunAt=${nextRunStr || 'n/a'} registered=${registered}`
        );
      }
      const unregistered = findUnregisteredTypes(allTasks.map(t => t.type));
      if (unregistered.length > 0) {
        logger.warn(
          `[scheduler] cron registry drift: ${unregistered.length} DB type(s) NOT in CRON_REGISTRY ` +
            `→ ${unregistered.join(', ')} (请加到 src/constants/cronRegistry.ts)`
        );
      }
      // 反向: registry 有但 DB 没启用 → 升级为 warn (Macro 串联补丁 2026-06-21).
      // Batch AJ 把 14 个漏 seed 的 cron 全部补齐后, 这个 list 应稳定为 0; 若有
      // 漂移意味着新加了 cron 但漏 seed 到 ensureDefaultTasks (会导致 fresh DB
      // 启动后这些 cron 不会运行) — ops 必须看到 warn 立即补 seed.
      // 允许 ops 通过 SCHEDULER_REGISTRY_DRIFT_ALLOW_MISSING env (CSV) 显式豁免
      // "故意不在本环境 seed" 的 type (e.g. 灰度中的 cron / dev-only).
      const dbTypes = new Set(allTasks.map(t => t.type));
      const driftAllowEnv = String(process.env.SCHEDULER_REGISTRY_DRIFT_ALLOW_MISSING || '');
      const driftAllowList = new Set(
        driftAllowEnv
          .split(',')
          .map(s => s.trim())
          .filter(s => s.length > 0)
      );
      const missingInDb = CRON_REGISTRY.map(d => d.type)
        .filter(t => !dbTypes.has(t) && !driftAllowList.has(t))
        .sort();
      if (missingInDb.length > 0) {
        logger.warn(
          `[scheduler] cron registry reverse drift: ${missingInDb.length} registered type(s) without DB row ` +
            `(请到 SchedulerService.ensureDefaultTasks 加 seed, 或 export ` +
            `SCHEDULER_REGISTRY_DRIFT_ALLOW_MISSING='${missingInDb.join(
              ','
            )}' 显式豁免): ${missingInDb.join(', ')}`
        );
      }
    } catch (err: any) {
      logger.warn(`[scheduler] dumpActiveTaskSchedule failed (non-fatal): ${err?.message || err}`);
    }
  }

  private getChinaDate(): string {
    return moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
  }

  private getDateDaysAgo(days: number): string {
    return moment().tz('Asia/Shanghai').subtract(days, 'days').format('YYYY-MM-DD');
  }

  private toPositiveInt(value: any, fallback: number, max?: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    const normalized = Math.floor(parsed);
    return max ? Math.min(normalized, max) : normalized;
  }

  /**
   * BJ-5/BJ-6 (2026-06-23): async script runner 替代 spawnSync.
   *
   * 真因: spawnSync 阻塞 node event loop → 长 cron (10min-5h) 让整个 backend
   * HTTP 失响应. 实际事件: SHAREHOLDER_COUNT_SYNC 02:00 触发后 backend /health
   * timeout 4h, 用户登录/看模拟盘全部 timeout.
   *
   * 用法: const r = await this.runScriptAsync('/usr/bin/node', [scriptPath, ...args], { cwd, timeoutMs });
   *       if (r.code === 0) ... else logger.warn(r.stderr);
   *
   * 返回: { code: number | null, stdout: string, stderr: string }
   *   - code === 0  → 成功
   *   - code === -1 → timeout 或 error 事件
   *   - stdout/stderr → 累积 (tail 16KB 防 OOM)
   */
  private async runScriptAsync(
    cmd: string,
    args: string[],
    opts: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv }
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { spawn } = require('child_process');
    return new Promise(resolve => {
      const child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env || { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d: Buffer) => {
        stdout += d.toString();
        if (stdout.length > 16 * 1024) stdout = stdout.slice(-16 * 1024); // 16KB tail
      });
      child.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString();
        if (stderr.length > 16 * 1024) stderr = stderr.slice(-16 * 1024);
      });
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        resolve({
          code: -1,
          stdout,
          stderr: stderr + `\n[runScriptAsync] killed by timeout ${opts.timeoutMs}ms`,
        });
      }, opts.timeoutMs);
      child.on('exit', (code: number | null) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
      child.on('error', (err: Error) => {
        clearTimeout(timer);
        resolve({ code: -1, stdout, stderr: stderr + '\n' + err.message });
      });
    });
  }

  private getParameterValue(parameters: any, snakeKey: string, camelKey?: string) {
    if (parameters?.[snakeKey] !== undefined) return parameters[snakeKey];
    if (camelKey && parameters?.[camelKey] !== undefined) return parameters[camelKey];
    return undefined;
  }

  private resolvePortfolioParams(parameters: any) {
    return {
      portfolio_name:
        parameters.portfolio_name ||
        parameters.portfolioName ||
        (parameters.use_autonomous_portfolio || parameters.useAutonomousPortfolio
          ? AUTONOMOUS_PORTFOLIO_NAME
          : undefined),
      initial_capital:
        parameters.initial_capital !== undefined
          ? Number(parameters.initial_capital)
          : parameters.initialCapital !== undefined
          ? Number(parameters.initialCapital)
          : parameters.use_autonomous_portfolio || parameters.useAutonomousPortfolio
          ? DEFAULT_AUTONOMOUS_INITIAL_CAPITAL
          : undefined,
      force_new_portfolio:
        parameters.force_new_portfolio !== undefined
          ? Boolean(parameters.force_new_portfolio)
          : parameters.forceNewPortfolio !== undefined
          ? Boolean(parameters.forceNewPortfolio)
          : false,
    };
  }

  private patchMissingParameters(
    existingParameters: Record<string, any> | null | undefined,
    defaultParameters: Record<string, any> | null | undefined,
    keys: string[]
  ): Record<string, any> | null {
    const params = existingParameters || {};
    const defaults = defaultParameters || {};
    const nextParams = { ...params };

    for (const key of keys) {
      if (nextParams[key] === undefined && defaults[key] !== undefined) {
        nextParams[key] = defaults[key];
      }
    }

    return JSON.stringify(nextParams) !== JSON.stringify(params) ? nextParams : null;
  }

  private patchAutonomousPortfolioParameters(task: ScheduledTask, taskData: any) {
    const autonomousTaskNames = new Set([
      '全市场荐股闭环',
      '推荐信号模拟盘跟单',
      'Agent尾盘建议模拟盘跟单',
      '模拟盘风控退出检查',
      '模拟盘收益归因报告',
      '推荐交易收益闭环刷新',
      '模拟盘交易计划报告',
    ]);
    if (!autonomousTaskNames.has(taskData.name)) return null;

    return this.patchMissingParameters(task.parameters, taskData.parameters, [
      'username',
      'use_autonomous_portfolio',
      'portfolio_name',
      'initial_capital',
    ]);
  }

  private async markTaskFinished(
    task: ScheduledTask,
    status: TaskRunStatus,
    executionLog?: TaskExecutionLogLike,
    error?: any
  ) {
    const error_message = error?.message || (error ? String(error) : undefined);
    // Batch T (2026-06-17, C-S4): 连续失败 kill-switch.
    // SUCCESS → consecutive_failure_count = 0
    // FAILED → +1, ≥ FAILURE_KILL_THRESHOLD (5) 自动 is_active=false + 报警.
    // 防告警淹没 + 防 task 一直 fail 仍 retry 浪费资源.
    const FAILURE_KILL_THRESHOLD = Number(process.env.SCHEDULER_FAILURE_KILL_THRESHOLD || 5);
    const updates: any = { last_run_status: status };
    if (status === 'SUCCESS') {
      if ((task.consecutive_failure_count || 0) > 0) {
        updates.consecutive_failure_count = 0;
      }
    } else if (status === 'FAILED') {
      const newCount = (task.consecutive_failure_count || 0) + 1;
      updates.consecutive_failure_count = newCount;
      if (newCount >= FAILURE_KILL_THRESHOLD && task.is_active) {
        updates.is_active = false;
        logger.error(
          `[scheduler] task ${task.id} (${task.name}) 连续失败 ${newCount} 次 ≥ ${FAILURE_KILL_THRESHOLD}, 自动 is_active=false. 修复后运维需手动重置 consecutive_failure_count=0 + is_active=true.`
        );
        // 写 RiskAlert HIGH 让运维 dashboard 第一时间看到
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { RiskAlert } = require('../models/RiskAlert');
          await RiskAlert.create({
            user_id: 1, // task 是系统级, 挂 admin 看; 后续如要按 owner 分发再扩
            level: 'HIGH',
            symbol: `SYSTEM:SCHEDULER_TASK_KILLED`,
            name: `定时任务 ${task.name} 自动熔断`,
            message:
              `定时任务 "${task.name}" (type=${task.type}, id=${task.id}) 连续失败 ` +
              `${newCount} 次, 已自动停用. 最近一次失败原因: ${error_message || '未知'}. ` +
              `运维修复后需 UPDATE scheduled_tasks SET consecutive_failure_count=0, is_active=true ` +
              `WHERE id=${task.id} 并重启 scheduler.`,
            rule_id: 'scheduler_task_killed',
            is_read: false,
          });
        } catch (alertErr: any) {
          logger.warn(
            `[scheduler] 写 kill alert 失败 (吞错继续): ${alertErr?.message || alertErr}`
          );
        }
        // 立即 stop in-memory cron 防下一次 tick 又跑
        try {
          const old = this.activeTasks.get(task.id);
          old?.stop();
          (old as any)?.destroy?.();
          this.activeTasks.delete(task.id);
        } catch (stopErr: any) {
          logger.warn(`[scheduler] stop killed task ${task.id} 失败: ${stopErr?.message}`);
        }
      }
    }
    await task.update(updates);

    if (!executionLog) return;

    const patch: any = {
      status: status === 'SUCCESS' ? 'COMPLETED' : status === 'FAILED' ? 'FAILED' : 'IN_PROGRESS',
    };

    if (status !== 'RUNNING') {
      patch.completed_at = new Date();
    }
    if (error_message) {
      patch.error_message = error_message;
    }

    await executionLog.update(patch);

    const parameters = task.parameters || {};
    const shouldReportToFeishu =
      parameters.report_to_feishu !== false && parameters.reportToFeishu !== false;
    if (status !== 'RUNNING' && shouldReportToFeishu) {
      await feishuTaskReportService.reportTaskExecutionLog(executionLog, {
        record_type: status === 'FAILED' ? '定时任务失败' : '定时任务完成',
        error,
      });
    }

    // Batch BF-2 (2026-06-23): cron 失败推 Lark + admin email — fire-and-forget,
    // 1h dedup (同 task.type 1h 内最多 1 次). 用户原话 "凌晨出问题没人知道",
    // 之前 markTaskFinished FAILED 只 logger.warn (error.log 沉默淹没); 现在系统级
    // admin 路径 (env FEISHU_RECOMMENDATION_BOT_WEBHOOK / ADMIN_ALERT_EMAILS) 推一条.
    // 不推 SUCCESS (太多噪声 — 每日数千次 success). 不推 RUNNING (中间态).
    if (status === 'FAILED') {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const sysMod = require('./SystemAdminAlertPusher');
        const stackPreview = errorStackPreview(error, 5);
        sysMod.pushSystemAdminAlertFireAndForget({
          dedup_key: `cron:${task.type}`,
          // cron 一直失败超过 FAILURE_KILL_THRESHOLD 已经写 RiskAlert HIGH (走 BF-1
          // 推 admin), 这里日常失败用 WARN 区分 (避免 OPS 群被 5 次连败前的每次失败刷屏).
          level: 'WARN',
          title: `[CRON FAIL] ${task.name} (${task.type})`,
          body_markdown:
            `**task_id**: ${task.id}\n` +
            `**task.type**: ${task.type}\n` +
            `**task.name**: ${task.name}\n` +
            `**连续失败次数**: ${(task.consecutive_failure_count || 0) + 1}\n` +
            `**失败时间**: ${new Date().toISOString()}\n` +
            `**错误**:\n\`\`\`\n${error_message || '未知错误'}\n\`\`\`\n` +
            (stackPreview ? `\n**Stack (前 5 行)**:\n\`\`\`\n${stackPreview}\n\`\`\`` : ''),
          triggered_at: new Date().toISOString(),
          trace_id: executionLog?.id ? `task_execution_log_id=${executionLog.id}` : undefined,
        });
      } catch (sysErr: any) {
        logger.warn(
          `[scheduler] markTaskFinished cron-failed pusher 异常 (吞错): ${
            sysErr?.message || sysErr
          }`
        );
      }
    }
  }

  private async safeUpdateExecutionLog(
    executionLog: TaskExecutionLogLike,
    patch: Record<string, any>
  ) {
    if (!executionLog) return;
    try {
      await executionLog.update(patch);
    } catch (error: any) {
      logger.warn(`更新定时任务执行日志失败，已降级继续执行: ${error.message}`);
    }
  }

  private async createExecutionLog(
    task: ScheduledTask,
    timestamp: Date,
    isManual: boolean
  ): Promise<TaskExecutionLogLike> {
    try {
      return await TaskExecutionLog.create({
        task_id: task.id,
        task_name: task.name + (isManual ? ' (手动执行)' : ''),
        status: 'IN_PROGRESS',
        started_at: timestamp,
      });
    } catch (error: any) {
      logger.error(`创建定时任务执行日志失败，任务仍将继续执行: ${task.id} (${task.name})`, error);
      return null;
    }
  }

  private async enqueueDataUpdateJob(
    task: ScheduledTask,
    executionLog: TaskExecutionLogLike,
    queueName: 'daily_update' | 'new_stocks_sync' | 'bulk_sync_custom' | 'data_quality_scan',
    data: any,
    jobPrefix: string,
    isManual: boolean
  ) {
    const job = await dataUpdateQueue.add(queueName, data, {
      jobId: `${jobPrefix}-${isManual ? 'manual-' : ''}task-${task.id}${
        executionLog?.id ? `-log-${executionLog.id}` : '-no-log'
      }-${Date.now()}`,
    });

    await this.safeUpdateExecutionLog(executionLog, {
      status: 'IN_PROGRESS',
      total_items: 1,
      completed_items: 0,
      failed_items: 0,
      error_message: null,
    });

    logger.info(`定时任务 ${task.id} (${task.name}) 已投递到 data-update 队列`, {
      queueName,
      jobId: job.id,
      data,
    });

    return job;
  }

  private async _executeTaskLogic(task: ScheduledTask, isManual = false) {
    const timestamp = new Date();
    // US-004 [OPS-004]: 记录 wall-clock 起点, 出口处 recordSchedulerTaskRun 落
    // scheduler_task_runs_total + scheduler_task_duration_seconds.
    const _metricStart = Date.now();
    await task.update({ last_run_at: timestamp, last_run_status: 'RUNNING' });

    const executionLog = await this.createExecutionLog(task, timestamp, isManual);

    try {
      const parameters = task.parameters || {};
      const portfolioParams = this.resolvePortfolioParams(parameters);
      const today = this.getChinaDate();

      // 节假日感知 — 工作日 cron 触发但今天是节假日 → 跳过
      // (CLEANUP_OLD_DATA / WEEKLY_REVIEW_EMAIL / 等周末 / 跨日 cron 不受影响, 它们的 cron 表达式本身就允许周末)
      // (isManual=true 用户手动触发时不跳过, 允许补跑)
      const requireTradingDay = (parameters as any).require_trading_day !== false;
      if (!isManual && requireTradingDay) {
        const { isAShareTradeDay, explainNonTradeDay } = require('../utils/tradingCalendar');
        // Batch O (2026-06-17, C-S7 fix): isWeekdayCron 正则扩展支持等价写法.
        // 旧只匹配 `* * 1-5$` 字面, ops 改成 `* * 1,2,3,4,5` / `* * MON-FRI` / `0,15,30,45 9-15 * * 1-5`
        // 都会绕过节假日 guard 在春节继续跑空请求. 新逻辑:
        // (a) 默认仍判 DoW 字段含 1-5 / MON-FRI / 1,2,3,4,5 / 工作日列表;
        // (b) parameters.require_trading_day=true (显式开启) → 强制走节假日 guard, 不依赖 cron pattern;
        // (c) parameters.require_trading_day=false → 不查 (周末/跨日 cron).
        const cronExpr = task.cron_expression || '';
        const dowField = cronExpr.trim().split(/\s+/)[4] || '*';
        const looksLikeWeekday =
          /1-5/.test(dowField) ||
          /MON-FRI/i.test(dowField) ||
          /^1,2,3,4,5$/.test(dowField) ||
          /\b1,2,3,4,5\b/.test(dowField);
        const explicitlyRequired = (parameters as any).require_trading_day === true;
        const isWeekdayCron = looksLikeWeekday || explicitlyRequired;
        if (isWeekdayCron && !isAShareTradeDay(timestamp)) {
          const reason = explainNonTradeDay(timestamp) || 'A 股节假日';
          logger.info(
            `[trading-calendar] task=${task.name} type=${task.type} 跳过 — 今天是 ${reason}`
          );
          await this.safeUpdateExecutionLog(executionLog, {
            success_count: 0,
            failed_count: 0,
            total_items: 0,
            result_summary: { skipped: true, reason: reason, scenario: 'non_trading_day' },
          });
          await this.markTaskFinished(task, 'SUCCESS');
          // US-004 [OPS-004]: 节假日跳过出口 — 走 status=skipped, 不算 success.
          recordSchedulerTaskRun(
            String(task.type || 'unknown'),
            'skipped',
            (Date.now() - _metricStart) / 1000
          );
          return { success: true, message: `skipped: ${reason}` };
        }
      }

      if (task.type === 'DAILY_UPDATE') {
        await this.enqueueDataUpdateJob(
          task,
          executionLog,
          'daily_update',
          {
            type: 'daily_update',
            date: today,
            forceUpdate: Boolean(parameters.force_update || parameters.forceUpdate || isManual),
            // PR-N (2026-06-29): default 300 → 2000, cap 2000 → 6000 — 全 A 股
            // 5500 票一次覆盖. 老 cap 让 sh.688 / sz.001 / sz.301 板块新股
            // 永远轮不到 sync, 是 PR-J 11/11 存储模块 0 推荐的数据层根因.
            max_stocks: this.toPositiveInt(
              parameters.max_stocks || parameters.maxStocks,
              2000,
              6000
            ),
            execution_log_id: executionLog?.id,
            scheduled_task_id: task.id,
          },
          'dailyUpdate',
          isManual
        );
      } else if (task.type === 'SYNC_ALL_STOCKS') {
        await this.enqueueDataUpdateJob(
          task,
          executionLog,
          'new_stocks_sync',
          {
            type: 'new_stocks_sync',
            date: today,
            execution_log_id: executionLog?.id,
            scheduled_task_id: task.id,
          },
          'syncAllStocks',
          isManual
        );
      } else if (task.type === 'SYNC_HISTORY') {
        const symbols = Array.isArray(parameters.symbols) ? parameters.symbols : undefined;
        const marketFilters = Array.isArray(parameters.marketFilters)
          ? parameters.marketFilters
          : Array.isArray(parameters.market_filters)
          ? parameters.market_filters
          : undefined;
        const syncAllStocks =
          parameters.syncAllStocks !== undefined
            ? Boolean(parameters.syncAllStocks)
            : parameters.sync_all_stocks !== undefined
            ? Boolean(parameters.sync_all_stocks)
            : !symbols?.length && !marketFilters?.length;

        await this.enqueueDataUpdateJob(
          task,
          executionLog,
          'bulk_sync_custom',
          {
            type: 'bulk_sync_custom',
            date: today,
            symbols,
            marketFilters,
            syncAllStocks,
            start_date:
              parameters.start_date ||
              parameters.startDate ||
              this.getDateDaysAgo(this.toPositiveInt(parameters.lookback_days, 10, 3650)),
            end_date: parameters.end_date || parameters.endDate || today,
            dataSource: parameters.dataSource || parameters.data_source || 'auto',
            concurrency: this.toPositiveInt(parameters.concurrency, 2, 10),
            batch_limit: this.toPositiveInt(
              this.getParameterValue(parameters, 'batch_limit', 'batchLimit'),
              200,
              6000
            ),
            lag_days_threshold: this.toPositiveInt(
              this.getParameterValue(parameters, 'lag_days_threshold', 'lagDaysThreshold'),
              0,
              3650
            ),
            stale_first:
              this.getParameterValue(parameters, 'stale_first', 'staleFirst') !== undefined
                ? Boolean(this.getParameterValue(parameters, 'stale_first', 'staleFirst'))
                : true,
            include_no_data:
              this.getParameterValue(parameters, 'include_no_data', 'includeNoData') !== undefined
                ? Boolean(this.getParameterValue(parameters, 'include_no_data', 'includeNoData'))
                : undefined,
            execution_log_id: executionLog?.id,
            scheduled_task_id: task.id,
          },
          'syncHistory',
          isManual
        );
      } else if (task.type === 'DATA_QUALITY_SCAN') {
        await this.enqueueDataUpdateJob(
          task,
          executionLog,
          'data_quality_scan',
          {
            type: 'data_quality_scan',
            date: today,
            scope: parameters.scope || 'market',
            lookback_days: this.toPositiveInt(parameters.lookback_days, 180, 3650),
            limit: this.toPositiveInt(parameters.limit, 200, 2000),
            execution_log_id: executionLog?.id,
            scheduled_task_id: task.id,
          },
          'dataQualityScan',
          isManual
        );
      } else if (task.type === 'REALTIME_QUOTE_SYNC') {
        const rawSymbols = Array.isArray(parameters.symbols)
          ? parameters.symbols
          : Array.isArray(parameters.stock_symbols)
          ? parameters.stock_symbols
          : undefined;
        // CE-A (2026-06-25): 新 universe_source='intraday' 分支 — 拿 IntradayUniverseService
        // 解析 ≤500 票活跃 universe 替代全市场 5500. 老 universe='market' / limit=5000
        // 路径完全保留, 见下面 else 分支. 触发器: cron parameters.universe_source='intraday'.
        const universeSource = String(parameters.universe_source || '').toLowerCase();
        const source = parameters.source || parameters.data_source || 'auto';
        let targetSymbols: string[];
        let universe: string;
        let batchSize: number;
        if (rawSymbols?.length) {
          // 手工指定 symbols — 优先级最高, 跳过 universe 解析.
          targetSymbols = rawSymbols
            .map((symbol: any) => String(symbol || '').trim())
            .filter(Boolean);
          universe = 'manual';
          batchSize = this.toPositiveInt(
            parameters.batch_size || parameters.batchSize,
            300,
            500
          );
        } else if (universeSource === 'intraday') {
          // CE-A 新路径: intraday universe (持仓 + 涨跌幅榜 + 涨停 + 成交额)
          const minSize = this.toPositiveInt(parameters.min_size, 200, 1000);
          const maxSize = this.toPositiveInt(
            parameters.limit || parameters.max_size,
            500,
            1000
          );
          batchSize = this.toPositiveInt(
            parameters.batch_size || parameters.batchSize,
            100,
            500
          );
          try {
            targetSymbols = await intradayUniverseService.resolveUniverse({
              min_size: minSize,
              max_size: maxSize,
            });
          } catch (err: any) {
            logger.warn(
              `[realtime-quote-sync] intraday universe 解析失败, fallback empty: ${
                err?.message || err
              }`
            );
            targetSymbols = [];
          }
          universe = 'intraday';
          logger.info(
            `[realtime-quote-sync] universe_source=intraday resolved ${targetSymbols.length} symbols (min=${minSize}, max=${maxSize})`
          );
        } else {
          // 老路径: universe='market'|'favorites', limit 默认 5000 全 A 股扫.
          const limit = this.toPositiveInt(
            parameters.limit || parameters.quote_sync_limit || parameters.max_stocks,
            5000,
            5000
          );
          universe = parameters.universe === 'favorites' ? 'favorites' : 'market';
          batchSize = this.toPositiveInt(
            parameters.batch_size || parameters.batchSize,
            300,
            500
          );
          const stocks = await quantDataService.getStocks({
            universe: universe as 'market' | 'favorites',
            user_id: parameters.user_id,
            limit,
          });
          targetSymbols = stocks.map(stock => stock.symbol);
        }

        // 2026-06-21 数据 sync 修复: 默认 universe 始终覆盖 当前持仓 + 全部用户的
        // FavoriteStock + 6 只目标 / 候选票, 确保 AI 引擎下游不会因为单股缺行情失败.
        // parameters.skip_extra_universe=true 时跳过 (例如 ops 手工只刷指定标的).
        // CE-A (2026-06-25): universe_source='intraday' 时同样跳过 — 内部已覆盖
        // 持仓 + 自选 + 涨跌幅榜 + 涨停 + 成交额, 不重复 enrich (避免破坏 max=500 约束).
        if (
          !rawSymbols?.length &&
          parameters.skip_extra_universe !== true &&
          universeSource !== 'intraday'
        ) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { PaperTradingPosition } = require('../models/PaperTradingPosition');
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { FavoriteStock } = require('../models/FavoriteStock');
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { Stock } = require('../models/Stock');
            const extra = new Set<string>(targetSymbols);
            const positions = await PaperTradingPosition.findAll({
              attributes: ['symbol'],
              group: ['symbol'],
              raw: true,
            }).catch(() => []);
            for (const r of positions as any[]) {
              if (r.symbol) extra.add(String(r.symbol));
            }
            // FavoriteStock has stock_id (not stock_code) — JOIN Stock to resolve.
            const favs = await FavoriteStock.findAll({
              attributes: ['stock_id'],
              raw: true,
            }).catch(() => []);
            const favIds = Array.from(
              new Set((favs as any[]).map(r => Number(r.stock_id)).filter(Boolean))
            );
            if (favIds.length) {
              // eslint-disable-next-line @typescript-eslint/no-var-requires
              const { Op } = require('sequelize');
              const favStocks = await Stock.findAll({
                where: { id: { [Op.in]: favIds } },
                attributes: ['symbol'],
                raw: true,
              }).catch(() => []);
              for (const r of favStocks as any[]) {
                if (r.symbol) extra.add(String(r.symbol));
              }
            }
            // Guarantee the 6 audit targets are always pulled
            const targetDigits = ['688008', '300054', '600667', '300476', '002916', '301377'];
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { Op } = require('sequelize');
            const tStocks = await Stock.findAll({
              where: {
                [Op.or]: targetDigits.map(d => ({ symbol: { [Op.like]: `%${d}` } })),
              },
              attributes: ['symbol'],
              raw: true,
            }).catch(() => []);
            for (const r of tStocks as any[]) {
              if (r.symbol) extra.add(String(r.symbol));
            }
            targetSymbols = Array.from(extra);
          } catch (e) {
            logger.warn(`[realtime-quote-sync] extra universe enrich failed: ${(e as Error).message}`);
          }
        }

        const result = await realtimeQuoteService.syncQuotesForSymbols(targetSymbols, {
          source,
          batch_size: batchSize,
        });
        const persistence = await realtimeQuoteService.getPersistenceSummary().catch(error => ({
          persisted: false,
          freshness_status: 'unknown',
          error: error?.message || String(error),
        }));
        const failedCount = Math.max(
          0,
          Number(result.requested_count || 0) - Number(result.persisted_count || 0)
        );
        const allFailed =
          Number(result.requested_count || 0) > 0 && Number(result.persisted_count || 0) === 0;
        const resultSummary = buildRealtimeQuoteSyncLogSummary(result, persistence, {
          source,
          universe,
        });

        await this.safeUpdateExecutionLog(executionLog, {
          total_items: result.requested_count,
          completed_items: result.persisted_count,
          failed_items: failedCount,
          status: allFailed ? 'FAILED' : 'COMPLETED',
          completed_at: new Date(),
          error_message: allFailed ? resultSummary.message : null,
          result_summary: resultSummary,
        });

        if (allFailed) {
          throw new Error(resultSummary.message);
        }

        logger.info(
          `实时行情快照刷新完成。请求 ${result.requested_count}，落盘 ${
            result.persisted_count
          }，更新股票 ${result.updated_stock_count}，最新 ${result.latest_quote_time || '-'}`
        );
      } else if (task.type === 'QUANT_PARAM_MAINTENANCE') {
        const tradeDate = parameters.trade_date || parameters.tradeDate || today;
        const lookbackDays = this.toPositiveInt(
          parameters.lookback_days || parameters.lookbackDays,
          14,
          365
        );
        const signalStartDate =
          parameters.start_date ||
          parameters.startDate ||
          moment(tradeDate).subtract(lookbackDays, 'days').format('YYYY-MM-DD');
        const signalEndDate = parameters.end_date || parameters.endDate || tradeDate;
        const rawSignals = Array.isArray(parameters.signal)
          ? parameters.signal
          : Array.isArray(parameters.signals)
          ? parameters.signals
          : ['buy', 'watch'];
        const strategyKeys = Array.isArray(parameters.strategy_keys)
          ? parameters.strategy_keys
          : Array.isArray(parameters.strategyKeys)
          ? parameters.strategyKeys
          : undefined;
        const horizons = Array.isArray(parameters.horizons)
          ? parameters.horizons.map((item: any) => this.toPositiveInt(item, 1, 60)).filter(Boolean)
          : [1, 3, 5, 10];
        const create = await quantStrategyParamVersionService.createPendingValidationsFromSignals({
          start_date: signalStartDate,
          end_date: signalEndDate,
          strategy_keys: strategyKeys,
          horizons,
          limit: this.toPositiveInt(parameters.limit, 1000, 10000),
          signal: rawSignals.map((item: any) => String(item || '').trim()).filter(Boolean),
        });
        const refresh = await quantStrategyParamVersionService.refreshValidationReturns({
          limit: this.toPositiveInt(
            parameters.refresh_limit || parameters.refreshLimit,
            3000,
            20000
          ),
          include_completed:
            parameters.include_completed !== undefined
              ? Boolean(parameters.include_completed)
              : parameters.includeCompleted !== undefined
              ? Boolean(parameters.includeCompleted)
              : false,
          auto_sync_benchmark:
            parameters.auto_sync_benchmark !== undefined
              ? Boolean(parameters.auto_sync_benchmark)
              : parameters.autoSyncBenchmark !== undefined
              ? Boolean(parameters.autoSyncBenchmark)
              : false,
        });
        const lifecycle = await quantStrategyParamVersionService.evaluateAndApplyLifecycle({
          dry_run:
            parameters.dry_run_lifecycle !== undefined
              ? Boolean(parameters.dry_run_lifecycle)
              : parameters.dryRunLifecycle !== undefined
              ? Boolean(parameters.dryRunLifecycle)
              : false,
          policy: parameters.lifecycle_policy || parameters.lifecyclePolicy,
          limit: this.toPositiveInt(
            parameters.lifecycle_limit || parameters.lifecycleLimit,
            5000,
            20000
          ),
        });
        const activeScanParams = await quantStrategyParamVersionService.getActiveParamsForScan({
          include_grid_search: true,
          include_experiment: true,
        });
        const result = {
          status: 'completed',
          generated_at: new Date().toISOString(),
          trade_date: tradeDate,
          signal_window: { start_date: signalStartDate, end_date: signalEndDate },
          horizons,
          create,
          refresh,
          lifecycle,
          active_scan_params: activeScanParams,
          message: lifecycle?.applied
            ? `参数后验维护完成，已应用 ${lifecycle.applied} 个推广/降级/回滚动作。`
            : `参数后验维护完成，新增 ${create.created} 条验证样本，完成 ${refresh.completed} 条收益刷新。`,
        };
        const resultSummary = buildQuantParamMaintenanceLogSummary(result);
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: Number(create.scanned || 0) + Number(refresh.refreshed || 0),
          completed_items:
            Number(create.created || 0) +
            Number(create.updated || 0) +
            Number(refresh.completed || 0),
          failed_items: Number(refresh.no_data || 0),
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
          result_summary: resultSummary,
        });

        if (parameters.report_to_feishu !== false && parameters.reportToFeishu !== false) {
          await feishuTaskReportService.reportTaskExecutionLog(executionLog, {
            record_type: parameters.record_type || parameters.recordType || '量化参数后验维护',
            task_type: 'QUANT_PARAM_MAINTENANCE',
            result: resultSummary,
          });
        }

        logger.info(
          `量化参数后验维护完成。新增 ${create.created}，更新 ${create.updated}，完成收益 ${refresh.completed}，生命周期应用 ${lifecycle.applied}`
        );
      } else if (task.type === 'QUANT_DAILY_PIPELINE') {
        await quantStrategyFeedbackService.refreshWeights({
          snapshot_date: today,
          lookback_days: this.toPositiveInt(
            parameters.strategy_weight_lookback_days || parameters.strategyWeightLookbackDays,
            365,
            3650
          ),
        });

        const result = await quantFusionService.runDailyPipeline({
          username: parameters.username || 'stock',
          trade_date: parameters.trade_date || parameters.tradeDate || today,
          target_date: parameters.target_date || parameters.targetDate || today,
          universe: parameters.universe === 'favorites' ? 'favorites' : 'market',
          symbols: Array.isArray(parameters.symbols) ? parameters.symbols : undefined,
          strategy_keys: Array.isArray(parameters.strategy_keys)
            ? parameters.strategy_keys
            : Array.isArray(parameters.strategyKeys)
            ? parameters.strategyKeys
            : undefined,
          lookback_days: this.toPositiveInt(
            parameters.lookback_days || parameters.lookbackDays,
            180,
            3650
          ),
          candidate_limit: this.toPositiveInt(
            parameters.candidate_limit || parameters.candidateLimit,
            180,
            1000
          ),
          refresh_realtime_quotes:
            parameters.refresh_realtime_quotes !== undefined
              ? Boolean(parameters.refresh_realtime_quotes)
              : parameters.refreshRealtimeQuotes !== undefined
              ? Boolean(parameters.refreshRealtimeQuotes)
              : true,
          sync_factors_before_scan:
            parameters.sync_factors_before_scan !== undefined
              ? Boolean(parameters.sync_factors_before_scan)
              : parameters.syncFactorsBeforeScan !== undefined
              ? Boolean(parameters.syncFactorsBeforeScan)
              : true,
          factor_sync_scope:
            parameters.factor_sync_scope || parameters.factorSyncScope || parameters.universe,
          factor_sync_limit: this.toPositiveInt(
            parameters.factor_sync_limit || parameters.factorSyncLimit,
            Math.max(Number(parameters.candidate_limit || parameters.candidateLimit || 220), 360),
            1500
          ),
          factor_provider: parameters.factor_provider || parameters.factorProvider || 'auto',
          factor_sync_skip_if_coverage_rate_gte: Number(
            parameters.factor_sync_skip_if_coverage_rate_gte ??
              parameters.factorSyncSkipIfCoverageRateGte ??
              92
          ),
          factor_sync_skip_if_real_provider_rate_gte: Number(
            parameters.factor_sync_skip_if_real_provider_rate_gte ??
              parameters.factorSyncSkipIfRealProviderRateGte ??
              65
          ),
          quote_sync_limit: this.toPositiveInt(
            parameters.quote_sync_limit || parameters.quoteSyncLimit,
            Math.max(Number(parameters.candidate_limit || parameters.candidateLimit || 220), 360),
            1000
          ),
          realtime_quote_source:
            parameters.realtime_quote_source || parameters.realtimeQuoteSource || 'auto',
          min_score: Number(parameters.min_score || parameters.minScore || 55),
          archive_limit: this.toPositiveInt(
            parameters.archive_limit || parameters.archiveLimit,
            30,
            200
          ),
          max_industry_candidates: this.toPositiveInt(
            parameters.max_industry_candidates || parameters.maxIndustryCandidates,
            4,
            20
          ),
          max_strategy_candidates: this.toPositiveInt(
            parameters.max_strategy_candidates || parameters.maxStrategyCandidates,
            8,
            30
          ),
          submit_agent_analysis:
            parameters.submit_agent_analysis !== undefined
              ? Boolean(parameters.submit_agent_analysis)
              : parameters.submitAgentAnalysis !== undefined
              ? Boolean(parameters.submitAgentAnalysis)
              : true,
          agent_max_count: this.toPositiveInt(
            parameters.agent_max_count || parameters.agentMaxCount,
            5,
            20
          ),
          agent_min_score: Number(parameters.agent_min_score || parameters.agentMinScore || 72),
          agent_paper_trade_min_score: Number(
            parameters.agent_paper_trade_min_score ||
              parameters.agentPaperTradeMinScore ||
              Math.min(Number(parameters.agent_min_score || parameters.agentMinScore || 72), 54)
          ),
          agent_session: parameters.agent_session || parameters.agentSession || 'close',
          agent_auto_paper_trade:
            parameters.agent_auto_paper_trade !== undefined
              ? Boolean(parameters.agent_auto_paper_trade)
              : parameters.agentAutoPaperTrade !== undefined
              ? Boolean(parameters.agentAutoPaperTrade)
              : true,
          run_paper_trading:
            parameters.run_paper_trading !== undefined
              ? Boolean(parameters.run_paper_trading)
              : parameters.runPaperTrading !== undefined
              ? Boolean(parameters.runPaperTrading)
              : true,
          dry_run:
            parameters.dry_run !== undefined
              ? Boolean(parameters.dry_run)
              : parameters.dryRun !== undefined
              ? Boolean(parameters.dryRun)
              : false,
          paper_trade_limit: this.toPositiveInt(
            parameters.paper_trade_limit || parameters.paperTradeLimit,
            3,
            20
          ),
          paper_trade_scan_limit: this.toPositiveInt(
            parameters.paper_trade_scan_limit || parameters.paperTradeScanLimit,
            80,
            300
          ),
          max_positions: this.toPositiveInt(
            parameters.max_positions || parameters.maxPositions,
            8,
            30
          ),
          default_position_pct: Number(
            parameters.default_position_pct || parameters.defaultPositionPct || 5
          ),
          max_position_pct: Number(parameters.max_position_pct || parameters.maxPositionPct || 10),
          min_trade_amount: Number(
            parameters.min_trade_amount || parameters.minTradeAmount || 3000
          ),
          use_entry_risk_guard:
            parameters.use_entry_risk_guard !== undefined
              ? Boolean(parameters.use_entry_risk_guard)
              : parameters.useEntryRiskGuard !== undefined
              ? Boolean(parameters.useEntryRiskGuard)
              : undefined,
          max_daily_new_positions:
            parameters.max_daily_new_positions ?? parameters.maxDailyNewPositions,
          max_daily_new_exposure_pct:
            parameters.max_daily_new_exposure_pct ?? parameters.maxDailyNewExposurePct,
          max_total_exposure_pct:
            parameters.max_total_exposure_pct ?? parameters.maxTotalExposurePct,
          max_industry_exposure_pct:
            parameters.max_industry_exposure_pct ?? parameters.maxIndustryExposurePct,
          min_cash_reserve_pct: parameters.min_cash_reserve_pct ?? parameters.minCashReservePct,
          max_portfolio_drawdown_pct:
            parameters.max_portfolio_drawdown_pct ?? parameters.maxPortfolioDrawdownPct,
          max_single_stock_volatility_pct:
            parameters.max_single_stock_volatility_pct ?? parameters.maxSingleStockVolatilityPct,
          max_position_correlation:
            parameters.max_position_correlation ?? parameters.maxPositionCorrelation,
          max_portfolio_var_pct: parameters.max_portfolio_var_pct ?? parameters.maxPortfolioVarPct,
          min_avg_turnover_yuan: parameters.min_avg_turnover_yuan ?? parameters.minAvgTurnoverYuan,
          cooldown_days_after_loss:
            parameters.cooldown_days_after_loss ?? parameters.cooldownDaysAfterLoss,
          use_experiment_params:
            parameters.use_experiment_params !== undefined
              ? Boolean(parameters.use_experiment_params)
              : parameters.useExperimentParams !== undefined
              ? Boolean(parameters.useExperimentParams)
              : true,
          experiment_param_policy:
            parameters.experiment_param_policy || parameters.experimentParamPolicy,
          block_limit_up:
            parameters.block_limit_up !== undefined
              ? Boolean(parameters.block_limit_up)
              : parameters.blockLimitUp !== undefined
              ? Boolean(parameters.blockLimitUp)
              : undefined,
          block_limit_down:
            parameters.block_limit_down !== undefined
              ? Boolean(parameters.block_limit_down)
              : parameters.blockLimitDown !== undefined
              ? Boolean(parameters.blockLimitDown)
              : undefined,
          block_suspended:
            parameters.block_suspended !== undefined
              ? Boolean(parameters.block_suspended)
              : parameters.blockSuspended !== undefined
              ? Boolean(parameters.blockSuspended)
              : undefined,
          block_buy_on_runtime_risk:
            parameters.block_buy_on_runtime_risk !== undefined
              ? Boolean(parameters.block_buy_on_runtime_risk)
              : parameters.blockBuyOnRuntimeRisk !== undefined
              ? Boolean(parameters.blockBuyOnRuntimeRisk)
              : true,
          ...portfolioParams,
          task_label: task.name,
          execution_log_id: executionLog?.id,
          report_to_feishu:
            parameters.report_to_feishu !== undefined
              ? Boolean(parameters.report_to_feishu)
              : parameters.reportToFeishu !== undefined
              ? Boolean(parameters.reportToFeishu)
              : true,
          notify_to_feishu_bot:
            parameters.notify_to_feishu_bot !== undefined
              ? Boolean(parameters.notify_to_feishu_bot)
              : parameters.notifyToFeishuBot !== undefined
              ? Boolean(parameters.notifyToFeishuBot)
              : true,
          params_by_strategy: parameters.params_by_strategy || parameters.paramsByStrategy,
          // PR-H (2026-06-29) — 推荐时机标签. cron parameters.timing_tag 透传到 archive 写入
          // AIInvestmentSignal.metadata.timing_tag → 前端推荐卡 badge. 5 个值:
          // opening_rush(9:25早盘抢) / afternoon_kick(12:55午后攻) / closing_grab(14:30尾盘埋) /
          // overnight(15:30隔夜潜伏, 默认) / intraday_anomaly(盘中异动 detector 走另一路).
          // 未传 → 沿用默认 'overnight' (符合历史 cron 行为, 兼容已部署 row).
          timing_tag: parameters.timing_tag || parameters.timingTag,
        });

        const agentSubmitted = Array.isArray(result.agent_analysis?.submitted)
          ? result.agent_analysis.submitted.length
          : 0;
        const agentFailed = Array.isArray(result.agent_analysis?.failed)
          ? result.agent_analysis.failed.length
          : 0;
        const runtimeRiskBlocked = Boolean(result.runtime_risk_blocked);
        await this.safeUpdateExecutionLog(executionLog, {
          total_items:
            agentSubmitted > 0 ? agentSubmitted + agentFailed : result.archive?.total || 0,
          completed_items: agentSubmitted > 0 ? 0 : result.archive?.total || 0,
          failed_items: agentFailed,
          status: agentSubmitted > 0 ? 'IN_PROGRESS' : 'COMPLETED',
          completed_at: agentSubmitted > 0 ? null : new Date(),
          error_message: runtimeRiskBlocked
            ? result.runtime_health?.summary?.conclusion ||
              result.message ||
              '量化运行时存在风险项，本轮只归档观察信号，不执行模拟买入。'
            : null,
          result_summary: buildQuantDailyPipelineLogSummary(result, agentSubmitted, agentFailed),
        });

        if (parameters.report_to_feishu !== false && parameters.reportToFeishu !== false) {
          await feishuTaskReportService.reportQuantDailyPipeline(result, {
            record_type:
              parameters.record_type ||
              parameters.recordType ||
              (agentSubmitted > 0 ? `${task.name}已提交Agent复核` : `${task.name}完成`),
            task_type: 'QUANT_DAILY_PIPELINE',
          });
        }

        logger.info(
          `量化策略扫描闭环完成。归档 ${
            result.archive?.total || 0
          }，Agent提交 ${agentSubmitted}，模拟盘 ${
            result.paper_trading?.executed ?? result.paper_trading?.planned ?? 0
          }`
        );
      } else if (task.type === 'QUANT_OPEN_WATCHDOG') {
        const result = await quantOpenWatchdogService.check({
          trade_date: parameters.trade_date || parameters.tradeDate || today,
          target_task_name: parameters.target_task_name || parameters.targetTaskName,
          expected_after_time: parameters.expected_after_time || parameters.expectedAfterTime,
          latest_allowed_minutes: this.toPositiveInt(
            parameters.latest_allowed_minutes || parameters.latestAllowedMinutes,
            15,
            180
          ),
          min_quant_signals: this.toPositiveInt(
            parameters.min_quant_signals || parameters.minQuantSignals,
            1,
            1000
          ),
          min_archived_signals: this.toPositiveInt(
            parameters.min_archived_signals || parameters.minArchivedSignals,
            1,
            1000
          ),
          require_fresh_quote:
            parameters.require_fresh_quote !== undefined
              ? Boolean(parameters.require_fresh_quote)
              : parameters.requireFreshQuote !== undefined
              ? Boolean(parameters.requireFreshQuote)
              : true,
          freshness_max_minutes: this.toPositiveInt(
            parameters.freshness_max_minutes || parameters.freshnessMaxMinutes,
            60,
            24 * 60
          ),
        });
        const issueCount = Array.isArray(result.issues) ? result.issues.length : 0;
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: 6,
          completed_items: result.status === 'healthy' ? 6 : Math.max(0, 6 - issueCount),
          failed_items: result.status === 'critical' ? Math.max(issueCount, 1) : 0,
          status: result.status === 'critical' ? 'FAILED' : 'COMPLETED',
          completed_at: new Date(),
          error_message:
            result.status === 'critical'
              ? (result.issues || []).map((issue: any) => issue.message).join('；')
              : null,
        });

        if (parameters.report_to_feishu !== false && parameters.reportToFeishu !== false) {
          await feishuTaskReportService.reportQuantOpenWatchdog(result, {
            record_type: parameters.record_type || parameters.recordType || task.name,
            task_type: 'QUANT_OPEN_WATCHDOG',
          });
        }

        if (result.status === 'critical') {
          logger.error(`量化开盘链路看门狗发现关键异常: ${result.conclusion}`, {
            issues: result.issues,
          });
          throw new Error(result.conclusion || '量化开盘链路看门狗发现关键异常');
        } else {
          logger.info(`量化开盘链路看门狗完成: ${result.status} - ${result.conclusion}`);
        }
      } else if (task.type === 'BENCHMARK_INDEX_SYNC') {
        const lookbackDays = this.toPositiveInt(
          parameters.lookback_days || parameters.lookbackDays,
          180,
          3650
        );
        const startDate =
          parameters.start_date ||
          parameters.startDate ||
          moment(today).subtract(lookbackDays, 'days').format('YYYY-MM-DD');
        const endDate = parameters.end_date || parameters.endDate || today;
        const result = await benchmarkIndexService.syncBenchmarkIndices(startDate, endDate, {
          symbols: Array.isArray(parameters.symbols) ? parameters.symbols : undefined,
          data_source: parameters.data_source || parameters.dataSource || 'tencent_only',
          concurrency: this.toPositiveInt(parameters.concurrency, 2, 5),
        });
        const entries = Object.entries(result);
        const inserted = entries.reduce(
          (sum, [, count]) => (Number(count) > 0 ? sum + Number(count) : sum),
          0
        );
        const failed = entries.filter(([, count]) => Number(count) < 0).length;

        await this.safeUpdateExecutionLog(executionLog, {
          total_items: entries.length,
          completed_items: entries.length - failed,
          failed_items: failed,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: failed > 0 ? `${failed} 个基准指数同步失败，详见结果摘要` : null,
        });

        if (parameters.report_to_feishu !== false && parameters.reportToFeishu !== false) {
          await feishuTaskReportService.reportTaskExecutionLog(executionLog, {
            record_type: '基准指数行情同步',
            task_type: 'BENCHMARK_INDEX_SYNC',
            result: {
              sync_window: { start_date: startDate, end_date: endDate },
              data_source: parameters.data_source || parameters.dataSource || 'tencent_only',
              inserted_records: inserted,
              total: entries.length,
              failed,
              details: result,
            },
          });
        }

        logger.info(
          `基准指数行情同步完成。指数 ${entries.length}，失败 ${failed}，写入/尝试 ${inserted} 条`
        );
      } else if (task.type === 'LIVE_SHADOW_AUTOPILOT') {
        const username = parameters.username || 'stock';
        const user = await User.findOne({ where: { username } });
        if (!user) throw new Error(`未找到影子执行用户：${username}`);
        const userId = Number((user as any).id);
        const requireReadiness =
          parameters.require_opening_readiness !== undefined
            ? Boolean(parameters.require_opening_readiness)
            : parameters.requireOpeningReadiness !== undefined
            ? Boolean(parameters.requireOpeningReadiness)
            : true;
        const allowDegraded =
          parameters.allow_degraded_readiness !== undefined
            ? Boolean(parameters.allow_degraded_readiness)
            : parameters.allowDegradedReadiness !== undefined
            ? Boolean(parameters.allowDegradedReadiness)
            : true;
        const readiness = requireReadiness
          ? await openingReadinessService.getReadiness({
              user_id: userId,
              username,
              trade_date: parameters.trade_date || parameters.tradeDate || today,
              factor_limit: this.toPositiveInt(
                parameters.factor_limit || parameters.factorLimit,
                220,
                1000
              ),
              use_cache: parameters.use_cache !== false && parameters.useCache !== false,
              cache_ttl_ms: this.toPositiveInt(
                parameters.cache_ttl_ms || parameters.cacheTtlMs,
                90_000,
                5 * 60 * 1000
              ),
            })
          : null;
        const readinessBlocked =
          readiness &&
          (readiness.status === 'blocked' || (!allowDegraded && readiness.status !== 'ready'));
        let result: any;
        if (readinessBlocked) {
          result = {
            generated_at: new Date().toISOString(),
            mode: 'shadow_only',
            skipped: true,
            reason: readiness?.conclusion || '开盘就绪门禁未通过，本轮不生成新的影子成交样本。',
            readiness: readiness
              ? {
                  status: readiness.status,
                  status_label: readiness.status_label,
                  conclusion: readiness.conclusion,
                  buy_gate: readiness.buy_gate,
                }
              : null,
            summary: {
              selected_count: 0,
              shadow_executed_count: 0,
              blocked_count: 0,
              real_order_submitted: 0,
              conclusion:
                readiness?.conclusion || '开盘就绪门禁未通过，本轮不生成新的影子成交样本。',
            },
          };
        } else {
          result = await liveTradingService.runShadowAutopilot(userId, {
            limit: this.toPositiveInt(parameters.limit || parameters.shadow_limit, 2, 10),
            source: parameters.source || task.name || 'scheduled_live_shadow_autopilot',
            dry_run:
              parameters.dry_run !== undefined
                ? Boolean(parameters.dry_run)
                : parameters.dryRun !== undefined
                ? Boolean(parameters.dryRun)
                : false,
          });
          result.readiness = readiness
            ? {
                status: readiness.status,
                status_label: readiness.status_label,
                conclusion: readiness.conclusion,
                buy_gate: readiness.buy_gate,
              }
            : null;
        }
        const outcomes = await liveTradingService.getShadowAutopilotOutcomes(userId, {
          limit: this.toPositiveInt(parameters.outcome_limit || parameters.outcomeLimit, 30, 100),
          horizons: Array.isArray(parameters.horizons)
            ? parameters.horizons.map((item: any) => Number(item)).filter(Number.isFinite)
            : [1, 3, 5],
        });
        const resultSummary = buildLiveShadowAutopilotLogSummary(result, outcomes);
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: Number(result.summary?.selected_count || 0),
          completed_items: Number(result.summary?.shadow_executed_count || 0),
          failed_items: Number(result.summary?.blocked_count || 0),
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
          result_summary: resultSummary,
        });

        if (parameters.report_to_feishu !== false && parameters.reportToFeishu !== false) {
          await feishuTaskReportService.reportTaskExecutionLog(executionLog, {
            record_type: parameters.record_type || parameters.recordType || '无人影子执行收益闭环',
            task_type: 'LIVE_SHADOW_AUTOPILOT',
            result: resultSummary,
          });
        }

        logger.info(
          `无人影子执行定时任务完成。影子成交 ${
            result.summary?.shadow_executed_count || 0
          }，真实提交 ${result.summary?.real_order_submitted || 0}，闭环样本 ${
            outcomes.summary?.shadow_trade_count || 0
          }`
        );
      } else if (task.type === 'LIVE_SHADOW_WEEKLY_REVIEW') {
        const username = parameters.username || 'stock';
        const user = await User.findOne({ where: { username } });
        if (!user) throw new Error(`未找到影子执行用户：${username}`);
        const shadowTask = await ScheduledTask.findOne({
          where: { type: 'LIVE_SHADOW_AUTOPILOT', is_active: true },
          order: [['id', 'ASC']],
        });
        const outcomes = await liveTradingService.getShadowAutopilotOutcomes(
          Number((user as any).id),
          {
            limit: this.toPositiveInt(parameters.outcome_limit || parameters.outcomeLimit, 80, 200),
            horizons: Array.isArray(parameters.horizons)
              ? parameters.horizons.map((item: any) => Number(item)).filter(Number.isFinite)
              : [1, 3, 5],
          }
        );
        const resultSummary: any = buildLiveShadowWeeklyReviewLogSummary(outcomes);
        if (shadowTask && outcomes.summary?.budget_decision) {
          const beforeParameters = { ...((shadowTask as any).parameters || {}) };
          const recommendedLimit = this.toPositiveInt(
            outcomes.summary.budget_decision.recommended_limit,
            Number(beforeParameters.limit || 2),
            10
          );
          const suggestedParameters = {
            ...beforeParameters,
            limit: recommendedLimit,
            shadow_budget_advice: {
              generated_at: new Date().toISOString(),
              source_task_id: Number(task.id),
              action: outcomes.summary.budget_decision.action,
              label: outcomes.summary.budget_decision.label,
              reason: outcomes.summary.budget_decision.reason,
              current_limit: Number(beforeParameters.limit || 0),
              recommended_limit: recommendedLimit,
              applied: false,
              note: '仅记录候选补丁，不自动修改定时任务参数。',
            },
          };
          const changedKeys = taskParameterAuditService.buildChangedKeys(
            beforeParameters,
            suggestedParameters,
            ['limit', 'shadow_budget_advice']
          );
          if (changedKeys.length > 0) {
            await taskParameterAuditService.record({
              task: shadowTask,
              event_type: LIVE_AUDIT_EVENT_TYPES.SHADOW_BUDGET_SUGGESTION,
              before_parameters: beforeParameters,
              after_parameters: suggestedParameters,
              changed_keys: changedKeys,
              metadata: {
                source: 'live_shadow_weekly_review',
                review_task_id: Number(task.id),
                outcome_summary: resultSummary,
                auto_applied: false,
              },
            });
          }
          resultSummary.suggested_task_patch = {
            target_task_id: Number((shadowTask as any).id),
            target_task_name: (shadowTask as any).name,
            changed_keys: changedKeys,
            before_limit: beforeParameters.limit,
            suggested_limit: recommendedLimit,
            auto_applied: false,
          };
        }
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: Number(outcomes.summary?.shadow_trade_count || 0),
          completed_items: Number(outcomes.summary?.evaluated_count || 0),
          failed_items: 0,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
          result_summary: resultSummary,
        });

        if (parameters.report_to_feishu !== false && parameters.reportToFeishu !== false) {
          await feishuTaskReportService.reportTaskExecutionLog(executionLog, {
            record_type: parameters.record_type || parameters.recordType || '影子执行周度复盘',
            task_type: 'LIVE_SHADOW_WEEKLY_REVIEW',
            result: resultSummary,
          });
        }

        logger.info(
          `影子执行周度复盘完成。样本 ${outcomes.summary?.shadow_trade_count || 0}，已评估 ${
            outcomes.summary?.evaluated_count || 0
          }，建议 ${outcomes.summary?.budget_decision?.label || '-'}`
        );
      } else if (task.type === 'SIGNAL_PERFORMANCE_REFRESH') {
        const commonPerformanceParams = {
          source_type: parameters.source_type || parameters.sourceType,
          agent_session: parameters.agent_session || parameters.agentSession,
          task_label: parameters.task_label || parameters.taskLabel,
          symbol: parameters.symbol,
          decision: parameters.decision,
          start_date: parameters.start_date || parameters.startDate,
          end_date: parameters.end_date || parameters.endDate,
          horizon: parameters.horizon,
          record_type: parameters.record_type || parameters.recordType,
          limit: this.toPositiveInt(parameters.limit, 500, 5000),
        };
        let repairResult: any = null;
        if (parameters.auto_repair_missing_data || parameters.autoRepairMissingData) {
          repairResult = await aiInvestmentSignalService.repairAndVerifySignals({
            ...commonPerformanceParams,
            data_source: parameters.data_source || parameters.dataSource || 'tencent_only',
            lookback_days: this.toPositiveInt(parameters.lookback_days, 15, 3650),
            sync_concurrency: this.toPositiveInt(parameters.sync_concurrency, 2, 5),
          });
          if (parameters.report_repair_to_feishu !== false) {
            await feishuTaskReportService.reportSignalVerificationRepair(repairResult, {
              record_type: `${
                parameters.record_type || parameters.recordType || '推荐绩效'
              }数据修复`,
            });
          }
        }

        const result = await aiInvestmentSignalService.refreshPerformance({
          ...commonPerformanceParams,
          report_to_feishu:
            parameters.report_to_feishu !== undefined
              ? Boolean(parameters.report_to_feishu)
              : parameters.reportToFeishu !== undefined
              ? Boolean(parameters.reportToFeishu)
              : true,
        });
        (result as any).repair = repairResult;

        await this.safeUpdateExecutionLog(executionLog, {
          total_items: result.verification.total,
          completed_items: result.verification.verified,
          failed_items: Number(result.verification.no_data || 0),
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
        });

        logger.info(
          `推荐绩效刷新完成。扫描 ${result.verification.total}，已完成 ${result.verification.verified}，等待 ${result.verification.pending}，无数据 ${result.verification.no_data}`
        );
      } else if (task.type === 'SIGNAL_QUALITY_DAILY_REPORT') {
        const result = await aiInvestmentSignalService.getSignalQualityReport({
          source_type: parameters.source_type || parameters.sourceType,
          agent_session: parameters.agent_session || parameters.agentSession,
          task_label: parameters.task_label || parameters.taskLabel,
          symbol: parameters.symbol,
          decision: parameters.decision,
          start_date: parameters.start_date || parameters.startDate,
          end_date: parameters.end_date || parameters.endDate,
          horizon: parameters.horizon || '5d',
          lookback_days: this.toPositiveInt(parameters.lookback_days, 30, 3650),
          min_samples: this.toPositiveInt(parameters.min_samples, 5, 100),
          limit: this.toPositiveInt(parameters.limit, 5000, 10000),
          auto_repair_missing_data:
            parameters.auto_repair_missing_data !== undefined
              ? Boolean(parameters.auto_repair_missing_data)
              : parameters.autoRepairMissingData !== undefined
              ? Boolean(parameters.autoRepairMissingData)
              : true,
          data_source: parameters.data_source || parameters.dataSource || 'tencent_only',
          repair_lookback_days: this.toPositiveInt(
            parameters.repair_lookback_days || parameters.repairLookbackDays,
            this.toPositiveInt(parameters.lookback_days, 30, 3650),
            3650
          ),
          sync_concurrency: this.toPositiveInt(
            parameters.sync_concurrency || parameters.syncConcurrency,
            2,
            5
          ),
          verify_before_report:
            parameters.verify_before_report !== undefined
              ? Boolean(parameters.verify_before_report)
              : parameters.verifyBeforeReport !== undefined
              ? Boolean(parameters.verifyBeforeReport)
              : true,
          report_to_feishu:
            parameters.report_to_feishu !== undefined
              ? Boolean(parameters.report_to_feishu)
              : parameters.reportToFeishu !== undefined
              ? Boolean(parameters.reportToFeishu)
              : true,
          record_type: parameters.record_type || parameters.recordType || '信号质量日报',
        });

        await this.safeUpdateExecutionLog(executionLog, {
          total_items: result.overview.total_signals,
          completed_items: result.overview.completed_samples,
          failed_items: Number(result.overview.no_data_signals || 0),
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
        });

        logger.info(
          `信号质量日报完成。信号 ${result.overview.total_signals}，完成样本 ${result.overview.completed_samples}，质量分 ${result.overview.quality_score}`
        );
      } else if (task.type === 'PAPER_TRADING_AUTO_SYNC') {
        // 修复 HIGH #24 (2026-06-16): all_portfolios 模式 — 之前 AUTO_SYNC 只对
        // parameters.portfolio_name 指定的单 portfolio 跑, 其他 portfolio 永远无 BUY.
        const allPortfoliosFlag =
          parameters.all_portfolios !== undefined
            ? Boolean(parameters.all_portfolios)
            : parameters.allPortfolios !== undefined
            ? Boolean(parameters.allPortfolios)
            : false;
        const buildSyncOptions = (overrides: any) => ({
          username: parameters.username,
          ...portfolioParams,
          ...overrides,
          source_type: parameters.source_type || parameters.sourceType,
          limit: this.toPositiveInt(parameters.limit, 5, 20),
          scan_limit: this.toPositiveInt(
            this.getParameterValue(parameters, 'scan_limit', 'scanLimit'),
            80,
            500
          ),
          min_score: Number(parameters.min_score || parameters.minScore || 72),
          max_positions: this.toPositiveInt(
            this.getParameterValue(parameters, 'max_positions', 'maxPositions'),
            8,
            30
          ),
          default_position_pct: Number(
            parameters.default_position_pct || parameters.defaultPositionPct || 5
          ),
          max_position_pct: Number(parameters.max_position_pct || parameters.maxPositionPct || 12),
          min_trade_amount: Number(
            parameters.min_trade_amount || parameters.minTradeAmount || 3000
          ),
          allowed_risk_levels: parameters.allowed_risk_levels ||
            parameters.allowedRiskLevels || ['low', 'medium'],
          require_action_buy:
            parameters.require_action_buy !== undefined
              ? Boolean(parameters.require_action_buy)
              : parameters.requireActionBuy !== undefined
              ? Boolean(parameters.requireActionBuy)
              : true,
          dry_run:
            parameters.dry_run !== undefined
              ? Boolean(parameters.dry_run)
              : parameters.dryRun !== undefined
              ? Boolean(parameters.dryRun)
              : false,
          report_to_feishu:
            parameters.report_to_feishu !== undefined
              ? Boolean(parameters.report_to_feishu)
              : parameters.reportToFeishu !== undefined
              ? Boolean(parameters.reportToFeishu)
              : true,
          refresh_recommendations:
            parameters.refresh_recommendations !== undefined
              ? Boolean(parameters.refresh_recommendations)
              : parameters.refreshRecommendations !== undefined
              ? Boolean(parameters.refreshRecommendations)
              : true,
          universe: parameters.universe === 'market' ? 'market' : 'favorites',
          style: ['balanced', 'momentum', 'value', 'low_risk'].includes(parameters.style)
            ? parameters.style
            : 'balanced',
          candidate_limit: this.toPositiveInt(
            parameters.candidate_limit || parameters.candidateLimit,
            20,
            50
          ),
          lookback_days: this.toPositiveInt(
            parameters.lookback_days || parameters.lookbackDays,
            120,
            3650
          ),
          verify_signals:
            parameters.verify_signals !== undefined
              ? Boolean(parameters.verify_signals)
              : parameters.verifySignals !== undefined
              ? Boolean(parameters.verifySignals)
              : false,
          use_attribution_feedback:
            parameters.use_attribution_feedback !== undefined
              ? Boolean(parameters.use_attribution_feedback)
              : parameters.useAttributionFeedback !== undefined
              ? Boolean(parameters.useAttributionFeedback)
              : true,
          use_profit_gate:
            parameters.use_profit_gate !== undefined
              ? Boolean(parameters.use_profit_gate)
              : parameters.useProfitGate !== undefined
              ? Boolean(parameters.useProfitGate)
              : true,
          profit_gate_horizon:
            parameters.profit_gate_horizon || parameters.profitGateHorizon || '5d',
          profit_gate_min_samples: this.toPositiveInt(
            parameters.profit_gate_min_samples || parameters.profitGateMinSamples,
            5,
            100
          ),
          profit_gate_min_quality_score: Number(
            parameters.profit_gate_min_quality_score || parameters.profitGateMinQualityScore || 45
          ),
          profit_gate_allow_deprioritized:
            parameters.profit_gate_allow_deprioritized !== undefined
              ? Boolean(parameters.profit_gate_allow_deprioritized)
              : parameters.profitGateAllowDeprioritized !== undefined
              ? Boolean(parameters.profitGateAllowDeprioritized)
              : false,
          profit_gate_allow_sampling:
            parameters.profit_gate_allow_sampling !== undefined
              ? Boolean(parameters.profit_gate_allow_sampling)
              : parameters.profitGateAllowSampling !== undefined
              ? Boolean(parameters.profitGateAllowSampling)
              : true,
          profit_gate_sampling_multiplier: Number(
            parameters.profit_gate_sampling_multiplier ||
              parameters.profitGateSamplingMultiplier ||
              0.35
          ),
          use_outcome_feedback:
            parameters.use_outcome_feedback !== undefined
              ? Boolean(parameters.use_outcome_feedback)
              : parameters.useOutcomeFeedback !== undefined
              ? Boolean(parameters.useOutcomeFeedback)
              : true,
          outcome_feedback_min_closed_samples: this.toPositiveInt(
            parameters.outcome_feedback_min_closed_samples ||
              parameters.outcomeFeedbackMinClosedSamples,
            5,
            100
          ),
          outcome_feedback_lookback_days: this.toPositiveInt(
            parameters.outcome_feedback_lookback_days || parameters.outcomeFeedbackLookbackDays,
            365,
            3650
          ),
          outcome_feedback_limit: this.toPositiveInt(
            parameters.outcome_feedback_limit || parameters.outcomeFeedbackLimit,
            2000,
            10000
          ),
        });

        let result: any;
        if (allPortfoliosFlag) {
          // 跨所有 active portfolio 跑 AUTO_SYNC, 聚合 counts
          const ports = await PaperTradingPortfolio.findAll({
            where: { is_active: true },
            order: [['id', 'ASC']],
          });
          const aggregated = {
            portfolio_id: 0,
            user_id: 0,
            dry_run: parameters.dry_run || parameters.dryRun || false,
            source_type: parameters.source_type || 'unknown',
            scanned: 0,
            eligible: 0,
            executed: 0,
            planned: 0,
            skipped: 0,
            trades: [] as any[],
            skipped_items: [] as any[],
          };
          for (const port of ports) {
            try {
              const opts = buildSyncOptions({
                user_id: port.user_id,
                portfolio_name: port.name,
                force_new_portfolio: false,
              });
              const r = await paperTradingAutomationService.runAutoSync(opts);
              aggregated.scanned += r.scanned || 0;
              aggregated.eligible += r.eligible || 0;
              aggregated.executed += r.executed || 0;
              aggregated.planned += r.planned || 0;
              aggregated.skipped += r.skipped || 0;
              if (r.trades) aggregated.trades.push(...r.trades);
              if (r.skipped_items) aggregated.skipped_items.push(...r.skipped_items);
            } catch (err: any) {
              logger.warn(
                `[AUTO_SYNC all_portfolios] portfolio ${port.id} (${port.name}) 失败: ${
                  err?.message || err
                }`
              );
            }
          }
          logger.info(
            `AUTO_SYNC all_portfolios 完成: ${ports.length} portfolios, executed=${aggregated.executed} planned=${aggregated.planned}`
          );
          result = aggregated;
        } else {
          result = await paperTradingAutomationService.runAutoSync(buildSyncOptions({}));
        }

        await this.safeUpdateExecutionLog(executionLog, {
          total_items: result.scanned,
          completed_items: result.executed || result.planned,
          failed_items: result.skipped,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
        });

        logger.info(
          `模拟盘自动跟单完成。扫描 ${result.scanned}，成交 ${result.executed}，预演 ${result.planned}，跳过 ${result.skipped}`
        );
      } else if (task.type === 'PAPER_TRADING_RISK_CHECK') {
        const result = await paperTradingAutomationService.runRiskCheck({
          username: parameters.username,
          ...portfolioParams,
          // 修复 (2026-06-16): all_portfolios=true 让风控扫所有 is_active portfolio,
          // 而不是只扫 portfolio_name 指定的那一个空仓 "系统观测盘".
          all_portfolios:
            parameters.all_portfolios !== undefined
              ? Boolean(parameters.all_portfolios)
              : parameters.allPortfolios !== undefined
              ? Boolean(parameters.allPortfolios)
              : false,
          dry_run:
            parameters.dry_run !== undefined
              ? Boolean(parameters.dry_run)
              : parameters.dryRun !== undefined
              ? Boolean(parameters.dryRun)
              : false,
          report_to_feishu:
            parameters.report_to_feishu !== undefined
              ? Boolean(parameters.report_to_feishu)
              : parameters.reportToFeishu !== undefined
              ? Boolean(parameters.reportToFeishu)
              : true,
          limit: this.toPositiveInt(parameters.limit, 20, 100),
          enable_stop_loss:
            parameters.enable_stop_loss !== undefined
              ? Boolean(parameters.enable_stop_loss)
              : parameters.enableStopLoss !== undefined
              ? Boolean(parameters.enableStopLoss)
              : true,
          enable_take_profit:
            parameters.enable_take_profit !== undefined
              ? Boolean(parameters.enable_take_profit)
              : parameters.enableTakeProfit !== undefined
              ? Boolean(parameters.enableTakeProfit)
              : true,
          enable_trailing_take_profit:
            parameters.enable_trailing_take_profit !== undefined
              ? Boolean(parameters.enable_trailing_take_profit)
              : parameters.enableTrailingTakeProfit !== undefined
              ? Boolean(parameters.enableTrailingTakeProfit)
              : true,
          enable_sell_signals:
            parameters.enable_sell_signals !== undefined
              ? Boolean(parameters.enable_sell_signals)
              : parameters.enableSellSignals !== undefined
              ? Boolean(parameters.enableSellSignals)
              : true,
          use_adaptive_risk_policy:
            parameters.use_adaptive_risk_policy !== undefined
              ? Boolean(parameters.use_adaptive_risk_policy)
              : parameters.useAdaptiveRiskPolicy !== undefined
              ? Boolean(parameters.useAdaptiveRiskPolicy)
              : true,
          adaptive_risk_lookback_days: this.toPositiveInt(
            parameters.adaptive_risk_lookback_days || parameters.adaptiveRiskLookbackDays,
            180,
            3650
          ),
          adaptive_risk_min_closed_samples: this.toPositiveInt(
            parameters.adaptive_risk_min_closed_samples || parameters.adaptiveRiskMinClosedSamples,
            5,
            100
          ),
          adaptive_risk_override_signal_params:
            parameters.adaptive_risk_override_signal_params !== undefined
              ? Boolean(parameters.adaptive_risk_override_signal_params)
              : parameters.adaptiveRiskOverrideSignalParams !== undefined
              ? Boolean(parameters.adaptiveRiskOverrideSignalParams)
              : false,
          default_stop_loss_pct: Number(
            parameters.default_stop_loss_pct || parameters.defaultStopLossPct || 7
          ),
          default_take_profit_pct: Number(
            parameters.default_take_profit_pct || parameters.defaultTakeProfitPct || 14
          ),
          trailing_activation_pct: Number(
            parameters.trailing_activation_pct || parameters.trailingActivationPct || 8
          ),
          trailing_drawdown_pct: Number(
            parameters.trailing_drawdown_pct || parameters.trailingDrawdownPct || 4
          ),
          max_hold_days: Number(parameters.max_hold_days || parameters.maxHoldDays || 0),
          min_sell_signal_score: Number(
            parameters.min_sell_signal_score || parameters.minSellSignalScore || 60
          ),
          sell_signal_source_type:
            parameters.sell_signal_source_type || parameters.sellSignalSourceType || 'all',
        });

        await this.safeUpdateExecutionLog(executionLog, {
          total_items: result.checked,
          completed_items: result.exited || result.planned,
          failed_items: result.skipped,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
        });

        logger.info(
          `模拟盘风控检查完成。检查 ${result.checked}，退出 ${result.exited}，预演 ${result.planned}，继续持有 ${result.held}`
        );
      } else if (task.type === 'PAPER_TRADING_TRAILING_STOP_UPDATE') {
        // US-048 — 每日收盘后定时任务：刷新所有用户的持仓 highest_price
        // 与 trailing_stop_price。`user_id` 参数可选；不传 = 扫描所有有
        // PaperTradingPortfolio 的用户。
        const targetUserId = parameters.user_id || parameters.userId;
        const result = await trailingStopGuard.updatePositionsAfterClose({
          user_id: targetUserId ? Number(targetUserId) : undefined,
        });
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: result.total_positions,
          completed_items: result.updated_positions,
          failed_items: result.skipped_positions,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
          result_summary: {
            scenario: 'paper_trading_trailing_stop_update',
            scanned_users: result.scanned_users,
            total_positions: result.total_positions,
            updated_positions: result.updated_positions,
            skipped_positions: result.skipped_positions,
            per_user_errors: result.per_user
              .filter(u => u.error)
              .map(u => ({ user_id: u.user_id, error: u.error })),
          },
        });
        logger.info(
          `追踪止损刷新完成。扫描用户 ${result.scanned_users}，` +
            `持仓 ${result.total_positions}，更新 ${result.updated_positions}，` +
            `跳过 ${result.skipped_positions}`
        );
      } else if (task.type === 'PAPER_TRADING_TRAILING_STOP_CHECK') {
        // US-048 — 次日开盘前定时任务：检查 prev_close ≤ trailing_stop_price
        // 触发 SELL 信号，写 RiskAlert(level='HIGH')。
        // Batch J (2026-06-17): 真卖路径接入 — 之前 trigger 只写 result_summary,
        // 不卖. 现在调 executeGuardSells 通过 facade.placeOrder 真卖 (bypass T+1 +
        // bypass trading_hours; EOD 评估天然满足 T+1). cron parameters.execute_sells
        // 控制是否执行 (默认 true; ops 可临时 false 退化为告警).
        const targetUserId = parameters.user_id || parameters.userId;
        const dryRun =
          parameters.dry_run !== undefined
            ? Boolean(parameters.dry_run)
            : parameters.dryRun !== undefined
            ? Boolean(parameters.dryRun)
            : false;
        const executeSells = parameters.execute_sells !== false; // default true
        const result = await trailingStopGuard.evaluateNextDayTriggers({
          user_id: targetUserId ? Number(targetUserId) : undefined,
          dry_run: dryRun,
        });
        let sellExecution: any = null;
        if (executeSells && result.triggers.length > 0) {
          sellExecution = await executeGuardSells(
            result.triggers.map(t => ({
              user_id: t.user_id,
              symbol: t.symbol,
              quantity: t.quantity,
              portfolio_id: t.portfolio_id,
              trigger_kind: 'trailing_stop',
              detail: {
                prev_close: t.prev_close,
                highest_price: t.highest_price,
                trailing_stop_price: t.trailing_stop_price,
                effective_pct: t.effective_pct,
              },
            })),
            { scenario: 'paper_trading_trailing_stop_check', dry_run: dryRun }
          );
        }
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: result.total_positions,
          completed_items: result.triggered_positions,
          failed_items: result.per_user_errors.length,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
          result_summary: {
            scenario: 'paper_trading_trailing_stop_check',
            scanned_users: result.scanned_users,
            total_positions: result.total_positions,
            triggered_positions: result.triggered_positions,
            dry_run: dryRun,
            per_user_errors: result.per_user_errors,
            triggers: result.triggers.map(t => ({
              user_id: t.user_id,
              symbol: t.symbol,
              prev_close: t.prev_close,
              highest_price: t.highest_price,
              trailing_stop_price: t.trailing_stop_price,
              effective_pct: t.effective_pct,
            })),
            sell_execution: sellExecution,
          },
        });
        logger.info(
          `追踪止损检查完成。扫描用户 ${result.scanned_users}，` +
            `持仓 ${result.total_positions}，触发 ${result.triggered_positions}` +
            (sellExecution
              ? `, 执行 SELL: succeeded=${sellExecution.succeeded}, failed=${sellExecution.failed}, skipped=${sellExecution.skipped}`
              : '') +
            (dryRun ? '（dry-run，未写 RiskAlert）' : '')
        );
      } else if (task.type === 'PAPER_TRADING_DRAWDOWN_BREAKER_CHECK') {
        // US-049 — 每日收盘后定时任务：评估所有用户的组合回撤等级
        // (LEVEL_1 / LEVEL_2 / LEVEL_3) 并触发对应风控动作（暂停 24h /
        // 减仓 50% / 清仓）。`user_id` 参数可选；不传 = 扫描所有有
        // PaperTradingPortfolio 的用户。`dry_run` 让 UI dashboard 能
        // "预演今日 trigger" 不写 RiskAlert / paused_until。
        const targetUserId = parameters.user_id || parameters.userId;
        const dryRun =
          parameters.dry_run !== undefined
            ? Boolean(parameters.dry_run)
            : parameters.dryRun !== undefined
            ? Boolean(parameters.dryRun)
            : false;
        const lookbackDays =
          parameters.lookback_days !== undefined
            ? Number(parameters.lookback_days)
            : parameters.lookbackDays !== undefined
            ? Number(parameters.lookbackDays)
            : undefined;
        const result = await drawdownCircuitBreaker.evaluateAfterClose({
          user_id: targetUserId ? Number(targetUserId) : undefined,
          dry_run: dryRun,
          lookback_days: lookbackDays,
        });
        // Batch J (2026-06-17): LEVEL_2 (减仓) / LEVEL_3 (清仓) triggers 真卖.
        // LEVEL_1 不卖 (仅 pause 新开仓); breaker 自己已写 paused_until.
        const executeSells = parameters.execute_sells !== false;
        let sellExecution: any = null;
        if (executeSells && result.triggers.length > 0) {
          sellExecution = await executeGuardSells(
            result.triggers.map(t => ({
              user_id: t.user_id,
              symbol: t.symbol,
              quantity: t.quantity,
              portfolio_id: t.portfolio_id,
              trigger_kind: t.reason.includes('LEVEL_3') ? 'drawdown_level_3' : 'drawdown_level_2',
              detail: { gain_ratio: t.gain_ratio, reason: t.reason },
            })),
            { scenario: 'paper_trading_drawdown_breaker_check', dry_run: dryRun }
          );
        }
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: result.scanned_users,
          completed_items: result.triggered_users,
          failed_items: result.per_user.filter(u => u.error).length,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
          result_summary: {
            scenario: 'paper_trading_drawdown_breaker_check',
            scanned_users: result.scanned_users,
            triggered_users: result.triggered_users,
            dry_run: dryRun,
            triggers: result.triggers.map(t => ({
              user_id: t.user_id,
              symbol: t.symbol,
              quantity: t.quantity,
              gain_ratio: t.gain_ratio,
              reason: t.reason,
            })),
            per_user_summary: result.per_user.map(u => ({
              user_id: u.user_id,
              level: u.level,
              drawdown_pct: u.drawdown_pct,
              peak_value: u.peak_value,
              current_value: u.current_value,
              paused_until: u.paused_until,
              error: u.error,
            })),
            sell_execution: sellExecution,
          },
        });
        logger.info(
          `组合回撤熔断评估完成。扫描用户 ${result.scanned_users}，` +
            `触发 ${result.triggered_users}` +
            (sellExecution
              ? `, 执行 SELL: succeeded=${sellExecution.succeeded}, failed=${sellExecution.failed}, skipped=${sellExecution.skipped}`
              : '') +
            (dryRun ? '（dry-run，未写 RiskAlert）' : '')
        );
      } else if (task.type === 'PAPER_TRADING_MARKET_REGIME_CHECK') {
        // US-050 — 每日开盘后定时任务：扫描上证指数(默认)的市场环境信号
        // (DROP_3D MEDIUM / DROP_20D HIGH / DEATH_CROSS MEDIUM) 并给所有
        // 有 PaperTradingPortfolio 的用户写一条 RiskAlert（每信号一行）。
        // `user_id` 参数可选；不传 = 扫描所有用户。`dry_run` 让 UI dashboard
        // 能"预演今日 trigger" 不写 RiskAlert。
        const targetUserId = parameters.user_id || parameters.userId;
        const dryRun =
          parameters.dry_run !== undefined
            ? Boolean(parameters.dry_run)
            : parameters.dryRun !== undefined
            ? Boolean(parameters.dryRun)
            : false;
        const lookbackDays =
          parameters.lookback_days !== undefined
            ? Number(parameters.lookback_days)
            : parameters.lookbackDays !== undefined
            ? Number(parameters.lookbackDays)
            : undefined;
        const result = await marketRegimeAlertService.evaluateAfterOpen({
          user_id: targetUserId ? Number(targetUserId) : undefined,
          dry_run: dryRun,
          lookback_days: lookbackDays,
        });
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: result.scanned_users,
          completed_items: result.alerted_users,
          failed_items: result.per_user.filter(u => u.error).length,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
          result_summary: {
            scenario: 'paper_trading_market_regime_check',
            scanned_users: result.scanned_users,
            alerted_users: result.alerted_users,
            dry_run: dryRun,
            benchmark_symbol: result.status.benchmark_symbol,
            as_of: result.status.as_of,
            return_3d_pct: result.status.return_3d_pct,
            return_20d_pct: result.status.return_20d_pct,
            cross_signal: result.status.cross_signal,
            alerts: result.status.alerts.map(a => ({
              type: a.type,
              level: a.level,
              symbol: a.symbol,
            })),
            per_user_summary: result.per_user.map(u => ({
              user_id: u.user_id,
              alerts_written: u.alerts_written,
              error: u.error,
            })),
          },
        });
        logger.info(
          `市场环境预警评估完成。扫描用户 ${result.scanned_users}，` +
            `触发告警 ${result.alerted_users}，` +
            `信号 [${result.status.alerts.map(a => a.type).join(',') || '无'}]` +
            (dryRun ? '（dry-run，未写 RiskAlert）' : '')
        );
      } else if (task.type === 'PAPER_TRADING_PER_STOCK_STOP_LOSS_CHECK') {
        // US-051 — 每日收盘后定时任务：扫描所有持仓，若 (close - avg_cost) /
        // avg_cost ≤ -effective_pct（默认 -7%）触发 RiskAlert(level='HIGH',
        // symbol=持仓 symbol)；若一个用户的触发数 ≥ Math.ceil(open_count * 0.5)
        // 额外写一行 RiskAlert(symbol='SYSTEM:PER_STOCK_STOP_LOSS_MASS') 标识
        // 组合级 LEVEL_2 群体止损事件。`user_id` 参数可选；不传 = 扫描所有用户。
        // `dry_run` 让 UI dashboard "预演今日 trigger" 不写 RiskAlert。
        const targetUserId = parameters.user_id || parameters.userId;
        const dryRun =
          parameters.dry_run !== undefined
            ? Boolean(parameters.dry_run)
            : parameters.dryRun !== undefined
            ? Boolean(parameters.dryRun)
            : false;
        const result = await perStockStopLossGuard.evaluateAfterClose({
          user_id: targetUserId ? Number(targetUserId) : undefined,
          dry_run: dryRun,
        });
        // Batch J (2026-06-17): 每股止损 trigger 真卖, MASS 级也同款执行 (本质上同一批
        // triggers, MASS 只是告警标记). 不触发 = 0 trigger, executeGuardSells 直接返 0.
        const executeSells = parameters.execute_sells !== false;
        let sellExecution: any = null;
        if (executeSells && result.triggers.length > 0) {
          sellExecution = await executeGuardSells(
            result.triggers.map(t => ({
              user_id: t.user_id,
              symbol: t.symbol,
              quantity: t.quantity,
              portfolio_id: t.portfolio_id,
              trigger_kind: 'per_stock_stop_loss',
              detail: {
                loss_ratio: t.loss_ratio,
                effective_pct: t.effective_pct,
                today_close: t.today_close,
                avg_cost: t.avg_cost,
              },
            })),
            { scenario: 'paper_trading_per_stock_stop_loss_check', dry_run: dryRun }
          );
        }
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: result.scanned_users,
          completed_items: result.triggered_users,
          failed_items: result.per_user.filter(u => u.error).length,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
          result_summary: {
            scenario: 'paper_trading_per_stock_stop_loss_check',
            scanned_users: result.scanned_users,
            triggered_users: result.triggered_users,
            dry_run: dryRun,
            triggers: result.triggers.map(t => ({
              user_id: t.user_id,
              symbol: t.symbol,
              quantity: t.quantity,
              loss_ratio: t.loss_ratio,
              effective_pct: t.effective_pct,
              today_close: t.today_close,
              avg_cost: t.avg_cost,
            })),
            per_user_summary: result.per_user.map(u => ({
              user_id: u.user_id,
              level: u.level,
              open_positions_count: u.open_positions_count,
              triggered_count: u.triggered_count,
              mass_message: u.mass_message,
              error: u.error,
            })),
            sell_execution: sellExecution,
          },
        });
        logger.info(
          `每股止损评估完成。扫描用户 ${result.scanned_users}，` +
            `触发用户 ${result.triggered_users}，` +
            `总 trigger ${result.triggers.length}` +
            (sellExecution
              ? `, 执行 SELL: succeeded=${sellExecution.succeeded}, failed=${sellExecution.failed}, skipped=${sellExecution.skipped}`
              : '') +
            (dryRun ? '（dry-run，未写 RiskAlert）' : '')
        );
      } else if (task.type === 'PAPER_TRADING_MORNING_CHECKUP') {
        // Batch J (2026-06-17): US-054 MorningRiskCheckupService cron 接入
        // (之前完全没注册, service 永远不跑). 推荐 cron: 30 8 * * 1-5 (08:30).
        const targetUserId = parameters.user_id || parameters.userId;
        const dryRun = parameters.dry_run !== undefined ? Boolean(parameters.dry_run) : false;
        const result = await morningRiskCheckupService.runMorningCheckup({
          user_id: targetUserId ? Number(targetUserId) : undefined,
          dry_run: dryRun,
        });
        const failedCount = (result.per_user || []).filter((u: any) => u.error).length;
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: result.scanned_users,
          completed_items: result.checked_users,
          failed_items: failedCount,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
          result_summary: {
            scenario: 'paper_trading_morning_checkup',
            scanned_users: result.scanned_users,
            checked_users: result.checked_users,
            dry_run: dryRun,
            failed: failedCount,
          },
        });
        logger.info(
          `早盘体检完成。扫描 ${result.scanned_users} / 体检 ${result.checked_users}` +
            (dryRun ? '（dry-run，未持久化）' : '')
        );
      } else if (task.type === 'PAPER_TRADING_RESTRICTED_SHARE_CHECK') {
        // Batch J (2026-06-17): US-089 RestrictedShareWatchdog cron 接入
        // (之前完全没注册). 推荐 cron: 0 9 * * 1-5 (开盘前提前预警).
        const targetUserId = parameters.user_id || parameters.userId;
        const dryRun = parameters.dry_run !== undefined ? Boolean(parameters.dry_run) : false;
        const result = await restrictedShareWatchdog.evaluateAfterOpen({
          user_id: targetUserId ? Number(targetUserId) : undefined,
          dry_run: dryRun,
        });
        const failedCount = (result.per_user || []).filter((u: any) => u.error).length;
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: result.scanned_users,
          completed_items: result.triggered_users,
          failed_items: failedCount,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
          result_summary: {
            scenario: 'paper_trading_restricted_share_check',
            scanned_users: result.scanned_users,
            triggered_users: result.triggered_users,
            dry_run: dryRun,
            window_start: result.window_start,
            window_end: result.window_end,
            trigger_count: result.triggers.length,
          },
        });
        logger.info(
          `限售解禁前瞻预警完成。扫描 ${result.scanned_users}, ` +
            `触发 ${result.triggered_users}, ${result.triggers.length} 个 trigger ` +
            (dryRun ? '（dry-run）' : '')
        );
      } else if (task.type === 'PAPER_TRADING_INDUSTRY_CONCENTRATION_CHECK') {
        // Batch J (2026-06-17): IndustryConcentrationGuard.evaluateAfterClose cron 接入
        // (之前完全没注册, 行业集中度告警从来没自动跑过). 推荐 cron: 35 15 * * 1-5 (收盘后).
        // 注: 这里只评估 + 写 MEDIUM RiskAlert, 不自动 rebalance — rebalance 是 user
        // 手动一键 (POST /api/portfolio/rebalance-industry).
        const targetUserId = parameters.user_id || parameters.userId;
        const dryRun = parameters.dry_run !== undefined ? Boolean(parameters.dry_run) : false;
        const result = await industryConcentrationGuard.evaluateAfterClose({
          user_id: targetUserId ? Number(targetUserId) : undefined,
          dry_run: dryRun,
        });
        const failedCount = (result.per_user || []).filter((u: any) => u.error).length;
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: result.scanned_users,
          completed_items: result.alerted_users,
          failed_items: failedCount,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
          result_summary: {
            scenario: 'paper_trading_industry_concentration_check',
            scanned_users: result.scanned_users,
            alerted_users: result.alerted_users,
            dry_run: dryRun,
          },
        });
        logger.info(
          `行业集中度评估完成。扫描 ${result.scanned_users}, ` +
            `告警 ${result.alerted_users}` +
            (dryRun ? '（dry-run，未写 RiskAlert）' : '')
        );
      } else if (task.type === 'INDUSTRY_FLOW_SYNC') {
        // Batch AB (2026-06-18): 行业资金流当日 sync (AKShare 实时快照 stock_sector_fund_flow_rank).
        // 配合 limit_up 联表算每行业涨停数. 推荐 cron: '5 15 * * 1-5' (收盘后 5min).
        const today = moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
        const date = parameters.date || today;
        const result = await industrySyncService.syncDate(date);
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: result.fetched || 0,
          success_count: result.upserted || 0,
          failed_count: result.error ? 1 : 0,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: result.error || null,
          result_summary: {
            scenario: 'industry_flow_sync',
            date,
            fetched: result.fetched,
            upserted: result.upserted,
            industries_with_limit_ups: result.industries_with_limit_ups,
            industries_with_leader: result.industries_with_leader,
          },
        });
        logger.info(
          `[industry-flow-sync] ${date} 完成: fetched=${result.fetched} upserted=${result.upserted}`
        );
      } else if (task.type === 'LIMIT_UP_SYNC') {
        // Batch AB (2026-06-18): 涨停股池当日 sync (zt_pool + strong_pool 合并).
        // DragonHead / GameTraderRelay / LinkageStrategy 都依赖. 推荐 cron: '10 15 * * 1-5'.
        const today = moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
        const date = parameters.date || today;
        const result = await limitUpSyncService.syncDate(date);
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: result.fetched || 0,
          success_count: result.upserted || 0,
          failed_count: result.error ? 1 : 0,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: result.error || null,
          result_summary: {
            scenario: 'limit_up_sync',
            date,
            fetched: result.fetched,
            upserted: result.upserted,
            recomputed_continuous_days: result.recomputed_continuous_days,
          },
        });
        logger.info(
          `[limit-up-sync] ${date} 完成: fetched=${result.fetched} upserted=${result.upserted}`
        );
      } else if (task.type === 'NORTHBOUND_SYNC') {
        // Batch AB (2026-06-18): 北向持股当日 sync (沪股通/深股通).
        // northbound 因子 + NorthboundFollowStrategy + EarningsSurpriseStrategy 依赖.
        // 推荐 cron: '15 16 * * 1-5' (港股通收盘后 16:10 数据可用).
        //
        // 2026-06-21 数据 sync 修复: 上游 East Money `stock_hsgt_hold_stock_em`
        // 当前 100% 返 null pages (AKShare TypeError), 全市场快照拉不下来. 增加
        // per-stock fallback: 先试 syncDate, 若 fetched=0 (空) 且 parameters.fallback_individual
        // 不为 false, 则用 universe (持仓 + 收藏 + 主板 top N) 走 stock_hsgt_individual_em
        // 逐只补回最近 N 天历史. 确保 northbound_holdings 始终非空.
        const today = moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
        const date = parameters.date || today;
        const result = await northboundSyncService.syncDate(date);

        // Fallback path
        let fallbackSummary: Record<string, unknown> | null = null;
        const allowFallback = parameters.fallback_individual !== false;
        if (allowFallback && (result.fetched || 0) === 0) {
          try {
            const windowDays = this.toPositiveInt(parameters.window_days, 14, 60);
            const universeLimit = this.toPositiveInt(parameters.universe_limit, 300, 1500);
            const startDate = moment(date)
              .tz('Asia/Shanghai')
              .subtract(windowDays, 'day')
              .format('YYYY-MM-DD');
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { Stock } = require('../models/Stock');
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { PaperTradingPosition } = require('../models/PaperTradingPosition');
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { Op } = require('sequelize');

            const set = new Set<string>();
            try {
              const positions = await PaperTradingPosition.findAll({
                attributes: ['symbol'],
                group: ['symbol'],
                raw: true,
              });
              for (const r of positions) {
                const digits = String(r.symbol || '').replace(/[^0-9]/g, '').slice(-6);
                if (/^\d{6}$/.test(digits)) set.add(digits);
              }
            } catch (e) {
              // continue
            }
            // Top stocks by circulating market cap to fill the universe
            try {
              const top = await Stock.findAll({
                where: {
                  is_listed: true,
                  name: {
                    [Op.and]: [{ [Op.notILike]: '%ST%' }, { [Op.notILike]: '%退%' }],
                  },
                },
                order: [['circulating_market_cap', 'DESC NULLS LAST']],
                limit: universeLimit,
                attributes: ['symbol'],
                raw: true,
              });
              for (const s of top as any[]) {
                const digits = String(s.symbol || '').replace(/[^0-9]/g, '').slice(-6);
                if (/^\d{6}$/.test(digits)) set.add(digits);
              }
            } catch (e) {
              // continue
            }
            // Always include core targets so they are guaranteed in DB
            for (const code of ['688008', '300054', '600667', '300476', '002916', '301377']) {
              set.add(code);
            }

            const universe = Array.from(set).slice(0, universeLimit);
            const individualResult = await northboundSyncService.syncIndividualUniverse(
              universe,
              startDate,
              date,
              { intervalMs: 150 }
            );
            fallbackSummary = {
              fallback: 'individual',
              window: { start: startDate, end: date },
              universe_size: universe.length,
              ...individualResult,
            };
          } catch (e: any) {
            fallbackSummary = { fallback: 'individual', error: e?.message || String(e) };
          }
        }

        await this.safeUpdateExecutionLog(executionLog, {
          total_items: result.fetched || 0,
          success_count: result.upserted || 0,
          failed_count: result.error ? 1 : 0,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: result.error || null,
          result_summary: {
            scenario: 'northbound_sync',
            date,
            fetched: result.fetched,
            upserted: result.upserted,
            ...(fallbackSummary ? { fallback: fallbackSummary } : {}),
          },
        });
        logger.info(
          `[northbound-sync] ${date} 完成: fetched=${result.fetched} upserted=${result.upserted}` +
            (fallbackSummary ? ` fallback=${JSON.stringify(fallbackSummary)}` : '')
        );

        // AR-3 (2026-06-21): sync 完后跑陈旧度告警 — 上游 AKShare 已死的事实
        // 让运维通过 RiskAlert 立刻看到, 而不是等用户在 UI 看空图反馈.
        // 失败仅 warn 不阻塞 cron.
        try {
          const staleness = await northboundSyncService.checkAndAlertStaleness(
            this.toPositiveInt(parameters.stale_threshold_days, 7, 365)
          );
          logger.info(
            `[northbound-sync] staleness check: latest=${staleness.latest_date} ` +
              `age_days=${staleness.age_days} is_stale=${staleness.is_stale} ` +
              `alert_written=${staleness.alert_written}`
          );
        } catch (e: any) {
          logger.warn(`[northbound-sync] staleness check failed: ${e?.message || e}`);
        }
      } else if (task.type === 'SNOWBALL_HOT_KEYWORD_SYNC') {
        // Batch AB (2026-06-18): 雪球热门话题 sync (AKShare stock_hot_follow_xq).
        // 当日热点关键词 + 关联个股, UI / sentiment 模块用. 推荐 cron: '0 16 * * 1-5'.
        const today = moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
        const date = parameters.date || today;
        const result = await snowballHotKeywordSyncService.syncDate(date);
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: result.fetched || 0,
          success_count: result.upserted || 0,
          failed_count: result.error ? 1 : 0,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: result.error || null,
          result_summary: {
            scenario: 'snowball_hot_keyword_sync',
            date,
            fetched: result.fetched,
            upserted: result.upserted,
            new_keywords_count: result.new_keywords_count,
          },
        });
        logger.info(
          `[snowball-keyword-sync] ${date} 完成: fetched=${result.fetched} 新进=${result.new_keywords_count}`
        );
      } else if (task.type === 'STOCK_SENTIMENT_SYNC') {
        // Batch AB (2026-06-18): 个股关注度 (东财人气榜 rank 倒数代理 post_count).
        // east_money_qa 因子依赖. 默认仅自选股 + 量化候选, 限 50-200 只防 AKShare 限频.
        // 推荐 cron: '30 16 * * 1-5'.
        const limit = parameters.limit ? Number(parameters.limit) : 100;
        const universe = parameters.universe === 'market' ? 'market' : 'favorites';
        // 取候选股: market 模式 = 流通市值 top N; favorites 模式 = 所有 user 的 FavoriteStock + 量化 top
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Stock } = require('../models/Stock');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Op } = require('sequelize');
        const candidates =
          universe === 'market'
            ? await Stock.findAll({
                where: {
                  is_listed: true,
                  name: { [Op.notLike]: '%ST%' },
                },
                order: [['circulating_market_cap', 'DESC']],
                limit,
                attributes: ['symbol'],
                raw: true,
              })
            : await Stock.findAll({
                attributes: ['symbol'],
                limit,
                raw: true,
              });
        const codes = (candidates as any[])
          .map(s => {
            // 兼容 'sz.300085' / '300085.SZ' / 纯 6 位 — 提取最后 6 位数字
            const digits = String(s.symbol || '').replace(/[^0-9]/g, '');
            return digits.length >= 6 ? digits.slice(-6) : '';
          })
          .filter(c => /^\d{6}$/.test(c));
        const result = await stockSentimentSyncService.syncStocks(codes, {
          intervalMs: 250,
        });
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: codes.length,
          success_count: result.succeeded || 0,
          failed_count: result.failed || 0,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
          result_summary: {
            scenario: 'stock_sentiment_sync',
            universe,
            limit,
            total: result.total_stocks,
            succeeded: result.succeeded,
            failed: result.failed,
            skipped: result.skipped,
          },
        });
        logger.info(
          `[stock-sentiment-sync] universe=${universe} limit=${limit} 完成: succeeded=${result.succeeded} failed=${result.failed}`
        );
      } else if (task.type === 'MARKET_NEWS_SYNC') {
        // Batch AG (2026-06-18): 市场新闻 / 财经事件 sync.
        // 多源 (财联社电报 / 东财全球 / 新浪) fallback + 去重入库 market_news 表.
        // 推荐 cron: '*/30 9-15 * * 1-5' (盘中每 30min) + '0 17,21 * * 1-5' (盘后).
        // 可选 parameters.limit 控制单次拉取行数 (默认 80).
        // 可选 parameters.prune_days 触发 pruneOld (默认不裁剪, 设 30 表示删 30 天前).
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { marketNewsSyncService } = require('../data/services/MarketNewsSyncService');
        const limit = parameters.limit ? Number(parameters.limit) : 80;
        const result = await marketNewsSyncService.syncOnce({ limit });
        let pruneDeleted = 0;
        if (parameters.prune_days) {
          const pruneRes = await marketNewsSyncService.pruneOld(Number(parameters.prune_days));
          pruneDeleted = pruneRes.deleted;
        }
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: result.fetched || 0,
          success_count: result.upserted || 0,
          failed_count: result.error ? 1 : 0,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: result.error || null,
          result_summary: {
            scenario: 'market_news_sync',
            fetched: result.fetched,
            upserted: result.upserted,
            skipped: result.skipped,
            prune_deleted: pruneDeleted,
          },
        });
        logger.info(
          `[market-news-sync] 完成: fetched=${result.fetched} upserted=${result.upserted} skipped=${result.skipped} pruned=${pruneDeleted}`
        );
      } else if (task.type === 'SOCIAL_SENTIMENT_SYNC') {
        // Batch AH (2026-06-18): 社媒/舆情综合 (东财人气榜 + 综合评分) sync.
        // 推荐 cron: '20 16 * * 1-5' (盘后, 错开北向 16:15 / 雪球 16:00).
        // 可选 parameters.universe_limit (默认 200, top 流通市值).
        // 可选 parameters.rank_lookback_days (默认 5, rank_breakout_delta 计算窗口).
        const today = moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
        const date = parameters.date || today;
        const limit = parameters.universe_limit ? Number(parameters.universe_limit) : 200;
        const lookback = parameters.rank_lookback_days ? Number(parameters.rank_lookback_days) : 5;
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const {
          socialSentimentSyncService,
        } = require('../data/services/SocialSentimentSyncService');
        const result = await socialSentimentSyncService.syncDate(date, {
          universeLimit: limit,
          rankLookbackDays: lookback,
        });
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: result.universe_size || 0,
          success_count: result.upserted || 0,
          failed_count: result.error ? 1 : 0,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: result.error || null,
          result_summary: {
            scenario: 'social_sentiment_sync',
            date,
            universe_size: result.universe_size,
            fetched: result.fetched,
            upserted: result.upserted,
            history_days_available: result.history_days_available,
          },
        });
        logger.info(
          `[social-sentiment-sync] ${date} 完成: universe=${result.universe_size} upserted=${result.upserted} history_days=${result.history_days_available}`
        );
      } else if (task.type === 'MARKET_HOT_SEARCH_SYNC') {
        // Batch AH (2026-06-18): 百度 A 股搜索热度榜 sync.
        // 推荐 cron: '40 16 * * 1-5' (盘后, 错开其它 16:xx sync).
        const today = moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
        const date = parameters.date || today;
        const limit = parameters.limit ? Number(parameters.limit) : 50;
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const {
          marketHotSearchSyncService,
        } = require('../data/services/MarketHotSearchSyncService');
        const result = await marketHotSearchSyncService.syncDate(date, { limit });
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: result.fetched || 0,
          success_count: result.upserted || 0,
          failed_count: result.error ? 1 : 0,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: result.error || null,
          result_summary: {
            scenario: 'market_hot_search_sync',
            date,
            fetched: result.fetched,
            upserted: result.upserted,
          },
        });
        logger.info(
          `[market-hot-search-sync] ${date} 完成: fetched=${result.fetched} upserted=${result.upserted}`
        );
      } else if (task.type === 'STRATEGY_KILL_SWITCH_CHECK') {
        // Phase 4+ 策略熔断监控 — 评估每个策略的 kill_switch_metric (定义在
        // edge_hypothesis 内)；低于 kill_switch_threshold 触发自动 enabled=false。
        //
        // Batch N (2026-06-17, B4 fix): 默认 dry_run=false 让 kill_switch 真生效.
        // 旧默认 dry_run=true "保守" 实际上让整套 kill_switch lever 永远不触发 —
        // 运维通常不会盯每个 task 配置, 反向更危险. 现在显式想"只评估" 的 task
        // 需要在 parameters 里 set dry_run=true (staging cron / 开发环境).
        const dryRun =
          parameters.dry_run !== undefined
            ? Boolean(parameters.dry_run)
            : parameters.dryRun !== undefined
            ? Boolean(parameters.dryRun)
            : false; // Batch N: 默认 false 让熔断真触发, "误关"由 evaluateAll 内部阈值/样本量门槛防止
        const { strategyKillSwitchMonitor } = require('../services/StrategyKillSwitchMonitor');
        const result = await strategyKillSwitchMonitor.evaluateAll({ dry_run: dryRun });
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: result.total_strategies,
          completed_items: result.evaluated,
          failed_items: result.errors.length,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
          result_summary: {
            scenario: 'strategy_kill_switch_check',
            total_strategies: result.total_strategies,
            evaluated: result.evaluated,
            triggered: result.triggered,
            skipped_no_kill_switch: result.skipped_no_kill_switch,
            skipped_disabled: result.skipped_disabled,
            skipped_insufficient_data: result.skipped_insufficient_data,
            dry_run: dryRun,
            triggered_strategies: result.evaluations
              .filter((e: any) => e.triggered)
              .map((e: any) => ({
                strategy_key: e.strategy_key,
                metric: e.metric,
                threshold: e.threshold,
                observed: e.observed_value,
                reason: e.reason,
              })),
          },
        });
        logger.info(
          `策略熔断评估完成。总策略 ${result.total_strategies}，` +
            `评估 ${result.evaluated}，触发 ${result.triggered}` +
            (dryRun ? '（dry-run，未真正禁用）' : '（已自动 disable）')
        );
      } else if (task.type === 'EQUITY_CURVE_GOVERNOR_DAILY_EVAL') {
        // Sprint 3: 资金曲线 Governor 每日评估 — 对所有 portfolio 评估 5 档健康度。
        // 默认 persist=true，写入 EquityCurveGovernorState，触发档位切换告警。
        const {
          equityCurveGovernorService,
        } = require('../services/governor/EquityCurveGovernorService');
        const result = await equityCurveGovernorService.evaluateAll({
          persist: parameters.persist !== false,
          as_of_date: parameters.as_of_date || parameters.asOfDate,
        });
        const byTier = result.reduce((acc: Record<string, number>, r: any) => {
          acc[r.tier] = (acc[r.tier] || 0) + 1;
          return acc;
        }, {});
        const changed = result.filter((r: any) => r.tier_changed).length;
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: result.length,
          completed_items: result.length,
          failed_items: 0,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
          result_summary: {
            scenario: 'equity_curve_governor_daily_eval',
            evaluated: result.length,
            by_tier: byTier,
            tier_changed: changed,
            results_sample: result.slice(0, 5).map((r: any) => ({
              portfolio_id: r.portfolio_id,
              tier: r.tier,
              multiplier: r.kelly_multiplier,
              trigger_reason: r.trigger_reason,
            })),
          },
        });
        logger.info(
          `资金曲线 Governor 评估完成。已评估 ${result.length} 个 portfolio, ` +
            `档位分布: ${JSON.stringify(byTier)}, ` +
            `档位切换 ${changed} 个`
        );
      } else if (task.type === 'RESEARCH_INTEGRITY_BATCH_AUDIT') {
        // Sprint 1A: ResearchIntegrity 周批量审计 — 扫描近 N 天完成的 QuantBacktestResult，
        // 对每个跑 audit (DSR / PBO / OOS decay)，FAIL 的 strategy 推到 ops 关注列表。
        const {
          researchIntegrityService,
        } = require('../services/research/ResearchIntegrityService');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { QuantBacktestResult } = require('../models/QuantBacktestResult');
        const sinceDays = this.toPositiveInt(parameters.since_days || parameters.sinceDays, 7, 90);
        const cutoff = new Date(Date.now() - sinceDays * 24 * 3600 * 1000);
        const { Op } = require('sequelize');
        const results = await QuantBacktestResult.findAll({
          where: { created_at: { [Op.gte]: cutoff } },
          order: [['created_at', 'DESC']],
          limit: 200,
        });
        let audited = 0;
        const verdictDist: Record<string, number> = { PASS: 0, WARN: 0, FAIL: 0, INSUFFICIENT: 0 };
        const failedStrategies: Array<{ strategy_key: string; verdict: string; reason: string }> =
          [];
        for (const r of results) {
          try {
            const equity = Array.isArray(r.equity_curve_json) ? r.equity_curve_json : [];
            const audit = await researchIntegrityService.auditBacktest(
              {
                backtest_id: r.id,
                source: 'quant_backtest_result',
                strategy_key: r.strategy_key,
                observed_sharpe:
                  r.sharpe_ratio !== null && r.sharpe_ratio !== undefined
                    ? Number(r.sharpe_ratio)
                    : null,
                num_trials: 1,
                sample_length: equity.length,
              },
              { persist: true }
            );
            audited += 1;
            verdictDist[audit.verdict] = (verdictDist[audit.verdict] || 0) + 1;
            if (audit.verdict === 'FAIL') {
              failedStrategies.push({
                strategy_key: r.strategy_key,
                verdict: audit.verdict,
                reason: audit.summary_message,
              });
            }
          } catch (err: any) {
            logger.warn(
              `[research-integrity-batch] audit failed for backtest ${r.id}: ${err?.message}`
            );
          }
        }
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: results.length,
          completed_items: audited,
          failed_items: results.length - audited,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
          result_summary: {
            scenario: 'research_integrity_batch_audit',
            since_days: sinceDays,
            total_backtests: results.length,
            audited,
            verdict_distribution: verdictDist,
            failed_strategies: failedStrategies.slice(0, 20),
          },
        });
        logger.info(
          `ResearchIntegrity 周批量审计完成: 扫描 ${results.length} 个 backtest, 审计 ${audited}, ` +
            `verdict 分布: ${JSON.stringify(verdictDist)}, FAIL 策略: ${failedStrategies.length}`
        );
      } else if (task.type === 'PAPER_TRADING_ATTRIBUTION_REPORT') {
        const result = await paperTradingAttributionService.getAttribution({
          username: parameters.username,
          ...portfolioParams,
          include_open:
            parameters.include_open !== undefined
              ? Boolean(parameters.include_open)
              : parameters.includeOpen !== undefined
              ? Boolean(parameters.includeOpen)
              : true,
          source_type: parameters.source_type || parameters.sourceType,
          start_date: parameters.start_date || parameters.startDate,
          end_date: parameters.end_date || parameters.endDate,
          limit: this.toPositiveInt(parameters.limit, 2000, 10000),
          report_to_feishu:
            parameters.report_to_feishu !== undefined
              ? Boolean(parameters.report_to_feishu)
              : parameters.reportToFeishu !== undefined
              ? Boolean(parameters.reportToFeishu)
              : true,
        });

        await this.safeUpdateExecutionLog(executionLog, {
          total_items: result.summary.executed_signals,
          completed_items: result.summary.closed_count,
          failed_items: result.summary.near_stop_loss_count,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
        });

        logger.info(
          `模拟盘收益归因完成。闭环 ${result.summary.closed_count}，持仓 ${result.summary.open_count}，胜率 ${result.summary.win_rate}%`
        );
      } else if (task.type === 'RECOMMENDATION_TRADE_OUTCOME_REFRESH') {
        const result = await recommendationTradeOutcomeService.refreshPortfolioOutcomes({
          username: parameters.username || 'stock',
          ...portfolioParams,
          // 修复 (2026-06-16): all_portfolios=true 让 outcome refresh 遍历所有
          // is_active portfolio, 不再只盯 portfolio_name 指定那一个.
          all_portfolios:
            parameters.all_portfolios !== undefined
              ? Boolean(parameters.all_portfolios)
              : parameters.allPortfolios !== undefined
              ? Boolean(parameters.allPortfolios)
              : false,
          include_open:
            parameters.include_open !== undefined
              ? Boolean(parameters.include_open)
              : parameters.includeOpen !== undefined
              ? Boolean(parameters.includeOpen)
              : true,
          lookback_days: this.toPositiveInt(
            parameters.lookback_days || parameters.lookbackDays,
            180,
            3650
          ),
          source_type: parameters.source_type || parameters.sourceType,
          agent_session: parameters.agent_session || parameters.agentSession,
          limit: this.toPositiveInt(parameters.limit, 2000, 10000),
          report_to_feishu:
            parameters.report_to_feishu !== undefined
              ? Boolean(parameters.report_to_feishu)
              : parameters.reportToFeishu !== undefined
              ? Boolean(parameters.reportToFeishu)
              : true,
        });

        await this.safeUpdateExecutionLog(executionLog, {
          total_items: result.refreshed,
          completed_items: result.created_or_updated,
          failed_items: result.failed,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: result.failed > 0 ? `${result.failed} 条收益闭环刷新失败` : null,
        });

        logger.info(
          `推荐交易收益闭环刷新完成。刷新 ${result.refreshed}，写入 ${
            result.created_or_updated
          }，闭环 ${(result.dashboard as any)?.summary?.closed_count ?? '—'}，总盈亏 ${
            (result.dashboard as any)?.summary?.total_pnl ?? '—'
          }`
        );
      } else if (task.type === 'PAPER_TRADING_DAILY_PLAN') {
        const result = await paperTradingPlanService.generatePlan({
          username: parameters.username,
          ...portfolioParams,
          include_entries:
            parameters.include_entries !== undefined
              ? Boolean(parameters.include_entries)
              : parameters.includeEntries !== undefined
              ? Boolean(parameters.includeEntries)
              : true,
          include_exits:
            parameters.include_exits !== undefined
              ? Boolean(parameters.include_exits)
              : parameters.includeExits !== undefined
              ? Boolean(parameters.includeExits)
              : true,
          include_monitor:
            parameters.include_monitor !== undefined
              ? Boolean(parameters.include_monitor)
              : parameters.includeMonitor !== undefined
              ? Boolean(parameters.includeMonitor)
              : true,
          report_to_feishu:
            parameters.report_to_feishu !== undefined
              ? Boolean(parameters.report_to_feishu)
              : parameters.reportToFeishu !== undefined
              ? Boolean(parameters.reportToFeishu)
              : true,
          source_type: parameters.source_type || parameters.sourceType,
          limit: this.toPositiveInt(parameters.limit, 30, 100),
          entry_limit: this.toPositiveInt(parameters.entry_limit || parameters.entryLimit, 3, 20),
          scan_limit: this.toPositiveInt(
            this.getParameterValue(parameters, 'scan_limit', 'scanLimit'),
            80,
            500
          ),
          min_score: Number(parameters.min_score || parameters.minScore || 72),
          max_positions: this.toPositiveInt(
            this.getParameterValue(parameters, 'max_positions', 'maxPositions'),
            8,
            30
          ),
          default_position_pct: Number(
            parameters.default_position_pct || parameters.defaultPositionPct || 5
          ),
          max_position_pct: Number(parameters.max_position_pct || parameters.maxPositionPct || 10),
          min_trade_amount: Number(
            parameters.min_trade_amount || parameters.minTradeAmount || 3000
          ),
          allowed_risk_levels: parameters.allowed_risk_levels ||
            parameters.allowedRiskLevels || ['low', 'medium'],
          use_attribution_feedback:
            parameters.use_attribution_feedback !== undefined
              ? Boolean(parameters.use_attribution_feedback)
              : parameters.useAttributionFeedback !== undefined
              ? Boolean(parameters.useAttributionFeedback)
              : true,
          use_profit_gate:
            parameters.use_profit_gate !== undefined
              ? Boolean(parameters.use_profit_gate)
              : parameters.useProfitGate !== undefined
              ? Boolean(parameters.useProfitGate)
              : true,
          profit_gate_horizon:
            parameters.profit_gate_horizon || parameters.profitGateHorizon || '5d',
          profit_gate_min_samples: this.toPositiveInt(
            parameters.profit_gate_min_samples || parameters.profitGateMinSamples,
            5,
            100
          ),
          profit_gate_min_quality_score: Number(
            parameters.profit_gate_min_quality_score || parameters.profitGateMinQualityScore || 45
          ),
          profit_gate_allow_deprioritized:
            parameters.profit_gate_allow_deprioritized !== undefined
              ? Boolean(parameters.profit_gate_allow_deprioritized)
              : parameters.profitGateAllowDeprioritized !== undefined
              ? Boolean(parameters.profitGateAllowDeprioritized)
              : false,
          profit_gate_allow_sampling:
            parameters.profit_gate_allow_sampling !== undefined
              ? Boolean(parameters.profit_gate_allow_sampling)
              : parameters.profitGateAllowSampling !== undefined
              ? Boolean(parameters.profitGateAllowSampling)
              : true,
          profit_gate_sampling_multiplier: Number(
            parameters.profit_gate_sampling_multiplier ||
              parameters.profitGateSamplingMultiplier ||
              0.35
          ),
          use_outcome_feedback:
            parameters.use_outcome_feedback !== undefined
              ? Boolean(parameters.use_outcome_feedback)
              : parameters.useOutcomeFeedback !== undefined
              ? Boolean(parameters.useOutcomeFeedback)
              : true,
          outcome_feedback_min_closed_samples: this.toPositiveInt(
            parameters.outcome_feedback_min_closed_samples ||
              parameters.outcomeFeedbackMinClosedSamples,
            5,
            100
          ),
          outcome_feedback_lookback_days: this.toPositiveInt(
            parameters.outcome_feedback_lookback_days || parameters.outcomeFeedbackLookbackDays,
            365,
            3650
          ),
          outcome_feedback_limit: this.toPositiveInt(
            parameters.outcome_feedback_limit || parameters.outcomeFeedbackLimit,
            2000,
            10000
          ),
          enable_stop_loss:
            parameters.enable_stop_loss !== undefined
              ? Boolean(parameters.enable_stop_loss)
              : parameters.enableStopLoss !== undefined
              ? Boolean(parameters.enableStopLoss)
              : true,
          enable_take_profit:
            parameters.enable_take_profit !== undefined
              ? Boolean(parameters.enable_take_profit)
              : parameters.enableTakeProfit !== undefined
              ? Boolean(parameters.enableTakeProfit)
              : true,
          enable_trailing_take_profit:
            parameters.enable_trailing_take_profit !== undefined
              ? Boolean(parameters.enable_trailing_take_profit)
              : parameters.enableTrailingTakeProfit !== undefined
              ? Boolean(parameters.enableTrailingTakeProfit)
              : true,
          enable_sell_signals:
            parameters.enable_sell_signals !== undefined
              ? Boolean(parameters.enable_sell_signals)
              : parameters.enableSellSignals !== undefined
              ? Boolean(parameters.enableSellSignals)
              : true,
          use_adaptive_risk_policy:
            parameters.use_adaptive_risk_policy !== undefined
              ? Boolean(parameters.use_adaptive_risk_policy)
              : parameters.useAdaptiveRiskPolicy !== undefined
              ? Boolean(parameters.useAdaptiveRiskPolicy)
              : true,
          adaptive_risk_lookback_days: this.toPositiveInt(
            parameters.adaptive_risk_lookback_days || parameters.adaptiveRiskLookbackDays,
            180,
            3650
          ),
          adaptive_risk_min_closed_samples: this.toPositiveInt(
            parameters.adaptive_risk_min_closed_samples || parameters.adaptiveRiskMinClosedSamples,
            5,
            100
          ),
          adaptive_risk_override_signal_params:
            parameters.adaptive_risk_override_signal_params !== undefined
              ? Boolean(parameters.adaptive_risk_override_signal_params)
              : parameters.adaptiveRiskOverrideSignalParams !== undefined
              ? Boolean(parameters.adaptiveRiskOverrideSignalParams)
              : false,
          default_stop_loss_pct: Number(
            parameters.default_stop_loss_pct || parameters.defaultStopLossPct || 7
          ),
          default_take_profit_pct: Number(
            parameters.default_take_profit_pct || parameters.defaultTakeProfitPct || 14
          ),
          trailing_activation_pct: Number(
            parameters.trailing_activation_pct || parameters.trailingActivationPct || 8
          ),
          trailing_drawdown_pct: Number(
            parameters.trailing_drawdown_pct || parameters.trailingDrawdownPct || 4
          ),
          max_hold_days: Number(parameters.max_hold_days || parameters.maxHoldDays || 20),
          min_sell_signal_score: Number(
            parameters.min_sell_signal_score || parameters.minSellSignalScore || 60
          ),
          sell_signal_source_type:
            parameters.sell_signal_source_type || parameters.sellSignalSourceType || 'all',
        });

        const hindsightRefresh = await paperTradingOrderIntentService
          .refreshHindsightSnapshots({
            username: parameters.username,
            ...portfolioParams,
            lookback_days: this.toPositiveInt(
              parameters.order_intent_hindsight_lookback_days ||
                parameters.orderIntentHindsightLookbackDays,
              60,
              3650
            ),
            limit: this.toPositiveInt(
              parameters.order_intent_hindsight_limit || parameters.orderIntentHindsightLimit,
              800,
              5000
            ),
            refresh_hindsight: Boolean(
              parameters.order_intent_hindsight_force_refresh ||
                parameters.orderIntentHindsightForceRefresh
            ),
          })
          .catch((error: any) => {
            logger.warn(`订单意图后验快照刷新失败，交易计划继续完成: ${error?.message || error}`);
            return null;
          });
        const shouldCaptureCanarySnapshot =
          parameters.capture_canary_snapshot !== undefined
            ? Boolean(parameters.capture_canary_snapshot)
            : parameters.captureCanarySnapshot !== undefined
            ? Boolean(parameters.captureCanarySnapshot)
            : true;
        const canarySnapshot = shouldCaptureCanarySnapshot
          ? await paperTradingTuningApplyService
              .getCanaryStatus({
                username: parameters.username,
                user_id: parameters.user_id || parameters.userId,
                limit: 5,
              })
              .catch((error: any) => {
                logger.warn(
                  `Canary 评审快照自动沉淀失败，交易计划继续完成: ${error?.message || error}`
                );
                return null;
              })
          : null;

        await this.safeUpdateExecutionLog(executionLog, {
          total_items: result.summary.action_count,
          completed_items: result.summary.action_count,
          failed_items: result.summary.urgent_count,
          result_summary: {
            scenario: 'paper_trading_daily_plan',
            action_count: result.summary.action_count,
            urgent_count: result.summary.urgent_count,
            entry_count: result.summary.entry_count,
            exit_count: result.summary.exit_count,
            order_intent_hindsight_refresh: hindsightRefresh
              ? {
                  refreshed_count: hindsightRefresh.refreshed_count,
                  evaluated_count: hindsightRefresh.summary?.evaluated_count,
                  persisted_snapshot_count: hindsightRefresh.summary?.persisted_snapshot_count,
                  cache_hit_count: hindsightRefresh.summary?.cache_hit_count,
                  cache_miss_count: hindsightRefresh.summary?.cache_miss_count,
                }
              : null,
            canary_snapshot_capture: canarySnapshot?.active
              ? {
                  snapshot_id: canarySnapshot.snapshot_capture?.snapshot_id,
                  action: canarySnapshot.review?.action,
                  action_label: canarySnapshot.review?.action_label,
                  review_score: canarySnapshot.review?.review_score,
                  ready_for_review: canarySnapshot.review?.ready_for_review,
                  closed_count: canarySnapshot.review?.metrics?.closed_count,
                  avg_excess_return_pct: canarySnapshot.review?.metrics?.avg_excess_return_pct,
                  drawdown_guard_passed: canarySnapshot.review?.drawdown_guard?.passed,
                }
              : {
                  captured: false,
                  reason: canarySnapshot?.summary?.conclusion || '暂无正在观察的 Canary 调参。',
                },
          },
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
        });

        logger.info(
          `模拟盘交易计划完成。动作 ${result.summary.action_count}，紧急 ${
            result.summary.urgent_count
          }，入场 ${result.summary.entry_count}，退出 ${result.summary.exit_count}，后验快照 ${
            hindsightRefresh?.refreshed_count ?? 0
          }，Canary快照 ${canarySnapshot?.snapshot_capture?.snapshot_id || '无'}`
        );
      } else if (task.type === 'PAPER_TRADING_DAILY_DIGEST') {
        // US-063 — 每日收盘后 (默认 15:30) 给所有 notification_channels.feishu.daily_digest=true
        // 的用户发飞书 interactive card 日报（PnL / 新增 BUY/SELL / 明日候选）。
        // `user_id` 可选；不传 = 扫所有 is_active=true 用户。`dry_run`=true 让 ops 预演 payload
        // 不真发 webhook。`per_strategy_limit` 控制明日候选 cap（默认 5）。
        const targetUserId = parameters.user_id || parameters.userId;
        const dryRun =
          parameters.dry_run !== undefined
            ? Boolean(parameters.dry_run)
            : parameters.dryRun !== undefined
            ? Boolean(parameters.dryRun)
            : false;
        const perStrategyLimit =
          parameters.per_strategy_limit !== undefined
            ? Number(parameters.per_strategy_limit)
            : parameters.perStrategyLimit !== undefined
            ? Number(parameters.perStrategyLimit)
            : undefined;
        const perDirectionTradeLimit =
          parameters.per_direction_trade_limit !== undefined
            ? Number(parameters.per_direction_trade_limit)
            : parameters.perDirectionTradeLimit !== undefined
            ? Number(parameters.perDirectionTradeLimit)
            : undefined;
        const digestResult = await dailyTradingDigestService.sendDigests({
          user_id: targetUserId ? Number(targetUserId) : undefined,
          trade_date: parameters.trade_date || parameters.tradeDate,
          dry_run: dryRun,
          per_strategy_limit: perStrategyLimit,
          per_direction_trade_limit: perDirectionTradeLimit,
        });
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: digestResult.scanned_users,
          completed_items: digestResult.sent_count,
          failed_items: digestResult.failed_count,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
          result_summary: {
            scenario: 'paper_trading_daily_digest',
            trade_date: digestResult.trade_date,
            scanned_users: digestResult.scanned_users,
            sent_count: digestResult.sent_count,
            skipped_count: digestResult.skipped_count,
            failed_count: digestResult.failed_count,
            dry_run: dryRun,
            per_user_summary: digestResult.per_user.map(u => ({
              user_id: u.user_id,
              username: u.username,
              status: u.status,
              sent: u.sent,
              skip_reason: u.skip_reason,
              error: u.error,
            })),
          },
        });
        logger.info(
          `当日交易日报推送完成。扫描用户 ${digestResult.scanned_users}，` +
            `已发 ${digestResult.sent_count}，跳过 ${digestResult.skipped_count}，` +
            `失败 ${digestResult.failed_count}` +
            (dryRun ? '（dry-run，未实际推送）' : '')
        );
      } else if (task.type === 'EARNINGS_FORECAST_WATCH') {
        // US-064 — 业绩预告即时提醒。`mode` 参数控制走持仓即时 (held) 还是自选
        // 盘后汇总 (watchlist)，缺省 = 'both' (持仓 + 自选都跑)。
        // `user_id` 可选 (扫单用户)；`dry_run`=true 仅预演不推送。
        const targetUserId = parameters.user_id || parameters.userId;
        const dryRun =
          parameters.dry_run !== undefined
            ? Boolean(parameters.dry_run)
            : parameters.dryRun !== undefined
            ? Boolean(parameters.dryRun)
            : false;
        const recentDays =
          parameters.recent_days !== undefined
            ? Number(parameters.recent_days)
            : parameters.recentDays !== undefined
            ? Number(parameters.recentDays)
            : undefined;
        const mode = String(parameters.mode || 'both').toLowerCase();
        const runHeld = mode === 'both' || mode === 'held';
        const runWatchlist = mode === 'both' || mode === 'watchlist';

        const heldResult = runHeld
          ? await earningsForecastWatcher.scanHeldStocks({
              user_id: targetUserId ? Number(targetUserId) : undefined,
              trade_date: parameters.trade_date || parameters.tradeDate,
              dry_run: dryRun,
              recent_days: recentDays,
            })
          : null;
        const watchlistResult = runWatchlist
          ? await earningsForecastWatcher.scanWatchlistStocks({
              user_id: targetUserId ? Number(targetUserId) : undefined,
              trade_date: parameters.trade_date || parameters.tradeDate,
              dry_run: dryRun,
              recent_days: recentDays,
            })
          : null;

        const totalSent = (heldResult?.sent_count ?? 0) + (watchlistResult?.sent_count ?? 0);
        const totalSkipped =
          (heldResult?.skipped_count ?? 0) + (watchlistResult?.skipped_count ?? 0);
        const totalFailed = (heldResult?.failed_count ?? 0) + (watchlistResult?.failed_count ?? 0);
        const totalScanned = Math.max(
          heldResult?.scanned_users ?? 0,
          watchlistResult?.scanned_users ?? 0
        );

        await this.safeUpdateExecutionLog(executionLog, {
          total_items:
            (heldResult?.scanned_forecasts ?? 0) + (watchlistResult?.scanned_forecasts ?? 0),
          completed_items: totalSent,
          failed_items: totalFailed,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
          result_summary: {
            scenario: 'earnings_forecast_watch',
            mode,
            trade_date: heldResult?.trade_date || watchlistResult?.trade_date,
            scanned_users: totalScanned,
            held: heldResult
              ? {
                  scanned_forecasts: heldResult.scanned_forecasts,
                  sent_count: heldResult.sent_count,
                  skipped_count: heldResult.skipped_count,
                  failed_count: heldResult.failed_count,
                  events: heldResult.per_event.map(e => ({
                    event_id: e.event_id,
                    symbol: e.symbol,
                    user_id: e.user_id,
                    status: e.status,
                    sent: e.sent,
                    error: e.error,
                    skip_reason: e.skip_reason,
                  })),
                }
              : null,
            watchlist: watchlistResult
              ? {
                  scanned_forecasts: watchlistResult.scanned_forecasts,
                  sent_count: watchlistResult.sent_count,
                  skipped_count: watchlistResult.skipped_count,
                  failed_count: watchlistResult.failed_count,
                  per_user: watchlistResult.per_user.map(u => ({
                    event_id: u.event_id,
                    user_id: u.user_id,
                    forecast_count: u.forecast_count,
                    status: u.status,
                    sent: u.sent,
                    error: u.error,
                    skip_reason: u.skip_reason,
                  })),
                }
              : null,
            dry_run: dryRun,
          },
        });
        logger.info(
          `业绩预告推送完成。mode=${mode}，已发 ${totalSent}，跳过 ${totalSkipped}，失败 ${totalFailed}` +
            (dryRun ? '（dry-run，未实际推送）' : '')
        );
      } else if (task.type === 'WEEKLY_REVIEW_EMAIL') {
        // US-065 — 每周一 08:00 发上周复盘邮件（HTML, SMTP via env）。
        // `user_id` 可选 (扫单用户)；`dry_run`=true 仅预演不推送；
        // `reference_date` 覆盖基准日（默认 = 上海时区当天）；
        // `upcoming_lookahead_days` 关注事件向后看天数（默认 7）。
        const targetUserId = parameters.user_id || parameters.userId;
        const dryRun =
          parameters.dry_run !== undefined
            ? Boolean(parameters.dry_run)
            : parameters.dryRun !== undefined
            ? Boolean(parameters.dryRun)
            : false;
        const lookahead =
          parameters.upcoming_lookahead_days !== undefined
            ? Number(parameters.upcoming_lookahead_days)
            : parameters.upcomingLookaheadDays !== undefined
            ? Number(parameters.upcomingLookaheadDays)
            : undefined;
        const weeklyResult = await weeklyReviewReportService.sendWeeklyReviewReports({
          user_id: targetUserId ? Number(targetUserId) : undefined,
          reference_date: parameters.reference_date || parameters.referenceDate,
          dry_run: dryRun,
          upcoming_lookahead_days: lookahead,
        });
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: weeklyResult.scanned_users,
          completed_items: weeklyResult.sent_count,
          failed_items: weeklyResult.failed_count,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
          result_summary: {
            scenario: 'weekly_review_email',
            week_start: weeklyResult.week.start_date,
            week_end: weeklyResult.week.end_date,
            week_id: weeklyResult.week.week_id,
            scanned_users: weeklyResult.scanned_users,
            sent_count: weeklyResult.sent_count,
            skipped_count: weeklyResult.skipped_count,
            failed_count: weeklyResult.failed_count,
            dry_run: dryRun,
            per_user_summary: weeklyResult.per_user.map(u => ({
              user_id: u.user_id,
              username: u.username,
              status: u.status,
              sent: u.sent,
              email_used: u.email_used,
              skip_reason: u.skip_reason,
              error: u.error,
            })),
          },
        });
        logger.info(
          `上周复盘邮件推送完成。week=${weeklyResult.week.start_date}~${weeklyResult.week.end_date}，` +
            `扫描用户 ${weeklyResult.scanned_users}，已发 ${weeklyResult.sent_count}，` +
            `跳过 ${weeklyResult.skipped_count}，失败 ${weeklyResult.failed_count}` +
            (dryRun ? '（dry-run，未实际推送）' : '')
        );
      } else if (task.type === 'DAILY_ATTRIBUTION_GENERATE') {
        // US-083 PM-006 — 工作日 17:00 给所有 active paper trading portfolio 生成 6 维
        // 归因 (factor/industry/timing/selection/sizing/execution_cost) 并 upsert 到
        // daily_attribution_reports. 单 portfolio 失败 fail-OPEN continue 不阻塞 batch.
        // `portfolio_ids` 显式 list (空 = 取所有 is_active=true); `dry_run`=true 仅算不写;
        // `date` override 默认今日 Asia/Shanghai; cron 默认零 AI 链路走 heuristic.
        /* eslint-disable @typescript-eslint/no-var-requires */
        const { runDailyAttributionGenerate } = require('./attribution/DailyAttributionCronRunner');
        /* eslint-enable @typescript-eslint/no-var-requires */
        const explicitIds: number[] = Array.isArray(parameters.portfolio_ids)
          ? parameters.portfolio_ids
              .map((x: unknown) => Number(x))
              .filter((n: number) => Number.isFinite(n) && n > 0)
          : [];
        const dryRunAttr =
          parameters.dry_run !== undefined
            ? Boolean(parameters.dry_run)
            : parameters.dryRun !== undefined
            ? Boolean(parameters.dryRun)
            : false;
        const refDate =
          typeof parameters.date === 'string' && parameters.date.length > 0
            ? parameters.date
            : typeof parameters.reference_date === 'string'
            ? parameters.reference_date
            : undefined;
        const attrSummary = await runDailyAttributionGenerate({
          date: refDate,
          portfolio_ids: explicitIds.length > 0 ? explicitIds : undefined,
          dry_run: dryRunAttr,
        });
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: attrSummary.total_portfolios,
          completed_items: attrSummary.persisted_count,
          failed_items: attrSummary.failed_count,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
          result_summary: {
            scenario: 'daily_attribution_generate',
            date: attrSummary.date,
            dry_run: attrSummary.dry_run,
            total_portfolios: attrSummary.total_portfolios,
            ok_count: attrSummary.ok_count,
            skipped_count: attrSummary.skipped_count,
            failed_count: attrSummary.failed_count,
            persisted_count: attrSummary.persisted_count,
            per_portfolio: attrSummary.per_portfolio.map((p: any) => ({
              portfolio_id: p.portfolio_id,
              status: p.status,
              reason: p.reason,
              persisted: p.persisted,
            })),
            // US-086 PM-009 — 飞书 push 摘要 (null 表示 enable_feishu_push=false 关闭)
            feishu_push: attrSummary.feishu_push
              ? {
                  scanned: attrSummary.feishu_push.scanned,
                  attempted: attrSummary.feishu_push.attempted,
                  succeeded: attrSummary.feishu_push.succeeded,
                  failed: attrSummary.feishu_push.failed,
                  skipped_reason: attrSummary.feishu_push.skipped_reason,
                }
              : null,
          },
        });
        logger.info(
          `[DAILY_ATTRIBUTION_GENERATE] date=${attrSummary.date} ` +
            `total=${attrSummary.total_portfolios} ok=${attrSummary.ok_count} ` +
            `skip=${attrSummary.skipped_count} fail=${attrSummary.failed_count} ` +
            `persisted=${attrSummary.persisted_count}${dryRunAttr ? ' (dry_run)' : ''}` +
            (attrSummary.feishu_push
              ? ` push=${attrSummary.feishu_push.succeeded}/${attrSummary.feishu_push.attempted}` +
                (attrSummary.feishu_push.skipped_reason
                  ? ` skipped=${attrSummary.feishu_push.skipped_reason}`
                  : '')
              : '')
        );
      } else if (task.type === 'AI_DIARY_GENERATE') {
        // US-091 PM-020 — 工作日 18:00 (DAILY_ATTRIBUTION_GENERATE 17:00 之后) 给所有
        // active user 生成 ≤ 500 字 AI 投资日记并 upsert ai_diary_entries.
        // `user_ids` 显式 list (空 = 取所有 is_active=true); `dry_run`=true 仅算不写;
        // `enable_llm`=true 启远端 trading_agents LLM (默认 false 走 heuristic);
        // `date` override 默认今日 Asia/Shanghai. fail-OPEN: 单 user 失败 continue 不阻塞 batch.
        /* eslint-disable @typescript-eslint/no-var-requires */
        const { runAIDiaryGenerate } = require('./postmortem/AIDiaryCronRunner');
        /* eslint-enable @typescript-eslint/no-var-requires */
        const explicitUserIds: number[] = Array.isArray(parameters.user_ids)
          ? parameters.user_ids
              .map((x: unknown) => Number(x))
              .filter((n: number) => Number.isFinite(n) && n > 0)
          : [];
        const dryRunDiary =
          parameters.dry_run !== undefined
            ? Boolean(parameters.dry_run)
            : parameters.dryRun !== undefined
            ? Boolean(parameters.dryRun)
            : false;
        const enableLlmDiary =
          parameters.enable_llm !== undefined
            ? Boolean(parameters.enable_llm)
            : parameters.enableLlm !== undefined
            ? Boolean(parameters.enableLlm)
            : false;
        const refDateDiary =
          typeof parameters.date === 'string' && parameters.date.length > 0
            ? parameters.date
            : typeof parameters.reference_date === 'string'
            ? parameters.reference_date
            : undefined;
        const diarySummary = await runAIDiaryGenerate({
          date: refDateDiary,
          user_ids: explicitUserIds.length > 0 ? explicitUserIds : undefined,
          dry_run: dryRunDiary,
          enable_llm: enableLlmDiary,
        });
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: diarySummary.total_users,
          completed_items: diarySummary.persisted_count,
          failed_items: diarySummary.failed_count,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
          result_summary: {
            scenario: 'ai_diary_generate',
            date: diarySummary.date,
            dry_run: diarySummary.dry_run,
            enable_llm: diarySummary.enable_llm,
            cron_run_id: diarySummary.cron_run_id,
            total_users: diarySummary.total_users,
            ok_count: diarySummary.ok_count,
            skipped_count: diarySummary.skipped_count,
            failed_count: diarySummary.failed_count,
            persisted_count: diarySummary.persisted_count,
            per_user: diarySummary.per_user.map((u: any) => ({
              user_id: u.user_id,
              status: u.status,
              reason: u.reason,
              persisted: u.persisted,
            })),
          },
        });
        logger.info(
          `[AI_DIARY_GENERATE] date=${diarySummary.date} ` +
            `total=${diarySummary.total_users} ok=${diarySummary.ok_count} ` +
            `skip=${diarySummary.skipped_count} fail=${diarySummary.failed_count} ` +
            `persisted=${diarySummary.persisted_count}` +
            `${diarySummary.enable_llm ? ' llm=on' : ' llm=off'}` +
            `${dryRunDiary ? ' (dry_run)' : ''}`
        );
      } else if (task.type === 'WEEKLY_ERROR_PATTERN_AGGREGATE') {
        // US-093 PM-022 — 周日 10:00 给所有 active user 聚合最近 90 天
        // DailyAttributionReport → upsert error_pattern_reports. `user_ids` 显式
        // list (空 = 取所有 is_active=true); `dry_run`=true 仅标记 (cron-side 仍
        // 跑全 user); `period_end` 默认今日 Asia/Shanghai; `lookback_days` 默认 90.
        // fail-OPEN: 单 user 失败 continue 不阻塞 batch.
        /* eslint-disable @typescript-eslint/no-var-requires */
        const { runWeeklyErrorPattern } = require('./postmortem/ErrorPatternCronRunner');
        /* eslint-enable @typescript-eslint/no-var-requires */
        const explicitEpUserIds: number[] = Array.isArray(parameters.user_ids)
          ? parameters.user_ids
              .map((x: unknown) => Number(x))
              .filter((n: number) => Number.isFinite(n) && n > 0)
          : [];
        const dryRunEp =
          parameters.dry_run !== undefined
            ? Boolean(parameters.dry_run)
            : parameters.dryRun !== undefined
            ? Boolean(parameters.dryRun)
            : false;
        const periodEndEp =
          typeof parameters.period_end === 'string' && parameters.period_end.length > 0
            ? parameters.period_end
            : typeof parameters.date === 'string' && parameters.date.length > 0
            ? parameters.date
            : undefined;
        const lookbackDaysEp =
          parameters.lookback_days !== undefined
            ? Number(parameters.lookback_days)
            : parameters.lookbackDays !== undefined
            ? Number(parameters.lookbackDays)
            : undefined;
        const epSummary = await runWeeklyErrorPattern({
          period_end: periodEndEp,
          lookback_days: lookbackDaysEp,
          user_ids: explicitEpUserIds.length > 0 ? explicitEpUserIds : undefined,
          dry_run: dryRunEp,
        });
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: epSummary.total_users,
          completed_items: epSummary.persisted_count,
          failed_items: epSummary.failed_count,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
          result_summary: {
            scenario: 'weekly_error_pattern_aggregate',
            period_end: epSummary.period_end,
            lookback_days: epSummary.lookback_days,
            dry_run: epSummary.dry_run,
            cron_run_id: epSummary.cron_run_id,
            total_users: epSummary.total_users,
            ok_count: epSummary.ok_count,
            skipped_count: epSummary.skipped_count,
            failed_count: epSummary.failed_count,
            persisted_count: epSummary.persisted_count,
            per_user: epSummary.per_user.map((u: any) => ({
              user_id: u.user_id,
              status: u.status,
              reason: u.reason,
              persisted: u.persisted,
            })),
          },
        });
        logger.info(
          `[WEEKLY_ERROR_PATTERN_AGGREGATE] period_end=${epSummary.period_end} ` +
            `lookback_days=${epSummary.lookback_days} ` +
            `total=${epSummary.total_users} ok=${epSummary.ok_count} ` +
            `skip=${epSummary.skipped_count} fail=${epSummary.failed_count} ` +
            `persisted=${epSummary.persisted_count}${dryRunEp ? ' (dry_run)' : ''}`
        );
      } else if (task.type === 'MARKET_BRIEF_GENERATE') {
        // US-073 — 每个交易日 08:30 生成「AI 大盘速读」当日卡片。
        // 5 维数据：沪深300 上日收盘 / 今日开盘 / 北向资金 / 涨停数 / AI 一句话观点。
        // 写入 market_briefs 表（一日一行 UPSERT），前端 TodayWorkspace 顶部
        // GET /api/ai/market-brief/today 直接读取。
        const tradeDate = parameters.trade_date || parameters.tradeDate || undefined;
        const dryRun =
          parameters.dry_run !== undefined
            ? Boolean(parameters.dry_run)
            : parameters.dryRun !== undefined
            ? Boolean(parameters.dryRun)
            : false;
        const skipAI =
          parameters.skip_ai !== undefined
            ? Boolean(parameters.skip_ai)
            : parameters.skipAi !== undefined
            ? Boolean(parameters.skipAi)
            : false;
        const briefResult = await marketBriefService.computeAndPersist({
          trade_date: tradeDate,
          dry_run: dryRun,
          skip_ai: skipAI,
        });
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: 5,
          completed_items:
            briefResult.status === 'failed' ? 0 : briefResult.status === 'partial' ? 3 : 5,
          failed_items:
            briefResult.status === 'failed' ? 5 : briefResult.status === 'partial' ? 2 : 0,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
          result_summary: {
            scenario: 'market_brief_generate',
            trade_date: briefResult.trade_date,
            status: briefResult.status,
            persisted: briefResult.persisted,
            dry_run: briefResult.dry_run,
            nlp_engine: briefResult.nlp_engine,
            ai_view_chars: briefResult.ai_view ? briefResult.ai_view.length : 0,
            prev_close: briefResult.prev_close,
            today_open: briefResult.today_open,
            open_change_pct: briefResult.open_change_pct,
            northbound_net_amount: briefResult.northbound_net_amount,
            limit_up_count: briefResult.limit_up_count,
            message: briefResult.message,
          },
        });
        logger.info(
          `AI 大盘速读生成完成。trade_date=${briefResult.trade_date} status=${briefResult.status} ` +
            `engine=${briefResult.nlp_engine || '—'} persisted=${briefResult.persisted}` +
            (dryRun ? '（dry-run，未写表）' : '')
        );
      } else if (task.type === 'ENHANCED_TRADING_JOURNAL_GENERATE') {
        // US-087 — 每个交易日 15:30 收盘后批量生成增强版 AI 复盘日记。
        // 5 段 markdown 输出：## 今日战报 / ## 操作复盘 / ## 市场观察 / ## 明日策略 / ## 风险提醒。
        // 写入 trading_journals 表（保留 user_notes 不动）。
        // `user_id` 缺省 = 扫所有 is_active 用户；`overwrite_hand_edited`=true 让 admin force-regen。
        // `dry_run`=true 让 ops 预演 markdown 不实际写表。
        const targetUserId = parameters.user_id || parameters.userId;
        const journalDryRun =
          parameters.dry_run !== undefined
            ? Boolean(parameters.dry_run)
            : parameters.dryRun !== undefined
            ? Boolean(parameters.dryRun)
            : false;
        const overwriteHandEdited =
          parameters.overwrite_hand_edited !== undefined
            ? Boolean(parameters.overwrite_hand_edited)
            : parameters.overwriteHandEdited !== undefined
            ? Boolean(parameters.overwriteHandEdited)
            : false;
        const journalSkipAI =
          parameters.skip_ai !== undefined
            ? Boolean(parameters.skip_ai)
            : parameters.skipAi !== undefined
            ? Boolean(parameters.skipAi)
            : false;
        const journalResult = await enhancedTradingJournalService.generateForAll({
          user_id: targetUserId ? Number(targetUserId) : undefined,
          trade_date: parameters.trade_date || parameters.tradeDate,
          dry_run: journalDryRun,
          overwrite_hand_edited: overwriteHandEdited,
          skip_ai: journalSkipAI,
        });
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: journalResult.scanned_users,
          completed_items: journalResult.generated_count + journalResult.partial_count,
          failed_items: journalResult.failed_count,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
          result_summary: {
            scenario: 'enhanced_trading_journal_generate',
            trade_date: journalResult.trade_date,
            scanned_users: journalResult.scanned_users,
            generated_count: journalResult.generated_count,
            partial_count: journalResult.partial_count,
            skipped_count: journalResult.skipped_count,
            failed_count: journalResult.failed_count,
            dry_run: journalDryRun,
            per_user_summary: journalResult.per_user.map(u => ({
              user_id: u.user_id,
              username: u.username,
              status: u.status,
              persisted: u.persisted,
              saved_row_id: u.saved_row_id,
              skip_reason: u.skip_reason,
              error: u.error,
            })),
          },
        });
        logger.info(
          `AI 复盘日记生成完成。trade_date=${journalResult.trade_date} 扫描用户 ${journalResult.scanned_users}，` +
            `生成 ${journalResult.generated_count}，部分 ${journalResult.partial_count}，` +
            `跳过 ${journalResult.skipped_count}，失败 ${journalResult.failed_count}` +
            (journalDryRun ? '（dry-run，未实际写表）' : '')
        );
      } else if (task.type === 'AUTO_RECOMMENDATION_LOOP') {
        const result = await automatedRecommendationLoopService.run({
          username: parameters.username || 'stock',
          ...portfolioParams,
          universe: parameters.universe === 'favorites' ? 'favorites' : 'market',
          style: ['balanced', 'momentum', 'value', 'low_risk'].includes(parameters.style)
            ? parameters.style
            : 'balanced',
          candidate_limit: this.toPositiveInt(parameters.candidate_limit, 30, 100),
          candidate_pool_limit: this.toPositiveInt(parameters.candidate_pool_limit, 360, 1000),
          lookback_days: this.toPositiveInt(parameters.lookback_days, 120, 360),
          min_bars: this.toPositiveInt(parameters.min_bars, 35, 120),
          exclude_st:
            parameters.exclude_st !== undefined
              ? Boolean(parameters.exclude_st)
              : parameters.excludeSt !== undefined
              ? Boolean(parameters.excludeSt)
              : true,
          min_market_cap_yi:
            parameters.min_market_cap_yi !== undefined
              ? Number(parameters.min_market_cap_yi)
              : parameters.minMarketCapYi !== undefined
              ? Number(parameters.minMarketCapYi)
              : 30,
          archive_limit: this.toPositiveInt(parameters.archive_limit, 30, 100),
          verify_signals:
            parameters.verify_signals !== undefined
              ? Boolean(parameters.verify_signals)
              : parameters.verifySignals !== undefined
              ? Boolean(parameters.verifySignals)
              : true,
          run_paper_trading:
            parameters.run_paper_trading !== undefined
              ? Boolean(parameters.run_paper_trading)
              : parameters.runPaperTrading !== undefined
              ? Boolean(parameters.runPaperTrading)
              : true,
          dry_run:
            parameters.dry_run !== undefined
              ? Boolean(parameters.dry_run)
              : parameters.dryRun !== undefined
              ? Boolean(parameters.dryRun)
              : false,
          paper_trade_limit: this.toPositiveInt(parameters.paper_trade_limit, 3, 20),
          paper_trade_scan_limit: this.toPositiveInt(parameters.paper_trade_scan_limit, 150, 500),
          min_score: Number(parameters.min_score || parameters.minScore || 72),
          max_positions: this.toPositiveInt(parameters.max_positions, 8, 30),
          default_position_pct: Number(
            parameters.default_position_pct || parameters.defaultPositionPct || 5
          ),
          max_position_pct: Number(parameters.max_position_pct || parameters.maxPositionPct || 10),
          min_trade_amount: Number(
            parameters.min_trade_amount || parameters.minTradeAmount || 3000
          ),
          use_outcome_feedback:
            parameters.use_outcome_feedback !== undefined
              ? Boolean(parameters.use_outcome_feedback)
              : parameters.useOutcomeFeedback !== undefined
              ? Boolean(parameters.useOutcomeFeedback)
              : true,
          use_policy_version_feedback:
            parameters.use_policy_version_feedback !== undefined
              ? Boolean(parameters.use_policy_version_feedback)
              : parameters.usePolicyVersionFeedback !== undefined
              ? Boolean(parameters.usePolicyVersionFeedback)
              : true,
          policy_version_lookback_limit: this.toPositiveInt(
            parameters.policy_version_lookback_limit || parameters.policyVersionLookbackLimit,
            120,
            1000
          ),
          use_strategy_experiment_feedback:
            parameters.use_strategy_experiment_feedback !== undefined
              ? Boolean(parameters.use_strategy_experiment_feedback)
              : parameters.useStrategyExperimentFeedback !== undefined
              ? Boolean(parameters.useStrategyExperimentFeedback)
              : true,
          strategy_experiment_min_quality_delta: Number(
            parameters.strategy_experiment_min_quality_delta ||
              parameters.strategyExperimentMinQualityDelta ||
              4
          ),
          strategy_experiment_limit: this.toPositiveInt(
            parameters.strategy_experiment_limit || parameters.strategyExperimentLimit,
            12,
            50
          ),
          strategy_experiment_pool_limit: this.toPositiveInt(
            parameters.strategy_experiment_pool_limit || parameters.strategyExperimentPoolLimit,
            240,
            1000
          ),
          outcome_feedback_lookback_days: this.toPositiveInt(
            parameters.outcome_feedback_lookback_days || parameters.outcomeFeedbackLookbackDays,
            365,
            3650
          ),
          outcome_feedback_min_closed_samples: this.toPositiveInt(
            parameters.outcome_feedback_min_closed_samples ||
              parameters.outcomeFeedbackMinClosedSamples,
            5,
            100
          ),
          use_profit_gate:
            parameters.use_profit_gate !== undefined
              ? Boolean(parameters.use_profit_gate)
              : parameters.useProfitGate !== undefined
              ? Boolean(parameters.useProfitGate)
              : true,
          profit_gate_horizon:
            parameters.profit_gate_horizon || parameters.profitGateHorizon || '5d',
          profit_gate_min_samples: this.toPositiveInt(
            parameters.profit_gate_min_samples || parameters.profitGateMinSamples,
            5,
            100
          ),
          profit_gate_min_quality_score: Number(
            parameters.profit_gate_min_quality_score || parameters.profitGateMinQualityScore || 45
          ),
          use_entry_risk_guard:
            parameters.use_entry_risk_guard !== undefined
              ? Boolean(parameters.use_entry_risk_guard)
              : parameters.useEntryRiskGuard !== undefined
              ? Boolean(parameters.useEntryRiskGuard)
              : true,
          max_daily_new_positions: this.toPositiveInt(
            parameters.max_daily_new_positions || parameters.maxDailyNewPositions,
            3,
            20
          ),
          max_daily_new_exposure_pct: Number(
            parameters.max_daily_new_exposure_pct || parameters.maxDailyNewExposurePct || 12
          ),
          max_total_exposure_pct: Number(
            parameters.max_total_exposure_pct || parameters.maxTotalExposurePct || 60
          ),
          max_industry_exposure_pct: Number(
            parameters.max_industry_exposure_pct || parameters.maxIndustryExposurePct || 25
          ),
          min_cash_reserve_pct: Number(
            parameters.min_cash_reserve_pct || parameters.minCashReservePct || 8
          ),
          max_portfolio_drawdown_pct: Number(
            parameters.max_portfolio_drawdown_pct || parameters.maxPortfolioDrawdownPct || 12
          ),
          max_single_stock_volatility_pct: Number(
            parameters.max_single_stock_volatility_pct ||
              parameters.maxSingleStockVolatilityPct ||
              7
          ),
          max_position_correlation: Number(
            parameters.max_position_correlation || parameters.maxPositionCorrelation || 0.82
          ),
          max_portfolio_var_pct: Number(
            parameters.max_portfolio_var_pct || parameters.maxPortfolioVarPct || 10
          ),
          min_avg_turnover_yuan: Number(
            parameters.min_avg_turnover_yuan || parameters.minAvgTurnoverYuan || 30000000
          ),
          cooldown_days_after_loss: this.toPositiveInt(
            parameters.cooldown_days_after_loss || parameters.cooldownDaysAfterLoss,
            12,
            120
          ),
          block_limit_up:
            parameters.block_limit_up !== undefined
              ? Boolean(parameters.block_limit_up)
              : parameters.blockLimitUp !== undefined
              ? Boolean(parameters.blockLimitUp)
              : true,
          block_limit_down:
            parameters.block_limit_down !== undefined
              ? Boolean(parameters.block_limit_down)
              : parameters.blockLimitDown !== undefined
              ? Boolean(parameters.blockLimitDown)
              : true,
          block_suspended:
            parameters.block_suspended !== undefined
              ? Boolean(parameters.block_suspended)
              : parameters.blockSuspended !== undefined
              ? Boolean(parameters.blockSuspended)
              : true,
          agent_auto_paper_trade:
            parameters.agent_auto_paper_trade !== undefined
              ? Boolean(parameters.agent_auto_paper_trade)
              : parameters.agentAutoPaperTrade !== undefined
              ? Boolean(parameters.agentAutoPaperTrade)
              : true,
          agent_only_auto_paper_trade:
            parameters.agent_only_auto_paper_trade !== undefined
              ? Boolean(parameters.agent_only_auto_paper_trade)
              : parameters.agentOnlyAutoPaperTrade !== undefined
              ? Boolean(parameters.agentOnlyAutoPaperTrade)
              : true,
          agent_only_paper_trade_min_score: Number(
            parameters.agent_only_paper_trade_min_score ||
              parameters.agentOnlyPaperTradeMinScore ||
              parameters.agent_min_score ||
              parameters.agentMinScore ||
              72
          ),
          agent_only_paper_trade_max_positions: this.toPositiveInt(
            parameters.agent_only_paper_trade_max_positions ||
              parameters.agentOnlyPaperTradeMaxPositions ||
              parameters.max_positions ||
              parameters.maxPositions,
            8,
            30
          ),
          agent_only_paper_trade_default_position_pct: Number(
            parameters.agent_only_paper_trade_default_position_pct ||
              parameters.agentOnlyPaperTradeDefaultPositionPct ||
              4
          ),
          agent_only_paper_trade_max_position_pct: Number(
            parameters.agent_only_paper_trade_max_position_pct ||
              parameters.agentOnlyPaperTradeMaxPositionPct ||
              8
          ),
          agent_only_paper_trade_min_trade_amount: Number(
            parameters.agent_only_paper_trade_min_trade_amount ||
              parameters.agentOnlyPaperTradeMinTradeAmount ||
              parameters.min_trade_amount ||
              parameters.minTradeAmount ||
              3000
          ),
          submit_agent_analysis:
            parameters.submit_agent_analysis !== undefined
              ? Boolean(parameters.submit_agent_analysis)
              : parameters.submitAgentAnalysis !== undefined
              ? Boolean(parameters.submitAgentAnalysis)
              : true,
          agent_max_count: this.toPositiveInt(parameters.agent_max_count, 5, 10),
          agent_min_score: Number(parameters.agent_min_score || parameters.agentMinScore || 72),
          agent_session: parameters.agent_session || parameters.agentSession || 'close',
          target_date: parameters.target_date || parameters.targetDate || today,
          task_label: task.name,
          execution_log_id: executionLog?.id,
          report_to_feishu:
            parameters.report_to_feishu !== undefined
              ? Boolean(parameters.report_to_feishu)
              : parameters.reportToFeishu !== undefined
              ? Boolean(parameters.reportToFeishu)
              : true,
          record_type: parameters.record_type || parameters.recordType || '全市场荐股闭环',
        });

        await this.safeUpdateExecutionLog(executionLog, {
          total_items: result.generated?.total_candidates || 0,
          completed_items: result.generated?.analyzed_candidates || 0,
          failed_items: result.paper_trading?.skipped || 0,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
        });

        logger.info(
          `全市场荐股闭环完成。候选 ${result.generated?.analyzed_candidates}/${
            result.generated?.total_candidates
          }，归档 ${result.archive?.total}，模拟盘 ${
            result.paper_trading?.executed ?? result.paper_trading?.planned ?? 0
          }`
        );
      } else if (task.type === 'AI_DAILY_SCREENER') {
        logger.info('触发 AI_DAILY_SCREENER 任务，使用多因子候选池进行 TradingAgents 深度分析...');

        const candidateLimit = Math.min(
          Number(parameters.candidate_limit || parameters.limit || 10),
          30
        );
        const universe = parameters.universe === 'market' ? 'market' : 'favorites';
        const style = ['balanced', 'momentum', 'value', 'low_risk'].includes(parameters.style)
          ? parameters.style
          : 'balanced';
        const targetDate = parameters.target_date || today;

        const candidateResult = await quantRecommendationService.generateRecommendations({
          universe,
          style,
          limit: candidateLimit,
          lookback_days: Number(parameters.lookback_days || 120),
          candidate_pool_limit: this.toPositiveInt(parameters.candidate_pool_limit, 240, 1000),
          exclude_st:
            parameters.exclude_st !== undefined
              ? Boolean(parameters.exclude_st)
              : parameters.excludeSt !== undefined
              ? Boolean(parameters.excludeSt)
              : true,
          min_market_cap_yi:
            parameters.min_market_cap_yi !== undefined
              ? Number(parameters.min_market_cap_yi)
              : parameters.minMarketCapYi !== undefined
              ? Number(parameters.minMarketCapYi)
              : 30,
          include_trend: false,
        });

        const candidates = candidateResult.recommendations;
        let count = 0;
        let failed = 0;

        await this.safeUpdateExecutionLog(executionLog, { total_items: candidates.length });

        for (const candidate of candidates) {
          try {
            const res = await aiAdvisorService.analyzeStock(candidate.symbol, targetDate, true);
            if (res && res.task_id) {
              const pollingJobOptions = buildAIPollingJobOptions({ taskId: res.task_id });
              if (!pollingJobOptions) {
                logger.warn(`跳过股票 ${candidate.symbol} 入队: TradingAgents 返回的 task_id 非法`);
                failed++;
                continue;
              }
              await aiPollingQueue.add(
                {
                  taskId: res.task_id,
                  symbol: candidate.symbol,
                  name: candidate.name,
                  executionLogId: executionLog?.id,
                  taskLabel: task.name,
                  quant_score: candidate.score,
                  quant_factors: candidate.factors,
                  quant_reasons: candidate.reasons,
                  quant_warnings: candidate.warnings,
                  data_quality_score: candidate.data_quality_score,
                  data_quality_bucket: candidate.data_quality_bucket,
                  data_quality: candidate.data_quality,
                  recommendation_style: style,
                  recommendation_source: universe,
                  agent_session: parameters.agent_session,
                },
                // US-019 / EX-005: jobId/attempts/backoff/retention 统一由 aiPollingEnqueue 单点供给.
                pollingJobOptions
              );
              count++;
            }
          } catch (err: any) {
            logger.error(`提交股票 ${candidate.symbol} 的 AI 分析任务失败:`, err);
            failed++;
          }
        }

        logger.info(
          `AI_DAILY_SCREENER 候选任务提交完成，候选池 ${candidateResult.analyzed_candidates}/${candidateResult.total_candidates}，成功提交 ${count} 个异步分析任务`
        );

        // 状态保留为 IN_PROGRESS，由 bull worker 来更新为 COMPLETED 或 FAILED
        await this.safeUpdateExecutionLog(executionLog, { failed_items: failed });
        // 如果没有成功提交的任务，说明已经结束了
        if (count === 0) {
          await this.safeUpdateExecutionLog(executionLog, {
            status: 'COMPLETED',
            completed_at: new Date(),
          });
          await feishuTaskReportService.reportTaskExecutionLog(executionLog, {
            record_type: 'AI定时任务完成',
            task_type: 'AI_DAILY_SCREENER',
            result: { message: '无候选股票成功提交 AI 分析任务', submitted: count, failed },
          });
        }
      } else if (task.type === 'CLEANUP_OLD_DATA') {
        // US-097 — 每周日凌晨 3 点跑旧数据清理:
        //   - quant_backtest_tasks + cascade results/trades (默认 90 天)
        //   - data_update_logs (默认 180 天)
        //   - task_execution_logs (默认 180 天)
        //   - risk_alerts where is_read=true (默认 30 天)
        // 默认 dry_run=false (scheduler 触发是为了真正清理); 手动 CLI 默认
        // dry_run=true (CLI 必须 --confirm 才执行).
        // 白名单 whitelist_strategies 跳过 strategy_keys 交集非空的 backtest task.
        const dryRunForCleanup =
          parameters.dry_run !== undefined
            ? Boolean(parameters.dry_run)
            : parameters.dryRun !== undefined
            ? Boolean(parameters.dryRun)
            : false;
        const cleanupResult = await cleanupOldDataService.cleanup({
          backtestRetentionDays:
            parameters.backtest_retention_days ?? parameters.backtestRetentionDays,
          logRetentionDays: parameters.log_retention_days ?? parameters.logRetentionDays,
          alertRetentionDays: parameters.alert_retention_days ?? parameters.alertRetentionDays,
          whitelistStrategies: Array.isArray(parameters.whitelist_strategies)
            ? parameters.whitelist_strategies
            : Array.isArray(parameters.whitelistStrategies)
            ? parameters.whitelistStrategies
            : [],
          dryRun: dryRunForCleanup,
        });
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: cleanupResult.targets.length,
          completed_items: cleanupResult.targets.length - cleanupResult.errors.length,
          failed_items: cleanupResult.errors.length,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message:
            cleanupResult.errors.length > 0
              ? `${cleanupResult.errors.length} target(s) failed: ${cleanupResult.errors.join(
                  ', '
                )}`
              : null,
          result_summary: {
            scenario: 'cleanup_old_data',
            as_of: cleanupResult.as_of,
            mode: cleanupResult.mode,
            total_count: cleanupResult.total_count,
            total_cascade_count: cleanupResult.total_cascade_count,
            whitelist_skipped_total: cleanupResult.whitelist_skipped_total,
            errors: cleanupResult.errors,
            targets: cleanupResult.targets.map(t => ({
              target: t.target,
              count: t.count,
              cascade_count: t.cascade_count,
              cutoff: t.cutoff,
              executed: t.executed,
              whitelist_skipped: t.whitelist_skipped,
              error: t.error,
            })),
          },
        });
        logger.info(
          `[CLEANUP_OLD_DATA] mode=${cleanupResult.mode} total_count=${cleanupResult.total_count} ` +
            `total_cascade=${cleanupResult.total_cascade_count} ` +
            `whitelist_skipped=${cleanupResult.whitelist_skipped_total} errors=${cleanupResult.errors.length}`
        );
      } else if (task.type === 'WEBHOOK_FALLBACK_RETRY') {
        // US-095 OPS-006 — 每 5min 扫 webhook_fallback_log status='pending' AND
        // next_retry_at <= NOW(), 透传 sender 重投递; 成功 → status='sent', 失败
        // attempts+=1 + 指数 backoff; attempts >= max_attempts → status='dead'.
        // dispatchers 把 row.scenario (sendDailyDigestCard / sendRiskAlertCard / etc)
        // 映射到真实 sender. 主流程 (FeishuBotWebhookService) 已 fail-OPEN, 本 cron
        // 是"为了不丢消息"的第二道防线; retryPendingFallbacks 自身永不 throw.
        /* eslint-disable @typescript-eslint/no-var-requires */
        const { retryPendingFallbacks } = require('./webhookFailOpen');
        const { feishuBotWebhookService } = require('./FeishuBotWebhookService');
        /* eslint-enable @typescript-eslint/no-var-requires */
        const limitWebhook = Number.isFinite(Number(parameters.limit))
          ? Number(parameters.limit)
          : undefined;
        // dispatchers — 按 scenario 名映射到真实 sender. payload 即首次失败时
        // INSERT 的 args (含 webhookUrl / body / options 等); webhook_url 仍走 row
        // (env 改了不影响在飞历史告警).
        const webhookDispatchers: Record<string, any> = {
          sendDailyDigestCard: async (payload: Record<string, unknown>, row: any) =>
            feishuBotWebhookService.sendDailyDigestCard(
              payload?.payload,
              String(row.webhook_url || ''),
              { buildCard: () => payload?.cardBody }
            ),
        };
        const webhookSummary = await retryPendingFallbacks({
          dispatchers: webhookDispatchers,
          limit: limitWebhook,
          now: new Date(),
        });
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: webhookSummary.total,
          completed_items: webhookSummary.sent_count,
          failed_items: webhookSummary.retry_failed_count + webhookSummary.dead_count,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
          result_summary: {
            scenario: 'webhook_fallback_retry',
            total: webhookSummary.total,
            sent_count: webhookSummary.sent_count,
            retry_failed_count: webhookSummary.retry_failed_count,
            dead_count: webhookSummary.dead_count,
            skipped_unknown_scenario_count: webhookSummary.skipped_unknown_scenario_count,
          },
        });
        logger.info(
          `[WEBHOOK_FALLBACK_RETRY] total=${webhookSummary.total} sent=${webhookSummary.sent_count} ` +
            `retry_failed=${webhookSummary.retry_failed_count} dead=${webhookSummary.dead_count} ` +
            `skipped_unknown=${webhookSummary.skipped_unknown_scenario_count}`
        );
      } else if (task.type === 'DB_BACKUP') {
        // US-096 OPS-007 — 每日 02:00 跑 scripts/backup-db.sh: pg_dump → gzip →
        // backups/YYYY-MM-DD.sql.gz; shell 自带 retention 30d purge.
        // 服务层 fail-OPEN: spawn 失败仅写 failed_items=1 + warn 不抛.
        // parameters.dry_run=true → 仅扫现有备份不真跑 (供 ops 在 prod cron 前预览).
        /* eslint-disable @typescript-eslint/no-var-requires */
        const { runDbBackup, getProductionBackupRunner } = require('./DbBackupService');
        /* eslint-enable @typescript-eslint/no-var-requires */
        const dryRunBackup =
          parameters.dry_run !== undefined
            ? Boolean(parameters.dry_run)
            : parameters.dryRun !== undefined
            ? Boolean(parameters.dryRun)
            : false;
        const retentionOverride =
          parameters.retention_days !== undefined
            ? parameters.retention_days
            : parameters.retentionDays;
        const timeoutOverride =
          parameters.timeout_ms !== undefined ? parameters.timeout_ms : parameters.timeoutMs;
        const backupDirOverride =
          typeof parameters.backup_dir === 'string' && parameters.backup_dir.length > 0
            ? parameters.backup_dir
            : typeof parameters.backupDir === 'string' && parameters.backupDir.length > 0
            ? parameters.backupDir
            : undefined;
        const backupResult = await runDbBackup(getProductionBackupRunner(), {
          dry_run: dryRunBackup,
          retentionDaysOverride: retentionOverride,
          timeoutMsOverride: timeoutOverride,
          backupDirOverride,
        });
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: 1,
          completed_items: backupResult.success ? 1 : 0,
          failed_items: backupResult.success ? 0 : 1,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: backupResult.error || null,
          result_summary: {
            scenario: 'db_backup',
            dry_run: backupResult.dry_run,
            backup_dir: backupResult.backup_dir,
            retention_days: backupResult.retention_days,
            file_count: backupResult.files.length,
            latest_backup_file: backupResult.latest_backup_file
              ? {
                  name: backupResult.latest_backup_file.name,
                  size_bytes: backupResult.latest_backup_file.size_bytes,
                  mtime_iso: backupResult.latest_backup_file.mtime_iso,
                  abs_path: backupResult.latest_backup_file.abs_path,
                }
              : null,
            spawn_elapsed_ms: backupResult.spawn?.elapsed_ms ?? null,
            spawn_status: backupResult.spawn?.status ?? null,
            spawn_timed_out: backupResult.spawn?.timed_out ?? false,
            error: backupResult.error || null,
          },
        });
        const latestName = backupResult.latest_backup_file?.name ?? 'none';
        if (backupResult.success) {
          logger.info(
            `[DB_BACKUP] success dry_run=${backupResult.dry_run} files=${backupResult.files.length} ` +
              `latest=${latestName} elapsed_ms=${backupResult.spawn?.elapsed_ms ?? 0}`
          );
        } else {
          logger.warn(`[DB_BACKUP] FAIL ${backupResult.error || 'unknown_error'}`);
        }
      } else if (task.type === 'EXTRA_DIMS_SYNC') {
        // 新维度同步 — 走 child_process 调用 sync:extra-dims CLI 复用既有逻辑
        const dims: string[] = Array.isArray(parameters.dims)
          ? parameters.dims
          : ['macro', 'qvix', 'block'];
        const blockDays: number = this.toPositiveInt(parameters.block_days, 7, 60);
        const results: Record<string, string> = {};
        // BJ-6: spawnSync replaced by runScriptAsync, no longer need require
        const path = require('path');
        const scriptPath = path.resolve(__dirname, '..', 'scripts', 'sync-extra-dims.ts');
        for (const dim of dims) {
          const args = [
            'node_modules/.bin/ts-node',
            '--transpile-only',
            scriptPath,
            `--dim=${dim}`,
          ];
          if (dim === 'block') {
            const today = moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
            const start = moment()
              .tz('Asia/Shanghai')
              .subtract(blockDays, 'days')
              .format('YYYY-MM-DD');
            args.push(`--start=${start}`, `--end=${today}`);
          }
          const t0 = Date.now();
          // BJ-6 (2026-06-23): 换 runScriptAsync 防 event loop 阻塞 (跟 BJ-5 BH-2/BH-3 同款)
          const r = await this.runScriptAsync('/usr/bin/node', args, {
            cwd: path.resolve(__dirname, '..', '..'),
            timeoutMs: 10 * 60_000,
          });
          const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
          if (r.code === 0) {
            results[dim] = `OK ${elapsed}s`;
            logger.info(`[EXTRA_DIMS_SYNC] ${dim} OK ${elapsed}s`);
          } else {
            results[dim] = `FAIL code=${r.code} ${(r.stderr || '').substring(0, 200)}`;
            logger.warn(`[EXTRA_DIMS_SYNC] ${dim} FAIL code=${r.code}`);
          }
        }
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: dims.length,
          success_count: Object.values(results).filter(v => v.startsWith('OK')).length,
          failed_count: Object.values(results).filter(v => !v.startsWith('OK')).length,
          result_summary: { scenario: 'extra_dims_sync', dims, results },
        });
        logger.info(`[EXTRA_DIMS_SYNC] done: ${JSON.stringify(results)}`);
      } else if (task.type === 'FACTOR_SCORE_COMPUTE') {
        // Sprint 40 (你提的优先级 #1): 每日盘后 factor_scores 生成任务.
        // 之前只有 FACTOR_IC_COMPUTE 没有 FACTOR_SCORE_COMPUTE — IC 算的前提是
        // factor_scores 表已生成. 现在加这个 task, cron 配比 IC 早 30 分钟,
        // 确保 IC 跑时 factor_scores 已就位.
        //
        // 调 compute-factors CLI; date 默认今天, factors 空跑全部 20 个.
        //
        // Batch AH review pt.2 (2026-06-18): 之前用 ts-node 跑 .ts 源在 prod
        // 报 'Cannot find module ./compute-factors.ts' — prod dist 模式 ts-node
        // 是 dev dep 且 .ts 源不复制. 改用 /usr/bin/node 直接跑 dist/scripts/compute-factors.js.
        const path = require('path');
        // __dirname in prod = dist/services, 上一级 = dist, scripts/compute-factors.js 就在 dist 内
        const compiledScript = path.resolve(__dirname, '..', 'scripts', 'compute-factors.js');
        const date: string =
          parameters.date ||
          parameters.trade_date ||
          moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
        const factorNames: string[] = Array.isArray(parameters.factor_names)
          ? parameters.factor_names
          : Array.isArray(parameters.factors)
          ? parameters.factors
          : [];
        const args = [compiledScript, `--date=${date}`];
        if (factorNames.length) args.push(`--factors=${factorNames.join(',')}`);
        // 默认 skip 仅在数据缺失时拖整流程的几个事件因子 (用户可在 task params 里 override)
        const skipFactors: string[] = Array.isArray(parameters.skip) ? parameters.skip : [];
        if (skipFactors.length) args.push(`--skip=${skipFactors.join(',')}`);
        const t0 = Date.now();
        // BJ-6 (2026-06-23): runScriptAsync 防 event loop 阻塞 30min
        const r = await this.runScriptAsync('/usr/bin/node', args, {
          cwd: path.resolve(__dirname, '..', '..'),
          timeoutMs: 30 * 60_000, // 20 个 factor × 上千股, 给 30 min 上限
        });
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        const ok = r.code === 0;
        if (ok) {
          logger.info(
            `[FACTOR_SCORE_COMPUTE] done in ${elapsed}s for date=${date} factors=${
              factorNames.length || 'all'
            }`
          );
        } else {
          logger.warn(
            `[FACTOR_SCORE_COMPUTE] failed code=${r.code} after ${elapsed}s: ${(
              r.stderr || ''
            ).substring(0, 200)}`
          );
        }
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: factorNames.length || 1,
          success_count: ok ? factorNames.length || 1 : 0,
          failed_count: ok ? 0 : 1,
          result_summary: {
            scenario: 'factor_score_compute',
            date,
            factor_names: factorNames,
            skip: skipFactors,
            elapsed_seconds: Number(elapsed),
            ok,
          },
        });
      } else if (task.type === 'COMPOSITE_REBALANCE') {
        // Sprint 41-A: 组合级策略 (multi_factor_alpha / ensemble_strategy) 的真实
        // BUY/SELL/HOLD 调仓任务. 读最新一日 QuantSignal (raw_factors.target_portfolio_size>0
        // 标记的 composite-level signals), 对每个 portfolio + 每个 composite strategy
        // 调 CompositeRebalanceService.rebalance() 算 plan.
        //
        // 安全配置 (与 PaperTradingAutomationService 默认值保持一致):
        //   - dry_run 默认 true (只产 plan + persist=true 写 OrderIntent 留审计;
        //     真下单需要单独 cron 或人工审批触发, 避免组合级调仓首次上线就大额洗仓)
        //   - max_per_position_pct=0.12 / max_industry_pct=0.25 / max_daily_turnover_pct=0.4
        /* eslint-disable @typescript-eslint/no-var-requires */
        const {
          compositeRebalanceService,
          COMPOSITE_REBALANCE_STRATEGY_KEYS,
        } = require('../portfolio/internal/CompositeRebalanceService');
        const { QuantSignal } = require('../models/QuantSignal');
        const { PaperTradingPortfolio } = require('../models/PaperTradingPortfolio');
        const { Op } = require('sequelize');
        /* eslint-enable @typescript-eslint/no-var-requires */

        const tradeDate: string =
          parameters.trade_date ||
          parameters.date ||
          moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
        const dryRun: boolean = parameters.dry_run !== false; // 默认 true
        const persist: boolean = parameters.persist !== false; // 默认 true (审计需要)
        const targetUsername: string = parameters.username || 'stock';

        // 取所有 composite-level signals 当日的 target_portfolio
        const signals = await QuantSignal.findAll({
          where: {
            trade_date: tradeDate,
            strategy_key: { [Op.in]: COMPOSITE_REBALANCE_STRATEGY_KEYS as string[] },
          },
          attributes: ['strategy_key', 'symbol', 'raw_factors'],
        });

        // 按 strategy_key 聚合 target_portfolio (信号本身的 symbol 集合即等于 target)
        const targetByStrategy = new Map<string, string[]>();
        for (const sig of signals as any[]) {
          const arr = targetByStrategy.get(sig.strategy_key) || [];
          arr.push(sig.symbol);
          targetByStrategy.set(sig.strategy_key, arr);
        }

        if (targetByStrategy.size === 0) {
          logger.info(`[COMPOSITE_REBALANCE] ${tradeDate} 无 composite-level signals, 跳过`);
          await this.safeUpdateExecutionLog(executionLog, {
            total_items: 0,
            success_count: 0,
            failed_count: 0,
            result_summary: {
              scenario: 'composite_rebalance',
              trade_date: tradeDate,
              ok: true,
              no_signals: true,
            },
          });
        } else {
          // 找目标 portfolio (优先名为 stock 的 user 的 autonomous portfolio)
          let portfolioId: number | undefined = parameters.portfolio_id;
          if (!portfolioId) {
            try {
              // eslint-disable-next-line @typescript-eslint/no-var-requires
              const { User } = require('../models/User');
              const user = await User.findOne({ where: { username: targetUsername } });
              if (user) {
                const portfolio = await PaperTradingPortfolio.findOne({
                  where: { user_id: (user as any).id },
                  order: [['created_at', 'ASC']],
                });
                portfolioId = portfolio ? (portfolio as any).id : undefined;
              }
            } catch (error: any) {
              logger.warn(
                `[COMPOSITE_REBALANCE] 自动解析 portfolio 失败 (username=${targetUsername}): ${
                  error?.message || error
                }`
              );
            }
          }

          if (!portfolioId) {
            logger.warn(
              `[COMPOSITE_REBALANCE] 找不到 portfolio (username=${targetUsername}, portfolio_id 未配), 跳过`
            );
            await this.safeUpdateExecutionLog(executionLog, {
              total_items: targetByStrategy.size,
              success_count: 0,
              failed_count: targetByStrategy.size,
              result_summary: {
                scenario: 'composite_rebalance',
                trade_date: tradeDate,
                ok: false,
                error: 'portfolio_not_found',
              },
            });
          } else {
            const t0 = Date.now();
            const results: any[] = [];
            for (const [strategyKey, targets] of targetByStrategy) {
              try {
                const result = await compositeRebalanceService.rebalance({
                  portfolio_id: portfolioId,
                  strategy_key: strategyKey,
                  target_portfolio: targets,
                  trade_date: tradeDate,
                  options: {
                    dryRun,
                    persist,
                  },
                });
                results.push({
                  strategy_key: strategyKey,
                  target_count: result.diagnostics.target_count,
                  orders_buy: result.orders.filter((o: any) => o.side === 'BUY').length,
                  orders_sell: result.orders.filter((o: any) => o.side === 'SELL').length,
                  orders_hold: result.orders.filter((o: any) => o.side === 'HOLD').length,
                  filtered_sells: result.filtered_sells.length,
                  capped_per_position: result.capped_per_position_orders,
                  capped_industry: result.capped_industry_orders,
                  capped_turnover: result.capped_turnover_orders,
                  turnover_pct: result.diagnostics.total_turnover_pct,
                  persisted: result.persisted,
                });
                logger.info(
                  `[COMPOSITE_REBALANCE] ${strategyKey} portfolio=${portfolioId}: ${result.diagnostics.message}`
                );
              } catch (error: any) {
                logger.warn(
                  `[COMPOSITE_REBALANCE] ${strategyKey} portfolio=${portfolioId} 失败 (fail-open): ${
                    error?.message || error
                  }`
                );
                results.push({ strategy_key: strategyKey, error: error?.message || String(error) });
              }
            }
            const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
            await this.safeUpdateExecutionLog(executionLog, {
              total_items: results.length,
              success_count: results.filter(r => !r.error).length,
              failed_count: results.filter(r => r.error).length,
              result_summary: {
                scenario: 'composite_rebalance',
                trade_date: tradeDate,
                portfolio_id: portfolioId,
                dry_run: dryRun,
                persist,
                elapsed_seconds: Number(elapsed),
                results,
              },
            });
          }
        }
      } else if (task.type === 'TCA_WEEKLY_REPORT') {
        // Sprint 43-B: 每周 TCA (Transaction Cost Attribution) 报告.
        // 跑 N 天 lookback 内已 closed trades → 拆 cost 来源 → 算 per-strategy
        // weight multiplier (entry_slip > 0.5% OR impact > 0.3% → 0.7).
        //
        // 写到 StrategyTcaMultiplier 表 (per-strategy 最新 multiplier), 让
        // StrategyAllocationPolicy / PaperTradingAutomationService 下周读取并应用.
        // fail-open: 单 trade attribution 失败不阻塞 batch, 整体失败仅 warn.
        /* eslint-disable @typescript-eslint/no-var-requires */
        const { tcaService } = require('../services/tca/TCAService');
        /* eslint-enable @typescript-eslint/no-var-requires */
        const lookbackDays: number = this.toPositiveInt(parameters.lookback_days, 30, 365);
        const asOfDate: string =
          parameters.as_of_date || moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
        const t0 = Date.now();
        let tcaResult: any = { per_trade: [], per_strategy: [], total_trades: 0 };
        try {
          tcaResult = await tcaService.runAttribution({
            lookback_days: lookbackDays,
            as_of_date: asOfDate,
          });
          // 持久化 per-strategy multiplier 到 strategy_tca_multipliers 表 (Sprint 43-B 新建).
          // 若表不存在 (DB migration 未跑), 仅 warn 不阻塞.
          try {
            /* eslint-disable @typescript-eslint/no-var-requires */
            const { StrategyTcaMultiplier } = require('../models/StrategyTcaMultiplier');
            /* eslint-enable @typescript-eslint/no-var-requires */
            for (const s of tcaResult.per_strategy) {
              await StrategyTcaMultiplier.upsert({
                strategy_key: s.strategy_key,
                report_date: asOfDate,
                lookback_days: lookbackDays,
                trade_count: s.trade_count,
                avg_realized_pnl_pct: s.avg_realized_pnl_pct,
                avg_tracking_error_pct: s.avg_tracking_error_pct,
                avg_entry_slippage_pct: s.avg_entry_slippage_pct,
                avg_impact_cost_pct: s.avg_impact_cost_pct,
                recommended_weight_multiplier: s.recommended_weight_multiplier,
                warning: s.warning,
                reason: s.reason,
              });
            }
            logger.info(
              `[TCA_WEEKLY_REPORT] ${asOfDate} ${tcaResult.per_strategy.length} strategies 持久化`
            );
          } catch (persistErr: any) {
            logger.warn(
              `[TCA_WEEKLY_REPORT] StrategyTcaMultiplier 持久化失败 (表可能未创建): ${
                persistErr?.message || persistErr
              }`
            );
          }
        } catch (e: any) {
          logger.warn(`[TCA_WEEKLY_REPORT] tcaService 失败: ${e?.message || e}`);
        }
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: tcaResult.total_trades,
          success_count: tcaResult.per_strategy.length,
          failed_count: 0,
          result_summary: {
            scenario: 'tca_weekly_report',
            as_of_date: asOfDate,
            lookback_days: lookbackDays,
            total_trades: tcaResult.total_trades,
            per_strategy_count: tcaResult.per_strategy.length,
            // 抽 warnings 列表给 dashboard
            high_cost_strategies: tcaResult.per_strategy
              .filter((s: any) => s.warning !== 'ok')
              .map((s: any) => ({
                strategy_key: s.strategy_key,
                warning: s.warning,
                weight: s.recommended_weight_multiplier,
                avg_entry_slip: s.avg_entry_slippage_pct,
                avg_impact: s.avg_impact_cost_pct,
              })),
            elapsed_seconds: Number(elapsed),
          },
        });
      } else if (task.type === 'FACTOR_CORRELATION_WEEKLY') {
        // Sprint 43-D: 每周日晚跑因子相关性报告 + 拥挤度 / 冗余度诊断.
        // 走 child_process 调 compute-factor-correlation CLI:
        //   - 算 N×N Pearson 相关矩阵
        //   - 找冗余对 (|r| > threshold, 默认 0.7) 写到 factor_correlation_results 表
        //   - 触发 RiskAlert (compute-factor-correlation CLI 内部已实现)
        //
        // 每周日晚 20:30 跑, 给周一开盘前看到本周因子健康度报告.
        /* eslint-disable @typescript-eslint/no-var-requires */
        const path = require('path');
        /* eslint-enable @typescript-eslint/no-var-requires */
        const scriptPath = path.resolve(
          __dirname,
          '..',
          'scripts',
          'compute-factor-correlation.ts'
        );
        const today = moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
        const lookbackDays: number = this.toPositiveInt(parameters.lookback_days, 30, 365);
        const startDate = moment(today)
          .tz('Asia/Shanghai')
          .subtract(lookbackDays, 'days')
          .format('YYYY-MM-DD');
        const threshold: number = Number.isFinite(Number(parameters.threshold))
          ? Number(parameters.threshold)
          : 0.7;
        const args = [
          'node_modules/.bin/ts-node',
          '--transpile-only',
          scriptPath,
          `--start=${startDate}`,
          `--end=${today}`,
          `--threshold=${threshold}`,
        ];
        const t0 = Date.now();
        // BJ-6 (2026-06-23): runScriptAsync 防 event loop 阻塞 30min
        const r = await this.runScriptAsync('/usr/bin/node', args, {
          cwd: path.resolve(__dirname, '..', '..'),
          timeoutMs: 30 * 60_000, // 30 min 上限 (20 因子 × C(20,2)=190 pair)
        });
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        const ok = r.code === 0;
        if (ok) {
          logger.info(
            `[FACTOR_CORRELATION_WEEKLY] done in ${elapsed}s for ${startDate}..${today} threshold=${threshold}`
          );
        } else {
          logger.warn(
            `[FACTOR_CORRELATION_WEEKLY] failed code=${r.code} after ${elapsed}s: ${(
              r.stderr || ''
            ).substring(0, 300)}`
          );
        }
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: 1,
          success_count: ok ? 1 : 0,
          failed_count: ok ? 0 : 1,
          result_summary: {
            scenario: 'factor_correlation_weekly',
            start_date: startDate,
            end_date: today,
            threshold,
            elapsed_seconds: Number(elapsed),
            ok,
            // 若 CLI 输出 redundant_pairs 数, 抽到 stdout 后简单 parse
            stdout_tail: (r.stdout || '').slice(-300),
          },
        });
      } else if (task.type === 'FACTOR_IC_COMPUTE') {
        // Phase 3: 每日因子 IC 计算 — 走 child_process 调用 compute-factor-ic CLI
        // 默认跑过去 90 天 + 默认 forwardDays=[1,5,10,20,60]，覆盖 5 个时间窗口的衰减分析
        const path = require('path');
        const scriptPath = path.resolve(__dirname, '..', 'scripts', 'compute-factor-ic.ts');
        const lookbackDays: number = this.toPositiveInt(parameters.lookback_days, 90, 365);
        const today = moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
        const start = moment()
          .tz('Asia/Shanghai')
          .subtract(lookbackDays, 'days')
          .format('YYYY-MM-DD');
        const factorNames: string[] = Array.isArray(parameters.factor_names)
          ? parameters.factor_names
          : []; // 空 → CLI 跑全部
        const args = [
          'node_modules/.bin/ts-node',
          '--transpile-only',
          scriptPath,
          `--start=${start}`,
          `--end=${today}`,
        ];
        if (factorNames.length) args.push(`--factors=${factorNames.join(',')}`);
        const t0 = Date.now();
        // BJ-6 (2026-06-23): runScriptAsync 防 event loop 阻塞 30min
        const r = await this.runScriptAsync('/usr/bin/node', args, {
          cwd: path.resolve(__dirname, '..', '..'),
          timeoutMs: 30 * 60_000, // IC 计算可能跑 5-15 分钟
        });
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        const ok = r.code === 0;
        if (ok) {
          logger.info(
            `[FACTOR_IC_COMPUTE] done in ${elapsed}s for ${
              factorNames.length || 'all'
            } factors over ${start}..${today}`
          );
        } else {
          logger.warn(
            `[FACTOR_IC_COMPUTE] failed code=${r.code} after ${elapsed}s: ${(
              r.stderr || ''
            ).substring(0, 200)}`
          );
        }
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: factorNames.length || 1,
          success_count: ok ? factorNames.length || 1 : 0,
          failed_count: ok ? 0 : 1,
          result_summary: {
            scenario: 'factor_ic_compute',
            lookback_days: lookbackDays,
            range: `${start}..${today}`,
            factor_names: factorNames,
            elapsed_seconds: Number(elapsed),
            exit_status: r.code,
          },
        });
      } else if (task.type === 'DRAGON_TIGER_SYNC') {
        // 龙虎榜独立 cron — 收盘后 16:30 拉今日（如有上榜）
        const path = require('path');
        const today = moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
        const start = parameters.start || today;
        const end = parameters.end || today;
        const scriptPath = path.resolve(__dirname, '..', 'scripts', 'sync-dragon-tiger.ts');
        const args = [
          'node_modules/.bin/ts-node',
          '--transpile-only',
          scriptPath,
          `--start=${start}`,
          `--end=${end}`,
        ];
        const t0 = Date.now();
        // BJ-6 (2026-06-23): runScriptAsync 防 event loop 阻塞 10min
        const r = await this.runScriptAsync('/usr/bin/node', args, {
          cwd: path.resolve(__dirname, '..', '..'),
          timeoutMs: 10 * 60_000,
        });
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        const ok = r.code === 0;
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: 1,
          success_count: ok ? 1 : 0,
          failed_count: ok ? 0 : 1,
          result_summary: {
            scenario: 'dragon_tiger_sync',
            start,
            end,
            elapsed_s: elapsed,
            status: r.code,
          },
        });
        logger.info(`[DRAGON_TIGER_SYNC] ${start}~${end} ${ok ? 'OK' : 'FAIL'} ${elapsed}s`);
      } else if (task.type === 'PAPER_TRADING_DAILY_SNAPSHOT') {
        // 收盘后给所有 paper_trading_portfolio 生成日 snapshot
        // 让"昨日盈亏 / 当月收益 / 最大回撤" 能正常显示历史
        const {
          paperTradingAutomationService,
        } = require('../portfolio/internal/PaperTradingAutomationService');
        const { PaperTradingPortfolio } = require('../models/PaperTradingPortfolio');
        const portfolios = await PaperTradingPortfolio.findAll({
          where: { is_active: true },
          attributes: ['id', 'user_id'],
          raw: true,
        });
        let ok = 0,
          failed = 0;
        for (const p of portfolios as any[]) {
          try {
            await paperTradingAutomationService.syncLatestPricesAndSnapshot(p.id);
            ok++;
          } catch (e: any) {
            logger.warn(
              `[PAPER_TRADING_DAILY_SNAPSHOT] portfolio=${p.id} FAIL: ${e?.message || e}`
            );
            failed++;
          }
        }
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: portfolios.length,
          success_count: ok,
          failed_count: failed,
          result_summary: {
            scenario: 'paper_trading_daily_snapshot',
            total: portfolios.length,
            ok,
            failed,
          },
        });
        logger.info(`[PAPER_TRADING_DAILY_SNAPSHOT] ${ok}/${portfolios.length} OK`);
      } else if (task.type === 'WEEKLY_QA_STAT_AGGREGATE') {
        // US-038 QA-002 (2026-06-19): 周一 02:00 (≤ AC 04:00 截止) 聚合上周投资者
        // 问答 → east_money_qa_stats. parameters.stock_codes 显式 list 或 fallback
        // 取 PaperTradingPosition 当前持仓 + 关注表 union (避免空跑). fail-OPEN: 单股
        // 失败 continue_on_error=true 不阻塞 batch.
        /* eslint-disable @typescript-eslint/no-var-requires */
        const { qaStatAggregator } = require('./qa/QAStatAggregator');
        /* eslint-enable @typescript-eslint/no-var-requires */
        const explicitCodes: string[] = Array.isArray(parameters.stock_codes)
          ? parameters.stock_codes.filter((s: unknown) => typeof s === 'string')
          : [];
        const limit = this.toPositiveInt(parameters.limit, 200, 1000);
        const intervalMs = this.toPositiveInt(parameters.interval_ms, 500, 60000);
        const dryRun = parameters.dry_run === true;
        const sinceDate: string | undefined =
          typeof parameters.since_date === 'string' ? parameters.since_date : undefined;
        let codes: string[] = explicitCodes;
        if (codes.length === 0) {
          // fallback: 取当前 paper trading 持仓 union 关注表; 失败兜底空跑.
          try {
            /* eslint-disable @typescript-eslint/no-var-requires */
            const { PaperTradingPosition } = require('../models/PaperTradingPosition');
            const { FavoriteStock } = require('../models/FavoriteStock');
            /* eslint-enable @typescript-eslint/no-var-requires */
            const positions = await PaperTradingPosition.findAll({
              attributes: ['stock_code'],
              group: ['stock_code'],
              raw: true,
            });
            const favorites = await FavoriteStock.findAll({
              attributes: ['stock_code'],
              group: ['stock_code'],
              raw: true,
            });
            const set = new Set<string>();
            for (const r of positions) if (r.stock_code) set.add(String(r.stock_code));
            for (const r of favorites) if (r.stock_code) set.add(String(r.stock_code));
            codes = Array.from(set).filter(c => /^\d{6}$/.test(c));
          } catch (e: any) {
            logger.warn(`[WEEKLY_QA_STAT_AGGREGATE] fallback codes 获取失败: ${e?.message || e}`);
            codes = [];
          }
        }

        const result = await qaStatAggregator.aggregateForStocks(codes, {
          limit,
          dry_run: dryRun,
          since_date: sinceDate,
          continue_on_error: true,
          interval_ms: intervalMs,
        });
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: result.total_stocks,
          completed_items: result.succeeded,
          failed_items: result.failed,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
          result_summary: {
            scenario: 'weekly_qa_stat_aggregate',
            dry_run: dryRun,
            total_stocks: result.total_stocks,
            succeeded: result.succeeded,
            failed: result.failed,
          },
        });
        logger.info(
          `[WEEKLY_QA_STAT_AGGREGATE] stocks=${result.total_stocks} ok=${result.succeeded} ` +
            `fail=${result.failed}${dryRun ? ' (dry_run)' : ''}`
        );
      } else if (task.type === 'BLACK_SWAN_DETECT') {
        // US-100 PR-011 — 每 30min 巡 5 类黑天鹅信号 → 落 BlackSwanEvent (PR-010).
        // 复用 BlackSwanWatchdog (US-053) 当事件枚举器, 把跨 user trigger 拍平
        // 后 (event_type, signature) 去重 → bulkCreate ignoreDuplicates: true.
        // dry_run=true → 仅返预演 distinct_total/by_type, 不真插表.
        // user_id (debug) → 仅扫单 user (但仍走 watchdog dry_run, 不写 RiskAlert).
        // fail-OPEN: watchdog/bulkCreate 任一 throw → success=false + error +
        //   failed_items=1 warn 不抛. 主 cron tick 不会因为 detector 挂崩.
        /* eslint-disable @typescript-eslint/no-var-requires */
        const {
          runBlackSwanDetector,
          getProductionDetectorRunner,
        } = require('./BlackSwanDetectorService');
        /* eslint-enable @typescript-eslint/no-var-requires */
        const dryRunBs = parameters.dry_run === true || parameters.dryRun === true;
        const targetUserIdBs = parameters.user_id || parameters.userId;
        const bsResult = await runBlackSwanDetector(getProductionDetectorRunner(), {
          dry_run: dryRunBs,
          user_id: targetUserIdBs ? Number(targetUserIdBs) : undefined,
          metadata: {
            cron_run_id: executionLog?.id ?? null,
            detector_version: 'PR-011/v1',
          },
        });
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: bsResult.distinct_total,
          completed_items: bsResult.inserted,
          failed_items: bsResult.success ? 0 : 1,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: bsResult.error || null,
          result_summary: {
            scenario: 'black_swan_detect',
            dry_run: bsResult.dry_run,
            scanned_users: bsResult.scanned_users,
            candidates_total: bsResult.candidates_total,
            distinct_total: bsResult.distinct_total,
            inserted: bsResult.inserted,
            skipped_duplicates: bsResult.skipped_duplicates,
            by_type: bsResult.by_type,
            by_severity: bsResult.by_severity,
            detected_at_iso: bsResult.detected_at_iso,
            error: bsResult.error || null,
          },
        });
        if (bsResult.success) {
          logger.info(
            `[BLACK_SWAN_DETECT] scanned=${bsResult.scanned_users} candidates=${bsResult.candidates_total} ` +
              `distinct=${bsResult.distinct_total} inserted=${bsResult.inserted} ` +
              `skipped_dup=${bsResult.skipped_duplicates}` +
              (bsResult.dry_run ? ' (dry_run)' : '')
          );
        } else {
          logger.warn(`[BLACK_SWAN_DETECT] FAIL ${bsResult.error || 'unknown_error'}`);
        }
      } else if (task.type === 'BLACK_SWAN_POSTMORTEM') {
        // US-102 PR-013 — 每 30min 巡最近 24h BlackSwanEvent (PR-010) → 生成
        // BlackSwanPostmortemReport (PR-012). 4 段中本 cron 只填第 1 段
        // event_summary; PR-014/015/016 各自接力填其它 3 段. status 初始 'partial'
        // (单段填) + UNIQUE(black_swan_event_id) UPSERT 让重跑只覆盖
        // event_summary/generated_at/sections_filled, 不动他人填的段.
        // dry_run=true → 仅返预演 events_total. event_id (debug) → 仅处理单事件 id.
        // lookback_hours 默认 24, 与 cron 30min 跑频率匹配 (容忍漏跑 / 补跑).
        // fail-OPEN: loadEvents throw → success=false + error + failed_items=1 warn 不抛.
        /* eslint-disable @typescript-eslint/no-var-requires */
        const {
          runBlackSwanPostmortem,
          getProductionPostmortemRunner,
        } = require('./BlackSwanPostmortemService');
        /* eslint-enable @typescript-eslint/no-var-requires */
        const dryRunBp = parameters.dry_run === true || parameters.dryRun === true;
        const eventIdBp = parameters.event_id || parameters.eventId;
        const lookbackHoursBp = parameters.lookback_hours || parameters.lookbackHours;
        const bpResult = await runBlackSwanPostmortem(getProductionPostmortemRunner(), {
          dry_run: dryRunBp,
          event_id: eventIdBp ? Number(eventIdBp) : undefined,
          lookback_hours: Number.isFinite(Number(lookbackHoursBp))
            ? Number(lookbackHoursBp)
            : undefined,
          metadata: {
            cron_run_id: executionLog?.id ?? null,
            service_version: 'PR-013/v1',
          },
        });
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: bpResult.events_total,
          completed_items: bpResult.reports_generated,
          failed_items: bpResult.success ? bpResult.reports_failed : 1,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: bpResult.error || null,
          result_summary: {
            scenario: 'black_swan_postmortem',
            dry_run: bpResult.dry_run,
            events_total: bpResult.events_total,
            reports_generated: bpResult.reports_generated,
            reports_failed: bpResult.reports_failed,
            generated_at_iso: bpResult.generated_at_iso,
            error: bpResult.error || null,
          },
        });
        if (bpResult.success) {
          logger.info(
            `[BLACK_SWAN_POSTMORTEM] events=${bpResult.events_total} generated=${bpResult.reports_generated} ` +
              `failed=${bpResult.reports_failed}` +
              (bpResult.dry_run ? ' (dry_run)' : '')
          );
        } else {
          logger.warn(`[BLACK_SWAN_POSTMORTEM] FAIL ${bpResult.error || 'unknown_error'}`);
        }
      } else if (task.type === 'BLACK_SWAN_BASELINE') {
        // US-103 PR-014 — 每 30min 扫 partial postmortem → 算 4 baseline
        // (hold/zero/plan/perfect) → UPDATE counterfactual_baselines 段
        // (PR-013 已填 event_summary; PR-015/016 各自填其它 2 段). 与
        // BLACK_SWAN_POSTMORTEM (13,43) 错峰 10min (23,53): postmortem 先填
        // event_summary, 本 cron 再补 counterfactual_baselines.
        // UNIQUE(black_swan_event_id) 让重跑只 UPDATE 同行; payload 仅含本段
        // (其它 JSONB 段不出现, sequelize 不动它们) — 与 [[多段 JSONB 报告分阶段
        // UPSERT]] 同款.
        // dry_run=true → 仅返预演 candidates_total. event_id (debug) → 仅处理
        // 单事件 id. lookback_hours 默认 24, 与 cron 30min 跑频率匹配.
        // fail-OPEN: loadCandidates throw → success=false + error +
        // failed_items=1 warn 不抛; 单事件 engine / upsert throw → skipped/failed
        // 累计但不抛.
        /* eslint-disable @typescript-eslint/no-var-requires */
        const {
          runCounterfactualBaselineService,
          getProductionBaselineRunner,
        } = require('./CounterfactualBaselineService');
        /* eslint-enable @typescript-eslint/no-var-requires */
        const dryRunBl = parameters.dry_run === true || parameters.dryRun === true;
        const eventIdBl = parameters.event_id || parameters.eventId;
        const lookbackHoursBl = parameters.lookback_hours || parameters.lookbackHours;
        const blResult = await runCounterfactualBaselineService(getProductionBaselineRunner(), {
          dry_run: dryRunBl,
          event_id: eventIdBl ? Number(eventIdBl) : undefined,
          lookback_hours: Number.isFinite(Number(lookbackHoursBl))
            ? Number(lookbackHoursBl)
            : undefined,
          metadata: {
            cron_run_id: executionLog?.id ?? null,
            service_version: 'PR-014/v1',
          },
        });
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: blResult.candidates_total,
          completed_items: blResult.reports_updated,
          failed_items: blResult.success ? blResult.reports_failed : 1,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: blResult.error || null,
          result_summary: {
            scenario: 'black_swan_baseline',
            dry_run: blResult.dry_run,
            candidates_total: blResult.candidates_total,
            reports_updated: blResult.reports_updated,
            reports_failed: blResult.reports_failed,
            reports_skipped: blResult.reports_skipped,
            generated_at_iso: blResult.generated_at_iso,
            error: blResult.error || null,
          },
        });
        if (blResult.success) {
          logger.info(
            `[BLACK_SWAN_BASELINE] candidates=${blResult.candidates_total} updated=${blResult.reports_updated} ` +
              `failed=${blResult.reports_failed} skipped=${blResult.reports_skipped}` +
              (blResult.dry_run ? ' (dry_run)' : '')
          );
        } else {
          logger.warn(`[BLACK_SWAN_BASELINE] FAIL ${blResult.error || 'unknown_error'}`);
        }
      } else if (task.type === 'BLACK_SWAN_TIMELINE') {
        // US-104 PR-015 — 每 30min 扫 partial postmortem → 把事件前 N 天
        // (默认 7) RiskAlert / BlackSwanWatchdog 触发 (rule_id='black_swan' 的
        // RiskAlert) 排时间轴 → UPDATE event_timeline 段 (PR-013 已填
        // event_summary, PR-014 已填 counterfactual_baselines; PR-016 后续填
        // improvement_suggestions). 与 BLACK_SWAN_BASELINE (23,53) 错峰 10min
        // (33,3): PR-014 先填 baseline, 本 cron 再补 event_timeline.
        // UNIQUE(black_swan_event_id) 让重跑只 UPDATE 同行; payload 仅含本段
        // (其它 JSONB 段不出现, sequelize 不动它们) — 与 [[多段 JSONB 报告
        // 分阶段 UPSERT]] 同款.
        // dry_run=true → 仅返预演 candidates_total. event_id (debug) → 仅处理
        // 单事件 id. lookback_hours 默认 24 (扫 partial postmortem),
        // lookback_days 默认 7 (engine 时间轴回溯天数).
        // fail-OPEN: loadCandidates throw → success=false + error +
        // failed_items=1 warn 不抛; 单事件 loadRiskAlerts / upsert throw →
        // skipped/failed 累计但不抛.
        /* eslint-disable @typescript-eslint/no-var-requires */
        const {
          runEventTimelineReplayerService,
          getProductionTimelineRunner,
        } = require('./EventTimelineReplayerService');
        /* eslint-enable @typescript-eslint/no-var-requires */
        const dryRunTl = parameters.dry_run === true || parameters.dryRun === true;
        const eventIdTl = parameters.event_id || parameters.eventId;
        const lookbackHoursTl = parameters.lookback_hours || parameters.lookbackHours;
        const lookbackDaysTl = parameters.lookback_days || parameters.lookbackDays;
        const tlResult = await runEventTimelineReplayerService(getProductionTimelineRunner(), {
          dry_run: dryRunTl,
          event_id: eventIdTl ? Number(eventIdTl) : undefined,
          lookback_hours: Number.isFinite(Number(lookbackHoursTl))
            ? Number(lookbackHoursTl)
            : undefined,
          lookback_days: Number.isFinite(Number(lookbackDaysTl))
            ? Number(lookbackDaysTl)
            : undefined,
          metadata: {
            cron_run_id: executionLog?.id ?? null,
            service_version: 'PR-015/v1',
          },
        });
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: tlResult.candidates_total,
          completed_items: tlResult.reports_updated,
          failed_items: tlResult.success ? tlResult.reports_failed : 1,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: tlResult.error || null,
          result_summary: {
            scenario: 'black_swan_timeline',
            dry_run: tlResult.dry_run,
            candidates_total: tlResult.candidates_total,
            reports_updated: tlResult.reports_updated,
            reports_failed: tlResult.reports_failed,
            reports_skipped: tlResult.reports_skipped,
            generated_at_iso: tlResult.generated_at_iso,
            error: tlResult.error || null,
          },
        });
        if (tlResult.success) {
          logger.info(
            `[BLACK_SWAN_TIMELINE] candidates=${tlResult.candidates_total} updated=${tlResult.reports_updated} ` +
              `failed=${tlResult.reports_failed} skipped=${tlResult.reports_skipped}` +
              (tlResult.dry_run ? ' (dry_run)' : '')
          );
        } else {
          logger.warn(`[BLACK_SWAN_TIMELINE] FAIL ${tlResult.error || 'unknown_error'}`);
        }
      } else if (task.type === 'BLACK_SWAN_IMPROVEMENT') {
        // US-105 PR-016 — 每 30min 扫 partial postmortem → 从已填段
        // (event_summary + counterfactual_baselines + event_timeline) 启发式
        // 归类 4 类短板 (detection/response/execution/risk_control) → 套模板生成
        // 建议 → UPDATE improvement_suggestions 段 (PR-013/014/015 已填前 3 段).
        // 与 BLACK_SWAN_TIMELINE (33,3) 错峰 10min (43,13): PR-015 先填 timeline,
        // 本 cron 再补 improvement_suggestions. UNIQUE(black_swan_event_id) 让
        // 重跑只 UPDATE 同行; payload 仅含本段 (其它 JSONB 段不出现, sequelize
        // 不动它们) — 与 [[多段 JSONB 报告分阶段 UPSERT]] 同款.
        // dry_run=true → 仅返预演 candidates_total. event_id (debug) → 仅处理
        // 单事件 id. lookback_hours 默认 24 (扫 partial postmortem).
        // top_findings_cap 默认 5.
        // fail-OPEN: loadCandidates throw → success=false + error +
        // failed_items=1 warn 不抛; 单事件 engine / upsert throw →
        // skipped/failed 累计但不抛.
        /* eslint-disable @typescript-eslint/no-var-requires */
        const {
          runBlackSwanImprovementSuggestorService,
          getProductionSuggestorRunner,
        } = require('./BlackSwanImprovementSuggestorService');
        /* eslint-enable @typescript-eslint/no-var-requires */
        const dryRunImpr = parameters.dry_run === true || parameters.dryRun === true;
        const eventIdImpr = parameters.event_id || parameters.eventId;
        const lookbackHoursImpr = parameters.lookback_hours || parameters.lookbackHours;
        const topFindingsCap = parameters.top_findings_cap || parameters.topFindingsCap;
        const imprResult = await runBlackSwanImprovementSuggestorService(
          getProductionSuggestorRunner(),
          {
            dry_run: dryRunImpr,
            event_id: eventIdImpr ? Number(eventIdImpr) : undefined,
            lookback_hours: Number.isFinite(Number(lookbackHoursImpr))
              ? Number(lookbackHoursImpr)
              : undefined,
            top_findings_cap: Number.isFinite(Number(topFindingsCap))
              ? Number(topFindingsCap)
              : undefined,
            metadata: {
              cron_run_id: executionLog?.id ?? null,
              service_version: 'PR-016/v1',
            },
          }
        );
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: imprResult.candidates_total,
          completed_items: imprResult.reports_updated,
          failed_items: imprResult.success ? imprResult.reports_failed : 1,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: imprResult.error || null,
          result_summary: {
            scenario: 'black_swan_improvement',
            dry_run: imprResult.dry_run,
            candidates_total: imprResult.candidates_total,
            reports_updated: imprResult.reports_updated,
            reports_failed: imprResult.reports_failed,
            reports_skipped: imprResult.reports_skipped,
            generated_at_iso: imprResult.generated_at_iso,
            error: imprResult.error || null,
          },
        });
        if (imprResult.success) {
          logger.info(
            `[BLACK_SWAN_IMPROVEMENT] candidates=${imprResult.candidates_total} updated=${imprResult.reports_updated} ` +
              `failed=${imprResult.reports_failed} skipped=${imprResult.reports_skipped}` +
              (imprResult.dry_run ? ' (dry_run)' : '')
          );
        } else {
          logger.warn(`[BLACK_SWAN_IMPROVEMENT] FAIL ${imprResult.error || 'unknown_error'}`);
        }
      } else if (task.type === 'BLACK_SWAN_QUARTERLY_SUMMARY') {
        // US-134 PR-019 — 每季首日 09:05 把上一季全量 BlackSwanEvent 聚合
        // (event_type/severity/scope/top_symbols/critical+high 高亮) → HTML 邮件
        // 发给 ops 收件人列表 (QUARTERLY_BLACK_SWAN_RECIPIENTS env). 与 PR-013/14/15/16
        // 单事件复盘互补. dry_run=true → 仅返聚合 payload, 不发邮件. reference_date
        // (YYYY-MM-DD, Asia/Shanghai) override 默认 NOW (用于回填). fail-OPEN: loadEvents
        // throw → success=false + error + failed_items=1 warn 不抛; 单收件人发送
        // 失败 → 累计 failed 但其它收件人继续.
        /* eslint-disable @typescript-eslint/no-var-requires */
        const {
          runBlackSwanQuarterlyReport,
          getProductionQuarterlyRunner,
        } = require('./BlackSwanQuarterlyReportService');
        /* eslint-enable @typescript-eslint/no-var-requires */
        const dryRunQ = parameters.dry_run === true || parameters.dryRun === true;
        const refDateQ =
          typeof parameters.reference_date === 'string'
            ? parameters.reference_date
            : typeof parameters.referenceDate === 'string'
            ? parameters.referenceDate
            : undefined;
        const qResult = await runBlackSwanQuarterlyReport(getProductionQuarterlyRunner(), {
          dry_run: dryRunQ,
          reference_date: refDateQ,
        });
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: qResult.recipients_total,
          completed_items: qResult.sent_count,
          failed_items: qResult.success ? qResult.failed_count : 1,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: qResult.error || null,
          result_summary: {
            scenario: 'black_swan_quarterly_summary',
            dry_run: qResult.dry_run,
            quarter: qResult.quarter ? `${qResult.quarter.year} Q${qResult.quarter.quarter}` : null,
            events_total: qResult.events_total,
            recipients_total: qResult.recipients_total,
            sent_count: qResult.sent_count,
            skipped_count: qResult.skipped_count,
            failed_count: qResult.failed_count,
            generated_at_iso: qResult.generated_at_iso,
            error: qResult.error || null,
          },
        });
        if (qResult.success) {
          logger.info(
            `[BLACK_SWAN_QUARTERLY_SUMMARY] quarter=${
              qResult.quarter ? `${qResult.quarter.year}Q${qResult.quarter.quarter}` : 'unknown'
            } events=${qResult.events_total} recipients=${qResult.recipients_total} ` +
              `sent=${qResult.sent_count} skipped=${qResult.skipped_count} failed=${qResult.failed_count}` +
              (qResult.dry_run ? ' (dry_run)' : '')
          );
        } else {
          logger.warn(`[BLACK_SWAN_QUARTERLY_SUMMARY] FAIL ${qResult.error || 'unknown_error'}`);
        }
      } else if (task.type === 'LIVE_RECONCILIATION_GUARD') {
        // BETA-2 (2026-06-18, audit S-12): 对账主动告警 cron — 阈值评估 →
        // RiskAlert HIGH/MEDIUM → RealtimeAlertDispatcher 飞书推送。
        // 推荐 cron: '31 10,14,15 * * 1-5' (盘中 3 次) + '1 16 * * 1-5' (收盘后).
        // dry_run=true 仅评估不写 RiskAlert; window='intraday'|'eod' 仅 message 标签。
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const {
          reconciliationAlertService,
        } = require('../live-trading/services/ReconciliationAlertService');
        const win = (parameters.window === 'eod' ? 'eod' : 'intraday') as 'intraday' | 'eod';
        const dryRun = parameters.dry_run === true;
        const targetUserId = parameters.user_id || parameters.userId;
        const result = await reconciliationAlertService.runOnce({
          window: win,
          dry_run: dryRun,
          user_id: targetUserId ? Number(targetUserId) : undefined,
        });
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: result.total_users,
          completed_items: result.scanned_users,
          failed_items: result.per_user.filter(u => u.error).length,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
          result_summary: {
            scenario: 'live_reconciliation_guard',
            window: win,
            dry_run: dryRun,
            total_users: result.total_users,
            scanned_users: result.scanned_users,
            high_count: result.high_count,
            medium_count: result.medium_count,
            deduped_count: result.deduped_count,
            alerts_written: result.alerts_written,
          },
        });
        logger.info(
          `[LIVE_RECONCILIATION_GUARD ${win}] users=${result.scanned_users}/${result.total_users} ` +
            `HIGH=${result.high_count} MEDIUM=${result.medium_count} ` +
            `written=${result.alerts_written} deduped=${result.deduped_count}` +
            (dryRun ? ' (dry_run)' : '')
        );
      } else if (task.type === 'WEEKLY_IMPROVEMENT_SUGGESTION_GENERATE') {
        // Macro 串联补丁 (2026-06-21) — US-094 PM-023 改进建议生成 cron 入口.
        // 周二 09:00 给所有 active user 把最近 ErrorPatternReport → 生成
        // improvement_suggestions (heuristic 模板, source='heuristic').
        // `user_ids` 显式 list (空 = 所有 is_active=true 用户); 单 user 失败 fail-OPEN
        // continue. `period_end` 可 override (默认 service 取 latest ok 报告).
        /* eslint-disable @typescript-eslint/no-var-requires */
        const {
          generateForUser: generateImprovementForUser,
          PRODUCTION_IMPROVEMENT_SUGGESTION_DATA_SOURCE,
        } = require('./postmortem/ImprovementSuggestionService');
        const { User } = require('../models/User');
        /* eslint-enable @typescript-eslint/no-var-requires */
        const explicitImprUserIds: number[] = Array.isArray(parameters.user_ids)
          ? parameters.user_ids
              .map((x: unknown) => Number(x))
              .filter((n: number) => Number.isFinite(n) && n > 0)
          : [];
        const periodEndImpr =
          typeof parameters.period_end === 'string' && parameters.period_end.length > 0
            ? parameters.period_end
            : null;
        const cronRunIdImpr = `improvement_suggestion_cron_${Date.now()}`;

        let imprTargets: Array<{ id: number }> = [];
        if (explicitImprUserIds.length > 0) {
          imprTargets = explicitImprUserIds.map(id => ({ id }));
        } else {
          try {
            const rows = await User.findAll({
              where: { is_active: true },
              attributes: ['id'],
              raw: true,
            });
            imprTargets = (rows as Array<{ id: number }>).map(r => ({ id: Number(r.id) }));
          } catch (err: any) {
            logger.warn(
              `[WEEKLY_IMPROVEMENT_SUGGESTION_GENERATE] listActiveUsers failed (treat as empty): ${
                err?.message || String(err)
              }`
            );
            imprTargets = [];
          }
        }

        let imprOk = 0;
        let imprSkipped = 0;
        let imprFailed = 0;
        let imprPersistedTotal = 0;
        const imprPerUser: Array<{
          user_id: number;
          status: string;
          reason: string | null;
          persisted_count: number;
          error?: string;
        }> = [];
        for (const t of imprTargets) {
          try {
            const res = await generateImprovementForUser(t.id, {
              data_source: PRODUCTION_IMPROVEMENT_SUGGESTION_DATA_SOURCE,
              period_end: periodEndImpr,
              cron_run_id: cronRunIdImpr,
            });
            if (res.status === 'ok') imprOk += 1;
            else if (res.status === 'skipped') imprSkipped += 1;
            else imprFailed += 1;
            imprPersistedTotal += res.persisted_count || 0;
            imprPerUser.push({
              user_id: t.id,
              status: res.status,
              reason: res.reason,
              persisted_count: res.persisted_count || 0,
            });
          } catch (err: any) {
            // service 已 fail-OPEN, 此处兜底防 fake/import 异常
            imprFailed += 1;
            logger.warn(
              `[WEEKLY_IMPROVEMENT_SUGGESTION_GENERATE] generateForUser user=${t.id} threw: ${
                err?.message || String(err)
              }`
            );
            imprPerUser.push({
              user_id: t.id,
              status: 'failed',
              reason: 'service_threw',
              persisted_count: 0,
              error: err?.message || String(err),
            });
          }
        }
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: imprTargets.length,
          completed_items: imprPersistedTotal,
          failed_items: imprFailed,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
          result_summary: {
            scenario: 'weekly_improvement_suggestion_generate',
            cron_run_id: cronRunIdImpr,
            period_end: periodEndImpr,
            total_users: imprTargets.length,
            ok_count: imprOk,
            skipped_count: imprSkipped,
            failed_count: imprFailed,
            persisted_count: imprPersistedTotal,
            per_user: imprPerUser,
          },
        });
        logger.info(
          `[WEEKLY_IMPROVEMENT_SUGGESTION_GENERATE] users=${imprTargets.length} ok=${imprOk} ` +
            `skip=${imprSkipped} fail=${imprFailed} persisted=${imprPersistedTotal}`
        );
      } else if (task.type === 'DAILY_IMPROVEMENT_EFFECT_TRACK') {
        // Macro 串联补丁 (2026-06-21) — US-146 PM-027 改进建议效果回采 cron 入口.
        // 每日 19:30 扫所有 status='applied' AND applied_at <= NOW - 30d AND
        // effect_tracked_at IS NULL 的 improvement_suggestions, 算 apply 后窗口的
        // total_pnl_sum / Sharpe / trade_count_sum 等 metrics 写回 effect_metrics JSONB.
        // `window_days` 默认 30; `user_id` 单 user 灰度; `limit` 限流; `dry_run`=true
        // 仅算不写; `force`=true 重算已 tracked 行 (heuristic 升级后).
        // fail-OPEN 三层 — list throw / 单条 trackForSuggestion throw / writeBack 失败均不抛.
        /* eslint-disable @typescript-eslint/no-var-requires */
        const {
          trackPendingSuggestions,
          PRODUCTION_IMPROVEMENT_EFFECT_TRACKER_DATA_SOURCE,
          EFFECT_METRICS_SOURCE,
        } = require('./postmortem/ImprovementEffectTracker');
        /* eslint-enable @typescript-eslint/no-var-requires */
        const windowDaysTrack =
          parameters.window_days !== undefined
            ? Number(parameters.window_days)
            : parameters.windowDays !== undefined
            ? Number(parameters.windowDays)
            : undefined;
        const dryRunTrack = parameters.dry_run === true || parameters.dryRun === true;
        const forceTrack = parameters.force === true;
        const userIdTrack =
          parameters.user_id !== undefined
            ? Number(parameters.user_id)
            : parameters.userId !== undefined
            ? Number(parameters.userId)
            : null;
        const limitTrack =
          parameters.limit !== undefined && Number.isFinite(Number(parameters.limit))
            ? Number(parameters.limit)
            : 0;
        const trackSummary = await trackPendingSuggestions({
          data_source: PRODUCTION_IMPROVEMENT_EFFECT_TRACKER_DATA_SOURCE,
          window_days: windowDaysTrack,
          source: EFFECT_METRICS_SOURCE.TRACKER_CRON,
          dry_run: dryRunTrack,
          force: forceTrack,
          user_id: userIdTrack && userIdTrack > 0 ? userIdTrack : null,
          limit: limitTrack,
        });
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: trackSummary.total_candidates,
          completed_items: trackSummary.persisted_count,
          failed_items: trackSummary.failed_count,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: null,
          result_summary: {
            scenario: 'daily_improvement_effect_track',
            window_days: trackSummary.window_days,
            source: trackSummary.source,
            dry_run: trackSummary.dry_run,
            total_candidates: trackSummary.total_candidates,
            ok_count: trackSummary.ok_count,
            skipped_count: trackSummary.skipped_count,
            failed_count: trackSummary.failed_count,
            persisted_count: trackSummary.persisted_count,
            reason: trackSummary.reason || null,
            per_suggestion: trackSummary.per_suggestion.map((s: any) => ({
              id: s.id,
              user_id: s.user_id,
              status: s.status,
              reason: s.reason,
              persisted: s.persisted,
            })),
          },
        });
        logger.info(
          `[DAILY_IMPROVEMENT_EFFECT_TRACK] candidates=${trackSummary.total_candidates} ok=${trackSummary.ok_count} ` +
            `skip=${trackSummary.skipped_count} fail=${trackSummary.failed_count} ` +
            `persisted=${trackSummary.persisted_count} window_days=${trackSummary.window_days}` +
            (dryRunTrack ? ' (dry_run)' : '')
        );
      } else if (task.type === 'ETF_FLOW_SYNC') {
        // Macro 串联补丁 (2026-06-21) — US-092 行业 ETF 资金流 daily sync cron 入口.
        // 工作日 18:00 (AKShare T+1 数据可用) 跑前一交易日 30+ 行业 ETF 净流入 / 份额.
        // `date` 显式 (YYYY-MM-DD) override; 默认今日 (Asia/Shanghai) — 与 CLI
        // backend/src/scripts/sync-etf-flow.ts 同款数据源 + service.
        // fail-OPEN: ETFFlowSyncService.syncDate 已 try/catch 返 result.error.
        /* eslint-disable @typescript-eslint/no-var-requires */
        const { ETFFlowSyncService } = require('../data/services/ETFFlowSyncService');
        /* eslint-enable @typescript-eslint/no-var-requires */
        const tzNow = moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
        const tradeDateEtf =
          typeof parameters.date === 'string' && parameters.date.length >= 10
            ? parameters.date.slice(0, 10)
            : typeof parameters.trade_date === 'string' && parameters.trade_date.length >= 10
            ? parameters.trade_date.slice(0, 10)
            : tzNow;
        const etfSvc = new ETFFlowSyncService();
        const etfResult = await etfSvc.syncDate(tradeDateEtf);
        const succeeded = !etfResult.error;
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: Number(etfResult.fetched) || 0,
          completed_items: Number(etfResult.upserted) || 0,
          failed_items: succeeded ? 0 : 1,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: etfResult.error || null,
          result_summary: {
            scenario: 'etf_flow_sync',
            trade_date: etfResult.trade_date,
            fetched: etfResult.fetched,
            upserted: etfResult.upserted,
            net_inflow_imputed: etfResult.net_inflow_imputed,
            filtered_out: etfResult.filtered_out,
            error: etfResult.error || null,
          },
        });
        if (succeeded) {
          logger.info(
            `[ETF_FLOW_SYNC] date=${etfResult.trade_date} fetched=${etfResult.fetched} ` +
              `upserted=${etfResult.upserted} imputed=${etfResult.net_inflow_imputed} ` +
              `filtered=${etfResult.filtered_out}`
          );
        } else {
          logger.warn(
            `[ETF_FLOW_SYNC] date=${etfResult.trade_date} FAIL ${
              etfResult.error || 'unknown_error'
            }`
          );
        }
      } else if (task.type === 'OVERNIGHT_SIGNAL_SYNC') {
        // PR-M1 (2026-06-29) — 隔夜信号矩阵 sync cron 入口.
        // 北京时间 21-23 (隔夜美股开盘) + 0-9 (隔夜+早盘前) 每 15min 跑一次,
        // 5 个 source (A50 / 港股恒指 / 纳指 / DXY / VIX) fail-OPEN.
        // 给早盘 QuantRecommendationService.loadOvernightContext 消费判定大盘方向.
        /* eslint-disable @typescript-eslint/no-var-requires */
        const {
          overnightSignalSyncService,
        } = require('./OvernightSignalSyncService');
        /* eslint-enable @typescript-eslint/no-var-requires */
        try {
          const r = await overnightSignalSyncService.syncAllSources();
          const succeeded = !r.error;
          await this.safeUpdateExecutionLog(executionLog, {
            total_items: 5, // 期望 source 数
            completed_items: Number(r.fetched) || 0,
            failed_items: succeeded ? 5 - (Number(r.fetched) || 0) : 5,
            status: 'COMPLETED',
            completed_at: new Date(),
            error_message: r.error || null,
            result_summary: {
              scenario: 'overnight_signal_sync',
              fetched: r.fetched,
              upserted: r.upserted,
              per_source: r.per_source,
              collected_at: r.collected_at,
              error: r.error || null,
            },
          });
          if (succeeded) {
            logger.info(
              `[OVERNIGHT_SIGNAL_SYNC] fetched=${r.fetched}/5 upserted=${r.upserted} ` +
                `sources=[${r.per_source
                  .filter((s: any) => s.ok)
                  .map((s: any) => `${s.signal_type}:${s.change_pct ?? '-'}%`)
                  .join(', ')}]`
            );
          } else {
            logger.warn(`[OVERNIGHT_SIGNAL_SYNC] FAIL ${r.error || 'unknown_error'}`);
          }
        } catch (e: any) {
          logger.warn(`[OVERNIGHT_SIGNAL_SYNC] outage: ${e?.message ?? e}`);
        }
      } else if (task.type === 'INDUSTRY_FLOW_INTRADAY_SYNC') {
        // BK-2 (2026-06-24): 盘中 10min 行业资金流时序快照. fail-OPEN: 单点漏没关系.
        /* eslint-disable @typescript-eslint/no-var-requires */
        const { industryFlowIntradayService } = require('./IndustryFlowIntradayService');
        /* eslint-enable @typescript-eslint/no-var-requires */
        try {
          const r = await industryFlowIntradayService.pullSnapshot();
          if (r.skipped_reason) {
            logger.info(
              `[INDUSTRY_FLOW_INTRADAY_SYNC] skipped reason=${r.skipped_reason} ts=${r.snapshot_ts.toISOString()}`
            );
          } else {
            logger.info(
              `[INDUSTRY_FLOW_INTRADAY_SYNC] ts=${r.snapshot_ts.toISOString()} upserted=${r.inserted}`
            );
          }
        } catch (e: any) {
          logger.warn(`[INDUSTRY_FLOW_INTRADAY_SYNC] failed: ${e?.message ?? e}`);
        }
      } else if (task.type === 'INDUSTRY_FLOW_INTRADAY_CLEANUP') {
        // BK-2 (2026-06-24): 每日 16:00 删 > 3 日老 intraday 快照. fail-OPEN.
        /* eslint-disable @typescript-eslint/no-var-requires */
        const { industryFlowIntradayService } = require('./IndustryFlowIntradayService');
        /* eslint-enable @typescript-eslint/no-var-requires */
        try {
          const n = await industryFlowIntradayService.cleanup(3);
          logger.info(`[INDUSTRY_FLOW_INTRADAY_CLEANUP] deleted=${n}`);
        } catch (e: any) {
          logger.warn(`[INDUSTRY_FLOW_INTRADAY_CLEANUP] failed: ${e?.message ?? e}`);
        }
      } else if (task.type === 'MARKET_SENTIMENT_INDEX_SYNC') {
        // BJ-8 (2026-06-24): 工作日 17:30 全市场情绪指数计算 (US-057).
        // computeAndPersist 内部 4 维度 safeAwait fallback (per-dim 死单独不阻塞),
        // 任一全死时 limit_diff 仍能算 (= 0-0), 写 index_value=50 中性. fail-OPEN.
        /* eslint-disable @typescript-eslint/no-var-requires */
        const { marketSentimentIndexService } = require('./MarketSentimentIndexService');
        /* eslint-enable @typescript-eslint/no-var-requires */
        try {
          const result = await marketSentimentIndexService.computeAndPersist({});
          logger.info(
            `[MARKET_SENTIMENT_INDEX_SYNC] trade_date=${result.trade_date} index_value=${result.index_value.toFixed(2)} persisted=${!result.dry_run}`
          );
        } catch (e: any) {
          // 整体异常仍 warn 不抛 (与 ETF_FLOW_SYNC 同款 fail-OPEN 模式),
          // 让 cron 标 success, 失败由 DATA_FRESHNESS_CHECK 18:30 监测 + 告警.
          logger.warn(`[MARKET_SENTIMENT_INDEX_SYNC] failed: ${e?.message ?? e}`);
        }
      } else if (task.type === 'DATA_FRESHNESS_CHECK') {
        // BF-3 (2026-06-23): 工作日 18:30 检查 5 项数据陈旧度 + 命中阈值推 Lark + 写 RiskAlert MEDIUM
        // fail-OPEN: runDataFreshnessCheck 内部 per-item try/catch, 整体不抛.
        /* eslint-disable @typescript-eslint/no-var-requires */
        const {
          runDataFreshnessCheck,
          buildFreshnessReportMarkdown,
          PRODUCTION_DATA_FRESHNESS_CHECK_DATA_SOURCE,
        } = require('./DataFreshnessCheckService');
        const { RiskAlert } = require('../models/RiskAlert');
        const { pushSystemAdminAlert } = require('./SystemAdminAlertPusher');
        /* eslint-enable @typescript-eslint/no-var-requires */
        const report = await runDataFreshnessCheck(PRODUCTION_DATA_FRESHNESS_CHECK_DATA_SOURCE);
        const hasFail = report.fail_count > 0;
        const hasWarn = report.warn_count > 0;
        // 命中阈值 → 写 RiskAlert + 推 Lark
        if (hasFail || hasWarn) {
          const level = hasFail ? 'MEDIUM' : 'LOW';
          try {
            await RiskAlert.create({
              user_id: 1, // system admin
              symbol: 'SYSTEM:DATA_FRESHNESS',
              name: `数据陈旧度告警 ${report.fail_count}f/${report.warn_count}w`,
              level,
              rule_id: 'data_freshness',
              message: report.items
                .filter((i: any) => i.status !== 'ok')
                .map((i: any) => `[${i.status.toUpperCase()}] ${i.display_name}: ${i.detail}`)
                .join('\n'),
              metadata: { report },
            });
          } catch (e: any) {
            logger.warn(`[DATA_FRESHNESS_CHECK] write RiskAlert failed: ${e?.message ?? e}`);
          }
          // 推 Lark (1h dedup)
          try {
            const md = buildFreshnessReportMarkdown(report);
            await pushSystemAdminAlert({
              dedup_key: `data_freshness:${report.trade_date}`,
              level: hasFail ? 'HIGH' : 'WARN',
              title: `📊 数据陈旧度告警 - ${report.fail_count} fail / ${report.warn_count} warn`,
              body_markdown: md.substring(0, 1900),
              triggered_at: new Date().toISOString(),
            });
          } catch (e: any) {
            logger.warn(`[DATA_FRESHNESS_CHECK] push lark failed: ${e?.message ?? e}`);
          }
        }
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: report.items.length,
          completed_items: report.ok_count,
          failed_items: hasFail ? report.fail_count : 0,
          status: 'COMPLETED',
          completed_at: new Date(),
          result_summary: {
            scenario: 'data_freshness_check',
            ok: report.ok_count,
            warn: report.warn_count,
            fail: report.fail_count,
            trade_date: report.trade_date,
          },
        });
        logger.info(
          `[DATA_FRESHNESS_CHECK] ok=${report.ok_count} warn=${report.warn_count} fail=${report.fail_count}`
        );
      } else if (task.type === 'DAILY_HEALTH_REPORT') {
        // BF-4 (2026-06-23): 工作日 21:00 7 段健康指标 → Lark OPS 群 + admin 邮箱
        // fail-OPEN: generateAndPushDailyHealthReport per-section + push 都 try/catch, 整体不抛.
        /* eslint-disable @typescript-eslint/no-var-requires */
        const {
          generateAndPushDailyHealthReport,
        } = require('./DailyHealthReportService');
        /* eslint-enable @typescript-eslint/no-var-requires */
        const dryRun = parameters?.dry_run === true;
        const out = await generateAndPushDailyHealthReport({ dry_run: dryRun });
        const r = out.report;
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: 7,
          completed_items:
            7 - Object.keys(r.errors || {}).length,
          failed_items: Object.keys(r.errors || {}).length,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: out.push_error || null,
          result_summary: {
            scenario: 'daily_health_report',
            trade_date: r.trade_date,
            is_trading_day: r.is_trading_day,
            live_total: r.live_order.total,
            live_success_rate: r.live_order.success_rate,
            paper_buy: r.paper_trading.buy_count,
            paper_sell: r.paper_trading.sell_count,
            cron_failures: r.cron_failures.length,
            risk_alerts_high: r.risk_alerts_high.length,
            ai_total: r.ai_engine.total,
            ai_fallback_rate: r.ai_engine.fallback_rate,
            factor_std_zero: r.factor_std_zero.length,
            push_attempted: out.push_attempted,
            push_error: out.push_error || null,
            section_errors: r.errors,
          },
        });
        logger.info(
          `[DAILY_HEALTH_REPORT] date=${r.trade_date} live=${r.live_order.total}/${
            (r.live_order.success_rate * 100).toFixed(1)
          }% paper=${r.paper_trading.buy_count}/${r.paper_trading.sell_count} ` +
            `cron_fail=${r.cron_failures.length} alerts=${r.risk_alerts_high.length} ` +
            `ai=${r.ai_engine.total}/${(r.ai_engine.fallback_rate * 100).toFixed(1)}%fb ` +
            `std0=${r.factor_std_zero.length} push=${out.push_attempted}`
        );
      } else if (task.type === 'ANALYST_FORECAST_SYNC') {
        // BH-2 (2026-06-23): 周一 03:00 全市场 sync 分析师研报
        // 跑 dist/scripts/sync-analyst-forecast.js --all --interval-ms=400
        // CLI 已有 skip-existing 断点续传, 重跑不会重复抓
        // 5500 票 × ~2s/票 = ~3h, 周一上班前跑完, factor cron 周一 17:30 重算时能用上新数据
        //
        // BJ-5 (2026-06-23): 必须用 async spawn 不是 spawnSync, 后者阻塞 node event loop,
        // 4-5h 的 sync 会让整个 backend 卡死无响应 (curl /health timeout).
        /* eslint-disable @typescript-eslint/no-var-requires */
        const { spawn: spawnAF } = require('child_process');
        const pathAF = require('path');
        /* eslint-enable @typescript-eslint/no-var-requires */
        const scriptAF = pathAF.resolve(__dirname, '..', 'scripts', 'sync-analyst-forecast.js');
        const argsAF = [scriptAF, '--all', '--interval-ms=400'];
        if (parameters.force) argsAF.push('--force');
        const t0AF = Date.now();
        const rAF = await new Promise<{ code: number | null; stderr: string }>(resolve => {
          const child = spawnAF('/usr/bin/node', argsAF, {
            cwd: pathAF.resolve(__dirname, '..', '..'),
            env: { ...process.env },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let stderr = '';
          child.stderr?.on('data', (d: Buffer) => {
            stderr += d.toString();
            if (stderr.length > 16 * 1024) stderr = stderr.slice(-16 * 1024); // 16KB tail
          });
          const timer = setTimeout(
            () => {
              child.kill('SIGTERM');
              resolve({ code: -1, stderr: stderr + '\n[BJ-5] killed by timeout 4h' });
            },
            4 * 60 * 60_000
          );
          child.on('exit', (code: number | null) => {
            clearTimeout(timer);
            resolve({ code, stderr });
          });
          child.on('error', (err: Error) => {
            clearTimeout(timer);
            resolve({ code: -1, stderr: stderr + '\n' + err.message });
          });
        });
        const elapsedAF = ((Date.now() - t0AF) / 1000).toFixed(1);
        const okAF = rAF.code === 0;
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: 1,
          completed_items: okAF ? 1 : 0,
          failed_items: okAF ? 0 : 1,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: okAF ? null : (rAF.stderr || '').substring(0, 500),
          result_summary: {
            scenario: 'analyst_forecast_sync',
            elapsed_seconds: Number(elapsedAF),
            status: okAF ? 'SUCCESS' : 'FAILED',
          },
        });
        if (okAF) {
          logger.info(`[ANALYST_FORECAST_SYNC] done in ${elapsedAF}s`);
        } else {
          logger.warn(
            `[ANALYST_FORECAST_SYNC] failed code=${rAF.code} after ${elapsedAF}s: ${(
              rAF.stderr || ''
            ).substring(0, 200)}`
          );
        }
      } else if (task.type === 'SHAREHOLDER_COUNT_SYNC') {
        // BH-3 (2026-06-23): 周三 02:00 全市场 sync 股东户数 (修 shareholder_concentration std<0.10 真因)
        // BJ-5 (2026-06-23): 同 BH-2, 用 async spawn 防 event loop 阻塞
        /* eslint-disable @typescript-eslint/no-var-requires */
        const { spawn: spawnSC } = require('child_process');
        const pathSC = require('path');
        /* eslint-enable @typescript-eslint/no-var-requires */
        const scriptSC = pathSC.resolve(__dirname, '..', 'scripts', 'sync-shareholder-count.js');
        const argsSC = [scriptSC, '--all', '--interval-ms=200'];
        if (parameters.force) argsSC.push('--force');
        const t0SC = Date.now();
        const rSC = await new Promise<{ code: number | null; stderr: string }>(resolve => {
          const child = spawnSC('/usr/bin/node', argsSC, {
            cwd: pathSC.resolve(__dirname, '..', '..'),
            env: { ...process.env },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let stderr = '';
          child.stderr?.on('data', (d: Buffer) => {
            stderr += d.toString();
            if (stderr.length > 16 * 1024) stderr = stderr.slice(-16 * 1024);
          });
          const timer = setTimeout(
            () => {
              child.kill('SIGTERM');
              resolve({ code: -1, stderr: stderr + '\n[BJ-5] killed by timeout 5h' });
            },
            5 * 60 * 60_000
          );
          child.on('exit', (code: number | null) => {
            clearTimeout(timer);
            resolve({ code, stderr });
          });
          child.on('error', (err: Error) => {
            clearTimeout(timer);
            resolve({ code: -1, stderr: stderr + '\n' + err.message });
          });
        });
        const elapsedSC = ((Date.now() - t0SC) / 1000).toFixed(1);
        const okSC = rSC.code === 0;
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: 1,
          completed_items: okSC ? 1 : 0,
          failed_items: okSC ? 0 : 1,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: okSC ? null : (rSC.stderr || '').substring(0, 500),
          result_summary: {
            scenario: 'shareholder_count_sync',
            elapsed_seconds: Number(elapsedSC),
            status: okSC ? 'SUCCESS' : 'FAILED',
          },
        });
        if (okSC) {
          logger.info(`[SHAREHOLDER_COUNT_SYNC] done in ${elapsedSC}s`);
        } else {
          logger.warn(
            `[SHAREHOLDER_COUNT_SYNC] failed code=${rSC.code} after ${elapsedSC}s: ${(
              rSC.stderr || ''
            ).substring(0, 200)}`
          );
        }
      } else if (task.type === 'FEEDBACK_REVIEW_SWEEP') {
        // Batch AL (2026-06-21) — SystemWorkspace 用户反馈闭环 cron 入口.
        // 每 30 分钟扫 status='pending' 且 (reviewed_at IS NULL OR < now-ageHours) 的反馈,
        // 跑启发式分类器, 把 ai_classification / ai_priority / ai_summary / reviewed_at 写回.
        // **不自动 resolve** — resolve 必须 admin 通过 POST /api/admin/feedbacks/:id/resolve 手工触发.
        // fail-OPEN: service.runReviewSweep 已 try/catch, 整体 + 单 row 均不抛.
        /* eslint-disable @typescript-eslint/no-var-requires */
        const { PRODUCTION_USER_FEEDBACK_REVIEW_SWEEP } = require('./UserFeedbackService');
        /* eslint-enable @typescript-eslint/no-var-requires */
        const feedbackLimit =
          Number.isFinite(Number(parameters.limit)) && Number(parameters.limit) > 0
            ? Number(parameters.limit)
            : 200;
        const feedbackAgeHours =
          Number.isFinite(Number(parameters.age_hours)) && Number(parameters.age_hours) >= 0
            ? Number(parameters.age_hours)
            : 6;
        const sweepResult = await PRODUCTION_USER_FEEDBACK_REVIEW_SWEEP({
          limit: feedbackLimit,
          ageHours: feedbackAgeHours,
        });
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: Number(sweepResult.scanned) || 0,
          completed_items: Number(sweepResult.updated) || 0,
          failed_items: Number(sweepResult.failed) || 0,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: sweepResult.error || null,
          result_summary: {
            scenario: 'feedback_review_sweep',
            scanned: sweepResult.scanned,
            updated: sweepResult.updated,
            failed: sweepResult.failed,
            per_classification: sweepResult.per_classification,
            age_hours: feedbackAgeHours,
            limit: feedbackLimit,
          },
        });
        if (sweepResult.error) {
          logger.warn(
            `[FEEDBACK_REVIEW_SWEEP] error=${sweepResult.error} scanned=${sweepResult.scanned}`
          );
        } else {
          logger.info(
            `[FEEDBACK_REVIEW_SWEEP] scanned=${sweepResult.scanned} updated=${sweepResult.updated} ` +
              `failed=${sweepResult.failed} classes=${JSON.stringify(
                sweepResult.per_classification
              )}`
          );
        }
      } else if (task.type === 'ANNOUNCEMENT_NLP') {
        // PR-A (2026-06-29): 公告 NLP 全市场扫描 — sync-announcements.ts CLI 之前
        // 一直没注册成 cron, announcement_summaries 表从 2026-06-09 后 0 更新.
        // 每日 17:00 全市场 (--all --with-ai=false 走启发式, 不调远端 AI 省钱).
        // 写 announcement_summaries.priority / event_type. critical 级走
        // CriticalAnnouncementPushService 推 OPS 飞书群. 周末也跑.
        // fail-OPEN: spawn 失败仅写 failed_items=1 + warn 不抛, 与 ANALYST_FORECAST_SYNC /
        // SHAREHOLDER_COUNT_SYNC 同款 async runScriptAsync 防 event loop 阻塞.
        const pathANN = require('path');
        // prod = dist/scripts/sync-announcements.js; ts-node dev 仍需走 .ts.
        // 与 FACTOR_SCORE_COMPUTE / ANALYST_FORECAST_SYNC 同款"prod 优先 .js"约定.
        const compiledANN = pathANN.resolve(
          __dirname,
          '..',
          'scripts',
          'sync-announcements.js'
        );
        const argsANN: string[] = [compiledANN];
        // parameters override; 默认全市场启发式
        if (parameters.symbol) argsANN.push(`--symbol=${parameters.symbol}`);
        if (parameters.date) argsANN.push(`--date=${parameters.date}`);
        if (parameters.backfill) argsANN.push(`--backfill=${parameters.backfill}`);
        if (parameters.with_ai === true) argsANN.push('--with-ai');
        if (parameters.force === true) argsANN.push('--force');
        if (parameters.dry_run === true) argsANN.push('--dry-run');
        if (Number.isFinite(Number(parameters.interval_ms))) {
          argsANN.push(`--interval-ms=${Number(parameters.interval_ms)}`);
        }
        const t0ANN = Date.now();
        const rANN = await this.runScriptAsync('/usr/bin/node', argsANN, {
          cwd: pathANN.resolve(__dirname, '..', '..'),
          timeoutMs: 60 * 60_000, // 1h
        });
        const elapsedANN = ((Date.now() - t0ANN) / 1000).toFixed(1);
        const okANN = rANN.code === 0;
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: 1,
          completed_items: okANN ? 1 : 0,
          failed_items: okANN ? 0 : 1,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: okANN ? null : (rANN.stderr || '').substring(0, 500),
          result_summary: {
            scenario: 'announcement_nlp_sync',
            elapsed_seconds: Number(elapsedANN),
            status: okANN ? 'SUCCESS' : 'FAILED',
            with_ai: parameters.with_ai === true,
          },
        });
        if (okANN) {
          logger.info(`[ANNOUNCEMENT_NLP] done in ${elapsedANN}s`);
        } else {
          logger.warn(
            `[ANNOUNCEMENT_NLP] failed code=${rANN.code} after ${elapsedANN}s: ${(
              rANN.stderr || ''
            ).substring(0, 200)}`
          );
        }
      } else if (task.type === 'KOL_AGGREGATE') {
        // PR-A (2026-06-29): KOL 观点聚合 — sync-kol-opinions.ts CLI 之前从未被
        // cron 调用过, kol_opinions 整张空表. 每日 18:30 跑 --favorites
        // --lookback-days=14 把用户收藏股票的 KOL 观点 (券商研报 + 个股新闻 +
        // 热门概念代理) 聚合落表, 给 NewsAnalyzer + BullishEventDetector 消费.
        // 周末也跑 — 研报 / 媒体 周末仍有内容.
        // fail-OPEN: spawn 失败仅 failed_items=1 + warn, runScriptAsync 防阻塞.
        const pathKOL = require('path');
        const compiledKOL = pathKOL.resolve(
          __dirname,
          '..',
          'scripts',
          'sync-kol-opinions.js'
        );
        const argsKOL: string[] = [compiledKOL];
        // 模式: favorites 默认 (parameters 可 override 为 --all / --stocks=...)
        if (parameters.stock) {
          argsKOL.push(`--stock=${parameters.stock}`);
        } else if (Array.isArray(parameters.stocks) && parameters.stocks.length > 0) {
          argsKOL.push(`--stocks=${parameters.stocks.join(',')}`);
        } else if (parameters.all === true) {
          argsKOL.push('--all');
        } else {
          // 默认 favorites (与 ensureDefaultTasks 一致)
          argsKOL.push('--favorites');
        }
        const lookbackKOL = Number.isFinite(Number(parameters.lookback_days))
          ? Number(parameters.lookback_days)
          : 14;
        argsKOL.push(`--lookback-days=${lookbackKOL}`);
        if (Number.isFinite(Number(parameters.limit))) {
          argsKOL.push(`--limit=${Number(parameters.limit)}`);
        }
        if (Number.isFinite(Number(parameters.interval_ms))) {
          argsKOL.push(`--interval-ms=${Number(parameters.interval_ms)}`);
        }
        if (parameters.dry_run === true) argsKOL.push('--dry-run');
        const t0KOL = Date.now();
        const rKOL = await this.runScriptAsync('/usr/bin/node', argsKOL, {
          cwd: pathKOL.resolve(__dirname, '..', '..'),
          timeoutMs: 2 * 60 * 60_000, // 2h
        });
        const elapsedKOL = ((Date.now() - t0KOL) / 1000).toFixed(1);
        const okKOL = rKOL.code === 0;
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: 1,
          completed_items: okKOL ? 1 : 0,
          failed_items: okKOL ? 0 : 1,
          status: 'COMPLETED',
          completed_at: new Date(),
          error_message: okKOL ? null : (rKOL.stderr || '').substring(0, 500),
          result_summary: {
            scenario: 'kol_aggregate',
            elapsed_seconds: Number(elapsedKOL),
            status: okKOL ? 'SUCCESS' : 'FAILED',
            lookback_days: lookbackKOL,
          },
        });
        if (okKOL) {
          logger.info(`[KOL_AGGREGATE] done in ${elapsedKOL}s`);
        } else {
          logger.warn(
            `[KOL_AGGREGATE] failed code=${rKOL.code} after ${elapsedKOL}s: ${(
              rKOL.stderr || ''
            ).substring(0, 200)}`
          );
        }
      } else if (task.type === 'INTRADAY_OPPORTUNITY_SCAN') {
        // CE-B (2026-06-26) — 盘中实时机会规则引擎.
        // 拉 IntradayUniverseService.resolveUniverse() → 10 类 detector → analyzeStock
        // 二次审核 → intradayOpportunityPusher.push. parameters 支持:
        //   - min_final_score (默认 65)
        //   - target_groups (默认 ['business'])
        //   - rules (subset 限定; 默认全 10 类)
        //   - dry_run
        /* eslint-disable @typescript-eslint/no-var-requires */
        const {
          intradayOpportunityWatcher,
        } = require('./IntradayOpportunityWatcher');
        /* eslint-enable @typescript-eslint/no-var-requires */
        const minFinal =
          Number.isFinite(Number(parameters.min_final_score)) &&
          Number(parameters.min_final_score) >= 0
            ? Number(parameters.min_final_score)
            : 65;
        const targetGroups = Array.isArray(parameters.target_groups)
          ? parameters.target_groups
          : ['business'];
        const rules = Array.isArray(parameters.rules) ? parameters.rules : undefined;
        const scanRes = await intradayOpportunityWatcher.scan({
          min_final_score: minFinal,
          target_groups: targetGroups,
          rules,
          dry_run: parameters.dry_run === true,
        });
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: scanRes.scanned_count,
          completed_items: scanRes.pushed_count,
          failed_items: scanRes.errors.length,
          status: 'COMPLETED',
          completed_at: new Date(),
          result_summary: {
            scenario: 'intraday_opportunity_scan',
            scanned: scanRes.scanned_count,
            hits: scanRes.hit_count,
            pushed: scanRes.pushed_count,
            skipped: scanRes.skipped_count,
            errors: scanRes.errors.length,
            min_final_score: minFinal,
          },
        });
        logger.info(
          `[INTRADAY_OPPORTUNITY_SCAN] scanned=${scanRes.scanned_count} hits=${scanRes.hit_count} ` +
            `pushed=${scanRes.pushed_count} skipped=${scanRes.skipped_count} errors=${scanRes.errors.length}`
        );
      } else if (task.type === 'BULLISH_EVENT_DETECT') {
        // PR-B (2026-06-29) — 个股利好主动推送. 用户原话 "周末利好华工科技的新闻你看到了吗,
        // 这类新闻你需要发消息提示我". 4 detector (critical 公告 / 正面新闻 / 关注度突增 /
        // KOL 集中关注), 命中写 RiskAlert(level=MEDIUM) + 推 OPS 飞书群. 24h dedup 走
        // RiskAlert.message tag. fail-OPEN: runOnce 永不 throw — 整次失败也保证 cron tick
        // 进 SUCCESS, 异常通过 result_summary.errors 暴露.
        /* eslint-disable @typescript-eslint/no-var-requires */
        const { bullishEventDetectorService } = require('./BullishEventDetectorService');
        /* eslint-enable @typescript-eslint/no-var-requires */
        const r = await bullishEventDetectorService.runOnce({
          dry_run: parameters.dry_run === true,
        });
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: r.scanned,
          completed_items: r.pushed,
          failed_items: r.errors?.length || 0,
          status: 'COMPLETED',
          completed_at: new Date(),
          result_summary: {
            scenario: 'bullish_event_detect',
            scanned: r.scanned,
            detected: r.detected,
            pushed: r.pushed,
            deduped: r.deduped,
            by_detector: r.by_detector,
            errors: r.errors?.length || 0,
            dry_run: r.dry_run,
          },
        });
        logger.info(
          `[BULLISH_EVENT_DETECT] scanned=${r.scanned} detected=${r.detected} pushed=${r.pushed} ` +
            `deduped=${r.deduped} errors=${r.errors?.length || 0} ` +
            `by_detector=${JSON.stringify(r.by_detector)}`
        );
      } else if (task.type === 'AUCTION_SNAPSHOT_SYNC') {
        // PR-M2 (2026-06-29) — 9:25 集合竞价后开盘快照. 学术: Han/Hu/Jia 2023 + Gu/Ren 2010.
        // 写 auction_snapshots; 给 OpeningRushDetector / UI 卡片消费. fail-OPEN.
        /* eslint-disable @typescript-eslint/no-var-requires */
        const { auctionSnapshotSyncService } = require('./AuctionSnapshotSyncService');
        /* eslint-enable @typescript-eslint/no-var-requires */
        const r = await auctionSnapshotSyncService.runOnce({
          dry_run: parameters.dry_run === true,
        });
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: r.scanned,
          completed_items: r.inserted,
          failed_items: Math.max(0, r.scanned - r.inserted),
          status: 'COMPLETED',
          completed_at: new Date(),
          result_summary: {
            scenario: r.scenario,
            trade_date: r.trade_date,
            scanned: r.scanned,
            inserted: r.inserted,
            by_pattern: r.by_pattern,
            skipped_reason: r.skipped_reason,
            dry_run: r.dry_run,
          },
        });
        logger.info(
          `[AUCTION_SNAPSHOT_SYNC] trade_date=${r.trade_date} scanned=${r.scanned} inserted=${r.inserted} ` +
            `skip=${r.skipped_reason || 'none'} by_pattern=${JSON.stringify(r.by_pattern)}`
        );
      } else if (task.type === 'INTRADAY_KLINE_30MIN_SYNC') {
        // PR-M2 (2026-06-29) — 盘中 30-min K 线时序同步.
        // 学术: Zhang/Ma/Zhu 2019 EM (9:30-10:00 预测 14:30-15:00). fail-OPEN per-symbol.
        /* eslint-disable @typescript-eslint/no-var-requires */
        const { intradayKlineSyncService } = require('./IntradayKlineSyncService');
        /* eslint-enable @typescript-eslint/no-var-requires */
        const r = await intradayKlineSyncService.runOnce({
          dry_run: parameters.dry_run === true,
        });
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: r.scanned_symbols,
          completed_items: r.succeeded_symbols,
          failed_items: Math.max(0, r.scanned_symbols - r.succeeded_symbols),
          status: 'COMPLETED',
          completed_at: new Date(),
          result_summary: {
            scenario: r.scenario,
            trade_date: r.trade_date,
            scanned_symbols: r.scanned_symbols,
            succeeded_symbols: r.succeeded_symbols,
            total_klines: r.total_klines,
            inserted: r.inserted,
            skipped_reason: r.skipped_reason,
            dry_run: r.dry_run,
          },
        });
        logger.info(
          `[INTRADAY_KLINE_30MIN_SYNC] trade_date=${r.trade_date} scanned=${r.scanned_symbols} ` +
            `ok=${r.succeeded_symbols} klines=${r.total_klines} inserted=${r.inserted} ` +
            `skip=${r.skipped_reason || 'none'}`
        );
      } else if (task.type === 'INTRADAY_MOMENTUM_DETECT') {
        // PR-M2 (2026-06-29) — 14:25 日内动量 detector.
        // r1>+1% buy → 全 user; r1<-1% 持仓 sell. 24h dedup. fail-OPEN.
        /* eslint-disable @typescript-eslint/no-var-requires */
        const { intradayMomentumDetector } = require('./IntradayMomentumDetector');
        /* eslint-enable @typescript-eslint/no-var-requires */
        const r = await intradayMomentumDetector.runOnce({
          dry_run: parameters.dry_run === true,
        });
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: r.scanned,
          completed_items: r.written_alerts,
          failed_items: r.errors?.length || 0,
          status: 'COMPLETED',
          completed_at: new Date(),
          result_summary: {
            scenario: r.scenario,
            trade_date: r.trade_date,
            scanned: r.scanned,
            matched_buy: r.matched_buy,
            matched_sell: r.matched_sell,
            written_alerts: r.written_alerts,
            deduped: r.deduped,
            errors: r.errors?.length || 0,
            skipped_reason: r.skipped_reason,
            dry_run: r.dry_run,
          },
        });
        logger.info(
          `[INTRADAY_MOMENTUM_DETECT] trade_date=${r.trade_date} scanned=${r.scanned} ` +
            `buy=${r.matched_buy} sell=${r.matched_sell} written=${r.written_alerts} ` +
            `deduped=${r.deduped} errors=${r.errors?.length || 0} skip=${r.skipped_reason || 'none'}`
        );
      } else if (task.type === 'INDUSTRY_SENTIMENT_AGGREGATE') {
        // PR-M3 (2026-06-29) — 板块情绪指数日度聚合. 学术: 龙头战法 4 核心因子
        // (板块涨停数 / 连板高度 / 封板率 / 炸板率) + 30 日板块动量 z-score.
        // 每日 16:00 (工作日) 跑, 给推荐 service 消费做"龙头板块加权 / 弱势板块直接 skip".
        /* eslint-disable @typescript-eslint/no-var-requires */
        const { industrySentimentAggregator } = require('./IndustrySentimentAggregator');
        /* eslint-enable @typescript-eslint/no-var-requires */
        const r = await industrySentimentAggregator.runOnce({
          dry_run: parameters.dry_run === true,
          trade_date: typeof parameters.trade_date === 'string' ? parameters.trade_date : undefined,
        });
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: r.industries_scanned,
          completed_items: r.industries_written,
          failed_items: r.errors?.length || 0,
          status: 'COMPLETED',
          completed_at: new Date(),
          result_summary: {
            scenario: 'industry_sentiment_aggregate',
            trade_date: r.trade_date,
            industries_scanned: r.industries_scanned,
            industries_written: r.industries_written,
            errors: r.errors?.length || 0,
          },
        });
        logger.info(
          `[INDUSTRY_SENTIMENT_AGGREGATE] trade_date=${r.trade_date} scanned=${r.industries_scanned} ` +
            `written=${r.industries_written} errors=${r.errors?.length || 0}`
        );
      } else if (task.type === 'INTRADAY_REVERSAL_DETECT') {
        // PR-M3 (2026-06-29) — 反转 (reversal) detector. 学术: Hsu 2018 JPM / Zhang & Zhu 2024 IREF
        // 4 篇独立研究共识 — A 股因 T+1 + 散户主导 → 短期反转主导, 而非动量.
        // 找今日 < -3% 且周月线趋势仍向上 → reversal_buy; > +5% 且 RSI > 70 → reversal_sell.
        /* eslint-disable @typescript-eslint/no-var-requires */
        const { intradayReversalDetector } = require('./IntradayReversalDetector');
        /* eslint-enable @typescript-eslint/no-var-requires */
        const r = await intradayReversalDetector.runOnce({
          dry_run: parameters.dry_run === true,
        });
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: r.scanned,
          completed_items: r.hits.length,
          failed_items: r.errors?.length || 0,
          status: 'COMPLETED',
          completed_at: new Date(),
          result_summary: {
            scenario: 'intraday_reversal_detect',
            scanned: r.scanned,
            hits: r.hits.length,
            by_type: r.by_type,
            errors: r.errors?.length || 0,
          },
        });
        logger.info(
          `[INTRADAY_REVERSAL_DETECT] scanned=${r.scanned} hits=${r.hits.length} ` +
            `buy=${r.by_type.reversal_buy} sell=${r.by_type.reversal_sell} errors=${r.errors?.length || 0}`
        );
      } else if (task.type === 'LIMIT_UP_BOARD_DETECT') {
        // PR-O2 (2026-06-29) — 涨停板战法 detector (20+ pattern). PR-I-v2 战法库 §1
        // 流派 1 落地率 0% → 50%. 每日 15:30 跑 (盘后), 对 limit_up_stocks 全表逐票运行
        // 20+ classifier (一字 / T 字 / 烂板 / 强势板 / 弱转强 / 中军 / 二板加速 / 二板回封 /
        // 二板填谷 / 二进三 / 高位连板加速 / 板块最高板 / 连板天梯 / 地天板 / 烂板反包 /
        // 跌停反包 / 炸板回封 / 炸板换手 / 龙头接力 / 跟风接力), 命中即写 RiskAlert
        // (rule_id='limit_up_<pattern>', level=MEDIUM) + 写 AIInvestmentSignal
        // (source_type='limit_up_board', metadata.timing_tag='overnight'). fail-OPEN.
        /* eslint-disable @typescript-eslint/no-var-requires */
        const { limitUpBoardDetectorService } = require('./LimitUpBoardDetector');
        /* eslint-enable @typescript-eslint/no-var-requires */
        const r = await limitUpBoardDetectorService.runOnce({
          dry_run: parameters.dry_run === true,
        });
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: r.scanned,
          completed_items: r.pushed,
          failed_items: r.errors?.length || 0,
          status: 'COMPLETED',
          completed_at: new Date(),
          result_summary: {
            scenario: 'limit_up_board_detect',
            trade_date: r.trade_date,
            scanned: r.scanned,
            total_hits: r.total_hits,
            pushed: r.pushed,
            deduped: r.deduped,
            by_pattern: r.by_pattern,
            errors: r.errors?.length || 0,
            skipped_reason: r.skipped_reason,
            dry_run: r.dry_run,
          },
        });
        logger.info(
          `[LIMIT_UP_BOARD_DETECT] trade_date=${r.trade_date} scanned=${r.scanned} ` +
            `total_hits=${r.total_hits} pushed=${r.pushed} deduped=${r.deduped} ` +
            `errors=${r.errors?.length || 0} skip=${r.skipped_reason || 'none'} ` +
            `by_pattern=${JSON.stringify(r.by_pattern)}`
        );
      } else if (task.type === 'THEME_FERMENTATION_DETECT') {
        // PR-O5 (2026-06-30) — 题材发酵 5 阶段 detector. 消费 PR-M3 industry_sentiment_indices
        // (16:00 写完) + 昨日 phase, 给每个板块打 germinate/launch/outbreak/climax/recession
        // 标签 + 检测主线切换事件. 工作日 16:30 跑.
        /* eslint-disable @typescript-eslint/no-var-requires */
        const { themeFermentationDetector } = require('./ThemeFermentationDetector');
        /* eslint-enable @typescript-eslint/no-var-requires */
        const r = await themeFermentationDetector.runOnce({
          dry_run: parameters.dry_run === true,
          trade_date: typeof parameters.trade_date === 'string' ? parameters.trade_date : undefined,
        });
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: r.industries_scanned,
          completed_items: r.industries_written,
          failed_items: r.errors?.length || 0,
          status: 'COMPLETED',
          completed_at: new Date(),
          result_summary: {
            scenario: 'theme_fermentation_detect',
            trade_date: r.trade_date,
            industries_scanned: r.industries_scanned,
            industries_written: r.industries_written,
            phase_distribution: r.phase_distribution,
            mainline_switch_events: r.mainline_switch_events.length,
            errors: r.errors?.length || 0,
          },
        });
        logger.info(
          `[THEME_FERMENTATION_DETECT] trade_date=${r.trade_date} scanned=${r.industries_scanned} ` +
            `written=${r.industries_written} ` +
            `dist=germ${r.phase_distribution.germinate}/lau${r.phase_distribution.launch}/out${r.phase_distribution.outbreak}/cli${r.phase_distribution.climax}/rec${r.phase_distribution.recession} ` +
            `switch_events=${r.mainline_switch_events.length} errors=${r.errors?.length || 0}`
        );
      } else if (task.type === 'OPENING_RUSH_DETECT') {
        // PR-O3 (2026-06-29) — Opening rush detector. 工作日 9:26 (集合竞价撮合 9:25 后 1min)
        // 跑, 消费 overnight_signals + auction_snapshots, 识别隔夜信号 + auction pattern
        // (高开 / 跳空 / 一字封板 / 等), 命中即写 AIInvestmentSignal (source_type=
        // 'opening_rush_detector', metadata.timing_tag='opening_rush'). fail-OPEN per-symbol.
        // PR-P (2026-06-30): 补 cron dispatch, 之前 PR-O3 只加 service 没注册 cron.
        /* eslint-disable @typescript-eslint/no-var-requires */
        const { openingRushDetector } = require('./OpeningRushDetector');
        /* eslint-enable @typescript-eslint/no-var-requires */
        const r = await openingRushDetector.runOnce({
          dry_run: parameters.dry_run === true,
          force: parameters.force === true,
        });
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: r.scanned,
          completed_items: r.written,
          failed_items: r.errors?.length || 0,
          status: 'COMPLETED',
          completed_at: new Date(),
          result_summary: {
            scenario: r.scenario,
            trade_date: r.trade_date,
            scanned: r.scanned,
            matched: r.matched,
            written: r.written,
            by_pattern: r.by_pattern,
            overnight_direction: r.overnight_direction,
            overnight_reason: r.overnight_reason,
            skipped_reason: r.skipped_reason,
            errors: r.errors?.length || 0,
            dry_run: r.dry_run,
          },
        });
        logger.info(
          `[OPENING_RUSH_DETECT] trade_date=${r.trade_date} scanned=${r.scanned} ` +
            `matched=${r.matched} written=${r.written} dir=${r.overnight_direction} ` +
            `skip=${r.skipped_reason || 'none'} errors=${r.errors?.length || 0} ` +
            `by_pattern=${JSON.stringify(r.by_pattern)}`
        );
      } else if (task.type === 'INTRADAY_PRICE_VOLUME_ANOMALY') {
        // PR-O3 (2026-06-29) — 盘中价量异动 6 类 detector. 工作日盘中每 30min 跑一次.
        // 命中写 RiskAlert + AIInvestmentSignal (source_type='intraday_price_volume_anomaly',
        // metadata.timing_tag='intraday_anomaly'). 24h dedup. fail-OPEN per-symbol.
        // PR-P (2026-06-30): 补 cron dispatch.
        /* eslint-disable @typescript-eslint/no-var-requires */
        const {
          intradayPriceVolumeAnomalyDetector,
        } = require('./IntradayPriceVolumeAnomalyDetector');
        /* eslint-enable @typescript-eslint/no-var-requires */
        const r = await intradayPriceVolumeAnomalyDetector.runOnce({
          dry_run: parameters.dry_run === true,
        });
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: r.scanned,
          completed_items: r.written_signals,
          failed_items: r.errors?.length || 0,
          status: 'COMPLETED',
          completed_at: new Date(),
          result_summary: {
            scenario: r.scenario,
            trade_date: r.trade_date,
            scanned: r.scanned,
            matched: r.matched,
            written_alerts: r.written_alerts,
            written_signals: r.written_signals,
            by_type: r.by_type,
            skipped_reason: r.skipped_reason,
            errors: r.errors?.length || 0,
            dry_run: r.dry_run,
          },
        });
        logger.info(
          `[INTRADAY_PRICE_VOLUME_ANOMALY] trade_date=${r.trade_date} scanned=${r.scanned} ` +
            `matched=${r.matched} alerts=${r.written_alerts} signals=${r.written_signals} ` +
            `skip=${r.skipped_reason || 'none'} errors=${r.errors?.length || 0} ` +
            `by_type=${JSON.stringify(r.by_type)}`
        );
      } else if (task.type === 'LAST_HOUR_MOMENTUM') {
        // PR-O3 (2026-06-29) — Last-hour 尾盘动量 detector. 学术: Zhang/Ma/Zhu 2019 EM
        // (中国市场 9:30-10:00 r1 → 14:30-15:00 r2 最 robust). 工作日 14:30 跑, r1>+1% buy →
        // AIInvestmentSignal (source_type='last_hour_momentum', metadata.timing_tag='closing_grab').
        // fail-OPEN per-symbol. PR-P (2026-06-30): 补 cron dispatch.
        /* eslint-disable @typescript-eslint/no-var-requires */
        const { lastHourMomentumDetector } = require('./LastHourMomentumDetector');
        /* eslint-enable @typescript-eslint/no-var-requires */
        const r = await lastHourMomentumDetector.runOnce({
          dry_run: parameters.dry_run === true,
        });
        await this.safeUpdateExecutionLog(executionLog, {
          total_items: r.scanned,
          completed_items: r.written,
          failed_items: r.errors?.length || 0,
          status: 'COMPLETED',
          completed_at: new Date(),
          result_summary: {
            scenario: r.scenario,
            trade_date: r.trade_date,
            scanned: r.scanned,
            matched: r.matched,
            written: r.written,
            skipped_reason: r.skipped_reason,
            errors: r.errors?.length || 0,
            dry_run: r.dry_run,
          },
        });
        logger.info(
          `[LAST_HOUR_MOMENTUM] trade_date=${r.trade_date} scanned=${r.scanned} ` +
            `matched=${r.matched} written=${r.written} ` +
            `skip=${r.skipped_reason || 'none'} errors=${r.errors?.length || 0}`
        );
      } else {
        throw new Error(`Unsupported task type: ${task.type}`);
      }

      await this.markTaskFinished(task, 'SUCCESS');
      // US-004 [OPS-004]: 正常 success 出口.
      recordSchedulerTaskRun(
        String(task.type || 'unknown'),
        'success',
        (Date.now() - _metricStart) / 1000
      );
      return { success: true, message: 'Task executed successfully' };
    } catch (error: any) {
      logger.error(`Error executing task ${task.name}:`, error);
      await this.markTaskFinished(task, 'FAILED', executionLog, error);
      // US-004 [OPS-004]: failed 出口 — try-catch 自吞防 metric 异常影响主流程.
      try {
        recordSchedulerTaskRun(
          String(task.type || 'unknown'),
          'failed',
          (Date.now() - _metricStart) / 1000
        );
      } catch {
        // metric helper 本身已 try-catch, 此处 belt-and-suspenders.
      }
      throw error;
    }
  }

  async executeTask(id: number) {
    const task = await ScheduledTask.findByPk(id);
    if (!task) throw new Error('Task not found');

    // US-097 [OPS-008]: 手动触发 task 也起独立 trace_id + module='scheduler' 子作用域,
    // 与 cron tick 路径对齐, 手动执行的全链路日志也可 grep trace_id.
    const ctxTraceId = generateTraceId();
    return await runWithLoggingContext({ trace_id: ctxTraceId, module: 'scheduler' }, async () => {
      logger.info(`Manually triggering task ${task.id} (${task.name})`);
      return await this._executeTaskLogic(task, true);
    });
  }

  async applyLiveShadowBudgetSuggestion(
    options: {
      audit_id?: number;
      dry_run?: boolean;
      operator?: { user_id?: number; username?: string };
    } = {}
  ) {
    const dryRun = options.dry_run !== false;
    const audit = options.audit_id
      ? await taskParameterAuditService
          .list({
            event_type: LIVE_AUDIT_EVENT_TYPES.SHADOW_BUDGET_SUGGESTION,
            limit: 100,
            watched_only: false,
          })
          .then(rows => rows.find((row: any) => Number(row.id) === Number(options.audit_id)))
      : await taskParameterAuditService
          .list({
            event_type: LIVE_AUDIT_EVENT_TYPES.SHADOW_BUDGET_SUGGESTION,
            limit: 1,
            watched_only: false,
          })
          .then(rows => rows[0] as any);

    if (!audit) throw new Error('未找到影子预算候选补丁');
    if (audit.event_type !== 'live_shadow_budget_suggestion') {
      throw new Error('只能应用影子预算候选补丁');
    }

    const task = await ScheduledTask.findOne({
      where: { id: Number((audit as any).task_id), type: 'LIVE_SHADOW_AUTOPILOT' },
    });
    if (!task) throw new Error('目标影子执行任务不存在或类型不匹配');

    const beforeParameters = { ...((task as any).parameters || {}) };
    const suggested = { ...((audit as any).after_parameters || {}) };
    const recommendedLimit = Number(suggested.limit);
    if (!Number.isInteger(recommendedLimit) || recommendedLimit < 1 || recommendedLimit > 10) {
      throw new Error(`影子预算 limit 必须在 1-10 之间，当前建议为 ${suggested.limit}`);
    }

    const afterParameters = {
      ...beforeParameters,
      limit: recommendedLimit,
      shadow_budget_advice: {
        ...(suggested.shadow_budget_advice || {}),
        applied: !dryRun,
        applied_at: dryRun ? undefined : new Date().toISOString(),
        applied_by: dryRun ? undefined : options.operator?.username || options.operator?.user_id,
        source_audit_id: Number((audit as any).id),
      },
    };
    const changedKeys = taskParameterAuditService.buildChangedKeys(
      beforeParameters,
      afterParameters,
      ['limit', 'shadow_budget_advice']
    );
    const result = {
      dry_run: dryRun,
      applied: false,
      audit_id: Number((audit as any).id),
      target_task_id: Number((task as any).id),
      target_task_name: (task as any).name,
      current_limit: Number(beforeParameters.limit || 0),
      suggested_limit: recommendedLimit,
      changed_keys: changedKeys,
      before_parameters: beforeParameters,
      suggested_parameters: afterParameters,
      message: changedKeys.length
        ? dryRun
          ? `影子预算候选补丁可应用：limit ${beforeParameters.limit ?? '-'} → ${recommendedLimit}。`
          : `影子预算候选补丁已应用：limit ${beforeParameters.limit ?? '-'} → ${recommendedLimit}。`
        : '影子预算任务参数已与候选补丁一致，无需更新。',
    };

    if (!dryRun && changedKeys.length > 0) {
      await task.update({ parameters: afterParameters });
      await taskParameterAuditService.record({
        task,
        event_type: LIVE_AUDIT_EVENT_TYPES.SHADOW_BUDGET_APPLIED,
        before_parameters: beforeParameters,
        after_parameters: afterParameters,
        changed_keys: changedKeys,
        operator: options.operator,
        metadata: {
          source: 'live_shadow_budget_suggestion_apply',
          source_audit_id: Number((audit as any).id),
          real_order_submitted: 0,
          note: '仅应用影子执行任务预算参数，不触发真实券商委托。',
        },
      });
      await this.reloadTask(Number((task as any).id));
      result.applied = true;
    }

    return result;
  }

  async reloadTask(taskId: number) {
    const task = await ScheduledTask.findByPk(taskId);
    if (!task) return;

    if (task.is_active) {
      this.scheduleTask(task);
    } else {
      if (this.activeTasks.has(task.id)) {
        this.activeTasks.get(task.id)?.stop();
        this.activeTasks.delete(task.id);
        logger.info(`Stopped scheduled task ${task.id}`);
      }
    }
  }

  async getAllTasks() {
    return await ScheduledTask.findAll({ order: [['id', 'ASC']] });
  }

  async reconcileStaleRunningTasks() {
    const staleBefore = moment().subtract(6, 'hours').toDate();
    const [taskCount, logCount] = await Promise.all([
      ScheduledTask.update(
        { last_run_status: 'FAILED' },
        {
          where: {
            last_run_status: 'RUNNING',
            last_run_at: { [Op.lt]: staleBefore },
          },
        }
      ),
      TaskExecutionLog.update(
        {
          status: 'FAILED',
          completed_at: new Date(),
          error_message: '任务长时间处于运行中，系统启动时自动标记为失败',
        },
        {
          where: {
            status: 'IN_PROGRESS',
            started_at: { [Op.lt]: staleBefore },
          },
        }
      ),
    ]);

    const updatedTasks = Array.isArray(taskCount) ? taskCount[0] : taskCount;
    const updatedLogs = Array.isArray(logCount) ? logCount[0] : logCount;
    if (updatedTasks || updatedLogs) {
      logger.warn(
        `Reconciled stale scheduler states. tasks=${updatedTasks || 0}, logs=${updatedLogs || 0}`
      );
    }
  }

  /**
   * Batch AH review (2026-06-18) — catch-up missed sync tasks on server boot.
   *
   * 启动时扫描白名单 sync task type, 若它们 cron 的"今日窗口"已过 + last_run_at
   * 是 null 或早于今日 00:00 上海时区 → 立即异步触发一次 (走 normal handler).
   *
   * 白名单仅 sync 类 (数据同步), 不含策略/风控类 — 避免 deploy 时反复触发
   * trade 操作.
   *
   * 限流: 任务之间 sleep 5s, 防 AKShare 限频.
   */
  private async catchUpMissedTasks(tasks: ScheduledTask[]) {
    const CATCH_UP_WHITELIST = new Set([
      'INDUSTRY_FLOW_SYNC',
      'LIMIT_UP_SYNC',
      'NORTHBOUND_SYNC',
      'SNOWBALL_HOT_KEYWORD_SYNC',
      'STOCK_SENTIMENT_SYNC',
      'MARKET_NEWS_SYNC',
      'SOCIAL_SENTIMENT_SYNC',
      'MARKET_HOT_SEARCH_SYNC',
      // Batch AH review (2026-06-18): 把 factor 计算也加入 catch-up,
      // 这样 deploy 重启或者 17:30 错过都会自动补跑. compute 比较重 (~30min),
      // 但 deploy 重启发生频率低; 加 60min 最小间隔避免短时间内反复触发.
      'FACTOR_SCORE_COMPUTE',
    ]);
    // 重活儿不能短时间内反复触发: FACTOR_SCORE_COMPUTE 需要 60min cooldown
    const COOLDOWN_MIN: Record<string, number> = {
      FACTOR_SCORE_COMPUTE: 60,
    };

    const todayStart = moment().tz('Asia/Shanghai').startOf('day').toDate();
    const now = new Date();
    const candidates = tasks.filter(t => {
      if (!CATCH_UP_WHITELIST.has(t.type)) return false;
      if (!t.is_active) return false;
      // 已在今天跑过 → skip
      if (t.last_run_at && new Date(t.last_run_at) >= todayStart) return false;
      // 冷却时间检查: 重活儿在冷却内不能再 catch-up
      const cooldownMin = COOLDOWN_MIN[t.type];
      if (cooldownMin && t.last_run_at) {
        const sinceLastRun = (now.getTime() - new Date(t.last_run_at).getTime()) / 60_000;
        if (sinceLastRun < cooldownMin) return false;
      }
      // cron 今日窗口还没到 → skip (今天会自然 trigger)
      if (!t.cron_expression) return false;
      const todayFireTime = nextTodayFireTimeForCron(t.cron_expression);
      if (!todayFireTime || todayFireTime > now) return false;
      return true;
    });

    if (candidates.length === 0) {
      logger.info(`[catch-up] no missed sync tasks to recover`);
      return;
    }

    logger.warn(
      `[catch-up] found ${candidates.length} missed sync task(s): ${candidates
        .map(t => t.type)
        .join(', ')} — triggering async with 5s gap`
    );

    // 按 type 异步串行 (不并发, 防 AKShare 同步限频)
    for (const t of candidates) {
      try {
        await new Promise<void>(resolve => setTimeout(resolve, 5_000));
        logger.info(`[catch-up] firing missed task: ${t.type} (#${t.id} "${t.name}")`);
        // 调 executeTask (执行真的 handler) — 但不阻塞 catch-up loop
        void this.executeTask(t.id).catch(err =>
          logger.warn(`[catch-up] task ${t.id} failed: ${err?.message}`)
        );
      } catch (err) {
        logger.warn(`[catch-up] schedule failed for ${t.type}: ${(err as Error).message}`);
      }
    }
  }

  async ensureDefaultTasks() {
    const defaultTasks = [
      {
        name: '每日行情增量同步',
        type: 'DAILY_UPDATE',
        cron_expression: '10 17 * * 1-5',
        is_active: true,
        parameters: {
          force_update: false,
          // PR-N (2026-06-29): 300 → 2000 — 解决 PR-J 揭示的 sh.688 / sz.001 /
          // sz.301 板块永远 sync 不到的根因. A 股 listed ≈ 5500, 300 cap 让
          // 缺 daily_bars 的新股每天只能补 ~300 只, 排到第二天又被更新更晚的票
          // 挤掉, 形成永远轮不到的死循环. 2000 让 3 个交易日全市场覆盖一次,
          // 实测 5 并发 ≈ 单股 200ms × 2000 = ~7 分钟跑完, 不堵塞盘后任务.
          max_stocks: 2000,
        },
      },
      {
        name: '全量股票日线同步',
        type: 'SYNC_HISTORY',
        cron_expression: '0 18 * * 1-5',
        is_active: true,
        parameters: {
          syncAllStocks: true,
          lookback_days: 10,
          dataSource: 'tencent_only',
          concurrency: 5,
          batch_limit: 300,
          lag_days_threshold: 0,
          stale_first: true,
        },
      },
      {
        name: '基准指数行情同步',
        type: 'BENCHMARK_INDEX_SYNC',
        cron_expression: '5 15 * * 1-5',
        is_active: true,
        parameters: {
          lookback_days: 180,
          data_source: 'tencent_only',
          concurrency: 2,
          report_to_feishu: true,
        },
      },
      {
        name: '实盘影子执行闭环',
        type: 'LIVE_SHADOW_AUTOPILOT',
        cron_expression: '58 9 * * 1-5',
        is_active: true,
        parameters: {
          username: 'stock',
          limit: 2,
          outcome_limit: 30,
          horizons: [1, 3, 5],
          source: 'scheduled_open_shadow_autopilot',
          require_opening_readiness: true,
          allow_degraded_readiness: true,
          factor_limit: 220,
          cache_ttl_ms: 90_000,
          dry_run: false,
          report_to_feishu: true,
          notify_to_feishu_bot: false,
          record_type: '实盘影子执行闭环',
        },
      },
      {
        name: '影子执行周度复盘',
        type: 'LIVE_SHADOW_WEEKLY_REVIEW',
        cron_expression: '20 16 * * 5',
        is_active: true,
        parameters: {
          username: 'stock',
          outcome_limit: 80,
          horizons: [1, 3, 5],
          report_to_feishu: true,
          notify_to_feishu_bot: false,
          record_type: '影子执行周度复盘',
        },
      },
      {
        name: '量化参数后验维护',
        type: 'QUANT_PARAM_MAINTENANCE',
        cron_expression: '45 16 * * 1-5',
        is_active: true,
        parameters: {
          lookback_days: 21,
          horizons: [1, 3, 5, 10],
          signal: ['buy', 'watch'],
          limit: 1500,
          refresh_limit: 5000,
          lifecycle_limit: 5000,
          auto_sync_benchmark: false,
          dry_run_lifecycle: false,
          report_to_feishu: true,
          notify_to_feishu_bot: false,
          record_type: '量化参数后验维护',
        },
      },
      {
        name: '实时行情快照刷新',
        type: 'REALTIME_QUOTE_SYNC',
        cron_expression: '5,25 9,10,13,14 * * 1-5',
        is_active: true,
        parameters: {
          universe: 'market',
          // Batch AR (2026-06-21): 360 → 5000, 全 A 股 universe.
          limit: 5000,
          source: 'auto',
          batch_size: 300,
          report_to_feishu: false,
          notify_to_feishu_bot: false,
          record_type: '实时行情快照刷新',
        },
      },
      {
        name: '量化策略全市场扫描',
        type: 'QUANT_DAILY_PIPELINE',
        cron_expression: '32 15 * * 1-5',
        is_active: true,
        parameters: {
          // PR-H (2026-06-29) — 15:32 跑的是"明日预谋", UI 卡片标 🌙 隔夜潜伏, 建议次日 9:30 买.
          timing_tag: 'overnight',
          username: 'stock',
          use_autonomous_portfolio: true,
          portfolio_name: AUTONOMOUS_PORTFOLIO_NAME,
          initial_capital: DEFAULT_AUTONOMOUS_INITIAL_CAPITAL,
          universe: 'market',
          strategy_keys: [
            'multi_factor_ranking',
            'relative_strength_momentum',
            'ma_trend',
            'volume_price_confirmation',
            'low_volatility_quality',
            // Sprint 40 #2: 组合级策略 (generateSignals 入口) 加入每日 pipeline.
            // QuantSignalService 内部识别这两个 key,跳过 per-stock evaluate loop,
            // 单独调它们的 generateSignals(date) 把 target_portfolio 转成 QuantSignal
            // 行入库,让 archive / agent / paper trading 闸门像消费其他 5 个 per-stock
            // 策略一样消费它们的信号. 用 dist 分位映射 score 到 [60,95] 保证稳定进闸门.
            'multi_factor_alpha',
            'ensemble_strategy',
          ],
          lookback_days: 180,
          candidate_limit: 220,
          refresh_realtime_quotes: true,
          sync_factors_before_scan: true,
          factor_sync_scope: 'market',
          factor_sync_limit: 360,
          factor_provider: 'auto',
          factor_sync_skip_if_coverage_rate_gte: 92,
          factor_sync_skip_if_real_provider_rate_gte: 65,
          quote_sync_limit: 360,
          realtime_quote_source: 'auto',
          min_score: 70,
          archive_limit: 20,
          max_industry_candidates: 3,
          max_strategy_candidates: 5,
          submit_agent_analysis: true,
          agent_max_count: 5,
          agent_min_score: 76,
          agent_paper_trade_min_score: 68,
          agent_session: 'close',
          agent_auto_paper_trade: true,
          run_paper_trading: true,
          dry_run: false,
          paper_trade_limit: 2,
          paper_trade_scan_limit: 100,
          max_positions: 8,
          default_position_pct: 5,
          max_position_pct: 10,
          min_trade_amount: 3000,
          strategy_weight_lookback_days: 365,
          use_entry_risk_guard: true,
          max_daily_new_positions: 2,
          max_daily_new_exposure_pct: 8,
          max_total_exposure_pct: 60,
          max_industry_exposure_pct: 25,
          min_cash_reserve_pct: 8,
          max_portfolio_drawdown_pct: 12,
          max_single_stock_volatility_pct: 7,
          max_position_correlation: 0.82,
          max_portfolio_var_pct: 10,
          min_avg_turnover_yuan: 30000000,
          cooldown_days_after_loss: 12,
          use_experiment_params: true,
          experiment_param_policy: {
            min_rank_score: 8,
            min_excess_return_pct: 0,
            min_trade_count: 1,
            max_drawdown_pct: 35,
            min_stable_count: 1,
          },
          block_limit_up: true,
          block_limit_down: true,
          block_suspended: true,
          block_buy_on_runtime_risk: true,
          risk_threshold_stability_min_consecutive_same_action: 2,
          risk_threshold_stability_min_actionable_samples: 2,
          risk_threshold_stability_min_protected_runs: 3,
          risk_threshold_stability_tighten_min_delta_pct: 0.5,
          risk_threshold_stability_relax_max_delta_pct: -0.8,
          risk_threshold_field_stability_min_consecutive_same_action: 2,
          risk_threshold_field_min_confidence: 0.45,
          risk_threshold_field_min_sample_count: 3,
          risk_threshold_field_min_triggered_count: 1,
          report_to_feishu: true,
          notify_to_feishu_bot: true,
          record_type: '量化策略全市场扫描',
        },
      },
      {
        name: '量化策略开盘机会扫描',
        type: 'QUANT_DAILY_PIPELINE',
        cron_expression: '25 9 * * 1-5',
        is_active: true,
        parameters: {
          // PR-H — 9:25 集合竞价撮合 (9:25:00) 后立即跑, UI 卡片标 🌅 早盘抢, 建议 9:30-10:00 买入.
          // 此前 cron 是 35 9, 在开盘 5 分钟之后才生成信号, 用户错过开盘最优买点.
          // 拉前到 9:25 是 PRD 决策: 集合竞价撮合后立即扫描, 9:30 开盘即可参考.
          timing_tag: 'opening_rush',
          username: 'stock',
          use_autonomous_portfolio: true,
          portfolio_name: AUTONOMOUS_PORTFOLIO_NAME,
          initial_capital: DEFAULT_AUTONOMOUS_INITIAL_CAPITAL,
          universe: 'market',
          strategy_keys: [
            'multi_factor_ranking',
            'relative_strength_momentum',
            'ma_trend',
            'volume_price_confirmation',
            'low_volatility_quality',
            // Sprint 40 #2: 组合级策略也加入开盘扫描. 这俩策略 evaluate() 是 hold,
            // 真入口 generateSignals(date) 由 QuantSignalService 内部 dispatcher 调用,
            // 输出转 QuantSignalResult 拼回主 signals 数组共享 archive/paper trading 闸门.
            'multi_factor_alpha',
            'ensemble_strategy',
          ],
          lookback_days: 180,
          candidate_limit: 220,
          refresh_realtime_quotes: true,
          sync_factors_before_scan: true,
          factor_sync_scope: 'market',
          factor_sync_limit: 360,
          factor_provider: 'auto',
          factor_sync_skip_if_coverage_rate_gte: 92,
          factor_sync_skip_if_real_provider_rate_gte: 65,
          quote_sync_limit: 360,
          realtime_quote_source: 'auto',
          min_score: 70,
          archive_limit: 20,
          max_industry_candidates: 3,
          max_strategy_candidates: 5,
          submit_agent_analysis: true,
          agent_max_count: 5,
          agent_min_score: 76,
          agent_paper_trade_min_score: 68,
          agent_session: 'open',
          agent_auto_paper_trade: true,
          run_paper_trading: true,
          dry_run: false,
          paper_trade_limit: 2,
          paper_trade_scan_limit: 100,
          max_positions: 8,
          default_position_pct: 4,
          max_position_pct: 8,
          min_trade_amount: 3000,
          strategy_weight_lookback_days: 365,
          use_entry_risk_guard: true,
          max_daily_new_positions: 2,
          max_daily_new_exposure_pct: 8,
          max_total_exposure_pct: 60,
          max_industry_exposure_pct: 25,
          min_cash_reserve_pct: 8,
          max_portfolio_drawdown_pct: 12,
          max_single_stock_volatility_pct: 7,
          max_position_correlation: 0.82,
          max_portfolio_var_pct: 10,
          min_avg_turnover_yuan: 30000000,
          cooldown_days_after_loss: 12,
          use_experiment_params: true,
          experiment_param_policy: {
            min_rank_score: 8,
            min_excess_return_pct: 0,
            min_trade_count: 1,
            max_drawdown_pct: 35,
            min_stable_count: 1,
          },
          block_limit_up: true,
          block_limit_down: true,
          block_suspended: true,
          block_buy_on_runtime_risk: true,
          risk_threshold_stability_min_consecutive_same_action: 2,
          risk_threshold_stability_min_actionable_samples: 2,
          risk_threshold_stability_min_protected_runs: 3,
          risk_threshold_stability_tighten_min_delta_pct: 0.5,
          risk_threshold_stability_relax_max_delta_pct: -0.8,
          risk_threshold_field_stability_min_consecutive_same_action: 2,
          risk_threshold_field_min_confidence: 0.45,
          risk_threshold_field_min_sample_count: 3,
          risk_threshold_field_min_triggered_count: 1,
          report_to_feishu: true,
          notify_to_feishu_bot: true,
          record_type: '量化策略开盘机会扫描',
        },
      },
      // PR-H (2026-06-29) — 午后开盘扫描 (12:55, 距 13:00 午盘 5min). UI 标 ☀️ 午后攻.
      //   集合竞价信号 + 早盘资金流 / 午间消息驱动. agent_session='afternoon' 让信号链路区分.
      //   submit_agent_analysis/run_paper_trading=false: 减负 (只生成信号给用户看, 不自动跟单).
      {
        name: '量化策略午后开盘扫描 (PR-H)',
        type: 'QUANT_DAILY_PIPELINE',
        cron_expression: '55 12 * * 1-5',
        is_active: true,
        parameters: {
          timing_tag: 'afternoon_kick',
          username: 'stock',
          use_autonomous_portfolio: true,
          portfolio_name: AUTONOMOUS_PORTFOLIO_NAME,
          initial_capital: DEFAULT_AUTONOMOUS_INITIAL_CAPITAL,
          universe: 'market',
          strategy_keys: [
            'multi_factor_ranking',
            'relative_strength_momentum',
            'ma_trend',
            'volume_price_confirmation',
            'multi_factor_alpha',
          ],
          lookback_days: 180,
          candidate_limit: 180,
          refresh_realtime_quotes: true,
          sync_factors_before_scan: false,
          quote_sync_limit: 360,
          realtime_quote_source: 'auto',
          min_score: 72,
          archive_limit: 15,
          max_industry_candidates: 3,
          max_strategy_candidates: 4,
          submit_agent_analysis: false,
          agent_session: 'afternoon',
          agent_auto_paper_trade: false,
          run_paper_trading: false,
          dry_run: false,
          paper_trade_limit: 2,
          max_positions: 8,
          default_position_pct: 4,
          max_position_pct: 8,
          min_trade_amount: 3000,
          use_entry_risk_guard: true,
          block_limit_up: true,
          block_limit_down: true,
          block_suspended: true,
          block_buy_on_runtime_risk: true,
          report_to_feishu: false,
          notify_to_feishu_bot: false,
          record_type: '量化策略午后开盘扫描',
        },
      },
      // PR-H (2026-06-29) — 尾盘扫描 (14:30, 距 14:57 收盘集合竞价 27min). UI 标 🌆 尾盘埋.
      //   全天量比 + 主力净流入 + 尾盘拉升驱动. 建议 14:30-14:55 内买入 (避开 14:57 集合竞价).
      {
        name: '量化策略尾盘扫描 (PR-H)',
        type: 'QUANT_DAILY_PIPELINE',
        cron_expression: '30 14 * * 1-5',
        is_active: true,
        parameters: {
          timing_tag: 'closing_grab',
          username: 'stock',
          use_autonomous_portfolio: true,
          portfolio_name: AUTONOMOUS_PORTFOLIO_NAME,
          initial_capital: DEFAULT_AUTONOMOUS_INITIAL_CAPITAL,
          universe: 'market',
          strategy_keys: [
            'multi_factor_ranking',
            'relative_strength_momentum',
            'ma_trend',
            'volume_price_confirmation',
            'multi_factor_alpha',
          ],
          lookback_days: 180,
          candidate_limit: 180,
          refresh_realtime_quotes: true,
          sync_factors_before_scan: false,
          quote_sync_limit: 360,
          realtime_quote_source: 'auto',
          min_score: 72,
          archive_limit: 15,
          max_industry_candidates: 3,
          max_strategy_candidates: 4,
          submit_agent_analysis: false,
          agent_session: 'closing',
          agent_auto_paper_trade: false,
          run_paper_trading: false,
          dry_run: false,
          paper_trade_limit: 2,
          max_positions: 8,
          default_position_pct: 4,
          max_position_pct: 8,
          min_trade_amount: 3000,
          use_entry_risk_guard: true,
          block_limit_up: true,
          block_limit_down: true,
          block_suspended: true,
          block_buy_on_runtime_risk: true,
          report_to_feishu: false,
          notify_to_feishu_bot: false,
          record_type: '量化策略尾盘扫描',
        },
      },
      {
        name: '量化开盘链路看门狗',
        type: 'QUANT_OPEN_WATCHDOG',
        cron_expression: '55 9 * * 1-5',
        is_active: true,
        parameters: {
          target_task_name: '量化策略开盘机会扫描',
          // PR-H — 开盘扫描提前到 9:25, watchdog expected_after 也下调到 09:25.
          // 整体宽限窗口仍是 9:55 (开盘后 25 min). 集合竞价 9:25 撮合 + 量化扫描需要 ~5min,
          // 一般 9:30-9:32 完成. latest_allowed_minutes 30 让"9:25 跑→9:50 落库"仍 healthy.
          expected_after_time: '09:25',
          latest_allowed_minutes: 30,
          min_quant_signals: 1,
          min_archived_signals: 1,
          require_fresh_quote: true,
          freshness_max_minutes: 75,
          report_to_feishu: true,
          notify_to_feishu_bot: true,
          record_type: '量化开盘链路看门狗',
        },
      },
      {
        name: 'AI优选-早盘分析',
        type: 'AI_DAILY_SCREENER',
        cron_expression: '0 9 * * 1-5',
        is_active: true,
        parameters: {
          universe: 'favorites',
          style: 'balanced',
          candidate_limit: 10,
          lookback_days: 120,
        },
      },
      {
        name: 'AI优选-午盘分析',
        type: 'AI_DAILY_SCREENER',
        cron_expression: '30 12 * * 1-5',
        is_active: true,
        parameters: {
          universe: 'favorites',
          style: 'balanced',
          candidate_limit: 10,
          lookback_days: 120,
        },
      },
      {
        name: 'AI优选-收盘分析',
        type: 'AI_DAILY_SCREENER',
        cron_expression: '30 14 * * 1-5',
        is_active: true,
        parameters: {
          universe: 'favorites',
          style: 'balanced',
          candidate_limit: 10,
          lookback_days: 120,
          agent_session: 'close',
        },
      },
      {
        name: '全市场AI机会扫描',
        type: 'AI_DAILY_SCREENER',
        cron_expression: '35 14 * * 1-5',
        is_active: true,
        parameters: {
          universe: 'market',
          style: 'balanced',
          candidate_limit: 8,
          lookback_days: 120,
          agent_session: 'close',
        },
      },
      {
        name: '全市场荐股闭环',
        type: 'AUTO_RECOMMENDATION_LOOP',
        cron_expression: '45 15 * * 1-5',
        is_active: true,
        parameters: {
          username: 'stock',
          use_autonomous_portfolio: true,
          portfolio_name: AUTONOMOUS_PORTFOLIO_NAME,
          initial_capital: DEFAULT_AUTONOMOUS_INITIAL_CAPITAL,
          universe: 'market',
          style: 'balanced',
          candidate_limit: 30,
          candidate_pool_limit: 360,
          lookback_days: 120,
          min_bars: 35,
          exclude_st: true,
          min_market_cap_yi: 30,
          archive_limit: 30,
          verify_signals: true,
          run_paper_trading: true,
          dry_run: false,
          paper_trade_limit: 3,
          paper_trade_scan_limit: 150,
          min_score: 72,
          max_positions: 8,
          default_position_pct: 5,
          max_position_pct: 10,
          min_trade_amount: 3000,
          use_outcome_feedback: true,
          use_policy_version_feedback: true,
          policy_version_lookback_limit: 120,
          use_strategy_experiment_feedback: true,
          strategy_experiment_min_quality_delta: 4,
          strategy_experiment_limit: 12,
          strategy_experiment_pool_limit: 240,
          outcome_feedback_lookback_days: 365,
          outcome_feedback_min_closed_samples: 5,
          use_profit_gate: true,
          profit_gate_horizon: '5d',
          profit_gate_min_samples: 5,
          profit_gate_min_quality_score: 45,
          use_entry_risk_guard: true,
          max_daily_new_positions: 3,
          max_daily_new_exposure_pct: 12,
          max_total_exposure_pct: 60,
          max_industry_exposure_pct: 25,
          min_cash_reserve_pct: 8,
          max_portfolio_drawdown_pct: 12,
          max_single_stock_volatility_pct: 7,
          max_position_correlation: 0.82,
          max_portfolio_var_pct: 10,
          risk_threshold_stability_min_consecutive_same_action: 2,
          risk_threshold_stability_min_actionable_samples: 2,
          risk_threshold_stability_min_protected_runs: 3,
          risk_threshold_stability_tighten_min_delta_pct: 0.5,
          risk_threshold_stability_relax_max_delta_pct: -0.8,
          risk_threshold_field_stability_min_consecutive_same_action: 2,
          risk_threshold_field_min_confidence: 0.45,
          risk_threshold_field_min_sample_count: 3,
          risk_threshold_field_min_triggered_count: 1,
          min_avg_turnover_yuan: 30000000,
          cooldown_days_after_loss: 12,
          block_limit_up: true,
          block_limit_down: true,
          block_suspended: true,
          agent_auto_paper_trade: true,
          agent_only_paper_trade_min_score: 45,
          submit_agent_analysis: true,
          agent_max_count: 5,
          agent_min_score: 72,
          agent_session: 'close',
          report_to_feishu: true,
          record_type: '全市场荐股闭环',
        },
      },
      {
        name: '推荐绩效后验刷新',
        type: 'SIGNAL_PERFORMANCE_REFRESH',
        cron_expression: '20 15 * * 1-5',
        is_active: true,
        parameters: {
          limit: 500,
          report_to_feishu: true,
        },
      },
      {
        name: 'Agent尾盘建议收益追踪',
        type: 'SIGNAL_PERFORMANCE_REFRESH',
        cron_expression: '25 15 * * 1-5',
        is_active: true,
        parameters: {
          source_type: 'tradingagents',
          agent_session: 'close',
          horizon: '5d',
          limit: 1000,
          record_type: 'Agent尾盘建议收益追踪',
          auto_repair_missing_data: true,
          data_source: 'tencent_only',
          lookback_days: 15,
          sync_concurrency: 2,
          report_to_feishu: true,
        },
      },
      {
        name: '信号质量日报',
        type: 'SIGNAL_QUALITY_DAILY_REPORT',
        cron_expression: '30 16 * * 1-5',
        is_active: true,
        parameters: {
          horizon: '5d',
          lookback_days: 30,
          min_samples: 5,
          limit: 5000,
          auto_repair_missing_data: true,
          data_source: 'tencent_only',
          repair_lookback_days: 30,
          sync_concurrency: 2,
          verify_before_report: true,
          report_to_feishu: true,
          record_type: '信号质量日报',
        },
      },
      {
        name: '推荐信号模拟盘跟单',
        type: 'PAPER_TRADING_AUTO_SYNC',
        cron_expression: '40 15 * * 1-5',
        is_active: true,
        parameters: {
          username: 'stock',
          use_autonomous_portfolio: true,
          portfolio_name: AUTONOMOUS_PORTFOLIO_NAME,
          initial_capital: DEFAULT_AUTONOMOUS_INITIAL_CAPITAL,
          refresh_recommendations: true,
          universe: 'favorites',
          style: 'balanced',
          candidate_limit: 20,
          lookback_days: 120,
          source_type: 'quant_recommendation',
          limit: 3,
          scan_limit: 100,
          min_score: 72,
          max_positions: 8,
          default_position_pct: 5,
          max_position_pct: 10,
          min_trade_amount: 3000,
          allowed_risk_levels: ['low', 'medium'],
          require_action_buy: true,
          use_attribution_feedback: true,
          use_profit_gate: true,
          profit_gate_horizon: '5d',
          profit_gate_min_samples: 5,
          profit_gate_min_quality_score: 45,
          profit_gate_allow_deprioritized: false,
          profit_gate_allow_sampling: true,
          profit_gate_sampling_multiplier: 0.35,
          use_outcome_feedback: true,
          outcome_feedback_min_closed_samples: 5,
          outcome_feedback_lookback_days: 365,
          outcome_feedback_limit: 2000,
          dry_run: false,
          report_to_feishu: true,
        },
      },
      {
        name: 'Agent尾盘建议模拟盘跟单',
        type: 'PAPER_TRADING_AUTO_SYNC',
        cron_expression: '42 15 * * 1-5',
        is_active: true,
        parameters: {
          username: 'stock',
          use_autonomous_portfolio: true,
          portfolio_name: AUTONOMOUS_PORTFOLIO_NAME,
          initial_capital: DEFAULT_AUTONOMOUS_INITIAL_CAPITAL,
          refresh_recommendations: false,
          source_type: 'tradingagents',
          agent_session: 'close',
          limit: 2,
          scan_limit: 80,
          min_score: 72,
          max_positions: 8,
          default_position_pct: 4,
          max_position_pct: 8,
          min_trade_amount: 3000,
          allowed_risk_levels: ['low', 'medium'],
          require_action_buy: false,
          use_attribution_feedback: true,
          use_profit_gate: true,
          profit_gate_horizon: '5d',
          profit_gate_min_samples: 5,
          profit_gate_min_quality_score: 45,
          profit_gate_allow_deprioritized: false,
          profit_gate_allow_sampling: true,
          profit_gate_sampling_multiplier: 0.35,
          use_outcome_feedback: true,
          outcome_feedback_min_closed_samples: 5,
          outcome_feedback_lookback_days: 365,
          outcome_feedback_limit: 2000,
          dry_run: false,
          report_to_feishu: true,
        },
      },
      {
        name: '模拟盘风控退出检查',
        type: 'PAPER_TRADING_RISK_CHECK',
        cron_expression: '50 15 * * 1-5',
        is_active: true,
        parameters: {
          username: 'stock',
          use_autonomous_portfolio: true,
          portfolio_name: AUTONOMOUS_PORTFOLIO_NAME,
          initial_capital: DEFAULT_AUTONOMOUS_INITIAL_CAPITAL,
          limit: 30,
          enable_stop_loss: true,
          enable_take_profit: true,
          enable_trailing_take_profit: true,
          enable_sell_signals: true,
          use_adaptive_risk_policy: true,
          adaptive_risk_lookback_days: 180,
          adaptive_risk_min_closed_samples: 5,
          adaptive_risk_override_signal_params: false,
          default_stop_loss_pct: 7,
          default_take_profit_pct: 14,
          trailing_activation_pct: 8,
          trailing_drawdown_pct: 4,
          max_hold_days: 20,
          min_sell_signal_score: 60,
          sell_signal_source_type: 'all',
          dry_run: false,
          report_to_feishu: true,
        },
      },
      {
        name: '模拟盘收益归因报告',
        type: 'PAPER_TRADING_ATTRIBUTION_REPORT',
        cron_expression: '5 16 * * 1-5',
        is_active: true,
        parameters: {
          username: 'stock',
          use_autonomous_portfolio: true,
          portfolio_name: AUTONOMOUS_PORTFOLIO_NAME,
          initial_capital: DEFAULT_AUTONOMOUS_INITIAL_CAPITAL,
          include_open: true,
          limit: 2000,
          report_to_feishu: true,
        },
      },
      {
        name: '推荐交易收益闭环刷新',
        type: 'RECOMMENDATION_TRADE_OUTCOME_REFRESH',
        cron_expression: '2 16 * * 1-5',
        is_active: true,
        parameters: {
          username: 'stock',
          use_autonomous_portfolio: true,
          portfolio_name: AUTONOMOUS_PORTFOLIO_NAME,
          initial_capital: DEFAULT_AUTONOMOUS_INITIAL_CAPITAL,
          include_open: true,
          lookback_days: 180,
          limit: 2000,
          report_to_feishu: true,
        },
      },
      {
        name: '模拟盘交易计划报告',
        type: 'PAPER_TRADING_DAILY_PLAN',
        cron_expression: '10 16 * * 1-5',
        is_active: true,
        parameters: {
          username: 'stock',
          use_autonomous_portfolio: true,
          portfolio_name: AUTONOMOUS_PORTFOLIO_NAME,
          initial_capital: DEFAULT_AUTONOMOUS_INITIAL_CAPITAL,
          include_entries: true,
          include_exits: true,
          include_monitor: true,
          source_type: 'quant_recommendation',
          limit: 30,
          entry_limit: 3,
          scan_limit: 100,
          min_score: 72,
          max_positions: 8,
          default_position_pct: 5,
          max_position_pct: 10,
          min_trade_amount: 3000,
          allowed_risk_levels: ['low', 'medium'],
          use_attribution_feedback: true,
          use_profit_gate: true,
          profit_gate_horizon: '5d',
          profit_gate_min_samples: 5,
          profit_gate_min_quality_score: 45,
          profit_gate_allow_deprioritized: false,
          profit_gate_allow_sampling: true,
          profit_gate_sampling_multiplier: 0.35,
          use_outcome_feedback: true,
          outcome_feedback_min_closed_samples: 5,
          outcome_feedback_lookback_days: 365,
          outcome_feedback_limit: 2000,
          enable_stop_loss: true,
          enable_take_profit: true,
          enable_trailing_take_profit: true,
          enable_sell_signals: true,
          use_adaptive_risk_policy: true,
          adaptive_risk_lookback_days: 180,
          adaptive_risk_min_closed_samples: 5,
          adaptive_risk_override_signal_params: false,
          default_stop_loss_pct: 7,
          default_take_profit_pct: 14,
          trailing_activation_pct: 8,
          trailing_drawdown_pct: 4,
          max_hold_days: 20,
          min_sell_signal_score: 60,
          sell_signal_source_type: 'all',
          report_to_feishu: true,
          capture_canary_snapshot: true,
        },
      },
      {
        // US-063 — 每个交易日 15:30 给所有 notification_channels.feishu.daily_digest=true
        // 的用户发飞书 interactive card 日报。
        name: '飞书当日交易日报',
        type: 'PAPER_TRADING_DAILY_DIGEST',
        cron_expression: '30 15 * * 1-5',
        is_active: true,
        parameters: {
          dry_run: false,
          per_strategy_limit: 5,
          per_direction_trade_limit: 3,
        },
      },
      {
        // US-064 — 业绩预告即时提醒（持仓 path）。每 15 分钟跑一次仅扫持仓股，
        // 命中即时推送（dedup buffer 防重复）。
        name: '业绩预告持仓即时提醒',
        type: 'EARNINGS_FORECAST_WATCH',
        cron_expression: '*/15 9-15 * * 1-5',
        is_active: true,
        parameters: {
          dry_run: false,
          mode: 'held',
          recent_days: 7,
        },
      },
      {
        // US-064 — 业绩预告自选股盘后汇总（watchlist path）。每个交易日 15:35
        // 跑一次（晚 daily-digest 5min），单 user 一条 digest card 汇总所有
        // 自选股当日新预告。
        name: '业绩预告自选盘后汇总',
        type: 'EARNINGS_FORECAST_WATCH',
        cron_expression: '35 15 * * 1-5',
        is_active: true,
        parameters: {
          dry_run: false,
          mode: 'watchlist',
          recent_days: 7,
        },
      },
      {
        // US-065 — 每周一 08:00 给所有 notification_channels.email.weekly_review=true
        // 的用户发上周 (周一-周日) 策略复盘 HTML 邮件 (PnL / 行业贡献 / 关注事件 /
        // AI 周观点)。SMTP 通过 SMTP_HOST/PORT/USER/PASS/SECURE/FROM env 配置。
        name: '邮件周度策略复盘',
        type: 'WEEKLY_REVIEW_EMAIL',
        cron_expression: '0 8 * * 1',
        is_active: true,
        parameters: {
          dry_run: false,
          upcoming_lookahead_days: 7,
        },
      },
      {
        // US-083 PM-006 — 工作日 17:00 (盘后 + DAILY_UPDATE 18:00 前) 给所有 active
        // paper_trading_portfolio 生成 6 维归因报告并 upsert 到 daily_attribution_reports.
        // 时间窗 (17:00) 早于 ENHANCED_TRADING_JOURNAL_GENERATE (15:40) 不冲突, 因为
        // journal 用的是 15:30 daily_digest 的快照, 而 attribution 用的是 17:00 之前
        // 的 snapshot/trade 落库结果, 二者读取互不依赖.
        // 默认 dry_run=false, 单 portfolio 失败 fail-OPEN continue 不阻塞 batch.
        name: '每日归因报告生成',
        type: 'DAILY_ATTRIBUTION_GENERATE',
        cron_expression: '0 17 * * 1-5',
        is_active: true,
        parameters: {
          dry_run: false,
        },
      },
      {
        // US-091 PM-020 — 工作日 18:00 (DAILY_ATTRIBUTION_GENERATE 17:00 之后) 给所有
        // active user 生成 ≤ 500 字 AI 投资日记并 upsert ai_diary_entries.
        // 默认 dry_run=false + enable_llm=false (走 heuristic 零外网链路);
        // 单 user 失败 fail-OPEN continue 不阻塞 batch.
        name: 'AI 投资日记每日生成',
        type: 'AI_DIARY_GENERATE',
        cron_expression: '0 18 * * 1-5',
        is_active: true,
        parameters: {
          dry_run: false,
          enable_llm: false,
        },
      },
      {
        // US-093 PM-022 — 周日 10:00 给所有 active user 聚合最近 90 天
        // DailyAttributionReport → upsert error_pattern_reports.
        // 默认 dry_run=false + lookback_days=90 (走 heuristic 零外网);
        // 单 user 失败 fail-OPEN continue 不阻塞 batch.
        name: '周度错误模式聚合',
        type: 'WEEKLY_ERROR_PATTERN_AGGREGATE',
        cron_expression: '0 10 * * 0',
        is_active: true,
        parameters: {
          dry_run: false,
          lookback_days: 90,
        },
      },
      {
        // US-073 — 每个交易日 08:30 (开盘前 30 分钟) 生成「AI 大盘速读」当日卡片。
        // 5 维数据：沪深300 上日收盘 / 今日开盘 / 北向资金 / 涨停数 / AI 一句话观点。
        // 写入 market_briefs 表（一日一行 UPSERT），前端 TodayWorkspace 顶部
        // GET /api/ai/market-brief/today 直接读取；首次访问 / cron miss 时会
        // 通过 getTodayBrief 触发懒求值兜底。
        name: 'AI 大盘速读日度生成',
        type: 'MARKET_BRIEF_GENERATE',
        cron_expression: '30 8 * * 1-5',
        is_active: true,
        parameters: {
          dry_run: false,
          skip_ai: false,
        },
      },
      {
        // US-087 — 每个交易日 15:40 收盘后批量生成增强版 AI 复盘日记。
        // 5 段 markdown 输出（今日战报 / 操作复盘 / 市场观察 / 明日策略 / 风险提醒），
        // 写入 trading_journals 表，保留用户已追加的 user_notes 不动。
        // 默认 overwrite_hand_edited=false 不覆盖用户手编版本。
        // 时间晚于 daily_digest (15:30) 与 earnings_forecast watchlist (15:35)，
        // 让 journal 能反映当日已生成的 digest / 业绩告警状态。
        name: 'AI 复盘日记日度生成',
        type: 'ENHANCED_TRADING_JOURNAL_GENERATE',
        cron_expression: '40 15 * * 1-5',
        is_active: true,
        parameters: {
          dry_run: false,
          overwrite_hand_edited: false,
          skip_ai: false,
        },
      },
      {
        // US-097 — 每周日凌晨 3 点清理 90 天前回测 / 180 天前日志 / 30 天前已读告警。
        // dry_run=false → scheduler 触发是为了真正删 (CLI 手动入口默认 dry-run + --confirm 才删).
        // whitelist_strategies 默认 [] (不豁免); 维护者可加 'multi_factor_alpha' 等保留长期对照样本.
        name: '旧数据清理',
        type: 'CLEANUP_OLD_DATA',
        cron_expression: '0 3 * * 0',
        is_active: true,
        parameters: {
          backtest_retention_days: 90,
          log_retention_days: 180,
          alert_retention_days: 30,
          whitelist_strategies: [],
          dry_run: false,
          report_to_feishu: true,
        },
      },
      {
        // 新维度数据同步（宏观/期权波动率/大宗交易）
        // 每个交易日盘后 16:30 跑，足够覆盖当日宏观/QVIX 更新
        // fund 维度需要 --year 参数，单独手动 / 季报披露后跑
        name: '新维度数据同步',
        type: 'EXTRA_DIMS_SYNC',
        cron_expression: '30 16 * * 1-5',
        is_active: true,
        parameters: {
          dims: ['macro', 'qvix', 'block'],
          block_days: 7,
        },
      },
      {
        // Sprint 40 (优先级 #1): 每日盘后 factor_scores 生成 — 必须早于 IC.
        // 17:30 = daily_bar sync 完成 + 龙虎榜 (16:45) 完成之后, IC (19:00) 之前.
        name: '每日因子分数计算',
        type: 'FACTOR_SCORE_COMPUTE',
        cron_expression: '30 17 * * 1-5',
        is_active: true,
        parameters: {
          // date 默认今日 (Asia/Shanghai), 空跑全部 20 个 factor
        },
      },
      {
        // Sprint 41-A: 组合级策略真实调仓 — 必须晚于 QUANT_DAILY_PIPELINE (15:32)
        // 给 composite-level signals 落库的时间, 默认 dry_run=true + persist=true
        // 让运维先看 plan 再决定是否切真下单 (改 task params dry_run=false).
        // 17:50 = FACTOR_SCORE (17:30) 后 20 分钟, FACTOR_IC (19:00) 之前.
        name: '组合级策略真实调仓 (composite rebalance)',
        type: 'COMPOSITE_REBALANCE',
        cron_expression: '50 17 * * 1-5',
        is_active: true,
        parameters: {
          // trade_date 默认今日 (Asia/Shanghai)
          username: 'stock',
          dry_run: true, // 默认 dry-run, 运维确认后改 false
          persist: true, // 默认 persist plan 留审计
        },
      },
      {
        // Sprint 43-B: 每周一晚 19:30 跑 TCA 报告 — 拆 cost 来源 +
        // 算 per-strategy multiplier (实盘买不到/滑点大的策略自动降权 0.7 或 0.5).
        // 与 FACTOR_IC_COMPUTE (周一-五 19:00) 错开 30 分钟避免 DB 争用.
        // lookback_days=30 让一周数据稍微 smoothing.
        name: '每周交易成本归因 (TCA)',
        type: 'TCA_WEEKLY_REPORT',
        cron_expression: '30 19 * * 1', // 每周一晚 19:30
        is_active: true,
        parameters: {
          lookback_days: 30,
          // as_of_date 默认今日 (Asia/Shanghai)
        },
      },
      {
        // Sprint 43-D: 每周日晚 20:30 跑因子相关性 + 冗余度报告.
        // - lookback_days=30 (一个月) 滚动窗口算 Pearson 相关
        // - threshold=0.7 → |r| > 0.7 视为冗余, 写 factor_correlation_results +
        //   触发 RiskAlert
        // 周日晚跑给周一开盘前看 dashboard.
        name: '每周因子相关性报告',
        type: 'FACTOR_CORRELATION_WEEKLY',
        cron_expression: '30 20 * * 0', // 每周日晚 20:30
        is_active: true,
        parameters: {
          lookback_days: 30,
          threshold: 0.7,
        },
      },
      {
        // Phase 3: 每日因子 IC 自动计算 — 周一到周五盘后 19:00 (各 sync 跑完之后)
        // 默认 lookback 90 天 + 全部 18 个因子 + 5 个 forward 窗口 (1/5/10/20/60)
        // 跑完后 UI FactorWorkspace 因子卡 + LabWorkspace 都能拉到最新 IC 数据
        // CPU 占用：~10-15 分钟（取决于因子数 + 横截面大小）
        name: '因子 IC 自动计算',
        type: 'FACTOR_IC_COMPUTE',
        cron_expression: '0 19 * * 1-5',
        is_active: true,
        parameters: {
          lookback_days: 90,
          factor_names: [], // 空 = 跑全部已注册因子
        },
      },
      {
        // 龙虎榜独立 cron — 收盘后 16:45 拉今日上榜
        // 沪深交易所通常 16:00 前披露，留 45min buffer
        name: '龙虎榜同步',
        type: 'DRAGON_TIGER_SYNC',
        cron_expression: '45 16 * * 1-5',
        is_active: true,
        parameters: {},
      },
      {
        // 模拟盘日 snapshot — 每个交易日 16:00 跑
        // 让"昨日盈亏 / 当月收益 / 最大回撤"等指标能正常显示历史曲线
        name: '模拟盘日 snapshot',
        type: 'PAPER_TRADING_DAILY_SNAPSHOT',
        cron_expression: '0 16 * * 1-5',
        is_active: true,
        parameters: {},
      },
      // Batch O (2026-06-17, C-S6 fix): 补 8 个之前完全没 seed 的 task type, ops 不
      // 手动加 ScheduledTask 行就永不跑. 配合 Batch J 的 真卖路径 + cron 接入,
      // 全部 risk guard 终于会自动跑.
      {
        name: '追踪止损 EOD 更新 (US-048)',
        type: 'PAPER_TRADING_TRAILING_STOP_UPDATE',
        cron_expression: '15 15 * * 1-5', // 收盘后 15:15
        is_active: true,
        parameters: { dry_run: false },
      },
      {
        name: '追踪止损次日开盘前检查 + 真卖 (US-048 + Batch J)',
        type: 'PAPER_TRADING_TRAILING_STOP_CHECK',
        cron_expression: '20 9 * * 1-5', // 开盘前 09:20
        is_active: true,
        parameters: { dry_run: false, execute_sells: true },
      },
      {
        name: '回撤熔断检查 + LEVEL_2/3 真卖 (US-049 + Batch J)',
        type: 'PAPER_TRADING_DRAWDOWN_BREAKER_CHECK',
        cron_expression: '20 15 * * 1-5',
        is_active: true,
        parameters: { dry_run: false, execute_sells: true },
      },
      {
        name: '市场环境预警 (US-050)',
        type: 'PAPER_TRADING_MARKET_REGIME_CHECK',
        cron_expression: '5 9 * * 1-5', // 开盘前 09:05
        is_active: true,
        parameters: { dry_run: false },
      },
      {
        name: '每股止损检查 + 真卖 (US-051 + Batch J)',
        type: 'PAPER_TRADING_PER_STOCK_STOP_LOSS_CHECK',
        cron_expression: '25 15 * * 1-5',
        is_active: true,
        parameters: { dry_run: false, execute_sells: true },
      },
      {
        name: '早盘体检 (US-054 + Batch J)',
        type: 'PAPER_TRADING_MORNING_CHECKUP',
        cron_expression: '30 8 * * 1-5',
        is_active: true,
        parameters: { dry_run: false },
      },
      {
        name: '限售解禁前瞻预警 (US-089 + Batch J)',
        type: 'PAPER_TRADING_RESTRICTED_SHARE_CHECK',
        cron_expression: '0 9 * * 1-5',
        is_active: true,
        parameters: { dry_run: false },
      },
      {
        name: '行业集中度评估 (US-052 + Batch J)',
        type: 'PAPER_TRADING_INDUSTRY_CONCENTRATION_CHECK',
        cron_expression: '35 15 * * 1-5',
        is_active: true,
        parameters: { dry_run: false },
      },
      {
        name: '策略熔断监控 (Phase 4+ + Batch N)',
        type: 'STRATEGY_KILL_SWITCH_CHECK',
        cron_expression: '40 16 * * 1-5',
        is_active: true,
        parameters: { dry_run: false }, // Batch N: 默认 dry_run=false 让熔断真触发
      },
      // Batch AB (2026-06-18): 5 个核心行业 / 题材 / 资金面数据 sync, 之前完全没 cron
      // 让 industry_flows / limit_up_stocks / northbound_holdings / snowball_keywords /
      // stock_sentiments 表全部停在旧日期 → 下游因子 / 策略 / TradingAgents prompt 全失明.
      {
        name: '行业资金流当日 sync (Batch AB)',
        type: 'INDUSTRY_FLOW_SYNC',
        cron_expression: '5 15 * * 1-5', // 收盘后 5min
        is_active: true,
        parameters: {},
      },
      {
        name: '涨停股池当日 sync (Batch AB)',
        type: 'LIMIT_UP_SYNC',
        cron_expression: '10 15 * * 1-5',
        is_active: true,
        parameters: {},
      },
      {
        name: '北向持股当日 sync (Batch AB)',
        type: 'NORTHBOUND_SYNC',
        cron_expression: '15 16 * * 1-5', // 港股通收盘后 16:10 数据可用
        is_active: true,
        parameters: {},
      },
      // PR-A (2026-06-29): SNOWBALL / STOCK_SENTIMENT / SOCIAL_SENTIMENT cron
      // 从 '* * 1-5' 改 '* * *' 周末也跑 — 雪球 / 论坛 / 社媒 周末讨论照旧.
      // 保留工作日的: K 线 / 因子 / 回测 / 策略信号 / 实盘对账 (周末本无意义).
      {
        name: '雪球热门话题当日 sync (Batch AB)',
        type: 'SNOWBALL_HOT_KEYWORD_SYNC',
        cron_expression: '0 16 * * *',
        is_active: true,
        parameters: {},
      },
      {
        name: '个股关注度当日 sync (Batch AB)',
        type: 'STOCK_SENTIMENT_SYNC',
        cron_expression: '30 16 * * *',
        is_active: true,
        parameters: { universe: 'market', limit: 200 },
      },
      // Batch AG (2026-06-18): 市场新闻 / 财经事件 — 让 TradingAgents prompt 注入
      // 'recent_news[]' 上下文 + 行业决策面板时间线展示. 高频(30 min/盘中) + 收尾裁剪.
      // PR-A (2026-06-29): 盘中 sync 保留工作日 (盘外没行情驱动); 17:17 收尾整理
      // 早已是 * * * 全周 7 天 (新闻周末仍发).
      {
        name: '市场新闻 sync — 盘中每 30 分钟 (Batch AG)',
        type: 'MARKET_NEWS_SYNC',
        cron_expression: '7,37 9-15 * * 1-5',
        is_active: true,
        parameters: { limit: 80 },
      },
      {
        name: '市场新闻 sync — 收盘整理 + 裁剪 30 天前 (Batch AG)',
        type: 'MARKET_NEWS_SYNC',
        cron_expression: '17 17 * * *',
        is_active: true,
        parameters: { limit: 80, prune_days: 30 },
      },
      // Batch AH (2026-06-18): 社媒/舆情综合数据 + 百度热搜
      {
        name: '社媒/舆情综合 sync (Batch AH)',
        type: 'SOCIAL_SENTIMENT_SYNC',
        cron_expression: '20 16 * * *',
        is_active: true,
        parameters: { universe_limit: 200, rank_lookback_days: 5 },
      },
      {
        name: '百度热搜榜 sync (Batch AH)',
        type: 'MARKET_HOT_SEARCH_SYNC',
        cron_expression: '40 16 * * 1-5',
        is_active: true,
        parameters: { limit: 50 },
      },
      // PR-A (2026-06-29): ANNOUNCEMENT_NLP 全市场公告 NLP — 之前 sync-announcements.ts
      // CLI 存在但没注册成 cron, announcement_summaries 表从 2026-06-09 后 0 更新.
      // 每天 17:00 跑全市场启发式 (--all --with-ai=false), 周末也跑 — 公告系统
      // 周末仍有临时公告 (停牌 / 重大事项 / 风险提示).
      {
        name: '全市场公告 NLP 抽取 (PR-A)',
        type: 'ANNOUNCEMENT_NLP',
        cron_expression: '0 17 * * *',
        is_active: true,
        parameters: { symbol: '全部', with_ai: false },
      },
      // PR-A (2026-06-29): KOL_AGGREGATE 收藏股票 KOL 观点聚合 — 之前从未跑过 cron,
      // kol_opinions 整张空表. 每天 18:30 跑收藏股票 14 天 lookback,
      // 给 NewsAnalyzer + BullishEventDetector 消费. 周末也跑.
      {
        name: 'KOL 观点聚合 - 收藏股票 (PR-A)',
        type: 'KOL_AGGREGATE',
        cron_expression: '30 18 * * *',
        is_active: true,
        parameters: { lookback_days: 14, limit: 10 },
      },
      // PR-B (2026-06-29): BULLISH_EVENT_DETECT 个股利好主动推送. 用户原话
      // "周末利好华工科技的新闻你看到了吗, 这类新闻你需要发消息提示我".
      // 每 30min 跑 4 detector (critical 公告 / 正面新闻 / 关注度突增 / KOL 集中看多),
      // 命中写 RiskAlert + 推 OPS 飞书群. 24h dedup. 周末 / 盘前盘后都跑.
      {
        name: '个股利好主动推送 (PR-B)',
        type: 'BULLISH_EVENT_DETECT',
        cron_expression: '*/30 * * * *',
        is_active: true,
        parameters: { dry_run: false },
      },
      // PR-M2 (2026-06-29) — 集合竞价 snapshot + 30-min K 线 + 日内动量 detector.
      // 学术: Han/Hu/Jia 2023 SSRN + Zhang/Ma/Zhu 2019 EM ("mainly evident in China").
      {
        name: 'PR-M2 集合竞价快照 (9:25)',
        type: 'AUCTION_SNAPSHOT_SYNC',
        cron_expression: '25 9 * * 1-5',
        is_active: true,
        parameters: { dry_run: false },
      },
      {
        name: 'PR-M2 盘中 30-min K 线 sync (每 30min)',
        type: 'INTRADAY_KLINE_30MIN_SYNC',
        cron_expression: '5 10,11,13,14 * * 1-5',
        is_active: true,
        parameters: { dry_run: false },
      },
      {
        name: 'PR-M2 日内动量 detector (14:25)',
        type: 'INTRADAY_MOMENTUM_DETECT',
        cron_expression: '25 14 * * 1-5',
        is_active: true,
        parameters: { dry_run: false },
      },
      // PR-M3 (2026-06-29): INDUSTRY_SENTIMENT_AGGREGATE 板块情绪指数日度聚合.
      // 学术依据 PR-I 报告第 3 个致命短板 — 龙头战法 4 核心因子 (涨停数 / 连板高度 / 封板率 / 炸板率)
      // + 30 日板块动量 z-score. 工作日 16:00 跑 (limit_up sync 在 15:35-15:40 之后).
      {
        name: '板块情绪指数日度聚合 (PR-M3)',
        type: 'INDUSTRY_SENTIMENT_AGGREGATE',
        cron_expression: '0 16 * * 1-5',
        is_active: true,
        parameters: { dry_run: false },
      },
      // PR-M3 (2026-06-29): INTRADAY_REVERSAL_DETECT 反转 detector.
      // 学术依据 PR-I 报告第 4 个致命短板 — A 股因 T+1 + 散户主导 → 短期反转主导, 而非动量.
      // 每日 15:10 跑 (收盘前 10min, 让 RT quote 已稳定但还未 sync 到 daily_bars).
      {
        name: '反转 detector (PR-M3)',
        type: 'INTRADAY_REVERSAL_DETECT',
        cron_expression: '10 15 * * 1-5',
        is_active: true,
        parameters: { dry_run: false },
      },
      // PR-O2 (2026-06-29) — 涨停板战法 detector. PR-I-v2 战法库 §1 流派 1 落地率 0% → 50%.
      // 每日 15:30 跑 (盘后 5min 余量, 在 LIMIT_UP_SYNC 15:10 之后), 对 limit_up_stocks 全表
      // 跑 20+ classifier, 命中写 RiskAlert + AIInvestmentSignal (source_type='limit_up_board',
      // metadata.timing_tag='overnight'). 让前端 /home 推荐卡能看到 "🚀 一字板" / "📈 二板加速" badge.
      {
        name: 'PR-O2 涨停板战法 detector (15:30)',
        type: 'LIMIT_UP_BOARD_DETECT',
        cron_expression: '30 15 * * 1-5',
        is_active: true,
        parameters: { dry_run: false },
      },
      // PR-O5 (2026-06-30): THEME_FERMENTATION_DETECT 题材发酵 5 阶段 detector.
      // 消费 PR-M3 industry_sentiment_indices (16:00 写完) + 昨日 phase, 给每个板块打
      // germinate/launch/outbreak/climax/recession 标签 + 检测主线切换. 工作日 16:30 跑.
      {
        name: '题材发酵 5 阶段 detector (PR-O5)',
        type: 'THEME_FERMENTATION_DETECT',
        cron_expression: '30 16 * * 1-5',
        is_active: true,
        parameters: { dry_run: false },
      },
      // PR-O3 (2026-06-29) — Opening rush detector. PR-P (2026-06-30) 补 cron seed:
      // 之前 PR-O3 加了 service 但没 seed, fresh DB 启动后不会跑.
      // 工作日 9:26 跑 (AUCTION_SNAPSHOT_SYNC 9:25 写完留 1min 余量).
      {
        name: 'Opening rush detector (PR-O3)',
        type: 'OPENING_RUSH_DETECT',
        cron_expression: '26 9 * * 1-5',
        is_active: true,
        parameters: { dry_run: false },
      },
      // PR-O3 (2026-06-29) — 盘中价量异动 6 类 detector. PR-P (2026-06-30) 补 cron seed.
      // 盘中每 30min 跑 (10:00, 10:30, 11:00, 11:30, 13:00, 13:30, 14:00, 14:30).
      {
        name: '盘中价量异动 detector (PR-O3)',
        type: 'INTRADAY_PRICE_VOLUME_ANOMALY',
        cron_expression: '*/30 10,11,13,14 * * 1-5',
        is_active: true,
        parameters: { dry_run: false },
      },
      // PR-O3 (2026-06-29) — Last-hour 尾盘动量 detector. PR-P (2026-06-30) 补 cron seed.
      // 学术: Zhang/Ma/Zhu 2019 EM 中国市场 r1 → r2 alpha 最 robust.
      {
        name: '尾盘动量 detector (PR-O3)',
        type: 'LAST_HOUR_MOMENTUM',
        cron_expression: '30 14 * * 1-5',
        is_active: true,
        parameters: { dry_run: false },
      },
      // ===========================================================================
      // Macro 串联补丁 (2026-06-21) — Batch AJ: 把 14 个已注册并已实现但 ensureDefaultTasks
      // 漏 seed 的 cron 全部补上, 让 fresh DB 启动 (新 staging / DR 重建) 后这些 cron
      // 自动起跑, 不再依赖 ops 人工 INSERT. cron_expression 全部对齐 cronRegistry.ts
      // 的 recommendedCron, 让 docs / 代码 / DB 三者口径一致.
      // 同时 seed 3 个本批新增 cron (WEEKLY_IMPROVEMENT_SUGGESTION_GENERATE,
      // DAILY_IMPROVEMENT_EFFECT_TRACK, ETF_FLOW_SYNC).
      // 参考 docs/audit/ralph_macro_integration_check_2026_06_21.md §🚨 #3.
      // ===========================================================================
      {
        // 数据质量深度扫描 — 每日 23:00 扫"空表 / 旧数据 / 数据漂移". cronRegistry data_sync.
        name: '数据质量深度扫描 (Batch AJ)',
        type: 'DATA_QUALITY_SCAN',
        cron_expression: '0 23 * * *',
        is_active: true,
        parameters: {},
      },
      {
        // 股票基础信息全量同步 — 每周一 03:00 (低峰 + 早于交易时段). cronRegistry data_sync.
        name: '股票基础信息全量同步 (Batch AJ)',
        type: 'SYNC_ALL_STOCKS',
        cron_expression: '0 3 * * 1',
        is_active: true,
        parameters: {},
      },
      {
        // 组合净值守卫日评 — 每日盘后 17:00 (DAILY_UPDATE 之后, 让最新净值入库再评).
        // cronRegistry risk_control; EquityCurveGovernor 触发 kill switch / 降仓建议.
        name: '组合净值守卫日评 (Batch AJ)',
        type: 'EQUITY_CURVE_GOVERNOR_DAILY_EVAL',
        cron_expression: '0 17 * * 1-5',
        is_active: true,
        parameters: { dry_run: false },
      },
      {
        // 实盘对账守卫 (intraday) — 盘中 10:31/14:31/15:31 三次 + 收盘后 16:01 一次.
        // BETA-2 (audit S-12) 的实现; intraday 标签下跑 3 次盘中风险窗口.
        name: '实盘对账守卫 (intraday) (Batch AJ)',
        type: 'LIVE_RECONCILIATION_GUARD',
        cron_expression: '31 10,14,15 * * 1-5',
        is_active: true,
        parameters: { window: 'intraday', dry_run: false },
      },
      {
        // 实盘对账守卫 (eod) — 收盘后 16:01 跑 EOD 对账, 与 intraday 错峰 + 不同 window 标签.
        name: '实盘对账守卫 (eod) (Batch AJ)',
        type: 'LIVE_RECONCILIATION_GUARD',
        cron_expression: '1 16 * * 1-5',
        is_active: true,
        parameters: { window: 'eod', dry_run: false },
      },
      {
        // 研究产物完整性批审计 — 每日 22:00 扫"研报已写但数据缺失"等漏洞. cronRegistry analytics.
        name: '研究产物完整性批审计 (Batch AJ)',
        type: 'RESEARCH_INTEGRITY_BATCH_AUDIT',
        cron_expression: '0 22 * * *',
        is_active: true,
        parameters: {},
      },
      {
        // Webhook fallback retry — 每 5 分钟扫 webhook_fallback_log pending 行重投递.
        // 飞书 fail-OPEN 后的第二道防线, 必须高频跑.
        name: 'Webhook fallback retry (Batch AJ)',
        type: 'WEBHOOK_FALLBACK_RETRY',
        cron_expression: '*/5 * * * *',
        is_active: true,
        parameters: {},
      },
      {
        // 全库 pg_dump 备份 — 每日 02:00 跑 backups/YYYY-MM-DD.sql.gz, 保留 30 天.
        name: '全库 pg_dump 备份 (Batch AJ)',
        type: 'DB_BACKUP',
        cron_expression: '0 2 * * *',
        is_active: true,
        parameters: { dry_run: false },
      },
      {
        // 周度问答统计聚合 — 周一 02:00 把上周个股投资者问答聚合 (≤ 04:00 截止). cronRegistry analytics.
        name: '周度问答统计聚合 (Batch AJ)',
        type: 'WEEKLY_QA_STAT_AGGREGATE',
        cron_expression: '0 2 * * 1',
        is_active: true,
        parameters: {},
      },
      // ===== 黑天鹅 6 stage 错峰 cron — cronRegistry 已设错峰, 这里 seed 同款 schedule =====
      {
        name: '黑天鹅检测 (Batch AJ)',
        type: 'BLACK_SWAN_DETECT',
        cron_expression: '3,33 * * * *',
        is_active: true,
        parameters: { dry_run: false },
      },
      {
        name: '黑天鹅复盘 - event_summary (Batch AJ)',
        type: 'BLACK_SWAN_POSTMORTEM',
        cron_expression: '13,43 * * * *',
        is_active: true,
        parameters: { dry_run: false },
      },
      {
        name: '黑天鹅复盘 - counterfactual_baseline (Batch AJ)',
        type: 'BLACK_SWAN_BASELINE',
        cron_expression: '23,53 * * * *',
        is_active: true,
        parameters: { dry_run: false },
      },
      {
        name: '黑天鹅复盘 - event_timeline (Batch AJ)',
        type: 'BLACK_SWAN_TIMELINE',
        cron_expression: '33,3 * * * *',
        is_active: true,
        parameters: { dry_run: false },
      },
      {
        name: '黑天鹅复盘 - improvement_suggestions (Batch AJ)',
        type: 'BLACK_SWAN_IMPROVEMENT',
        cron_expression: '43,13 * * * *',
        is_active: true,
        parameters: { dry_run: false },
      },
      {
        name: '黑天鹅季度汇总邮件 (Batch AJ)',
        type: 'BLACK_SWAN_QUARTERLY_SUMMARY',
        cron_expression: '5 9 1 1,4,7,10 *',
        is_active: true,
        parameters: { dry_run: false },
      },
      // ===== 3 个本批新增 cron =====
      {
        // Macro 串联补丁 (2026-06-21) — US-094 PM-023 改进建议生成 cron.
        // 周二 09:00 错峰在 WEEKLY_ERROR_PATTERN_AGGREGATE (周日 10:00) 之后,
        // 让上周 error pattern 已落库再聚合成 actionable suggestion. 每周一次足够.
        name: '改进建议生成 (周度)',
        type: 'WEEKLY_IMPROVEMENT_SUGGESTION_GENERATE',
        cron_expression: '0 9 * * 2',
        is_active: true,
        parameters: {},
      },
      {
        // Macro 串联补丁 (2026-06-21) — US-146 PM-027 改进建议效果回采 cron.
        // 每日 19:30 错峰在 FACTOR_IC_COMPUTE (19:00) + DAILY_ATTRIBUTION_GENERATE
        // (17:00) 之后, 让当日所有 portfolio 的 attribution 已落库再算 effect_metrics.
        name: '改进建议效果回采 (日度)',
        type: 'DAILY_IMPROVEMENT_EFFECT_TRACK',
        cron_expression: '30 19 * * *',
        is_active: true,
        parameters: { dry_run: false },
      },
      {
        // Macro 串联补丁 (2026-06-21) — US-092 行业 ETF 资金流 daily sync cron.
        // 工作日 18:00 (AKShare T+1 数据可用) 跑前一交易日 30+ 行业 ETF 净流入 / 份额.
        name: '行业 ETF 资金流 daily sync',
        type: 'ETF_FLOW_SYNC',
        cron_expression: '0 18 * * 1-5',
        is_active: true,
        parameters: {},
      },
      {
        // PR-M1 (2026-06-29) — 隔夜信号矩阵 (A50/HK/Nasdaq/DXY/VIX) cron seed.
        // 北京时间 21-23 (隔夜美股开盘) + 0-9 (隔夜+早盘前) 每 15min 跑一次.
        name: '隔夜信号矩阵 sync (A50/HK/Nasdaq/DXY/VIX)',
        type: 'OVERNIGHT_SIGNAL_SYNC',
        cron_expression: '*/15 0-9,21-23 * * *',
        is_active: true,
        parameters: {},
      },
      {
        // Batch AL (2026-06-21) — SystemWorkspace 用户反馈闭环 cron seed.
        // 每 30 分钟扫 status='pending' 且 (reviewed_at IS NULL OR > 6h) 的反馈,
        // 跑启发式分类器 + 优先级 + 摘要. 不自动 resolve — 留 admin 手工触发.
        name: '用户反馈分类巡检 (30min)',
        type: 'FEEDBACK_REVIEW_SWEEP',
        cron_expression: '*/30 * * * *',
        is_active: true,
        parameters: { age_hours: 6, limit: 200 },
      },
    ];

    for (const taskData of defaultTasks) {
      const [task, created] = await ScheduledTask.findOrCreate({
        where: { name: taskData.name },
        defaults: taskData,
      });

      const patch: any = {};
      if (!task.cron_expression) patch.cron_expression = taskData.cron_expression;
      if (!task.type) patch.type = taskData.type;
      if (!task.parameters && taskData.parameters) patch.parameters = taskData.parameters;
      if (task.is_active === null || task.is_active === undefined)
        patch.is_active = taskData.is_active;

      const autonomousParamsPatch = this.patchAutonomousPortfolioParameters(task, taskData);
      if (autonomousParamsPatch) {
        patch.parameters = autonomousParamsPatch;
      }

      if (taskData.name === '全量股票日线同步') {
        const params = patch.parameters || task.parameters || {};
        const nextParams = { ...taskData.parameters, ...params };
        const hasExplicitScope =
          Array.isArray(params.symbols) ||
          Array.isArray(params.marketFilters) ||
          Array.isArray(params.market_filters) ||
          params.syncAllStocks !== undefined ||
          params.sync_all_stocks !== undefined;
        if (!hasExplicitScope) {
          nextParams.syncAllStocks = true;
        }
        for (const key of [
          'batch_limit',
          'lag_days_threshold',
          'stale_first',
          'include_no_data',
          'dataSource',
          'concurrency',
        ]) {
          if (nextParams[key] === undefined && (taskData.parameters as any)[key] !== undefined) {
            nextParams[key] = (taskData.parameters as any)[key];
          }
        }
        if (JSON.stringify(nextParams) !== JSON.stringify(params)) {
          patch.parameters = nextParams;
        }
      }

      if (taskData.name === 'Agent尾盘建议收益追踪') {
        const params = patch.parameters || task.parameters || {};
        const nextParams = { ...taskData.parameters, ...params };
        for (const key of [
          'auto_repair_missing_data',
          'data_source',
          'lookback_days',
          'sync_concurrency',
          'agent_session',
          'source_type',
          'horizon',
          'record_type',
        ]) {
          if (nextParams[key] === undefined && (taskData.parameters as any)[key] !== undefined) {
            nextParams[key] = (taskData.parameters as any)[key];
          }
        }
        if (JSON.stringify(nextParams) !== JSON.stringify(params)) {
          patch.parameters = nextParams;
        }
      }

      if (taskData.name === '信号质量日报') {
        const params = patch.parameters || task.parameters || {};
        const nextParams = { ...taskData.parameters, ...params };
        for (const key of [
          'horizon',
          'lookback_days',
          'min_samples',
          'limit',
          'auto_repair_missing_data',
          'data_source',
          'repair_lookback_days',
          'sync_concurrency',
          'verify_before_report',
          'report_to_feishu',
          'notify_to_feishu_bot',
          'record_type',
        ]) {
          if (nextParams[key] === undefined && (taskData.parameters as any)[key] !== undefined) {
            nextParams[key] = (taskData.parameters as any)[key];
          }
        }
        if (JSON.stringify(nextParams) !== JSON.stringify(params)) {
          patch.parameters = nextParams;
        }
      }

      if (taskData.type === 'QUANT_PARAM_MAINTENANCE') {
        const params = patch.parameters || task.parameters || {};
        const nextParams = { ...taskData.parameters, ...params };
        for (const key of [
          'lookback_days',
          'horizons',
          'signal',
          'limit',
          'refresh_limit',
          'lifecycle_limit',
          'auto_sync_benchmark',
          'dry_run_lifecycle',
          'report_to_feishu',
          'notify_to_feishu_bot',
          'record_type',
        ]) {
          if (nextParams[key] === undefined && (taskData.parameters as any)[key] !== undefined) {
            nextParams[key] = (taskData.parameters as any)[key];
          }
        }
        if (JSON.stringify(nextParams) !== JSON.stringify(params)) {
          patch.parameters = nextParams;
        }
      }

      if (taskData.type === 'REALTIME_QUOTE_SYNC') {
        const params = patch.parameters || task.parameters || {};
        const nextParams = { ...taskData.parameters, ...params };
        for (const key of [
          'universe',
          'limit',
          'source',
          'batch_size',
          'report_to_feishu',
          'notify_to_feishu_bot',
          'record_type',
        ]) {
          if (nextParams[key] === undefined && (taskData.parameters as any)[key] !== undefined) {
            nextParams[key] = (taskData.parameters as any)[key];
          }
        }
        if (JSON.stringify(nextParams) !== JSON.stringify(params)) {
          patch.parameters = nextParams;
        }
      }

      if (taskData.type === 'LIVE_SHADOW_AUTOPILOT') {
        const params = patch.parameters || task.parameters || {};
        const nextParams = { ...taskData.parameters, ...params };
        for (const key of [
          'username',
          'limit',
          'outcome_limit',
          'horizons',
          'source',
          'require_opening_readiness',
          'allow_degraded_readiness',
          'factor_limit',
          'cache_ttl_ms',
          'dry_run',
          'report_to_feishu',
          'notify_to_feishu_bot',
          'record_type',
        ]) {
          if (nextParams[key] === undefined && (taskData.parameters as any)[key] !== undefined) {
            nextParams[key] = (taskData.parameters as any)[key];
          }
        }
        if (JSON.stringify(nextParams) !== JSON.stringify(params)) {
          patch.parameters = nextParams;
        }
      }

      if (taskData.type === 'LIVE_SHADOW_WEEKLY_REVIEW') {
        const params = patch.parameters || task.parameters || {};
        const nextParams = { ...taskData.parameters, ...params };
        for (const key of [
          'username',
          'outcome_limit',
          'horizons',
          'report_to_feishu',
          'notify_to_feishu_bot',
          'record_type',
        ]) {
          if (nextParams[key] === undefined && (taskData.parameters as any)[key] !== undefined) {
            nextParams[key] = (taskData.parameters as any)[key];
          }
        }
        if (JSON.stringify(nextParams) !== JSON.stringify(params)) {
          patch.parameters = nextParams;
        }
      }

      if (taskData.type === 'QUANT_DAILY_PIPELINE') {
        const params = patch.parameters || task.parameters || {};
        const nextParams = { ...taskData.parameters, ...params };
        for (const key of [
          'username',
          'use_autonomous_portfolio',
          'portfolio_name',
          'initial_capital',
          'universe',
          'strategy_keys',
          'lookback_days',
          'candidate_limit',
          'refresh_realtime_quotes',
          'sync_factors_before_scan',
          'factor_sync_scope',
          'factor_sync_limit',
          'factor_provider',
          'factor_sync_skip_if_coverage_rate_gte',
          'factor_sync_skip_if_real_provider_rate_gte',
          'quote_sync_limit',
          'realtime_quote_source',
          'min_score',
          'archive_limit',
          'max_industry_candidates',
          'max_strategy_candidates',
          'submit_agent_analysis',
          'agent_max_count',
          'agent_min_score',
          'agent_paper_trade_min_score',
          'agent_session',
          'agent_auto_paper_trade',
          'run_paper_trading',
          'dry_run',
          'paper_trade_limit',
          'paper_trade_scan_limit',
          'max_positions',
          'default_position_pct',
          'max_position_pct',
          'min_trade_amount',
          'strategy_weight_lookback_days',
          'use_entry_risk_guard',
          'max_daily_new_positions',
          'max_daily_new_exposure_pct',
          'max_total_exposure_pct',
          'max_industry_exposure_pct',
          'min_cash_reserve_pct',
          'max_portfolio_drawdown_pct',
          'max_single_stock_volatility_pct',
          'max_position_correlation',
          'max_portfolio_var_pct',
          'min_avg_turnover_yuan',
          'cooldown_days_after_loss',
          'use_experiment_params',
          'experiment_param_policy',
          'block_limit_up',
          'block_limit_down',
          'block_suspended',
          'block_buy_on_runtime_risk',
          'risk_threshold_stability_min_consecutive_same_action',
          'risk_threshold_stability_min_actionable_samples',
          'risk_threshold_stability_min_protected_runs',
          'risk_threshold_stability_tighten_min_delta_pct',
          'risk_threshold_stability_relax_max_delta_pct',
          'risk_threshold_field_stability_min_consecutive_same_action',
          'risk_threshold_field_min_confidence',
          'risk_threshold_field_min_sample_count',
          'risk_threshold_field_min_triggered_count',
          'report_to_feishu',
          'notify_to_feishu_bot',
          'record_type',
        ]) {
          if (nextParams[key] === undefined && (taskData.parameters as any)[key] !== undefined) {
            nextParams[key] = (taskData.parameters as any)[key];
          }
        }
        if (
          Number(nextParams.quote_sync_limit || 0) <
          Number((taskData.parameters as any).quote_sync_limit || 0)
        ) {
          nextParams.quote_sync_limit = (taskData.parameters as any).quote_sync_limit;
        }
        if (
          Number(nextParams.factor_sync_limit || 0) <
          Number((taskData.parameters as any).factor_sync_limit || 0)
        ) {
          nextParams.factor_sync_limit = (taskData.parameters as any).factor_sync_limit;
        }
        if (JSON.stringify(nextParams) !== JSON.stringify(params)) {
          patch.parameters = nextParams;
        }
      }

      if (taskData.type === 'QUANT_OPEN_WATCHDOG') {
        const params = patch.parameters || task.parameters || {};
        const nextParams = { ...taskData.parameters, ...params };
        for (const key of [
          'target_task_name',
          'expected_after_time',
          'latest_allowed_minutes',
          'min_quant_signals',
          'min_archived_signals',
          'require_fresh_quote',
          'freshness_max_minutes',
          'report_to_feishu',
          'notify_to_feishu_bot',
          'record_type',
        ]) {
          if (nextParams[key] === undefined && (taskData.parameters as any)[key] !== undefined) {
            nextParams[key] = (taskData.parameters as any)[key];
          }
        }
        if (JSON.stringify(nextParams) !== JSON.stringify(params)) {
          patch.parameters = nextParams;
        }
      }

      if (taskData.name === '全市场荐股闭环') {
        const params = patch.parameters || task.parameters || {};
        const nextParams = { ...taskData.parameters, ...params };
        for (const key of [
          'username',
          'use_autonomous_portfolio',
          'portfolio_name',
          'initial_capital',
          'universe',
          'style',
          'candidate_limit',
          'candidate_pool_limit',
          'lookback_days',
          'min_bars',
          'exclude_st',
          'min_market_cap_yi',
          'archive_limit',
          'verify_signals',
          'run_paper_trading',
          'dry_run',
          'paper_trade_limit',
          'paper_trade_scan_limit',
          'min_score',
          'max_positions',
          'default_position_pct',
          'max_position_pct',
          'min_trade_amount',
          'use_outcome_feedback',
          'use_policy_version_feedback',
          'policy_version_lookback_limit',
          'use_strategy_experiment_feedback',
          'strategy_experiment_min_quality_delta',
          'strategy_experiment_limit',
          'strategy_experiment_pool_limit',
          'outcome_feedback_lookback_days',
          'outcome_feedback_min_closed_samples',
          'use_profit_gate',
          'profit_gate_horizon',
          'profit_gate_min_samples',
          'profit_gate_min_quality_score',
          'use_entry_risk_guard',
          'max_daily_new_positions',
          'max_daily_new_exposure_pct',
          'max_total_exposure_pct',
          'max_industry_exposure_pct',
          'min_cash_reserve_pct',
          'max_portfolio_drawdown_pct',
          'max_single_stock_volatility_pct',
          'max_position_correlation',
          'max_portfolio_var_pct',
          'risk_threshold_stability_min_consecutive_same_action',
          'risk_threshold_stability_min_actionable_samples',
          'risk_threshold_stability_min_protected_runs',
          'risk_threshold_stability_tighten_min_delta_pct',
          'risk_threshold_stability_relax_max_delta_pct',
          'risk_threshold_field_stability_min_consecutive_same_action',
          'risk_threshold_field_min_confidence',
          'risk_threshold_field_min_sample_count',
          'risk_threshold_field_min_triggered_count',
          'min_avg_turnover_yuan',
          'cooldown_days_after_loss',
          'block_limit_up',
          'block_limit_down',
          'block_suspended',
          'agent_auto_paper_trade',
          'agent_only_paper_trade_min_score',
          'submit_agent_analysis',
          'agent_max_count',
          'agent_min_score',
          'agent_session',
          'report_to_feishu',
          'record_type',
        ]) {
          if (nextParams[key] === undefined && (taskData.parameters as any)[key] !== undefined) {
            nextParams[key] = (taskData.parameters as any)[key];
          }
        }
        if (JSON.stringify(nextParams) !== JSON.stringify(params)) {
          patch.parameters = nextParams;
        }
      }

      if (
        taskData.name === '推荐信号模拟盘跟单' ||
        taskData.name === 'Agent尾盘建议模拟盘跟单' ||
        taskData.name === '模拟盘交易计划报告'
      ) {
        const params = patch.parameters || task.parameters || {};
        const nextParams = { ...taskData.parameters, ...params };
        for (const key of [
          'use_autonomous_portfolio',
          'portfolio_name',
          'initial_capital',
          'use_profit_gate',
          'profit_gate_horizon',
          'profit_gate_min_samples',
          'profit_gate_min_quality_score',
          'profit_gate_allow_deprioritized',
          'profit_gate_allow_sampling',
          'profit_gate_sampling_multiplier',
          'use_outcome_feedback',
          'outcome_feedback_min_closed_samples',
          'outcome_feedback_lookback_days',
          'outcome_feedback_limit',
        ]) {
          if (nextParams[key] === undefined && (taskData.parameters as any)[key] !== undefined) {
            nextParams[key] = (taskData.parameters as any)[key];
          }
        }
        if (JSON.stringify(nextParams) !== JSON.stringify(params)) {
          patch.parameters = nextParams;
        }
      }

      if (taskData.name === '推荐交易收益闭环刷新') {
        const params = patch.parameters || task.parameters || {};
        const nextParams = { ...taskData.parameters, ...params };
        for (const key of [
          'use_autonomous_portfolio',
          'portfolio_name',
          'initial_capital',
          'include_open',
          'lookback_days',
          'limit',
          'report_to_feishu',
        ]) {
          if (nextParams[key] === undefined && (taskData.parameters as any)[key] !== undefined) {
            nextParams[key] = (taskData.parameters as any)[key];
          }
        }
        if (JSON.stringify(nextParams) !== JSON.stringify(params)) {
          patch.parameters = nextParams;
        }
      }

      if (taskData.name === '模拟盘风控退出检查' || taskData.name === '模拟盘收益归因报告') {
        const params = patch.parameters || task.parameters || {};
        const nextParams = { ...taskData.parameters, ...params };
        for (const key of [
          'use_autonomous_portfolio',
          'portfolio_name',
          'initial_capital',
          'limit',
          'include_open',
          'enable_stop_loss',
          'enable_take_profit',
          'enable_trailing_take_profit',
          'enable_sell_signals',
          'use_adaptive_risk_policy',
          'adaptive_risk_lookback_days',
          'adaptive_risk_min_closed_samples',
          'adaptive_risk_override_signal_params',
          'default_stop_loss_pct',
          'default_take_profit_pct',
          'trailing_activation_pct',
          'trailing_drawdown_pct',
          'max_hold_days',
          'min_sell_signal_score',
          'sell_signal_source_type',
          'dry_run',
          'report_to_feishu',
        ]) {
          if (nextParams[key] === undefined && (taskData.parameters as any)[key] !== undefined) {
            nextParams[key] = (taskData.parameters as any)[key];
          }
        }
        if (JSON.stringify(nextParams) !== JSON.stringify(params)) {
          patch.parameters = nextParams;
        }
      }

      if (Object.keys(patch).length > 0) {
        await task.update(patch);
      }

      if (created) {
        logger.info(`Default scheduled task created: ${taskData.name}`);
      }
    }
  }

  async createTask(data: any, auditContext: any = {}) {
    const task = await ScheduledTask.create(data);
    await taskParameterAuditService.record({
      task,
      event_type: 'task_created',
      before_parameters: {},
      after_parameters: task.parameters || {},
      changed_keys: Object.keys(task.parameters || {}),
      operator: auditContext.operator,
      metadata: {
        source: auditContext.source || 'scheduler_service',
      },
    });
    if (task.is_active) {
      this.scheduleTask(task);
    }
    return task;
  }

  async updateTask(id: number, data: any, auditContext: any = {}) {
    const task = await ScheduledTask.findByPk(id);
    if (!task) throw new Error('Task not found');

    const beforeParameters = { ...(task.parameters || {}) };
    await task.update(data);
    const afterParameters = { ...(task.parameters || {}) };
    const changedKeys = taskParameterAuditService.buildChangedKeys(
      beforeParameters,
      afterParameters,
      auditContext.changed_keys
    );
    if (changedKeys.length > 0) {
      await taskParameterAuditService.record({
        task,
        event_type:
          auditContext.event_type ||
          taskParameterAuditService.inferEventType(changedKeys, 'task_updated'),
        before_parameters: beforeParameters,
        after_parameters: afterParameters,
        changed_keys: changedKeys,
        source_loop_run_id: auditContext.source_loop_run_id,
        operator: auditContext.operator,
        metadata: {
          source: auditContext.source || 'scheduler_service',
          updated_fields: Object.keys(data || {}),
          ...(auditContext.metadata || {}),
        },
      });
    }
    await this.reloadTask(id);
    return task;
  }

  async deleteTask(id: number) {
    const task = await ScheduledTask.findByPk(id);
    if (task) {
      if (this.activeTasks.has(id)) {
        this.activeTasks.get(id)?.stop();
        this.activeTasks.delete(id);
      }
      await task.destroy();
    }
  }
}

/**
 * Batch AH review (2026-06-18) — Given a cron expression, return today's most
 * recent fire time (in Asia/Shanghai), or null if no firings today before now.
 *
 * 用于 catch-up: 检测某 task 今天本该 fire 但 missed 了.
 *
 * 简化逻辑: 解析标准 5-field cron 表达式 (minute hour DoM Month DoW), 找到
 * "今日已过的最近一次 fire 时刻". 不支持复杂 cron 语法 (如步长 / 范围混用),
 * 但能 cover 我们 8 个 sync task 都使用的 'MM HH * * 1-5' / 'MM,MM HH-HH * * 1-5' 模式.
 */
function nextTodayFireTimeForCron(cronExpr: string): Date | null {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minutePart, hourPart, , , dowPart] = parts;

  const nowSh = moment().tz('Asia/Shanghai');
  // 周末过滤 (DoW 1-5 = Mon-Fri)
  if (dowPart === '1-5') {
    const dow = nowSh.day(); // 0=Sun, 6=Sat
    if (dow === 0 || dow === 6) return null;
  }

  const minutes = expandCronField(minutePart, 0, 59);
  const hours = expandCronField(hourPart, 0, 23);
  if (!minutes.length || !hours.length) return null;

  // 找今天最近一次 fire 时刻 (≤ now)
  let lastFire: moment.Moment | null = null;
  for (const h of hours) {
    for (const m of minutes) {
      const candidate = nowSh.clone().hour(h).minute(m).second(0).millisecond(0);
      if (candidate.isSameOrBefore(nowSh)) {
        if (!lastFire || candidate.isAfter(lastFire)) lastFire = candidate;
      }
    }
  }
  return lastFire ? lastFire.toDate() : null;
}

function expandCronField(part: string, min: number, max: number): number[] {
  if (part === '*') {
    return Array.from({ length: max - min + 1 }, (_, i) => min + i);
  }
  const out: number[] = [];
  for (const seg of part.split(',')) {
    const trimmed = seg.trim();
    if (!trimmed) continue;
    if (trimmed.includes('-')) {
      const [a, b] = trimmed.split('-').map(Number);
      if (Number.isFinite(a) && Number.isFinite(b)) {
        for (let i = Math.max(min, a); i <= Math.min(max, b); i++) out.push(i);
      }
    } else if (trimmed.startsWith('*/')) {
      const step = Number(trimmed.slice(2));
      if (Number.isFinite(step) && step > 0) {
        for (let i = min; i <= max; i += step) out.push(i);
      }
    } else {
      const n = Number(trimmed);
      if (Number.isFinite(n) && n >= min && n <= max) out.push(n);
    }
  }
  return out;
}

export const schedulerService = new SchedulerService();
