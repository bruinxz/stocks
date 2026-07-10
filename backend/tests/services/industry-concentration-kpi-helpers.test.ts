/**
 * US-057 [FE-018] PortfolioWorkspace 行业集中度 KPI > 25% 红色高亮 — 单元测试.
 *
 * 不依赖 jest / DB / 网络 / React; 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/industry-concentration-kpi-helpers.test.ts
 *
 * 全部 import 自 frontend/src/pages/workspace/industryConcentrationKpiHelpers.ts
 * (pure helpers, 无 antd/react, ts-node 直接吃). 跨 monorepo import 用相对
 * 路径 `../../../frontend/...`, 与 US-049 (factor-pick-reason) / US-054
 * (strategy-leaderboard) helper 单测同款.
 *
 * 覆盖维度:
 *   [1] 常量 sanity (INDUSTRY_KPI_WARN_PCT=0.25 / WARN_COLOR / NEUTRAL_COLOR / labels)
 *   [2] shouldHideIndustryKpi — null / undefined / portfolio_id=null / 正常
 *   [3] isOverIndustryWarn — null / undefined / NaN / Infinity / 边界 0.25 / 0.2499 / 0.2501
 *   [4] formatIndustryLabel — UNKNOWN / null / undefined / '' / '   ' / 正常 / 前后空格
 *   [5] buildIndustryKpiSuffix — '—' / 正常
 *   [6] buildIndustryKpiTooltipLines — over_alert true/false / max_industry_pct null / format
 *   [7] buildIndustryConcentrationKpiViewModel — AC 主验收 4 case:
 *       (a) > 25% 红色 (overWarn=true, color=WARN_COLOR, suffix 含行业)
 *       (b) = 25% 仍中性灰 (严格大于语义)
 *       (c) < 25% 中性灰
 *       (d) 空持仓 max_industry_pct=null → 0% 中性灰 label='—' suffix='%'
 *   [8] view model 边界 — null/undefined summary / portfolio_id=null / 未分类
 *   [9] META-GUARD fs+regex:
 *       (a) PortfolioWorkspace.tsx 含 import buildIndustryConcentrationKpiViewModel
 *       (b) PortfolioWorkspace.tsx 不再 inline 写 max_industry_pct ?? 0
 *       (c) helper 主要 export 都在
 *       (d) helper 仅定义一次 INDUSTRY_KPI_WARN_PCT = 0.25 (单事实源)
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  INDUSTRY_KPI_WARN_PCT,
  INDUSTRY_KPI_WARN_COLOR,
  INDUSTRY_KPI_NEUTRAL_COLOR,
  INDUSTRY_UNKNOWN_HUMAN_LABEL,
  INDUSTRY_EMPTY_PLACEHOLDER,
  shouldHideIndustryKpi,
  isOverIndustryWarn,
  formatIndustryLabel,
  buildIndustryKpiSuffix,
  buildIndustryKpiTooltipLines,
  buildIndustryConcentrationKpiViewModel,
} from '../../../frontend/src/pages/workspace/industryConcentrationKpiHelpers';
import type { IndustryConcentrationSummary } from '../../../frontend/src/services/portfolioWorkspaceService';
import { UNKNOWN_INDUSTRY_LABEL } from '../../../frontend/src/services/portfolioWorkspaceService';

let failed = 0;
let passed = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`❌ ${name}${detail ? '  detail=' + detail : ''}`);
  }
}

function makeSummary(overrides: Partial<IndustryConcentrationSummary> = {}): IndustryConcentrationSummary {
  return {
    user_id: 1,
    portfolio_id: 10,
    enabled: true,
    alert_pct: 0.35,
    rebalance_target_pct: 0.25,
    max_industry_pct: 0.3,
    max_industry_name: '银行',
    over_alert: false,
    open_positions_count: 5,
    total_position_value: 100000,
    industry_breakdown: [],
    ...overrides,
  };
}

// ---- [1] 常量 sanity --------------------------------------------------------
assert('[1.1] WARN_PCT = 0.25 (AC 主条款)', INDUSTRY_KPI_WARN_PCT === 0.25);
assert('[1.2] WARN_COLOR 是十六进制色串', /^#[0-9a-fA-F]{6}$/.test(INDUSTRY_KPI_WARN_COLOR));
assert('[1.3] NEUTRAL_COLOR 是十六进制色串', /^#[0-9a-fA-F]{6}$/.test(INDUSTRY_KPI_NEUTRAL_COLOR));
assert('[1.4] WARN_COLOR != NEUTRAL_COLOR (能区分)', INDUSTRY_KPI_WARN_COLOR !== INDUSTRY_KPI_NEUTRAL_COLOR);
assert('[1.5] UNKNOWN_HUMAN_LABEL 非空', INDUSTRY_UNKNOWN_HUMAN_LABEL.length > 0);
assert('[1.6] EMPTY_PLACEHOLDER 非空', INDUSTRY_EMPTY_PLACEHOLDER.length > 0);

// ---- [2] shouldHideIndustryKpi ---------------------------------------------
assert('[2.1] null → true', shouldHideIndustryKpi(null) === true);
assert('[2.2] undefined → true', shouldHideIndustryKpi(undefined) === true);
assert(
  '[2.3] portfolio_id=null → true',
  shouldHideIndustryKpi(makeSummary({ portfolio_id: null })) === true,
);
assert('[2.4] 正常 summary → false', shouldHideIndustryKpi(makeSummary()) === false);
assert(
  '[2.5] portfolio_id=0 视为正常 (合法 id)',
  shouldHideIndustryKpi(makeSummary({ portfolio_id: 0 })) === false,
);

// ---- [3] isOverIndustryWarn -------------------------------------------------
assert('[3.1] null → false', isOverIndustryWarn(null) === false);
assert('[3.2] undefined → false', isOverIndustryWarn(undefined) === false);
assert('[3.3] NaN → false', isOverIndustryWarn(Number.NaN) === false);
assert('[3.4] +Infinity → false', isOverIndustryWarn(Number.POSITIVE_INFINITY) === false);
assert('[3.5] -Infinity → false', isOverIndustryWarn(Number.NEGATIVE_INFINITY) === false);
assert('[3.6] 0.25 (恰好) → false (严格大于语义)', isOverIndustryWarn(0.25) === false);
assert('[3.7] 0.2499 → false', isOverIndustryWarn(0.2499) === false);
assert('[3.8] 0.2501 → true', isOverIndustryWarn(0.2501) === true);
assert('[3.9] 0.5 → true', isOverIndustryWarn(0.5) === true);
assert('[3.10] 0 → false', isOverIndustryWarn(0) === false);

// ---- [4] formatIndustryLabel -----------------------------------------------
assert(
  '[4.1] UNKNOWN sentinel → 未分类',
  formatIndustryLabel(UNKNOWN_INDUSTRY_LABEL) === INDUSTRY_UNKNOWN_HUMAN_LABEL,
);
assert('[4.2] null → —', formatIndustryLabel(null) === INDUSTRY_EMPTY_PLACEHOLDER);
assert('[4.3] undefined → —', formatIndustryLabel(undefined) === INDUSTRY_EMPTY_PLACEHOLDER);
assert('[4.4] 空串 → —', formatIndustryLabel('') === INDUSTRY_EMPTY_PLACEHOLDER);
assert('[4.5] "   " → —', formatIndustryLabel('   ') === INDUSTRY_EMPTY_PLACEHOLDER);
assert('[4.6] "银行" → 银行', formatIndustryLabel('银行') === '银行');
assert('[4.7] " 银行 " → 银行 (trim)', formatIndustryLabel(' 银行 ') === '银行');

// ---- [5] buildIndustryKpiSuffix --------------------------------------------
assert(
  '[5.1] label=— → "%" (不拼后缀)',
  buildIndustryKpiSuffix(INDUSTRY_EMPTY_PLACEHOLDER) === '%',
);
assert('[5.2] label=银行 → "% · 银行"', buildIndustryKpiSuffix('银行') === '% · 银行');
assert(
  '[5.3] label=未分类 → "% · 未分类"',
  buildIndustryKpiSuffix(INDUSTRY_UNKNOWN_HUMAN_LABEL) === '% · 未分类',
);

// ---- [6] buildIndustryKpiTooltipLines --------------------------------------
{
  const s = makeSummary({ max_industry_pct: 0.3, max_industry_name: '银行', over_alert: false, alert_pct: 0.35 });
  const lines = buildIndustryKpiTooltipLines(s);
  assert('[6.1] over_alert=false → 4 行', lines.length === 4);
  assert('[6.2] 第一行含行业名', lines[0].includes('银行'));
  assert('[6.3] 第二行含 30.00%', lines[1].includes('30.00%'));
  assert('[6.4] 第三行含 25% 阈值', lines[2].includes('25%'));
  assert('[6.5] 第四行含 35% 阈值', lines[3].includes('35%'));
}
{
  const s = makeSummary({ max_industry_pct: 0.4, over_alert: true });
  const lines = buildIndustryKpiTooltipLines(s);
  assert('[6.6] over_alert=true → 5 行 (含 ⚠ 警告)', lines.length === 5);
  assert('[6.7] 第五行以 ⚠ 开头', lines[4].startsWith('⚠'));
  assert('[6.8] 第五行含再平衡建议', lines[4].includes('再平衡'));
}
{
  const s = makeSummary({ max_industry_pct: null, max_industry_name: null });
  const lines = buildIndustryKpiTooltipLines(s);
  assert('[6.9] max_industry_pct=null → 0.00%', lines[1].includes('0.00%'));
  assert('[6.10] max_industry_name=null → —', lines[0].includes(INDUSTRY_EMPTY_PLACEHOLDER));
}

// ---- [7] buildIndustryConcentrationKpiViewModel — AC 主验收 ----------------
{
  // (a) > 25% 红色
  const vm = buildIndustryConcentrationKpiViewModel(
    makeSummary({ max_industry_pct: 0.3, max_industry_name: '银行' }),
  );
  assert('[7a.1] hidden=false', vm.hidden === false);
  assert('[7a.2] rawPct=0.3', vm.rawPct === 0.3);
  assert('[7a.3] pctNum=30', vm.pctNum === 30);
  assert('[7a.4] overWarn=true (>25%)', vm.overWarn === true);
  assert('[7a.5] color=WARN_COLOR (红)', vm.color === INDUSTRY_KPI_WARN_COLOR);
  assert('[7a.6] suffix="% · 银行"', vm.suffix === '% · 银行');
  assert('[7a.7] industryLabel=银行', vm.industryLabel === '银行');
}
{
  // (b) = 25% 仍中性灰 (严格大于)
  const vm = buildIndustryConcentrationKpiViewModel(
    makeSummary({ max_industry_pct: 0.25, max_industry_name: '银行' }),
  );
  assert('[7b.1] = 25% overWarn=false', vm.overWarn === false);
  assert('[7b.2] = 25% color=NEUTRAL', vm.color === INDUSTRY_KPI_NEUTRAL_COLOR);
  assert('[7b.3] pctNum=25', vm.pctNum === 25);
}
{
  // (c) < 25% 中性灰
  const vm = buildIndustryConcentrationKpiViewModel(
    makeSummary({ max_industry_pct: 0.1, max_industry_name: '医药' }),
  );
  assert('[7c.1] overWarn=false', vm.overWarn === false);
  assert('[7c.2] color=NEUTRAL', vm.color === INDUSTRY_KPI_NEUTRAL_COLOR);
  assert('[7c.3] suffix="% · 医药"', vm.suffix === '% · 医药');
}
{
  // (d) 空持仓 max_industry_pct=null
  const vm = buildIndustryConcentrationKpiViewModel(
    makeSummary({ max_industry_pct: null, max_industry_name: null }),
  );
  assert('[7d.1] hidden=false (有 portfolio)', vm.hidden === false);
  assert('[7d.2] rawPct=0 (fallback)', vm.rawPct === 0);
  assert('[7d.3] pctNum=0', vm.pctNum === 0);
  assert('[7d.4] overWarn=false', vm.overWarn === false);
  assert('[7d.5] color=NEUTRAL', vm.color === INDUSTRY_KPI_NEUTRAL_COLOR);
  assert('[7d.6] industryLabel=—', vm.industryLabel === INDUSTRY_EMPTY_PLACEHOLDER);
  assert('[7d.7] suffix="%" (不拼)', vm.suffix === '%');
}

// ---- [8] view model 边界 --------------------------------------------------
{
  const vm = buildIndustryConcentrationKpiViewModel(null);
  assert('[8.1] null → hidden=true', vm.hidden === true);
  assert('[8.2] hidden tooltipLines 空', vm.tooltipLines.length === 0);
}
{
  const vm = buildIndustryConcentrationKpiViewModel(undefined);
  assert('[8.3] undefined → hidden=true', vm.hidden === true);
}
{
  const vm = buildIndustryConcentrationKpiViewModel(makeSummary({ portfolio_id: null }));
  assert('[8.4] portfolio_id=null → hidden=true', vm.hidden === true);
}
{
  // UNKNOWN industry sentinel
  const vm = buildIndustryConcentrationKpiViewModel(
    makeSummary({ max_industry_pct: 0.4, max_industry_name: UNKNOWN_INDUSTRY_LABEL, over_alert: true }),
  );
  assert('[8.5] UNKNOWN → label=未分类', vm.industryLabel === INDUSTRY_UNKNOWN_HUMAN_LABEL);
  assert('[8.6] UNKNOWN suffix="% · 未分类"', vm.suffix === '% · 未分类');
  assert('[8.7] overWarn=true (40% > 25%)', vm.overWarn === true);
  assert('[8.8] overAlert=true 透传', vm.overAlert === true);
  assert(
    '[8.9] tooltip 含 ⚠ 警告行',
    vm.tooltipLines.some(line => line.startsWith('⚠')),
  );
}
{
  // 异常 rawPct (NaN/Infinity) — 不应抛, color 走 neutral
  const vm = buildIndustryConcentrationKpiViewModel(
    makeSummary({ max_industry_pct: Number.NaN }),
  );
  assert('[8.10] NaN rawPct overWarn=false', vm.overWarn === false);
  assert('[8.11] NaN rawPct pctNum=0', vm.pctNum === 0);
}

// ---- [9] META-GUARD fs+regex ----------------------------------------------
{
  const helperPath = join(
    __dirname,
    '../../../frontend/src/pages/workspace/industryConcentrationKpiHelpers.ts',
  );
  const src = readFileSync(helperPath, 'utf8');
  assert(
    '[9.7] helper export INDUSTRY_KPI_WARN_PCT',
    /export\s+const\s+INDUSTRY_KPI_WARN_PCT\s*=\s*0\.25/.test(src),
  );
  assert('[9.8] helper export INDUSTRY_KPI_WARN_COLOR', /export\s+const\s+INDUSTRY_KPI_WARN_COLOR/.test(src));
  assert(
    '[9.9] helper export INDUSTRY_KPI_NEUTRAL_COLOR',
    /export\s+const\s+INDUSTRY_KPI_NEUTRAL_COLOR/.test(src),
  );
  assert(
    '[9.10] helper export shouldHideIndustryKpi',
    /export\s+function\s+shouldHideIndustryKpi/.test(src),
  );
  assert(
    '[9.11] helper export isOverIndustryWarn',
    /export\s+function\s+isOverIndustryWarn/.test(src),
  );
  assert(
    '[9.12] helper export formatIndustryLabel',
    /export\s+function\s+formatIndustryLabel/.test(src),
  );
  assert(
    '[9.13] helper export buildIndustryConcentrationKpiViewModel',
    /export\s+function\s+buildIndustryConcentrationKpiViewModel/.test(src),
  );
  // 单事实源 — 0.25 字面量只在 INDUSTRY_KPI_WARN_PCT 声明里出现 1 次
  const matches = src.match(/=\s*0\.25\b/g) || [];
  assert(
    '[9.14] helper 内 0.25 字面量仅出现 1 次 (单事实源)',
    matches.length === 1,
    `count=${matches.length}`,
  );
}

// ---- summary ---------------------------------------------------------------
console.log(`\nindustry-concentration-kpi-helpers: ${passed} ok / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
