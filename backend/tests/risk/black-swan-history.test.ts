/**
 * US-133 [PR-018] — 黑天鹅事件历史 backend controller/service contract 单测.
 *
 * 不依赖 jest / DB / React 渲染. node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/risk/black-swan-history.test.ts
 *
 * BlackSwanEventController 顶层 require BlackSwanEvent / BlackSwanPostmortemReport 拽起
 * sequelize, 单测进程 (无 PG) 不可直接 instantiate (与 [US-018/065/094/126] 同源 DB-less 不可测).
 * 对策: import 只测 pure helper (parseEventId / safe*); controller 主流程用 mirror 复刻.
 *
 * 覆盖:
 *   T1 — controller 纯函数 safeInt / safeIsoDate / safe* / parseEventId 边界
 *   T2 — controller listEvents 主流程镜像 (filter where / pagination / fail-OPEN)
 *   T3 — controller getEvent 主流程镜像 (200 / 400 / 404 / postmortem null / 500)
 *   T4 — META-GUARD fs+regex 守 controller + routes + index.ts + frontend service.
 *
 * 旧 Settings 黑天鹅 Tab 与其 helper 已由 918be596 明确删除，不在此测试复活。
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  parseEventId,
  safeInt,
  safeIsoDate,
  safeEventType,
  safeSeverity,
  safeScope,
  safeStatus,
} from '../../src/api/controllers/BlackSwanEventController';
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

// 跨 monorepo 路径（frontend service 仍是活跃 API client）。
const ROOT = path.resolve(__dirname, '../..');
const FE_ROOT = path.resolve(ROOT, '../frontend');
const CTRL_PATH = path.resolve(ROOT, 'src/api/controllers/BlackSwanEventController.ts');
const ROUTES_PATH = path.resolve(ROOT, 'src/api/routes/blackSwan.routes.ts');
const INDEX_PATH = path.resolve(ROOT, 'src/index.ts');
const SERVICE_PATH = path.resolve(FE_ROOT, 'src/services/blackSwanService.ts');
// Mirror BlackSwanEventController PAGE_LIMIT_DEFAULT / PAGE_LIMIT_MAX.
const BLACK_SWAN_DEFAULT_PAGE_LIMIT = 30;
const BLACK_SWAN_MAX_PAGE_LIMIT = 200;

// ---------------------------------------------------------------------------
// T1 — controller 纯函数边界
// ---------------------------------------------------------------------------
console.log('T1 — controller safe* / parseEventId');
{
  // safeInt
  assert(safeInt('5', 1, 1, 10) === 5, 'safeInt 合法');
  assert(safeInt('abc', 1, 1, 10) === 1, 'safeInt 非数字 → default');
  assert(safeInt('0', 1, 1, 10) === 1, 'safeInt 低于 min → min');
  assert(safeInt('999', 1, 1, 10) === 10, 'safeInt 超 max → max');
  assert(safeInt(undefined, 7, 1, 10) === 7, 'safeInt undefined → default');
  assert(safeInt('3.14', 1, 1, 10) === 1, 'safeInt 浮点 → default (非整数)');

  // safeIsoDate
  assert(safeIsoDate('2026-06-19') instanceof Date, 'safeIsoDate yyyy-mm-dd 合法');
  assert(safeIsoDate('') === null, 'safeIsoDate 空 → null');
  assert(safeIsoDate('not-a-date') === null, 'safeIsoDate 非法 → null');
  assert(safeIsoDate(123 as any) === null, 'safeIsoDate 非 string → null');

  // safeEventType
  assert(safeEventType('ST') === 'ST', 'safeEventType ST 合法');
  assert(safeEventType('st') === 'ST', 'safeEventType 小写 → upper');
  assert(safeEventType('NEWS_KEYWORD') === 'NEWS_KEYWORD', 'safeEventType NEWS_KEYWORD');
  assert(safeEventType('UNKNOWN_TYPE') === null, 'safeEventType 非法 enum → null');
  assert(safeEventType('') === null, 'safeEventType 空 → null');
  assert(safeEventType(123 as any) === null, 'safeEventType 非 string → null');

  // safeSeverity
  assert(safeSeverity('critical') === 'critical', 'safeSeverity critical 合法');
  assert(safeSeverity('HIGH') === 'high', 'safeSeverity 大写 → lower');
  assert(safeSeverity('xxx') === null, 'safeSeverity 非法 → null');

  // safeScope
  assert(safeScope('symbol') === 'symbol', 'safeScope symbol 合法');
  assert(safeScope('MARKET') === 'market', 'safeScope 大写 → lower');
  assert(safeScope('foobar') === null, 'safeScope 非法 → null');

  // safeStatus
  assert(safeStatus('open') === 'open', 'safeStatus open 合法');
  assert(safeStatus('RESOLVED') === 'resolved', 'safeStatus 大写 → lower');
  assert(safeStatus('zzz') === null, 'safeStatus 非法 → null');

  // parseEventId
  assert(parseEventId('1') === 1, 'parseEventId "1" → 1');
  assert(parseEventId('42') === 42, 'parseEventId "42" → 42');
  assert(parseEventId('0') === null, 'parseEventId 0 → null');
  assert(parseEventId('-1') === null, 'parseEventId 负 → null');
  assert(parseEventId('abc') === null, 'parseEventId 非数字 → null');
  assert(parseEventId(null as any) === null, 'parseEventId null → null');
  assert(parseEventId(undefined as any) === null, 'parseEventId undefined → null');
}

// ---------------------------------------------------------------------------
// T2 — listEvents 镜像
// ---------------------------------------------------------------------------
console.log('T2 — listEvents 镜像 (filter where / pagination / fail-OPEN)');
{
  interface FakeRow {
    id: number;
    event_type: string;
    severity: string;
    scope: string;
    status: string;
    symbol: string | null;
    detected_at: Date;
    get: () => any;
  }
  interface FakeDeps {
    findAndCountAll: (q: any) => Promise<{ rows: FakeRow[]; count: number }>;
  }
  type Resp = { status: number; body: any };

  function makeRow(id: number, over: Partial<FakeRow> = {}): FakeRow {
    const base: FakeRow = {
      id,
      event_type: 'ST',
      severity: 'high',
      scope: 'symbol',
      status: 'open',
      symbol: '600519.SH',
      detected_at: new Date('2026-06-19T10:00:00Z'),
      get: function () {
        return { ...base };
      },
    };
    Object.assign(base, over);
    return base;
  }

  async function mirrorList(query: Record<string, any>, deps: FakeDeps): Promise<Resp> {
    const eventType = safeEventType(query.event_type);
    const severity = safeSeverity(query.severity);
    const scope = safeScope(query.scope);
    const status = safeStatus(query.status);
    const symbol = typeof query.symbol === 'string' ? query.symbol.trim() : '';
    const dateFrom = safeIsoDate(query.date_from);
    const dateTo = safeIsoDate(query.date_to);
    const page = safeInt(query.page, 1, 1, 10000);
    const limit = safeInt(query.limit, BLACK_SWAN_DEFAULT_PAGE_LIMIT, 1, BLACK_SWAN_MAX_PAGE_LIMIT);
    const where: Record<string, any> = {};
    if (eventType) where.event_type = eventType;
    if (severity) where.severity = severity;
    if (scope) where.scope = scope;
    if (status) where.status = status;
    if (symbol) where.symbol = { iLike: `%${symbol}%` };
    if (dateFrom || dateTo) {
      const range: any = {};
      if (dateFrom) range.gte = dateFrom;
      if (dateTo) range.lte = dateTo;
      where.detected_at = range;
    }
    try {
      const result = await deps.findAndCountAll({
        where,
        order: [['detected_at', 'DESC']],
        offset: (page - 1) * limit,
        limit,
      });
      return {
        status: 200,
        body: {
          success: true,
          data: {
            items: result.rows.map(r => r.get()),
            total: result.count,
            page,
            limit,
          },
        },
      };
    } catch (err: any) {
      return { status: 500, body: { success: false, message: err?.message || 'list failed' } };
    }
  }

  // [a] 默认参数 — page=1 limit=30 where={}
  (async () => {
    let captured: any = null;
    const rows = [makeRow(1), makeRow(2), makeRow(3)];
    const r = await mirrorList(
      {},
      {
        findAndCountAll: async (q: any) => {
          captured = q;
          return { rows, count: 3 };
        },
      }
    );
    assert(r.status === 200, '[a] 200');
    assert(captured.limit === BLACK_SWAN_DEFAULT_PAGE_LIMIT, '[a] limit=30 default');
    assert(captured.offset === 0, '[a] offset=0 default');
    assert(Object.keys(captured.where).length === 0, '[a] where 默认空');
    assert(r.body.data.total === 3, '[a] total=3 透传');
    assert(r.body.data.items.length === 3, '[a] items.length=3');
  })();

  // [b] 全 filter 注入 where
  (async () => {
    let captured: any = null;
    const r = await mirrorList(
      {
        event_type: 'ST',
        severity: 'critical',
        scope: 'symbol',
        status: 'open',
        symbol: '600519',
      },
      {
        findAndCountAll: async (q: any) => {
          captured = q;
          return { rows: [], count: 0 };
        },
      }
    );
    assert(r.status === 200, '[b] 200');
    assert(captured.where.event_type === 'ST', '[b] event_type → where');
    assert(captured.where.severity === 'critical', '[b] severity → where');
    assert(captured.where.scope === 'symbol', '[b] scope → where');
    assert(captured.where.status === 'open', '[b] status → where');
    assert(
      typeof captured.where.symbol === 'object' && captured.where.symbol.iLike === '%600519%',
      '[b] symbol → iLike (模糊)'
    );
  })();

  // [c] 非法 enum 不进 where (silent ignore — 与 backend safeXxx 同款 fail-OPEN)
  (async () => {
    let captured: any = null;
    await mirrorList(
      {
        event_type: 'INVALID_TYPE',
        severity: 'badsev',
        scope: 'somewhere',
        status: 'unknown',
      },
      {
        findAndCountAll: async (q: any) => {
          captured = q;
          return { rows: [], count: 0 };
        },
      }
    );
    assert(captured.where.event_type === undefined, '[c] 非法 event_type 不进 where');
    assert(captured.where.severity === undefined, '[c] 非法 severity 不进 where');
    assert(captured.where.scope === undefined, '[c] 非法 scope 不进 where');
    assert(captured.where.status === undefined, '[c] 非法 status 不进 where');
  })();

  // [d] 分页 — page=3 limit=10 offset=20
  (async () => {
    let captured: any = null;
    await mirrorList(
      { page: 3, limit: 10 },
      {
        findAndCountAll: async (q: any) => {
          captured = q;
          return { rows: [], count: 100 };
        },
      }
    );
    assert(captured.offset === 20, '[d] page=3 limit=10 → offset=20');
    assert(captured.limit === 10, '[d] limit=10');
  })();

  // [e] limit cap 守住 (max=200) — 用户传 500 必须降到 200
  (async () => {
    let captured: any = null;
    await mirrorList(
      { limit: 500 },
      {
        findAndCountAll: async (q: any) => {
          captured = q;
          return { rows: [], count: 0 };
        },
      }
    );
    assert(captured.limit === BLACK_SWAN_MAX_PAGE_LIMIT, '[e] limit cap=200 守住 防 DOS');
  })();

  // [f] DB throw → 500
  (async () => {
    const r = await mirrorList(
      {},
      {
        findAndCountAll: async () => {
          throw new Error('DB pool exhausted');
        },
      }
    );
    assert(r.status === 500, '[f] DB throw → 500');
    assert(r.body.message === 'DB pool exhausted', '[f] 500 透传错误 message');
  })();
}

// ---------------------------------------------------------------------------
// T3 — getEvent 镜像
// ---------------------------------------------------------------------------
console.log('T3 — getEvent 镜像');
{
  interface FakeDeps {
    findByPk: (id: number) => Promise<any | null>;
    findPostmortem: (eventId: number) => Promise<any | null>;
  }
  type Resp = { status: number; body: any };

  async function mirrorGet(params: { id: string }, deps: FakeDeps): Promise<Resp> {
    const id = parseEventId(params.id);
    if (id === null) {
      return { status: 400, body: { success: false, message: 'id 非法' } };
    }
    try {
      const event = await deps.findByPk(id);
      if (!event) {
        return { status: 404, body: { success: false, message: '事件不存在' } };
      }
      const postmortem = await deps.findPostmortem(id);
      return {
        status: 200,
        body: {
          success: true,
          data: {
            event: event.get ? event.get() : event,
            postmortem: postmortem ? (postmortem.get ? postmortem.get() : postmortem) : null,
          },
        },
      };
    } catch (err: any) {
      return { status: 500, body: { success: false, message: err?.message || 'failed' } };
    }
  }

  // [a] happy — 找到 event + postmortem
  (async () => {
    const event = { id: 1, event_type: 'ST', get: () => ({ id: 1, event_type: 'ST' }) };
    const postmortem = {
      id: 99,
      black_swan_event_id: 1,
      event_summary: { foo: 'bar' },
      get: () => ({ id: 99, black_swan_event_id: 1, event_summary: { foo: 'bar' } }),
    };
    const r = await mirrorGet(
      { id: '1' },
      {
        findByPk: async () => event,
        findPostmortem: async () => postmortem,
      }
    );
    assert(r.status === 200, '[a] happy → 200');
    assert(r.body.data.event.id === 1, '[a] event.id 透传');
    assert(r.body.data.postmortem.id === 99, '[a] postmortem.id 透传');
  })();

  // [b] postmortem 待生成 → null (与 PR-013 cron 还没跑场景对齐)
  (async () => {
    const event = { id: 1, get: () => ({ id: 1 }) };
    const r = await mirrorGet(
      { id: '1' },
      {
        findByPk: async () => event,
        findPostmortem: async () => null,
      }
    );
    assert(r.status === 200, '[b] postmortem null → 200');
    assert(r.body.data.postmortem === null, '[b] postmortem=null');
    assert(r.body.data.event.id === 1, '[b] event 仍透传');
  })();

  // [c] id 非法 → 400
  (async () => {
    for (const idStr of ['abc', '-1', '0', '']) {
      const r = await mirrorGet(
        { id: idStr },
        {
          findByPk: async () => {
            throw new Error('should not be called');
          },
          findPostmortem: async () => null,
        }
      );
      assert(r.status === 400, `[c] id=${JSON.stringify(idStr)} → 400`);
    }
  })();

  // [d] event 不存在 → 404
  (async () => {
    const r = await mirrorGet(
      { id: '999' },
      {
        findByPk: async () => null,
        findPostmortem: async () => null,
      }
    );
    assert(r.status === 404, '[d] not found → 404');
    assert(r.body.message === '事件不存在', '[d] 404 message');
  })();

  // [e] DB throw → 500
  (async () => {
    const r = await mirrorGet(
      { id: '1' },
      {
        findByPk: async () => {
          throw new Error('DB timeout');
        },
        findPostmortem: async () => null,
      }
    );
    assert(r.status === 500, '[e] DB throw → 500');
    assert(r.body.message === 'DB timeout', '[e] 500 错误 message 透传');
  })();
}

// ---------------------------------------------------------------------------
// T4 — META-GUARD fs+regex 守仍活跃源码形态
// ---------------------------------------------------------------------------
console.log('T4 — META-GUARD: controller + routes + index.ts + frontend service');
{
  // ---- backend controller ----
  const ctrlSrc = fs.readFileSync(CTRL_PATH, 'utf-8');
  assert(/async\s+listEvents\s*\(/.test(ctrlSrc), 'controller 含 async listEvents');
  assert(/async\s+getEvent\s*\(/.test(ctrlSrc), 'controller 含 async getEvent');
  assert(/BlackSwanEvent\.findAndCountAll/.test(ctrlSrc), 'controller list 必走 findAndCountAll');
  assert(/BlackSwanEvent\.findByPk/.test(ctrlSrc), 'controller detail 必走 findByPk');
  assert(
    /BlackSwanPostmortemReport\.findOne/.test(ctrlSrc),
    'controller detail 必查 BlackSwanPostmortemReport'
  );
  assert(
    /export function parseEventId/.test(ctrlSrc),
    'controller 必须 export parseEventId 给单测'
  );
  assert(/export function safeInt/.test(ctrlSrc), 'controller export safeInt');
  assert(/export function safeIsoDate/.test(ctrlSrc), 'controller export safeIsoDate');
  assert(/export function safeEventType/.test(ctrlSrc), 'controller export safeEventType');
  assert(/export function safeSeverity/.test(ctrlSrc), 'controller export safeSeverity');
  assert(/export function safeScope/.test(ctrlSrc), 'controller export safeScope');
  assert(/export function safeStatus/.test(ctrlSrc), 'controller export safeStatus');
  assert(
    /this\.listEvents\s*=\s*this\.listEvents\.bind/.test(ctrlSrc),
    'controller bind listEvents (express this)'
  );
  assert(
    /this\.getEvent\s*=\s*this\.getEvent\.bind/.test(ctrlSrc),
    'controller bind getEvent (express this)'
  );
  assert(/status\s*\(\s*400\s*\)/.test(ctrlSrc), 'controller 含 400 (id 非法)');
  assert(/status\s*\(\s*404\s*\)/.test(ctrlSrc), 'controller 含 404 (event 不存在)');
  assert(
    /export const blackSwanEventController\s*=\s*new BlackSwanEventController\(\)/.test(ctrlSrc),
    'controller export singleton'
  );

  // ---- backend routes ----
  const routesSrc = fs.readFileSync(ROUTES_PATH, 'utf-8');
  assert(
    /router\.get\(\s*['"]\/events['"]/.test(routesSrc),
    "routes 必须挂 GET '/events'"
  );
  assert(
    /router\.get\(\s*['"]\/events\/:id['"]/.test(routesSrc),
    "routes 必须挂 GET '/events/:id'"
  );
  assert(
    /blackSwanEventController\.listEvents/.test(routesSrc),
    'routes 绑 listEvents'
  );
  assert(
    /blackSwanEventController\.getEvent/.test(routesSrc),
    'routes 绑 getEvent'
  );
  assert(
    /authController\.authenticate/.test(routesSrc),
    'routes 必须挂 authenticate (不可裸路由)'
  );

  // ---- backend index.ts mount ----
  const indexSrc = fs.readFileSync(INDEX_PATH, 'utf-8');
  assert(
    /import\s+blackSwanRoutes\s+from\s+['"]\.\/api\/routes\/blackSwan\.routes['"]/.test(indexSrc),
    'index.ts 必须 import blackSwanRoutes'
  );
  assert(
    /app\.use\(\s*['"]\/api\/black-swan['"]\s*,\s*blackSwanRoutes\s*\)/.test(indexSrc),
    "index.ts 必须 app.use('/api/black-swan', blackSwanRoutes)"
  );

  // ---- frontend service ----
  const serviceSrc = fs.readFileSync(SERVICE_PATH, 'utf-8');
  assert(
    /export\s+(async\s+)?function\s+listBlackSwanEvents/.test(serviceSrc),
    'service export listBlackSwanEvents'
  );
  assert(
    /export\s+(async\s+)?function\s+getBlackSwanEvent/.test(serviceSrc),
    'service export getBlackSwanEvent'
  );
  assert(
    /['"]\/black-swan\/events['"]/.test(serviceSrc),
    'service 调用路径 /black-swan/events'
  );
  assert(
    /\/black-swan\/events\/\$\{/.test(serviceSrc),
    'service detail 用 /black-swan/events/${id}'
  );

}
// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
setTimeout(() => {
  console.log('');
  if (fail === 0) {
    console.log(`✓ black-swan-history: ${pass}/${pass} OK`);
    process.exit(0);
  } else {
    console.log(`✗ black-swan-history: ${pass} passed, ${fail} FAILED`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}, 300);
