/**
 * Phase 15 — Stripe 同款 section divider (细线 + 中央 brand dot).
 *
 * 用于长页面 (HomeWorkspace / SystemWorkspace) 的 section 分隔.
 */
import React from 'react';

const SectionDivider: React.FC<{ className?: string }> = ({ className }) => (
  <div className={`section-divider${className ? ' ' + className : ''}`} aria-hidden>
    <span className="section-divider-dot" />
  </div>
);

export default SectionDivider;
