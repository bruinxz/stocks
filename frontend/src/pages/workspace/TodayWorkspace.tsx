import React, { useState } from 'react';
import { Card, Empty, Statistic, Space, Tag } from 'antd';
import { ThunderboltOutlined, AlertOutlined, BellOutlined } from '@ant-design/icons';
import WorkspaceLayout, { WorkspaceTab } from '../../components/layout/WorkspaceLayout';

/**
 * 今日作战 (Today Workspace) shell.
 *
 * US-002 deliverable: hooked into `WorkspaceLayout` with a KPI strip and a
 * single placeholder card per tab. Full content lands in US-018.
 */
const TodayWorkspace: React.FC = () => {
  const tabs: WorkspaceTab[] = [
    { key: 'signals', label: '今日信号', icon: <ThunderboltOutlined /> },
    { key: 'events', label: '关键事件', icon: <BellOutlined /> },
    { key: 'alerts', label: '风险提醒', icon: <AlertOutlined /> },
  ];
  const [activeKey, setActiveKey] = useState('signals');

  const kpiSlot = (
    <Space size={32}>
      <Statistic title="账户余额" value={0} precision={2} prefix="¥" />
      <Statistic title="昨日盈亏" value={0} precision={2} prefix="¥" />
      <Statistic title="未读风险" value={0} suffix="条" />
    </Space>
  );

  const headerActions = <Tag color="processing">待 US-018 接入策略信号</Tag>;

  return (
    <WorkspaceLayout
      title="今日作战"
      subtitle="开盘前一目了然：多策略当日信号、关键事件与风险提醒。"
      tabs={tabs}
      activeKey={activeKey}
      onTabChange={setActiveKey}
      kpiSlot={kpiSlot}
      headerActions={headerActions}
    >
      <Card>
        <Empty description={`Today Workspace · ${activeKey} 占位 — 待 US-018 实现完整内容`} />
      </Card>
    </WorkspaceLayout>
  );
};

export default TodayWorkspace;
