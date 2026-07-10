import React from 'react';
import type { TabKey } from '../useTabState';

interface TabNavProps {
  activeTab: TabKey;
  onTabChange: (key: TabKey) => void;
}

const TAB_ITEMS: { key: TabKey; label: string }[] = [
  { key: 'morning', label: 'A股早报' },
  { key: 'us', label: '美股优选' },
  { key: 'jpkr', label: '日韩市场' },
  { key: 'multi', label: '高倍潜力' },
  { key: 'backtest', label: '回测证据' },
  { key: 'daily', label: '每日日报' },
  { key: 'history', label: '报告历史' },
];

const navStyle: React.CSSProperties = {
  width: 'var(--cd-sider-w)',
  minWidth: 'var(--cd-sider-w)',
  background: 'var(--cd-bg-surface)',
  borderRight: '1px solid var(--cd-border)',
  padding: '12px 0',
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
};

const itemBase: React.CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '10px 20px',
  border: 'none',
  background: 'transparent',
  color: 'var(--cd-text-secondary)',
  fontSize: 'var(--cd-font-md)',
  fontFamily: 'var(--cd-font-sans)',
  textAlign: 'left',
  cursor: 'pointer',
  borderRadius: 'var(--cd-radius-md)',
  transition: 'background 0.15s, color 0.15s',
};

const activeExtra: React.CSSProperties = {
  background: 'var(--cd-accent)',
  color: '#fff',
  fontWeight: 600,
};

export function TabNav({ activeTab, onTabChange }: TabNavProps) {
  return (
    <nav style={navStyle} aria-label="CatDesk tabs">
      {TAB_ITEMS.map((item) => {
        const isActive = activeTab === item.key;
        return (
          <button
            key={item.key}
            type="button"
            style={{ ...itemBase, ...(isActive ? activeExtra : {}) }}
            aria-current={isActive ? 'page' : undefined}
            onClick={() => onTabChange(item.key)}
          >
            {item.label}
          </button>
        );
      })}
    </nav>
  );
}
