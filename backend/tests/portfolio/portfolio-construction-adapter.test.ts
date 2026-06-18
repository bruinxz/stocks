/**
 * portfolio-construction-adapter.test.ts — Sprint 29 helpers 单测
 *
 * 覆盖 4 个纯函数 (不涉及 DB):
 *   - normalizePortfolioConstructionConfig: lenient normalize, invalid → default
 *   - pickTopCandidates: 按 alpha_score desc + symbol asc 稳定排序, 截 top-N
 *   - mapWeightsToSignalIds: 把 service 输出 (按 symbol 顺序) 映射回 signal_id map
 *   - DEFAULT_PORTFOLIO_CONSTRUCTION_CONFIG: 不变量 (mode=off 等)
 *
 * US-006 / PR-001 扩展 (2026-06-19):
 *   - buildPortfolioConstruction 主入口的 mode='off' / 0 candidates / fail-open
 *     早返路径 (不依赖 DB / 不依赖 service)
 *   - **meta-test**: 用源文件正则扫 PaperTradingAutomationService.autoBuyFromSignals
 *     必须 import buildPortfolioConstruction + 必须在 candidateSignals 收集之后
 *     调用; 保护 PR-001 "真接入" 不被未来 refactor 误删 (与 cron-registry.test.ts
 *     的 [5] 双向一致性 guard 同款模式)
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  normalizePortfolioConstructionConfig,
  pickTopCandidates,
  mapWeightsToSignalIds,
  buildPortfolioConstruction,
  DEFAULT_PORTFOLIO_CONSTRUCTION_CONFIG,
  type AdapterCandidate,
  type PortfolioConstructionConfig,
} from '../../src/portfolio/internal/PortfolioConstructionAdapter';

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

function testDefault() {
  console.log('\n## DEFAULT_PORTFOLIO_CONSTRUCTION_CONFIG');
  assert('mode = off (向后兼容默认)', DEFAULT_PORTFOLIO_CONSTRUCTION_CONFIG.mode === 'off');
  assert('method = risk_parity', DEFAULT_PORTFOLIO_CONSTRUCTION_CONFIG.method === 'risk_parity');
  assert('lookback_days = 60', DEFAULT_PORTFOLIO_CONSTRUCTION_CONFIG.lookback_days === 60);
  assert('max_candidates = 30', DEFAULT_PORTFOLIO_CONSTRUCTION_CONFIG.max_candidates === 30);
  assert('max_weight = 0.15', DEFAULT_PORTFOLIO_CONSTRUCTION_CONFIG.max_weight === 0.15);
  assert(
    'max_industry_weight = 0.40',
    DEFAULT_PORTFOLIO_CONSTRUCTION_CONFIG.max_industry_weight === 0.40
  );
}

function testNormalizeConfig() {
  console.log('\n## normalizePortfolioConstructionConfig');

  // 空输入 → 全 default
  const empty = normalizePortfolioConstructionConfig({});
  assert('空输入: mode = off', empty.mode === 'off');
  assert('空输入: method = risk_parity', empty.method === 'risk_parity');

  // null 输入 → 全 default
  const nul = normalizePortfolioConstructionConfig(null);
  assert('null 输入: mode = off', nul.mode === 'off');

  // 完整合法输入
  const full = normalizePortfolioConstructionConfig({
    mode: 'shadow',
    method: 'hrp',
    lookback_days: 120,
    max_candidates: 50,
    max_weight: 0.2,
    max_industry_weight: 0.35,
  });
  assert('完整: mode = shadow', full.mode === 'shadow');
  assert('完整: method = hrp', full.method === 'hrp');
  assert('完整: lookback = 120', full.lookback_days === 120);
  assert('完整: max_candidates = 50', full.max_candidates === 50);
  assert('完整: max_weight = 0.2', full.max_weight === 0.2);

  // invalid mode → 退到 default
  const badMode = normalizePortfolioConstructionConfig({ mode: 'badass' });
  assert('invalid mode → off', badMode.mode === 'off');

  // invalid method → 退到 default
  const badMethod = normalizePortfolioConstructionConfig({ method: 'wizard_mode' });
  assert('invalid method → risk_parity', badMethod.method === 'risk_parity');

  // lookback out of range → clamp
  const tooLow = normalizePortfolioConstructionConfig({ lookback_days: 10 });
  assert('lookback < 20 clamp to 20', tooLow.lookback_days === 20);

  const tooHigh = normalizePortfolioConstructionConfig({ lookback_days: 500 });
  assert('lookback > 252 clamp to 252', tooHigh.lookback_days === 252);

  // negative / NaN → default
  const negCand = normalizePortfolioConstructionConfig({ max_candidates: -5 });
  assert('max_candidates negative → default 30', negCand.max_candidates === 30);

  const nanWeight = normalizePortfolioConstructionConfig({ max_weight: NaN });
  assert('max_weight NaN → default 0.15', nanWeight.max_weight === 0.15);

  // weight > 1 → default
  const overWeight = normalizePortfolioConstructionConfig({ max_weight: 1.5 });
  assert('max_weight > 1 → default 0.15', overWeight.max_weight === 0.15);

  const zeroWeight = normalizePortfolioConstructionConfig({ max_weight: 0 });
  assert('max_weight = 0 → default 0.15 (must > 0)', zeroWeight.max_weight === 0.15);
}

function testPickTopCandidates() {
  console.log('\n## pickTopCandidates');

  const cands: AdapterCandidate[] = [
    { signal_id: 1, symbol: 'sh.600000', alpha_score: 80 },
    { signal_id: 2, symbol: 'sh.600001', alpha_score: 95 },
    { signal_id: 3, symbol: 'sh.600002', alpha_score: 60 },
    { signal_id: 4, symbol: 'sh.600003', alpha_score: 80 },  // 与 #1 同分
    { signal_id: 5, symbol: 'sh.600004', alpha_score: 70 },
  ];

  // max=0 → 不截断
  const all = pickTopCandidates(cands, 0);
  assert('max=0 不截断', all.length === 5);

  // max ≥ length → 不截断
  const allByCap = pickTopCandidates(cands, 100);
  assert('max≥len 不截断', allByCap.length === 5);

  // max=3 → 排序 desc, top 3
  const top3 = pickTopCandidates(cands, 3);
  assert('max=3 取 3 个', top3.length === 3);
  assert('top1.score = 95', top3[0].alpha_score === 95);
  assert('top1.symbol = sh.600001', top3[0].symbol === 'sh.600001');
  // 同分稳定排序: sh.600000 (80) 在 sh.600003 (80) 前 (symbol asc)
  assert('top2 同分 stable: sh.600000', top3[1].symbol === 'sh.600000');
  assert('top3 同分 stable: sh.600003', top3[2].symbol === 'sh.600003');

  // null alpha_score → 视为 0
  const cands2: AdapterCandidate[] = [
    { signal_id: 1, symbol: 'sh.A', alpha_score: null },
    { signal_id: 2, symbol: 'sh.B', alpha_score: 50 },
  ];
  const top1 = pickTopCandidates(cands2, 1);
  assert('null alpha 视为 0, top1 = sh.B (50)', top1[0].symbol === 'sh.B');
}

function testMapWeightsToSignalIds() {
  console.log('\n## mapWeightsToSignalIds');

  const cands: AdapterCandidate[] = [
    { signal_id: 100, symbol: 'sh.600000' },
    { signal_id: 200, symbol: 'sh.600001' },
    { signal_id: 300, symbol: 'sh.600002' },
  ];

  // service 输出 symbols 顺序与 cands 不同, weights 全 >0
  const result: any = {
    symbols: ['sh.600001', 'sh.600000', 'sh.600002'],
    weights: [0.5, 0.3, 0.2],
  };
  const map = mapWeightsToSignalIds(cands, result);
  assert('map.size = 3', map.size === 3);
  assert('signal_id 100 → 0.3', map.get(100) === 0.3);
  assert('signal_id 200 → 0.5', map.get(200) === 0.5);
  assert('signal_id 300 → 0.2', map.get(300) === 0.2);

  // 0 权重 / NaN 应被剔除
  const result2: any = {
    symbols: ['sh.600000', 'sh.600001', 'sh.600002'],
    weights: [0.5, 0, NaN],
  };
  const map2 = mapWeightsToSignalIds(cands, result2);
  assert('0 权重剔除', !map2.has(200));
  assert('NaN 权重剔除', !map2.has(300));
  assert('正权重保留', map2.get(100) === 0.5);

  // service 输出含 symbol 不在 cands 里 → 忽略
  const result3: any = {
    symbols: ['sh.999999', 'sh.600000'],
    weights: [0.5, 0.5],
  };
  const map3 = mapWeightsToSignalIds(cands, result3);
  assert('未知 symbol 忽略', map3.size === 1);
  assert('已知 symbol 保留', map3.get(100) === 0.5);
}

function main() {
  testDefault();
  testNormalizeConfig();
  testPickTopCandidates();
  testMapWeightsToSignalIds();
  // US-006 / PR-001 扩展 — 异步主入口早返路径 + 主干 wire-in meta-guard
  Promise.resolve()
    .then(testBuildPortfolioConstructionEarlyReturns)
    .then(testBuildPortfolioConstructionFailOpen)
    .then(testAutoBuyFromSignalsWireIn)
    .then(() => {
      console.log(`\n========================================`);
      console.log(`portfolio-construction-adapter tests: ${passed} pass / ${failed} fail`);
      console.log(`========================================`);
      process.exit(failed > 0 ? 1 : 0);
    });
}

/**
 * 异步主入口早返路径 — 不依赖 DB / 不依赖 PortfolioConstructionService
 * 保护 "mode=off 时 buy-decision loop 零开销" 的承诺.
 */
async function testBuildPortfolioConstructionEarlyReturns() {
  console.log('\n## buildPortfolioConstruction — early returns (US-006)');
  const baseCfg: PortfolioConstructionConfig = {
    mode: 'off',
    method: 'risk_parity',
    lookback_days: 60,
    max_candidates: 30,
    max_weight: 0.15,
    max_industry_weight: 0.4,
  };
  const cands: AdapterCandidate[] = [
    { signal_id: 1, symbol: 'sh.600000', alpha_score: 80 },
    { signal_id: 2, symbol: 'sh.600001', alpha_score: 70 },
  ];

  // mode=off → null (零开销, 不查 DB / 不调 service)
  const r1 = await buildPortfolioConstruction({
    user_id: 1,
    as_of_date: '2026-06-19',
    candidates: cands,
    config: baseCfg,
  });
  assert('mode=off → null (零开销契约)', r1 === null);

  // candidates=[] → null (即使 mode=shadow)
  const r2 = await buildPortfolioConstruction({
    user_id: 1,
    as_of_date: '2026-06-19',
    candidates: [],
    config: { ...baseCfg, mode: 'shadow' },
  });
  assert('candidates=[] + shadow → null', r2 === null);

  // candidates=[] + hard → null
  const r3 = await buildPortfolioConstruction({
    user_id: 1,
    as_of_date: '2026-06-19',
    candidates: [],
    config: { ...baseCfg, mode: 'hard' },
  });
  assert('candidates=[] + hard → null', r3 === null);
}

/**
 * fail-open 契约 — loadCandidateReturns 内部 DB query 必失败 (无 DB 连接),
 * 整个 returnsMap 空 → usableCandidates=0 → 返非 null 但 skipped_reason='data_shortage';
 * loop 主干据此走原 per-signal 流程, 不抛错. 这是 PR-001 "真接入" 的关键安全网.
 */
async function testBuildPortfolioConstructionFailOpen() {
  console.log('\n## buildPortfolioConstruction — fail-open (US-006)');
  const cfg: PortfolioConstructionConfig = {
    mode: 'shadow',
    method: 'risk_parity',
    lookback_days: 60,
    max_candidates: 30,
    max_weight: 0.15,
    max_industry_weight: 0.4,
  };
  const cands: AdapterCandidate[] = [
    { signal_id: 1, symbol: 'sh.600000', alpha_score: 80, industry: '银行' },
    { signal_id: 2, symbol: 'sh.600001', alpha_score: 70, industry: '银行' },
  ];

  // 无 DB 连接环境下: Stock.findAll 抛 SequelizeConnectionError → loadCandidateReturns
  // 内部 catch 后返回空 Map → usableCandidates=0 → 返 skipped 结果, 不抛错.
  let threw: Error | null = null;
  let result: any = null;
  try {
    result = await buildPortfolioConstruction({
      user_id: 1,
      as_of_date: '2026-06-19',
      candidates: cands,
      config: cfg,
    });
  } catch (e: any) {
    threw = e;
  }
  assert('不抛错 (fail-open 契约)', threw === null, threw ? `threw: ${threw.message}` : '');
  assert('返非 null 结果对象', result !== null);
  if (result) {
    assert('result.mode 透传', result.mode === 'shadow');
    assert('result.method 透传', result.method === 'risk_parity');
    assert('total_candidates = 2', result.total_candidates === 2);
    assert('used_candidates = 0 (data shortage)', result.used_candidates === 0);
    assert(
      'weights_by_signal_id 空 Map',
      result.weights_by_signal_id instanceof Map && result.weights_by_signal_id.size === 0
    );
    assert(
      'skipped_reason ∈ {data_shortage, construct_failed}',
      result.skipped_reason === 'data_shortage' || result.skipped_reason === 'construct_failed'
    );
    assert('construction_result = null', result.construction_result === null);
  }
}

/**
 * Meta-test guard — US-006 / PR-001 "PortfolioOptimizer 真接入" 验收主守卫.
 *
 * 直接扫源文件: PaperTradingAutomationService.ts 必须
 *   1. import buildPortfolioConstruction (from PortfolioConstructionAdapter)
 *   2. 在 autoBuyFromSignals 方法体内调用 buildPortfolioConstruction(...)
 *   3. 在 buy-decision loop 内消费 portfolioConstructionResult.weights_by_signal_id
 *      (即 hard mode 真正替换 effectiveTargetPct, 否则只是 shadow 装样子)
 *
 * 任何后续 refactor 把 wire-in 误删 → 此 test 立刻挂.
 * 与 cron-registry.test.ts 的 [5] 双向一致性 guard 同款 meta-test 模式.
 */
async function testAutoBuyFromSignalsWireIn() {
  console.log('\n## meta-guard: PaperTradingAutomationService.autoBuyFromSignals wire-in (US-006)');
  const src = fs.readFileSync(
    path.join(__dirname, '../../src/portfolio/internal/PaperTradingAutomationService.ts'),
    'utf8'
  );

  // [1] import 路径必须在
  const importRe =
    /import\s*\{[\s\S]*?\bbuildPortfolioConstruction\b[\s\S]*?\}\s*from\s*['"]\.\/PortfolioConstructionAdapter['"]/;
  assert('[1] import buildPortfolioConstruction from ./PortfolioConstructionAdapter', importRe.test(src));

  // [2] autoBuyFromSignals 方法体内必须真正调用 buildPortfolioConstruction(...)
  const methodMatch = src.match(/async\s+autoBuyFromSignals\s*\([\s\S]*?\n  \}/);
  assert('[2a] autoBuyFromSignals 方法可定位', !!methodMatch);
  if (methodMatch) {
    const body = methodMatch[0];
    assert(
      '[2b] autoBuyFromSignals 方法体内调用 buildPortfolioConstruction(',
      /\bbuildPortfolioConstruction\s*\(/.test(body)
    );
    // [3] 必须消费 weights_by_signal_id (否则只是装样子, 没有真正替换 sizing)
    assert(
      '[3] 方法体内消费 weights_by_signal_id (hard mode 替换 effectiveTargetPct)',
      /weights_by_signal_id/.test(body) && /effectiveTargetPct\s*=\s*pcTargetPct/.test(body)
    );
    // [4] 必须 try/catch 包裹 — fail-open
    assert(
      '[4] adapter 调用被 try/catch 包裹 (fail-open 契约)',
      /try\s*\{[\s\S]*?buildPortfolioConstruction[\s\S]*?\}\s*catch/.test(body)
    );
    // [5] candidateSignals 先于 adapter 调用
    const idxCands = body.indexOf('candidateSignals');
    const idxBuild = body.indexOf('buildPortfolioConstruction');
    assert(
      '[5] candidateSignals 先收集再调 adapter (顺序正确)',
      idxCands > -1 && idxBuild > -1 && idxCands < idxBuild
    );
  }
}

main();
