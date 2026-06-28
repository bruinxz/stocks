/**
 * SystemAdminAlertPusher 单测 — Batch BF-1 (2026-06-23)
 *
 * 跑法:
 *   cd backend && npx ts-node --transpile-only tests/services/system-admin-alert-pusher.test.ts
 *
 * 覆盖:
 *   - isDedupedForKey / recordDedupForKey 边界
 *   - buildSystemAdminAlertCard 4 个 level header 颜色
 *   - pushSystemAdminAlert e2e:
 *     - feishu env 缺 → feishu.attempted=false
 *     - feishu success → success=true + dedup 记录
 *     - feishu code != 0 → success=false
 *     - 同 dedup_key 1h 内第二次 → deduped=true
 *     - 不同 dedup_key 不互相影响
 *     - admin email 缺 → email.skipped=true
 *     - admin email 3 个收件人 2 succ 1 fail → success_count=2 failed_count=1
 *     - 顶层 throw → catch 不挂
 */

import {
  isDedupedForKey,
  recordDedupForKey,
  buildSystemAdminAlertCard,
  pushSystemAdminAlert,
} from '../../src/services/SystemAdminAlertPusher';
import {
  markDispatcherFeishuForAlert,
  clearDispatcherFeishuMarksForTests,
} from '../../src/services/RealtimeAlertDispatcher';

let passed = 0;
let failed = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`❌ ${name}${detail ? '  detail=' + detail : ''}`);
  }
}

function assertEqual<T>(name: string, actual: T, expected: T): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(name, ok, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

async function main() {
  // ===========================================================================
  console.log('\n[1] isDedupedForKey / recordDedupForKey 边界...');
  const state = new Map<string, number>();
  const now = 1_700_000_000_000;
  assertEqual('empty state → false', isDedupedForKey('k', now, state), false);
  recordDedupForKey('k', now, state);
  assertEqual('刚 record → true', isDedupedForKey('k', now, state, 60_000), true);
  assertEqual(
    '60s 内 → true',
    isDedupedForKey('k', now + 59_000, state, 60_000),
    true
  );
  assertEqual(
    '60s 之外 → false',
    isDedupedForKey('k', now + 60_001, state, 60_000),
    false
  );
  assertEqual('空 key → false', isDedupedForKey('', now, state), false);

  // ===========================================================================
  console.log('\n[2] buildSystemAdminAlertCard header 颜色...');
  const c1 = buildSystemAdminAlertCard({
    dedup_key: 'k',
    level: 'CRITICAL',
    title: 't',
    body_markdown: 'b',
  });
  assertEqual('CRITICAL → red', c1.card.header.template, 'red');
  const c2 = buildSystemAdminAlertCard({
    dedup_key: 'k',
    level: 'HIGH',
    title: 't',
    body_markdown: 'b',
  });
  assertEqual('HIGH → red', c2.card.header.template, 'red');
  const c3 = buildSystemAdminAlertCard({
    dedup_key: 'k',
    level: 'WARN',
    title: 't',
    body_markdown: 'b',
  });
  assertEqual('WARN → orange', c3.card.header.template, 'orange');
  const c4 = buildSystemAdminAlertCard({
    dedup_key: 'k',
    level: 'INFO',
    title: 't',
    body_markdown: 'b',
  });
  assertEqual('INFO → blue', c4.card.header.template, 'blue');
  assertEqual('msg_type=interactive', c1.msg_type, 'interactive');

  // ===========================================================================
  console.log('\n[3] pushSystemAdminAlert e2e feishu 路径...');
  // 设 env
  const origFeishu = process.env.OPS_ALERT_FEISHU_WEBHOOK;
  const origRecBot = process.env.FEISHU_RECOMMENDATION_BOT_WEBHOOK;
  const origBot = process.env.FEISHU_BOT_WEBHOOK;
  const origEmails = process.env.ADMIN_ALERT_EMAILS;
  process.env.OPS_ALERT_FEISHU_WEBHOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/fake-token';
  delete process.env.FEISHU_RECOMMENDATION_BOT_WEBHOOK;
  delete process.env.FEISHU_BOT_WEBHOOK;
  delete process.env.ADMIN_ALERT_EMAILS;

  const dedup = new Map<string, number>();
  const postCalls: any[] = [];
  const r1 = await pushSystemAdminAlert(
    {
      dedup_key: 'risk:sh.600519:HIGH',
      level: 'HIGH',
      title: 't',
      body_markdown: 'b',
    },
    {
      dedup_state: dedup,
      now_ms: 1_700_000_000_000,
      feishu_post: async (url, body) => {
        postCalls.push({ url, body });
        return { data: { code: 0 } };
      },
    }
  );
  assertEqual('feishu attempted', r1.feishu.attempted, true);
  assertEqual('feishu success', r1.feishu.success, true);
  assertEqual('pushed=true', r1.pushed, true);
  assertEqual('email skipped (no env)', r1.email.skipped, true);
  assertEqual('postCalls=1', postCalls.length, 1);
  assertEqual('dedup recorded', dedup.has('risk:sh.600519:HIGH'), true);

  // 第二次 — dedup hit
  postCalls.length = 0;
  const r2 = await pushSystemAdminAlert(
    {
      dedup_key: 'risk:sh.600519:HIGH',
      level: 'HIGH',
      title: 't2',
      body_markdown: 'b2',
    },
    {
      dedup_state: dedup,
      now_ms: 1_700_000_000_000 + 100,
      feishu_post: async () => ({ data: { code: 0 } }),
    }
  );
  assertEqual('第二次 deduped=true', r2.deduped, true);
  assertEqual('第二次 pushed=false', r2.pushed, false);
  assertEqual('postCalls=0', postCalls.length, 0);

  // 不同 dedup_key → 不互相影响
  const r3 = await pushSystemAdminAlert(
    {
      dedup_key: 'risk:sh.600519:CRITICAL',
      level: 'CRITICAL',
      title: 't3',
      body_markdown: 'b3',
    },
    {
      dedup_state: dedup,
      now_ms: 1_700_000_000_000 + 200,
      feishu_post: async () => ({ data: { code: 0 } }),
    }
  );
  assertEqual('不同 key 不 dedup', r3.deduped, false);
  assertEqual('不同 key 推', r3.pushed, true);

  // 出 1h 窗 — 同 key 再推
  const r4 = await pushSystemAdminAlert(
    {
      dedup_key: 'risk:sh.600519:HIGH',
      level: 'HIGH',
      title: 't4',
      body_markdown: 'b4',
    },
    {
      dedup_state: dedup,
      now_ms: 1_700_000_000_000 + 61 * 60 * 1000,
      feishu_post: async () => ({ data: { code: 0 } }),
    }
  );
  assertEqual('出 1h 窗 不 dedup', r4.deduped, false);
  assertEqual('出 1h 窗 推', r4.pushed, true);

  // feishu code != 0
  const dedup2 = new Map<string, number>();
  const r5 = await pushSystemAdminAlert(
    {
      dedup_key: 'risk:sh.000001:HIGH',
      level: 'HIGH',
      title: 't',
      body_markdown: 'b',
    },
    {
      dedup_state: dedup2,
      now_ms: 1_700_000_000_000,
      feishu_post: async () => ({ data: { code: 19021, msg: 'invalid token' } }),
    }
  );
  assertEqual('feishu code!=0 success=false', r5.feishu.success, false);
  assertEqual('feishu code!=0 message=invalid token', r5.feishu.message, 'invalid token');

  // ===========================================================================
  console.log('\n[4] pushSystemAdminAlert email 路径...');
  delete process.env.OPS_ALERT_FEISHU_WEBHOOK;
  process.env.ADMIN_ALERT_EMAILS = 'admin1@example.com, admin2@example.com,admin3@example.com';
  const dedup3 = new Map<string, number>();
  const emailCalls: any[] = [];
  const r6 = await pushSystemAdminAlert(
    {
      dedup_key: 'cron:DAILY_UPDATE',
      level: 'CRITICAL',
      title: 'DAILY_UPDATE failed',
      body_markdown: 'something broke',
    },
    {
      dedup_state: dedup3,
      now_ms: 1_700_000_000_000,
      email_send: async (addr) => {
        emailCalls.push(addr);
        // admin2 fails
        if (addr === 'admin2@example.com')
          return { success: false, message: 'SMTP down' };
        return { success: true };
      },
    }
  );
  assertEqual('feishu skipped (no env)', r6.feishu.attempted, false);
  assertEqual('email attempted=true', r6.email.attempted, true);
  assertEqual('email success_count=2', r6.email.success_count, 2);
  assertEqual('email failed_count=1', r6.email.failed_count, 1);
  assertEqual('emailCalls=3', emailCalls.length, 3);
  assertEqual('pushed=true (>=1 channel sent)', r6.pushed, true);

  // ===========================================================================
  console.log('\n[5] 顶层 fail-OPEN...');
  delete process.env.OPS_ALERT_FEISHU_WEBHOOK;
  delete process.env.ADMIN_ALERT_EMAILS;
  const dedup4 = new Map<string, number>();
  const r7 = await pushSystemAdminAlert(
    { dedup_key: 'k', level: 'HIGH', title: 't', body_markdown: 'b' },
    { dedup_state: dedup4, now_ms: 1_700_000_000_000 }
  );
  assertEqual('无 env 配置 - 不挂', typeof r7.pushed, 'boolean');

  // ===========================================================================
  console.log('\n[6] Phase 10 冗余 P1-2: dispatcher fan-out 去重...');
  process.env.OPS_ALERT_FEISHU_WEBHOOK = 'https://feishu.test/webhook/p10-dedupe';
  clearDispatcherFeishuMarksForTests();
  // (a) caller_alert_id=999 + dispatcher 已 mark 同 URL → feishu skip
  {
    const nowTest = 1_700_000_001_000;
    markDispatcherFeishuForAlert(999, 'https://feishu.test/webhook/p10-dedupe', nowTest);
    const postCalls: any[] = [];
    const r = await pushSystemAdminAlert(
      {
        dedup_key: 'risk:sh.600519:HIGH:p10-skip',
        level: 'HIGH',
        title: 't',
        body_markdown: 'b',
        caller_alert_id: 999,
      },
      {
        dedup_state: new Map(),
        now_ms: nowTest + 100,
        feishu_post: async (url, body) => {
          postCalls.push({ url, body });
          return { data: { code: 0 } };
        },
      }
    );
    assertEqual('p10 dedupe: feishu attempted=false', r.feishu.attempted, false);
    assertEqual('p10 dedupe: feishu success=false', r.feishu.success, false);
    assert(
      'p10 dedupe: feishu.message 含 dispatcher 已推送',
      String(r.feishu.message || '').includes('dispatcher')
    );
    assertEqual('p10 dedupe: postCalls=0 (未调 axios)', postCalls.length, 0);
  }
  // (b) caller_alert_id=999 但 dispatcher mark 的是不同 URL → feishu 仍发
  clearDispatcherFeishuMarksForTests();
  {
    const nowTest = 1_700_000_002_000;
    markDispatcherFeishuForAlert(999, 'https://feishu.test/webhook/different-url', nowTest);
    const postCalls: any[] = [];
    const r = await pushSystemAdminAlert(
      {
        dedup_key: 'risk:sh.600519:HIGH:p10-diff-url',
        level: 'HIGH',
        title: 't',
        body_markdown: 'b',
        caller_alert_id: 999,
      },
      {
        dedup_state: new Map(),
        now_ms: nowTest + 100,
        feishu_post: async (url, body) => {
          postCalls.push({ url, body });
          return { data: { code: 0 } };
        },
      }
    );
    assertEqual('p10 diff URL: feishu attempted=true', r.feishu.attempted, true);
    assertEqual('p10 diff URL: feishu success=true', r.feishu.success, true);
    assertEqual('p10 diff URL: postCalls=1', postCalls.length, 1);
  }
  // (c) dispatcher mark 超 10s TTL → 视为过期, feishu 仍发
  clearDispatcherFeishuMarksForTests();
  {
    const nowTest = 1_700_000_003_000;
    markDispatcherFeishuForAlert(999, 'https://feishu.test/webhook/p10-dedupe', nowTest);
    const postCalls: any[] = [];
    const r = await pushSystemAdminAlert(
      {
        dedup_key: 'risk:sh.600519:HIGH:p10-ttl',
        level: 'HIGH',
        title: 't',
        body_markdown: 'b',
        caller_alert_id: 999,
      },
      {
        dedup_state: new Map(),
        now_ms: nowTest + 11_000, // 超过 10s TTL
        feishu_post: async () => {
          postCalls.push(1);
          return { data: { code: 0 } };
        },
      }
    );
    assertEqual('p10 TTL: feishu attempted=true', r.feishu.attempted, true);
    assertEqual('p10 TTL: postCalls=1', postCalls.length, 1);
  }
  // (d) 未传 caller_alert_id → 不走去重路径 (兼容旧 caller)
  clearDispatcherFeishuMarksForTests();
  {
    const nowTest = 1_700_000_004_000;
    markDispatcherFeishuForAlert(999, 'https://feishu.test/webhook/p10-dedupe', nowTest);
    const postCalls: any[] = [];
    const r = await pushSystemAdminAlert(
      {
        dedup_key: 'risk:sh.600519:HIGH:p10-no-caller',
        level: 'HIGH',
        title: 't',
        body_markdown: 'b',
        // caller_alert_id 不传
      },
      {
        dedup_state: new Map(),
        now_ms: nowTest + 100,
        feishu_post: async () => {
          postCalls.push(1);
          return { data: { code: 0 } };
        },
      }
    );
    assertEqual('p10 no caller: feishu attempted=true', r.feishu.attempted, true);
    assertEqual('p10 no caller: postCalls=1', postCalls.length, 1);
  }
  clearDispatcherFeishuMarksForTests();
  delete process.env.OPS_ALERT_FEISHU_WEBHOOK;

  // 还原 env
  if (origFeishu !== undefined) process.env.OPS_ALERT_FEISHU_WEBHOOK = origFeishu;
  else delete process.env.OPS_ALERT_FEISHU_WEBHOOK;
  if (origRecBot !== undefined) process.env.FEISHU_RECOMMENDATION_BOT_WEBHOOK = origRecBot;
  if (origBot !== undefined) process.env.FEISHU_BOT_WEBHOOK = origBot;
  if (origEmails !== undefined) process.env.ADMIN_ALERT_EMAILS = origEmails;
  else delete process.env.ADMIN_ALERT_EMAILS;

  console.log('========================================');
  console.log(`system-admin-alert-pusher test summary: ${passed} ok / ${failed} failed`);
  console.log('========================================');
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('test unexpected error:', err);
  process.exit(1);
});
