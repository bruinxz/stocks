import React from 'react';
import { Card, Empty, Typography } from 'antd';

const { Title, Paragraph } = Typography;

const TodayWorkspace: React.FC = () => {
  return (
    <div style={{ padding: 24 }}>
      <Title level={3} style={{ marginBottom: 8 }}>
        今日作战
      </Title>
      <Paragraph type="secondary" style={{ marginBottom: 24 }}>
        开盘前一目了然：多策略当日信号、关键事件与风险提醒。完整功能将在 US-018 中实现。
      </Paragraph>
      <Card>
        <Empty description="Today Workspace 占位 — 待 US-018 实现完整内容" />
      </Card>
    </div>
  );
};

export default TodayWorkspace;
