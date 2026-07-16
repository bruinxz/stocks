import React from 'react';
import {
  AimOutlined,
  ExperimentOutlined,
  FileTextOutlined,
  GlobalOutlined,
  HistoryOutlined,
  LineChartOutlined,
  StockOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import type { TabKey } from '../useTabState';
import { CowMascot } from './CowMascot';

interface TabNavProps {
  activeTab: TabKey;
  onTabChange: (key: TabKey) => void;
}

const TAB_ITEMS: { key: TabKey; label: string; hint: string; icon: React.ReactNode }[] = [
  { key: 'market', label: 'A股市场', hint: '全市场行情', icon: <StockOutlined /> },
  { key: 'morning', label: 'A股早报', hint: '今日线索', icon: <AimOutlined /> },
  { key: 'us', label: '美股优选', hint: '全球催化', icon: <GlobalOutlined /> },
  { key: 'jpkr', label: '日韩市场', hint: '亚洲窗口', icon: <LineChartOutlined /> },
  { key: 'multi', label: '高倍潜力', hint: '长线发现', icon: <ThunderboltOutlined /> },
  { key: 'backtest', label: '回测证据', hint: '历史验证', icon: <ExperimentOutlined /> },
  { key: 'daily', label: '每日日报', hint: '研究来信', icon: <FileTextOutlined /> },
  { key: 'history', label: '报告历史', hint: '判断档案', icon: <HistoryOutlined /> },
];

export function TabNav({ activeTab, onTabChange }: TabNavProps) {
  return (
    <aside className="catdesk-sidebar">
      <div className="catdesk-brand">
        <CowMascot className="catdesk-brand-cow" mood="confident" />
        <div>
          <strong>九点牛研</strong>
          <span>九点牛研 · 市场观察站</span>
        </div>
      </div>
      <nav className="catdesk-nav" aria-label="研究台导航">
        {TAB_ITEMS.map((item, index) => {
          const isActive = activeTab === item.key;
          return (
            <button
              key={item.key}
              type="button"
              className={isActive ? 'catdesk-nav-item is-active' : 'catdesk-nav-item'}
              aria-current={isActive ? 'page' : undefined}
              onClick={() => onTabChange(item.key)}
              style={{ '--nav-index': index } as React.CSSProperties}
            >
              <span className="catdesk-nav-icon">{item.icon}</span>
              <span className="catdesk-nav-copy">
                <strong>{item.label}</strong>
                <small>{item.hint}</small>
              </span>
              <span className="catdesk-nav-arrow">↗</span>
            </button>
          );
        })}
      </nav>
      <div className="catdesk-sidebar-note">
        <span className="catdesk-note-label">研究守则 / 09</span>
        <strong>好奇，但不莽撞。</strong>
        <p>用公开资料观察、学习与复盘。每个结论都要能走回证据。</p>
        <CowMascot className="catdesk-resting-cow" mood="sleepy" />
      </div>
    </aside>
  );
}
