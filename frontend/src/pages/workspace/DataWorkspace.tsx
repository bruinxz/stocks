import React, { lazy, Suspense, useState } from 'react';
import { Card, Empty, Statistic, Space, Tag, Spin } from 'antd';
import {
  CloudSyncOutlined,
  ScheduleOutlined,
  FileDoneOutlined,
  MonitorOutlined,
  DashboardOutlined,
} from '@ant-design/icons';
import WorkspaceLayout, { WorkspaceTab } from '../../components/layout/WorkspaceLayout';
import DataHealthDashboard from '../../components/data/DataHealthDashboard';

// 4 个 tab 都接入 legacy 页面（仍在使用 + 数据真实），用 lazy 减少初始 bundle
const DataUpdateStatus = lazy(() => import('../DataUpdateStatus'));
const TaskScheduler = lazy(() => import('../TaskScheduler'));
const SystemLogs = lazy(() => import('../SystemLogs'));
const HealthMonitor = lazy(() => import('../HealthMonitor'));

/**
 * 数据中心 (Data Workspace) shell.
 *
 * - 'health'     → US-079 数据健康度看板（DataHealthDashboard）
 * - 'sync'       → 行情同步状态（legacy DataUpdateStatus，2400 行实现，含手动触发 / 队列 / Bull job 列表）
 * - 'tasks'      → 调度任务（legacy TaskScheduler，2500 行实现，cron 任务管理）
 * - 'logs'       → 系统日志（legacy SystemLogs）
 * - 'monitoring' → 运行健康监控（HealthMonitor，新建：服务存活 / 队列 / DB / Redis）
 *
 * lazy import 让初始页面只装 DataHealthDashboard，切到其他 tab 再 dynamic import。
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
      <Statistic title="数据源" value={20} suffix="个" />
      <Statistic title="同步任务" value={31} />
      <Statistic title="今日告警" value={0} />
    </Space>
  );

  const headerActions = <Tag color="processing">已接入 5 个数据中心子模块</Tag>;

  const fallback = (
    <div style={{ textAlign: 'center', padding: 48 }}>
      <Spin tip="加载中..." />
    </div>
  );

  const renderTab = () => {
    switch (activeKey) {
      case 'health':
        return <DataHealthDashboard />;
      case 'sync':
        return (
          <Suspense fallback={fallback}>
            <DataUpdateStatus />
          </Suspense>
        );
      case 'tasks':
        return (
          <Suspense fallback={fallback}>
            <TaskScheduler />
          </Suspense>
        );
      case 'logs':
        return (
          <Suspense fallback={fallback}>
            <SystemLogs />
          </Suspense>
        );
      case 'monitoring':
        return (
          <Suspense fallback={fallback}>
            <HealthMonitor />
          </Suspense>
        );
      default:
        return <Card><Empty description={`未知 tab: ${activeKey}`} /></Card>;
    }
  };

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
      {renderTab()}
    </WorkspaceLayout>
  );
};

export default DataWorkspace;
