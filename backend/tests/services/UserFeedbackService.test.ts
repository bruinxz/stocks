/**
 * UserFeedbackService 单元测试 (Batch AL 2026-06-21)
 *
 *   cd backend && npx ts-node --transpile-only tests/services/UserFeedbackService.test.ts
 *
 * 覆盖:
 *   [1] classifyFeedbackHeuristic — bug / feature_request / question / praise / other 5 分支
 *   [2] buildSummary — 截断 + 拼接
 *   [3] runReviewSweep — pure 入口 (用 stub 模型替换 UserFeedback.findAll)
 *   [4] createForUser / resolveById 参数校验 (不连 DB; 仅 throw 路径)
 */

import {
  classifyFeedbackHeuristic,
  buildSummary,
  UserFeedbackService,
  FEEDBACK_CLASSIFICATION,
  FEEDBACK_STATUS,
} from '../../src/services/UserFeedbackService';

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

// ---------------------------------------------------------------------------
// [1] classifyFeedbackHeuristic
// ---------------------------------------------------------------------------
console.log('\n[1] classifyFeedbackHeuristic 5 分支...');

{
  const r = classifyFeedbackHeuristic({ title: '登录页面闪退', description: '点击登录就崩溃' });
  assert('[1.1] 含 "闪退/崩溃" → bug', r.ai_classification === FEEDBACK_CLASSIFICATION.BUG);
  assert('[1.1.1] bug priority=4', r.ai_priority === 4);
}
{
  const r = classifyFeedbackHeuristic({
    title: '希望增加新的策略选项',
    description: '建议加一个高股息策略',
  });
  assert(
    '[1.2] 含 "希望/建议" → feature_request',
    r.ai_classification === FEEDBACK_CLASSIFICATION.FEATURE_REQUEST
  );
  assert('[1.2.1] feature_request priority=3', r.ai_priority === 3);
}
{
  const r = classifyFeedbackHeuristic({
    title: '怎么开启 shadow mode?',
    description: '在哪里看?',
  });
  assert('[1.3] 疑问词 → question', r.ai_classification === FEEDBACK_CLASSIFICATION.QUESTION);
}
{
  const r = classifyFeedbackHeuristic({
    title: '系统真不错',
    description: '感谢开发团队 大家辛苦了',
  });
  assert('[1.4] 含 "不错/感谢" → praise', r.ai_classification === FEEDBACK_CLASSIFICATION.PRAISE);
  assert('[1.4.1] praise priority=1', r.ai_priority === 1);
}
{
  const r = classifyFeedbackHeuristic({ title: '随便说点', description: '今天天气好' });
  assert('[1.5] 无关键词 → other', r.ai_classification === FEEDBACK_CLASSIFICATION.OTHER);
}
{
  const r = classifyFeedbackHeuristic({ title: '末尾有问号吗？', description: '' });
  assert(
    '[1.6] 标题末尾 ？ → question',
    r.ai_classification === FEEDBACK_CLASSIFICATION.QUESTION
  );
}
{
  // bug 优先级高于 question (即使含问号)
  const r = classifyFeedbackHeuristic({ title: 'bug 怎么修？', description: 'crash 了' });
  assert('[1.7] bug > question 优先级', r.ai_classification === FEEDBACK_CLASSIFICATION.BUG);
}

// ---------------------------------------------------------------------------
// [2] buildSummary
// ---------------------------------------------------------------------------
console.log('\n[2] buildSummary...');
{
  const s = buildSummary({ title: 'abc', description: 'first sentence. second' });
  assert('[2.1] 含 title 和 描述首句', s.includes('abc') && s.includes('first sentence'));
}
{
  const longTitle = 'A'.repeat(120);
  const s = buildSummary({ title: longTitle, description: 'B'.repeat(300) });
  assert('[2.2] 最长 ≤ 200', s.length <= 200);
}
{
  const s = buildSummary({ title: '', description: '' });
  assert('[2.3] 全空 → 空串', s === '');
}

// ---------------------------------------------------------------------------
// [3] runReviewSweep — stub UserFeedback model
// ---------------------------------------------------------------------------
console.log('\n[3] runReviewSweep 用 stub findAll...');

async function test_sweep_updates_rows_with_stub() {
  const ufModule = require('../../src/services/UserFeedbackService');
  const modelModule = require('../../src/models/UserFeedback');

  const savedCalls: any[] = [];
  const fakeRows = [
    {
      id: 1,
      title: '点击登录就崩溃',
      description: '完全打不开',
      ai_classification: null as string | null,
      ai_priority: null as number | null,
      ai_summary: null as string | null,
      reviewed_at: null as Date | null,
      save: async function () {
        savedCalls.push({ id: this.id, ai_classification: this.ai_classification });
      },
    },
    {
      id: 2,
      title: '感谢团队',
      description: '系统不错',
      ai_classification: null as string | null,
      ai_priority: null as number | null,
      ai_summary: null as string | null,
      reviewed_at: null as Date | null,
      save: async function () {
        savedCalls.push({ id: this.id, ai_classification: this.ai_classification });
      },
    },
  ];
  const origFindAll = modelModule.UserFeedback.findAll;
  modelModule.UserFeedback.findAll = async () => fakeRows;
  try {
    const svc = new ufModule.UserFeedbackService();
    const res = await svc.runReviewSweep({ nowMs: Date.UTC(2026, 5, 21, 10) });
    assert('[3.1] scanned = 2', res.scanned === 2);
    assert('[3.2] updated = 2', res.updated === 2);
    assert('[3.3] failed = 0', res.failed === 0);
    assert('[3.4] row1 → bug', fakeRows[0].ai_classification === FEEDBACK_CLASSIFICATION.BUG);
    assert('[3.5] row2 → praise', fakeRows[1].ai_classification === FEEDBACK_CLASSIFICATION.PRAISE);
    assert('[3.6] save 调用 2 次', savedCalls.length === 2);
    assert(
      '[3.7] per_classification 含 bug=1 praise=1',
      res.per_classification[FEEDBACK_CLASSIFICATION.BUG] === 1 &&
        res.per_classification[FEEDBACK_CLASSIFICATION.PRAISE] === 1
    );
  } finally {
    modelModule.UserFeedback.findAll = origFindAll;
  }
}

async function test_sweep_failopen_on_findall_error() {
  const ufModule = require('../../src/services/UserFeedbackService');
  const modelModule = require('../../src/models/UserFeedback');
  const origFindAll = modelModule.UserFeedback.findAll;
  modelModule.UserFeedback.findAll = async () => {
    throw new Error('db boom');
  };
  try {
    const svc = new ufModule.UserFeedbackService();
    const res = await svc.runReviewSweep({});
    assert('[3.8] findAll throw 不抛, error 字段填', typeof res.error === 'string');
    assert('[3.9] scanned = 0', res.scanned === 0);
  } finally {
    modelModule.UserFeedback.findAll = origFindAll;
  }
}

async function test_sweep_failopen_on_save_error() {
  const ufModule = require('../../src/services/UserFeedbackService');
  const modelModule = require('../../src/models/UserFeedback');
  const fakeRow = {
    id: 10,
    title: 'bug',
    description: 'crash',
    ai_classification: null as string | null,
    ai_priority: null as number | null,
    ai_summary: null as string | null,
    reviewed_at: null as Date | null,
    save: async () => {
      throw new Error('save fail');
    },
  };
  const origFindAll = modelModule.UserFeedback.findAll;
  modelModule.UserFeedback.findAll = async () => [fakeRow];
  try {
    const svc = new ufModule.UserFeedbackService();
    const res = await svc.runReviewSweep({});
    assert('[3.10] scanned=1', res.scanned === 1);
    assert('[3.11] updated=0', res.updated === 0);
    assert('[3.12] failed=1', res.failed === 1);
  } finally {
    modelModule.UserFeedback.findAll = origFindAll;
  }
}

// ---------------------------------------------------------------------------
// [4] createForUser / resolveById 参数校验
// ---------------------------------------------------------------------------
console.log('\n[4] createForUser / resolveById 参数校验...');

async function test_create_invalid_user_id() {
  const svc = new UserFeedbackService();
  try {
    await svc.createForUser(0, { title: 'x', description: 'y' });
    assert('[4.1] user_id=0 should throw', false);
  } catch (err: any) {
    assert('[4.1] user_id=0 throws invalid_user_id', /invalid_user_id/.test(err.message));
  }
}
async function test_create_empty_title() {
  const svc = new UserFeedbackService();
  try {
    await svc.createForUser(1, { title: '', description: 'y' });
    assert('[4.2] empty title throws', false);
  } catch (err: any) {
    assert('[4.2] empty title throws', /invalid_title/.test(err.message));
  }
}
async function test_create_empty_description() {
  const svc = new UserFeedbackService();
  try {
    await svc.createForUser(1, { title: 'x', description: '' });
    assert('[4.3] empty description throws', false);
  } catch (err: any) {
    assert('[4.3] empty description throws', /invalid_description/.test(err.message));
  }
}
async function test_resolve_non_admin() {
  const svc = new UserFeedbackService();
  try {
    await svc.resolveById(1, 5, { resolution_note: 'fixed' }, { isAdmin: false });
    assert('[4.4] non-admin throws', false);
  } catch (err: any) {
    assert(
      '[4.4] non-admin throws forbidden_admin_only',
      /forbidden_admin_only/.test(err.message) && err.code === 'FORBIDDEN'
    );
  }
}
async function test_resolve_invalid_id() {
  const svc = new UserFeedbackService();
  try {
    await svc.resolveById(0, 1, { resolution_note: 'fixed' }, { isAdmin: true });
    assert('[4.5] id=0 throws', false);
  } catch (err: any) {
    assert('[4.5] id=0 throws invalid_id', /invalid_id/.test(err.message));
  }
}
async function test_resolve_empty_note() {
  const svc = new UserFeedbackService();
  try {
    await svc.resolveById(1, 1, { resolution_note: '' }, { isAdmin: true });
    assert('[4.6] empty note throws', false);
  } catch (err: any) {
    assert('[4.6] empty note throws', /resolution_note_required/.test(err.message));
  }
}

async function test_resolve_happy_with_stub() {
  const modelModule = require('../../src/models/UserFeedback');
  const stubRow: any = {
    id: 42,
    status: FEEDBACK_STATUS.PENDING,
    resolution_note: null,
    resolution_commit_hash: null,
    resolution_pr_number: null,
    resolved_at: null,
    save: async function () {
      this.saved = true;
    },
    toJSON: function () {
      const { save, toJSON, ...rest } = this;
      return rest;
    },
  };
  const origFindByPk = modelModule.UserFeedback.findByPk;
  modelModule.UserFeedback.findByPk = async (_id: number) => stubRow;
  try {
    const svc = new UserFeedbackService();
    const res = await svc.resolveById(
      42,
      9,
      {
        resolution_note: 'merged in PR 123',
        resolution_commit_hash: 'abc1234',
        resolution_pr_number: 123,
        status: 'resolved',
      },
      { isAdmin: true }
    );
    assert('[4.7.1] status=resolved', res.status === FEEDBACK_STATUS.RESOLVED);
    assert('[4.7.2] resolution_note 写入', res.resolution_note === 'merged in PR 123');
    assert('[4.7.3] commit hash 写入', res.resolution_commit_hash === 'abc1234');
    assert('[4.7.4] pr number 写入', res.resolution_pr_number === 123);
    assert('[4.7.5] resolved_at 非 null', !!res.resolved_at);
  } finally {
    modelModule.UserFeedback.findByPk = origFindByPk;
  }
}

async function test_resolve_not_found_with_stub() {
  const modelModule = require('../../src/models/UserFeedback');
  const origFindByPk = modelModule.UserFeedback.findByPk;
  modelModule.UserFeedback.findByPk = async () => null;
  try {
    const svc = new UserFeedbackService();
    try {
      await svc.resolveById(99, 1, { resolution_note: 'x' }, { isAdmin: true });
      assert('[4.8] not_found throws', false);
    } catch (err: any) {
      assert(
        '[4.8] not_found throws NOT_FOUND',
        err.code === 'NOT_FOUND' && /not_found/.test(err.message)
      );
    }
  } finally {
    modelModule.UserFeedback.findByPk = origFindByPk;
  }
}

async function test_resolve_conflict_with_stub() {
  const modelModule = require('../../src/models/UserFeedback');
  const stubRow: any = {
    id: 50,
    status: FEEDBACK_STATUS.RESOLVED,
    save: async () => {
      throw new Error('should not be called');
    },
    toJSON: () => ({}),
  };
  const origFindByPk = modelModule.UserFeedback.findByPk;
  modelModule.UserFeedback.findByPk = async () => stubRow;
  try {
    const svc = new UserFeedbackService();
    try {
      await svc.resolveById(50, 1, { resolution_note: 'x' }, { isAdmin: true });
      assert('[4.9] already_resolved throws', false);
    } catch (err: any) {
      assert(
        '[4.9] already_resolved throws CONFLICT',
        err.code === 'CONFLICT' && /already_resolved/.test(err.message)
      );
    }
  } finally {
    modelModule.UserFeedback.findByPk = origFindByPk;
  }
}

async function runAll() {
  await test_sweep_updates_rows_with_stub();
  await test_sweep_failopen_on_findall_error();
  await test_sweep_failopen_on_save_error();
  await test_create_invalid_user_id();
  await test_create_empty_title();
  await test_create_empty_description();
  await test_resolve_non_admin();
  await test_resolve_invalid_id();
  await test_resolve_empty_note();
  await test_resolve_happy_with_stub();
  await test_resolve_not_found_with_stub();
  await test_resolve_conflict_with_stub();

  console.log('');
  console.log(`✅ passed=${passed}`);
  console.log(`❌ failed=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runAll().catch(err => {
  console.error('TEST RUNNER CRASHED:', err);
  process.exit(1);
});
