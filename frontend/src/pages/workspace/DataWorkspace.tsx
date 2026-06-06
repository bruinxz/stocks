import React from 'react';
import { Card, Empty, Typography } from 'antd';

const { Title, Paragraph } = Typography;

const DataWorkspace: React.FC = () => {
  return (
    <div style={{ padding: 24 }}>
      <Title level={3} style={{ marginBottom: 8 }}>
        数据中心
      </Title>
      <Paragraph type="secondary" style={{ marginBottom: 24 }}>
        行情、北向资金、龙虎榜、涨停板等数据同步与质量监控。
      </Paragraph>
      <Card>
        <Empty description="Data Workspace 占位 — 后续 Story 会接入数据同步面板" />
      </Card>
    </div>
  );
};

export default DataWorkspace;
