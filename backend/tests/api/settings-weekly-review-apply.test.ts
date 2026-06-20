/**
 * US-143 [PM-015] — POST /api/settings/weekly-review/apply 单测.
 *
 * 不依赖 jest / DB / express. node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/api/settings-weekly-review-apply.test.ts
 *
 * SettingsController 顶层 require sequelize-typescript model 链路 (User), 单测
 * 进程 (无 PG) 不可直接 instantiate controller. 范式 = "mirror 复刻 + META-GUARD"
 * (与 [[ImprovementSuggestionController]] PM-024 同款):
 *   - 镜像主流程: parseApplyRecommendationBody → service.applyRecommendation (fake)
 *     → 200 / 400 / 404 / 409 / 500 路径全覆盖
 *   - regex 守 controller + routes + service 源文件形态没有退化
 *
 * 覆盖:
 *   T1 — parseApplyRecommendationBody 行为契约 (controller helper)
 *   T2 — normalizeAppliedRecommendation 行为契约 (service helper)
 *   T3 — readWeeklyReviewAppliedFromRiskConfig 行为契约
 *   T4 — findDuplicateApplied 行为契约
 *   T5 — appendAppliedRecommendation LRU cap 行为契约
 *   T6 — controller 主流程镜像 (200 happy / 400 / 401 / 404 / 409 / 500)
 *   T7 — META-GUARD fs+regex 守 controller + routes + service + index.ts 源码形态
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseApplyRecommendationBody } from '../../src/api/controllers/SettingsController';
import {
  normalizeAppliedRecommendation,
  readWeeklyReviewAppliedFromRiskConfig,
  findDuplicateApplied,
  appendAppliedRecommendation,
  APPLIED_RECOMMENDATION_CAP,
  APPLIED_RECOMMENDATION_TEXT_MAX,
  APPLIED_RECOMMENDATION_DEFAULT_SOURCE,
  AppliedRecommendation,
} from '../../src/services/WeeklyReviewReportService';

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
// T1 — parseApplyRecommendationBody
// ---------------------------------------------------------------------------
console.log('T1 — parseApplyRecommendationBody 行为契约');
{
  // happy
  const ok = parseApplyRecommendationBody({
    week_id: '2026-W25',
    recommendation_index: 0,
    text: 'foo',
    source: 'frontend',
  });
  assert(ok !== null, 'happy → non-null');
  assert(ok!.week_id === '2026-W25', 'week_id 透传');
  assert(ok!.recommendation_index === 0, 'index 透传');
  assert(ok!.text === 'foo', 'text 透传');
  assert(ok!.source === 'frontend', 'source 透传');

  // 缺 body
  assert(parseApplyRecommendationBody(null) === null, 'null body → null');
  assert(parseApplyRecommendationBody(undefined) === null, 'undefined → null');
  assert(parseApplyRecommendationBody('string') === null, 'string body → null');
  assert(parseApplyRecommendationBody({}) === null, '空 obj → null');

  // week_id 缺 / 非法
  assert(
    parseApplyRecommendationBody({ recommendation_index: 0 }) === null,
    '缺 week_id → null'
  );
  assert(
    parseApplyRecommendationBody({ week_id: '', recommendation_index: 0 }) === null,
    '空 week_id → null'
  );
  assert(
    parseApplyRecommendationBody({ week_id: '   ', recommendation_index: 0 }) === null,
    '纯空格 week_id → null'
  );
  assert(
    parseApplyRecommendationBody({ week_id: 'x'.repeat(33), recommendation_index: 0 }) === null,
    'week_id 过长 → null'
  );
  assert(
    parseApplyRecommendationBody({ week_id: 123 as any, recommendation_index: 0 }) === null,
    'week_id 非 string → null'
  );

  // index 缺 / 非法
  assert(
    parseApplyRecommendationBody({ week_id: 'w' }) === null,
    '缺 index → null'
  );
  assert(
    parseApplyRecommendationBody({ week_id: 'w', recommendation_index: -1 }) === null,
    '负 index → null'
  );
  assert(
    parseApplyRecommendationBody({ week_id: 'w', recommendation_index: 'foo' }) === null,
    '非数字 index → null'
  );
  assert(
    parseApplyRecommendationBody({ week_id: 'w', recommendation_index: NaN }) === null,
    'NaN index → null'
  );
  assert(
    parseApplyRecommendationBody({ week_id: 'w', recommendation_index: 1000 }) === null,
    '> 999 index → null'
  );

  // 浮点截整
  const flt = parseApplyRecommendationBody({ week_id: 'w', recommendation_index: 2.7 });
  assert(flt !== null && flt!.recommendation_index === 2, '浮点截整 → 2');

  // text/source 可选
  const noOptional = parseApplyRecommendationBody({ week_id: 'w', recommendation_index: 0 });
  assert(noOptional !== null, '无 text/source 仍有效');
  assert(noOptional!.text === undefined, 'text undefined 时不存在');

  // week_id trim
  const trimmed = parseApplyRecommendationBody({
    week_id: '  2026-W25  ',
    recommendation_index: 1,
  });
  assert(trimmed !== null && trimmed!.week_id === '2026-W25', 'week_id 自动 trim');
}

// ---------------------------------------------------------------------------
// T2 — normalizeAppliedRecommendation
// ---------------------------------------------------------------------------
console.log('T2 — normalizeAppliedRecommendation 行为契约');
{
  const t = '2026-06-21T00:00:00Z';

  const ok = normalizeAppliedRecommendation({
    week_id: '2026-W25',
    recommendation_index: 0,
    text: 'foo',
    source: 'manual',
    applied_at: t,
  });
  assert(ok !== null, 'happy → non-null');
  assert(ok!.text === 'foo', 'text 透传');
  assert(ok!.source === 'manual', 'source 透传');
  assert(ok!.applied_at === t, 'applied_at 透传');

  // 非法 input
  assert(normalizeAppliedRecommendation(null as any) === null, 'null → null');
  assert(normalizeAppliedRecommendation({ week_id: '' } as any) === null, '空 week_id → null');
  assert(
    normalizeAppliedRecommendation({ week_id: 'w', recommendation_index: -1 } as any) === null,
    '负 index → null'
  );
  assert(
    normalizeAppliedRecommendation({ week_id: 'w', recommendation_index: 1000 } as any) === null,
    '> 999 index → null'
  );

  // text 截断
  const long = 'x'.repeat(APPLIED_RECOMMENDATION_TEXT_MAX + 100);
  const truncated = normalizeAppliedRecommendation({
    week_id: 'w',
    recommendation_index: 0,
    text: long,
    applied_at: t,
  });
  assert(truncated !== null, 'long text 仍 valid');
  assert(truncated!.text.length === APPLIED_RECOMMENDATION_TEXT_MAX, 'text 截到 MAX');

  // source 默认
  const noSource = normalizeAppliedRecommendation({
    week_id: 'w',
    recommendation_index: 0,
    applied_at: t,
  });
  assert(noSource !== null, 'no source ok');
  assert(noSource!.source === APPLIED_RECOMMENDATION_DEFAULT_SOURCE, 'source 默认 = manual');

  // source 空串 → default
  const emptySource = normalizeAppliedRecommendation({
    week_id: 'w',
    recommendation_index: 0,
    source: '   ',
    applied_at: t,
  });
  assert(emptySource!.source === APPLIED_RECOMMENDATION_DEFAULT_SOURCE, '空 source → 默认');

  // applied_at 缺 → 当前 now (ISO string)
  const nowed = normalizeAppliedRecommendation({
    week_id: 'w',
    recommendation_index: 0,
  });
  assert(nowed !== null, 'no applied_at ok');
  assert(
    typeof nowed!.applied_at === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(nowed!.applied_at),
    'applied_at 自动 fill ISO'
  );

  // text 缺 → ''
  const notext = normalizeAppliedRecommendation({
    week_id: 'w',
    recommendation_index: 0,
    applied_at: t,
  });
  assert(notext!.text === '', 'text 缺 → 空串');

  // source 截断到 32
  const longSource = normalizeAppliedRecommendation({
    week_id: 'w',
    recommendation_index: 0,
    source: 'x'.repeat(100),
    applied_at: t,
  });
  assert(longSource!.source.length === 32, 'source 截到 32');
}

// ---------------------------------------------------------------------------
// T3 — readWeeklyReviewAppliedFromRiskConfig
// ---------------------------------------------------------------------------
console.log('T3 — readWeeklyReviewAppliedFromRiskConfig 行为契约');
{
  assert(readWeeklyReviewAppliedFromRiskConfig(null).length === 0, 'null → []');
  assert(readWeeklyReviewAppliedFromRiskConfig(undefined).length === 0, 'undefined → []');
  assert(readWeeklyReviewAppliedFromRiskConfig({}).length === 0, '无字段 → []');
  assert(
    readWeeklyReviewAppliedFromRiskConfig({ weekly_review_applied: 'foo' }).length === 0,
    '非数组 → []'
  );
  // 含 1 valid + 1 invalid (idx=-1)
  const mixed = readWeeklyReviewAppliedFromRiskConfig({
    weekly_review_applied: [
      { week_id: 'w', recommendation_index: 0, applied_at: '2026-01-01T00:00:00Z' },
      { week_id: 'w', recommendation_index: -1 }, // skip
      { week_id: 'w2', recommendation_index: 1, applied_at: '2026-02-01T00:00:00Z' },
    ],
  });
  assert(mixed.length === 2, '非法项被静默 drop, 保留 valid');
  assert(mixed[0].week_id === 'w' && mixed[1].week_id === 'w2', '顺序保留');
}

// ---------------------------------------------------------------------------
// T4 — findDuplicateApplied
// ---------------------------------------------------------------------------
console.log('T4 — findDuplicateApplied 行为契约');
{
  const existing: AppliedRecommendation[] = [
    {
      week_id: 'w1',
      recommendation_index: 0,
      text: 'a',
      applied_at: '2026-01-01T00:00:00Z',
      source: 'manual',
    },
    {
      week_id: 'w1',
      recommendation_index: 1,
      text: 'b',
      applied_at: '2026-01-02T00:00:00Z',
      source: 'manual',
    },
  ];
  const cand: AppliedRecommendation = {
    week_id: 'w1',
    recommendation_index: 1,
    text: 'new',
    applied_at: '2026-06-01T00:00:00Z',
    source: 'manual',
  };
  const dup = findDuplicateApplied(existing, cand);
  assert(dup !== null && dup!.text === 'b', '同 (week, index) 命中, 返 existing 项');

  const fresh: AppliedRecommendation = {
    week_id: 'w2',
    recommendation_index: 1,
    text: 'x',
    applied_at: '2026-06-01T00:00:00Z',
    source: 'manual',
  };
  assert(findDuplicateApplied(existing, fresh) === null, '不同 week → null');

  const sameWeekDiffIdx: AppliedRecommendation = {
    week_id: 'w1',
    recommendation_index: 2,
    text: 'x',
    applied_at: '2026-06-01T00:00:00Z',
    source: 'manual',
  };
  assert(
    findDuplicateApplied(existing, sameWeekDiffIdx) === null,
    '同 week 不同 idx → null'
  );

  assert(findDuplicateApplied([], cand) === null, '空 existing → null');
}

// ---------------------------------------------------------------------------
// T5 — appendAppliedRecommendation LRU cap
// ---------------------------------------------------------------------------
console.log('T5 — appendAppliedRecommendation LRU cap');
{
  const mk = (i: number): AppliedRecommendation => ({
    week_id: `w${i}`,
    recommendation_index: 0,
    text: '',
    applied_at: `2026-01-${(i % 30) + 1}T00:00:00Z`,
    source: 'manual',
  });

  // 不到 cap: 直接 append
  const some = appendAppliedRecommendation([mk(1), mk(2)], mk(3));
  assert(some.length === 3, '<cap 直接 append');
  assert(some[2].week_id === 'w3', '末尾是新项');

  // 满 cap 后 append: drop 最旧
  const full: AppliedRecommendation[] = [];
  for (let i = 1; i <= APPLIED_RECOMMENDATION_CAP; i += 1) full.push(mk(i));
  const overflow = appendAppliedRecommendation(full, mk(999));
  assert(overflow.length === APPLIED_RECOMMENDATION_CAP, '满 cap append → 仍 = cap');
  assert(overflow[0].week_id === 'w2', '最旧 (w1) 被 drop');
  assert(overflow[overflow.length - 1].week_id === 'w999', '末尾是新项');

  // 空 existing
  const empty = appendAppliedRecommendation([], mk(1));
  assert(empty.length === 1, '空 + 1 = 1');
}

// ---------------------------------------------------------------------------
// T6 — controller 主流程镜像复刻 (mirror)
// 直接 mirror controller.applyWeeklyReviewRecommendation 主流程, 注入 fake
// service (不依赖 sequelize). 不验证 res.send 实际写出, 只验证 status + body shape.
// ---------------------------------------------------------------------------
console.log('T6 — controller 主流程镜像 (200 / 400 / 401 / 404 / 409 / 500)');
{
  // mock res
  class FakeRes {
    statusCode = 200;
    body: any = null;
    status(c: number) {
      this.statusCode = c;
      return this;
    }
    json(b: any) {
      this.body = b;
      return this;
    }
  }

  // mock service
  type ApplyInput = {
    week_id: string;
    recommendation_index: number;
    text?: string;
    source?: string;
  };
  type FakeBehavior =
    | { kind: 'ok'; applied: AppliedRecommendation; history: AppliedRecommendation[] }
    | { kind: 'user_not_found' }
    | { kind: 'already_applied'; previous: AppliedRecommendation }
    | { kind: 'invalid' }
    | { kind: 'throw'; err: Error };
  const mkSvc = (b: FakeBehavior) => ({
    applyRecommendation: async (_uid: number, _input: ApplyInput) => {
      if (b.kind === 'ok') return { applied: b.applied, history: b.history };
      if (b.kind === 'user_not_found') throw new Error('USER_NOT_FOUND');
      if (b.kind === 'already_applied') {
        const e: any = new Error('ALREADY_APPLIED');
        e.previous = b.previous;
        throw e;
      }
      if (b.kind === 'invalid') throw new Error('INVALID_RECOMMENDATION_INPUT');
      throw b.err;
    },
  });

  // mirror controller body
  async function callApply(
    req: any,
    res: FakeRes,
    svc: ReturnType<typeof mkSvc>
  ): Promise<void> {
    try {
      const user_id = req.user?.id;
      if (!user_id) {
        res.status(401).json({ success: false, message: '未登录' });
        return;
      }
      const parsed = parseApplyRecommendationBody(req.body || {});
      if (!parsed) {
        res
          .status(400)
          .json({ success: false, message: '参数非法 (week_id / recommendation_index 必填)' });
        return;
      }
      const result = await svc.applyRecommendation(user_id, parsed);
      res.json({
        success: true,
        data: { applied: result.applied, history: result.history },
        message: '建议已应用',
      });
    } catch (error: any) {
      const msg = String(error?.message || '');
      if (msg === 'USER_NOT_FOUND') {
        res.status(404).json({ success: false, message: '用户不存在' });
        return;
      }
      if (msg === 'ALREADY_APPLIED') {
        res.status(409).json({
          success: false,
          message: '该建议已 apply 过, 不可重复触发',
          data: { previous: error.previous || null },
        });
        return;
      }
      if (msg === 'INVALID_RECOMMENDATION_INPUT') {
        res.status(400).json({ success: false, message: '参数非法' });
        return;
      }
      res.status(500).json({ success: false, message: error?.message || 'apply 失败' });
    }
  }

  const mkApplied = (): AppliedRecommendation => ({
    week_id: '2026-W25',
    recommendation_index: 0,
    text: 'foo',
    applied_at: '2026-06-21T00:00:00Z',
    source: 'frontend',
  });

  // [a] happy 200
  (async () => {
    const res = new FakeRes();
    const a = mkApplied();
    await callApply(
      { user: { id: 1 }, body: { week_id: '2026-W25', recommendation_index: 0 } },
      res,
      mkSvc({ kind: 'ok', applied: a, history: [a] })
    );
    assert(res.statusCode === 200, '[a] happy → 200');
    assert(res.body.success === true, '[a] success=true');
    assert(res.body.data.applied.week_id === '2026-W25', '[a] applied 透传');
    assert(Array.isArray(res.body.data.history) && res.body.data.history.length === 1, '[a] history len=1');
  })();

  // [b] 401 未登录
  (async () => {
    const res = new FakeRes();
    await callApply({ body: {} }, res, mkSvc({ kind: 'ok', applied: mkApplied(), history: [] }));
    assert(res.statusCode === 401, '[b] 无 req.user → 401');
  })();
  (async () => {
    const res = new FakeRes();
    await callApply(
      { user: { id: 0 }, body: {} },
      res,
      mkSvc({ kind: 'ok', applied: mkApplied(), history: [] })
    );
    assert(res.statusCode === 401, '[b2] user.id=0 falsy → 401');
  })();

  // [c] 400 参数非法 (4 子路径)
  (async () => {
    const res = new FakeRes();
    await callApply(
      { user: { id: 1 }, body: {} },
      res,
      mkSvc({ kind: 'ok', applied: mkApplied(), history: [] })
    );
    assert(res.statusCode === 400, '[c1] 空 body → 400');
  })();
  (async () => {
    const res = new FakeRes();
    await callApply(
      { user: { id: 1 }, body: { recommendation_index: 0 } },
      res,
      mkSvc({ kind: 'ok', applied: mkApplied(), history: [] })
    );
    assert(res.statusCode === 400, '[c2] 缺 week_id → 400');
  })();
  (async () => {
    const res = new FakeRes();
    await callApply(
      { user: { id: 1 }, body: { week_id: 'w' } },
      res,
      mkSvc({ kind: 'ok', applied: mkApplied(), history: [] })
    );
    assert(res.statusCode === 400, '[c3] 缺 index → 400');
  })();
  (async () => {
    const res = new FakeRes();
    await callApply(
      { user: { id: 1 }, body: { week_id: 'w', recommendation_index: -1 } },
      res,
      mkSvc({ kind: 'ok', applied: mkApplied(), history: [] })
    );
    assert(res.statusCode === 400, '[c4] 负 index → 400');
  })();

  // [d] 404 USER_NOT_FOUND
  (async () => {
    const res = new FakeRes();
    await callApply(
      { user: { id: 1 }, body: { week_id: 'w', recommendation_index: 0 } },
      res,
      mkSvc({ kind: 'user_not_found' })
    );
    assert(res.statusCode === 404, '[d] USER_NOT_FOUND → 404');
  })();

  // [e] 409 ALREADY_APPLIED + previous 透传
  (async () => {
    const res = new FakeRes();
    const prev = mkApplied();
    await callApply(
      { user: { id: 1 }, body: { week_id: '2026-W25', recommendation_index: 0 } },
      res,
      mkSvc({ kind: 'already_applied', previous: prev })
    );
    assert(res.statusCode === 409, '[e] ALREADY_APPLIED → 409');
    assert(res.body.data.previous.week_id === '2026-W25', '[e] previous 透传');
  })();

  // [f] 400 service-level INVALID_RECOMMENDATION_INPUT (虽 controller helper 已挡)
  (async () => {
    const res = new FakeRes();
    await callApply(
      { user: { id: 1 }, body: { week_id: 'w', recommendation_index: 0 } },
      res,
      mkSvc({ kind: 'invalid' })
    );
    assert(res.statusCode === 400, '[f] service INVALID → 400');
  })();

  // [g] 500 unknown throw
  (async () => {
    const res = new FakeRes();
    await callApply(
      { user: { id: 1 }, body: { week_id: 'w', recommendation_index: 0 } },
      res,
      mkSvc({ kind: 'throw', err: new Error('DB connection refused') })
    );
    assert(res.statusCode === 500, '[g] unknown throw → 500');
    assert(res.body.message === 'DB connection refused', '[g] error message 透传');
  })();
}

// ---------------------------------------------------------------------------
// T7 — META-GUARD fs+regex 守源码形态
// ---------------------------------------------------------------------------
console.log('T7 — META-GUARD 源码形态');
{
  const ctrlSrc = fs.readFileSync(
    path.resolve(__dirname, '../../src/api/controllers/SettingsController.ts'),
    'utf8'
  );
  const routesSrc = fs.readFileSync(
    path.resolve(__dirname, '../../src/api/routes/settings.routes.ts'),
    'utf8'
  );
  const svcSrc = fs.readFileSync(
    path.resolve(__dirname, '../../src/services/WeeklyReviewReportService.ts'),
    'utf8'
  );

  // controller: 含 apply method + export helper + 6 状态码分支
  assert(
    /async\s+applyWeeklyReviewRecommendation\s*\(/.test(ctrlSrc),
    'controller 含 applyWeeklyReviewRecommendation method'
  );
  assert(
    /async\s+listAppliedWeeklyReviewRecommendations\s*\(/.test(ctrlSrc),
    'controller 含 listAppliedWeeklyReviewRecommendations method'
  );
  assert(
    /export\s+function\s+parseApplyRecommendationBody\s*\(/.test(ctrlSrc),
    'controller 含 export parseApplyRecommendationBody'
  );
  assert(/status\s*\(\s*409\s*\)/.test(ctrlSrc), 'controller 含 409 路径');
  assert(/status\s*\(\s*404\s*\)/.test(ctrlSrc), 'controller 含 404 路径');
  assert(/status\s*\(\s*400\s*\)/.test(ctrlSrc), 'controller 含 400 路径');
  assert(/USER_NOT_FOUND/.test(ctrlSrc), 'controller 识别 USER_NOT_FOUND');
  assert(/ALREADY_APPLIED/.test(ctrlSrc), 'controller 识别 ALREADY_APPLIED');

  // routes: 含两个新 endpoint
  assert(
    /router\.post\s*\(\s*['"]\/weekly-review\/apply['"]/.test(routesSrc),
    'routes 含 POST /weekly-review/apply'
  );
  assert(
    /router\.get\s*\(\s*['"]\/weekly-review\/applied['"]/.test(routesSrc),
    'routes 含 GET /weekly-review/applied'
  );
  assert(
    /settingsController\.applyWeeklyReviewRecommendation/.test(routesSrc),
    'routes 挂 applyWeeklyReviewRecommendation'
  );
  assert(
    /settingsController\.listAppliedWeeklyReviewRecommendations/.test(routesSrc),
    'routes 挂 listAppliedWeeklyReviewRecommendations'
  );
  assert(/US-143/.test(routesSrc), 'routes 含 US-143 标记');

  // service: 含 apply 方法 + 5 helper + 常量
  assert(
    /async\s+applyRecommendation\s*\(/.test(svcSrc),
    'service 含 applyRecommendation method'
  );
  assert(
    /async\s+listAppliedRecommendations\s*\(/.test(svcSrc),
    'service 含 listAppliedRecommendations method'
  );
  assert(
    /export\s+function\s+normalizeAppliedRecommendation\s*\(/.test(svcSrc),
    'service 含 normalizeAppliedRecommendation export'
  );
  assert(
    /export\s+function\s+readWeeklyReviewAppliedFromRiskConfig\s*\(/.test(svcSrc),
    'service 含 readWeeklyReviewAppliedFromRiskConfig export'
  );
  assert(
    /export\s+function\s+findDuplicateApplied\s*\(/.test(svcSrc),
    'service 含 findDuplicateApplied export'
  );
  assert(
    /export\s+function\s+appendAppliedRecommendation\s*\(/.test(svcSrc),
    'service 含 appendAppliedRecommendation export'
  );
  assert(
    /APPLIED_RECOMMENDATION_CAP\s*=\s*50/.test(svcSrc),
    'service APPLIED_RECOMMENDATION_CAP = 50'
  );
  assert(
    /weekly_review_applied/.test(svcSrc),
    'service 含 weekly_review_applied namespace'
  );
  assert(
    /new\s+Error\s*\(\s*['"]ALREADY_APPLIED['"]\s*\)/.test(svcSrc),
    'service throws ALREADY_APPLIED'
  );
  assert(
    /throw\s+new\s+Error\s*\(\s*['"]USER_NOT_FOUND['"]\s*\)/.test(svcSrc),
    'service throw USER_NOT_FOUND'
  );
  assert(
    /user\.changed\s*\(\s*['"]risk_config['"]\s*,\s*true\s*\)/.test(svcSrc),
    'service 调用 user.changed risk_config 强制 JSONB 持久化'
  );
}

// ---------------------------------------------------------------------------
// 终止前等待 async mirror 全跑完
// ---------------------------------------------------------------------------
setTimeout(() => {
  console.log(`\n────────────────────────────────────`);
  console.log(`${pass} passed, ${fail} failed`);
  console.log(`────────────────────────────────────`);
  if (fail > 0) {
    console.error('failures:', failures);
    process.exit(1);
  }
}, 100);
