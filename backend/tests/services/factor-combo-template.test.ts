/**
 * US-047 FactorWorkspace 组合模板 save/load (FE-008) 单元测试
 *
 * 不依赖 jest; 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/factor-combo-template.test.ts
 *
 * 也不依赖 DB/网络/React: 全部 import 自
 * frontend/src/pages/workspace/factorComboTemplateHelpers.ts (pure helpers, 无 antd/react,
 * ts-node 直接吃) + 注入 in-memory storage mock (不依赖 jsdom/node localStorage shim).
 *
 * 覆盖维度:
 *   [1] 常量值 sanity
 *   [2] normalizeTemplateName — 空 / 空白 / 超长 / 正常
 *   [3] sanitizeWeights — NaN / 负值 / 非 number / 正常
 *   [4] isValidTemplateShape — 缺字段 / 类型错 / 正常
 *   [5] listComboTemplates — 空 / 损坏 JSON / 错 schemaVersion / 部分非法被过滤
 *   [6] saveComboTemplate — 新增 / 覆盖同名 / name 非法 / weights 空 / 上限
 *   [7] deleteComboTemplate — 找不到 noop / 找到删除
 *   [8] findComboTemplate
 *   [9] META-GUARD fs+regex:
 *       - FactorWorkspace.tsx: import + Save/Load 按钮 + Modal data-testid
 *       - factorComboTemplateHelpers.ts: 主要 export 全在
 *       - sessionCleanup.ts: 包含 'fw_combo_templates_v1' key
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  COMBO_TEMPLATES_STORAGE_KEY,
  COMBO_TEMPLATE_SCHEMA_VERSION,
  COMBO_TEMPLATE_NAME_MAX_LEN,
  COMBO_TEMPLATE_MAX_COUNT,
  ComboTemplate,
  ComboTemplateStorage,
  normalizeTemplateName,
  sanitizeWeights,
  isValidTemplateShape,
  listComboTemplates,
  saveComboTemplate,
  deleteComboTemplate,
  findComboTemplate,
} from '../../../frontend/src/pages/workspace/factorComboTemplateHelpers';

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

/** in-memory storage mock — 注入到所有 helper 调用, 隔离每个测试块. */
function mkStorage(initial?: string): ComboTemplateStorage {
  const map = new Map<string, string>();
  if (initial !== undefined) map.set(COMBO_TEMPLATES_STORAGE_KEY, initial);
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

/** fixed now() — 让 savedAt 可断言. */
const NOW = new Date('2026-06-19T10:00:00.000Z');
const fixedNow = () => NOW;

// ---- [1] 常量值 sanity ------------------------------------------------------
assert('[1.1] STORAGE_KEY 是 fw_combo_templates_v1', COMBO_TEMPLATES_STORAGE_KEY === 'fw_combo_templates_v1');
assert('[1.2] SCHEMA_VERSION = 1', COMBO_TEMPLATE_SCHEMA_VERSION === 1);
assert('[1.3] NAME_MAX_LEN 在合理范围', COMBO_TEMPLATE_NAME_MAX_LEN > 0 && COMBO_TEMPLATE_NAME_MAX_LEN <= 200);
assert('[1.4] MAX_COUNT 在合理范围', COMBO_TEMPLATE_MAX_COUNT >= 5 && COMBO_TEMPLATE_MAX_COUNT <= 100);

// ---- [2] normalizeTemplateName ---------------------------------------------
assert('[2.1] null → null', normalizeTemplateName(null) === null);
assert('[2.2] undefined → null', normalizeTemplateName(undefined) === null);
assert('[2.3] 空串 → null', normalizeTemplateName('') === null);
assert('[2.4] 仅空白 → null', normalizeTemplateName('   \n\t  ') === null);
assert('[2.5] 正常 + trim', normalizeTemplateName('  高分红  ') === '高分红');
assert(
  '[2.6] 超长 → null',
  normalizeTemplateName('A'.repeat(COMBO_TEMPLATE_NAME_MAX_LEN + 1)) === null
);
assert(
  '[2.7] 临界长度 = MAX_LEN → 合法',
  normalizeTemplateName('A'.repeat(COMBO_TEMPLATE_NAME_MAX_LEN)) ===
    'A'.repeat(COMBO_TEMPLATE_NAME_MAX_LEN)
);

// ---- [3] sanitizeWeights ----------------------------------------------------
const s1 = sanitizeWeights({});
assert('[3.1] 空 → 空', Object.keys(s1).length === 0);

const s2 = sanitizeWeights({ value: 30, quality: 0, momentum: NaN, growth: -5, low_vol: Infinity });
assert(
  '[3.2] 保留 finite 非负 (含 0); 丢 NaN/负/Infinity',
  s2.value === 30 && s2.quality === 0 && !('momentum' in s2) && !('growth' in s2) && !('low_vol' in s2)
);

// @ts-ignore — 测试运行时防御 (传 null 检验不抛错)
const s3 = sanitizeWeights(null as unknown as Record<string, number>);
assert('[3.3] null 输入 → 空 (不抛)', Object.keys(s3).length === 0);

// ---- [4] isValidTemplateShape -----------------------------------------------
const goodTpl: ComboTemplate = {
  name: 'foo',
  weights: { value: 30, quality: 20 },
  topN: 30,
  industryNeutral: true,
  maxPerIndustry: 3,
  excludeST: true,
  excludeNew60d: false,
  savedAt: NOW.toISOString(),
};
assert('[4.1] 合法 ComboTemplate', isValidTemplateShape(goodTpl));
assert('[4.2] null → false', !isValidTemplateShape(null));
assert('[4.3] 缺 weights → false', !isValidTemplateShape({ ...goodTpl, weights: undefined }));
assert('[4.4] weights 含 NaN → false', !isValidTemplateShape({ ...goodTpl, weights: { v: NaN } }));
assert('[4.5] topN < 1 → false', !isValidTemplateShape({ ...goodTpl, topN: 0 }));
assert(
  '[4.6] excludeST 不是 boolean → false',
  !isValidTemplateShape({ ...goodTpl, excludeST: 'true' as unknown as boolean })
);
assert('[4.7] 缺 savedAt → false', !isValidTemplateShape({ ...goodTpl, savedAt: undefined }));

// ---- [5] listComboTemplates -------------------------------------------------
assert('[5.1] 空 storage → []', listComboTemplates(mkStorage()).length === 0);
assert('[5.2] 非 JSON → []', listComboTemplates(mkStorage('not json {')).length === 0);
assert('[5.3] 错 schemaVersion → []', listComboTemplates(mkStorage(JSON.stringify({ schemaVersion: 999, templates: [goodTpl] }))).length === 0);
assert('[5.4] templates 不是数组 → []', listComboTemplates(mkStorage(JSON.stringify({ schemaVersion: 1, templates: 'oops' }))).length === 0);

const list5 = listComboTemplates(
  mkStorage(
    JSON.stringify({
      schemaVersion: 1,
      templates: [goodTpl, { ...goodTpl, name: '' }, { not: 'a template' }],
    })
  )
);
assert('[5.5] 非法成员被过滤, 只剩合法的', list5.length === 1 && list5[0].name === 'foo');

// ---- [6] saveComboTemplate --------------------------------------------------

// [6.1] 新增成功
const storage6 = mkStorage();
const r61 = saveComboTemplate(
  {
    name: '高分红',
    weights: { value: 50, quality: 30 },
    topN: 25,
    industryNeutral: true,
    maxPerIndustry: 4,
    excludeST: true,
    excludeNew60d: true,
  },
  storage6,
  fixedNow
);
assert('[6.1] 新增 → list 长度 1', r61.length === 1);
assert('[6.1b] savedAt 是 fixedNow ISO', r61[0].savedAt === NOW.toISOString());
assert('[6.1c] name trim 后存', r61[0].name === '高分红');

// [6.2] 覆盖同名 — 不会让 list 增长
const r62 = saveComboTemplate(
  {
    name: '高分红',
    weights: { value: 99 },
    topN: 10,
    industryNeutral: false,
    maxPerIndustry: 1,
    excludeST: false,
    excludeNew60d: false,
  },
  storage6,
  fixedNow
);
assert(
  '[6.2] 覆盖同名 → 长度仍 1, 内容是新值',
  r62.length === 1 && r62[0].weights.value === 99 && r62[0].industryNeutral === false
);

// [6.3] name 非法抛错
let caught = '';
try {
  saveComboTemplate({ name: '   ', weights: { v: 1 }, topN: 10, industryNeutral: false, maxPerIndustry: 1, excludeST: false, excludeNew60d: false }, mkStorage(), fixedNow);
} catch (e: unknown) {
  caught = e instanceof Error ? e.message : String(e);
}
assert('[6.3] 空白 name 抛错', caught.length > 0 && /模板名/.test(caught));

// [6.4] weights 为空抛错
caught = '';
try {
  saveComboTemplate({ name: 'x', weights: {}, topN: 10, industryNeutral: false, maxPerIndustry: 1, excludeST: false, excludeNew60d: false }, mkStorage(), fixedNow);
} catch (e: unknown) {
  caught = e instanceof Error ? e.message : String(e);
}
assert('[6.4] 空 weights 抛错', /权重/.test(caught));

// [6.5] topN < 1 抛错
caught = '';
try {
  saveComboTemplate({ name: 'x', weights: { a: 1 }, topN: 0, industryNeutral: false, maxPerIndustry: 1, excludeST: false, excludeNew60d: false }, mkStorage(), fixedNow);
} catch (e: unknown) {
  caught = e instanceof Error ? e.message : String(e);
}
assert('[6.5] topN<1 抛错', /topN/.test(caught));

// [6.6] 达上限 + 不是覆盖 → 抛错
const storage66 = mkStorage();
for (let i = 0; i < COMBO_TEMPLATE_MAX_COUNT; i += 1) {
  saveComboTemplate(
    {
      name: `tpl_${i}`,
      weights: { v: 1 },
      topN: 10,
      industryNeutral: false,
      maxPerIndustry: 1,
      excludeST: false,
      excludeNew60d: false,
    },
    storage66,
    fixedNow
  );
}
caught = '';
try {
  saveComboTemplate({ name: 'overflow', weights: { v: 1 }, topN: 10, industryNeutral: false, maxPerIndustry: 1, excludeST: false, excludeNew60d: false }, storage66, fixedNow);
} catch (e: unknown) {
  caught = e instanceof Error ? e.message : String(e);
}
assert('[6.6] 上限 + 新名 → 抛错', /上限/.test(caught) && listComboTemplates(storage66).length === COMBO_TEMPLATE_MAX_COUNT);

// [6.7] 达上限 + 覆盖同名 → 允许 (不抛)
const overwriteList = saveComboTemplate(
  { name: 'tpl_0', weights: { v: 2 }, topN: 11, industryNeutral: true, maxPerIndustry: 2, excludeST: true, excludeNew60d: true },
  storage66,
  fixedNow
);
assert('[6.7] 上限 + 覆盖 → 不抛 + 长度不变', overwriteList.length === COMBO_TEMPLATE_MAX_COUNT);

// [6.8] weights 中 NaN/负值被 sanitize 掉, 剩余非负进入存储
const storage68 = mkStorage();
const r68 = saveComboTemplate(
  {
    name: 'sanitize',
    weights: { value: 30, quality: -5, growth: NaN, momentum: 0 },
    topN: 20,
    industryNeutral: true,
    maxPerIndustry: 3,
    excludeST: true,
    excludeNew60d: false,
  },
  storage68,
  fixedNow
);
assert(
  '[6.8] sanitizeWeights 生效: NaN/负值剔除, 0 保留',
  r68[0].weights.value === 30 &&
    r68[0].weights.momentum === 0 &&
    !('quality' in r68[0].weights) &&
    !('growth' in r68[0].weights)
);

// ---- [7] deleteComboTemplate ------------------------------------------------
const storage7 = mkStorage();
saveComboTemplate({ name: 'a', weights: { v: 1 }, topN: 1, industryNeutral: false, maxPerIndustry: 1, excludeST: false, excludeNew60d: false }, storage7, fixedNow);
saveComboTemplate({ name: 'b', weights: { v: 1 }, topN: 1, industryNeutral: false, maxPerIndustry: 1, excludeST: false, excludeNew60d: false }, storage7, fixedNow);
assert('[7.1] 删除找不到 → 长度不变', deleteComboTemplate('nosuch', storage7).length === 2);
const r72 = deleteComboTemplate('a', storage7);
assert('[7.2] 删除存在的 → 长度 -1', r72.length === 1 && r72[0].name === 'b');
assert('[7.3] storage 已落盘', listComboTemplates(storage7).length === 1);
// 空白 name 走 normalizeTemplateName → null → 直接返当前列表 (无副作用)
const beforeDel = listComboTemplates(storage7).length;
const r74 = deleteComboTemplate('   ', storage7);
assert('[7.4] 空白 name → noop', r74.length === beforeDel);

// ---- [8] findComboTemplate --------------------------------------------------
assert('[8.1] 找到', findComboTemplate('b', storage7)?.name === 'b');
assert('[8.2] 没找到 → null', findComboTemplate('nosuch', storage7) === null);
assert('[8.3] 空白 → null', findComboTemplate('  ', storage7) === null);
assert('[8.4] trim 后匹配', findComboTemplate('  b  ', storage7)?.name === 'b');

// ---- [9] META-GUARD fs+regex ------------------------------------------------
const repoRoot = join(__dirname, '../../../');

const helpersSrc = readFileSync(
  join(repoRoot, 'frontend/src/pages/workspace/factorComboTemplateHelpers.ts'),
  'utf8'
);
assert(
  '[9.1] helpers 导出 8 个核心符号',
  /export\s+const\s+COMBO_TEMPLATES_STORAGE_KEY/.test(helpersSrc) &&
    /export\s+function\s+normalizeTemplateName/.test(helpersSrc) &&
    /export\s+function\s+sanitizeWeights/.test(helpersSrc) &&
    /export\s+function\s+isValidTemplateShape/.test(helpersSrc) &&
    /export\s+function\s+listComboTemplates/.test(helpersSrc) &&
    /export\s+function\s+saveComboTemplate/.test(helpersSrc) &&
    /export\s+function\s+deleteComboTemplate/.test(helpersSrc) &&
    /export\s+function\s+findComboTemplate/.test(helpersSrc)
);
assert(
  '[9.2] STORAGE_KEY 字面量与 sessionCleanup 一致',
  /'fw_combo_templates_v1'/.test(helpersSrc)
);

const workspaceSrc = readFileSync(
  join(repoRoot, 'frontend/src/pages/workspace/FactorWorkspace.tsx'),
  'utf8'
);
assert(
  '[9.3] FactorWorkspace import factorComboTemplateHelpers',
  /from\s+['"]\.\/factorComboTemplateHelpers['"]/.test(workspaceSrc) &&
    /saveComboTemplate/.test(workspaceSrc) &&
    /listComboTemplates/.test(workspaceSrc) &&
    /deleteComboTemplate/.test(workspaceSrc)
);
assert(
  '[9.4] 保存/加载按钮 data-testid 在源里',
  /data-testid=['"]combo-template-save-btn['"]/.test(workspaceSrc) &&
    /data-testid=['"]combo-template-load-btn['"]/.test(workspaceSrc)
);
assert(
  '[9.5] Save Modal 含 name input + confirm button data-testid',
  /data-testid=['"]combo-template-name-input['"]/.test(workspaceSrc) &&
    /['"]?data-testid['"]?\s*[:=]\s*['"]combo-template-save-confirm-btn['"]/.test(workspaceSrc)
);
assert(
  '[9.6] Load Modal 含 List + per-row load/delete data-testid 模板字符串',
  /data-testid=['"]combo-template-list['"]/.test(workspaceSrc) &&
    /combo-template-load-btn-\$\{tpl\.name\}/.test(workspaceSrc) &&
    /combo-template-delete-btn-\$\{tpl\.name\}/.test(workspaceSrc)
);

const sessionCleanupSrc = readFileSync(
  join(repoRoot, 'frontend/src/utils/sessionCleanup.ts'),
  'utf8'
);
assert(
  '[9.7] sessionCleanup 登记了 fw_combo_templates_v1',
  /'fw_combo_templates_v1'/.test(sessionCleanupSrc)
);

// ---- 报告 --------------------------------------------------------------------
console.log(`\nFactor Combo Template test: passed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
process.exit(0);
