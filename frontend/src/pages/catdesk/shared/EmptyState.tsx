import React from 'react';
import { CowMascot } from './CowMascot';

interface EmptyStateProps {
  title?: string;
  variant?: 'default' | 'simple';
}

export function EmptyState({ title, variant = 'default' }: EmptyStateProps) {
  return (
    <div className={`catdesk-empty ${variant === 'simple' ? 'is-simple' : ''}`}>
      <div className="catdesk-empty-illustration" aria-hidden="true">
        <span className="catdesk-empty-orbit orbit-one" />
        <span className="catdesk-empty-orbit orbit-two" />
        <span className="catdesk-empty-star star-one">✦</span>
        <span className="catdesk-empty-star star-two">✶</span>
        <CowMascot className="catdesk-empty-cow" mood="hopeful" />
      </div>
      <span className="catdesk-empty-kicker">信号牧场正在整理数据</span>
      <h2>{title ?? '这片信号牧场还在苏醒'}</h2>
      <p>数据完成校验后就会来到这里。牛牛研究员正在整理证据，请稍等一小会儿。</p>
      <div className="catdesk-empty-dots">
        <i />
        <i />
        <i />
      </div>
    </div>
  );
}
