import React from 'react';
import { CowMascot, type CowMood } from './CowMascot';

interface LoadingStateProps {
  title?: string;
  description?: string;
  mood?: CowMood;
}

export function LoadingState({
  title = '正在打开九点牛研',
  description = '把行情、证据和时间线放回正确的位置…',
  mood = 'working',
}: LoadingStateProps) {
  return (
    <div className="catdesk-loading" aria-live="polite">
      <CowMascot className="catdesk-loading-cow" mood={mood} />
      <strong>{title}</strong>
      <span>{description}</span>
      <div className="catdesk-loading-track">
        <i />
      </div>
    </div>
  );
}
