/**
 * Phase 15 — value flash hook.
 *
 * 给一个数字, 当它跨次 render 发生变化时, 返回一段 className 触发 600ms 闪烁
 * (绿如果涨, 红如果跌). 之后自动清除. 首次 mount 不闪.
 *
 * 用法:
 *   const flashCls = useFlashOnChange(price);
 *   <span className={flashCls}>{price}</span>
 *
 * 配套 CSS keyframes value-flash-up / value-flash-down 写在 index.css.
 */
import { useEffect, useRef, useState } from 'react';

export type FlashTone = 'up' | 'down' | null;

export function useFlashOnChange(value: number | null | undefined): string {
  const prevRef = useRef<number | null>(null);
  const [tone, setTone] = useState<FlashTone>(null);

  useEffect(() => {
    const next = value == null || !Number.isFinite(value) ? null : Number(value);
    const prev = prevRef.current;
    if (prev != null && next != null && prev !== next) {
      setTone(next > prev ? 'up' : 'down');
      const t = window.setTimeout(() => setTone(null), 650);
      prevRef.current = next;
      return () => window.clearTimeout(t);
    }
    prevRef.current = next;
  }, [value]);

  if (tone === 'up') return 'value-flash value-flash--up';
  if (tone === 'down') return 'value-flash value-flash--down';
  return '';
}
