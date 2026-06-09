import { useEffect, useState } from 'react';

/**
 * `useIsMobile` — A small media-query hook for responsive layout decisions.
 *
 * Returns `true` when `window.innerWidth < breakpoint`. Default breakpoint is
 * **768px** to match the project-wide "mobile / desktop" split introduced in
 * US-095 (WorkspaceLayout 顶部 Drawer 弹出 + 表格转卡片). Components should
 * fall back to a desktop-like layout if `window.matchMedia` is unavailable
 * (e.g. SSR snapshot tests, jsdom defaults), so we initialise as `false`.
 *
 * Usage:
 * ```
 * const isMobile = useIsMobile(); // 768 default
 * return isMobile ? <CardList /> : <Table />;
 * ```
 *
 * Implementation notes:
 *   - Uses `window.matchMedia(`(max-width: ${breakpoint - 1}px)`)` and listens
 *     for change events. The `breakpoint - 1` keeps the breakpoint itself in
 *     the "desktop" bucket — consistent with antd's xs/sm/md tokens (768 is
 *     the first `md` breakpoint, NOT a mobile width).
 *   - Cleans up the listener on unmount.
 *   - Re-subscribes when `breakpoint` changes so caller can dynamically adjust
 *     (rare, but free).
 *
 * Why not just use antd Grid's `useBreakpoint()`?
 *   That hook returns `{xs, sm, md, lg, xl, xxl}` booleans and re-renders on
 *   every breakpoint crossing — fine, but it pulls in antd's responsive
 *   observer plumbing and tightly couples to antd tokens. This hook stays
 *   tiny, framework-agnostic, and matches the single 768 boundary we actually
 *   care about for US-095.
 */
export function useIsMobile(breakpoint = 768): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }
    return window.matchMedia(`(max-width: ${breakpoint - 1}px)`).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const mql = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    // Initial sync (mql.matches may have changed between render & effect)
    setIsMobile(mql.matches);
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    }
    // Safari < 14 fallback
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  }, [breakpoint]);

  return isMobile;
}

export default useIsMobile;
