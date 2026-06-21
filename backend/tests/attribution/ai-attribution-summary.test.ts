/**
 * AIAttributionSummary 单元测试 (US-082 [PM-005]).
 *
 * 不依赖 jest / DB / 网络; node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/attribution/ai-attribution-summary.test.ts
 *
 * 覆盖维度:
 *   [1] 常量 sanity (cap / min numbers / endpoint / timeout)
 *   [2] countNumericTokens (整数 / 浮点 / 负数 / 空 / null / 中文混排)
 *   [3] buildAttributionSummaryPrompt (含 MAX_CHARS / 含 MIN_NUMBERS / 含
 *       日期 / 含 total_pnl / 缺维度不强提)
 *   [4] enforceAttributionSummaryConstraints — AC 主验收:
 *       (a) 合规返 ok=true
 *       (b) 超 cap 自动截断 + …
 *       (c) <3 数字返 ok=false reason=numeric_too_few_*
 *       (d) 非 string 返 ok=false reason=not_string
 *       (e) 空串返 ok=false reason=empty
 *       (f) 多重空白合并
 *   [5] generateAIAttributionSummary — AC 主验收:
 *       (a) source=null → fallback (heuristic)
 *       (b) source 返合规 LLM 文本 → source='llm' + 含 ≥ 3 数字
 *       (c) source 返空串 → fallback + reason=empty
 *       (d) source 返 <3 数字 → fallback + reason=numeric_too_few_*
 *       (e) source throw → fallback + reason=llm_threw
 *       (f) source 返超 cap → 自动截断 + 仍 source='llm' (若截后仍合规)
 *   [6] fallback 总满足 ≤ MAX_CHARS + ≥ MIN_NUMBERS (heuristic 兜底契约)
 *   [7] PRODUCTION DataSource factory — 不抛 (lazy require + try/catch 兜底)
 *   [8] META-GUARD fs+regex
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  AI_ATTRIBUTION_SUMMARY_MAX_CHARS,
  AI_ATTRIBUTION_SUMMARY_MIN_NUMBERS,
  AI_ATTRIBUTION_SUMMARY_ENDPOINT,
  AI_ATTRIBUTION_SUMMARY_TIMEOUT_MS,
  countNumericTokens,
  buildAttributionSummaryPrompt,
  enforceAttributionSummaryConstraints,
  generateAIAttributionSummary,
  createProductionAIAttributionSummaryDataSource,
  AIAttributionSummaryDataSource,
} from '../../src/services/attribution/AIAttributionSummary';
import {
  buildDailyAttributionReport,
  DailyAttributionReport,
  DailyAttributionTradeRow,
  DailyAttributionSnapshotRow,
} from '../../src/services/attribution/DailyAttributionService';

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

function trade(o: Partial<DailyAttributionTradeRow> & { id: number }): DailyAttributionTradeRow {
  return {
    id: o.id,
    portfolio_id: o.portfolio_id ?? 1,
    symbol: o.symbol ?? '600519',
    name: o.name ?? '贵州茅台',
    direction: o.direction ?? 'SELL',
    execute_price: o.execute_price ?? 1800,
    quantity: o.quantity ?? 100,
    amount: o.amount ?? 180_000,
    commission: o.commission ?? 50,
    realized_pnl: o.realized_pnl ?? 1500,
    created_at: o.created_at ?? '2026-06-19 14:30:00',
  };
}

function snap(date: string, total: number): DailyAttributionSnapshotRow {
  return { date, total_value: total, current_cash: 50_000, position_value: total - 50_000 };
}

function makeReport(overrides?: { trades?: DailyAttributionTradeRow[]; snapshotPair?: [number, number] }): DailyAttributionReport {
  const sp = overrides?.snapshotPair ?? [100_000, 105_000];
  return buildDailyAttributionReport({
    portfolio_id: 7,
    date: '2026-06-19',
    trades: overrides?.trades ?? [
      trade({ id: 1, symbol: 'A', realized_pnl: 1500, commission: 5 }),
      trade({ id: 2, symbol: 'B', realized_pnl: -300, commission: 3 }),
    ],
    snapshots: [snap('2026-06-18', sp[0]), snap('2026-06-19', sp[1])],
    positions: [],
    symbolToIndustry: { A: '银行', B: '半导体' },
    generated_at: '2026-06-19T17:00:00Z',
  });
}

(async () => {
  // ---- [1] 常量 sanity ------------------------------------------------------
  {
    assert('[1.1] MAX_CHARS = 200', AI_ATTRIBUTION_SUMMARY_MAX_CHARS === 200);
    assert('[1.2] MIN_NUMBERS = 3', AI_ATTRIBUTION_SUMMARY_MIN_NUMBERS === 3);
    assert('[1.3] ENDPOINT 形态合法', AI_ATTRIBUTION_SUMMARY_ENDPOINT.startsWith('/api/'));
    assert('[1.4] TIMEOUT 30s', AI_ATTRIBUTION_SUMMARY_TIMEOUT_MS === 30_000);
  }

  // ---- [2] countNumericTokens ----------------------------------------------
  {
    assert('[2.1] 整数 5', countNumericTokens('总盈亏 5 元') === 1);
    assert('[2.2] 浮点 3.14', countNumericTokens('3.14 元') === 1);
    assert('[2.3] 负数 -5', countNumericTokens('亏损 -5 元') === 1);
    assert('[2.4] 多个数字', countNumericTokens('5 笔 +200.5 元 -3') === 3);
    assert('[2.5] 空串', countNumericTokens('') === 0);
    assert('[2.6] null', countNumericTokens(null) === 0);
    assert('[2.7] 非 string', countNumericTokens(123 as unknown as string) === 0);
    assert(
      '[2.8] 日期 2026-06-19 算 3 个 (有 - 号视作负数)',
      countNumericTokens('2026-06-19') === 3,
    );
    assert(
      '[2.9] 中文混排 "成交3笔 +200.5元"',
      countNumericTokens('成交3笔 +200.5元') === 2,
    );
  }

  // ---- [3] buildAttributionSummaryPrompt -----------------------------------
  {
    const report = makeReport();
    const prompt = buildAttributionSummaryPrompt(report);
    assert(
      '[3.1] prompt 含 MAX_CHARS=200',
      prompt.includes(String(AI_ATTRIBUTION_SUMMARY_MAX_CHARS)),
    );
    assert(
      '[3.2] prompt 含 MIN_NUMBERS=3',
      prompt.includes(String(AI_ATTRIBUTION_SUMMARY_MIN_NUMBERS)),
    );
    assert('[3.3] prompt 含 日期', prompt.includes('2026-06-19'));
    assert(
      '[3.4] prompt 含 total_pnl 5000',
      prompt.includes('5000') || prompt.includes('5000.00'),
    );
    assert('[3.5] prompt 含 行业 银行', prompt.includes('银行'));
    assert('[3.6] prompt 含 客观要求', prompt.includes('客观'));
  }
  {
    // 缺维度 (空 trades / 无行业) 不应崩
    const empty: DailyAttributionReport = {
      ...makeReport({ trades: [] }),
      breakdown: {
        ...makeReport({ trades: [] }).breakdown,
        industry_contrib: [],
        execution_cost: 0,
      },
      best_trades: [],
      worst_trades: [],
    };
    const prompt = buildAttributionSummaryPrompt(empty);
    assert('[3.7] 缺维度不崩 + 仍含日期', prompt.includes('2026-06-19'));
    assert('[3.8] 缺维度不强提 行业 top', !prompt.includes('行业贡献 top'));
  }

  // ---- [4] enforceAttributionSummaryConstraints — AC 主验收 ----------------
  {
    // 合规
    const r = enforceAttributionSummaryConstraints(
      '2026-06-19 总盈亏 +5000 元 (5%); 成交 3 笔',
    );
    assert('[4.a.1] 合规 ok=true', r.ok === true);
    assert('[4.a.2] text 非空', !!r.text && r.text.length > 0);
    assert('[4.a.3] reason=null', r.reason === null);
  }
  {
    // 超 cap 截断
    const long = '盈亏数字 ' + '1234 '.repeat(80); // ~5*80 chars, 含 80+ 数字
    const r = enforceAttributionSummaryConstraints(long);
    assert('[4.b.1] 超 cap 仍 ok=true', r.ok === true);
    assert(
      '[4.b.2] 自动截到 ≤ MAX',
      r.text != null && Array.from(r.text).length <= AI_ATTRIBUTION_SUMMARY_MAX_CHARS,
    );
    assert('[4.b.3] 末尾 …', r.text != null && r.text.endsWith('…'));
  }
  {
    // <3 数字
    const r = enforceAttributionSummaryConstraints('今日 5 笔交易, 整体平稳');
    assert('[4.c.1] <3 数字 ok=false', r.ok === false);
    assert('[4.c.2] text=null', r.text === null);
    assert('[4.c.3] reason 含 numeric_too_few', (r.reason || '').includes('numeric_too_few'));
  }
  {
    // 非 string
    const r = enforceAttributionSummaryConstraints(null);
    assert('[4.d.1] null ok=false', r.ok === false);
    assert('[4.d.2] reason=not_string', r.reason === 'not_string');
  }
  {
    // 空串
    const r = enforceAttributionSummaryConstraints('   ');
    assert('[4.e.1] 空白 ok=false', r.ok === false);
    assert('[4.e.2] reason=empty', r.reason === 'empty');
  }
  {
    // 多重空白合并
    const r = enforceAttributionSummaryConstraints(
      '2026   total\t\t+500 元\n\n3 笔',
    );
    assert('[4.f.1] ok=true', r.ok === true);
    assert(
      '[4.f.2] 多重空白合并',
      r.text != null && !r.text.includes('  ') && !r.text.includes('\t'),
    );
  }
  {
    // 恰好 MAX_CHARS 不截
    const exact = '5 1 2'.padEnd(AI_ATTRIBUTION_SUMMARY_MAX_CHARS, 'a');
    const r = enforceAttributionSummaryConstraints(exact);
    assert('[4.g.1] 恰好 MAX 不截', r.ok === true && r.text === exact);
    // MAX+1 截 (≤ MAX-1 + …)
    const over = exact + 'x';
    const r2 = enforceAttributionSummaryConstraints(over);
    assert(
      '[4.g.2] MAX+1 截到 MAX',
      r2.ok === true &&
        r2.text != null &&
        Array.from(r2.text).length === AI_ATTRIBUTION_SUMMARY_MAX_CHARS,
    );
  }

  // ---- [5] generateAIAttributionSummary — AC 主验收 ------------------------
  {
    // (a) source=null → fallback
    const r = await generateAIAttributionSummary(makeReport(), null);
    assert('[5.a.1] source=null → fallback', r.source === 'fallback');
    assert('[5.a.2] reason=no_data_source', r.reason === 'no_data_source');
    assert('[5.a.3] text ≤ MAX', Array.from(r.text).length <= AI_ATTRIBUTION_SUMMARY_MAX_CHARS);
    assert(
      '[5.a.4] text 含 ≥ 3 数字',
      countNumericTokens(r.text) >= AI_ATTRIBUTION_SUMMARY_MIN_NUMBERS,
    );
  }
  {
    // (b) source 返合规 LLM 文本
    const fake: AIAttributionSummaryDataSource = {
      async callLLMSummary() {
        return '今日 2026-06-19 投资组合盈利 5000 元, 主因银行业贡献 +1500 元, 半导体拖累 -300 元, 合计 3 笔交易.';
      },
    };
    const r = await generateAIAttributionSummary(makeReport(), fake);
    assert('[5.b.1] source=llm', r.source === 'llm');
    assert('[5.b.2] reason=null', r.reason === null);
    assert(
      '[5.b.3] text 含 ≥ 3 数字',
      countNumericTokens(r.text) >= AI_ATTRIBUTION_SUMMARY_MIN_NUMBERS,
    );
    assert('[5.b.4] text ≤ MAX', Array.from(r.text).length <= AI_ATTRIBUTION_SUMMARY_MAX_CHARS);
    assert('[5.b.5] text 含 银行', r.text.includes('银行'));
  }
  {
    // (c) source 返空串 → fallback
    const fake: AIAttributionSummaryDataSource = {
      async callLLMSummary() {
        return '';
      },
    };
    const r = await generateAIAttributionSummary(makeReport(), fake);
    assert('[5.c.1] source=fallback', r.source === 'fallback');
    assert('[5.c.2] reason=empty', r.reason === 'empty');
  }
  {
    // (d) source 返 <3 数字 → fallback
    const fake: AIAttributionSummaryDataSource = {
      async callLLMSummary() {
        return '今日整体平稳, 银行业表现突出.';
      },
    };
    const r = await generateAIAttributionSummary(makeReport(), fake);
    assert('[5.d.1] source=fallback', r.source === 'fallback');
    assert(
      '[5.d.2] reason 含 numeric_too_few',
      (r.reason || '').includes('numeric_too_few'),
    );
  }
  {
    // (e) source throw → fallback
    const fake: AIAttributionSummaryDataSource = {
      async callLLMSummary() {
        throw new Error('boom llm');
      },
    };
    const r = await generateAIAttributionSummary(makeReport(), fake);
    assert('[5.e.1] source=fallback', r.source === 'fallback');
    assert('[5.e.2] reason=llm_threw', r.reason === 'llm_threw');
    assert(
      '[5.e.3] text 仍 ≥ 3 数字 (fallback 兜底)',
      countNumericTokens(r.text) >= AI_ATTRIBUTION_SUMMARY_MIN_NUMBERS,
    );
  }
  {
    // (f) source 返超 cap → 截断后若仍合规则 source='llm'
    const fake: AIAttributionSummaryDataSource = {
      async callLLMSummary() {
        return (
          '盈利 100 元 2026-06-19 完美 ' +
          '极好极妙的'.repeat(60)
        );
      },
    };
    const r = await generateAIAttributionSummary(makeReport(), fake);
    assert('[5.f.1] source=llm (截后仍合规)', r.source === 'llm');
    assert('[5.f.2] text ≤ MAX', Array.from(r.text).length <= AI_ATTRIBUTION_SUMMARY_MAX_CHARS);
  }
  {
    // (g) source 返非 string → fallback
    const fake: AIAttributionSummaryDataSource = {
      async callLLMSummary() {
        return null;
      },
    };
    const r = await generateAIAttributionSummary(makeReport(), fake);
    assert('[5.g.1] null → fallback', r.source === 'fallback');
    assert('[5.g.2] reason=not_string', r.reason === 'not_string');
  }

  // ---- [6] fallback 总满足 cap + 数字契约 (heuristic 兜底永远合规) ----------
  {
    // 各种边界 report — fallback 都应满足契约
    const reports: DailyAttributionReport[] = [
      makeReport({ snapshotPair: [100_000, 100_000] }), // pnl=0
      makeReport({ snapshotPair: [100_000, 50_000] }), // 大亏
      makeReport({ trades: [] }), // 无 trade
      makeReport({
        trades: Array.from({ length: 100 }, (_, i) =>
          trade({ id: i, symbol: `S${i}`, realized_pnl: 100 + i }),
        ),
      }), // 大量 trade (长行业列表)
    ];
    for (let i = 0; i < reports.length; i++) {
      const r = await generateAIAttributionSummary(reports[i], null);
      assert(
        `[6.${i + 1}.a] text ≤ MAX`,
        Array.from(r.text).length <= AI_ATTRIBUTION_SUMMARY_MAX_CHARS,
        `len=${Array.from(r.text).length}`,
      );
      assert(
        `[6.${i + 1}.b] text ≥ 3 数字`,
        countNumericTokens(r.text) >= AI_ATTRIBUTION_SUMMARY_MIN_NUMBERS,
        `count=${countNumericTokens(r.text)} text="${r.text}"`,
      );
    }
  }

  // ---- [7] PRODUCTION DataSource factory — 不抛 ---------------------------
  {
    const ds = createProductionAIAttributionSummaryDataSource();
    // axios 没真 endpoint, 走 fail-OPEN 返 null (不抛)
    const r = await ds.callLLMSummary('test prompt');
    assert('[7.1] PRODUCTION callLLMSummary 不抛, 返 null', r === null);
  }

  // ---- [8] META-GUARD fs+regex --------------------------------------------
  {
    const helperPath = join(
      __dirname,
      '../../src/services/attribution/AIAttributionSummary.ts',
    );
    const helperSrc = readFileSync(helperPath, 'utf8');
    assert(
      '[8.1] helper 含 export buildAttributionSummaryPrompt',
      /export\s+function\s+buildAttributionSummaryPrompt/.test(helperSrc),
    );
    assert(
      '[8.2] helper 含 export enforceAttributionSummaryConstraints',
      /export\s+function\s+enforceAttributionSummaryConstraints/.test(helperSrc),
    );
    assert(
      '[8.3] helper 含 export generateAIAttributionSummary',
      /export\s+async\s+function\s+generateAIAttributionSummary/.test(helperSrc),
    );
    assert(
      '[8.4] helper 含 export PRODUCTION factory',
      /export\s+function\s+createProductionAIAttributionSummaryDataSource/.test(helperSrc),
    );
    assert(
      '[8.5] helper 含 PM-005 标识',
      /PM-005|US-082/.test(helperSrc),
    );
    assert('[8.6] helper 含 fail-OPEN 注释', /fail-OPEN/.test(helperSrc));
    // 反向 — helper 不能直接 require model (DataSource DI 必须保留)
    assert(
      '[8.7] helper 不 inline import PaperTradingTrade',
      !/from\s+['"][.\/]+models\/PaperTradingTrade/.test(helperSrc),
    );

    // service 接入点
    const servicePath = join(
      __dirname,
      '../../src/services/attribution/DailyAttributionService.ts',
    );
    const serviceSrc = readFileSync(servicePath, 'utf8');
    assert(
      '[8.8] service 含 import generateAIAttributionSummary',
      /import\s+\{[^}]*generateAIAttributionSummary[^}]*\}\s+from\s+['"]\.\/AIAttributionSummary['"]/.test(
        serviceSrc,
      ),
    );
    assert(
      '[8.9] service 含 ai_summary_source option',
      /ai_summary_source\?:/.test(serviceSrc),
    );
    assert(
      '[8.10] service 调 generateAIAttributionSummary',
      /generateAIAttributionSummary\(/.test(serviceSrc),
    );
    assert(
      '[8.11] service ai_summary_source !== off 判分支',
      /ai_summary_source\s*!==\s*['"]off['"]/.test(serviceSrc),
    );
  }

  // ---- summary --------------------------------------------------------------
  console.log(`\nai-attribution-summary: ${passed} ok / ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
