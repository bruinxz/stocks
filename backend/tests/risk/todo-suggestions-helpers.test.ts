/**
 * US-068 [FE-029] — todoSuggestionsHelpers 纯函数单测.
 *
 * 不依赖 jest / DB / React 渲染. node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/risk/todo-suggestions-helpers.test.ts
 *
 * 7 个测试模块:
 *   [1] 常量 frozen + sanity (category/priority 顺序 / 颜色 / label 完整)
 *   [2] truncateText 边界 (恰好 N / N+1 / 超长 / 空 / null)
 *   [3] normalizeAlertLevelToPriority (HIGH/CRITICAL/MEDIUM/LOW/warning/unknown/null)
 *   [4] buildBlackSwanTodos (空/null/已读过滤/LOW 过滤/cap)
 *   [5] buildDeviationTodos (null/issues+chain 全拍平/dedup/level 映射)
 *   [6] buildImprovementTodos (null/can_apply→high/observe→low/next_actions→medium/empty next_actions)
 *   [7] buildTodoSuggestionsViewModel 主入口 (聚合 + 排序 + summary + has_critical)
 *
 * Settings TodoSuggestionsTab 已由 918be596 明确删除；这里不再断言旧 UI 接线。
 */

let pass = 0;
let fail = 0;
const failures: string[] = [];
function assert(cond: boolean, msg: string): void {
  if (cond) pass += 1;
  else {
    fail += 1;
    failures.push(msg);
    console.error(`✗ ${msg}`);
  }
}

// import 真 helper (pure function, 不带 React/antd 依赖)
import {
  buildBlackSwanTodos,
  buildDeviationTodos,
  buildImprovementTodos,
  buildTodoSuggestionsViewModel,
  normalizeAlertLevelToPriority,
  TODO_ACTION_HINT_MAX_CHARS,
  TODO_CATEGORY_COLOR,
  TODO_CATEGORY_LABEL,
  TODO_CATEGORY_ORDER,
  TODO_DETAIL_MAX_CHARS,
  TODO_PRIORITY_COLOR,
  TODO_PRIORITY_LABEL,
  TODO_PRIORITY_ORDER,
  TODO_TITLE_MAX_CHARS,
  truncateText,
  type AutomationHealthInput,
  type RiskAlertInput,
  type TodoCategory,
  type TodoPriority,
} from '../../../frontend/src/pages/workspace/todoSuggestionsHelpers';

// ---------------------------------------------------------------------------
// [1] 常量 frozen + sanity
// ---------------------------------------------------------------------------
console.log('[1] 常量 frozen + sanity');
{
  assert(Object.isFrozen(TODO_CATEGORY_ORDER), 'TODO_CATEGORY_ORDER 必须 frozen');
  assert(Object.isFrozen(TODO_PRIORITY_ORDER), 'TODO_PRIORITY_ORDER 必须 frozen');
  assert(Object.isFrozen(TODO_CATEGORY_COLOR), 'TODO_CATEGORY_COLOR 必须 frozen');
  assert(Object.isFrozen(TODO_CATEGORY_LABEL), 'TODO_CATEGORY_LABEL 必须 frozen');
  assert(Object.isFrozen(TODO_PRIORITY_COLOR), 'TODO_PRIORITY_COLOR 必须 frozen');
  assert(Object.isFrozen(TODO_PRIORITY_LABEL), 'TODO_PRIORITY_LABEL 必须 frozen');

  // 顺序 — black-swan 最先, improvement 最后 (业务约定: 黑天鹅最先看)
  assert(TODO_CATEGORY_ORDER[0] === 'black-swan', 'TODO_CATEGORY_ORDER[0] 必须是 black-swan');
  assert(TODO_CATEGORY_ORDER[2] === 'improvement', 'TODO_CATEGORY_ORDER[2] 必须是 improvement');
  assert(TODO_PRIORITY_ORDER[0] === 'critical', 'TODO_PRIORITY_ORDER[0] 必须是 critical');
  assert(TODO_PRIORITY_ORDER[3] === 'low', 'TODO_PRIORITY_ORDER[3] 必须是 low');

  // 3 个 category / 4 个 priority 全部映射
  for (const cat of TODO_CATEGORY_ORDER) {
    assert(typeof TODO_CATEGORY_COLOR[cat] === 'string', `TODO_CATEGORY_COLOR[${cat}] 必须有定义`);
    assert(typeof TODO_CATEGORY_LABEL[cat] === 'string', `TODO_CATEGORY_LABEL[${cat}] 必须有定义`);
  }
  for (const p of TODO_PRIORITY_ORDER) {
    assert(typeof TODO_PRIORITY_COLOR[p] === 'string', `TODO_PRIORITY_COLOR[${p}] 必须有定义`);
    assert(typeof TODO_PRIORITY_LABEL[p] === 'string', `TODO_PRIORITY_LABEL[${p}] 必须有定义`);
  }

  // cap 常量 sanity
  assert(TODO_TITLE_MAX_CHARS > 0 && TODO_TITLE_MAX_CHARS <= 200, 'TODO_TITLE_MAX_CHARS 合理范围');
  assert(TODO_DETAIL_MAX_CHARS >= TODO_TITLE_MAX_CHARS, 'detail cap >= title cap (业务约定)');
  assert(TODO_ACTION_HINT_MAX_CHARS > 0, 'action hint cap > 0');

  // 业务: black-swan 必须红色 (最严重视觉)
  assert(TODO_CATEGORY_COLOR['black-swan'] === 'red', 'black-swan 必须红色');
}

// ---------------------------------------------------------------------------
// [2] truncateText 边界
// ---------------------------------------------------------------------------
console.log('[2] truncateText 边界');
{
  assert(truncateText(null, 10) === '', 'null → 空字符串');
  assert(truncateText(undefined, 10) === '', 'undefined → 空字符串');
  assert(truncateText('', 10) === '', '空 → 空');
  assert(truncateText('短', 10) === '短', '短于 cap 不截');
  // 恰好 cap (US-043 lesson: 3 case 必含 — 恰好 / cap+1 / 远超)
  const exactlyTen = '0123456789';
  assert(truncateText(exactlyTen, 10) === exactlyTen, '长度==cap 不截');
  // cap+1 截到 cap
  const elevenChar = '0123456789a';
  const r1 = truncateText(elevenChar, 10);
  assert(r1.length === 10, 'cap+1 截到 cap 总长');
  assert(r1.endsWith('…'), '截断必加 …');
  // 远超
  const longText = '一'.repeat(200);
  const r2 = truncateText(longText, 30);
  assert(r2.length === 30, '远超截到 cap');
  assert(r2.endsWith('…'), '远超必加 …');
}

// ---------------------------------------------------------------------------
// [3] normalizeAlertLevelToPriority
// ---------------------------------------------------------------------------
console.log('[3] normalizeAlertLevelToPriority');
{
  assert(normalizeAlertLevelToPriority('CRITICAL') === 'critical', 'CRITICAL → critical');
  assert(normalizeAlertLevelToPriority('critical') === 'critical', 'critical → critical');
  assert(normalizeAlertLevelToPriority('HIGH') === 'high', 'HIGH → high');
  assert(normalizeAlertLevelToPriority('high') === 'high', 'high → high');
  assert(normalizeAlertLevelToPriority('MEDIUM') === 'medium', 'MEDIUM → medium');
  assert(normalizeAlertLevelToPriority('warning') === 'medium', 'warning → medium');
  assert(normalizeAlertLevelToPriority('LOW') === 'low', 'LOW → low');
  assert(normalizeAlertLevelToPriority('info') === 'low', 'info → low');
  // 未识别 fallback medium (不是 critical)
  assert(normalizeAlertLevelToPriority('weird-string') === 'medium', '未识别 fallback medium');
  assert(normalizeAlertLevelToPriority(null) === 'medium', 'null fallback medium');
  assert(normalizeAlertLevelToPriority(undefined) === 'medium', 'undefined fallback medium');
  assert(normalizeAlertLevelToPriority('') === 'medium', '空 fallback medium');
  assert(normalizeAlertLevelToPriority(123 as any) === 'medium', '非 string fallback medium');
}

// ---------------------------------------------------------------------------
// [4] buildBlackSwanTodos
// ---------------------------------------------------------------------------
console.log('[4] buildBlackSwanTodos');
{
  assert(buildBlackSwanTodos(null).length === 0, 'null → []');
  assert(buildBlackSwanTodos(undefined).length === 0, 'undefined → []');
  assert(buildBlackSwanTodos([] as RiskAlertInput[]).length === 0, '[] → []');
  assert(buildBlackSwanTodos('not array' as any).length === 0, '非数组 → []');

  // 已读过滤
  const readAlerts: RiskAlertInput[] = [
    { id: 1, level: 'HIGH', message: '高危', is_read: true },
    { id: 2, level: 'HIGH', message: '高危2', is_read: false },
  ];
  const readResult = buildBlackSwanTodos(readAlerts);
  assert(readResult.length === 1, '已读 alert 不进待办');
  assert(readResult[0].source === 'RiskAlert#2', '未读 alert 透传 id');

  // LOW 不进待办
  const mixedLevels: RiskAlertInput[] = [
    { id: 1, level: 'CRITICAL', message: 'c' },
    { id: 2, level: 'HIGH', message: 'h' },
    { id: 3, level: 'MEDIUM', message: 'm' },
    { id: 4, level: 'LOW', message: 'l' }, // 应被过滤
  ];
  const mixed = buildBlackSwanTodos(mixedLevels);
  assert(mixed.length === 3, 'LOW 过滤掉, 剩 3 条 (critical/high/medium)');
  assert(mixed.every(t => t.category === 'black-swan'), '全部 category = black-swan');

  // 优先级 mapping 正确
  const c = mixed.find(t => t.source === 'RiskAlert#1');
  assert(c?.priority === 'critical', 'CRITICAL → critical');
  const h = mixed.find(t => t.source === 'RiskAlert#2');
  assert(h?.priority === 'high', 'HIGH → high');
  const m = mixed.find(t => t.source === 'RiskAlert#3');
  assert(m?.priority === 'medium', 'MEDIUM → medium');

  // title cap (业务约定 ≤30 字)
  const longAlert: RiskAlertInput = {
    id: 1,
    level: 'HIGH',
    rule_id: 'BlackSwanWatchdog',
    message: '一'.repeat(200),
  };
  const long = buildBlackSwanTodos([longAlert]);
  assert(long[0].title.length <= TODO_TITLE_MAX_CHARS, 'title 必须 ≤ cap');
  assert(long[0].detail.length <= TODO_DETAIL_MAX_CHARS, 'detail 必须 ≤ cap');
  assert(long[0].action_hint.length <= TODO_ACTION_HINT_MAX_CHARS, 'action_hint 必须 ≤ cap');

  // 非对象 entry 跳过
  const bad = buildBlackSwanTodos([null as any, 'string' as any, { id: 1, level: 'HIGH', message: 'ok' }]);
  assert(bad.length === 1, '非对象/null entry 跳过');

  // occurred_at 透传
  const withTime: RiskAlertInput = {
    id: 1,
    level: 'HIGH',
    message: 'x',
    triggered_at: '2026-06-20T08:00:00Z',
  };
  const wt = buildBlackSwanTodos([withTime]);
  assert(wt[0].occurred_at === '2026-06-20T08:00:00Z', 'triggered_at 透传');

  const withCreated: RiskAlertInput = {
    id: 2,
    level: 'HIGH',
    message: 'x',
    created_at: '2026-06-20T09:00:00Z',
  };
  const wc = buildBlackSwanTodos([withCreated]);
  assert(wc[0].occurred_at === '2026-06-20T09:00:00Z', 'created_at fallback');
}

// ---------------------------------------------------------------------------
// [5] buildDeviationTodos
// ---------------------------------------------------------------------------
console.log('[5] buildDeviationTodos');
{
  assert(buildDeviationTodos(null).length === 0, 'null → []');
  assert(buildDeviationTodos(undefined).length === 0, 'undefined → []');
  assert(buildDeviationTodos({} as AutomationHealthInput).length === 0, '空对象 → []');

  // 顶层 issues + chain.issues 全拍平
  const health: AutomationHealthInput = {
    issues: [
      { level: 'critical', message: '顶层严重', code: 'invalid_cron', task_name: 'task-a' },
      { level: 'warning', message: '顶层警告', code: 'stale_task', task_name: 'task-b' },
    ],
    chains: [
      {
        title: 'trading-loop',
        issues: [
          { level: 'critical', message: '链路问题', code: 'last_run_failed', task_name: 'task-c' },
        ],
      },
    ],
  };
  const ds = buildDeviationTodos(health);
  assert(ds.length === 3, '顶层 2 + chain 1 = 3 条');
  assert(ds.every(t => t.category === 'deviation'), '全部 category=deviation');

  // level → priority 映射
  const cr = ds.find(t => t.source === 'automation-health:invalid_cron');
  assert(cr?.priority === 'critical', 'critical → critical');
  const wr = ds.find(t => t.source === 'automation-health:stale_task');
  assert(wr?.priority === 'high', 'warning → high (业务: warning 在 ops 视角是高优)');
  const ch = ds.find(t => t.source === 'chain:trading-loop');
  assert(ch?.priority === 'critical', '链路 critical');
  assert(ch?.title.includes('trading-loop'), '链路待办 title 必含 chain title');

  // dedup (同 code+task_name 不重复)
  const dupHealth: AutomationHealthInput = {
    issues: [
      { level: 'critical', message: 'a', code: 'foo', task_name: 'task-x' },
      { level: 'critical', message: 'a-dup', code: 'foo', task_name: 'task-x' },
    ],
  };
  const dedup = buildDeviationTodos(dupHealth);
  assert(dedup.length === 1, '同 code+task_name dedup');

  // 非对象 issue 跳过
  const badHealth: AutomationHealthInput = {
    issues: [null as any, 'bad' as any, { level: 'critical', message: 'ok', code: 'c1' }],
  };
  assert(buildDeviationTodos(badHealth).length === 1, '非对象 issue 跳过');

  // chain 非对象 / 无 issues 跳过
  const skipChain: AutomationHealthInput = {
    chains: [null as any, { title: 'no-issues' } as any, { issues: 'not array' as any }],
  };
  assert(buildDeviationTodos(skipChain).length === 0, 'chain 异常全跳过');
}

// ---------------------------------------------------------------------------
// [6] buildImprovementTodos
// ---------------------------------------------------------------------------
console.log('[6] buildImprovementTodos');
{
  assert(buildImprovementTodos(null).length === 0, 'null → []');
  assert(buildImprovementTodos({} as AutomationHealthInput).length === 0, '空对象 → []');

  // can_apply=true → high priority "可应用"
  const canApply: AutomationHealthInput = {
    risk_limit_suggestion: {
      action: 'apply',
      reason: '稳定 5 次, 可应用',
      stability: { can_apply: true },
      generated_at: '2026-06-20T01:00:00Z',
    },
  };
  const ca = buildImprovementTodos(canApply);
  assert(ca.length === 1, 'can_apply → 1 条');
  assert(ca[0].priority === 'high', 'can_apply → high');
  assert(ca[0].source === 'risk_limit_suggestion', 'source=risk_limit_suggestion');
  assert(ca[0].occurred_at === '2026-06-20T01:00:00Z', 'generated_at 透传');

  // observe → low priority
  const observe: AutomationHealthInput = {
    risk_limit_suggestion: {
      action: 'observe',
      reason: '样本不足',
      stability: { can_apply: false },
    },
  };
  const ob = buildImprovementTodos(observe);
  assert(ob.length === 1, 'observe → 1 条');
  assert(ob[0].priority === 'low', 'observe → low');

  // pause / unknown action 静默跳过
  const pause: AutomationHealthInput = {
    risk_limit_suggestion: { action: 'pause', reason: 'paused', stability: { can_apply: false } },
  };
  assert(buildImprovementTodos(pause).length === 0, 'pause 静默跳过');

  const unknown: AutomationHealthInput = {
    risk_limit_suggestion: { action: 'weird', stability: { can_apply: false } },
  };
  assert(buildImprovementTodos(unknown).length === 0, 'unknown action 静默跳过');

  // next_actions → medium
  const naHealth: AutomationHealthInput = {
    next_actions: ['先修复 schema', '检查队列积压', ''],
  };
  const na = buildImprovementTodos(naHealth);
  assert(na.length === 2, 'next_actions 非空 2 条 (空字符串跳过)');
  assert(na.every(t => t.priority === 'medium'), 'next_actions → medium');
  assert(na[0].source === 'next_actions[0]', '编号透传');

  // next_actions 非数组安全
  const badNa: AutomationHealthInput = { next_actions: 'not array' as any };
  assert(buildImprovementTodos(badNa).length === 0, 'next_actions 非数组安全');

  // 组合: can_apply + 2 个 next_actions = 3 条
  const combo: AutomationHealthInput = {
    risk_limit_suggestion: { action: 'apply', stability: { can_apply: true } },
    next_actions: ['a', 'b'],
  };
  assert(buildImprovementTodos(combo).length === 3, 'can_apply + 2 next_actions = 3 条');
}

// ---------------------------------------------------------------------------
// [7] buildTodoSuggestionsViewModel 主入口
// ---------------------------------------------------------------------------
console.log('[7] buildTodoSuggestionsViewModel');
{
  // null/undefined safe
  const vEmpty = buildTodoSuggestionsViewModel(null);
  assert(vEmpty.total === 0, 'null → total 0');
  assert(vEmpty.by_category.black_swan === 0, 'null → black_swan 0');
  assert(vEmpty.by_priority.critical === 0, 'null → critical 0');
  assert(vEmpty.has_critical === false, 'null → has_critical false');

  // 异常输入兜底
  assert(buildTodoSuggestionsViewModel({ alerts: null, health: null }).total === 0, '都 null → 0');

  // 聚合 + 排序
  const input = {
    alerts: [
      { id: 1, level: 'CRITICAL', message: 'cccc' },
      { id: 2, level: 'HIGH', message: 'hhhh' },
    ] as RiskAlertInput[],
    health: {
      issues: [
        { level: 'critical', message: 'crit-dev', code: 'invalid_cron' },
        { level: 'warning', message: 'warn-dev', code: 'stale_task' },
      ],
      risk_limit_suggestion: {
        action: 'apply',
        stability: { can_apply: true },
      },
      next_actions: ['n-act-1'],
    } as AutomationHealthInput,
  };
  const vm = buildTodoSuggestionsViewModel(input);

  // by_category 计数
  assert(vm.by_category.black_swan === 2, 'black_swan=2');
  assert(vm.by_category.deviation === 2, 'deviation=2');
  assert(vm.by_category.improvement === 2, 'improvement=2 (risk_limit + 1 next_action)');
  assert(vm.total === 6, 'total=6');

  // by_priority 计数
  assert(vm.by_priority.critical === 2, 'critical=2 (black-swan CRITICAL + deviation critical)');
  assert(vm.by_priority.high === 3, 'high=3 (black-swan HIGH + deviation warning + improvement can_apply)');
  assert(vm.by_priority.medium === 1, 'medium=1 (next_actions)');
  assert(vm.by_priority.low === 0, 'low=0');
  assert(vm.has_critical === true, 'has_critical=true');

  // 排序: 第一条必须是 critical, 且同 critical 内 black-swan 在 deviation 前
  assert(vm.items[0].priority === 'critical', 'items[0] priority=critical');
  assert(vm.items[0].category === 'black-swan', 'items[0] category=black-swan (同 priority 内最先)');
  // 最后一条必须是 medium (next_actions)
  assert(vm.items[vm.items.length - 1].priority === 'medium', 'items[末] priority=medium');

  // 排序稳定性: tie-break 字母序
  const tiedInput = {
    alerts: [
      { id: 'B', level: 'HIGH', message: 'B-msg' },
      { id: 'A', level: 'HIGH', message: 'A-msg' },
    ] as RiskAlertInput[],
    health: null as AutomationHealthInput | null,
  };
  const tied = buildTodoSuggestionsViewModel(tiedInput);
  assert(tied.items.length === 2, 'tied 2 条');
  // 都没 occurred_at, 字母序 id "black-swan:A-..." < "black-swan:B-..."
  assert(tied.items[0].id.includes('A'), 'tie-break id 字母序 (A 在前)');

  // occurred_at 倒序
  const timedInput = {
    alerts: [
      { id: 1, level: 'HIGH', message: 'old', triggered_at: '2026-06-20T01:00:00Z' },
      { id: 2, level: 'HIGH', message: 'new', triggered_at: '2026-06-20T05:00:00Z' },
    ] as RiskAlertInput[],
    health: null,
  };
  const timed = buildTodoSuggestionsViewModel(timedInput);
  assert(timed.items[0].occurred_at === '2026-06-20T05:00:00Z', '同 priority 内 occurred_at 倒序 (新在前)');

  // has_critical false 当无 critical
  const noCrit = buildTodoSuggestionsViewModel({
    alerts: [{ id: 1, level: 'HIGH', message: 'x' }] as RiskAlertInput[],
    health: null,
  });
  assert(noCrit.has_critical === false, '无 critical → has_critical=false');
}
// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
console.log('');
if (fail === 0) {
  console.log(`✓ todo-suggestions-helpers: ${pass}/${pass} OK`);
  process.exit(0);
} else {
  console.log(`✗ todo-suggestions-helpers: ${pass} passed, ${fail} FAILED`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
