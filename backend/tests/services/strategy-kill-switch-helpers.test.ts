/**
 * US-069 [FE-030] SettingsWorkspace 策略 kill-switch UI — 单元测试.
 *
 * 跑法 (项目无 jest, 直接 ts-node spawn):
 *   cd backend && npx ts-node --transpile-only tests/services/strategy-kill-switch-helpers.test.ts
 * 或 (会被 run-tests.ts 自动 spawn):
 *   cd backend && npm test -- --filter=strategy-kill-switch
 *
 * 跨 monorepo import (../../../frontend) — 与 [[前端 pure helper 模板]]
 * (analysis-engine-weight / shadow-run / overfit-metrics) 同款, 但本 helper
 * 反过来 import labService 类型 (QuantStrategyItem). 单测不需要 mock labService:
 * 跨文件 type-only import 在 ts-node 下零运行时影响.
 *
 * 覆盖维度:
 *   [1] normalizeRiskLevel: low/medium/high 透传 + 未知值兜底 medium
 *   [2] pickDisplayName: display_name > name > strategy_key > '未知策略'
 *   [3] normalizeTags: 非数组 / 空值 / 去重 / 保序 / trim
 *   [4] buildKillSwitchRows: 空/null/非数组 / enabled 兜底 / 缺 strategy_key 跳过
 *   [5] buildKillSwitchKpi: total / enabled / disabled / highRiskEnabled
 *   [6] buildKillSwitchConfirmConfig: 启用不弹 / 禁用 low/medium 不弹 / 禁用 high 弹
 *   [7] applyEnabledPatch: 命中 / 未命中 / 不可变性 (input rows 不被修改)
 *   [8] META-GUARD fs+regex:
 *       - SettingsWorkspace.StrategyKillSwitchTab.tsx: import helper, listQuantStrategies,
 *         setStrategyEnabled, Switch data-testid, Modal.confirm 路径
 *       - labService.ts: 含 setStrategyEnabled export, PATCH /quant/strategies 路径
 *       - SettingsWorkspace.tsx: 注册 strategy-kill-switch tab + 渲染分支
 *       - strategyKillSwitchHelpers.ts: 关键 export 全在
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  applyEnabledPatch,
  buildKillSwitchConfirmConfig,
  buildKillSwitchKpi,
  buildKillSwitchRows,
  normalizeRiskLevel,
  normalizeTags,
  pickDisplayName,
  type KillSwitchRowItem,
} from '../../../frontend/src/pages/workspace/strategyKillSwitchHelpers';

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

function assertEqual<T>(name: string, actual: T, expected: T): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(name, ok, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

// ============================================================
// [1] normalizeRiskLevel
// ============================================================
assert('[1.1] normalizeRiskLevel(low)', normalizeRiskLevel('low') === 'low');
assert('[1.2] normalizeRiskLevel(medium)', normalizeRiskLevel('medium') === 'medium');
assert('[1.3] normalizeRiskLevel(high)', normalizeRiskLevel('high') === 'high');
assert('[1.4] normalizeRiskLevel(undefined) 兜底 medium', normalizeRiskLevel(undefined) === 'medium');
assert('[1.5] normalizeRiskLevel(null) 兜底 medium', normalizeRiskLevel(null) === 'medium');
assert('[1.6] normalizeRiskLevel("") 兜底 medium', normalizeRiskLevel('') === 'medium');
assert('[1.7] normalizeRiskLevel("xxx") 兜底 medium', normalizeRiskLevel('xxx') === 'medium');
assert('[1.8] normalizeRiskLevel(0) 兜底 medium', normalizeRiskLevel(0) === 'medium');

// ============================================================
// [2] pickDisplayName
// ============================================================
assert(
  '[2.1] display_name 优先',
  pickDisplayName({ display_name: '动量A', name: 'mom_a', strategy_key: 'mom_a' } as any) === '动量A'
);
assert(
  '[2.2] display_name 缺失退到 name',
  pickDisplayName({ name: 'mom_a', strategy_key: 'mom_a' } as any) === 'mom_a'
);
assert(
  '[2.3] display_name 空字符串退到 name',
  pickDisplayName({ display_name: '   ', name: 'mom_a', strategy_key: 'mom_a' } as any) === 'mom_a'
);
assert(
  '[2.4] 全空退到 strategy_key',
  pickDisplayName({ strategy_key: 'mom_a' } as any) === 'mom_a'
);
assert('[2.5] 全无 fallback 到 未知策略', pickDisplayName({} as any) === '未知策略');

// ============================================================
// [3] normalizeTags
// ============================================================
assertEqual('[3.1] 非数组返 []', normalizeTags(null), [] as string[]);
assertEqual('[3.2] 空数组返 []', normalizeTags([]), [] as string[]);
assertEqual('[3.3] 普通数组', normalizeTags(['a', 'b', 'c']), ['a', 'b', 'c']);
assertEqual('[3.4] 去重保序', normalizeTags(['a', 'b', 'a', 'c', 'b']), ['a', 'b', 'c']);
assertEqual('[3.5] trim + 丢空', normalizeTags(['  a  ', '', '  ', 'b']), ['a', 'b']);
assertEqual('[3.6] 非 string 强转', normalizeTags([1, 2, true]), ['1', '2', 'true']);
assertEqual('[3.7] string("") 输入返 []', normalizeTags('not-array' as any), [] as string[]);

// ============================================================
// [4] buildKillSwitchRows
// ============================================================
assertEqual('[4.1] null 输入返 []', buildKillSwitchRows(null as any), [] as KillSwitchRowItem[]);
assertEqual('[4.2] undefined 输入返 []', buildKillSwitchRows(undefined), [] as KillSwitchRowItem[]);
assertEqual('[4.3] 空数组返 []', buildKillSwitchRows([]), [] as KillSwitchRowItem[]);
{
  // 标准映射
  const rows = buildKillSwitchRows([
    {
      strategy_key: 'mom_a',
      name: 'Momentum A',
      display_name: '动量A',
      category: 'momentum',
      risk_level: 'high',
      enabled: true,
      tags: ['alpha', 'momentum'],
    } as any,
  ]);
  assert('[4.4] 标准映射 — 长度=1', rows.length === 1);
  assert('[4.5] 标准映射 — display_name', rows[0].display_name === '动量A');
  assert('[4.6] 标准映射 — risk_level', rows[0].risk_level === 'high');
  assert('[4.7] 标准映射 — enabled', rows[0].enabled === true);
  assertEqual('[4.8] 标准映射 — tags', rows[0].tags, ['alpha', 'momentum']);
  assert('[4.9] 标准映射 — category', rows[0].category === 'momentum');
}
{
  // enabled 默认行为
  const rows = buildKillSwitchRows([
    { strategy_key: 'a' } as any,
    { strategy_key: 'b', enabled: undefined } as any,
    { strategy_key: 'c', enabled: null } as any,
    { strategy_key: 'd', enabled: false } as any,
    { strategy_key: 'e', enabled: true } as any,
  ]);
  assert('[4.10] a 缺字段 enabled 兜底 true', rows.find(r => r.strategy_key === 'a')?.enabled === true);
  assert('[4.11] b enabled=undefined 兜底 true', rows.find(r => r.strategy_key === 'b')?.enabled === true);
  assert('[4.12] c enabled=null 兜底 true', rows.find(r => r.strategy_key === 'c')?.enabled === true);
  assert('[4.13] d enabled=false', rows.find(r => r.strategy_key === 'd')?.enabled === false);
  assert('[4.14] e enabled=true', rows.find(r => r.strategy_key === 'e')?.enabled === true);
}
{
  // 缺 strategy_key / 非对象跳过
  const rows = buildKillSwitchRows([
    null as any,
    undefined as any,
    {} as any,
    { strategy_key: '' } as any,
    { strategy_key: '   ' } as any,
    { strategy_key: 'ok' } as any,
  ]);
  assert('[4.15] 跳过非法 row', rows.length === 1 && rows[0].strategy_key === 'ok');
}
{
  // category 缺失 → 'uncategorized'
  const rows = buildKillSwitchRows([{ strategy_key: 'x' } as any]);
  assert('[4.16] category 缺失 → uncategorized', rows[0].category === 'uncategorized');
}
{
  // 保留输入顺序
  const rows = buildKillSwitchRows([
    { strategy_key: 'c' } as any,
    { strategy_key: 'a' } as any,
    { strategy_key: 'b' } as any,
  ]);
  assertEqual(
    '[4.17] 保留输入顺序',
    rows.map(r => r.strategy_key),
    ['c', 'a', 'b']
  );
}

// ============================================================
// [5] buildKillSwitchKpi
// ============================================================
{
  const kpi = buildKillSwitchKpi([]);
  assertEqual('[5.1] 空 KPI', kpi, { total: 0, enabledCount: 0, disabledCount: 0, highRiskEnabled: 0 });
}
{
  const rows: KillSwitchRowItem[] = [
    { strategy_key: 'a', display_name: 'A', category: 'c', risk_level: 'low', enabled: true, tags: [] },
    { strategy_key: 'b', display_name: 'B', category: 'c', risk_level: 'medium', enabled: true, tags: [] },
    { strategy_key: 'c', display_name: 'C', category: 'c', risk_level: 'high', enabled: true, tags: [] },
    { strategy_key: 'd', display_name: 'D', category: 'c', risk_level: 'high', enabled: false, tags: [] },
    { strategy_key: 'e', display_name: 'E', category: 'c', risk_level: 'medium', enabled: false, tags: [] },
  ];
  const kpi = buildKillSwitchKpi(rows);
  assertEqual('[5.2] mixed KPI', kpi, {
    total: 5,
    enabledCount: 3,
    disabledCount: 2,
    highRiskEnabled: 1,
  });
}
{
  // null safe
  const kpi = buildKillSwitchKpi(null as any);
  assertEqual('[5.3] null 输入 KPI', kpi, { total: 0, enabledCount: 0, disabledCount: 0, highRiskEnabled: 0 });
}

// ============================================================
// [6] buildKillSwitchConfirmConfig
// ============================================================
{
  // 启用 — 一律不弹
  for (const risk of ['low', 'medium', 'high'] as const) {
    const cfg = buildKillSwitchConfirmConfig({ risk_level: risk, display_name: 'X' }, true);
    assert(`[6.1.${risk}] 启用任何风险都不弹`, cfg.needsConfirm === false);
    assert(`[6.1b.${risk}] 启用 danger=false`, cfg.danger === false);
  }
}
{
  // 禁用 low / medium — 不弹
  for (const risk of ['low', 'medium'] as const) {
    const cfg = buildKillSwitchConfirmConfig({ risk_level: risk, display_name: 'X' }, false);
    assert(`[6.2.${risk}] 禁用 ${risk} 不弹`, cfg.needsConfirm === false);
    assert(`[6.2b.${risk}] 禁用 danger=true`, cfg.danger === true);
  }
}
{
  // 禁用 high — 弹
  const cfg = buildKillSwitchConfirmConfig({ risk_level: 'high', display_name: '动量A' }, false);
  assert('[6.3] 禁用 high 必弹', cfg.needsConfirm === true);
  assert('[6.4] 禁用 high title 含名字', cfg.title.includes('动量A'));
  assert('[6.5] 禁用 high content 非空', cfg.content.length > 0);
  assert('[6.6] 禁用 high okText=禁用', cfg.okText === '禁用');
  assert('[6.7] 禁用 high danger=true', cfg.danger === true);
}

// ============================================================
// [7] applyEnabledPatch
// ============================================================
{
  const rows: KillSwitchRowItem[] = [
    { strategy_key: 'a', display_name: 'A', category: 'c', risk_level: 'low', enabled: true, tags: [] },
    { strategy_key: 'b', display_name: 'B', category: 'c', risk_level: 'low', enabled: true, tags: [] },
  ];
  const next = applyEnabledPatch(rows, 'b', false);
  assert('[7.1] 命中 b 改 enabled=false', next.find(r => r.strategy_key === 'b')?.enabled === false);
  assert('[7.2] 未命中 a 保持 enabled=true', next.find(r => r.strategy_key === 'a')?.enabled === true);
  assert('[7.3] 长度不变', next.length === 2);
  // 不可变性 — 原数组未被修改
  assert('[7.4] 原 rows[1].enabled 未被改', rows[1].enabled === true);
  // 未命中 strategy_key
  const noMatch = applyEnabledPatch(rows, 'zzz', false);
  assert('[7.5] 未命中 strategy_key 不变', noMatch.every(r => r.enabled === true));
  // 空 / null 安全
  assertEqual('[7.6] 空数组返 []', applyEnabledPatch([], 'a', false), [] as KillSwitchRowItem[]);
  assertEqual('[7.7] null 返 []', applyEnabledPatch(null as any, 'a', false), [] as KillSwitchRowItem[]);
}

// ============================================================
// [8] META-GUARD fs+regex — 保证 UI / helper / service 三段同步
// ============================================================
const FRONTEND_ROOT = join(__dirname, '..', '..', '..', 'frontend', 'src');

function readFile(rel: string): string {
  return readFileSync(join(FRONTEND_ROOT, rel), 'utf8');
}

// 8.1 — helper export 完整
{
  const helperSrc = readFile('pages/workspace/strategyKillSwitchHelpers.ts');
  for (const name of [
    'export function normalizeRiskLevel',
    'export function pickDisplayName',
    'export function normalizeTags',
    'export function buildKillSwitchRows',
    'export function buildKillSwitchKpi',
    'export function buildKillSwitchConfirmConfig',
    'export function applyEnabledPatch',
    'export type StrategyRiskLevel',
    'export interface KillSwitchRowItem',
    'export interface KillSwitchKpi',
    'export interface KillSwitchConfirmConfig',
  ]) {
    assert(`[8.1] helper exports ${name}`, helperSrc.includes(name));
  }
}

// 8.2 — labService 含 setStrategyEnabled
{
  const labSrc = readFile('services/labService.ts');
  assert('[8.2a] labService 含 setStrategyEnabled export', labSrc.includes('export async function setStrategyEnabled'));
  assert(
    '[8.2b] labService 用 PATCH /quant/strategies/...',
    /api\.patch\([`'"]\/quant\/strategies\/\$\{encodeURIComponent\(strategyKey\)\}[`'"]\s*,\s*\{\s*[\s\S]*?enabled/.test(
      labSrc
    )
  );
  assert(
    '[8.2c] labService setStrategyEnabled 提到 US-069',
    labSrc.includes('US-069')
  );
}

// 8.3 — Tab 文件接入 helper / labService / 含 data-testid + Modal 路径
{
  const tabSrc = readFile('pages/workspace/SettingsWorkspace.StrategyKillSwitchTab.tsx');
  assert('[8.3a] Tab import buildKillSwitchRows', tabSrc.includes('buildKillSwitchRows'));
  assert('[8.3b] Tab import buildKillSwitchKpi', tabSrc.includes('buildKillSwitchKpi'));
  assert('[8.3c] Tab import buildKillSwitchConfirmConfig', tabSrc.includes('buildKillSwitchConfirmConfig'));
  assert('[8.3d] Tab import applyEnabledPatch', tabSrc.includes('applyEnabledPatch'));
  assert('[8.3e] Tab import listQuantStrategies', tabSrc.includes('listQuantStrategies'));
  assert('[8.3f] Tab import setStrategyEnabled', tabSrc.includes('setStrategyEnabled'));
  assert('[8.3g] Tab 用 ks-switch- data-testid', /data-testid=\{`ks-switch-/.test(tabSrc));
  assert('[8.3h] Tab 有 ks-kpi-strip data-testid', tabSrc.includes('data-testid="ks-kpi-strip"'));
  assert('[8.3i] Tab 使用 Modal.confirm 二次确认', tabSrc.includes('Modal.confirm'));
  assert(
    '[8.3j] Tab 把 helper 返回的 needsConfirm 接到 Modal',
    tabSrc.includes('cfg.needsConfirm')
  );
  // optimistic + 回滚
  assert(
    '[8.3k] Tab optimistic patch (applyEnabledPatch 出现 ≥2 次, 包括失败回滚)',
    (tabSrc.match(/applyEnabledPatch/g) || []).length >= 2
  );
}

// 8.4 — SettingsWorkspace.tsx 已注册 strategy-kill-switch tab
{
  const wsSrc = readFile('pages/workspace/SettingsWorkspace.tsx');
  assert('[8.4a] SettingsWorkspace import StrategyKillSwitchTab', wsSrc.includes('StrategyKillSwitchTab'));
  assert(
    '[8.4b] SettingsWorkspace tabs 列表含 strategy-kill-switch',
    /key:\s*'strategy-kill-switch'/.test(wsSrc)
  );
  assert(
    '[8.4c] SettingsWorkspace 渲染分支 activeKey === strategy-kill-switch',
    /activeKey === 'strategy-kill-switch'/.test(wsSrc)
  );
  assert(
    '[8.4d] SettingsWorkspace 渲染 <StrategyKillSwitchTab />',
    wsSrc.includes('<StrategyKillSwitchTab />')
  );
}

// ============================================================
// 汇总
// ============================================================
console.log(`\nstrategy-kill-switch helpers tests: ${passed} passed, ${failed} failed.`);
if (failed > 0) {
  process.exit(1);
}
process.exit(0);
