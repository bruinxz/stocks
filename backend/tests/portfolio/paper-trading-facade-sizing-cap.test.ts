/**
 * PR-M4 单元测试 — 仓位风控 hard caps 纯函数验证.
 *
 *   cd backend && npx ts-node --transpile-only tests/portfolio/paper-trading-facade-sizing-cap.test.ts
 *
 * 覆盖:
 *   1) PR_M4_SINGLE_POSITION_CAP_PCT === 5 + PR_M4_INDUSTRY_CONCENTRATION_CAP_PCT === 25
 *      (常量护栏 — 用户授权这两个数值, 漏改会被立刻发现)
 *   2) evaluateSinglePositionCap:
 *      - 不超 → ok + 不 cap
 *      - 超 → ok + capped=true + effective_cost = 5%×total
 *      - total_value <= 0 → 不 cap (空账户走资金不足分支)
 *      - 自定义 cap_pct 覆盖
 *   3) evaluateIndustryConcentrationCap:
 *      - 未超 25% → ok
 *      - 超 25% → !ok + code='INDUSTRY_CONCENTRATION_CAP_EXCEEDED'
 *      - industry=null → 不拒单 (未分类)
 *      - 边界 exact 25% (含本单) → 不拒单 (用 `>` 严格不等)
 *      - 边界 25.01% → 拒单
 *      - total_value <= 0 → 不拒单
 *   4) 真实用户场景 (用户授权对应)
 *   5) META 守 — facade 真的调了 helper
 */

import {
  PR_M4_SINGLE_POSITION_CAP_PCT,
  PR_M4_INDUSTRY_CONCENTRATION_CAP_PCT,
  evaluateSinglePositionCap,
  evaluateIndustryConcentrationCap,
} from '../../src/portfolio/PaperTradingFacade';

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}${detail ? ' — ' + detail : ''}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
}

// ---------------------------------------------------------------------------
// [1] 常量护栏 — 用户授权 5% / 25%, 不能被无意改动
// ---------------------------------------------------------------------------
function test_constants() {
  console.log('\n[1] 常量护栏');
  assert(
    'PR_M4_SINGLE_POSITION_CAP_PCT === 5',
    PR_M4_SINGLE_POSITION_CAP_PCT === 5
  );
  assert(
    'PR_M4_INDUSTRY_CONCENTRATION_CAP_PCT === 25',
    PR_M4_INDUSTRY_CONCENTRATION_CAP_PCT === 25
  );
}

// ---------------------------------------------------------------------------
// [2] evaluateSinglePositionCap
// ---------------------------------------------------------------------------
function test_single_position_cap_ok() {
  console.log('\n[2] evaluateSinglePositionCap');
  const r = evaluateSinglePositionCap({
    proposed_cost: 4000,
    total_value: 100000,
  });
  assert('proposed 4000 / total 100000 → ok 不 cap', r.ok && !r.capped);
  assert('effective_cost === 4000', r.effective_cost === 4000);
  assert('cap_amount === 5000 (5%×100000)', r.cap_amount === 5000);
}

function test_single_position_cap_capped() {
  const r = evaluateSinglePositionCap({
    proposed_cost: 10000,
    total_value: 100000,
  });
  assert('proposed 10000 / total 100000 → ok capped', r.ok && r.capped);
  assert('effective_cost === 5000 (5%×100000)', r.effective_cost === 5000);
  assert('cap_amount === 5000', r.cap_amount === 5000);
  assert('detail.capped === true', r.detail.capped === true);
}

function test_single_position_cap_zero_total() {
  const r = evaluateSinglePositionCap({
    proposed_cost: 1000,
    total_value: 0,
  });
  assert('total_value=0 → ok 不 cap', r.ok && !r.capped);
}

function test_single_position_cap_override() {
  const r = evaluateSinglePositionCap({
    proposed_cost: 6000,
    total_value: 100000,
    cap_pct: 10,
  });
  assert('cap_pct=10 / proposed 6000 → 不 cap', r.ok && !r.capped);
  assert('cap_amount === 10000 (10%×100000)', r.cap_amount === 10000);
}

function test_single_position_cap_boundary_exact() {
  // proposed === cap → 用 `>` 严格 → 不 cap
  const r = evaluateSinglePositionCap({
    proposed_cost: 5000,
    total_value: 100000,
  });
  assert('proposed exactly 5% → 不 cap (用 > 严格)', r.ok && !r.capped);
}

// ---------------------------------------------------------------------------
// [3] evaluateIndustryConcentrationCap
// ---------------------------------------------------------------------------
function test_industry_cap_under() {
  console.log('\n[3] evaluateIndustryConcentrationCap');
  const r = evaluateIndustryConcentrationCap({
    industry: '电力',
    industry_value: 10000,
    proposed_cost: 5000,
    total_value: 100000,
  });
  assert('已 10000 + 本单 5000 < 25% (25000) → ok', r.ok);
  assert('cap_amount === 25000', r.cap_amount === 25000);
}

function test_industry_cap_exceeded() {
  const r = evaluateIndustryConcentrationCap({
    industry: '电力',
    industry_value: 22000,
    proposed_cost: 5000,
    total_value: 100000,
  });
  assert('已 22000 + 本单 5000 > 25% (25000) → 拒单', !r.ok);
  assert(
    "code === 'INDUSTRY_CONCENTRATION_CAP_EXCEEDED'",
    r.code === 'INDUSTRY_CONCENTRATION_CAP_EXCEEDED'
  );
  assert("message 含 '电力'", (r.message || '').includes('电力'));
  assert("message 含 '25%'", (r.message || '').includes('25%'));
}

function test_industry_cap_boundary_exact() {
  const r = evaluateIndustryConcentrationCap({
    industry: '电力',
    industry_value: 15000,
    proposed_cost: 10000,
    total_value: 100000,
  });
  assert('边界 exact 25% → ok (用 > 严格不等)', r.ok);
  assert('industry_value_after === 25000', r.industry_value_after === 25000);
}

function test_industry_cap_boundary_just_over() {
  const r = evaluateIndustryConcentrationCap({
    industry: '电力',
    industry_value: 15000,
    proposed_cost: 10001,
    total_value: 100000,
  });
  assert('边界 25.001% → 拒单', !r.ok);
}

function test_industry_cap_unknown_industry() {
  const r = evaluateIndustryConcentrationCap({
    industry: null,
    industry_value: 50000,
    proposed_cost: 50000,
    total_value: 100000,
  });
  assert('industry=null → 不拒单', r.ok);
  assert("detail.industry === '__UNKNOWN__'", r.detail.industry === '__UNKNOWN__');
}

function test_industry_cap_zero_total() {
  const r = evaluateIndustryConcentrationCap({
    industry: '电力',
    industry_value: 50000,
    proposed_cost: 50000,
    total_value: 0,
  });
  assert('total=0 → 不拒单', r.ok);
}

function test_industry_cap_whitespace_industry() {
  const r = evaluateIndustryConcentrationCap({
    industry: '   ',
    industry_value: 80000,
    proposed_cost: 10000,
    total_value: 100000,
  });
  assert("industry='   ' → 走 UNKNOWN 不拒单", r.ok);
}

// ---------------------------------------------------------------------------
// [4] real-world 用户授权场景
// ---------------------------------------------------------------------------
function test_user_scenario_capped_to_5pct() {
  console.log('\n[4] 真实场景 (用户授权对应)');
  // 用户授权: "建议 1 万但 capped 5000 类似". 账户 10 万, 5%=5000
  // 用户传 10000 → effective 5000
  const r = evaluateSinglePositionCap({
    proposed_cost: 10000,
    total_value: 100000,
  });
  assert(
    '用户授权场景: 建议 10000 自动 capped 到 5000',
    r.capped && r.effective_cost === 5000
  );
}

function test_user_scenario_industry_44pct_rejected() {
  // 用户上下文: "电力/交通/煤炭 44% 持仓亏 6%". 电力 44000, 总 100000 = 44%.
  // 再来一单 1000 元电力 → 应该拒单 (44% 已超 25%).
  const r = evaluateIndustryConcentrationCap({
    industry: '电力',
    industry_value: 44000,
    proposed_cost: 1000,
    total_value: 100000,
  });
  assert(
    '电力 44% 持仓再加 1000 元 → 应该拒单 (已超 25%)',
    !r.ok && r.code === 'INDUSTRY_CONCENTRATION_CAP_EXCEEDED'
  );
}

// ---------------------------------------------------------------------------
// [5] meta-guard — 源文件正则扫验证 facade 真的调用了这两个 cap
// ---------------------------------------------------------------------------
function test_meta_facade_wires_in_caps() {
  console.log('\n[5] meta-guard: facade 必须真调用 cap');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs');
  const src = fs.readFileSync(
    require('path').resolve(__dirname, '../../src/portfolio/PaperTradingFacade.ts'),
    'utf8'
  );
  assert(
    'facade.ts 含 evaluateSinglePositionCap 调用',
    /sizingCapDecision\s*=\s*evaluateSinglePositionCap\(/.test(src)
  );
  assert(
    'facade.ts 含 evaluateIndustryConcentrationCap 调用',
    /industryCapDecision\s*=\s*evaluateIndustryConcentrationCap\(/.test(src)
  );
  assert(
    "facade.ts 含 throw 'INDUSTRY_CONCENTRATION_CAP_EXCEEDED'",
    /INDUSTRY_CONCENTRATION_CAP_EXCEEDED/.test(src)
  );
  assert(
    "facade.ts 含 'SIZING_CAP_TOO_SMALL' (cap 不下 100 股拒单 code)",
    /SIZING_CAP_TOO_SMALL/.test(src)
  );
  assert(
    'facade.ts 暴露 bypass_sizing_caps option',
    /bypass_sizing_caps\?:\s*boolean/.test(src)
  );
  // closePosition 默认 bypass=true
  assert(
    'closePosition 默认 bypass_sizing_caps=true',
    /bypass_sizing_caps:\s*options\.bypass_sizing_caps\s*!==\s*false/.test(src)
  );
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------
test_constants();
test_single_position_cap_ok();
test_single_position_cap_capped();
test_single_position_cap_zero_total();
test_single_position_cap_override();
test_single_position_cap_boundary_exact();
test_industry_cap_under();
test_industry_cap_exceeded();
test_industry_cap_boundary_exact();
test_industry_cap_boundary_just_over();
test_industry_cap_unknown_industry();
test_industry_cap_zero_total();
test_industry_cap_whitespace_industry();
test_user_scenario_capped_to_5pct();
test_user_scenario_industry_44pct_rejected();
test_meta_facade_wires_in_caps();

console.log('');
console.log(`Result: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
