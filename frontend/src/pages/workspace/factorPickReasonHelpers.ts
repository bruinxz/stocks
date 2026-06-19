/**
 * US-049 [FE-010] FactorWorkspace picks inline 理由 — 纯函数 helper.
 *
 * 目的: 在 PicksTab 的表格里, 给每行 stock 显示一段"为什么入选"的 inline 短理由,
 * 让操盘手不展开 expandable row 也能扫到; expand 仍然显示完整 reason + 全因子 z chips.
 *
 * 设计选择:
 *   - 不直接复用 backend 写好的 signal.reason (e.g. "新进入选: composite=0.785") —
 *     它对人类没解释力 ("composite=0.785" 看不出来"为什么是 0.785"). 我们抽出每只
 *     股票在 8 个因子上贡献最大的 top-2 (按 |z_score| 排序), 拼成
 *     "动量 +1.8 / 价值 +1.2" 让用户看到主要 alpha 来源.
 *   - 同时保留 signal.reason 作为"动作语义" (新进/保留/剔除), inline 拼出
 *     "新进 · 动量 +1.8 / 价值 +1.2" 是完整的"动作 + 原因"二元结构.
 *   - 硬截断 PICK_REASON_MAX_CHARS=60 字符 + '…' 后缀, 防止 row height 撑爆 ——
 *     与 [[AI_VIEW_MAX_CHARS 落代码模板]] 同款 cap 思想 (US-043), 但 60 是 table
 *     cell 适配的更紧凑值 (vs market brief 长视角 150 字).
 *   - 主入口 buildShortPickReason() 接 null/undefined/任意垃圾输入返 fallback "无理由数据",
 *     永远不抛, 让 column render 函数零 try/catch. 与 [[前端 pure helper 模板]] 兜底契约一致.
 *
 * 纯函数, 不依赖 React / antd / fetch, 单测在
 * backend/tests/services/factor-pick-reason.test.ts (跨 monorepo import frontend
 * 的 .ts, 用 ts-node --transpile-only 跑).
 */

import type { FactorPreviewSignal } from '../../services/factorService';

/** inline 理由的硬上限字符数. 60 是 table cell 适合 1-2 行展示的紧凑值 */
export const PICK_REASON_MAX_CHARS = 60;

/** 主理由抽不到时的兜底文案 */
export const PICK_REASON_FALLBACK = '无理由数据';

/** factor 内部名 → 中文短标签 (与 FactorWorkspace 主表 CATEGORY_DISPLAY 同源命名) */
export const FACTOR_NAME_LABELS: Record<string, string> = {
  value: '价值',
  quality: '质量',
  growth: '成长',
  momentum: '动量',
  low_vol: '低波',
  northbound: '北向',
  money_flow: '主力',
  dragon_tiger: '龙虎',
};

/** signal=buy/sell/hold → 中文动作前缀 (单字, 给 inline 拼接节省字符) */
export const ACTION_PREFIX: Record<'buy' | 'sell' | 'hold', string> = {
  buy: '新进',
  sell: '剔除',
  hold: '保留',
};

/**
 * 把 (factor_name, z_score) map 按 |z| 排序, 返回 top-k. 排除 NaN / 非数 / 0.
 * tie-break 按 factor name 字母序保稳定排序 (React key / 单测 deterministic).
 *
 * pure, 不读全局.
 */
export function pickTopFactorContributors(
  factorZScores: Record<string, number> | null | undefined,
  k: number
): Array<{ name: string; z: number }> {
  if (!factorZScores || typeof factorZScores !== 'object') return [];
  if (!Number.isFinite(k) || k <= 0) return [];

  const entries: Array<{ name: string; z: number; abs: number }> = [];
  for (const [name, raw] of Object.entries(factorZScores)) {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
    const abs = Math.abs(raw);
    if (abs === 0) continue;
    entries.push({ name, z: raw, abs });
  }
  // |z| 降序; |z| 相等时按 name 字母升序 (deterministic)
  entries.sort((a, b) => {
    if (b.abs !== a.abs) return b.abs - a.abs;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return entries.slice(0, k).map(e => ({ name: e.name, z: e.z }));
}

/**
 * 把单个因子贡献渲染成短词: "动量 +1.84" / "价值 -0.95". 保 2 位小数,
 * 显式带正负号.
 */
export function formatFactorContrib(name: string, z: number): string {
  const label = FACTOR_NAME_LABELS[name] || name;
  const sign = z >= 0 ? '+' : '';
  return `${label} ${sign}${z.toFixed(2)}`;
}

/**
 * 主入口: 把 FactorPreviewSignal → inline 理由短文本.
 *
 * 输出形如:
 *   - "新进 · 动量 +1.84 / 价值 +1.20"  (signal=buy 有 top contributors)
 *   - "保留 · composite +0.785"          (没 factor z 数据时降级 composite)
 *   - "剔除 · 动量 -1.50"                (sell 也用 top contributors, z 可负)
 *   - "无理由数据"                         (signal null + 无 composite + 无 z)
 *
 * 不抛, 任意输入兜底返 PICK_REASON_FALLBACK. 输出已 truncate 到 PICK_REASON_MAX_CHARS.
 */
export function buildShortPickReason(signal: FactorPreviewSignal | null | undefined): string {
  if (!signal || typeof signal !== 'object') return PICK_REASON_FALLBACK;

  const actionRaw = signal.signal;
  const actionPrefix =
    actionRaw === 'buy' || actionRaw === 'sell' || actionRaw === 'hold'
      ? ACTION_PREFIX[actionRaw]
      : null;

  // 1) 优先 top-2 因子贡献
  const tops = pickTopFactorContributors(signal.factor_z_scores, 2);
  let body: string;
  if (tops.length > 0) {
    body = tops.map(t => formatFactorContrib(t.name, t.z)).join(' / ');
  } else if (
    typeof signal.composite_score === 'number' &&
    Number.isFinite(signal.composite_score)
  ) {
    // 2) factor z 全空 → 降级到 composite 数字
    const c = signal.composite_score;
    const sign = c >= 0 ? '+' : '';
    body = `composite ${sign}${c.toFixed(3)}`;
  } else {
    // 3) 啥都没有
    body = PICK_REASON_FALLBACK;
  }

  const text = actionPrefix && body !== PICK_REASON_FALLBACK ? `${actionPrefix} · ${body}` : body;
  return truncatePickReason(text);
}

/**
 * 硬截断: 超过 PICK_REASON_MAX_CHARS 切到 cap-1 + '…'. ≤ cap 原样返.
 * 用 Array.from 计 codepoint, 避免中文 surrogate pair 算成 2 字符.
 */
export function truncatePickReason(text: string | null | undefined): string {
  if (typeof text !== 'string' || text.length === 0) return PICK_REASON_FALLBACK;
  const chars = Array.from(text);
  if (chars.length <= PICK_REASON_MAX_CHARS) return text;
  return chars.slice(0, PICK_REASON_MAX_CHARS - 1).join('') + '…';
}
