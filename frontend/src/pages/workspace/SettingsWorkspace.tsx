import React, { useState } from 'react';
import { Card, Empty, Statistic, Space, Tag } from 'antd';
import { UserOutlined, KeyOutlined, BellOutlined, TeamOutlined } from '@ant-design/icons';
import WorkspaceLayout, { WorkspaceTab } from '../../components/layout/WorkspaceLayout';

/**
 * 账号设置 (Settings Workspace) shell.
 *
 * US-002 deliverable: layout + KPI placeholder + per-tab empty state.
 * Full content (profile / API keys / notifications / users) will fold in later.
 */
const SettingsWorkspace: React.FC = () => {
  const tabs: WorkspaceTab[] = [
    { key: 'profile', label: '个人资料', icon: <UserOutlined /> },
    { key: 'keys', label: 'API 密钥', icon: <KeyOutlined /> },
    { key: 'notifications', label: '通知设置', icon: <BellOutlined /> },
    { key: 'users', label: '用户管理', icon: <TeamOutlined /> },
  ];
  const [activeKey, setActiveKey] = useState('profile');

  const kpiSlot = (
    <Space size={32}>
      <Statistic title="账号角色" value="—" />
      <Statistic title="API 密钥" value={0} suffix="个" />
      <Statistic title="未读通知" value={0} suffix="条" />
    </Space>
  );

  const headerActions = <Tag color="processing">待迁移现有个人中心 / 用户管理页</Tag>;

  return (
    <WorkspaceLayout
      title="账号设置"
      subtitle="个人资料、API 密钥、通知、用户管理等设置入口。"
      tabs={tabs}
      activeKey={activeKey}
      onTabChange={setActiveKey}
      kpiSlot={kpiSlot}
      headerActions={headerActions}
    >
      <Card>
        <Empty
          description={`Settings Workspace · ${activeKey} 占位 — 后续聚合个人中心 / 用户管理`}
        />
      </Card>
    </WorkspaceLayout>
  );
};

export default SettingsWorkspace;
