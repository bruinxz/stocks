/**
 * Phase 15 (2026-06-28) — Stripe 同款精致细节: number count-up 动画.
 *
 * 页面加载/数字变化时, 用 framer-motion 把当前显示值缓动到新 target, 0.6s ease-out.
 * 不是装饰 — Stripe Dashboard 的 KPI 入场就是这样 (Gross Volume / Customers count).
 *
 * 与 Phase 14 减法基调一致: 单一 ease-out, 不用 spring; 600ms 是 Stripe 实际曲线.
 *
 * 用法:
 *   <CountUp value={123456.78} format={n => '¥' + nfMoney.format(n)} />
 *
 * prefers-reduced-motion 下退化为静态文本 (无动画).
 */
import React, { useEffect, useRef } from 'react';
import { animate, useMotionValue, useTransform, motion, useReducedMotion } from 'framer-motion';

interface CountUpProps {
  /** 目标数字. 变化时自动重新缓动. */
  value: number | null | undefined;
  /** 格式化函数 — 默认 toFixed(0). */
  format?: (n: number) => string;
  /** 动画时长 (秒), 默认 0.6 (Stripe 标配). */
  duration?: number;
  /** 缺省 占位文本 (value 为 null/undefined/NaN 时). */
  fallback?: string;
  /** 透传 className 给外层 span. */
  className?: string;
}

const CountUp: React.FC<CountUpProps> = ({
  value,
  format = (n: number) => String(Math.round(n)),
  duration = 0.6,
  fallback = '—',
  className,
}) => {
  const reduceMotion = useReducedMotion();
  const target = value == null || !Number.isFinite(value) ? null : Number(value);
  const motionVal = useMotionValue(target ?? 0);
  const rounded = useTransform(motionVal, (latest: number) => format(latest));
  const prevTargetRef = useRef<number | null>(target);

  useEffect(() => {
    if (target == null) return;
    if (reduceMotion) {
      motionVal.set(target);
      prevTargetRef.current = target;
      return;
    }
    const from = prevTargetRef.current ?? 0;
    motionVal.set(from);
    const controls = animate(motionVal, target, {
      duration,
      ease: [0.22, 1, 0.36, 1],
    });
    prevTargetRef.current = target;
    return () => controls.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, duration, reduceMotion]);

  if (target == null) {
    return <span className={className}>{fallback}</span>;
  }
  return <motion.span className={className}>{rounded}</motion.span>;
};

export default CountUp;
