import React, { useState } from 'react';
import { Card, Empty, Statistic, Space, Tag } from 'antd';
import {
  CloudSyncOutlined,
  ScheduleOutlined,
  FileDoneOutlined,
  MonitorOutlined,
  DashboardOutlined,
} from '@ant-design/icons';
import WorkspaceLayout, { WorkspaceTab } from '../../components/layout/WorkspaceLayout';
import DataHealthDashboard from '../../components/data/DataHealthDashboard';

/**
 * 数据中心 (Data Workspace) shell.
 *
 * - 'health' tab: US-079 数据健康度看板（卡片网格 + 手动触发同步 + 落后徽章）
 * - 其他 tab 仍为 US-002 占位，留待后续 story 接入。
 */
const DataWorkspace: React.FC = () => {
  const tabs: WorkspaceTab[] = [
    { key: 'health', label: '数据健康', icon: <DashboardOutlined /> },
    { key: 'sync', label: '行情同步', icon: <CloudSyncOutlined /> },
    { key: 'tasks', label: '调度任务', icon: <ScheduleOutlined /> },
    { key: 'logs', label: '系统日志', icon: <FileDoneOutlined /> },
    { key: 'monitoring', label: '健康监控', icon: <MonitorOutlined /> },
  ];
  const [activeKey, setActiveKey] = useState('health');

  const kpiSlot = (
    <Space size={32}>
      <Statistic title="数据源" value={0} suffix="个" />
      <Statistic title="今日同步" value={0} suffix="次" />
      <Statistic title="失败任务" value={0} suffix="个" />
    </Space>
  );

  const headerActions = <Tag color="processing">US-079 数据健康看板已上线</Tag>;

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
      {activeKey === 'health' ? (
        <DataHealthDashboard />
      ) : (
        <Card>
          <Empty description={`Data Workspace · ${activeKey} 占位 — 后续 Story 接入数据同步面板`} />
        </Card>
      )}
    </WorkspaceLayout>
  );
};

export default DataWorkspace;
