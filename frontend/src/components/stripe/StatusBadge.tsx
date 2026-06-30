/**
 * Phase 15 — Stripe 同款 status badge (dot pill).
 *
 * 与 antd Tag 区别: 12px 高 + 6px 圆点 + 字号 11px UPPERCASE-friendly,
 * 颜色按语义 (active=green / paused=amber / failed=red / running=blue / muted=gray).
 *
 * 用法:
 *   <StatusBadge tone="active">运行中</StatusBadge>
 *   <StatusBadge tone="paused">已暂停</StatusBadge>
 */
import React from 'react';

export type StatusTone = 'active' | 'paused' | 'failed' | 'running' | 'muted' | 'brand';

interface StatusBadgeProps {
  tone?: StatusTone;
  children: React.ReactNode;
  /** 默认显示 dot, 设 false 仅文字 pill (用在 nav 计数等). */
  dot?: boolean;
  className?: string;
}

const StatusBadge: React.FC<StatusBadgeProps> = ({
  tone = 'muted',
  children,
  dot = true,
  className,
}) => {
  const cls = `status-badge status-badge--${tone}${className ? ' ' + className : ''}`;
  return (
    <span className={cls}>
      {dot && <span className="status-badge-dot" aria-hidden />}
      <span className="status-badge-label">{children}</span>
    </span>
  );
};

export default StatusBadge;
