import React from 'react';
import { Card, Empty, Typography } from 'antd';

const { Title, Paragraph } = Typography;

const FactorWorkspace: React.FC = () => {
  return (
    <div style={{ padding: 24 }}>
      <Title level={3} style={{ marginBottom: 8 }}>
        选股因子
      </Title>
      <Paragraph type="secondary" style={{ marginBottom: 24 }}>
        统一管理因子库、权重调参与多因子选股结果。完整功能将在 US-015 中实现。
      </Paragraph>
      <Card>
        <Empty description="Factor Workspace 占位 — 待 US-015 实现完整内容" />
      </Card>
    </div>
  );
};

export default FactorWorkspace;
