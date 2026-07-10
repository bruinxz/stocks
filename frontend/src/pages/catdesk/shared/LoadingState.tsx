import React from 'react';
import { Spin } from 'antd';

export function LoadingState() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: 200 }}>
      <Spin size="large" />
    </div>
  );
}
