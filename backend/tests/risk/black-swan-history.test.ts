/**
 * US-133 [PR-018] — 黑天鹅事件历史 (controller + helpers + tab + SettingsWorkspace) 单测.
 *
 * 不依赖 jest / DB / React 渲染. node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/risk/black-swan-history.test.ts
 *
 * 范式 = [[improvement-suggestion-apply.test.ts]] (镜像 + META-GUARD) +
 *        [[todo-suggestions-helpers.test.ts]] (跨 monorepo helper import + tab fs regex).
 *
 * BlackSwanEventController 顶层 require BlackSwanEvent / BlackSwanPostmortemReport 拽起
 * sequelize, 单测进程 (无 PG) 不可直接 instantiate (与 [US-018/065/094/126] 同源 DB-less 不可测).
 * 对策: import 只测 pure helper (parseEventId / safe*); controller 主流程用 mirror 复刻.
 *
 * 覆盖 (8 模块):
 *   T1 — controller 纯函数 safeInt / safeIsoDate / safe* / parseEventId 边界
 *   T2 — controller listEvents 主流程镜像 (filter where / pagination / fail-OPEN)
 *   T3 — controller getEvent 主流程镜像 (200 / 400 / 404 / postmortem null / 500)
 *   T4 — frontend helper truncateText / *Label / *Color / severityRank 行为
 *   T5 — frontend helper sortBlackSwanEventsBySeverity 3 段稳定排序
 *   T6 — frontend helper summarizeBlackSwanEvents 永远返 4 档 + unknown 兜底
 *   T7 — frontend helper computePostmortemSectionStatus 4 段完成度
 *   T8 — META-GUARD fs+regex 守 controller + routes + index.ts + tab.tsx +
 *        SettingsWorkspace.tsx + service.ts 源码形态
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
import {
  BLACK_SWAN_DEFAULT_PAGE_LIMIT,
  BLACK_SWAN_MAX_PAGE_LIMIT,
  BLACK_SWAN_SEVERITY_ORDER,
  BLACK_SWAN_EVENT_TYPES,
  BLACK_SWAN_SCOPE_LABEL,
  BLACK_SWAN_STATUS_LABEL,
  BLACK_SWAN_SEVERITY_COLOR,
  BLACK_SWAN_SEVERITY_LABEL,
  truncateText,
  eventTypeLabel,
  scopeLabel,
  statusLabel,
  severityLabel,
  severityColor,
  scopeColor,
  statusColor,
  severityRank,
  sortBlackSwanEventsBySeverity,
  summarizeBlackSwanEvents,
  computePostmortemSectionStatus,
} from '../../../frontend/src/pages/workspace/blackSwanHistoryHelpers';

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

// 跨 monorepo 路径
const ROOT = path.resolve(__dirname, '../..');
const FE_ROOT = path.resolve(ROOT, '../frontend');
const CTRL_PATH = path.resolve(ROOT, 'src/api/controllers/BlackSwanEventController.ts');
const ROUTES_PATH = path.resolve(ROOT, 'src/api/routes/blackSwan.routes.ts');
const INDEX_PATH = path.resolve(ROOT, 'src/index.ts');
const TAB_PATH = path.resolve(FE_ROOT, 'src/pages/workspace/SettingsWorkspace.BlackSwanHistoryTab.tsx');
const SETTINGS_WS_PATH = path.resolve(FE_ROOT, 'src/pages/workspace/SettingsWorkspace.tsx');
const HELPER_PATH = path.resolve(FE_ROOT, 'src/pages/workspace/blackSwanHistoryHelpers.ts');
const SERVICE_PATH = path.resolve(FE_ROOT, 'src/services/blackSwanService.ts');

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
// T4 — frontend helper 显示归一化
// ---------------------------------------------------------------------------
console.log('T4 — frontend helper truncateText / *Label / *Color');
{
  // truncateText 边界 (N / N+1 / 远超 / 空)
  assert(truncateText('hello', 5) === 'hello', 'truncate N 不截');
  assert(truncateText('hellow', 5) === 'hell…', 'truncate N+1 截到 N (4+…=5)');
  assert(truncateText('helloworld', 5) === 'hell…', 'truncate 远超 截到 N');
  assert(truncateText(null, 5) === '', 'truncate null → ""');
  assert(truncateText(undefined, 5) === '', 'truncate undefined → ""');
  assert(truncateText('', 5) === '', 'truncate "" → ""');
  assert(truncateText('a', 5) === 'a', 'truncate 远小于 N 不截');

  // eventTypeLabel
  assert(eventTypeLabel('ST') === 'ST 标记', 'eventTypeLabel ST');
  assert(eventTypeLabel('UNKNOWN_FUTURE') === 'UNKNOWN_FUTURE', 'eventTypeLabel 未知 → 原值兜底');
  assert(eventTypeLabel(null) === '—', 'eventTypeLabel null → —');
  assert(eventTypeLabel('') === '—', 'eventTypeLabel "" → —');

  // scopeLabel
  assert(scopeLabel('symbol') === '单股', 'scopeLabel symbol → 单股');
  assert(scopeLabel('market') === '全市场', 'scopeLabel market → 全市场');
  assert(scopeLabel(null) === '—', 'scopeLabel null → —');
  assert(scopeLabel('unknown') === 'unknown', 'scopeLabel 未知 → 原值');

  // statusLabel
  assert(statusLabel('open') === '进行中', 'statusLabel open');
  assert(statusLabel('resolved') === '已解决', 'statusLabel resolved');
  assert(statusLabel(null) === '—', 'statusLabel null');

  // severityLabel
  assert(severityLabel('critical') === '极端', 'severityLabel critical');
  assert(severityLabel('high') === '高', 'severityLabel high');
  assert(severityLabel(null) === '—', 'severityLabel null');

  // severityColor — 未知不抛 走 default
  assert(severityColor('critical') === 'red', 'severityColor critical → red');
  assert(severityColor('high') === 'volcano', 'severityColor high → volcano');
  assert(severityColor('unknown') === 'default', 'severityColor 未知 → default 不抛');
  assert(severityColor(null) === 'default', 'severityColor null → default');

  // scopeColor / statusColor 同款兜底
  assert(scopeColor('market') === 'purple', 'scopeColor market');
  assert(scopeColor('unknown') === 'default', 'scopeColor 未知 → default');
  assert(statusColor('open') === 'red', 'statusColor open → red');
  assert(statusColor('unknown') === 'default', 'statusColor 未知 → default');

  // severityRank
  assert(severityRank('critical') === 0, 'severityRank critical = 0 (最严重)');
  assert(severityRank('high') === 1, 'severityRank high = 1');
  assert(severityRank('medium') === 2, 'severityRank medium = 2');
  assert(severityRank('low') === 3, 'severityRank low = 3');
  assert(severityRank('unknown') === 999, 'severityRank 未知 = 999 (落最后)');
  assert(severityRank(null) === 999, 'severityRank null = 999');

  // sanity 常量
  assert(BLACK_SWAN_DEFAULT_PAGE_LIMIT < BLACK_SWAN_MAX_PAGE_LIMIT, 'default < max page limit');
  assert(BLACK_SWAN_SEVERITY_ORDER[0] === 'critical', 'severity 顺序首 critical');
  assert(BLACK_SWAN_SEVERITY_ORDER[3] === 'low', 'severity 顺序末 low');
  assert(BLACK_SWAN_EVENT_TYPES.includes('ST'), 'event_types 含 ST');
  assert(BLACK_SWAN_EVENT_TYPES.includes('MARKET_REGIME'), 'event_types 含 MARKET_REGIME');
  // frozen
  try {
    (BLACK_SWAN_SEVERITY_LABEL as any).critical = 'X';
    assert(BLACK_SWAN_SEVERITY_LABEL.critical === '极端', 'frozen — 写入无效');
  } catch {
    assert(true, 'frozen — 写入抛 (strict mode)');
  }
  try {
    (BLACK_SWAN_SCOPE_LABEL as any).market = 'X';
    assert(BLACK_SWAN_SCOPE_LABEL.market === '全市场', 'scope label frozen');
  } catch {
    assert(true, 'scope label frozen (strict)');
  }
  try {
    (BLACK_SWAN_STATUS_LABEL as any).open = 'X';
    assert(BLACK_SWAN_STATUS_LABEL.open === '进行中', 'status label frozen');
  } catch {
    assert(true, 'status label frozen (strict)');
  }
  try {
    (BLACK_SWAN_SEVERITY_COLOR as any).critical = 'X';
    assert(BLACK_SWAN_SEVERITY_COLOR.critical === 'red', 'severity color frozen');
  } catch {
    assert(true, 'severity color frozen (strict)');
  }
}

// ---------------------------------------------------------------------------
// T5 — sortBlackSwanEventsBySeverity 3 段稳定
// ---------------------------------------------------------------------------
console.log('T5 — sortBlackSwanEventsBySeverity 3 段稳定');
{
  const rows: any[] = [
    {
      id: 3,
      severity: 'low',
      detected_at: '2026-06-19T08:00:00Z',
      event_type: 'ST',
      scope: 'symbol',
      status: 'open',
      symbol: 'A',
      signature: 's3',
      title: 'A',
      description: '',
      detail: {},
      scope_detail: {},
      source: 'detector_cron',
      resolved_at: null,
      resolved_reason: null,
      metadata: {},
      created_at: '',
      updated_at: '',
    },
    {
      id: 1,
      severity: 'critical',
      detected_at: '2026-06-19T05:00:00Z',
      event_type: 'ST',
      scope: 'symbol',
      status: 'open',
      symbol: 'B',
      signature: 's1',
      title: 'B',
      description: '',
      detail: {},
      scope_detail: {},
      source: 'detector_cron',
      resolved_at: null,
      resolved_reason: null,
      metadata: {},
      created_at: '',
      updated_at: '',
    },
    {
      id: 2,
      severity: 'critical',
      detected_at: '2026-06-19T07:00:00Z',
      event_type: 'ST',
      scope: 'symbol',
      status: 'open',
      symbol: 'C',
      signature: 's2',
      title: 'C',
      description: '',
      detail: {},
      scope_detail: {},
      source: 'detector_cron',
      resolved_at: null,
      resolved_reason: null,
      metadata: {},
      created_at: '',
      updated_at: '',
    },
    {
      id: 5,
      severity: 'high',
      detected_at: '2026-06-19T09:00:00Z',
      event_type: 'ST',
      scope: 'symbol',
      status: 'open',
      symbol: 'D',
      signature: 's5',
      title: 'D',
      description: '',
      detail: {},
      scope_detail: {},
      source: 'detector_cron',
      resolved_at: null,
      resolved_reason: null,
      metadata: {},
      created_at: '',
      updated_at: '',
    },
  ];
  const sorted = sortBlackSwanEventsBySeverity(rows);
  assert(sorted[0].id === 2, '[T5] critical 内 detected_at DESC: id=2 (07:00) 先于 id=1 (05:00)');
  assert(sorted[1].id === 1, '[T5] 第二条 id=1');
  assert(sorted[2].id === 5, '[T5] high 第三');
  assert(sorted[3].id === 3, '[T5] low 最后');
  // 原数组不变
  assert(rows[0].id === 3, '[T5] 原数组未变更 (sort 拷贝)');

  // 同 severity 同 ts 时按 id 升序 (兜底稳定)
  const sameTs: any[] = [
    { id: 5, severity: 'critical', detected_at: '2026-06-19T10:00:00Z' },
    { id: 2, severity: 'critical', detected_at: '2026-06-19T10:00:00Z' },
    { id: 8, severity: 'critical', detected_at: '2026-06-19T10:00:00Z' },
  ];
  const sortedSame = sortBlackSwanEventsBySeverity(sameTs);
  assert(sortedSame[0].id === 2, '[T5 兜底] 同 severity+ts → id ASC');
  assert(sortedSame[1].id === 5, '[T5 兜底] 第二 id=5');
  assert(sortedSame[2].id === 8, '[T5 兜底] 第三 id=8');
}

// ---------------------------------------------------------------------------
// T6 — summarizeBlackSwanEvents 永远 4 档 + unknown
// ---------------------------------------------------------------------------
console.log('T6 — summarizeBlackSwanEvents');
{
  const empty = summarizeBlackSwanEvents([]);
  assert(empty.total === 0, '[T6 empty] total=0');
  assert(empty.critical === 0, '[T6 empty] critical=0');
  assert(empty.high === 0, '[T6 empty] high=0');
  assert(empty.medium === 0, '[T6 empty] medium=0');
  assert(empty.low === 0, '[T6 empty] low=0');
  assert(empty.unknown === 0, '[T6 empty] unknown=0');

  const mixed = summarizeBlackSwanEvents([
    { severity: 'critical' } as any,
    { severity: 'critical' } as any,
    { severity: 'high' } as any,
    { severity: 'medium' } as any,
    { severity: 'low' } as any,
    { severity: 'low' } as any,
    { severity: 'low' } as any,
    { severity: 'weird-future-enum' } as any,
  ]);
  assert(mixed.total === 8, '[T6 mixed] total=8');
  assert(mixed.critical === 2, '[T6 mixed] critical=2');
  assert(mixed.high === 1, '[T6 mixed] high=1');
  assert(mixed.medium === 1, '[T6 mixed] medium=1');
  assert(mixed.low === 3, '[T6 mixed] low=3');
  assert(mixed.unknown === 1, '[T6 mixed] unknown=1 (未来 enum 走 unknown 不丢)');

  // null severity 也归 unknown
  const nullCase = summarizeBlackSwanEvents([{ severity: null } as any, { severity: '' } as any]);
  assert(nullCase.unknown === 2, '[T6 null] null/空 严重度 → unknown');

  // null array 防御
  const nullArr = summarizeBlackSwanEvents(null as any);
  assert(nullArr.total === 0, '[T6 null] null array → total=0 不抛');
}

// ---------------------------------------------------------------------------
// T7 — computePostmortemSectionStatus 4 段完成度
// ---------------------------------------------------------------------------
console.log('T7 — computePostmortemSectionStatus');
{
  // null postmortem → 全 false
  const none = computePostmortemSectionStatus(null);
  assert(none.filled === 0, '[T7 null] filled=0');
  assert(none.total === 4, '[T7 null] total=4');
  assert(none.event_summary === false, '[T7 null] event_summary=false');

  // undefined 同款
  const u = computePostmortemSectionStatus(undefined);
  assert(u.filled === 0, '[T7 undef] filled=0');

  // 4 段全 {} 空对象 → 全 false (PR-012 jsdoc 默认 '{}'::jsonb 即未填)
  const empty = computePostmortemSectionStatus({
    event_summary: {},
    counterfactual_baselines: {},
    event_timeline: {},
    improvement_suggestions: {},
  });
  assert(empty.filled === 0, '[T7 empty {}] 4 段全 {} → filled=0');

  // 1 段已填 → filled=1
  const one = computePostmortemSectionStatus({
    event_summary: { event_type: 'ST', severity: 'high' },
    counterfactual_baselines: {},
    event_timeline: {},
    improvement_suggestions: {},
  });
  assert(one.filled === 1, '[T7 one] filled=1');
  assert(one.event_summary === true, '[T7 one] event_summary=true');
  assert(one.counterfactual_baselines === false, '[T7 one] counterfactual=false');

  // 4 段全填 → filled=4
  const full = computePostmortemSectionStatus({
    event_summary: { x: 1 },
    counterfactual_baselines: { baselines: [] },
    event_timeline: { timeline: [] },
    improvement_suggestions: { suggestions: [] },
  });
  assert(full.filled === 4, '[T7 full] filled=4');
  assert(full.event_summary === true, '[T7 full] all 4');
  assert(full.counterfactual_baselines === true, '[T7 full]');
  assert(full.event_timeline === true, '[T7 full]');
  assert(full.improvement_suggestions === true, '[T7 full]');

  // null 段 vs {} 段 同效 (都 false)
  const mixedNull = computePostmortemSectionStatus({
    event_summary: null as any,
    counterfactual_baselines: { foo: 'bar' },
    event_timeline: undefined as any,
    improvement_suggestions: null as any,
  });
  assert(mixedNull.filled === 1, '[T7 mixed null] 1 段填');
  assert(mixedNull.event_summary === false, '[T7 mixed null] null 段 false');
  assert(mixedNull.event_timeline === false, '[T7 mixed null] undef 段 false');
}

// ---------------------------------------------------------------------------
// T8 — META-GUARD fs+regex 守源码形态
// ---------------------------------------------------------------------------
console.log('T8 — META-GUARD: controller + routes + index.ts + tab + SettingsWorkspace + helper + service');
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

  // ---- frontend helper ----
  const helperSrc = fs.readFileSync(HELPER_PATH, 'utf-8');
  assert(/export const BLACK_SWAN_SEVERITY_ORDER/.test(helperSrc), 'helper export severity order');
  assert(/export const BLACK_SWAN_EVENT_TYPES/.test(helperSrc), 'helper export event types');
  assert(
    /export function computePostmortemSectionStatus/.test(helperSrc),
    'helper export computePostmortemSectionStatus'
  );
  assert(/Object\.freeze\(/.test(helperSrc), 'helper 用 Object.freeze 守常量');
  assert(/export function severityColor/.test(helperSrc), 'helper export severityColor');
  assert(/export function severityRank/.test(helperSrc), 'helper export severityRank');
  assert(
    /export function sortBlackSwanEventsBySeverity/.test(helperSrc),
    'helper export sortBlackSwanEventsBySeverity'
  );
  assert(
    /export function summarizeBlackSwanEvents/.test(helperSrc),
    'helper export summarizeBlackSwanEvents'
  );

  // ---- frontend tab ----
  const tabSrc = fs.readFileSync(TAB_PATH, 'utf-8');
  assert(/listBlackSwanEvents/.test(tabSrc), 'tab 调 listBlackSwanEvents');
  assert(/getBlackSwanEvent/.test(tabSrc), 'tab 调 getBlackSwanEvent');
  assert(/computePostmortemSectionStatus/.test(tabSrc), 'tab 调 computePostmortemSectionStatus');
  assert(/severityColor/.test(tabSrc), 'tab 用 severityColor');
  assert(/scopeLabel/.test(tabSrc), 'tab 用 scopeLabel');
  assert(/Drawer/.test(tabSrc), 'tab 有 Drawer (详情)');
  assert(/Tabs/.test(tabSrc), 'tab 详情用 Tabs 展示 4 段 postmortem');
  assert(
    /data-testid=['"]black-swan-event-list['"]/.test(tabSrc),
    'tab 含 data-testid black-swan-event-list'
  );
  assert(
    /data-testid=['"]black-swan-event-detail-drawer['"]/.test(tabSrc),
    'tab 含 data-testid black-swan-event-detail-drawer'
  );
  assert(
    /data-testid=['"]black-swan-filters['"]/.test(tabSrc),
    'tab 含 data-testid black-swan-filters'
  );
  // 4 段 tab key 都得 render
  assert(/event_summary/.test(tabSrc), 'tab 渲染 event_summary 段');
  assert(/counterfactual_baselines/.test(tabSrc), 'tab 渲染 counterfactual_baselines 段');
  assert(/event_timeline/.test(tabSrc), 'tab 渲染 event_timeline 段');
  assert(/improvement_suggestions/.test(tabSrc), 'tab 渲染 improvement_suggestions 段');
  assert(/export default BlackSwanHistoryTab/.test(tabSrc), 'tab default export');

  // ---- SettingsWorkspace.tsx 接入 ----
  const wsSrc = fs.readFileSync(SETTINGS_WS_PATH, 'utf-8');
  assert(
    /import\s+BlackSwanHistoryTab\s+from\s+['"]\.\/SettingsWorkspace\.BlackSwanHistoryTab['"]/.test(
      wsSrc
    ),
    'SettingsWorkspace import BlackSwanHistoryTab'
  );
  assert(
    /AlertOutlined/.test(wsSrc),
    'SettingsWorkspace 含 AlertOutlined icon import'
  );
  assert(
    /key:\s*['"]black-swan['"]/.test(wsSrc),
    "SettingsWorkspace tabs[] 含 key='black-swan'"
  );
  assert(
    /activeKey\s*===\s*['"]black-swan['"]/.test(wsSrc),
    'SettingsWorkspace 含 activeKey === black-swan 分支'
  );
  assert(
    /<BlackSwanHistoryTab\s*\/>/.test(wsSrc),
    'SettingsWorkspace render <BlackSwanHistoryTab />'
  );
  // headerActions 分支 (US-133 PR-018 tag)
  assert(
    /US-133.*PR-018/.test(wsSrc),
    'SettingsWorkspace headerActions 含 US-133 PR-018 tag'
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
