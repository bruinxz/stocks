/**
 * Phase 15 — Stripe 同款 Empty state.
 *
 * 中央 24px line icon + 14px 主文案 + 13px 副文案 + 可选 CTA. padding 48px.
 * 替代 antd <Empty>，与 Stripe Dashboard 的 "No data yet" 空态视觉一致.
 */
import React from 'react';

interface EmptyStripeProps {
  /** 24×24 line icon (Heroicons outline 或自定义 SVG). 不传则用默认 inbox 灰图. */
  icon?: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** 主 CTA, 一般是 antd <Button>. */
  cta?: React.ReactNode;
  className?: string;
}

const DefaultIcon: React.FC = () => (
  <svg
    width={28}
    height={28}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    aria-hidden="true"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M2.25 13.5h3.86a2.25 2.25 0 0 1 2.012 1.244l.256.512a2.25 2.25 0 0 0 2.013 1.244h3.218a2.25 2.25 0 0 0 2.013-1.244l.256-.512a2.25 2.25 0 0 1 2.013-1.244h3.859m-19.5.338V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18v-4.162c0-.224-.034-.447-.1-.661l-2.144-7.046A2.25 2.25 0 0 0 17.36 4.5H6.64a2.25 2.25 0 0 0-2.146 1.631L2.35 13.178a2.25 2.25 0 0 0-.1.661Z"
    />
  </svg>
);

const EmptyStripe: React.FC<EmptyStripeProps> = ({ icon, title, subtitle, cta, className }) => {
  return (
    <div className={`empty-stripe${className ? ' ' + className : ''}`}>
      <span className="empty-stripe-icon">{icon || <DefaultIcon />}</span>
      <div className="empty-stripe-title">{title}</div>
      {subtitle && <div className="empty-stripe-subtitle">{subtitle}</div>}
      {cta && <div className="empty-stripe-cta">{cta}</div>}
    </div>
  );
};

export default EmptyStripe;
