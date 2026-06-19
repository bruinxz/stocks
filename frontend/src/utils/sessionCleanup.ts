/**
 * sessionCleanup — Batch U (2026-06-17, front-3 fix)
 *
 * 中央化 logout / 401-refresh-fail / 切换用户时清扫 localStorage user-scoped key.
 *
 * 旧问题: App.tsx handleLogout 和 api.ts 401-refresh fail 各自只清 3-4 个 key,
 * 残留: `aiAdvisor_events / aiAdvisor_ticker / aiAdvisor_decision / aiAdvisor_analyzing /
 *      pt_selected_portfolio_id / user / PINNED_KEY` 等.
 * 共用浏览器场景下次登录用户能读到上一个 user 的 AI 研究历史 / 选盘 id / 收藏列表.
 *
 * 这个 helper 维护一份 USER_SCOPED_LOCAL_STORAGE_KEYS 白名单, 任何新加的 user-scoped
 * localStorage key 都应该在这里登记一次, 避免散弹式清理漏项.
 */

export const USER_SCOPED_LOCAL_STORAGE_KEYS: ReadonlyArray<string> = [
  // auth
  'token',
  'refreshToken',
  'username',
  'user',
  // portfolio context
  'pt_selected_portfolio_id',
  // AI advisor 持久化的研究状态
  'aiAdvisor_events',
  'aiAdvisor_ticker',
  'aiAdvisor_decision',
  'aiAdvisor_analyzing',
  // 收藏 / pinned 类
  'stocks_pinned_symbols', // PINNED_KEY in StockExplorer
  // US-047 FactorWorkspace 组合模板 (FE-008) — 用户自定义因子组合 (权重 + 选股参数), localStorage-only
  'fw_combo_templates_v1',
  // US-053 LabWorkspace 快速 grid 模板 (FE-014) — 用户自定义 walk-forward param_grid 预设, localStorage-only
  'lab_grid_templates_v1',
];

/**
 * 清扫 user-scoped localStorage. 仅扫白名单, 不动 app-level preferences (主题色 / 语言等).
 */
export function clearUserScopedStorage(): void {
  try {
    for (const key of USER_SCOPED_LOCAL_STORAGE_KEYS) {
      localStorage.removeItem(key);
    }
  } catch {
    // localStorage 访问失败 (private mode / quota) — 静默
  }
}
