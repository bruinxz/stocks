import React, { lazy, Suspense, useEffect, useState } from 'react';
import { Card, Empty, Statistic, Space, Tag, Spin } from 'antd';
import {
  CloudSyncOutlined,
  ScheduleOutlined,
  FileDoneOutlined,
  MonitorOutlined,
  DashboardOutlined,
  StockOutlined,
} from '@ant-design/icons';
import WorkspaceLayout, { WorkspaceTab } from '../../components/layout/WorkspaceLayout';
import DataHealthDashboard from '../../components/data/DataHealthDashboard';
import StockExplorer from '../../components/data/StockExplorer';
import SystemTopologyMap from '../../components/data/SystemTopologyMap';
import ActivationDashboard from '../../components/data/ActivationDashboard';
import { getDataHealthStatus } from '../../services/dataHealthService';

// 4 个 tab 都接入 legacy 页面（仍在使用 + 数据真实），用 lazy 减少初始 bundle
const DataUpdateStatus = lazy(() => import('../DataUpdateStatus'));
const TaskScheduler = lazy(() => import('../TaskScheduler'));
const SystemLogs = lazy(() => import('../SystemLogs'));
const HealthMonitor = lazy(() => import('../HealthMonitor'));

/**
 * 数据中心 (Data Workspace) shell.
 *
 * - 'health'     → US-079 数据健康度看板（DataHealthDashboard）
 * - 'stocks'     → 个股趋势浏览器（StockExplorer，左列表 + 右 K 线）
 * - 'sync'       → 行情同步状态（legacy DataUpdateStatus）
 * - 'tasks'      → 调度任务（legacy TaskScheduler）
 * - 'logs'       → 系统日志（legacy SystemLogs）
 * - 'monitoring' → 运行健康监控（HealthMonitor）
 *
 * KPI 从 /api/data/health-status 实时计算，不再 hardcode。
 */
const DataWorkspace: React.FC = () => {
  const tabs: WorkspaceTab[] = [
    { key: 'health', label: '数据健康', icon: <DashboardOutlined /> },
    { key: 'stocks', label: '个股趋势', icon: <StockOutlined /> },
    { key: 'sync', label: '行情同步', icon: <CloudSyncOutlined /> },
    { key: 'tasks', label: '调度任务', icon: <ScheduleOutlined /> },
    { key: 'logs', label: '系统日志', icon: <FileDoneOutlined /> },
    { key: 'monitoring', label: '健康监控', icon: <MonitorOutlined /> },
  ];
  const [activeKey, setActiveKey] = useState('health');
  const [kpi, setKpi] = useState<{ total: number; red: number; yellow: number }>({
    total: 0,
    red: 0,
    yellow: 0,
  });

  useEffect(() => {
    getDataHealthStatus()
      .then((data) => {
        const cards = data?.cards || [];
        setKpi({
          total: cards.length,
          red: cards.filter((c) => c.level === 'red').length,
          yellow: cards.filter((c) => c.level === 'yellow').length,
        });
      })
      .catch(() => {
        // 失败保持 0；DataHealthDashboard 自己也会显示错误
      });
  }, []);

  const kpiSlot = (
    <Space size={32}>
      <Statistic title="数据源" value={kpi.total} suffix="个" />
      <Statistic
        title="严重滞后"
        value={kpi.red}
        valueStyle={{ color: kpi.red > 0 ? '#cf1322' : '#3f8600' }}
      />
      <Statistic
        title="轻微滞后"
        value={kpi.yellow}
        valueStyle={{ color: kpi.yellow > 0 ? '#fa8c16' : '#3f8600' }}
      />
    </Space>
  );

  const headerActions = (
    <Tag color={kpi.red > 0 ? 'red' : kpi.yellow > 0 ? 'orange' : 'green'}>
      {kpi.red > 0
        ? `${kpi.red} 个数据源严重滞后`
        : kpi.yellow > 0
        ? `${kpi.yellow} 个数据源待补`
        : '全部数据源正常'}
    </Tag>
  );

  const fallback = (
    <div style={{ textAlign: 'center', padding: 48 }}>
      <Spin tip="加载中..." />
    </div>
  );

  const renderTab = () => {
    switch (activeKey) {
      case 'health':
        return (
          <>
            <SystemTopologyMap />
            <ActivationDashboard />
            <DataHealthDashboard />
          </>
        );
      case 'stocks':
        return <StockExplorer />;
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
