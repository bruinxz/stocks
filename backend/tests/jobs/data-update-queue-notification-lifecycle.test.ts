import { finalizeQueuedScheduledTask } from '../../src/jobs/dataUpdateQueue';
import { ScheduledTask } from '../../src/models/ScheduledTask';
import { cronNotificationLifecycleService } from '../../src/services/CronNotificationLifecycleService';

let failed = 0;
function assert(name: string, condition: boolean) {
  if (!condition) {
    failed += 1;
    console.error(`FAIL ${name}`);
  }
}

async function main() {
  const originalFind = ScheduledTask.findByPk;
  const originalFailure = cronNotificationLifecycleService.recordFailure;
  const originalRecovery = cronNotificationLifecycleService.recordRecovery;
  const originalThreshold = process.env.SCHEDULER_FAILURE_KILL_THRESHOLD;
  const notifications: any[] = [];
  const task: any = {
    id: 7,
    type: 'DAILY_UPDATE',
    name: '每日更新',
    is_active: true,
    consecutive_failure_count: 0,
    last_run_status: 'RUNNING',
    async update(patch: any) {
      Object.assign(this, patch);
    },
  };
  try {
    (ScheduledTask as any).findByPk = async () => task;
    (cronNotificationLifecycleService as any).recordFailure = async (input: any) => {
      notifications.push({ phase: 'failure', input });
    };
    (cronNotificationLifecycleService as any).recordRecovery = async (input: any) => {
      notifications.push({ phase: 'recovery', input });
    };
    process.env.SCHEDULER_FAILURE_KILL_THRESHOLD = '2';

    await finalizeQueuedScheduledTask({
      scheduled_task_id: 7,
      execution_log_id: 101,
      status: 'FAILED',
      error_message: 'source down',
    });
    assert('first queue failure increments persistent count', task.consecutive_failure_count === 1);
    assert('first queue failure remains active', task.is_active === true);
    assert('first queue failure enters incident lifecycle', notifications[0]?.phase === 'failure');
    assert('execution log correlation preserved', notifications[0]?.input.execution_log_id === 101);

    await finalizeQueuedScheduledTask({
      scheduled_task_id: 7,
      execution_log_id: 102,
      status: 'FAILED',
      error_message: 'still down',
    });
    assert('threshold queue failure disables task', task.is_active === false);
    assert('threshold queue failure marks escalation', notifications[1]?.input.killed === true);

    await finalizeQueuedScheduledTask({
      scheduled_task_id: 7,
      execution_log_id: 103,
      status: 'SUCCESS',
    });
    assert('queue recovery resets failure count', task.consecutive_failure_count === 0);
    assert('queue recovery enters lifecycle', notifications[2]?.phase === 'recovery');
  } finally {
    (ScheduledTask as any).findByPk = originalFind;
    (cronNotificationLifecycleService as any).recordFailure = originalFailure;
    (cronNotificationLifecycleService as any).recordRecovery = originalRecovery;
    if (originalThreshold === undefined) delete process.env.SCHEDULER_FAILURE_KILL_THRESHOLD;
    else process.env.SCHEDULER_FAILURE_KILL_THRESHOLD = originalThreshold;
  }

  console.log(`[data-update-queue-notification-lifecycle] ${8 - failed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
