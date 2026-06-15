/**
 * portfolio-construction-adapter.test.ts — Sprint 29 helpers 单测
 *
 * 覆盖 4 个纯函数 (不涉及 DB):
 *   - normalizePortfolioConstructionConfig: lenient normalize, invalid → default
 *   - pickTopCandidates: 按 alpha_score desc + symbol asc 稳定排序, 截 top-N
 *   - mapWeightsToSignalIds: 把 service 输出 (按 symbol 顺序) 映射回 signal_id map
 *   - DEFAULT_PORTFOLIO_CONSTRUCTION_CONFIG: 不变量 (mode=off 等)
 */

import {
  normalizePortfolioConstructionConfig,
  pickTopCandidates,
  mapWeightsToSignalIds,
  DEFAULT_PORTFOLIO_CONSTRUCTION_CONFIG,
  type AdapterCandidate,
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
  console.log(`\n========================================`);
  console.log(`portfolio-construction-adapter tests: ${passed} pass / ${failed} fail`);
  console.log(`========================================`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
