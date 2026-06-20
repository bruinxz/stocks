/**
 * US-126 [PM-024] — ImprovementSuggestion apply route 单测.
 *
 * 不依赖 jest / DB / express. node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/api/improvement-suggestion-apply.test.ts
 *
 * ImprovementSuggestionController.ts 顶层 require ImprovementSuggestion model 拽起
 * sequelize, 单测进程 (无 PG) 不可直接 instantiate (与 [US-018 / US-065 / US-084 /
 * US-094] 同源 DB-less 不可测问题). 范式 = "mirror 复刻 + META-GUARD" — 镜像 controller
 * 主流程 (parseSuggestionId → owner findOne → canApplyStatus → save), 配 regex 守
 * controller + routes + index.ts 形态没有退化.
 *
 * 覆盖:
 *   T1 — parseSuggestionId 行为契约 (controller 依赖 helper)
 *   T2 — canApplyStatus 行为契约 (controller 依赖 helper)
 *   T3 — resolveActionType 行为契约 (controller 依赖 helper)
 *   T4 — controller 主流程镜像复刻 (6 路径: 200 / 401 / 400 / 404 / 409 / save throw 500)
 *   T5 — META-GUARD fs+regex 守 controller + routes + index.ts 源码形态
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  parseSuggestionId,
  canApplyStatus,
  resolveActionType,
} from '../../src/api/controllers/ImprovementSuggestionController';
import {
  IMPROVEMENT_STATUS,
  IMPROVEMENT_ACTION_TYPE,
} from '../../src/services/postmortem/ImprovementSuggestionService';

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

// ---------------------------------------------------------------------------
// T1 — parseSuggestionId
// ---------------------------------------------------------------------------
console.log('T1 — parseSuggestionId 行为契约');
{
  assert(parseSuggestionId('1') === 1, 'string "1" → 1');
  assert(parseSuggestionId('42') === 42, 'string "42" → 42');
  assert(parseSuggestionId(42) === 42, 'number 42 → 42');
  assert(parseSuggestionId('0') === null, 'string "0" → null (非正)');
  assert(parseSuggestionId('-1') === null, '负数 → null');
  assert(parseSuggestionId('abc') === null, '非数字字符 → null');
  assert(parseSuggestionId('') === null, '空字符串 → null');
  assert(parseSuggestionId(undefined) === null, 'undefined → null');
  assert(parseSuggestionId(null) === null, 'null → null');
  assert(parseSuggestionId('3.14') === 3, 'parseInt 截整 → 3 (与 controller 一致, 不强校验)');
  assert(parseSuggestionId('1abc') === 1, 'parseInt 容忍 → 1 (与 controller 一致)');
}

// ---------------------------------------------------------------------------
// T2 — canApplyStatus
// ---------------------------------------------------------------------------
console.log('T2 — canApplyStatus 行为契约');
{
  assert(canApplyStatus('open') === true, "'open' → true");
  assert(canApplyStatus(IMPROVEMENT_STATUS.OPEN) === true, 'IMPROVEMENT_STATUS.OPEN → true');
  assert(canApplyStatus('applied') === false, "'applied' → false (already)");
  assert(canApplyStatus('dismissed') === false, "'dismissed' → false");
  assert(canApplyStatus('expired') === false, "'expired' → false");
  assert(canApplyStatus('') === false, "'' → false");
  assert(canApplyStatus(null) === false, 'null → false');
  assert(canApplyStatus(undefined) === false, 'undefined → false');
  assert(canApplyStatus('OPEN' as any) === false, "大写 'OPEN' → false (status 是小写)");
}

// ---------------------------------------------------------------------------
// T3 — resolveActionType
// ---------------------------------------------------------------------------
console.log('T3 — resolveActionType 行为契约');
{
  assert(resolveActionType(null) === 'noop', 'null → noop');
  assert(resolveActionType(undefined) === 'noop', 'undefined → noop');
  assert(resolveActionType({}) === 'noop', '{} → noop (无 type)');
  assert(resolveActionType({ type: 'noop' }) === 'noop', "{type:'noop'} → noop");
  assert(
    resolveActionType({ type: 'tune_risk_param' }) === 'tune_risk_param',
    'tune_risk_param 透传'
  );
  assert(
    resolveActionType({ type: 'enable_kill_switch' }) === 'enable_kill_switch',
    'enable_kill_switch 透传'
  );
  assert(
    resolveActionType({ type: 'open_workspace_tab' }) === 'open_workspace_tab',
    'open_workspace_tab 透传'
  );
  assert(
    resolveActionType({ type: 'unknown_future_type' }) === 'noop',
    '未知 type → noop (forward-compat 降级)'
  );
  assert(resolveActionType({ type: 42 } as any) === 'noop', 'type 非 string → noop');
  assert(resolveActionType('not-an-object' as any) === 'noop', 'string action → noop');
  assert(
    resolveActionType({ type: 'noop', payload: { x: 1 } }) === 'noop',
    'payload 字段不影响 type 解析'
  );
}

// ---------------------------------------------------------------------------
// T4 — controller 主流程镜像复刻
// ---------------------------------------------------------------------------
console.log('T4 — controller 主流程镜像 (镜像 ImprovementSuggestionController.applyImprovementSuggestion)');
{
  interface FakeRow {
    id: number;
    user_id: number;
    status: string;
    applied_at: Date | null;
    dismissed_at: Date | null;
    action: Record<string, unknown>;
    save: () => Promise<void>;
  }
  interface FakeDeps {
    findOne: (where: { id: number; user_id: number }) => Promise<FakeRow | null>;
  }
  interface FakeReq {
    user?: { id: number };
    params: { id: string };
  }
  type Resp = { status: number; body: any };

  async function mirrorApply(req: FakeReq, deps: FakeDeps): Promise<Resp> {
    const user_id = req.user?.id;
    if (!user_id) return { status: 401, body: { success: false, message: '未登录' } };
    const id = parseSuggestionId(req.params.id);
    if (id === null) {
      return { status: 400, body: { success: false, message: 'id 非法' } };
    }
    let row: FakeRow | null;
    try {
      row = await deps.findOne({ id, user_id });
    } catch (err: any) {
      return {
        status: 500,
        body: { success: false, message: err?.message || 'apply ImprovementSuggestion 失败' },
      };
    }
    if (!row) {
      return { status: 404, body: { success: false, message: '建议不存在' } };
    }
    if (!canApplyStatus(row.status)) {
      return {
        status: 409,
        body: {
          success: false,
          message: `建议已 ${row.status}, 不可重复 apply`,
          data: {
            id: row.id,
            status: row.status,
            applied_at: row.applied_at,
            dismissed_at: row.dismissed_at,
          },
        },
      };
    }
    const actionType = resolveActionType(row.action);
    try {
      row.status = IMPROVEMENT_STATUS.APPLIED;
      row.applied_at = new Date();
      await row.save();
    } catch (err: any) {
      return {
        status: 500,
        body: { success: false, message: err?.message || 'apply ImprovementSuggestion 失败' },
      };
    }
    return {
      status: 200,
      body: {
        success: true,
        data: {
          id: row.id,
          status: row.status,
          applied_at: row.applied_at,
          action_type: actionType,
          action: row.action,
        },
      },
    };
  }

  function makeOpenRow(over: Partial<FakeRow> = {}): FakeRow {
    let saved = false;
    const base: FakeRow = {
      id: 99,
      user_id: 7,
      status: IMPROVEMENT_STATUS.OPEN,
      applied_at: null,
      dismissed_at: null,
      action: { type: IMPROVEMENT_ACTION_TYPE.NOOP },
      save: async () => {
        saved = true;
      },
    };
    Object.assign(base, over);
    (base as any).__saved = () => saved;
    return base;
  }

  // [a] happy — open → applied
  (async () => {
    const row = makeOpenRow();
    const r = await mirrorApply(
      { user: { id: 7 }, params: { id: '99' } },
      { findOne: async () => row }
    );
    assert(r.status === 200, '[a] happy → 200');
    assert(r.body?.success === true, '[a] happy → success=true');
    assert(r.body?.data?.id === 99, '[a] happy → data.id 透传');
    assert(r.body?.data?.status === 'applied', '[a] happy → status applied');
    assert(r.body?.data?.applied_at instanceof Date, '[a] happy → applied_at Date');
    assert(r.body?.data?.action_type === 'noop', '[a] happy → action_type noop');
    assert(row.status === 'applied', '[a] happy → row.status mutated → applied');
    assert(row.applied_at instanceof Date, '[a] happy → row.applied_at mutated');
    assert((row as any).__saved() === true, '[a] happy → row.save() called');
  })();

  // [b] 未登录 → 401
  (async () => {
    const r = await mirrorApply({ params: { id: '99' } }, { findOne: async () => null });
    assert(r.status === 401, '[b] 未登录 → 401');
    assert(r.body?.message === '未登录', '[b] 401 message');
  })();

  // [c] id 非法 → 400 (NaN / 负数 / 0)
  (async () => {
    const cases = ['abc', '-1', '0', ''];
    for (const idStr of cases) {
      const r = await mirrorApply(
        { user: { id: 7 }, params: { id: idStr } },
        { findOne: async () => null }
      );
      assert(r.status === 400, `[c] id=${JSON.stringify(idStr)} → 400`);
      assert(r.body?.message === 'id 非法', `[c] id=${JSON.stringify(idStr)} → message`);
    }
  })();

  // [d] not found → 404 (含跨用户 enumeration 防御)
  (async () => {
    let where: { id: number; user_id: number } | null = null;
    const r = await mirrorApply(
      { user: { id: 7 }, params: { id: '999' } },
      {
        findOne: async w => {
          where = w;
          return null;
        },
      }
    );
    assert(r.status === 404, '[d] not found → 404');
    assert(r.body?.message === '建议不存在', '[d] 404 message');
    assert(
      where !== null && (where as any).user_id === 7 && (where as any).id === 999,
      '[d] findOne where 必须含 user_id 防 enumeration'
    );
  })();

  // [e] 跨用户访问 — row.user_id=88, 查询 user_id=7 → findOne 自然返 null → 404
  // (with where {id, user_id} 单步查不到; 与 [d] 路径一致, 不区分 404/403 防 enumeration)
  (async () => {
    let queriedUserId = 0;
    const r = await mirrorApply(
      { user: { id: 7 }, params: { id: '99' } },
      {
        findOne: async w => {
          queriedUserId = w.user_id;
          // 模拟 DB: 跨用户找不到
          return null;
        },
      }
    );
    assert(r.status === 404, '[e] 跨用户 → 404 (与 not found 同路径, 防 enumeration)');
    assert(queriedUserId === 7, '[e] findOne 必须用 req.user.id 过滤');
  })();

  // [f] status='applied' → 409 idempotent guard
  (async () => {
    const appliedAt = new Date('2026-06-19T10:00:00Z');
    const row = makeOpenRow({ status: 'applied', applied_at: appliedAt });
    const r = await mirrorApply(
      { user: { id: 7 }, params: { id: '99' } },
      { findOne: async () => row }
    );
    assert(r.status === 409, '[f] applied → 409');
    assert(r.body?.success === false, '[f] 409 → success=false');
    assert(
      r.body?.message === '建议已 applied, 不可重复 apply',
      '[f] 409 message 含当前 status'
    );
    assert(r.body?.data?.status === 'applied', '[f] 409 data.status 透传');
    assert(r.body?.data?.applied_at === appliedAt, '[f] 409 data.applied_at 透传');
    assert((row as any).__saved() === false, '[f] applied 不应再调 save');
  })();

  // [g] status='dismissed' → 409
  (async () => {
    const dismissedAt = new Date('2026-06-18T15:00:00Z');
    const row = makeOpenRow({ status: 'dismissed', dismissed_at: dismissedAt });
    const r = await mirrorApply(
      { user: { id: 7 }, params: { id: '99' } },
      { findOne: async () => row }
    );
    assert(r.status === 409, '[g] dismissed → 409');
    assert(r.body?.data?.dismissed_at === dismissedAt, '[g] 409 data.dismissed_at 透传');
  })();

  // [h] status='expired' → 409
  (async () => {
    const row = makeOpenRow({ status: 'expired' });
    const r = await mirrorApply(
      { user: { id: 7 }, params: { id: '99' } },
      { findOne: async () => row }
    );
    assert(r.status === 409, '[h] expired → 409');
  })();

  // [i] save throw → 500
  (async () => {
    const row = makeOpenRow({
      save: async () => {
        throw new Error('DB connection lost');
      },
    });
    const r = await mirrorApply(
      { user: { id: 7 }, params: { id: '99' } },
      { findOne: async () => row }
    );
    assert(r.status === 500, '[i] save throw → 500');
    assert(r.body?.message === 'DB connection lost', '[i] 500 透传错误 message');
  })();

  // [j] findOne throw → 500
  (async () => {
    const r = await mirrorApply(
      { user: { id: 7 }, params: { id: '99' } },
      {
        findOne: async () => {
          throw new Error('sequelize pool timeout');
        },
      }
    );
    assert(r.status === 500, '[j] findOne throw → 500');
    assert(r.body?.message === 'sequelize pool timeout', '[j] 500 透传错误 message');
  })();

  // [k] action.type='tune_risk_param' → 响应 action_type 透传
  (async () => {
    const row = makeOpenRow({
      action: { type: 'tune_risk_param', payload: { max_drawdown: 0.05 } },
    });
    const r = await mirrorApply(
      { user: { id: 7 }, params: { id: '99' } },
      { findOne: async () => row }
    );
    assert(r.status === 200, '[k] tune_risk_param happy → 200');
    assert(r.body?.data?.action_type === 'tune_risk_param', '[k] action_type 透传');
    assert(
      r.body?.data?.action?.payload?.max_drawdown === 0.05,
      '[k] action 整体透传给前端按 type 决策'
    );
  })();

  // [l] action.type 未知 → action_type 降级 noop (forward-compat)
  (async () => {
    const row = makeOpenRow({ action: { type: 'future_unknown_type' } });
    const r = await mirrorApply(
      { user: { id: 7 }, params: { id: '99' } },
      { findOne: async () => row }
    );
    assert(r.status === 200, '[l] unknown action_type happy → 200');
    assert(r.body?.data?.action_type === 'noop', '[l] 未知 action.type → 响应降级 noop');
  })();
}

// ---------------------------------------------------------------------------
// T5 — META-GUARD fs+regex 守 controller + routes + index.ts 源码形态
// ---------------------------------------------------------------------------
console.log('T5 — META-GUARD: controller + routes + index.ts 源码守约');
{
  const ctrlSrc = fs.readFileSync(
    path.resolve(__dirname, '../../src/api/controllers/ImprovementSuggestionController.ts'),
    'utf-8'
  );
  assert(
    /async\s+applyImprovementSuggestion\s*\(/.test(ctrlSrc),
    'ImprovementSuggestionController.ts 必须 export async applyImprovementSuggestion'
  );
  assert(
    /ImprovementSuggestion\.findOne/.test(ctrlSrc),
    'controller 必须 ImprovementSuggestion.findOne (不能 inline SQL)'
  );
  // owner check via where {id, user_id} 单步 — 不可拆成 findByPk(id) + 再比 user_id
  // (会暴露 id 命中状态 / enumeration)
  assert(
    /findOne\s*\(\s*\{\s*where\s*:\s*\{[^}]*id\s*,\s*user_id\s*\}/.test(ctrlSrc),
    'controller findOne where 必须含 (id, user_id) 单步 (防 enumeration)'
  );
  assert(
    /this\.applyImprovementSuggestion\s*=\s*this\.applyImprovementSuggestion\.bind/.test(ctrlSrc),
    'controller constructor 必须 bind(this) applyImprovementSuggestion (express this 上下文)'
  );
  assert(
    /IMPROVEMENT_STATUS\.APPLIED/.test(ctrlSrc),
    'controller 必须用 IMPROVEMENT_STATUS.APPLIED 常量 (不能 inline 字符串 漂移)'
  );
  assert(
    /canApplyStatus|status\s*===\s*['"]open['"]|IMPROVEMENT_STATUS\.OPEN/.test(ctrlSrc),
    'controller 必须有 open 状态守约 (canApplyStatus / status==open)'
  );
  // 409 idempotent guard
  assert(/status\s*\(\s*409\s*\)/.test(ctrlSrc), 'controller 必须返 409 当非 open');
  // applied_at 写入 + save
  assert(
    /\.applied_at\s*=\s*now|\.applied_at\s*=\s*new Date/.test(ctrlSrc),
    'controller 必须写 row.applied_at = new Date()'
  );
  assert(/await\s+row\.save\(\)/.test(ctrlSrc), 'controller 必须 await row.save()');
  // export singleton
  assert(
    /export const improvementSuggestionController\s*=\s*new ImprovementSuggestionController\(\)/.test(
      ctrlSrc
    ),
    'controller 必须 export singleton improvementSuggestionController'
  );
  // export pure helpers
  assert(/export function parseSuggestionId/.test(ctrlSrc), 'export parseSuggestionId');
  assert(/export function canApplyStatus/.test(ctrlSrc), 'export canApplyStatus');
  assert(/export function resolveActionType/.test(ctrlSrc), 'export resolveActionType');

  const routesSrc = fs.readFileSync(
    path.resolve(__dirname, '../../src/api/routes/improvementSuggestion.routes.ts'),
    'utf-8'
  );
  assert(
    /router\.post\(\s*['"]\/:id\/apply['"]/.test(routesSrc),
    "routes 必须挂 POST '/:id/apply'"
  );
  assert(
    /improvementSuggestionController\.applyImprovementSuggestion/.test(routesSrc),
    'routes 必须绑 improvementSuggestionController.applyImprovementSuggestion'
  );
  assert(
    /authController\.authenticate/.test(routesSrc),
    'routes 必须挂 authController.authenticate (不可裸路由)'
  );

  // index.ts 必须挂 /api/me/improvement-suggestions
  const indexSrc = fs.readFileSync(path.resolve(__dirname, '../../src/index.ts'), 'utf-8');
  assert(
    /import\s+improvementSuggestionRoutes\s+from\s+['"]\.\/api\/routes\/improvementSuggestion\.routes['"]/.test(
      indexSrc
    ),
    'index.ts 必须 import improvementSuggestionRoutes'
  );
  assert(
    /app\.use\(\s*['"]\/api\/me\/improvement-suggestions['"]\s*,\s*improvementSuggestionRoutes\s*\)/.test(
      indexSrc
    ),
    "index.ts 必须 app.use('/api/me/improvement-suggestions', improvementSuggestionRoutes)"
  );
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
setImmediate(() => {
  console.log('');
  if (fail === 0) {
    console.log(`✓ improvement-suggestion-apply controller: ${pass}/${pass} OK`);
    process.exit(0);
  } else {
    console.log(`✗ improvement-suggestion-apply controller: ${pass} passed, ${fail} FAILED`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
});
