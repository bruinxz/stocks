/**
 * LiveAuditAlertService 单测。
 *
 *   cd backend && npx ts-node --transpile-only src/live-trading/services/LiveAuditAlertService.test.ts
 */

import axios from 'axios';

import {
  sendLiveAuditAlert,
  __resetAuditAlertForTests,
} from './LiveAuditAlertService';

let failed = 0;
const ORIGINAL_ENV = { ...process.env };

function assert(name: string, cond: boolean, detail = '') {
  if (cond) console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

const calls: Array<{ url: string; body: any }> = [];
let originalCreate: typeof axios.create;

function installAxiosStub(behavior: 'ok' | 'throw' = 'ok') {
  originalCreate = axios.create;
  (axios as any).create = () => ({
    post: async (url: string, body: any) => {
      if (behavior === 'throw') throw new Error('network down');
      calls.push({ url, body });
      return { data: { ok: true } };
    },
  });
}

function uninstallAxiosStub() {
  (axios as any).create = originalCreate;
}

function reset() {
  __resetAuditAlertForTests();
  calls.length = 0;
  process.env = { ...ORIGINAL_ENV };
  process.env.LIVE_ALERT_FEISHU_WEBHOOK = 'https://feishu.example.com/hook/x';
}

async function flush(ms: number) {
  await new Promise(r => setTimeout(r, ms));
}

// ------------------------------------------------------------

async function test_no_webhook_no_send() {
  reset();
  delete process.env.LIVE_ALERT_FEISHU_WEBHOOK;
  delete process.env.FEISHU_RECOMMENDATION_BOT_WEBHOOK;
  installAxiosStub('ok');
  sendLiveAuditAlert({ event_type: 't1', severity: 'critical', message: 'm' });
  await flush(20);
  uninstallAxiosStub();
  assert('未配 webhook 不推送', calls.length === 0);
}

async function test_info_severity_skipped() {
  reset();
  installAxiosStub('ok');
  sendLiveAuditAlert({ event_type: 't2', severity: 'info', message: 'm' });
  await flush(20);
  uninstallAxiosStub();
  assert('info 级别不推', calls.length === 0);
}

async function test_warning_default_skipped() {
  reset();
  installAxiosStub('ok');
  sendLiveAuditAlert({ event_type: 't3', severity: 'warning', message: 'm' });
  await flush(20);
  uninstallAxiosStub();
  assert('warning 默认不推', calls.length === 0);
}

async function test_warning_opt_in() {
  reset();
  process.env.LIVE_ALERT_INCLUDE_WARNING = 'true';
  installAxiosStub('ok');
  sendLiveAuditAlert({ event_type: 't3b', severity: 'warning', message: 'm' });
  await flush(20);
  uninstallAxiosStub();
  assert('warning + opt-in 推送', calls.length === 1);
}

async function test_critical_sent() {
  reset();
  installAxiosStub('ok');
  sendLiveAuditAlert({
    event_type: 'live_kill_switch_triggered',
    severity: 'critical',
    message: 'unit test',
    user_id: 7,
    metadata: { reason_code: 'manual' },
  });
  await flush(20);
  uninstallAxiosStub();
  assert('critical 推送 1 次', calls.length === 1);
  const text = calls[0]?.body?.content?.text || '';
  assert('text 含 event_type', text.includes('live_kill_switch_triggered'));
  assert('text 含 emoji 🚨', text.includes('🚨'));
  assert('text 含 user', text.includes('user=7'));
  assert('text 含 metadata', text.includes('reason_code'));
}

async function test_dedup_within_window_only_one() {
  reset();
  installAxiosStub('ok');
  for (let i = 0; i < 5; i++) {
    sendLiveAuditAlert({
      event_type: 'flood',
      severity: 'error',
      message: `iter ${i}`,
      metadata: { reason_code: 'same' },
    });
  }
  await flush(20);
  uninstallAxiosStub();
  assert('5 次同 key 只推 1 次', calls.length === 1);
}

async function test_different_keys_not_dedup() {
  reset();
  installAxiosStub('ok');
  sendLiveAuditAlert({
    event_type: 'evt1',
    severity: 'error',
    message: 'm',
    metadata: { reason_code: 'a' },
  });
  sendLiveAuditAlert({
    event_type: 'evt1',
    severity: 'error',
    message: 'm',
    metadata: { reason_code: 'b' },
  });
  sendLiveAuditAlert({
    event_type: 'evt2',
    severity: 'error',
    message: 'm',
    metadata: { reason_code: 'a' },
  });
  await flush(20);
  uninstallAxiosStub();
  assert('不同 (event_type, reason_code) 不去重', calls.length === 3);
}

async function test_webhook_error_does_not_throw() {
  reset();
  installAxiosStub('throw');
  let threw = false;
  try {
    sendLiveAuditAlert({
      event_type: 'net_err',
      severity: 'critical',
      message: 'm',
    });
    await flush(20);
  } catch (e) {
    threw = true;
  }
  uninstallAxiosStub();
  assert('webhook 抛错不冒泡', threw === false);
}

async function test_disable_flag_skips_all() {
  reset();
  process.env.DISABLE_LIVE_ALERT = 'true';
  installAxiosStub('ok');
  sendLiveAuditAlert({
    event_type: 'disabled_test',
    severity: 'critical',
    message: 'm',
  });
  await flush(20);
  uninstallAxiosStub();
  assert('DISABLE_LIVE_ALERT=true 不推', calls.length === 0);
}

async function test_fallback_to_recommendation_webhook() {
  reset();
  delete process.env.LIVE_ALERT_FEISHU_WEBHOOK;
  process.env.FEISHU_RECOMMENDATION_BOT_WEBHOOK = 'https://feishu.example.com/hook/fallback';
  installAxiosStub('ok');
  sendLiveAuditAlert({
    event_type: 'fallback_test',
    severity: 'critical',
    message: 'm',
  });
  await flush(20);
  uninstallAxiosStub();
  assert('回退到 RECOMMENDATION webhook', calls.length === 1);
  assert('url 走的是 fallback', calls[0]?.url?.includes('fallback') === true);
}

// ------------------------------------------------------------

const tests = [
  test_no_webhook_no_send,
  test_info_severity_skipped,
  test_warning_default_skipped,
  test_warning_opt_in,
  test_critical_sent,
  test_dedup_within_window_only_one,
  test_different_keys_not_dedup,
  test_webhook_error_does_not_throw,
  test_disable_flag_skips_all,
  test_fallback_to_recommendation_webhook,
];

(async () => {
  console.log(`\n=== LiveAuditAlertService unit tests (${tests.length}) ===\n`);
  for (const t of tests) {
    try {
      await t();
    } catch (err: any) {
      failed += 1;
      console.error(`  THROW ${t.name}: ${err?.message || err}`);
    }
  }
  process.env = ORIGINAL_ENV;
  console.log(`\nResult: ${tests.length - failed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
