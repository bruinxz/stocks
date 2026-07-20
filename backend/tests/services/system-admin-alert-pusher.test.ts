import {
  buildSystemAdminAlertCard,
  pushSystemAdminAlert,
} from '../../src/services/SystemAdminAlertPusher';

let failed = 0;
function assert(name: string, condition: boolean, detail = '') {
  if (!condition) {
    failed += 1;
    console.error(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
}

async function main() {
  const queued: any[] = [];
  const notifications = {
    async enqueueAndDeliver(input: any) {
      queued.push(input);
      return {
        success: queued.length !== 2,
        deduped: false,
        skipped: false,
        status: queued.length === 2 ? 'retry' : 'sent',
        outbox_id: queued.length,
        attempts: 1,
        message: queued.length === 2 ? 'timeout' : undefined,
      };
    },
  };

  const red = buildSystemAdminAlertCard({
    dedup_key: 'red',
    level: 'HIGH',
    title: '高风险',
    body_markdown: 'detail',
  });
  assert('HIGH card is red', red.card.header.template === 'red');

  const green = buildSystemAdminAlertCard({
    dedup_key: 'green',
    level: 'SUCCESS',
    title: '恢复',
    body_markdown: 'ok',
  });
  assert('SUCCESS card is green', green.card.header.template === 'green');

  const first = await pushSystemAdminAlert(
    {
      dedup_key: 'cron:test',
      level: 'WARN',
      title: 'cron failed',
      body_markdown: 'failure',
      audience: 'ops',
    },
    {
      now_ms: Date.UTC(2026, 6, 19, 0, 30),
      dedup_window_ms: 60 * 60 * 1000,
      notification_service: notifications as any,
    }
  );
  assert('windowed notification delegates to outbox', first.pushed === true);
  assert('windowed key is persistent', queued[0].idempotency_key === 'cron:test:window:495672');
  assert('ops audience remains strict', queued[0].audience === 'ops');

  const retry = await pushSystemAdminAlert(
    {
      dedup_key: 'delivery-failure',
      idempotency_key: 'stable:event:1',
      level: 'CRITICAL',
      title: 'delivery failure',
      body_markdown: 'timeout',
    },
    { notification_service: notifications as any }
  );
  assert(
    'delivery failure is reported as retry',
    retry.status === 'retry' && retry.pushed === false
  );
  assert(
    'explicit business idempotency key preserved',
    queued[1].idempotency_key === 'stable:event:1'
  );

  const exact = await pushSystemAdminAlert(
    {
      dedup_key: 'daily',
      idempotency_key: 'daily-health:2026-07-19',
      audience: 'ops',
      kind: 'daily_health_report',
      level: 'INFO',
      title: 'daily',
      body_markdown: 'ok',
    },
    { notification_service: notifications as any }
  );
  assert(
    'exact key and kind reach outbox',
    queued[2].idempotency_key === 'daily-health:2026-07-19' &&
      queued[2].kind === 'daily_health_report'
  );
  assert(
    'legacy admin email side channel removed',
    exact.email.skipped === true && exact.email.attempted === false
  );

  console.log(`[system-admin-alert-outbox] ${9 - failed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
