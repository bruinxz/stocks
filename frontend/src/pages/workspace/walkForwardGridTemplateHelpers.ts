/**
 * US-053 LabWorkspace 快速 grid 模板 (FE-014) — 纯函数 helper.
 *
 * 操盘手在 walk-forward / GridSearch 新建表单里反复手敲相同的 param_grid JSON
 * (topN/stopLossPct/breakout_window/...) 容易抄错、漂阶、忘加方向. 本 helper 把
 * 一套完整的"param_grid"参数空间打包成 GridTemplate, 存到 localStorage, 提供
 * builtin presets + save/load/list/delete/find 6 个纯操作.
 *
 * 设计:
 *   - **builtin + user 双源**: BUILTIN_GRID_TEMPLATES (代码内 frozen) 提供 4 个
 *     开箱即用的预设 (动量/反转/突破/多因子), user 还可以把自己常调的存到
 *     localStorage. listAllGridTemplates() 合并返回, builtin 永远在前.
 *   - **localStorage-only (user templates)**: 与 [[factorComboTemplateHelpers]] 同
 *     模式 (FE-008). 后续 US-XYZ 做"云模板分享"时再加 GET 接口.
 *   - **user-scoped storage key**: 'lab_grid_templates_v1' 已登记到 [[sessionCleanup]]
 *     USER_SCOPED_LOCAL_STORAGE_KEYS, 切换用户 / logout 自动清.
 *   - **schema 版本化 (v1)**: payload 顶层带 schemaVersion, load 端读到非 v1 直接
 *     当空, 避免误覆盖.
 *   - **paramGrid 形态校验**: 必须 { [key: string]: number[] }, 每个 number[] ≥ 1
 *     非空有限数. 后端 walk-forward optimizer 只接受这个形态 — 在 helper 层
 *     校好, UI 提交前不会爆 backend 5xx.
 *   - **strategy_key 关联 (可选)**: builtin 模板用 forStrategies?: string[]
 *     声明适配的策略 key, UI 可按当前选中 strategy 高亮 / 排序 (用 sortByRelevance);
 *     未声明 = 通用模板对所有策略可见.
 *
 * 单测: backend/tests/services/walk-forward-grid-template.test.ts
 *   cd backend && npx ts-node --transpile-only tests/services/walk-forward-grid-template.test.ts
 *
 * 引用范式: [[factorComboTemplateHelpers]] (FE-008) — 同款 localStorage helper
 * + 注入式 storage + ts-node 跨 monorepo 单测.
 */

/** localStorage key — 已登记到 sessionCleanup USER_SCOPED_LOCAL_STORAGE_KEYS */
export const GRID_TEMPLATES_STORAGE_KEY = 'lab_grid_templates_v1';

/** payload schema 版本号. 未来加字段时 +1, load 端依此做迁移. */
export const GRID_TEMPLATE_SCHEMA_VERSION = 1;

/** 模板名最大长度. 防止用户拷贝长字符串撑爆 storage. */
export const GRID_TEMPLATE_NAME_MAX_LEN = 60;

/** 单用户最多保留模板数 (不含 builtin). 超过会拒绝保存, UI 提示让用户主动整理. */
export const GRID_TEMPLATE_MAX_COUNT = 20;

/** 单个 param 的取值数量上限. 防止用户填 [1,2,3,...,1000] 撑爆 GridSearch 组合数. */
export const GRID_TEMPLATE_PARAM_VALUES_MAX = 12;

/** 模板内 param 数量上限. GridSearch 总组合 = ∏ |values|, 太多维度会爆 max_combos. */
export const GRID_TEMPLATE_PARAM_KEYS_MAX = 8;

/** paramGrid 形态: { paramKey: [v1, v2, v3, ...] }. 每个 value 为有限 number. */
export type ParamGrid = Record<string, number[]>;

/** 一套完整的 grid 参数空间. */
export interface GridTemplate {
  /** 用户/builtin 可见标识. trim 后非空, ≤ NAME_MAX_LEN. */
  name: string;
  /** 一行简介, UI tooltip 用. 可空. */
  description?: string;
  /** 适配的策略 key 数组. 空/未填 = 通用. UI 按当前 strategy_key 排序展示. */
  forStrategies?: string[];
  /** param_grid: { topN: [10, 20, 30], stopLossPct: [-5, -7] } */
  paramGrid: ParamGrid;
  /** 'builtin' = 代码内置不可删, 'user' = 用户保存可删/改. */
  source: 'builtin' | 'user';
  /** ISO 时间戳. builtin 模板设为空串, user 模板由 save helper 自动填. */
  savedAt: string;
}

/** storage 顶层 schema. */
interface GridTemplateStoragePayload {
  schemaVersion: number;
  templates: GridTemplate[];
}

/** Storage 抽象 — 默认走 window.localStorage; 单测注入 in-memory mock. */
export interface GridTemplateStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

/** 默认 storage. SSR / 测试无 window 兜底走 in-memory map. */
export function defaultStorage(): GridTemplateStorage {
  if (typeof window !== 'undefined' && window.localStorage) {
    return {
      getItem: k => window.localStorage.getItem(k),
      setItem: (k, v) => window.localStorage.setItem(k, v),
      removeItem: k => window.localStorage.removeItem(k),
    };
  }
  const map = new Map<string, string>();
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

// ============================================================================
// Built-in presets — 代码内 frozen, list 时永远在前
// ============================================================================

/**
 * 4 个 builtin 预设, 覆盖团队常用策略族:
 *   1. 动量/趋势 — topN × stopLossPct 二维网格 (适合 cta100_momentum, rs_momentum, ma_trend, donchian_trend)
 *   2. 反转/均值回归 — period × oversold/overbought (适合 rsi_mean_reversion, bollinger_reversion)
 *   3. 突破 — breakout_window × volume_ratio × atr_period (适合 breakout_atr, breakout_strategy, turtle_breakout)
 *   4. 多因子打分 — topN × maxPerIndustry × industryNeutral_off/on (适合 multi_factor_alpha, multi_factor_ranking, high_dividend_value, garp)
 *
 * 选值规则:
 *   - 每维度 3 取值左右 (3×3=9 组合, 3×3×3=27 组合), 与 max_combos=256 默认匹配
 *   - stopLossPct/yields 用整数百分比, 避免浮点漂移
 *   - 边界值含 strategy 默认值附近 (e.g. RSI oversold 30/35/40 围绕默认 35)
 */
export const BUILTIN_GRID_TEMPLATES: ReadonlyArray<GridTemplate> = Object.freeze([
  Object.freeze({
    name: '动量趋势 · topN × stopLoss',
    description: '动量类策略 (cta100/rs_momentum/ma_trend) — 二维网格, 9 组合.',
    forStrategies: [
      'cta100_momentum',
      'rs_momentum',
      'ma_trend',
      'donchian_trend',
      'macd_trend',
      'dragon_head_momentum',
      'dual_momentum_rotation',
      'relative_strength_momentum',
    ],
    paramGrid: Object.freeze({
      topN: Object.freeze([10, 20, 30]) as unknown as number[],
      stopLossPct: Object.freeze([-5, -7, -10]) as unknown as number[],
    }) as unknown as ParamGrid,
    source: 'builtin',
    savedAt: '',
  }) as GridTemplate,
  Object.freeze({
    name: '反转均值 · period × 阈值',
    description: '均值回归 (rsi/bollinger) — period × oversold/overbought, 9 组合.',
    forStrategies: ['rsi_mean_reversion', 'bollinger_reversion', 'left_side_reversal'],
    paramGrid: Object.freeze({
      period: Object.freeze([10, 14, 20]) as unknown as number[],
      oversold: Object.freeze([25, 30, 35]) as unknown as number[],
      overbought: Object.freeze([65, 70, 75]) as unknown as number[],
    }) as unknown as ParamGrid,
    source: 'builtin',
    savedAt: '',
  }) as GridTemplate,
  Object.freeze({
    name: '突破 · 窗口 × 量比 × ATR',
    description: '突破类 (breakout/turtle) — 3 维 27 组合, 注意 max_combos.',
    forStrategies: ['breakout_atr', 'breakout_strategy', 'turtle_breakout'],
    paramGrid: Object.freeze({
      breakout_window: Object.freeze([15, 20, 25]) as unknown as number[],
      volume_ratio: Object.freeze([1.2, 1.5, 1.8]) as unknown as number[],
      atr_period: Object.freeze([10, 14, 20]) as unknown as number[],
    }) as unknown as ParamGrid,
    source: 'builtin',
    savedAt: '',
  }) as GridTemplate,
  Object.freeze({
    name: '多因子 · topN × 行业上限',
    description: '多因子打分 (multi_factor/garp/high_dividend) — topN × maxPerIndustry, 9 组合.',
    forStrategies: [
      'multi_factor_alpha',
      'multi_factor_ranking',
      'high_dividend_value',
      'garp',
      'quality_momentum_blend',
      'low_volatility_quality',
    ],
    paramGrid: Object.freeze({
      topN: Object.freeze([15, 25, 40]) as unknown as number[],
      maxPerIndustry: Object.freeze([2, 3, 4]) as unknown as number[],
    }) as unknown as ParamGrid,
    source: 'builtin',
    savedAt: '',
  }) as GridTemplate,
]);

// ============================================================================
// pure schema helpers
// ============================================================================

/** trim + 长度截断后判断 name 是否合法. */
export function normalizeTemplateName(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = String(raw).trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > GRID_TEMPLATE_NAME_MAX_LEN) return null;
  return trimmed;
}

/**
 * paramGrid 清洗: 丢非 number / 非有限数 / 空数组的 key. 保留有限 number 的位置顺序.
 * 截到 PARAM_VALUES_MAX, 多余 silently drop (与 sanitizeWeights 同思想).
 */
export function sanitizeParamGrid(input: unknown): ParamGrid {
  const out: ParamGrid = {};
  if (!input || typeof input !== 'object') return out;
  for (const [k, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!Array.isArray(raw)) continue;
    const cleaned: number[] = [];
    for (const v of raw) {
      if (typeof v === 'number' && Number.isFinite(v)) {
        cleaned.push(v);
        if (cleaned.length >= GRID_TEMPLATE_PARAM_VALUES_MAX) break;
      }
    }
    if (cleaned.length === 0) continue;
    out[k] = cleaned;
  }
  return out;
}

/** GridSearch 总组合数 = ∏ |values|. 用于 UI 提示 "本模板会跑 N 个组合". */
export function countGridCombinations(grid: ParamGrid): number {
  const keys = Object.keys(grid);
  if (keys.length === 0) return 0;
  let total = 1;
  for (const k of keys) {
    const len = Array.isArray(grid[k]) ? grid[k].length : 0;
    if (len === 0) return 0;
    total *= len;
  }
  return total;
}

/** 判断对象是否符合 GridTemplate 形状 (load 端做防御). */
export function isValidTemplateShape(obj: unknown): obj is GridTemplate {
  if (!obj || typeof obj !== 'object') return false;
  const t = obj as Record<string, unknown>;
  if (typeof t.name !== 'string' || normalizeTemplateName(t.name) === null) return false;
  if (!t.paramGrid || typeof t.paramGrid !== 'object') return false;
  if (t.source !== 'builtin' && t.source !== 'user') return false;
  if (typeof t.savedAt !== 'string') return false;
  // paramGrid 至少 1 个 param + 每个 param values ≥ 1
  const grid = sanitizeParamGrid(t.paramGrid);
  if (Object.keys(grid).length === 0) return false;
  if (Object.keys(grid).length > GRID_TEMPLATE_PARAM_KEYS_MAX) return false;
  // forStrategies 可省, 若有必须 string[]
  if (t.forStrategies !== undefined) {
    if (!Array.isArray(t.forStrategies)) return false;
    if (!t.forStrategies.every(s => typeof s === 'string')) return false;
  }
  if (t.description !== undefined && typeof t.description !== 'string') return false;
  return true;
}

// ============================================================================
// storage read/write
// ============================================================================

/** 读取所有 user 模板. 解析失败 / schema 不匹配 / storage 为空 都返 []. */
export function listUserGridTemplates(
  storage: GridTemplateStorage = defaultStorage()
): GridTemplate[] {
  let raw: string | null;
  try {
    raw = storage.getItem(GRID_TEMPLATES_STORAGE_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const payload = parsed as Partial<GridTemplateStoragePayload>;
  if (payload.schemaVersion !== GRID_TEMPLATE_SCHEMA_VERSION) return [];
  if (!Array.isArray(payload.templates)) return [];
  // 校验 + 强制 source='user' (防止 storage 被改成 'builtin' 混淆 UI 删除路径)
  return payload.templates
    .filter(isValidTemplateShape)
    .map(t => ({ ...t, source: 'user' as const }));
}

/**
 * 列出全部模板 (builtin + user). builtin 永远在前;
 * 当传入 currentStrategyKey 时, builtin 中 forStrategies 命中的会排在更前面,
 * 再之后是其它 builtin, 最后是 user 模板 (user 模板按 savedAt 倒序).
 *
 * Codebase pattern: "builtin + user 双源" 列表合并 → builtin 永远在前, 命中场景上浮.
 */
export function listAllGridTemplates(
  currentStrategyKey?: string | null,
  storage: GridTemplateStorage = defaultStorage()
): GridTemplate[] {
  const builtins = [...BUILTIN_GRID_TEMPLATES];
  const matchKey = currentStrategyKey ? String(currentStrategyKey).trim() : '';
  if (matchKey) {
    builtins.sort((a, b) => {
      const aHit = (a.forStrategies || []).includes(matchKey) ? 0 : 1;
      const bHit = (b.forStrategies || []).includes(matchKey) ? 0 : 1;
      return aHit - bHit;
    });
  }
  const users = listUserGridTemplates(storage).sort((a, b) =>
    String(b.savedAt).localeCompare(String(a.savedAt))
  );
  return [...builtins, ...users];
}

function writeAll(storage: GridTemplateStorage, templates: GridTemplate[]): void {
  const payload: GridTemplateStoragePayload = {
    schemaVersion: GRID_TEMPLATE_SCHEMA_VERSION,
    templates,
  };
  storage.setItem(GRID_TEMPLATES_STORAGE_KEY, JSON.stringify(payload));
}

/**
 * save 操作 — overwrite 同名 user 模板; 新模板追加. 返回写回后的 user 列表.
 *
 * 校验失败抛 Error (caller 用 try/catch + message.error):
 *   - name 不合法 (空白 / 超长)
 *   - name 与 builtin 撞名 (避免被 builtin 遮蔽不知所措)
 *   - paramGrid 清洗后空
 *   - paramGrid key 数 > PARAM_KEYS_MAX
 *   - 已达 GRID_TEMPLATE_MAX_COUNT 且不是覆盖同名
 *
 * source 强制 'user', savedAt 由本 helper 当场写, 不让 caller 传.
 */
export function saveGridTemplate(
  input: {
    name: string;
    description?: string;
    forStrategies?: string[];
    paramGrid: ParamGrid;
  },
  storage: GridTemplateStorage = defaultStorage(),
  now: () => Date = () => new Date()
): GridTemplate[] {
  const name = normalizeTemplateName(input.name);
  if (name === null) {
    throw new Error(`模板名不合法 (需要 1-${GRID_TEMPLATE_NAME_MAX_LEN} 字符的非空白串)`);
  }
  const builtinNames = BUILTIN_GRID_TEMPLATES.map(t => t.name);
  if (builtinNames.includes(name)) {
    throw new Error(`模板名 "${name}" 与内置预设撞名, 请改一个`);
  }
  const grid = sanitizeParamGrid(input.paramGrid);
  if (Object.keys(grid).length === 0) {
    throw new Error('paramGrid 至少要有 1 个 param + 每个 param ≥ 1 个有限取值');
  }
  if (Object.keys(grid).length > GRID_TEMPLATE_PARAM_KEYS_MAX) {
    throw new Error(`paramGrid param 数超过上限 (${GRID_TEMPLATE_PARAM_KEYS_MAX})`);
  }
  const existing = listUserGridTemplates(storage);
  const idx = existing.findIndex(t => t.name === name);
  const isOverwrite = idx >= 0;
  if (!isOverwrite && existing.length >= GRID_TEMPLATE_MAX_COUNT) {
    throw new Error(`已达模板上限 (${GRID_TEMPLATE_MAX_COUNT} 个), 请先删除不用的模板再保存新模板`);
  }
  const tpl: GridTemplate = {
    name,
    description: input.description ? String(input.description).slice(0, 200) : undefined,
    forStrategies:
      Array.isArray(input.forStrategies) && input.forStrategies.length > 0
        ? input.forStrategies.filter(s => typeof s === 'string' && s.trim().length > 0)
        : undefined,
    paramGrid: grid,
    source: 'user',
    savedAt: now().toISOString(),
  };
  const next = [...existing];
  if (isOverwrite) {
    next[idx] = tpl;
  } else {
    next.push(tpl);
  }
  writeAll(storage, next);
  return next;
}

/** 删除指定名字的 user 模板. builtin 永远不可删 — 静默忽略. */
export function deleteGridTemplate(
  name: string,
  storage: GridTemplateStorage = defaultStorage()
): GridTemplate[] {
  const trimmed = normalizeTemplateName(name);
  if (trimmed === null) return listUserGridTemplates(storage);
  // builtin 不可删
  if (BUILTIN_GRID_TEMPLATES.some(t => t.name === trimmed)) {
    return listUserGridTemplates(storage);
  }
  const existing = listUserGridTemplates(storage);
  const next = existing.filter(t => t.name !== trimmed);
  if (next.length === existing.length) return existing;
  writeAll(storage, next);
  return next;
}

/** 按名字查模板 (builtin + user). 找不到返 null. */
export function findGridTemplate(
  name: string,
  storage: GridTemplateStorage = defaultStorage()
): GridTemplate | null {
  const trimmed = normalizeTemplateName(name);
  if (trimmed === null) return null;
  const builtin = BUILTIN_GRID_TEMPLATES.find(t => t.name === trimmed);
  if (builtin) return builtin;
  const user = listUserGridTemplates(storage).find(t => t.name === trimmed);
  return user ?? null;
}

/** 把 paramGrid 序列化成 walk-forward 表单需要的 JSON 字符串 (2-space indent). */
export function paramGridToJsonString(grid: ParamGrid): string {
  return JSON.stringify(grid, null, 2);
}
