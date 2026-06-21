/**
 * US-053 LabWorkspace 快速 grid 模板 (FE-014) 单元测试
 *
 * 不依赖 jest; 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/walk-forward-grid-template.test.ts
 *
 * 不依赖 DB/网络/React: 全部 import 自
 *   frontend/src/pages/workspace/walkForwardGridTemplateHelpers.ts
 * (pure helpers, 无 antd/react), + 注入 in-memory storage mock.
 *
 * 覆盖维度:
 *   [1] 常量值 sanity
 *   [2] BUILTIN_GRID_TEMPLATES — 4 套预设形态 / frozen
 *   [3] normalizeTemplateName — 空 / 空白 / 超长 / 正常
 *   [4] sanitizeParamGrid — 各种垃圾输入 / 超限截断 / 正常
 *   [5] countGridCombinations — 0 维 / N 维乘积
 *   [6] isValidTemplateShape — 缺字段 / 形态错 / 正常
 *   [7] listUserGridTemplates — 空 / 损坏 JSON / 错 schemaVersion / 部分非法被过滤
 *   [8] listAllGridTemplates — builtin 在前 / 按 strategy_key 上浮 / user 按 savedAt 倒序
 *   [9] saveGridTemplate — 新增 / 覆盖 / name 非法 / builtin 撞名 / 空 grid / param 数超限 / 上限
 *  [10] deleteGridTemplate — 找不到 noop / builtin 不可删 / 用户模板可删
 *  [11] findGridTemplate — builtin/user 命中, 未命中 null
 *  [12] paramGridToJsonString
 *  [13] META-GUARD fs+regex:
 *       - WalkForwardTab.tsx: import helper + 选 template 时调 setFieldsValue + data-testid
 *       - sessionCleanup.ts: 包含 'lab_grid_templates_v1' key
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  GRID_TEMPLATES_STORAGE_KEY,
  GRID_TEMPLATE_SCHEMA_VERSION,
  GRID_TEMPLATE_NAME_MAX_LEN,
  GRID_TEMPLATE_MAX_COUNT,
  GRID_TEMPLATE_PARAM_VALUES_MAX,
  GRID_TEMPLATE_PARAM_KEYS_MAX,
  BUILTIN_GRID_TEMPLATES,
  GridTemplateStorage,
  normalizeTemplateName,
  sanitizeParamGrid,
  countGridCombinations,
  isValidTemplateShape,
  listUserGridTemplates,
  listAllGridTemplates,
  saveGridTemplate,
  deleteGridTemplate,
  findGridTemplate,
  paramGridToJsonString,
} from '../../../frontend/src/pages/workspace/walkForwardGridTemplateHelpers';

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

function mkStorage(initial?: string): GridTemplateStorage {
  const map = new Map<string, string>();
  if (initial !== undefined) map.set(GRID_TEMPLATES_STORAGE_KEY, initial);
  return {
    getItem: k => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: k => {
      map.delete(k);
    },
  };
}

const NOW = new Date('2026-06-19T10:00:00.000Z');
const fixedNow = () => NOW;

// ---- [1] 常量值 sanity ------------------------------------------------------
assert('[1.1] STORAGE_KEY 是 lab_grid_templates_v1', GRID_TEMPLATES_STORAGE_KEY === 'lab_grid_templates_v1');
assert('[1.2] SCHEMA_VERSION = 1', GRID_TEMPLATE_SCHEMA_VERSION === 1);
assert(
  '[1.3] NAME_MAX_LEN 合理',
  GRID_TEMPLATE_NAME_MAX_LEN > 0 && GRID_TEMPLATE_NAME_MAX_LEN <= 200
);
assert(
  '[1.4] MAX_COUNT 合理',
  GRID_TEMPLATE_MAX_COUNT >= 5 && GRID_TEMPLATE_MAX_COUNT <= 100
);
assert(
  '[1.5] PARAM_VALUES_MAX 合理',
  GRID_TEMPLATE_PARAM_VALUES_MAX >= 3 && GRID_TEMPLATE_PARAM_VALUES_MAX <= 50
);
assert(
  '[1.6] PARAM_KEYS_MAX 合理',
  GRID_TEMPLATE_PARAM_KEYS_MAX >= 2 && GRID_TEMPLATE_PARAM_KEYS_MAX <= 20
);

// ---- [2] BUILTIN_GRID_TEMPLATES ---------------------------------------------
assert('[2.1] builtin ≥ 3 套', BUILTIN_GRID_TEMPLATES.length >= 3);
assert(
  '[2.2] builtin 全部 source=builtin',
  BUILTIN_GRID_TEMPLATES.every(t => t.source === 'builtin')
);
assert(
  '[2.3] builtin name 唯一',
  new Set(BUILTIN_GRID_TEMPLATES.map(t => t.name)).size === BUILTIN_GRID_TEMPLATES.length
);
assert(
  '[2.4] builtin 全部通过 isValidTemplateShape',
  BUILTIN_GRID_TEMPLATES.every(t => isValidTemplateShape(t))
);
// frozen
try {
  // @ts-expect-error 故意改 frozen
  BUILTIN_GRID_TEMPLATES[0].name = 'mutated';
  assert(
    '[2.5] builtin frozen — 修改不生效',
    BUILTIN_GRID_TEMPLATES[0].name !== 'mutated'
  );
} catch {
  // strict mode 会抛 — 同样视为通过
  assert('[2.5] builtin frozen — 修改不生效', true);
}
assert(
  '[2.6] 至少有一个 builtin 覆盖 cta100_momentum',
  BUILTIN_GRID_TEMPLATES.some(t => (t.forStrategies || []).includes('cta100_momentum'))
);
assert(
  '[2.7] 至少有一个 builtin 覆盖 multi_factor_alpha',
  BUILTIN_GRID_TEMPLATES.some(t => (t.forStrategies || []).includes('multi_factor_alpha'))
);

// ---- [3] normalizeTemplateName ---------------------------------------------
assert('[3.1] null → null', normalizeTemplateName(null) === null);
assert('[3.2] undefined → null', normalizeTemplateName(undefined) === null);
assert('[3.3] 空串 → null', normalizeTemplateName('') === null);
assert('[3.4] 仅空白 → null', normalizeTemplateName('   \n\t  ') === null);
assert('[3.5] 正常 + trim', normalizeTemplateName('  我的网格  ') === '我的网格');
assert(
  '[3.6] 超长 → null',
  normalizeTemplateName('A'.repeat(GRID_TEMPLATE_NAME_MAX_LEN + 1)) === null
);
assert(
  '[3.7] 临界长度 = MAX_LEN → 合法',
  normalizeTemplateName('A'.repeat(GRID_TEMPLATE_NAME_MAX_LEN)) ===
    'A'.repeat(GRID_TEMPLATE_NAME_MAX_LEN)
);

// ---- [4] sanitizeParamGrid --------------------------------------------------
assert('[4.1] null → {}', Object.keys(sanitizeParamGrid(null)).length === 0);
assert('[4.2] [] → {}', Object.keys(sanitizeParamGrid([])).length === 0);
assert('[4.3] 字符串 → {}', Object.keys(sanitizeParamGrid('abc')).length === 0);
const g1 = sanitizeParamGrid({ topN: [10, 20, NaN, '30', null, Infinity] });
assert('[4.4] 丢 NaN/字符串/null/Infinity', g1.topN.length === 2 && g1.topN[0] === 10 && g1.topN[1] === 20);
const g2 = sanitizeParamGrid({ topN: [10, 20], stopLossPct: [] });
assert('[4.5] 空数组的 key 被丢', Object.keys(g2).length === 1 && !('stopLossPct' in g2));
const g3 = sanitizeParamGrid({ topN: 'not-array', stopLossPct: [10] });
assert('[4.6] 非数组 value 的 key 被丢', !('topN' in g3) && g3.stopLossPct[0] === 10);
const g4 = sanitizeParamGrid({ topN: Array.from({ length: 100 }, (_, i) => i + 1) });
assert(
  '[4.7] 超 PARAM_VALUES_MAX 截断',
  g4.topN.length === GRID_TEMPLATE_PARAM_VALUES_MAX
);

// ---- [5] countGridCombinations ----------------------------------------------
assert('[5.1] 空 grid → 0', countGridCombinations({}) === 0);
assert('[5.2] 1×3 → 3', countGridCombinations({ a: [1, 2, 3] }) === 3);
assert('[5.3] 2×3 → 6', countGridCombinations({ a: [1, 2], b: [1, 2, 3] }) === 6);
assert(
  '[5.4] 3×3×3 → 27',
  countGridCombinations({ a: [1, 2, 3], b: [4, 5, 6], c: [7, 8, 9] }) === 27
);
assert('[5.5] 含空 array → 0', countGridCombinations({ a: [1, 2], b: [] as number[] }) === 0);

// ---- [6] isValidTemplateShape ----------------------------------------------
assert('[6.1] null → false', !isValidTemplateShape(null));
assert('[6.2] 缺 paramGrid → false', !isValidTemplateShape({ name: 'x', source: 'user', savedAt: '' }));
assert(
  '[6.3] source 非法 → false',
  !isValidTemplateShape({ name: 'x', paramGrid: { a: [1] }, source: 'system', savedAt: '' })
);
assert(
  '[6.4] paramGrid 全空 → false',
  !isValidTemplateShape({
    name: 'x',
    paramGrid: { a: [] as number[] },
    source: 'user',
    savedAt: '',
  })
);
assert(
  '[6.5] forStrategies 非数组 → false',
  !isValidTemplateShape({
    name: 'x',
    paramGrid: { a: [1] },
    forStrategies: 'wrong',
    source: 'user',
    savedAt: '',
  })
);
assert(
  '[6.6] 合法 → true',
  isValidTemplateShape({
    name: '我的网格',
    paramGrid: { topN: [10, 20] },
    forStrategies: ['cta100'],
    description: 'desc',
    source: 'user',
    savedAt: '2026-06-19T10:00:00.000Z',
  })
);
assert(
  '[6.7] param keys 超限 → false',
  !isValidTemplateShape({
    name: 'x',
    paramGrid: Object.fromEntries(
      Array.from({ length: GRID_TEMPLATE_PARAM_KEYS_MAX + 1 }, (_, i) => [`k${i}`, [1]])
    ),
    source: 'user',
    savedAt: '',
  })
);

// ---- [7] listUserGridTemplates ----------------------------------------------
{
  const s = mkStorage();
  assert('[7.1] 空 storage → []', listUserGridTemplates(s).length === 0);
}
{
  const s = mkStorage('not-json');
  assert('[7.2] 损坏 JSON → []', listUserGridTemplates(s).length === 0);
}
{
  const s = mkStorage(JSON.stringify({ schemaVersion: 999, templates: [] }));
  assert('[7.3] 错 schemaVersion → []', listUserGridTemplates(s).length === 0);
}
{
  // 部分非法被过滤
  const payload = {
    schemaVersion: GRID_TEMPLATE_SCHEMA_VERSION,
    templates: [
      {
        name: '合法',
        paramGrid: { topN: [10] },
        source: 'user',
        savedAt: '2026-06-19T10:00:00.000Z',
      },
      { name: '', paramGrid: { topN: [10] }, source: 'user', savedAt: '' }, // name 空
      { name: 'X', paramGrid: {}, source: 'user', savedAt: '' }, // paramGrid 空
    ],
  };
  const s = mkStorage(JSON.stringify(payload));
  const list = listUserGridTemplates(s);
  assert('[7.4] 部分非法过滤后 = 1', list.length === 1);
  assert('[7.5] 合法那条留下', list[0].name === '合法');
  assert('[7.6] source 强制 user', list[0].source === 'user');
}

// ---- [8] listAllGridTemplates -----------------------------------------------
{
  const s = mkStorage();
  const all = listAllGridTemplates(undefined, s);
  assert('[8.1] 无 strategy_key → builtin 全在', all.length === BUILTIN_GRID_TEMPLATES.length);
  assert(
    '[8.2] 全部都是 builtin (无 user)',
    all.every(t => t.source === 'builtin')
  );
}
{
  const s = mkStorage();
  // 添 2 个 user 模板
  saveGridTemplate({ name: '用户A', paramGrid: { topN: [10] } }, s, () => new Date('2026-06-01T00:00:00.000Z'));
  saveGridTemplate({ name: '用户B', paramGrid: { topN: [20] } }, s, () => new Date('2026-06-02T00:00:00.000Z'));
  const all = listAllGridTemplates(undefined, s);
  assert('[8.3] builtin 在前', all.slice(0, BUILTIN_GRID_TEMPLATES.length).every(t => t.source === 'builtin'));
  assert(
    '[8.4] user 按 savedAt 倒序',
    all[all.length - 2].name === '用户B' && all[all.length - 1].name === '用户A'
  );
}
{
  const s = mkStorage();
  const all = listAllGridTemplates('cta100_momentum', s);
  // 第一个 builtin 必须命中 cta100_momentum
  const first = all[0];
  assert(
    '[8.5] strategy_key=cta100_momentum 时, 第一个 builtin 含 cta100_momentum',
    Array.isArray(first.forStrategies) && first.forStrategies!.includes('cta100_momentum')
  );
}

// ---- [9] saveGridTemplate ---------------------------------------------------
{
  const s = mkStorage();
  const list = saveGridTemplate(
    { name: '新模板', paramGrid: { topN: [10, 20], stopLossPct: [-5, -7] } },
    s,
    fixedNow
  );
  assert('[9.1] 保存后 list 长 1', list.length === 1);
  assert('[9.2] savedAt = fixedNow', list[0].savedAt === NOW.toISOString());
  assert('[9.3] source = user', list[0].source === 'user');
  assert('[9.4] paramGrid 正确写入', list[0].paramGrid.topN.length === 2);
}
{
  const s = mkStorage();
  saveGridTemplate({ name: 'X', paramGrid: { topN: [10] } }, s, fixedNow);
  // 覆盖
  const list = saveGridTemplate(
    { name: 'X', paramGrid: { topN: [20, 30] } },
    s,
    () => new Date('2026-06-20T10:00:00.000Z')
  );
  assert('[9.5] 同名覆盖 list 长仍为 1', list.length === 1);
  assert('[9.6] 新 paramGrid 写入', list[0].paramGrid.topN.length === 2 && list[0].paramGrid.topN[0] === 20);
}
{
  const s = mkStorage();
  let threw = false;
  try {
    saveGridTemplate({ name: '   ', paramGrid: { topN: [10] } }, s, fixedNow);
  } catch {
    threw = true;
  }
  assert('[9.7] name 非法抛错', threw);
}
{
  const s = mkStorage();
  let threw = false;
  try {
    saveGridTemplate(
      { name: BUILTIN_GRID_TEMPLATES[0].name, paramGrid: { topN: [10] } },
      s,
      fixedNow
    );
  } catch {
    threw = true;
  }
  assert('[9.8] 与 builtin 撞名抛错', threw);
}
{
  const s = mkStorage();
  let threw = false;
  try {
    saveGridTemplate({ name: '空 grid', paramGrid: {} }, s, fixedNow);
  } catch {
    threw = true;
  }
  assert('[9.9] 空 paramGrid 抛错', threw);
}
{
  const s = mkStorage();
  let threw = false;
  try {
    saveGridTemplate(
      {
        name: '超 key',
        paramGrid: Object.fromEntries(
          Array.from({ length: GRID_TEMPLATE_PARAM_KEYS_MAX + 1 }, (_, i) => [`k${i}`, [1]])
        ),
      },
      s,
      fixedNow
    );
  } catch {
    threw = true;
  }
  assert('[9.10] paramGrid key 超限抛错', threw);
}
{
  const s = mkStorage();
  for (let i = 0; i < GRID_TEMPLATE_MAX_COUNT; i++) {
    saveGridTemplate({ name: `t${i}`, paramGrid: { topN: [10] } }, s, fixedNow);
  }
  let threw = false;
  try {
    saveGridTemplate({ name: '溢出', paramGrid: { topN: [10] } }, s, fixedNow);
  } catch {
    threw = true;
  }
  assert('[9.11] 超 MAX_COUNT 抛错', threw);
  // 覆盖既有不应受 cap 影响
  const overwritten = saveGridTemplate({ name: 't0', paramGrid: { topN: [99] } }, s, fixedNow);
  assert(
    '[9.12] 同名覆盖在已满状态下仍允许',
    overwritten.find(t => t.name === 't0')!.paramGrid.topN[0] === 99
  );
}

// ---- [10] deleteGridTemplate ------------------------------------------------
{
  const s = mkStorage();
  saveGridTemplate({ name: 'X', paramGrid: { topN: [10] } }, s, fixedNow);
  const after = deleteGridTemplate('X', s);
  assert('[10.1] 删除用户模板成功', after.length === 0);
}
{
  const s = mkStorage();
  saveGridTemplate({ name: 'X', paramGrid: { topN: [10] } }, s, fixedNow);
  const after = deleteGridTemplate('不存在', s);
  assert('[10.2] 删除不存在 = noop', after.length === 1);
}
{
  const s = mkStorage();
  saveGridTemplate({ name: 'X', paramGrid: { topN: [10] } }, s, fixedNow);
  // 试删 builtin
  const after = deleteGridTemplate(BUILTIN_GRID_TEMPLATES[0].name, s);
  assert('[10.3] 删 builtin = noop (用户列表不变)', after.length === 1);
}

// ---- [11] findGridTemplate --------------------------------------------------
{
  const s = mkStorage();
  saveGridTemplate({ name: 'XUser', paramGrid: { topN: [10] } }, s, fixedNow);
  assert(
    '[11.1] 命中 builtin',
    findGridTemplate(BUILTIN_GRID_TEMPLATES[0].name, s)?.source === 'builtin'
  );
  assert('[11.2] 命中 user', findGridTemplate('XUser', s)?.source === 'user');
  assert('[11.3] 未命中 null', findGridTemplate('NoSuch', s) === null);
}

// ---- [12] paramGridToJsonString --------------------------------------------
{
  const s = paramGridToJsonString({ topN: [10, 20], stopLossPct: [-5, -7] });
  assert('[12.1] 输出含 topN', s.includes('"topN"'));
  assert('[12.2] 输出是合法 JSON', (() => {
    try {
      JSON.parse(s);
      return true;
    } catch {
      return false;
    }
  })());
  // 2-space indent
  assert('[12.3] 2-space indent', /\n {2}"/.test(s));
}

// ---- [13] META-GUARD fs+regex 守接入点 -------------------------------------
{
  const ROOT = join(__dirname, '../../..');
  const wfTab = readFileSync(
    join(ROOT, 'frontend/src/pages/workspace/LabWorkspace.WalkForwardTab.tsx'),
    'utf8'
  );
  assert(
    '[13.1] WalkForwardTab.tsx import helper',
    wfTab.includes("from './walkForwardGridTemplateHelpers'") ||
      wfTab.includes('walkForwardGridTemplateHelpers')
  );
  assert(
    '[13.2] WalkForwardTab.tsx 调 listAllGridTemplates',
    wfTab.includes('listAllGridTemplates(')
  );
  assert(
    '[13.3] WalkForwardTab.tsx 选模板调 setFieldsValue({ param_grid_json: ...) 注入到表单',
    wfTab.includes('setFieldsValue') && wfTab.includes('param_grid_json')
  );
  assert(
    '[13.4] WalkForwardTab.tsx data-testid 暴露给 e2e',
    wfTab.includes('grid-template-picker') || wfTab.includes('grid-template-select')
  );
  assert(
    '[13.5] WalkForwardTab.tsx 用 paramGridToJsonString 序列化',
    wfTab.includes('paramGridToJsonString')
  );
}
{
  const cleanup = readFileSync(
    join(__dirname, '../../../frontend/src/utils/sessionCleanup.ts'),
    'utf8'
  );
  assert(
    '[13.6] sessionCleanup 含 lab_grid_templates_v1 key',
    cleanup.includes('lab_grid_templates_v1')
  );
}
{
  // helper 自身 export 健全
  const helper = readFileSync(
    join(__dirname, '../../../frontend/src/pages/workspace/walkForwardGridTemplateHelpers.ts'),
    'utf8'
  );
  for (const sym of [
    'GRID_TEMPLATES_STORAGE_KEY',
    'GRID_TEMPLATE_SCHEMA_VERSION',
    'BUILTIN_GRID_TEMPLATES',
    'normalizeTemplateName',
    'sanitizeParamGrid',
    'countGridCombinations',
    'isValidTemplateShape',
    'listUserGridTemplates',
    'listAllGridTemplates',
    'saveGridTemplate',
    'deleteGridTemplate',
    'findGridTemplate',
    'paramGridToJsonString',
  ]) {
    assert(`[13.7] helper export ${sym}`, helper.includes(`export `) && helper.includes(sym));
  }
}

// ---- summary ----------------------------------------------------------------
console.log(`\n${passed} ok / ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
