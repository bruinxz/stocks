/**
 * audit-task-parameters-dry-run 单元测试 (US-003 / OPS-003)
 *
 * 不依赖 jest；node 直接跑:
 *   cd backend && npx ts-node --transpile-only \
 *     tests/scripts/audit-task-parameters-dry-run.test.ts
 *
 * 这份测试是 US-003 "dry_run 默认值巡检 boot guard + 扩展告警 channel" 的核心 guard：
 *   1. shouldFlagDryRunTask — 严格 === true / 仅白名单 task type / 仅 is_active 命中
 *   2. buildOpsAlertText — 0 命中 / 1 命中 / >5 命中（截断 + "+N more"）
 *   3. buildOpsAlertChannelPlan
 *      a. opts.dry_run=true → 总是返回 []
 *      b. opts.channels 显式传入 → 仅交集 + 去重 + 过滤未知名
 *      c. opts.channels 未传 + env 无 feishu webhook → ['risk_alert']
 *      d. opts.channels 未传 + env 有 feishu webhook → ['risk_alert','feishu_ops']
 *   4. auditTaskParametersDryRun 集成（注入式 fake ScheduledTask.findAll +
 *      fake RiskAlert creator + fake feishu poster）：
 *      a. 0 matches → 不写任何 alert, alerts=[], alert_written=false
 *      b. N matches + 默认 channel → 仅 risk_alert 调用 1 次, alert_id 透传
 *      c. risk_alert creator throw → fail-OPEN, alerts 里记 error, 整体不 throw
 *      d. env 有 webhook → feishu_ops 自动追加并被调用一次
 *      e. webhook poster fail → alerts 记 success=false, 整体不 throw
 *      f. caller 传 channels=[] → 一个 channel 都不跑, 但 matches 仍返回
 *      g. DB findAll throw → 整个 audit 返 error 字段, 不 throw
 *
 * 测试 [4] 覆盖 boot guard 真正会跑的路径：任一 channel 失败都不允许污染 boot。
 */

import {
  shouldFlagDryRunTask,
  buildOpsAlertText,
  buildOpsAlertChannelPlan,
  auditTaskParametersDryRun,
  DRY_RUN_AUDIT_CHANNELS,
  SHOULD_BE_LIVE_TASK_TYPES,
  type DryRunAuditMatch,
} from '../../src/scripts/audit-task-parameters-dry-run';

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

// ---------------------------------------------------------------------------
// Test bootstrap — silence logger 防止 console 被 warn/error 污染.
// 必须在 require 任何用 logger 的模块之前. 由于 ts-node hoist import,
// 这里直接 require + 覆盖（不 ESM-import）.
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-var-requires
const loggerModule = require('../../src/utils/logger');
loggerModule.logger.info = () => undefined;
loggerModule.logger.warn = () => undefined;
loggerModule.logger.error = () => undefined;

// 同样 stub ScheduledTask.findAll 让 auditTaskParametersDryRun 走我们投喂的数据.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ScheduledTask } = require('../../src/models/ScheduledTask');
let fakeRows: any[] = [];
let findAllThrow: Error | null = null;
ScheduledTask.findAll = async (_opts?: any) => {
  if (findAllThrow) throw findAllThrow;
  return fakeRows;
};

function resetFakeDb(): void {
  fakeRows = [];
  findAllThrow = null;
}

// ===========================================================================
// [1] shouldFlagDryRunTask
// ===========================================================================
console.log('\n[1] shouldFlagDryRunTask...');

assertEqual(
  '严格 === true 命中',
  shouldFlagDryRunTask({
    type: 'STRATEGY_KILL_SWITCH_CHECK',
    is_active: true,
    parameters: { dry_run: true },
  }),
  { flagged: true, dry_run_value: true }
);

assertEqual(
  'is_active=false 不命中',
  shouldFlagDryRunTask({
    type: 'STRATEGY_KILL_SWITCH_CHECK',
    is_active: false,
    parameters: { dry_run: true },
  }),
  { flagged: false }
);

assertEqual(
  '非白名单 type 不命中',
  shouldFlagDryRunTask({
    type: 'SOMETHING_ELSE',
    is_active: true,
    parameters: { dry_run: true },
  }),
  { flagged: false }
);

assertEqual(
  '字符串 "true" 不算 (避免误报 ops 显式异常值)',
  shouldFlagDryRunTask({
    type: 'STRATEGY_KILL_SWITCH_CHECK',
    is_active: true,
    parameters: { dry_run: 'true' },
  }),
  { flagged: false }
);

assertEqual(
  '数字 1 不算',
  shouldFlagDryRunTask({
    type: 'STRATEGY_KILL_SWITCH_CHECK',
    is_active: true,
    parameters: { dry_run: 1 },
  }),
  { flagged: false }
);

assertEqual(
  'parameters 缺失 不命中且不爆',
  shouldFlagDryRunTask({
    type: 'STRATEGY_KILL_SWITCH_CHECK',
    is_active: true,
    parameters: null,
  }),
  { flagged: false }
);

assertEqual(
  'parameters.dry_run=false 不命中',
  shouldFlagDryRunTask({
    type: 'STRATEGY_KILL_SWITCH_CHECK',
    is_active: true,
    parameters: { dry_run: false },
  }),
  { flagged: false }
);

assert(
  'SHOULD_BE_LIVE_TASK_TYPES 至少包含 STRATEGY_KILL_SWITCH_CHECK',
  SHOULD_BE_LIVE_TASK_TYPES.includes('STRATEGY_KILL_SWITCH_CHECK')
);

// ===========================================================================
// [2] buildOpsAlertText
// ===========================================================================
console.log('\n[2] buildOpsAlertText...');

assert(
  '0 命中 → "扫描 N 个 task, 0 命中"',
  buildOpsAlertText([], 7).includes('扫描 7 个 task, 0 命中')
);

function mkMatch(id: number, name: string): DryRunAuditMatch {
  return {
    task_id: id,
    task_name: name,
    task_type: 'STRATEGY_KILL_SWITCH_CHECK',
    cron_expression: '0 9 * * *',
    dry_run_value: true,
    is_active: true,
  };
}

{
  const t = buildOpsAlertText([mkMatch(1, 'task-A')], 3);
  assert('1 命中 包含 1/3', t.includes('1/3'));
  assert('1 命中 包含 task-A', t.includes('task-A'));
  assert('1 命中 不含 "+N more"', !/\+\d+ more/.test(t));
}

{
  const many = Array.from({ length: 8 }, (_, i) => mkMatch(i + 1, `task-${i + 1}`));
  const t = buildOpsAlertText(many, 10);
  assert('>5 命中 包含 "+3 more"', t.includes('+3 more'));
  assert('>5 命中 头 5 个出现', t.includes('task-1') && t.includes('task-5'));
  assert('>5 命中 第 6 个不出现 (被 +3 more 收编)', !t.includes('task-6'));
  // 必须出现总数标题
  assert('>5 命中 包含 8/10', t.includes('8/10'));
}

// ===========================================================================
// [3] buildOpsAlertChannelPlan
// ===========================================================================
console.log('\n[3] buildOpsAlertChannelPlan...');

assertEqual('dry_run=true 总是空', buildOpsAlertChannelPlan({ dry_run: true }, {}), []);
assertEqual(
  'dry_run=true 即使配置了 webhook 也空',
  buildOpsAlertChannelPlan({ dry_run: true }, { OPS_ALERT_FEISHU_WEBHOOK: 'https://x' }),
  []
);

assertEqual(
  '未传 + 无 webhook → 默认 risk_alert',
  buildOpsAlertChannelPlan({}, {}),
  ['risk_alert']
);
assertEqual(
  '未传 + 有 webhook → 自动追加 feishu_ops',
  buildOpsAlertChannelPlan({}, { OPS_ALERT_FEISHU_WEBHOOK: 'https://hook' }),
  ['risk_alert', 'feishu_ops']
);
assertEqual(
  '未传 + webhook 仅空白 → 不追加',
  buildOpsAlertChannelPlan({}, { OPS_ALERT_FEISHU_WEBHOOK: '   ' }),
  ['risk_alert']
);

assertEqual(
  '显式 channels=[] → 不跑任何 channel',
  buildOpsAlertChannelPlan({ channels: [] }, { OPS_ALERT_FEISHU_WEBHOOK: 'https://x' }),
  []
);
assertEqual(
  '显式 channels 含未知名 → 静默丢弃',
  buildOpsAlertChannelPlan(
    { channels: ['risk_alert', 'totally_unknown' as any] },
    { OPS_ALERT_FEISHU_WEBHOOK: 'https://x' }
  ),
  ['risk_alert']
);
assertEqual(
  '显式 channels 含重复 → 去重',
  buildOpsAlertChannelPlan(
    { channels: ['risk_alert', 'risk_alert', 'feishu_ops'] },
    {}
  ),
  ['risk_alert', 'feishu_ops']
);

assert(
  'DRY_RUN_AUDIT_CHANNELS 被 freeze',
  Object.isFrozen(DRY_RUN_AUDIT_CHANNELS)
);
assertEqual(
  'DRY_RUN_AUDIT_CHANNELS 形状',
  [...DRY_RUN_AUDIT_CHANNELS],
  ['risk_alert', 'feishu_ops']
);

// ===========================================================================
// [4] auditTaskParametersDryRun 集成（注入 fake DB / risk alert / feishu poster）
// ===========================================================================
console.log('\n[4] auditTaskParametersDryRun (integration with fakes)...');

// [4a] 0 matches → 不写任何 alert.
(async () => {
  resetFakeDb();
  fakeRows = [
    { id: 10, name: 't', type: 'STRATEGY_KILL_SWITCH_CHECK', cron_expression: '0 9 * * *', parameters: { dry_run: false }, is_active: true },
  ];
  let createCalled = 0;
  const r = await auditTaskParametersDryRun(
    {},
    {
      riskAlertCreator: async (_row: any) => {
        createCalled += 1;
        return { id: 999 };
      },
      env: {},
    }
  );
  assert('[4a] scanned_tasks=1', r.scanned_tasks === 1);
  assert('[4a] matches 空', r.matches.length === 0);
  assert('[4a] alerts 空', r.alerts.length === 0);
  assert('[4a] alert_written=false', r.alert_written === false);
  assert('[4a] riskAlertCreator 未被调用', createCalled === 0);
})();

// [4b] N matches + 默认 channel → 仅 risk_alert 调用, alert_id 透传.
(async () => {
  resetFakeDb();
  fakeRows = [
    { id: 11, name: 'kill-A', type: 'STRATEGY_KILL_SWITCH_CHECK', cron_expression: '0 9 * * *', parameters: { dry_run: true }, is_active: true },
    { id: 12, name: 'kill-B', type: 'STRATEGY_KILL_SWITCH_CHECK', cron_expression: '0 10 * * *', parameters: { dry_run: true }, is_active: true },
    { id: 13, name: 'unrelated', type: 'STRATEGY_KILL_SWITCH_CHECK', cron_expression: '0 11 * * *', parameters: {}, is_active: true },
  ];
  let createCalled = 0;
  let postCalled = 0;
  const r = await auditTaskParametersDryRun(
    {},
    {
      riskAlertCreator: async (_row: any) => {
        createCalled += 1;
        return { id: 555 };
      },
      feishuWebhookPoster: async () => {
        postCalled += 1;
        return { success: true };
      },
      env: {},
    }
  );
  assert('[4b] scanned_tasks=3', r.scanned_tasks === 3);
  assert('[4b] matches=2 (kill-A, kill-B)', r.matches.length === 2);
  assert('[4b] alerts 长度=1', r.alerts.length === 1);
  assert('[4b] alerts[0].channel=risk_alert', r.alerts[0].channel === 'risk_alert');
  assert('[4b] alerts[0].success=true', r.alerts[0].success === true);
  assert('[4b] alert_written=true', r.alert_written === true);
  assert('[4b] alert_id=555', r.alert_id === 555);
  assert('[4b] riskAlertCreator 调 1 次', createCalled === 1);
  assert('[4b] feishu poster 未调 (env 无 webhook)', postCalled === 0);
})();

// [4c] risk_alert creator throw → fail-OPEN.
(async () => {
  resetFakeDb();
  fakeRows = [
    { id: 21, name: 'kill', type: 'STRATEGY_KILL_SWITCH_CHECK', cron_expression: '* * * * *', parameters: { dry_run: true }, is_active: true },
  ];
  const r = await auditTaskParametersDryRun(
    {},
    {
      riskAlertCreator: async () => {
        throw new Error('DB down');
      },
      env: {},
    }
  );
  assert('[4c] scanned_tasks=1', r.scanned_tasks === 1);
  assert('[4c] matches=1', r.matches.length === 1);
  assert('[4c] alert_written=false', r.alert_written === false);
  assert('[4c] alerts[0].success=false', r.alerts[0].success === false);
  assert(
    '[4c] alerts[0].error 包含 DB down',
    String(r.alerts[0].error || '').includes('DB down')
  );
  assert('[4c] 整体不 throw + error 字段未污染', r.error === undefined);
})();

// [4d] env 有 webhook → feishu_ops 自动追加并被调用一次.
(async () => {
  resetFakeDb();
  fakeRows = [
    { id: 31, name: 'kill', type: 'STRATEGY_KILL_SWITCH_CHECK', cron_expression: '0 * * * *', parameters: { dry_run: true }, is_active: true },
  ];
  let postPayload: any = null;
  const r = await auditTaskParametersDryRun(
    {},
    {
      riskAlertCreator: async () => ({ id: 1 }),
      feishuWebhookPoster: async (_url: string, body: any) => {
        postPayload = body;
        return { success: true };
      },
      env: { OPS_ALERT_FEISHU_WEBHOOK: 'https://hook.example/abc' },
    }
  );
  assert('[4d] alerts 长度=2', r.alerts.length === 2);
  assert('[4d] alerts[1].channel=feishu_ops', r.alerts[1].channel === 'feishu_ops');
  assert('[4d] alerts[1].success=true', r.alerts[1].success === true);
  assert('[4d] postPayload msg_type=text', postPayload && postPayload.msg_type === 'text');
  assert(
    '[4d] postPayload.content.text 含 task name "kill"',
    postPayload && String(postPayload.content?.text || '').includes('kill')
  );
})();

// [4e] webhook poster fail → 整体不 throw + 记 success=false.
(async () => {
  resetFakeDb();
  fakeRows = [
    { id: 41, name: 'k', type: 'STRATEGY_KILL_SWITCH_CHECK', cron_expression: '0 9 * * *', parameters: { dry_run: true }, is_active: true },
  ];
  const r = await auditTaskParametersDryRun(
    {},
    {
      riskAlertCreator: async () => ({ id: 7 }),
      feishuWebhookPoster: async () => ({ success: false, message: 'timeout' }),
      env: { OPS_ALERT_FEISHU_WEBHOOK: 'https://h' },
    }
  );
  assert('[4e] risk_alert 成功 + feishu_ops 失败 互不影响', r.alert_written === true);
  assert('[4e] alerts[1].success=false', r.alerts[1].success === false);
  assert('[4e] alerts[1].message=timeout', r.alerts[1].message === 'timeout');
})();

// [4f] caller 传 channels=[] → 一个 channel 都不跑.
(async () => {
  resetFakeDb();
  fakeRows = [
    { id: 51, name: 'k', type: 'STRATEGY_KILL_SWITCH_CHECK', cron_expression: '0 9 * * *', parameters: { dry_run: true }, is_active: true },
  ];
  let createCalled = 0;
  const r = await auditTaskParametersDryRun(
    { channels: [] },
    {
      riskAlertCreator: async () => {
        createCalled += 1;
        return { id: 1 };
      },
      env: { OPS_ALERT_FEISHU_WEBHOOK: 'https://h' },
    }
  );
  assert('[4f] matches 仍返回', r.matches.length === 1);
  assert('[4f] alerts 空', r.alerts.length === 0);
  assert('[4f] alert_written=false', r.alert_written === false);
  assert('[4f] riskAlertCreator 没被调', createCalled === 0);
})();

// [4g] DB findAll throw → 返 error 字段, 不 throw.
(async () => {
  resetFakeDb();
  findAllThrow = new Error('connection refused');
  const r = await auditTaskParametersDryRun({}, { riskAlertCreator: async () => ({ id: 1 }) });
  assert('[4g] scanned_tasks=0', r.scanned_tasks === 0);
  assert('[4g] matches 空', r.matches.length === 0);
  assert('[4g] alerts 空', r.alerts.length === 0);
  assert(
    '[4g] error 字段含 connection refused',
    String(r.error || '').includes('connection refused')
  );
})();

// ===========================================================================
// Wait for async [4*] microtasks 再汇总
// ===========================================================================
setTimeout(() => {
  console.log('\n--------------------------------------------------------------');
  console.log(`Total: ${passed} ok, ${failed} failed`);
  console.log('--------------------------------------------------------------');
  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}, 200);
