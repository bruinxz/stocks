export interface RetiredScheduledTaskLike {
  id: number;
  name: string;
  type: string;
  update(patch: Record<string, unknown>): Promise<unknown>;
}

export interface RetiredTaskExecutionLogLike {
  update(patch: Record<string, unknown>): Promise<unknown>;
}

export interface RetiredScheduledTaskResult {
  success: true;
  skipped: true;
  message: string;
}

interface SkipRetiredScheduledTaskOptions {
  task: RetiredScheduledTaskLike;
  execution_log: RetiredTaskExecutionLogLike | null;
  reason: string;
  metric_started_at_ms: number;
  record_metric: (task_type: string, status: string, duration_seconds: number) => void;
  deactivate_in_memory?: () => void | Promise<void>;
  now?: () => Date;
  warn?: (message: string) => void;
}

/**
 * Safely finalizes a persisted cron row whose implementation has been retired.
 * Execution-log writes are intentionally fail-open so a broken audit row cannot
 * keep the obsolete task active. The scheduled-task update remains mandatory.
 */
export async function skipRetiredScheduledTask(
  options: SkipRetiredScheduledTaskOptions
): Promise<RetiredScheduledTaskResult> {
  const now = options.now || (() => new Date());
  const warn = options.warn || (() => undefined);
  const summary = {
    scenario: 'retired_scheduled_task',
    retired: true,
    task_type: options.task.type,
    reason: options.reason,
  };

  if (options.execution_log) {
    try {
      await options.execution_log.update({
        total_items: 0,
        completed_items: 0,
        failed_items: 0,
        status: 'SKIPPED',
        completed_at: now(),
        error_message: null,
        result_summary: summary,
      });
    } catch (error: any) {
      warn(
        `[scheduler] retired task ${options.task.type} execution log update failed; ` +
          `continuing with task deactivation: ${error?.message || error}`
      );
    }
  }

  await options.task.update({
    last_run_status: 'SKIPPED',
    is_active: false,
  });

  if (options.deactivate_in_memory) {
    try {
      await options.deactivate_in_memory();
    } catch (error: any) {
      warn(
        `[scheduler] retired task ${options.task.type} in-memory deactivation failed: ` +
          `${error?.message || error}`
      );
    }
  }

  try {
    options.record_metric(
      options.task.type,
      'skipped',
      Math.max(0, (Date.now() - options.metric_started_at_ms) / 1000)
    );
  } catch (error: any) {
    warn(
      `[scheduler] retired task ${options.task.type} skipped metric failed: ` +
        `${error?.message || error}`
    );
  }

  return {
    success: true,
    skipped: true,
    message: `skipped: retired task ${options.task.type}`,
  };
}
