/**
 * integration-smoke-test 脚本的纯函数单元测试 (US-100)
 *
 * 完全脱 DB / 网络: 只覆盖 script 内 export 的纯函数 +
 * runStep 的状态/计时/异常归一化路径。runSmokeTest 主流程依赖 Sequelize
 * + 真实 services, 不在单测覆盖范围 (走 npm run smoke-test 端到端验证)。
 *
 * 跑法:
 *   cd backend && npx ts-node --transpile-only tests/services/integration-smoke-test.test.ts
 *
 * 覆盖维度:
 *   - formatDuration: < 1s / 1s-1m / > 1m / NaN / 负数 / 0 / 大整数
 *   - pickTopBuyCandidates: 空 / 只 'hold' / 只 'sell' / 混合 / topN=0 / topN > 数组长度
 *     / 保序 (信号已排好序)
 *   - safeTradeDate: 合法 / 缺省 / 非法格式 / null / 空串 / 大小写
 *   - inferSymbolFromCode: 6 开头 = .SH / 0 开头 = .SZ / 3 开头 = .SZ /
 *     已带后缀 / 空串 / null / 4 开头兜底 .SZ
 *   - runStep: 成功 / 抛错 / skipped 标识 / detail 透传 / duration_ms 非负
 *   - DEFAULT_SMOKE_ORDER_COUNT === 3 (AC: 3 单)
 *   - DEFAULT_SMOKE_ORDER_QTY === 100 (A 股 1 手, cash 充足)
 */

import {
  formatDuration,
  pickTopBuyCandidates,
  safeTradeDate,
  inferSymbolFromCode,
  runStep,
  DEFAULT_SMOKE_ORDER_COUNT,
  DEFAULT_SMOKE_ORDER_QTY,
} from '../../src/scripts/integration-smoke-test';
import { MultiFactorAlphaSignal } from '../../src/quant/strategies/MultiFactorAlphaStrategy';

let failed = 0;
let passed = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

function expectEqual<T>(name: string, actual: T, expected: T, detail = ''): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  assert(
    name,
    same,
    detail || `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  );
}

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------
(function testFormatDuration() {
  console.log('\n[formatDuration]');
  expectEqual('0ms → "0ms"', formatDuration(0), '0ms');
  expectEqual('123ms → "123ms"', formatDuration(123), '123ms');
  expectEqual('999ms → "999ms"', formatDuration(999), '999ms');
  expectEqual('1000ms → "1.00s"', formatDuration(1000), '1.00s');
  expectEqual('1234ms → "1.23s"', formatDuration(1234), '1.23s');
  expectEqual('59999ms → "60.00s"', formatDuration(59_999), '60.00s');
  expectEqual('60000ms → "1m0s"', formatDuration(60_000), '1m0s');
  expectEqual('83000ms → "1m23s"', formatDuration(83_000), '1m23s');
  expectEqual('300000ms → "5m0s"', formatDuration(300_000), '5m0s');
  expectEqual('NaN → "?ms"', formatDuration(NaN), '?ms');
  expectEqual('负数 → "?ms"', formatDuration(-1), '?ms');
  expectEqual('Infinity → "?ms"', formatDuration(Infinity), '?ms');
})();

// ---------------------------------------------------------------------------
// pickTopBuyCandidates
// ---------------------------------------------------------------------------
function makeSignal(
  stock_code: string,
  signal: 'buy' | 'sell' | 'hold',
  composite_score = 0
): MultiFactorAlphaSignal {
  return {
    stock_code,
    name: stock_code,
    industry: null,
    signal,
    composite_score,
    factor_z_scores: {},
    reason: 'test',
  };
}

(function testPickTopBuyCandidates() {
  console.log('\n[pickTopBuyCandidates]');
  const empty: MultiFactorAlphaSignal[] = [];
  expectEqual('空数组 → []', pickTopBuyCandidates(empty, 3).length, 0);

  const onlyHolds = [makeSignal('000001', 'hold'), makeSignal('000002', 'hold')];
  expectEqual('全 hold → []', pickTopBuyCandidates(onlyHolds, 3).length, 0);

  const onlySells = [makeSignal('000001', 'sell')];
  expectEqual('全 sell → []', pickTopBuyCandidates(onlySells, 3).length, 0);

  const mixed = [
    makeSignal('600519', 'buy', 5.0),
    makeSignal('000001', 'hold', 4.0),
    makeSignal('600036', 'buy', 3.0),
    makeSignal('000002', 'sell', 2.0),
    makeSignal('601318', 'buy', 1.0),
    makeSignal('000651', 'buy', 0.5),
  ];

  const top3 = pickTopBuyCandidates(mixed, 3);
  expectEqual('混合 topN=3 → 3 只 buy', top3.length, 3);
  expectEqual('top3[0]=600519', top3[0].stock_code, '600519');
  expectEqual('top3[1]=600036', top3[1].stock_code, '600036');
  expectEqual('top3[2]=601318', top3[2].stock_code, '601318');

  const top0 = pickTopBuyCandidates(mixed, 0);
  expectEqual('topN=0 → []', top0.length, 0);

  const topAll = pickTopBuyCandidates(mixed, 100);
  expectEqual('topN > 数组长度 → 全部 buy (=4)', topAll.length, 4);

  const negTop = pickTopBuyCandidates(mixed, -1);
  expectEqual('topN 负数 → 0 长 (clamped 到 0)', negTop.length, 0);

  // 输入是 null / 非数组 → 防御
  expectEqual('input=null → []', pickTopBuyCandidates(null as any, 3).length, 0);

  // 输入混入 null / undefined 信号 — pickTopBuyCandidates 防御性 filter
  const dirty = [
    makeSignal('600519', 'buy'),
    null as any,
    undefined as any,
    makeSignal('600036', 'buy'),
  ];
  expectEqual('混入 null/undefined → 仅有效信号', pickTopBuyCandidates(dirty, 5).length, 2);
})();

// ---------------------------------------------------------------------------
// safeTradeDate
// ---------------------------------------------------------------------------
(function testSafeTradeDate() {
  console.log('\n[safeTradeDate]');
  expectEqual('合法 ISO date 保留', safeTradeDate('2026-06-05'), '2026-06-05');
  expectEqual('合法 ISO date(2024 闰年)保留', safeTradeDate('2024-02-29'), '2024-02-29');

  // 缺省 / 空 / null → 当天 (YYYY-MM-DD)
  const today = safeTradeDate();
  assert(
    '缺省 → today (YYYY-MM-DD)',
    /^\d{4}-\d{2}-\d{2}$/.test(today),
    `got "${today}"`
  );
  const sameAsUndefined = safeTradeDate(undefined);
  expectEqual('undefined 等价 缺省', sameAsUndefined, today);
  const fromNull = safeTradeDate(null);
  assert(
    'null → today (格式 YYYY-MM-DD)',
    /^\d{4}-\d{2}-\d{2}$/.test(fromNull)
  );

  // 非法格式 → today
  const fromBad = safeTradeDate('20260605');
  assert(
    '非 ISO 格式 (20260605) → today',
    /^\d{4}-\d{2}-\d{2}$/.test(fromBad)
  );
  const fromEmpty = safeTradeDate('');
  assert('空串 → today', /^\d{4}-\d{2}-\d{2}$/.test(fromEmpty));
  const fromGarbage = safeTradeDate('not-a-date');
  assert('垃圾字符 → today', /^\d{4}-\d{2}-\d{2}$/.test(fromGarbage));
})();

// ---------------------------------------------------------------------------
// inferSymbolFromCode
// ---------------------------------------------------------------------------
(function testInferSymbolFromCode() {
  console.log('\n[inferSymbolFromCode]');
  expectEqual('6 开头 = .SH', inferSymbolFromCode('600519'), '600519.SH');
  expectEqual('6 开头 (601318)', inferSymbolFromCode('601318'), '601318.SH');
  expectEqual('0 开头 = .SZ', inferSymbolFromCode('000001'), '000001.SZ');
  expectEqual('0 开头 (000651)', inferSymbolFromCode('000651'), '000651.SZ');
  expectEqual('3 开头 = .SZ (创业板)', inferSymbolFromCode('300750'), '300750.SZ');
  // 已带后缀直接返回
  expectEqual('已带 .SH 后缀', inferSymbolFromCode('600519.SH'), '600519.SH');
  expectEqual('已带 .SZ 后缀', inferSymbolFromCode('000001.SZ'), '000001.SZ');
  // 边界
  expectEqual('空串透传', inferSymbolFromCode(''), '');
  expectEqual('null 透传', inferSymbolFromCode(null as any), null as any);
  // 4 开头兜底 .SZ
  expectEqual('4 开头兜底 .SZ', inferSymbolFromCode('400123'), '400123.SZ');
  expectEqual('8 开头兜底 .SZ', inferSymbolFromCode('872925'), '872925.SZ');
})();

// ---------------------------------------------------------------------------
// runStep — 成功 / 失败 / skipped 路径
// ---------------------------------------------------------------------------
(async function testRunStep() {
  console.log('\n[runStep]');

  // 成功
  const okRecord = await runStep('PROBE_OK', async () => ({ detail: 'ran fine' }));
  expectEqual('成功状态', okRecord.status, 'success');
  expectEqual('成功 detail 透传', okRecord.detail, 'ran fine');
  assert('成功 duration_ms ≥ 0', okRecord.duration_ms >= 0);
  expectEqual('成功 error 字段为 undefined', okRecord.error, undefined);
  expectEqual('成功 name 透传', okRecord.name, 'PROBE_OK');

  // skipped
  const skipRecord = await runStep('PROBE_SKIP', async () => ({
    detail: 'caller said skip',
    skipped: true,
  }));
  expectEqual('skipped 状态', skipRecord.status, 'skipped');
  expectEqual('skipped detail 仍透传', skipRecord.detail, 'caller said skip');

  // 失败 (throw Error)
  const failRecord = await runStep('PROBE_FAIL', async () => {
    throw new Error('boom!');
  });
  expectEqual('失败状态', failRecord.status, 'failed');
  expectEqual('失败 error message 写入', failRecord.error, 'boom!');
  assert('失败时 duration_ms ≥ 0', failRecord.duration_ms >= 0);
  expectEqual('失败 detail 为 undefined', failRecord.detail, undefined);

  // 失败 (throw 非 Error — 字符串/对象)
  const failRawRecord = await runStep('PROBE_FAIL_RAW', async () => {
    throw 'just a string';
  });
  expectEqual('throw 字符串 → failed', failRawRecord.status, 'failed');
  expectEqual('throw 字符串 → error 字段=字符串', failRawRecord.error, 'just a string');

  // 计时合理性 (sleep 50ms 应当 ≥ 30ms 且 ≤ 5000ms, 留 timing 抖动余量)
  const sleepRecord = await runStep('PROBE_TIMING', async () => {
    await new Promise(r => setTimeout(r, 50));
    return { detail: 'slept' };
  });
  assert(
    'sleep 50ms 后 duration_ms ≥ 30',
    sleepRecord.duration_ms >= 30,
    `got ${sleepRecord.duration_ms}ms`
  );
  assert(
    'sleep 50ms 后 duration_ms ≤ 5000 (timing 抖动余量)',
    sleepRecord.duration_ms <= 5000
  );
})();

// ---------------------------------------------------------------------------
// 常量 (AC 锁定)
// ---------------------------------------------------------------------------
(function testConstants() {
  console.log('\n[constants]');
  // AC: 模拟下 3 单
  expectEqual('DEFAULT_SMOKE_ORDER_COUNT === 3', DEFAULT_SMOKE_ORDER_COUNT, 3);
  // 默认 100 股 = 1 手, 与 A 股最小交易单位一致
  expectEqual('DEFAULT_SMOKE_ORDER_QTY === 100', DEFAULT_SMOKE_ORDER_QTY, 100);
})();

// ---------------------------------------------------------------------------
// Summary + exit
// ---------------------------------------------------------------------------
setTimeout(() => {
  console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
  process.exit(failed > 0 ? 1 : 0);
}, 200); // 给 async runStep 测试足够时间完成
