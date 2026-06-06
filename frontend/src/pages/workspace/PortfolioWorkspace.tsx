import React from 'react';
import { Card, Empty, Typography } from 'antd';

const { Title, Paragraph } = Typography;

const PortfolioWorkspace: React.FC = () => {
  return (
    <div style={{ padding: 24 }}>
      <Title level={3} style={{ marginBottom: 8 }}>
        持仓与复盘
      </Title>
      <Paragraph type="secondary" style={{ marginBottom: 24 }}>
        模拟盘持仓、资金曲线、交易明细与复盘日记。完整功能将在 US-017 中实现。
      </Paragraph>
      <Card>
        <Empty description="Portfolio Workspace 占位 — 待 US-017 实现完整内容" />
      </Card>
    </div>
  );
};

export default PortfolioWorkspace;
