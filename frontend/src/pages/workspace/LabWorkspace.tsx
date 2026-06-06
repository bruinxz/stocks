import React from 'react';
import { Card, Empty, Typography } from 'antd';

const { Title, Paragraph } = Typography;

const LabWorkspace: React.FC = () => {
  return (
    <div style={{ padding: 24 }}>
      <Title level={3} style={{ marginBottom: 8 }}>
        策略实验室
      </Title>
      <Paragraph type="secondary" style={{ marginBottom: 24 }}>
        新建策略、对比回测、版本管理。完整功能将在 US-016 中实现。
      </Paragraph>
      <Card>
        <Empty description="Lab Workspace 占位 — 待 US-016 实现完整内容" />
      </Card>
    </div>
  );
};

export default LabWorkspace;
