/**
 * US-047 FactorWorkspace 组合模板 save/load (FE-008) — 纯函数 helper.
 *
 * 操盘手在权重调参 tab 反复调出 "高分红 / 短期反转 / 成长动量" 等多套自定义因子
 * 组合, 不希望每次都从默认 8 因子重新拖 slider. 本 helper 把一套完整的"权重 +
 * 选股参数"打包成 ComboTemplate 存到 localStorage, 提供 save / load / list /
 * delete / rename 5 个纯操作.
 *
 * 设计:
 *   - **localStorage-only**: 模板属用户私有视图状态 (与 PortfolioContext 的
 *     selectedPortfolioId / StockExplorer 的 PINNED_KEY 同类), 不需要跨设备同步;
 *     现阶段后端没有 user_preferences 表, 加一张表为这个功能不值. 后续 US-XYZ
 *     再做"云模板分享"时再加 GET /api/factors/combo-templates 等 endpoint, 升级
 *     路径清晰.
 *   - **user-scoped storage key**: 'fw_combo_templates_v1' 已登记到
 *     [[sessionCleanup]] USER_SCOPED_LOCAL_STORAGE_KEYS, 切换用户 / logout 会被
 *     自动清掉, 避免上一个用户的模板泄漏给下一个登录用户.
 *   - **schema 版本化**: payload 顶层带 schemaVersion (当前 = 1), 未来字段扩
 *     展时 load 端可做向后兼容 / 旧版本丢弃.
 *   - **不存默认值**: DEFAULT_WEIGHTS 与默认 topN/industryNeutral 不会通过模板
 *     反复保存. caller 自己决定要不要把当前 state 包装成模板 — 这个 helper 只
 *     做"已经有一个完整的 ComboTemplate, 怎么存/取/列/删".
 *   - **纯函数 + 显式 storage 抽象**: 所有读写都通过 ComboTemplateStorage 接口
 *     (默认 = window.localStorage), 这样单测可以注入 in-memory mock, 不依赖
 *     jsdom / node.localStorage shim. 与 [[factorAIWeightHelpers]] 同款"frontend
 *     helper + backend ts-node 跑测试" 范式.
 *
 * 单测: backend/tests/services/factor-combo-template.test.ts
 *   cd backend && npx ts-node --transpile-only tests/services/factor-combo-template.test.ts
 */

/** localStorage key — 已登记到 sessionCleanup USER_SCOPED_LOCAL_STORAGE_KEYS */
export const COMBO_TEMPLATES_STORAGE_KEY = 'fw_combo_templates_v1';

/** payload schema 版本号. 未来加字段时 +1, load 端依此做迁移. */
export const COMBO_TEMPLATE_SCHEMA_VERSION = 1;

/** 模板名最大长度 (UTF-8 字符数, 不是字节). 防止用户拷贝长字符串撑爆 storage. */
export const COMBO_TEMPLATE_NAME_MAX_LEN = 60;

/** 单用户最多保留模板数. 超过会拒绝保存 (而不是 silently FIFO 删旧), 给 UI 提示让用户主动整理. */
export const COMBO_TEMPLATE_MAX_COUNT = 20;

/** 一套完整的因子组合参数 — 与 FactorWorkspace WeightsTab state 字段一一对应. */
export interface ComboTemplate {
  /** 用户可见标识 (key+UI 唯一性). trim 后非空, ≤ COMBO_TEMPLATE_NAME_MAX_LEN. */
  name: string;
  /** 因子名 → 权重 % (0..100). 不归一化, load 时按原样灌给 setWeights. */
  weights: Record<string, number>;
  /** Top-N 持仓数 */
  topN: number;
  industryNeutral: boolean;
  maxPerIndustry: number;
  excludeST: boolean;
  excludeNew60d: boolean;
  /** ISO 时间戳 (Date.toISOString) — UI 显示 "保存于 X". 由 save helper 自动填. */
  savedAt: string;
}

/** storage 文件根 schema (顶层永远有 version, 让 load 防御未来格式变更) */
interface ComboTemplateStoragePayload {
  schemaVersion: number;
  templates: ComboTemplate[];
}

/**
 * Storage 抽象 — 默认走 window.localStorage; 单测注入 in-memory mock.
 * 与 sessionCleanup 共用同一份 key 字面量.
 */
export interface ComboTemplateStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

/** 默认 storage —— 在浏览器里就是 window.localStorage; 单测可不传, 用 in-memory mock. */
export function defaultStorage(): ComboTemplateStorage {
  if (typeof window !== 'undefined' && window.localStorage) {
    return {
      getItem: k => window.localStorage.getItem(k),
      setItem: (k, v) => window.localStorage.setItem(k, v),
      removeItem: k => window.localStorage.removeItem(k),
    };
  }
  // SSR / 测试无 window 兜底: 一个 in-memory map, 不抛错
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
// pure schema helpers
// ============================================================================

/** trim + 长度截断后判断 name 是否合法. 不抛错, 返 string | null. */
export function normalizeTemplateName(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = String(raw).trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > COMBO_TEMPLATE_NAME_MAX_LEN) return null;
  return trimmed;
}

/** weights 输入清洗: 丢非有限数 / 负数, NaN. caller 拿到的 map 已是可安全 JSON 化的形态. */
export function sanitizeWeights(input: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  if (!input || typeof input !== 'object') return out;
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * 判断一个解析后的对象是否符合 ComboTemplate 形状 — load 端读 localStorage 后
 * 用它做防御 (用户可能手动改了 storage / 旧版本 schema / 别的 app 占了同名 key).
 */
export function isValidTemplateShape(obj: unknown): obj is ComboTemplate {
  if (!obj || typeof obj !== 'object') return false;
  const t = obj as Record<string, unknown>;
  if (typeof t.name !== 'string' || normalizeTemplateName(t.name) === null) return false;
  if (!t.weights || typeof t.weights !== 'object') return false;
  if (typeof t.topN !== 'number' || !Number.isFinite(t.topN) || t.topN < 1) return false;
  if (typeof t.industryNeutral !== 'boolean') return false;
  if (typeof t.maxPerIndustry !== 'number' || !Number.isFinite(t.maxPerIndustry)) return false;
  if (typeof t.excludeST !== 'boolean') return false;
  if (typeof t.excludeNew60d !== 'boolean') return false;
  if (typeof t.savedAt !== 'string') return false;
  // weights 值合法性 — 必须全是有限数
  for (const v of Object.values(t.weights)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return false;
  }
  return true;
}

// ============================================================================
// storage read/write
// ============================================================================

/**
 * 读取所有已保存模板. 解析失败 / schema 不匹配 / storage 为空 都返 [].
 * 不抛错: UI 不需要为"localStorage 损坏"展示错误页.
 */
export function listComboTemplates(
  storage: ComboTemplateStorage = defaultStorage()
): ComboTemplate[] {
  let raw: string | null;
  try {
    raw = storage.getItem(COMBO_TEMPLATES_STORAGE_KEY);
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
  const payload = parsed as Partial<ComboTemplateStoragePayload>;
  // 当前只识别 v1; 旧/新版本一律忽略 (caller 拿到 [] 就当没保存过, 不会误覆盖)
  if (payload.schemaVersion !== COMBO_TEMPLATE_SCHEMA_VERSION) return [];
  if (!Array.isArray(payload.templates)) return [];
  return payload.templates.filter(isValidTemplateShape);
}

/** 把模板数组整体写回 storage. throws if storage.setItem throws (e.g. quota). */
function writeAll(storage: ComboTemplateStorage, templates: ComboTemplate[]): void {
  const payload: ComboTemplateStoragePayload = {
    schemaVersion: COMBO_TEMPLATE_SCHEMA_VERSION,
    templates,
  };
  storage.setItem(COMBO_TEMPLATES_STORAGE_KEY, JSON.stringify(payload));
}

/**
 * save 操作 — overwrite 同名模板; 新模板追加在末尾. 返回写回后的完整列表.
 *
 * 校验失败抛 Error (caller 用 try/catch + message.error 提示):
 *   - name 不合法 (空白 / 超长)
 *   - weights 清洗后为空 (说明用户没分配任何权重 — load 回来会让 preview disabled,
 *     存了无意义)
 *   - 已达 COMBO_TEMPLATE_MAX_COUNT 且不是覆盖同名
 *
 * savedAt 由本 helper 当场写, 不让 caller 传; 这样 list 中的时间戳一定是真实的保存时刻.
 */
export function saveComboTemplate(
  input: Omit<ComboTemplate, 'savedAt'> & { savedAt?: string },
  storage: ComboTemplateStorage = defaultStorage(),
  /** 注入 now() — 便于单测断言 savedAt; 浏览器默认走 new Date(). */
  now: () => Date = () => new Date()
): ComboTemplate[] {
  const name = normalizeTemplateName(input.name);
  if (name === null) {
    throw new Error(`模板名不合法 (需要 1-${COMBO_TEMPLATE_NAME_MAX_LEN} 字符的非空白串)`);
  }
  const weights = sanitizeWeights(input.weights);
  if (Object.keys(weights).length === 0) {
    throw new Error('模板至少要有一个因子权重 > 0');
  }
  if (typeof input.topN !== 'number' || !Number.isFinite(input.topN) || input.topN < 1) {
    throw new Error('topN 必须 ≥ 1');
  }
  if (
    typeof input.maxPerIndustry !== 'number' ||
    !Number.isFinite(input.maxPerIndustry) ||
    input.maxPerIndustry < 1
  ) {
    throw new Error('maxPerIndustry 必须 ≥ 1');
  }
  const existing = listComboTemplates(storage);
  const idx = existing.findIndex(t => t.name === name);
  const isOverwrite = idx >= 0;
  if (!isOverwrite && existing.length >= COMBO_TEMPLATE_MAX_COUNT) {
    throw new Error(
      `已达模板上限 (${COMBO_TEMPLATE_MAX_COUNT} 个), 请先删除不用的模板再保存新模板`
    );
  }
  const tpl: ComboTemplate = {
    name,
    weights,
    topN: Math.floor(input.topN),
    industryNeutral: !!input.industryNeutral,
    maxPerIndustry: Math.floor(input.maxPerIndustry),
    excludeST: !!input.excludeST,
    excludeNew60d: !!input.excludeNew60d,
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

/** 删除指定名字的模板. 返回更新后的列表. 名字不存在 = noop, 不抛错. */
export function deleteComboTemplate(
  name: string,
  storage: ComboTemplateStorage = defaultStorage()
): ComboTemplate[] {
  const trimmed = normalizeTemplateName(name);
  if (trimmed === null) return listComboTemplates(storage);
  const existing = listComboTemplates(storage);
  const next = existing.filter(t => t.name !== trimmed);
  if (next.length === existing.length) return existing;
  writeAll(storage, next);
  return next;
}

/** 按名字查模板; 找不到返 null. */
export function findComboTemplate(
  name: string,
  storage: ComboTemplateStorage = defaultStorage()
): ComboTemplate | null {
  const trimmed = normalizeTemplateName(name);
  if (trimmed === null) return null;
  const match = listComboTemplates(storage).find(t => t.name === trimmed);
  return match ?? null;
}
