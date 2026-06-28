/**
 * Phase 16 — value pulse hook (sc-datav 借鉴的"数据更新"暗示).
 *
 * 与 useFlashOnChange 区别:
 *   - useFlashOnChange: 涨红跌绿 — 用在数字本身 (P&L 之类)
 *   - usePulseOnChange: 紫色背景闪一下 — 用在 "数据刚刚从 API 更新" 的提示, 与
 *     count-up 动画不冲突 (count-up 是数字滚动, pulse 是背景一闪)
 *
 * 用法:
 *   const pulseCls = usePulseOnChange(account?.total_value);
 *   <span className={pulseCls}>{...}</span>
 *
 * 配套 CSS @keyframes value-pulse-fresh 在 index.css Phase 16 段.
 */
import { useEffect, useRef, useState } from 'react';

export function usePulseOnChange(value: number | null | undefined): string {
  const prevRef = useRef<number | null>(null);
  const [pulse, setPulse] = useState(false);

  useEffect(() => {
    const next = value == null || !Number.isFinite(value) ? null : Number(value);
    const prev = prevRef.current;
    if (prev != null && next != null && prev !== next) {
      setPulse(true);
      const t = window.setTimeout(() => setPulse(false), 750);
      prevRef.current = next;
      return () => window.clearTimeout(t);
    }
    prevRef.current = next;
  }, [value]);

  return pulse ? 'value-pulse-fresh' : '';
}
