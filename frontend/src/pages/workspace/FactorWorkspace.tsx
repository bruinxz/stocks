import React, { useState } from 'react';
import { Card, Empty, Statistic, Space, Tag } from 'antd';
import { FundOutlined, SlidersOutlined, OrderedListOutlined } from '@ant-design/icons';
import WorkspaceLayout, { WorkspaceTab } from '../../components/layout/WorkspaceLayout';

/**
 * 选股因子 (Factor Workspace) shell.
 *
 * US-002 deliverable: layout + KPI placeholder + per-tab empty state.
 * Full content (factor distributions, weight tuning, today's picks) lands in US-015.
 */
const FactorWorkspace: React.FC = () => {
  const tabs: WorkspaceTab[] = [
    { key: 'overview', label: '因子总览', icon: <FundOutlined /> },
    { key: 'weights', label: '权重调参', icon: <SlidersOutlined /> },
    { key: 'picks', label: '今日选股清单', icon: <OrderedListOutlined /> },
  ];
  const [activeKey, setActiveKey] = useState('overview');

  const kpiSlot = (
    <Space size={32}>
      <Statistic title="已注册因子" value={0} suffix="个" />
      <Statistic title="覆盖股票" value={0} suffix="只" />
      <Statistic title="最新计算日" value="—" />
    </Space>
  );

  const headerActions = <Tag color="processing">待 US-009 / US-010 / US-015 接入</Tag>;

  return (
    <WorkspaceLayout
      title="选股因子"
      subtitle="统一管理因子库、权重调参与多因子选股结果。"
      tabs={tabs}
      activeKey={activeKey}
      onTabChange={setActiveKey}
      kpiSlot={kpiSlot}
      headerActions={headerActions}
    >
      <Card>
        <Empty description={`Factor Workspace · ${activeKey} 占位 — 待 US-015 实现完整内容`} />
      </Card>
    </WorkspaceLayout>
  );
};

export default FactorWorkspace;
