import {
  __resetAuditAlertForTests,
  __setLiveAuditNotificationServiceForTests,
  formatLiveAuditAlertText,
  sendLiveAuditAlert,
} from '../../src/live-trading/services/LiveAuditAlertService';

let failed = 0;
function assert(name: string, condition: boolean, detail = '') {
  if (!condition) {
    failed += 1;
    console.error(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
}

async function flush() {
  await new Promise(resolve => setTimeout(resolve, 0));
}

async function main() {
  const original = { ...process.env };
  const unique = new Map<string, any>();
  let calls = 0;
  let shouldThrow = false;
  const fake = {
    async enqueueAndDeliver(input: any) {
      calls += 1;
      if (shouldThrow) throw new Error('db down');
      if (!unique.has(input.idempotency_key)) unique.set(input.idempotency_key, input);
      return { success: true, status: 'sent', outbox_id: unique.size, attempts: 1 };
    },
  };
  __setLiveAuditNotificationServiceForTests(fake as any);

  sendLiveAuditAlert({ event_type: 'ignored', severity: 'info', message: 'x' });
  await flush();
  assert('info skipped', calls === 0);

  sendLiveAuditAlert({ event_type: 'warning', severity: 'warning', message: 'x' });
  await flush();
  assert('warning skipped by default', calls === 0);

  process.env.LIVE_ALERT_INCLUDE_WARNING = 'true';
  sendLiveAuditAlert({ event_type: 'warning', severity: 'warning', message: 'x' });
  await flush();
  assert('warning opt-in enqueued', calls === 1);
  delete process.env.LIVE_ALERT_INCLUDE_WARNING;

  const payload = {
    event_type: 'live_kill_switch_triggered',
    severity: 'critical',
    message: 'unit test',
    user_id: 7,
    metadata: { reason_code: 'manual' },
  };
  sendLiveAuditAlert(payload);
  await flush();
  const critical = [...unique.values()].find(row => row.topic_key.includes('live_kill_switch'));
  assert('critical uses live audience', critical?.audience === 'live');
  const text = critical?.payload?.content?.text || '';
  assert('critical text includes context', text.includes('user=7') && text.includes('reason_code'));
  assert('critical time is UTC+8', text.includes('UTC+8'));

  for (let i = 0; i < 5; i++) {
    sendLiveAuditAlert({
      event_type: 'flood',
      severity: 'error',
      message: String(i),
      metadata: { reason_code: 'same' },
    });
  }
  await flush();
  const floodRows = [...unique.values()].filter(row =>
    row.topic_key.includes('live-audit:flood:same')
  );
  assert('same key is durably deduped by window', floodRows.length === 1);

  sendLiveAuditAlert({
    event_type: 'flood',
    severity: 'error',
    message: 'a',
    metadata: { reason_code: 'a' },
  });
  sendLiveAuditAlert({
    event_type: 'flood',
    severity: 'error',
    message: 'b',
    metadata: { reason_code: 'b' },
  });
  await flush();
  assert(
    'different reason codes do not dedup',
    [...unique.values()].filter(row => row.topic_key.startsWith('live-audit:flood:')).length === 3
  );

  process.env.DISABLE_LIVE_ALERT = 'true';
  const beforeDisabled = calls;
  sendLiveAuditAlert({ event_type: 'disabled', severity: 'critical', message: 'x' });
  await flush();
  assert('disable flag skips enqueue', calls === beforeDisabled);
  delete process.env.DISABLE_LIVE_ALERT;

  shouldThrow = true;
  let threw = false;
  try {
    sendLiveAuditAlert({ event_type: 'db_error', severity: 'critical', message: 'x' });
    await flush();
  } catch {
    threw = true;
  }
  assert('enqueue error remains fire-and-forget', threw === false);

  const formatted = formatLiveAuditAlertText(payload);
  assert('formatter includes critical emoji', formatted.includes('🚨'));

  __resetAuditAlertForTests();
  process.env = original;
  console.log(`[live-audit-outbox] ${10 - failed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
