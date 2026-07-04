import React, { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { Card, Empty, Statistic, Space, Tag, Spin, Tooltip, Typography, Segmented } from 'antd';
import {
  CloudSyncOutlined,
  MonitorOutlined,
  DashboardOutlined,
  StockOutlined,
} from '@ant-design/icons';
import WorkspaceLayout, { WorkspaceTab } from '../../components/layout/WorkspaceLayout';
import WorkspaceHero from '../../components/layout/WorkspaceHero';
import { AnimatePresence, motion } from 'framer-motion';
import DataHealthDashboard from '../../components/data/DataHealthDashboard';
import StockExplorer from '../../components/data/StockExplorer';
// Batch AQ (2026-06-21) — SystemTopologyMap 已迁到 系统介绍 → 架构图
// (用户原话: 架构图应挂在系统介绍 tab, 不在数据中心). 这里删 import + health 渲染.
import ActivationDashboard from '../../components/data/ActivationDashboard';
import SlaDashboardCard from '../../components/data/SlaDashboardCard';
import DataMissingAlertsCard from '../../components/data/DataMissingAlertsCard';
import BulkBackfillButton from '../../components/data/BulkBackfillButton';
import DataSourceSwitchCard from '../../components/data/DataSourceSwitchCard';
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
/** 收敛后一级 tab key — 运维三视图折进 'ops'. */
type DataTopTabKey = 'health' | 'stocks' | 'sync' | 'ops';

const DataWorkspace: React.FC = () => {
  // 收敛 (2026-07-04): 原 6 个一级 tab 里 调度任务/系统日志/健康监控 3 个纯 admin
  // 运维视图折进单个「运维」tab, 内部用二级 Segmented 切换, 一级 6 → 4.
  const tabs: WorkspaceTab[] = [
    { key: 'health', label: '数据健康', icon: <DashboardOutlined /> },
    { key: 'stocks', label: '个股趋势', icon: <StockOutlined /> },
    { key: 'sync', label: '行情同步', icon: <CloudSyncOutlined /> },
    { key: 'ops', label: '运维', icon: <MonitorOutlined /> },
  ];
  const [activeKey, setActiveKey] = useState<DataTopTabKey>('health');
  // 「运维」二级子视图: 调度任务 / 系统日志 / 健康监控.
  const [opsSubView, setOpsSubView] = useState<'tasks' | 'logs' | 'monitoring'>('tasks');
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

  // US-063: 一键补抓完成后让本 Workspace 主动 refresh healthData, 让三张
  // 派生卡 (SLA / 数据缺失告警 / 一键补抓本身) 立刻反映新 lag.
  const refreshHealthData = React.useCallback(() => {
    getDataHealthStatus()
      .then(data => setHealthData(data))
      .catch(() => {
        /* 静默 — 既有 60s polling 兜底 */
      });
  }, []);

  // US-060: tab-aware view model — 切 tab 时 kpiSlot 内容变, 不再永远显示 health 三件套.
  // 「运维」tab 复用其二级子视图 (tasks/logs/monitoring) 的 view model, KPI 随子视图切.
  const vmKey: DataWorkspaceTabKey = activeKey === 'ops' ? opsSubView : activeKey;
  const vm: DataWorkspaceTabViewModel = useMemo(
    () => buildDataWorkspaceTabViewModel(vmKey, healthData),
    [vmKey, healthData]
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
            <BulkBackfillButton healthData={healthData} onBackfillDone={refreshHealthData} />
            <SlaDashboardCard healthData={healthData} />
            <DataMissingAlertsCard healthData={healthData} />
            <DataSourceSwitchCard />
            {/* Batch AQ (2026-06-21) — SystemTopologyMap 已迁到 系统介绍 → 架构图 */}
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
      case 'ops':
        return (
          <>
            {overviewBar}
            <Segmented
              className="ws-tab-segmented"
              style={{ marginBottom: 12 }}
              options={[
                { label: '调度任务', value: 'tasks' },
                { label: '系统日志', value: 'logs' },
                { label: '健康监控', value: 'monitoring' },
              ]}
              value={opsSubView}
              onChange={v => setOpsSubView(v as typeof opsSubView)}
            />
            <Suspense fallback={fallback}>
              {opsSubView === 'tasks' ? (
                <TaskScheduler />
              ) : opsSubView === 'logs' ? (
                <SystemLogs />
              ) : (
                <HealthMonitor />
              )}
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
      onTabChange={k => setActiveKey(k as DataTopTabKey)}
      hero={
        <WorkspaceHero
          eyebrow="Data · 管理员视图"
          title="数据中心"
          subtitle="行情同步 · 调度任务 · 系统日志 · 健康监控 — admin 级别全链路可观测性"
          variant="admin"
          metrics={vm.kpis.slice(0, 3).map((k, idx) => ({
            label: k.title,
            value: k.value === undefined || k.value === null ? '—' : String(k.value),
            unit: k.suffix,
            emphasis: idx === 0,
          }))}
        />
      }
      themed
    >
      {/* Phase 16 — sc-datav 借鉴: admin 区极淡 grid 背景 (48px 单元), 暗示 "在
          数据空间里". 用户 tab (Home/Portfolio/Lab/Settings) 保持纯白. */}
      <div className="workspace-grid-bg" style={{ padding: '8px 0', minHeight: '100%' }}>
        <AnimatePresence mode="wait">
          <motion.div
            key={activeKey}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            {renderTab()}
          </motion.div>
        </AnimatePresence>
      </div>
    </WorkspaceLayout>
  );
};

export default DataWorkspace;
