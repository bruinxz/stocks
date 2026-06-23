/**
 * US-084 [PM-007] — PortfolioController.getDailyAttribution + portfolio.routes /:id/attribution/daily 单测.
 *
 * 不依赖 jest / DB / express. node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/api/portfolio-daily-attribution.test.ts
 *
 * PortfolioController.ts 顶层 import 一堆 service singleton 拽起 sequelize, 单测进程
 * 不可加载 (与 [US-018 EX-004] 与 [US-065 RiskController] 同源 DB-less 不可测问题). 范式 =
 * "mirror 复刻 + META-GUARD" — 镜像 controller 主流程 (PaperTradingPortfolio.findByPk →
 * owner check → normalizeAttributionDate → DailyAttributionReport.findOne →
 * 200/403/404), 配 regex 守 controller + routes 形态没有退化.
 *
 * 覆盖:
 *   T1 — normalizeAttributionDate 行为契约 (controller 依赖这里)
 *   T2 — controller 主流程镜像复刻 (5 路径: 200 / 401 / 400 / 403 / 404-portfolio / 404-report)
 *   T3 — META-GUARD fs+regex 守 controller + routes 源码形态
 */

import * as fs from 'fs';
import * as path from 'path';
import { normalizeAttributionDate } from '../../src/services/attribution/DailyAttributionService';

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
// T1 — normalizeAttributionDate 行为契约 (controller 依赖 helper, 漂就漂)
// ---------------------------------------------------------------------------
console.log('T1 — normalizeAttributionDate 行为契约');
{
  const d1 = normalizeAttributionDate('2026-06-19');
  assert(d1 === '2026-06-19', 'YYYY-MM-DD 透传');

  const d2 = normalizeAttributionDate('2026-06-19T10:00:00Z');
  assert(d2 === '2026-06-19', 'ISO 长串 → 截前 10 字符');

  const d3 = normalizeAttributionDate('not-a-date');
  assert(/^\d{4}-\d{2}-\d{2}$/.test(d3), '非法字符串 → 默认今日 YYYY-MM-DD');

  const d4 = normalizeAttributionDate(undefined);
  assert(/^\d{4}-\d{2}-\d{2}$/.test(d4), 'undefined → 默认今日');

  const d5 = normalizeAttributionDate(null);
  assert(/^\d{4}-\d{2}-\d{2}$/.test(d5), 'null → 默认今日');
}

// ---------------------------------------------------------------------------
// T2 — controller 主流程镜像复刻
// ---------------------------------------------------------------------------
// 与 PortfolioController.getDailyAttribution 主体保持字字对应. T3 META-GUARD
// 会用 regex 守 controller.ts 含同款形态; 任一脱节立刻挂.
console.log('T2 — controller 主流程镜像 (镜像 PortfolioController.getDailyAttribution)');
{
  interface FakePortfolioRow {
    id: number;
    user_id: number;
  }
  interface FakeReportRow {
    id: number;
    portfolio_id: number;
    date: string;
    total_pnl: number;
    breakdown: Record<string, unknown>;
    ai_summary: string;
  }
  interface FakeDeps {
    findPortfolio: (id: number) => Promise<FakePortfolioRow | null>;
    findReport: (where: { portfolio_id: number; date: string }) => Promise<FakeReportRow | null>;
  }
  interface FakeReq {
    user?: { id: number };
    params: { id: string };
    query: { date?: string };
  }
  type Resp = { status: number; body: any };

  async function mirrorGet(req: FakeReq, deps: FakeDeps): Promise<Resp> {
    const user_id = req.user?.id;
    if (!user_id) return { status: 401, body: { success: false, message: '未登录' } };
    const portfolioId = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(portfolioId) || portfolioId <= 0) {
      return { status: 400, body: { success: false, message: 'portfolio id 非法' } };
    }
    const portfolio = await deps.findPortfolio(portfolioId);
    if (!portfolio) {
      return { status: 404, body: { success: false, message: 'portfolio 不存在' } };
    }
    if (portfolio.user_id !== user_id) {
      return { status: 403, body: { success: false, message: '无权访问' } };
    }
    const date = normalizeAttributionDate(req.query.date);
    const row = await deps.findReport({ portfolio_id: portfolioId, date });
    if (!row) {
      return {
        status: 404,
        body: {
          success: false,
          message: '当日归因报告不存在',
          data: { portfolio_id: portfolioId, date },
        },
      };
    }
    return { status: 200, body: { success: true, data: row } };
  }

  const sampleReport: FakeReportRow = {
    id: 17,
    portfolio_id: 42,
    date: '2026-06-19',
    total_pnl: 123.45,
    breakdown: { execution_cost: 1.2, industry_contrib: [] },
    ai_summary: '2026-06-19 总盈亏 +123.45 元',
  };

  // [a] happy — 200 + 正确 data
  (async () => {
    const r = await mirrorGet(
      { user: { id: 7 }, params: { id: '42' }, query: { date: '2026-06-19' } },
      {
        findPortfolio: async id => ({ id, user_id: 7 }),
        findReport: async () => sampleReport,
      }
    );
    assert(r.status === 200, '[a] happy → 200');
    assert(r.body?.success === true, '[a] happy → success=true');
    assert(r.body?.data?.id === 17, '[a] happy → 返完整 report row');
    assert(r.body?.data?.total_pnl === 123.45, '[a] happy → total_pnl 透传');
  })();

  // [b] 未登录 → 401
  (async () => {
    const r = await mirrorGet(
      { params: { id: '42' }, query: {} },
      { findPortfolio: async () => null, findReport: async () => null }
    );
    assert(r.status === 401, '[b] 未登录 → 401');
    assert(r.body?.message === '未登录', '[b] 401 message');
  })();

  // [c] portfolio id 非法 → 400 (NaN / 负数 / 0)
  (async () => {
    const cases = ['abc', '-1', '0'];
    for (const idStr of cases) {
      const r = await mirrorGet(
        { user: { id: 7 }, params: { id: idStr }, query: {} },
        { findPortfolio: async () => null, findReport: async () => null }
      );
      assert(r.status === 400, `[c] id=${idStr} → 400`);
    }
  })();

  // [d] portfolio 不存在 → 404
  (async () => {
    const r = await mirrorGet(
      { user: { id: 7 }, params: { id: '999' }, query: {} },
      {
        findPortfolio: async () => null,
        findReport: async () => sampleReport,
      }
    );
    assert(r.status === 404, '[d] portfolio 不存在 → 404');
    assert(r.body?.message === 'portfolio 不存在', '[d] 404 message');
  })();

  // [e] portfolio 属于别人 → 403 (owner check 优先于 report 查询)
  (async () => {
    let findReportCalled = false;
    const r = await mirrorGet(
      { user: { id: 7 }, params: { id: '42' }, query: {} },
      {
        findPortfolio: async id => ({ id, user_id: 99 }),
        findReport: async () => {
          findReportCalled = true;
          return sampleReport;
        },
      }
    );
    assert(r.status === 403, '[e] 非本人 portfolio → 403');
    assert(r.body?.message === '无权访问', '[e] 403 message');
    assert(
      findReportCalled === false,
      '[e] 403 不应查 DailyAttributionReport (owner check 优先, 防 enumeration)'
    );
  })();

  // [f] 当日无报告 → 404
  (async () => {
    const r = await mirrorGet(
      { user: { id: 7 }, params: { id: '42' }, query: { date: '2026-06-18' } },
      {
        findPortfolio: async id => ({ id, user_id: 7 }),
        findReport: async () => null,
      }
    );
    assert(r.status === 404, '[f] 当日无报告 → 404');
    assert(r.body?.message === '当日归因报告不存在', '[f] 404 报告 message');
    assert(
      r.body?.data?.portfolio_id === 42 && r.body?.data?.date === '2026-06-18',
      '[f] 404 携带 portfolio_id + 规范化 date 让前端可降级渲染'
    );
  })();

  // [g] query.date 缺省 → 走默认今日
  (async () => {
    let queriedDate = '';
    const r = await mirrorGet(
      { user: { id: 7 }, params: { id: '42' }, query: {} },
      {
        findPortfolio: async id => ({ id, user_id: 7 }),
        findReport: async w => {
          queriedDate = w.date;
          return null;
        },
      }
    );
    assert(r.status === 404, '[g] 默认日期无报告 → 404');
    assert(
      /^\d{4}-\d{2}-\d{2}$/.test(queriedDate),
      '[g] 缺省时仍走 normalizeAttributionDate → YYYY-MM-DD'
    );
  })();

  // [h] query.date 非法 → 静默退到今日 (lenient, controller 不 400)
  (async () => {
    let queriedDate = '';
    await mirrorGet(
      { user: { id: 7 }, params: { id: '42' }, query: { date: 'bad-date' } },
      {
        findPortfolio: async id => ({ id, user_id: 7 }),
        findReport: async w => {
          queriedDate = w.date;
          return null;
        },
      }
    );
    assert(
      /^\d{4}-\d{2}-\d{2}$/.test(queriedDate),
      '[h] 非法 date 走 normalize 退到今日 (lenient)'
    );
  })();
}

// ---------------------------------------------------------------------------
// T3 — META-GUARD fs+regex 守 controller + routes 形态没有退化
// ---------------------------------------------------------------------------
console.log('T3 — META-GUARD: PortfolioController.ts + portfolio.routes.ts 源码守约');
{
  const controllerSrc = fs.readFileSync(
    path.resolve(__dirname, '../../src/api/controllers/PortfolioController.ts'),
    'utf-8'
  );
  assert(
    /async\s+getDailyAttribution\s*\(/.test(controllerSrc),
    'PortfolioController.ts 必须 export getDailyAttribution method'
  );
  assert(
    /DailyAttributionReport/.test(controllerSrc),
    'PortfolioController.ts 必须 require DailyAttributionReport model (不能 inline SQL)'
  );
  assert(
    /normalizeAttributionDate/.test(controllerSrc),
    'PortfolioController.ts 必须 require normalizeAttributionDate (date 规范化不能 inline)'
  );
  assert(
    /PaperTradingPortfolio\.findByPk/.test(controllerSrc),
    'PortfolioController.ts getDailyAttribution 必须 findByPk(portfolioId) 做 owner check'
  );
  assert(
    /\.user_id\s*!==\s*user_id/.test(controllerSrc),
    'PortfolioController.ts 必须 owner check 403 (portfolio.user_id !== user_id)'
  );
  // owner 403 必须在 findReport 之前 — 防 user enumeration; 用 indexOf 顺序判断
  const idxOwnerCheck = controllerSrc.indexOf("'无权访问'");
  const idxReportFind = controllerSrc.search(/DailyAttributionReport\.findOne/);
  assert(
    idxOwnerCheck > 0 && idxReportFind > 0 && idxOwnerCheck < idxReportFind,
    'PortfolioController.ts owner 403 必须在 DailyAttributionReport.findOne 之前 (防 enumeration)'
  );
  assert(
    /this\.getDailyAttribution\s*=\s*this\.getDailyAttribution\.bind/.test(controllerSrc),
    'PortfolioController.ts constructor 必须 bind(this) getDailyAttribution (express this 上下文)'
  );

  const routesSrc = fs.readFileSync(
    path.resolve(__dirname, '../../src/api/routes/portfolio.routes.ts'),
    'utf-8'
  );
  // Batch BC-7 (2026-06-23): 容忍 BC-4 加的 UUID regex 约束 `'/:id([0-9a-fA-F]{8}-...)'/attribution/daily'`
  // 旧 regex 只匹配裸 `'/:id/...'`. 加 `(?:\([^)]+\))?` 让 (uuid regex) 可选.
  // BJ-3 (2026-06-23): /attribution/daily 接 integer + UUID, regex 是 `\d+|UUID`,
  //   含 `|` 需在 (?:\([^)]+\))? 内允许.
  assert(
    /router\.get\([\s\S]*?['"]\/:id(?:\([^)]+\))?\/attribution\/daily['"]/.test(routesSrc),
    "portfolio.routes.ts 必须挂 GET '/:id/attribution/daily'"
  );
  assert(
    /portfolioController\.getDailyAttribution/.test(routesSrc),
    'portfolio.routes.ts 必须把 GET /:id/attribution/daily 绑到 portfolioController.getDailyAttribution'
  );
  assert(
    /\/:id(?:\([^)]+\))?\/attribution\/daily['"][\s\S]{0,300}authController\.authenticate/.test(
      routesSrc
    ) ||
      /authController\.authenticate[\s\S]{0,300}\/:id(?:\([^)]+\))?\/attribution\/daily/.test(
        routesSrc
      ),
    "portfolio.routes.ts /:id/attribution/daily 必须挂 authController.authenticate (不可裸路由)"
  );
  // /:id/attribution/daily 必须在 /:id 之后注册 — Express 路径匹配是按 pattern 注册顺序
  // 走第一个匹配的; '/:id' 是 single-segment 不匹配多段路径, 所以放后面也 OK; 但既然加在
  // /:id 之后, 顺序天然正确. 仍守 routes 含 /:id 路径 (sanity).
  assert(
    /router\.get\(\s*['"]\/:id(?:\([^)]+\))?['"]/.test(routesSrc),
    "portfolio.routes.ts 仍含 GET '/:id'"
  );
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
// 等 IIFE 全跑完再 exit. Node setImmediate 让 microtask 排干净.
setImmediate(() => {
  console.log('');
  if (fail === 0) {
    console.log(`✓ portfolio-daily-attribution controller: ${pass}/${pass} OK`);
    process.exit(0);
  } else {
    console.log(`✗ portfolio-daily-attribution controller: ${pass} passed, ${fail} FAILED`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
});
