import React, { useState } from 'react';
import { Card, Empty, Statistic, Space, Tag } from 'antd';
import { ExperimentOutlined, PlusSquareOutlined, SwapOutlined } from '@ant-design/icons';
import WorkspaceLayout, { WorkspaceTab } from '../../components/layout/WorkspaceLayout';

/**
 * 策略实验室 (Lab Workspace) shell.
 *
 * US-002 deliverable: layout + KPI placeholder + per-tab empty state.
 * Full content (strategy list / new backtest / comparison) lands in US-016.
 */
const LabWorkspace: React.FC = () => {
  const tabs: WorkspaceTab[] = [
    { key: 'mine', label: '我的策略', icon: <ExperimentOutlined /> },
    { key: 'new', label: '新建回测', icon: <PlusSquareOutlined /> },
    { key: 'compare', label: '回测对比', icon: <SwapOutlined /> },
  ];
  const [activeKey, setActiveKey] = useState('mine');

  const kpiSlot = (
    <Space size={32}>
      <Statistic title="已保存策略" value={0} suffix="个" />
      <Statistic title="进行中回测" value={0} suffix="项" />
      <Statistic title="最近 7 日完成" value={0} suffix="次" />
    </Space>
  );

  const headerActions = <Tag color="processing">待 US-011 / US-012 / US-013 / US-016 接入</Tag>;

  return (
    <WorkspaceLayout
      title="策略实验室"
      subtitle="新建策略、对比回测、版本管理 — 策略迭代的统一工作台。"
      tabs={tabs}
      activeKey={activeKey}
      onTabChange={setActiveKey}
      kpiSlot={kpiSlot}
      headerActions={headerActions}
    >
      <Card>
        <Empty description={`Lab Workspace · ${activeKey} 占位 — 待 US-016 实现完整内容`} />
      </Card>
    </WorkspaceLayout>
  );
};

export default LabWorkspace;
