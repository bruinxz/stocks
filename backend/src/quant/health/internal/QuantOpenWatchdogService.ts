import moment from 'moment-timezone';
import { Op } from 'sequelize';
import { ScheduledTask } from '../../../models/ScheduledTask';
import { TaskExecutionLog } from '../../../models/TaskExecutionLog';
import { AIInvestmentSignal, AISignalSourceType } from '../../../models/AIInvestmentSignal';
import { PaperTradingTrade } from '../../../models/PaperTradingTrade';
import { realtimeQuoteService } from '../../../data/services/RealtimeQuoteService';

// Stub for deleted QuantSignal model
const QuantSignal = { count: async (_?: any): Promise<number> => 0 };

type WatchdogStatus = 'healthy' | 'warning' | 'critical';

type WatchdogIssue = {
  level: 'warning' | 'critical';
  code: string;
  message: string;
};

function chinaNow() {
  return moment().tz('Asia/Shanghai');
}

function toPositiveInt(value: any, fallback: number, max?: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  const normalized = Math.floor(parsed);
  return max ? Math.min(normalized, max) : normalized;
}

function worstStatus(issues: WatchdogIssue[]): WatchdogStatus {
  if (issues.some(issue => issue.level === 'critical')) return 'critical';
  if (issues.some(issue => issue.level === 'warning')) return 'warning';
  return 'healthy';
}

export interface QuantOpenWatchdogOptions {
  trade_date?: string;
  target_task_name?: string;
  expected_after_time?: string;
  latest_allowed_minutes?: number;
  min_quant_signals?: number;
  min_archived_signals?: number;
  require_fresh_quote?: boolean;
  freshness_max_minutes?: number;
  // 周末/节假日手动查看时，不应把“未到运行时间/非交易时段”误判为关键故障。
  off_hours_warning_only?: boolean;
}

class QuantOpenWatchdogService {
  async check(options: QuantOpenWatchdogOptions = {}) {
    const now = chinaNow();
    const tradeDate = options.trade_date || now.format('YYYY-MM-DD');
    const targetTaskName = options.target_task_name || '量化策略开盘机会扫描';
    const expectedAfterTime = options.expected_after_time || '09:35';
    const latestAllowedMinutes = toPositiveInt(options.latest_allowed_minutes, 25, 180);
    const minQuantSignals = toPositiveInt(options.min_quant_signals, 1, 1000);
    const minArchivedSignals = toPositiveInt(options.min_archived_signals, 1, 1000);
    const requireFreshQuote = options.require_fresh_quote !== false;
    const freshnessMaxMinutes = toPositiveInt(options.freshness_max_minutes, 60, 24 * 60);
    const offHoursWarningOnly = options.off_hours_warning_only !== false;
    const issues: WatchdogIssue[] = [];

    const expectedAt = moment.tz(
      `${tradeDate} ${expectedAfterTime}`,
      'YYYY-MM-DD HH:mm',
      'Asia/Shanghai'
    );
    const weekday = expectedAt.isoWeekday();
    const isWeekend = weekday >= 6;
    const hasMarketOpenedForDate = !isWeekend && now.isAfter(expectedAt);
    const latestAllowedAt = expectedAt.clone().add(latestAllowedMinutes, 'minutes');
    const dayStart = moment.tz(`${tradeDate} 00:00`, 'YYYY-MM-DD HH:mm', 'Asia/Shanghai').toDate();
    const dayEnd = moment
      .tz(`${tradeDate} 23:59:59`, 'YYYY-MM-DD HH:mm:ss', 'Asia/Shanghai')
      .toDate();

    const task = await ScheduledTask.findOne({ where: { name: targetTaskName } });
    if (!task) {
      issues.push({
        level: 'critical',
        code: 'missing_task',
        message: `缺少开盘量化任务：${targetTaskName}`,
      });
    } else if (!task.is_active) {
      issues.push({
        level: 'critical',
        code: 'inactive_task',
        message: `开盘量化任务已停用：${targetTaskName}`,
      });
    }

    const latestLog = task
      ? await TaskExecutionLog.findOne({
          where: {
            task_id: task.id,
            started_at: { [Op.between]: [dayStart, dayEnd] },
          },
          order: [['started_at', 'DESC']],
        })
      : null;

    if (!latestLog) {
      const shouldEscalate = now.isAfter(latestAllowedAt) && hasMarketOpenedForDate;
      const level = shouldEscalate ? 'critical' : 'warning';
      issues.push({
        level,
        code: 'task_not_run',
        message: `交易日 ${tradeDate} 尚未发现 ${targetTaskName} 执行日志，预期 ${expectedAfterTime} 后运行。`,
      });
    } else if (latestLog.status === 'FAILED') {
      issues.push({
        level: 'critical',
        code: 'task_failed',
        message: `${targetTaskName} 最近一次执行失败：${latestLog.error_message || '未记录错误'}`,
      });
    } else if (
      latestLog.status === 'IN_PROGRESS' &&
      now.diff(moment(latestLog.started_at), 'minutes') > 45
    ) {
      issues.push({
        level: 'critical',
        code: 'task_stuck',
        message: `${targetTaskName} 已运行超过 45 分钟仍未完成。`,
      });
    }

    const [quantSignalCount, archivedSignalCount, paperTradeCount, quotePersistence] =
      await Promise.all([
        QuantSignal.count({ where: { trade_date: tradeDate } }),
        AIInvestmentSignal.count({
          where: {
            source_type: AISignalSourceType.QUANT_RECOMMENDATION,
            signal_date: tradeDate,
          },
        }),
        PaperTradingTrade.count({
          where: { created_at: { [Op.between]: [dayStart, dayEnd] } },
        }).catch(() => 0),
        realtimeQuoteService.getPersistenceSummary({ trade_date: tradeDate }),
      ]);

    if (quantSignalCount < minQuantSignals) {
      issues.push({
        level: latestLog?.status === 'COMPLETED' && hasMarketOpenedForDate ? 'critical' : 'warning',
        code: 'no_quant_signals',
        message: `量化信号不足：${quantSignalCount}/${minQuantSignals}。`,
      });
    }
    if (archivedSignalCount < minArchivedSignals) {
      // BL-1 (2026-06-25) — 区分 "扫描失败" vs "扫描成功但无候选"
      //
      // 真因: 2026-06-25 开盘扫描成功生成 166 条策略信号 (扫描正常), 但融合后无
      // 股票达到 min_score=55 阈值, 归档 0. watchdog 旧逻辑直接 critical → throw
      // → cron FAILED → Lark 告警, 但这本质是合理的"今日市场无机会"业务空仓状态.
      //
      // 修后: 当 quant_signal_count 达标 (扫描已成功) 但 archived=0, 仅 warning
      // 不 throw; 只有扫描和归档都不足才 critical (真链路异常).
      const scanWorked = quantSignalCount >= minQuantSignals;
      const isCritical =
        latestLog?.status === 'COMPLETED' && hasMarketOpenedForDate && !scanWorked;
      issues.push({
        level: isCritical ? 'critical' : 'warning',
        code: 'no_archived_signals',
        message: scanWorked
          ? `量化融合归档不足：${archivedSignalCount}/${minArchivedSignals} (扫描已生成 ${quantSignalCount} 条策略信号, 本日无候选达到融合阈值, 属合理空仓)。`
          : `量化融合归档不足：${archivedSignalCount}/${minArchivedSignals}。`,
      });
    }
    if (requireFreshQuote) {
      const age = quotePersistence.age_minutes;
      if (!quotePersistence.persisted) {
        issues.push({ level: 'warning', code: 'quote_missing', message: '实时行情尚未落盘。' });
      } else if (age !== null && Number(age) > freshnessMaxMinutes) {
        issues.push({
          level: 'warning',
          code: 'quote_stale',
          message: `实时行情已过期 ${age} 分钟，阈值 ${freshnessMaxMinutes} 分钟。`,
        });
      }
    }

    const status = worstStatus(issues);
    return {
      status,
      generated_at: now.format('YYYY-MM-DD HH:mm:ss'),
      trade_date: tradeDate,
      target_task: task
        ? {
            id: task.id,
            name: task.name,
            type: task.type,
            cron_expression: task.cron_expression,
            is_active: task.is_active,
            last_run_at: task.last_run_at,
            last_run_status: task.last_run_status,
          }
        : null,
      expected_after_time: expectedAfterTime,
      latest_allowed_minutes: latestAllowedMinutes,
      market_time_guard: {
        is_weekend: isWeekend,
        has_market_opened_for_date: hasMarketOpenedForDate,
        off_hours_warning_only: offHoursWarningOnly,
        latest_allowed_at: latestAllowedAt.format('YYYY-MM-DD HH:mm:ss'),
      },
      latest_log: latestLog
        ? {
            id: latestLog.id,
            status: latestLog.status,
            started_at: latestLog.started_at,
            completed_at: latestLog.completed_at,
            total_items: latestLog.total_items,
            completed_items: latestLog.completed_items,
            failed_items: latestLog.failed_items,
            error_message: latestLog.error_message,
          }
        : null,
      checks: {
        quant_signal_count: quantSignalCount,
        min_quant_signals: minQuantSignals,
        archived_signal_count: archivedSignalCount,
        min_archived_signals: minArchivedSignals,
        paper_trade_count: paperTradeCount,
        quote_persistence: quotePersistence,
      },
      issues,
      conclusion:
        status === 'healthy'
          ? '开盘量化推荐链路已运行，信号、归档和行情检查通过。'
          : status === 'warning'
          ? '开盘量化推荐链路存在警告，建议观察行情新鲜度和信号数量。'
          : '开盘量化推荐链路存在关键异常，需要立即排查定时任务、信号生成或归档写入。',
    };
  }
}

export const quantOpenWatchdogService = new QuantOpenWatchdogService();
