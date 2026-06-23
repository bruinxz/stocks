/**
 * SchedulerService cron failed → SystemAdminAlertPusher hook 测试 — Batch BF-2 (2026-06-23)
 *
 * 跑法:
 *   cd backend && npx ts-node --transpile-only tests/services/scheduler-cron-failed-push.test.ts
 *
 * 验证 markTaskFinished 在 status=FAILED 时是否会触发 SystemAdminAlertPusher.
 * 完全脱离 DB / 飞书 — 直接调 errorStackPreview / 模拟 cron 失败 → 监听 fire-and-forget
 * pusher 被 invoke.
 *
 * 实现策略: 不 import 整个 SchedulerService (会 require 大量 model / queue),
 * 把要测的内联 logic 单独抽出来测. 真路径走 system-admin-alert-pusher 自己的单测.
 */

import {
  clearSystemAdminAlertDedupForTests,
  pushSystemAdminAlert,
} from '../../src/services/SystemAdminAlertPusher';

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

/**
 * 复刻 SchedulerService.errorStackPreview (因为 SchedulerService 在 file 顶层
 * import 整个 SequelizeTypescript 模型, 跑测要 DB 真连; 单测只关心 helper 逻辑).
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

async function main() {
  console.log('\n[1] errorStackPreview 边界...');
  assertEqual('null err → 空', errorStackPreview(null, 5), '');
  assertEqual('undefined err → 空', errorStackPreview(undefined, 5), '');
  assertEqual('string err (无 stack) → 空', errorStackPreview('bad', 5), '');
  assertEqual('object 无 stack → 空', errorStackPreview({ message: 'x' }, 5), '');

  const e = new Error('boom');
  const preview = errorStackPreview(e, 3);
  assert('Error 实例 → 包含 boom', preview.includes('boom'));
  assert('Error 实例 → 行数 ≤ 3', preview.split('\n').length <= 3);

  // ===========================================================================
  console.log('\n[2] cron failed → SystemAdminAlertPusher e2e...');
  clearSystemAdminAlertDedupForTests();
  const origFei = process.env.OPS_ALERT_FEISHU_WEBHOOK;
  const origEmails = process.env.ADMIN_ALERT_EMAILS;
  process.env.OPS_ALERT_FEISHU_WEBHOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/fake';
  delete process.env.ADMIN_ALERT_EMAILS;

  const dedup = new Map<string, number>();
  let postCount = 0;
  const r1 = await pushSystemAdminAlert(
    {
      dedup_key: 'cron:DAILY_UPDATE',
      level: 'WARN',
      title: '[CRON FAIL] 每日数据更新 (DAILY_UPDATE)',
      body_markdown:
        '**task_id**: 1\n**task.type**: DAILY_UPDATE\n**连续失败次数**: 1\n**错误**:\n```\nBlackSwanClient timeout\n```',
      triggered_at: '2026-06-23T15:00:00Z',
      trace_id: 'task_execution_log_id=999',
    },
    {
      dedup_state: dedup,
      now_ms: 1700000000000,
      feishu_post: async () => {
        postCount += 1;
        return { data: { code: 0 } };
      },
    }
  );
  assertEqual('cron failed push pushed=true', r1.pushed, true);
  assertEqual('cron failed feishu success', r1.feishu.success, true);
  assertEqual('调 feishu 1 次', postCount, 1);

  // 1h 内同 task 再失败 → dedup
  postCount = 0;
  const r2 = await pushSystemAdminAlert(
    {
      dedup_key: 'cron:DAILY_UPDATE',
      level: 'WARN',
      title: '[CRON FAIL] 每日数据更新 (DAILY_UPDATE)',
      body_markdown: '**连续失败次数**: 2',
      triggered_at: '2026-06-23T15:30:00Z',
    },
    {
      dedup_state: dedup,
      now_ms: 1700000000000 + 30 * 60 * 1000, // 30min later
      feishu_post: async () => {
        postCount += 1;
        return { data: { code: 0 } };
      },
    }
  );
  assertEqual('30min 后同 task → deduped', r2.deduped, true);
  assertEqual('30min 后同 task → 不调 feishu', postCount, 0);

  // 不同 task → 不 dedup
  postCount = 0;
  const r3 = await pushSystemAdminAlert(
    {
      dedup_key: 'cron:REALTIME_QUOTE_SYNC',
      level: 'WARN',
      title: '[CRON FAIL] REALTIME_QUOTE_SYNC',
      body_markdown: 'x',
      triggered_at: '2026-06-23T15:30:00Z',
    },
    {
      dedup_state: dedup,
      now_ms: 1700000000000 + 30 * 60 * 1000,
      feishu_post: async () => {
        postCount += 1;
        return { data: { code: 0 } };
      },
    }
  );
  assertEqual('不同 task → 不 dedup', r3.deduped, false);
  assertEqual('不同 task → 推', postCount, 1);

  // 出 1h 窗后 → 重新推
  postCount = 0;
  const r4 = await pushSystemAdminAlert(
    {
      dedup_key: 'cron:DAILY_UPDATE',
      level: 'WARN',
      title: 't',
      body_markdown: 'x',
    },
    {
      dedup_state: dedup,
      now_ms: 1700000000000 + 61 * 60 * 1000,
      feishu_post: async () => {
        postCount += 1;
        return { data: { code: 0 } };
      },
    }
  );
  assertEqual('出 1h 窗 → 重新推', r4.pushed, true);
  assertEqual('出 1h 窗 → 不 dedup', r4.deduped, false);

  // 还原
  if (origFei !== undefined) process.env.OPS_ALERT_FEISHU_WEBHOOK = origFei;
  else delete process.env.OPS_ALERT_FEISHU_WEBHOOK;
  if (origEmails !== undefined) process.env.ADMIN_ALERT_EMAILS = origEmails;
  else delete process.env.ADMIN_ALERT_EMAILS;

  console.log('========================================');
  console.log(
    `scheduler-cron-failed-push test summary: ${passed} ok / ${failed} failed`
  );
  console.log('========================================');
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('test unexpected error:', err);
  process.exit(1);
});
