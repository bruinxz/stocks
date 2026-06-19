import React, { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { Card, Empty, Statistic, Space, Tag, Spin, Tooltip, Typography } from 'antd';
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
import { DataHealthStatusResponse, getDataHealthStatus } from '../../services/dataHealthService';
import {
  DataWorkspaceTabKey,
  DataWorkspaceTabViewModel,
  buildDataWorkspaceTabViewModel,
} from './dataWorkspaceTabHelpers';

// 6 个 tab 都接入 legacy 页面（仍在使用 + 数据真实），用 lazy 减少初始 bundle
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
 * US-060: 顶部 KPI / 副标题 / 状态 Tag 现在按 tab 切换 — 由
 * `dataWorkspaceTabHelpers.buildDataWorkspaceTabViewModel(activeKey, health)`
 * 派生, 每个 tab 都有 "真内容" 的上下文 KPI, 不再共用同一组固定 statistic.
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
  const [activeKey, setActiveKey] = useState<DataWorkspaceTabKey>('health');
  const [healthData, setHealthData] = useState<DataHealthStatusResponse | null>(null);

  useEffect(() => {
    getDataHealthStatus()
      .then(data => {
        setHealthData(data);
      })
      .catch(() => {
        // 失败保持 null；下游 helper 返 loading view model
        setHealthData(null);
      });
  }, []);

  // US-060: tab-aware view model — 切 tab 时 kpiSlot 内容变, 不再永远显示 health 三件套
  const vm: DataWorkspaceTabViewModel = useMemo(
    () => buildDataWorkspaceTabViewModel(activeKey, healthData),
    [activeKey, healthData]
  );

  const kpiSlot = (
    <Space size={32}>
      {vm.kpis.map((k, idx) => {
        const stat = (
          <Statistic
            title={k.title}
            value={k.value}
            suffix={k.suffix}
            valueStyle={k.color ? { color: k.color } : undefined}
          />
        );
        if (k.tooltip) {
          return (
            <Tooltip key={`${vm.tabKey}-${idx}-${k.title}`} title={k.tooltip}>
              {stat}
            </Tooltip>
          );
        }
        return <React.Fragment key={`${vm.tabKey}-${idx}-${k.title}`}>{stat}</React.Fragment>;
      })}
    </Space>
  );

  const headerActions = vm.tag ? (
    <Tag color={vm.tag.color === 'default' ? undefined : vm.tag.color}>{vm.tag.text}</Tag>
  ) : null;

  const fallback = (
    <div style={{ textAlign: 'center', padding: 48 }}>
      <Spin tip="加载中..." />
    </div>
  );

  // US-060: 每个 tab 上方都加一行 "概览条" Card — 主副标题 + 当前 tab 的语义提示
  const overviewBar = (
    <Card
      size="small"
      style={{ marginBottom: 12 }}
      bodyStyle={{ padding: '10px 16px' }}
      data-testid={`data-workspace-overview-${vm.tabKey}`}
    >
      <Space direction="vertical" size={2} style={{ width: '100%' }}>
        <Typography.Text strong style={{ fontSize: 14 }}>
          {vm.headline}
        </Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {vm.subtitle}
        </Typography.Text>
      </Space>
    </Card>
  );

  const renderTab = () => {
    switch (activeKey) {
      case 'health':
        return (
          <>
            {overviewBar}
            <SystemTopologyMap />
            <ActivationDashboard />
            <DataHealthDashboard />
          </>
        );
      case 'stocks':
        return (
          <>
            {overviewBar}
            <StockExplorer />
          </>
        );
      case 'sync':
        return (
          <>
            {overviewBar}
            <Suspense fallback={fallback}>
              <DataUpdateStatus />
            </Suspense>
          </>
        );
      case 'tasks':
        return (
          <>
            {overviewBar}
            <Suspense fallback={fallback}>
              <TaskScheduler />
            </Suspense>
          </>
        );
      case 'logs':
        return (
          <>
            {overviewBar}
            <Suspense fallback={fallback}>
              <SystemLogs />
            </Suspense>
          </>
        );
      case 'monitoring':
        return (
          <>
            {overviewBar}
            <Suspense fallback={fallback}>
              <HealthMonitor />
            </Suspense>
          </>
        );
      default:
        return (
          <Card>
            <Empty description={`未知 tab: ${activeKey as string}`} />
          </Card>
        );
    }
  };

  return (
    <WorkspaceLayout
      title="数据中心"
      subtitle="行情、北向资金、龙虎榜、涨停板等数据同步与质量监控。"
      tabs={tabs}
      activeKey={activeKey}
      onTabChange={k => setActiveKey(k as DataWorkspaceTabKey)}
      kpiSlot={kpiSlot}
      headerActions={headerActions}
    >
      {renderTab()}
    </WorkspaceLayout>
  );
};

export default DataWorkspace;
