import React, { useState } from 'react';
import { Card, Empty, Statistic, Space, Tag } from 'antd';
import {
  WalletOutlined,
  LineChartOutlined,
  UnorderedListOutlined,
  ReadOutlined,
} from '@ant-design/icons';
import WorkspaceLayout, { WorkspaceTab } from '../../components/layout/WorkspaceLayout';

/**
 * 持仓与复盘 (Portfolio Workspace) shell.
 *
 * US-002 deliverable: layout + KPI placeholder + per-tab empty state.
 * Full content (positions / equity curve / trades / journal) lands in US-017.
 */
const PortfolioWorkspace: React.FC = () => {
  const tabs: WorkspaceTab[] = [
    { key: 'positions', label: '当前持仓', icon: <WalletOutlined /> },
    { key: 'equity', label: '资金曲线', icon: <LineChartOutlined /> },
    { key: 'trades', label: '交易明细', icon: <UnorderedListOutlined /> },
    { key: 'journal', label: '复盘日记', icon: <ReadOutlined /> },
  ];
  const [activeKey, setActiveKey] = useState('positions');

  const kpiSlot = (
    <Space size={32}>
      <Statistic title="当前持仓" value={0} suffix="只" />
      <Statistic title="今日浮盈" value={0} precision={2} prefix="¥" />
      <Statistic title="当月收益" value={0} precision={2} suffix="%" />
      <Statistic title="最大回撤" value={0} precision={2} suffix="%" />
    </Space>
  );

  const headerActions = <Tag color="processing">待 US-017 接入 PaperTradingFacade</Tag>;

  return (
    <WorkspaceLayout
      title="持仓与复盘"
      subtitle="模拟盘持仓、资金曲线、交易明细与复盘日记 — 赚亏闭环。"
      tabs={tabs}
      activeKey={activeKey}
      onTabChange={setActiveKey}
      kpiSlot={kpiSlot}
      headerActions={headerActions}
    >
      <Card>
        <Empty description={`Portfolio Workspace · ${activeKey} 占位 — 待 US-017 实现完整内容`} />
      </Card>
    </WorkspaceLayout>
  );
};

export default PortfolioWorkspace;
