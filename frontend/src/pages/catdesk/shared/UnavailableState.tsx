import React from 'react';
import { Alert } from 'antd';

interface UnavailableStateProps {
  message: string;
}

export function UnavailableState({ message }: UnavailableStateProps) {
  return (
    <div style={{ padding: 24 }}>
      <Alert type="warning" showIcon message="暂不可用" description={message} />
    </div>
  );
}
