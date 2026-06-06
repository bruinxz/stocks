import React from 'react';
import { Card, Empty, Typography } from 'antd';

const { Title, Paragraph } = Typography;

const SettingsWorkspace: React.FC = () => {
  return (
    <div style={{ padding: 24 }}>
      <Title level={3} style={{ marginBottom: 8 }}>
        账号设置
      </Title>
      <Paragraph type="secondary" style={{ marginBottom: 24 }}>
        个人资料、API 密钥、通知、用户管理等设置入口。
      </Paragraph>
      <Card>
        <Empty description="Settings Workspace 占位 — 后续会聚合个人中心 / 用户管理" />
      </Card>
    </div>
  );
};

export default SettingsWorkspace;
