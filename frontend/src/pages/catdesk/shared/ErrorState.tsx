import React from 'react';
import { Alert } from 'antd';

interface ErrorStateProps {
  message: string;
}

export function ErrorState({ message }: ErrorStateProps) {
  return (
    <div style={{ padding: 24 }}>
      <Alert type="error" showIcon message="出错了" description={message} />
    </div>
  );
}
