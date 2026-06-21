/**
 * AIDiaryService 单元测试 (US-090 [PM-019]).
 *
 * 不依赖 jest / DB / 网络; node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/postmortem/ai-diary-service.test.ts
 *
 * 覆盖维度:
 *   [1] 常量 sanity (MAX_CHARS=500 / MIN_CHARS / ENDPOINT / TIMEOUT / source / status 枚举)
 *   [2] buildDiaryPrompt — 含 MAX / 含 date / 含 total_pnl / 缺维度不强提 / 称呼回退
 *   [3] enforceDiaryConstraints — AC 主验收:
 *       (a) 合规返 ok=true (b) 超 cap 自动截断 + … (c) 太短返 too_short_*
 *       (d) null 返 not_string (e) 空白 returns empty (f) 多重空白合并
 *   [4] heuristicDiary — 永远 ≤ MAX + 含数字 + 各种边界 ctx 不崩
 *   [5] buildDiaryEvidence / buildDataSourcesList — 字段映射
 *   [6] generateForUser — AC 主验收 (PRD US-090 "每日生成"):
 *       (a) no context → skipped + 落留痕 (b) LLM 合规 → ok + source=llm
 *       (c) LLM 返空 → ok + source=heuristic + reason=empty
 *       (d) LLM throw → ok + source=heuristic + reason=llm_threw
 *       (e) LLM 返 null → ok + source=heuristic + reason=llm_returned_null
 *       (f) 无 LLM source → ok + source=heuristic + reason=no_llm_source
 *       (g) upsert 失败 → failed + persisted=false (主入口不 throw)
 *       (h) loadContext throw → skipped + persisted=false
 *       (i) cron_run_id 流入 metadata
 *   [7] mapAttributionRowToContext — 缺字段降级不抛
 *   [8] PRODUCTION LLM source / DataSource factory — 不抛 (lazy require)
 *   [9] META-GUARD fs+regex
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  AI_DIARY_MAX_CHARS,
  AI_DIARY_MIN_CHARS,
  AI_DIARY_ENDPOINT,
  AI_DIARY_TIMEOUT_MS,
  AI_DIARY_SOURCE,
  AI_DIARY_STATUS,
  buildDiaryPrompt,
  enforceDiaryConstraints,
  heuristicDiary,
  buildDiaryEvidence,
  buildDataSourcesList,
  generateForUser,
  mapAttributionRowToContext,
  createProductionAIDiaryLLMSource,
  createProductionAIDiaryDataSource,
  AIDiaryDataSource,
  AIDiaryLLMSource,
  AIDiaryUpsertRow,
  DiaryContext,
} from '../../src/services/postmortem/AIDiaryService';

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

function makeCtx(overrides: Partial<DiaryContext> = {}): DiaryContext {
  return {
    user_id: 7,
    date: '2026-06-19',
    daily_attribution_report_id: 42,
    total_pnl: 1500.5,
    total_pnl_pct: 1.5,
    trade_count: 5,
    buy_count: 2,
    sell_count: 3,
    best_trades_codes: ['600519', '000001'],
    worst_trades_codes: ['300750'],
    top_industries: [
      { industry: '白酒', pnl: 1000 },
      { industry: '银行', pnl: 500 },
    ],
    bias_findings_count: 1,
    user_name: '张三',
    ...overrides,
  };
}

(async () => {
  // ---- [1] 常量 sanity ------------------------------------------------------
  {
    assert('[1.1] MAX_CHARS = 500 (PRD AC)', AI_DIARY_MAX_CHARS === 500);
    assert('[1.2] MIN_CHARS > 0 < MAX', AI_DIARY_MIN_CHARS > 0 && AI_DIARY_MIN_CHARS < AI_DIARY_MAX_CHARS);
    assert('[1.3] ENDPOINT 形态合法', AI_DIARY_ENDPOINT.startsWith('/api/'));
    assert('[1.4] TIMEOUT 30s', AI_DIARY_TIMEOUT_MS === 30_000);
    assert('[1.5] SOURCE 枚举三态', AI_DIARY_SOURCE.LLM === 'llm' && AI_DIARY_SOURCE.HEURISTIC === 'heuristic' && AI_DIARY_SOURCE.MANUAL === 'manual');
    assert('[1.6] STATUS 枚举三态', AI_DIARY_STATUS.OK === 'ok' && AI_DIARY_STATUS.SKIPPED === 'skipped' && AI_DIARY_STATUS.FAILED === 'failed');
    assert('[1.7] SOURCE frozen', Object.isFrozen(AI_DIARY_SOURCE));
    assert('[1.8] STATUS frozen', Object.isFrozen(AI_DIARY_STATUS));
  }

  // ---- [2] buildDiaryPrompt -------------------------------------------------
  {
    const ctx = makeCtx();
    const p = buildDiaryPrompt(ctx);
    assert('[2.1] prompt 含 MAX_CHARS=500', p.includes('500'));
    assert('[2.2] prompt 含日期', p.includes('2026-06-19'));
    assert('[2.3] prompt 含 total_pnl', p.includes('1500.50'));
    assert('[2.4] prompt 含 行业', p.includes('白酒'));
    assert('[2.5] prompt 含 best 标的', p.includes('600519'));
    assert('[2.6] prompt 含 worst 标的', p.includes('300750'));
    assert('[2.7] prompt 含 称呼 张三', p.includes('张三'));
    assert('[2.8] prompt 含 bias 命中', p.includes('行为偏差命中: 1'));
    assert('[2.9] prompt 含 客观要求', p.includes('客观'));
  }
  {
    // 称呼回退 / 缺维度
    const ctx: DiaryContext = makeCtx({
      user_name: null,
      top_industries: [],
      best_trades_codes: [],
      worst_trades_codes: [],
      bias_findings_count: 0,
      total_pnl_pct: null,
    });
    const p = buildDiaryPrompt(ctx);
    assert('[2.10] user_name=null → "操盘手" 回退', p.includes('操盘手'));
    assert('[2.11] 缺行业不强提 "行业贡献"', !p.includes('行业贡献:'));
    assert('[2.12] 缺 best 不强提', !p.includes('盈利标的:'));
    assert('[2.13] 缺 worst 不强提', !p.includes('亏损标的:'));
    assert('[2.14] bias=0 不强提', !p.includes('行为偏差命中:'));
    assert('[2.15] pct=null 不输出 %', !/\(.+%\)/.test(p));
  }

  // ---- [3] enforceDiaryConstraints -----------------------------------------
  {
    const ok = enforceDiaryConstraints('今日盈利 1500 元, 主因白酒板块拉升, 复盘下来纪律执行到位.');
    assert('[3.a.1] 合规 ok=true', ok.ok === true);
    assert('[3.a.2] text 非空', !!ok.text);
    assert('[3.a.3] reason=null', ok.reason === null);
  }
  {
    // 超 cap 截断
    const long = '盈亏复盘 ' + 'a'.repeat(600);
    const r = enforceDiaryConstraints(long);
    assert('[3.b.1] 超 cap ok=true', r.ok === true);
    assert(
      '[3.b.2] 截到 ≤ MAX',
      r.text != null && Array.from(r.text).length <= AI_DIARY_MAX_CHARS
    );
    assert('[3.b.3] 末尾 …', r.text != null && r.text.endsWith('…'));
  }
  {
    // 太短
    const r = enforceDiaryConstraints('今日平稳');
    assert('[3.c.1] 太短 ok=false', r.ok === false);
    assert('[3.c.2] reason 含 too_short_', (r.reason || '').startsWith('too_short_'));
  }
  {
    // null
    const r = enforceDiaryConstraints(null);
    assert('[3.d.1] null ok=false', r.ok === false);
    assert('[3.d.2] reason=not_string', r.reason === 'not_string');
  }
  {
    // 空白
    const r = enforceDiaryConstraints('   ');
    assert('[3.e.1] 空白 ok=false', r.ok === false);
    assert('[3.e.2] reason=empty', r.reason === 'empty');
  }
  {
    // 多重空白合并
    const r = enforceDiaryConstraints('今日\t\t盈利   1500\n\n 元 主因  白酒板块拉升, 复盘到位.');
    assert('[3.f.1] ok=true', r.ok === true);
    assert(
      '[3.f.2] 多重空白合并',
      r.text != null && !r.text.includes('  ') && !r.text.includes('\t') && !r.text.includes('\n')
    );
  }
  {
    // 恰好 MIN_CHARS 不算 too_short
    const exact = 'x'.repeat(AI_DIARY_MIN_CHARS);
    const r = enforceDiaryConstraints(exact);
    assert('[3.g.1] 恰好 MIN ok=true', r.ok === true);
  }
  {
    // MAX 边界
    const exact = 'x'.repeat(AI_DIARY_MAX_CHARS);
    const r = enforceDiaryConstraints(exact);
    assert('[3.g.2] 恰好 MAX 不截', r.ok === true && r.text === exact);
    const over = exact + 'y';
    const r2 = enforceDiaryConstraints(over);
    assert(
      '[3.g.3] MAX+1 截到 MAX',
      r2.ok === true &&
        r2.text != null &&
        Array.from(r2.text).length === AI_DIARY_MAX_CHARS
    );
  }

  // ---- [4] heuristicDiary ---------------------------------------------------
  {
    const cases: DiaryContext[] = [
      makeCtx(),
      makeCtx({ total_pnl: 0, total_pnl_pct: 0 }),
      makeCtx({ total_pnl: -3000, total_pnl_pct: -3.5 }),
      makeCtx({ top_industries: [], best_trades_codes: [], worst_trades_codes: [], bias_findings_count: 0, user_name: null }),
      makeCtx({
        top_industries: Array.from({ length: 50 }, (_, i) => ({ industry: `行业${i}`, pnl: i * 100 })),
        best_trades_codes: Array.from({ length: 20 }, (_, i) => `S${i}`),
      }),
      makeCtx({ total_pnl_pct: null }),
    ];
    cases.forEach((c, i) => {
      const t = heuristicDiary(c);
      assert(
        `[4.${i + 1}.a] heuristic ≤ MAX`,
        Array.from(t).length <= AI_DIARY_MAX_CHARS,
        `len=${Array.from(t).length}`
      );
      assert(`[4.${i + 1}.b] heuristic 含日期`, t.includes(c.date));
      assert(`[4.${i + 1}.c] heuristic 含 总盈亏 keyword`, t.includes('当日盈亏'));
    });
  }

  // ---- [5] buildDiaryEvidence / buildDataSourcesList -----------------------
  {
    const ctx = makeCtx();
    const e = buildDiaryEvidence(ctx);
    assert('[5.1] evidence 含 daily_attribution_report_id=42', e.daily_attribution_report_id === 42);
    assert('[5.2] evidence 含 total_pnl', (e as any).total_pnl === 1500.5);
    assert('[5.3] evidence 含 best_trades_codes ≤ 3', Array.isArray((e as any).best_trades_codes) && (e as any).best_trades_codes.length <= 3);
    assert('[5.4] evidence 含 data_sources[]', Array.isArray((e as any).data_sources));
    const ds = buildDataSourcesList(ctx);
    assert('[5.5] data_sources 含 attribution', ds.includes('attribution'));
    assert('[5.6] data_sources 含 bias', ds.includes('bias'));
    assert('[5.7] data_sources 含 industry', ds.includes('industry'));
    assert('[5.8] data_sources 含 trades', ds.includes('trades'));
  }
  {
    // 全空 ctx → data_sources=[]
    const ctx = makeCtx({
      daily_attribution_report_id: null,
      best_trades_codes: [],
      worst_trades_codes: [],
      top_industries: [],
      bias_findings_count: 0,
    });
    const ds = buildDataSourcesList(ctx);
    assert('[5.9] 全空 ctx data_sources=[]', ds.length === 0);
  }
  {
    // best 截到 ≤ 3
    const ctx = makeCtx({
      best_trades_codes: ['a', 'b', 'c', 'd', 'e'],
    });
    const e = buildDiaryEvidence(ctx);
    assert('[5.10] best_trades_codes 截 3', (e as any).best_trades_codes.length === 3);
  }

  // ---- [6] generateForUser — AC 主验收 -------------------------------------
  function makeFakeDs(
    ctx: DiaryContext | null,
    upsertOk = true,
    upsertReason?: string,
    upsertThrow = false,
    loadThrow = false
  ): { ds: AIDiaryDataSource; upserts: AIDiaryUpsertRow[] } {
    const upserts: AIDiaryUpsertRow[] = [];
    const ds: AIDiaryDataSource = {
      async loadDiaryContext() {
        if (loadThrow) throw new Error('boom load');
        return ctx;
      },
      async upsertDiaryEntry(row) {
        upserts.push(row);
        if (upsertThrow) throw new Error('boom upsert');
        return upsertOk ? { ok: true } : { ok: false, reason: upsertReason };
      },
    };
    return { ds, upserts };
  }
  {
    // (a) no context → skipped + 留痕
    const { ds, upserts } = makeFakeDs(null);
    const r = await generateForUser(7, { date: '2026-06-19', data_source: ds });
    assert('[6.a.1] status=skipped', r.status === AI_DIARY_STATUS.SKIPPED);
    assert('[6.a.2] reason=no_attribution_today', r.reason === 'no_attribution_today');
    assert('[6.a.3] text=""', r.text === '');
    assert('[6.a.4] persisted=true', r.persisted === true);
    assert('[6.a.5] upsert 调用 1 次留痕', upserts.length === 1);
    assert('[6.a.6] 留痕 status=skipped', upserts[0].status === 'skipped');
    assert('[6.a.7] 留痕 source=heuristic', upserts[0].source === 'heuristic');
  }
  {
    // (b) LLM 合规 → ok + source=llm
    const { ds, upserts } = makeFakeDs(makeCtx());
    const llm: AIDiaryLLMSource = {
      async callLLMDiary() {
        return '今日盈利 1500 元, 主因白酒板块拉升, 复盘下来纪律执行到位, 经验教训: 持续盯紧主线.';
      },
    };
    const r = await generateForUser(7, { date: '2026-06-19', data_source: ds, llm_source: llm });
    assert('[6.b.1] status=ok', r.status === AI_DIARY_STATUS.OK);
    assert('[6.b.2] source=llm', r.source === AI_DIARY_SOURCE.LLM);
    assert('[6.b.3] reason=null', r.reason === null);
    assert('[6.b.4] persisted=true', r.persisted === true);
    assert('[6.b.5] text 含 1500', r.text.includes('1500'));
    assert('[6.b.6] text ≤ MAX', Array.from(r.text).length <= AI_DIARY_MAX_CHARS);
    assert('[6.b.7] upsert source=llm', upserts[0].source === 'llm');
    assert('[6.b.8] upsert text == r.text', upserts[0].text === r.text);
    assert(
      '[6.b.9] upsert metadata 含 llm_latency_ms',
      typeof (upserts[0].metadata as any).llm_latency_ms === 'number'
    );
    assert(
      '[6.b.10] upsert metadata 含 llm_engine',
      (upserts[0].metadata as any).llm_engine === 'trading_agents'
    );
    assert(
      '[6.b.11] upsert evidence 含 daily_attribution_report_id=42',
      (upserts[0].evidence as any).daily_attribution_report_id === 42
    );
  }
  {
    // (c) LLM 返空 → ok + heuristic + reason=empty
    const { ds, upserts } = makeFakeDs(makeCtx());
    const llm: AIDiaryLLMSource = {
      async callLLMDiary() {
        return '';
      },
    };
    const r = await generateForUser(7, { date: '2026-06-19', data_source: ds, llm_source: llm });
    assert('[6.c.1] status=ok', r.status === AI_DIARY_STATUS.OK);
    assert('[6.c.2] source=heuristic', r.source === AI_DIARY_SOURCE.HEURISTIC);
    assert('[6.c.3] reason=empty', r.reason === 'empty');
    assert('[6.c.4] persisted=true', r.persisted === true);
    assert(
      '[6.c.5] metadata.heuristic_fallback_reason=empty',
      (upserts[0].metadata as any).heuristic_fallback_reason === 'empty'
    );
  }
  {
    // (d) LLM throw → ok + heuristic + reason=llm_threw
    const { ds, upserts } = makeFakeDs(makeCtx());
    const llm: AIDiaryLLMSource = {
      async callLLMDiary() {
        throw new Error('boom');
      },
    };
    const r = await generateForUser(7, { date: '2026-06-19', data_source: ds, llm_source: llm });
    assert('[6.d.1] status=ok', r.status === AI_DIARY_STATUS.OK);
    assert('[6.d.2] source=heuristic', r.source === AI_DIARY_SOURCE.HEURISTIC);
    assert('[6.d.3] reason=llm_threw', r.reason === 'llm_threw');
    assert('[6.d.4] persisted=true', r.persisted === true);
    assert(
      '[6.d.5] metadata.heuristic_fallback_reason=llm_threw',
      (upserts[0].metadata as any).heuristic_fallback_reason === 'llm_threw'
    );
  }
  {
    // (e) LLM 返 null → ok + heuristic + reason=llm_returned_null
    const { ds } = makeFakeDs(makeCtx());
    const llm: AIDiaryLLMSource = {
      async callLLMDiary() {
        return null;
      },
    };
    const r = await generateForUser(7, { date: '2026-06-19', data_source: ds, llm_source: llm });
    assert('[6.e.1] status=ok', r.status === AI_DIARY_STATUS.OK);
    assert('[6.e.2] source=heuristic', r.source === AI_DIARY_SOURCE.HEURISTIC);
    assert('[6.e.3] reason=llm_returned_null', r.reason === 'llm_returned_null');
  }
  {
    // (f) 无 LLM source → ok + heuristic + reason=no_llm_source
    const { ds, upserts } = makeFakeDs(makeCtx());
    const r = await generateForUser(7, { date: '2026-06-19', data_source: ds });
    assert('[6.f.1] status=ok', r.status === AI_DIARY_STATUS.OK);
    assert('[6.f.2] source=heuristic', r.source === AI_DIARY_SOURCE.HEURISTIC);
    assert('[6.f.3] reason=no_llm_source', r.reason === 'no_llm_source');
    assert('[6.f.4] persisted=true', r.persisted === true);
    assert(
      '[6.f.5] heuristic 含 date',
      upserts[0].text.includes('2026-06-19')
    );
  }
  {
    // (g) upsert 失败返 ok=false → failed + persisted=false
    const { ds } = makeFakeDs(makeCtx(), false, 'persist_failed');
    const r = await generateForUser(7, { date: '2026-06-19', data_source: ds });
    assert('[6.g.1] status=failed', r.status === AI_DIARY_STATUS.FAILED);
    assert('[6.g.2] reason=persist_failed', r.reason === 'persist_failed');
    assert('[6.g.3] persisted=false', r.persisted === false);
    assert('[6.g.4] text 仍 = heuristic 非空', r.text.length > 0);
  }
  {
    // (g2) upsert throw → 主入口不抛, 仍 failed + persisted=false
    const { ds } = makeFakeDs(makeCtx(), true, undefined, true);
    let threw = false;
    let r;
    try {
      r = await generateForUser(7, { date: '2026-06-19', data_source: ds });
    } catch {
      threw = true;
    }
    assert('[6.g.5] upsert throw 主入口不抛', !threw);
    assert('[6.g.6] r.status=failed', !!r && r.status === AI_DIARY_STATUS.FAILED);
    assert('[6.g.7] r.persisted=false', !!r && r.persisted === false);
    assert('[6.g.8] r.reason=upsert_threw', !!r && r.reason === 'upsert_threw');
  }
  {
    // (h) loadContext throw → skipped + persisted=false + 不抛
    const { ds, upserts } = makeFakeDs(makeCtx(), true, undefined, false, true);
    let threw = false;
    let r;
    try {
      r = await generateForUser(7, { date: '2026-06-19', data_source: ds });
    } catch {
      threw = true;
    }
    assert('[6.h.1] loadContext throw 主入口不抛', !threw);
    assert('[6.h.2] status=skipped', !!r && r.status === AI_DIARY_STATUS.SKIPPED);
    assert('[6.h.3] reason=load_context_threw', !!r && r.reason === 'load_context_threw');
    assert('[6.h.4] persisted=false', !!r && r.persisted === false);
    assert('[6.h.5] load throw 不写留痕 (无 ctx 无 evidence)', upserts.length === 0);
  }
  {
    // (i) cron_run_id 流入 metadata
    const { ds, upserts } = makeFakeDs(makeCtx());
    await generateForUser(7, {
      date: '2026-06-19',
      data_source: ds,
      cron_run_id: 'cron-2026-06-19-T18',
    });
    assert(
      '[6.i.1] metadata.cron_run_id 落库',
      (upserts[0].metadata as any).cron_run_id === 'cron-2026-06-19-T18'
    );
  }

  // ---- [7] mapAttributionRowToContext --------------------------------------
  {
    const row = {
      id: 42,
      date: '2026-06-19',
      total_pnl: 1500.5,
      total_pnl_pct: 1.5,
      trade_count: 5,
      buy_count: 2,
      sell_count: 3,
      breakdown: {
        industry_contrib: [
          { industry: '白酒', pnl: 1000 },
          { industry: '银行', pnl: 500 },
          { industry: '半导体', pnl: -200 },
          { industry: '钢铁', pnl: 100 }, // 超 3 个, 应被截
        ],
      },
      best_trades: [{ symbol: '600519' }, { symbol: '000001' }],
      worst_trades: [{ symbol: '300750' }],
      bias_findings: [{ kind: 'chasing_high' }, { kind: 'overtrading' }],
    };
    const ctx = mapAttributionRowToContext(row, 7, '张三');
    assert('[7.1] id 映射', ctx.daily_attribution_report_id === 42);
    assert('[7.2] total_pnl 映射', ctx.total_pnl === 1500.5);
    assert('[7.3] industries 截 3', ctx.top_industries.length === 3);
    assert('[7.4] best codes', ctx.best_trades_codes.length === 2 && ctx.best_trades_codes[0] === '600519');
    assert('[7.5] worst codes', ctx.worst_trades_codes.length === 1);
    assert('[7.6] bias count', ctx.bias_findings_count === 2);
    assert('[7.7] user_name', ctx.user_name === '张三');
  }
  {
    // 缺字段降级 — 全 undefined / null 应不抛, 走 0 / [] / null 默认
    const ctx = mapAttributionRowToContext({ date: '2026-06-19' }, 7, null);
    assert('[7.8] 缺 breakdown 不抛, industries=[]', ctx.top_industries.length === 0);
    assert('[7.9] 缺 best_trades industry=[]', ctx.best_trades_codes.length === 0);
    assert('[7.10] 缺 total_pnl → 0', ctx.total_pnl === 0);
    assert('[7.11] 缺 id → null', ctx.daily_attribution_report_id === null);
    assert('[7.12] 缺 total_pnl_pct → null', ctx.total_pnl_pct === null);
    assert('[7.13] 缺 user_name → null', ctx.user_name === null);
    assert('[7.14] 缺 bias → 0', ctx.bias_findings_count === 0);
  }

  // ---- [8] PRODUCTION factories — 不抛 -------------------------------------
  {
    const llm = createProductionAIDiaryLLMSource();
    // 没真 endpoint, fail-OPEN 返 null (不抛)
    const r = await llm.callLLMDiary('test');
    assert('[8.1] PRODUCTION callLLMDiary 不抛, 返 null', r === null);
  }
  {
    const ds = createProductionAIDiaryDataSource();
    // 没 DB 连接, fail-OPEN 返 null + ok=false (不抛)
    const ctx = await ds.loadDiaryContext({ user_id: 7, date: '2026-06-19' });
    assert('[8.2] PRODUCTION loadDiaryContext 不抛, 返 null', ctx === null);
    const u = await ds.upsertDiaryEntry({
      user_id: 7,
      date: '2026-06-19',
      text: 'x',
      evidence: {},
      source: 'heuristic',
      status: 'ok',
      reason: null,
      metadata: {},
      generated_at: new Date(),
    });
    assert('[8.3] PRODUCTION upsertDiaryEntry 不抛, 返 ok=false', u.ok === false);
  }

  // ---- [9] META-GUARD fs+regex ---------------------------------------------
  {
    const helperPath = join(
      __dirname,
      '../../src/services/postmortem/AIDiaryService.ts'
    );
    const src = readFileSync(helperPath, 'utf8');
    assert('[9.1] 含 export generateForUser', /export\s+async\s+function\s+generateForUser/.test(src));
    assert('[9.2] 含 export buildDiaryPrompt', /export\s+function\s+buildDiaryPrompt/.test(src));
    assert('[9.3] 含 export enforceDiaryConstraints', /export\s+function\s+enforceDiaryConstraints/.test(src));
    assert('[9.4] 含 export heuristicDiary', /export\s+function\s+heuristicDiary/.test(src));
    assert('[9.5] 含 export buildDiaryEvidence', /export\s+function\s+buildDiaryEvidence/.test(src));
    assert('[9.6] 含 export createProductionAIDiaryLLMSource', /export\s+function\s+createProductionAIDiaryLLMSource/.test(src));
    assert('[9.7] 含 export createProductionAIDiaryDataSource', /export\s+function\s+createProductionAIDiaryDataSource/.test(src));
    assert('[9.8] 含 PM-019 / US-090 标识', /PM-019|US-090/.test(src));
    assert('[9.9] 含 fail-OPEN 注释', /fail-OPEN/.test(src));
    assert('[9.10] 含 PRODUCTION 单例 export', /PRODUCTION_AI_DIARY_DATA_SOURCE/.test(src));
    // helper 反向 — 不能 inline import AIDiaryEntry (lazy require 才对)
    assert(
      '[9.11] helper 不 inline import AIDiaryEntry (须 lazy require)',
      !/from\s+['"][.\/]+models\/AIDiaryEntry['"]/.test(src)
    );
    assert(
      '[9.12] helper 不 inline import DailyAttributionReport',
      !/from\s+['"][.\/]+models\/DailyAttributionReport['"]/.test(src)
    );
  }

  // ---- summary --------------------------------------------------------------
  console.log(`\nai-diary-service: ${passed} ok / ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
