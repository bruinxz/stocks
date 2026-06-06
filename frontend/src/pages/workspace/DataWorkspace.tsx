import React, { useState } from 'react';
import { Card, Empty, Statistic, Space, Tag } from 'antd';
import {
  CloudSyncOutlined,
  ScheduleOutlined,
  FileDoneOutlined,
  MonitorOutlined,
} from '@ant-design/icons';
import WorkspaceLayout, { WorkspaceTab } from '../../components/layout/WorkspaceLayout';

/**
 * 数据中心 (Data Workspace) shell.
 *
 * US-002 deliverable: layout + KPI placeholder + per-tab empty state.
 * Tabs will fill in alongside data-pipeline stories (US-005..US-008).
 */
const DataWorkspace: React.FC = () => {
  const tabs: WorkspaceTab[] = [
    { key: 'sync', label: '行情同步', icon: <CloudSyncOutlined /> },
    { key: 'tasks', label: '调度任务', icon: <ScheduleOutlined /> },
    { key: 'logs', label: '系统日志', icon: <FileDoneOutlined /> },
    { key: 'health', label: '健康监控', icon: <MonitorOutlined /> },
  ];
  const [activeKey, setActiveKey] = useState('sync');

  const kpiSlot = (
    <Space size={32}>
      <Statistic title="数据源" value={0} suffix="个" />
      <Statistic title="今日同步" value={0} suffix="次" />
      <Statistic title="失败任务" value={0} suffix="个" />
    </Space>
  );

  const headerActions = <Tag color="processing">待 US-005..US-008 接入数据面板</Tag>;

  return (
    <WorkspaceLayout
      title="数据中心"
      subtitle="行情、北向资金、龙虎榜、涨停板等数据同步与质量监控。"
      tabs={tabs}
      activeKey={activeKey}
      onTabChange={setActiveKey}
      kpiSlot={kpiSlot}
      headerActions={headerActions}
    >
      <Card>
        <Empty description={`Data Workspace · ${activeKey} 占位 — 后续 Story 接入数据同步面板`} />
      </Card>
    </WorkspaceLayout>
  );
};

export default DataWorkspace;
