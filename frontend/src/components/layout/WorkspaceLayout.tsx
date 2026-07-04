import React, { useMemo, useState } from 'react';
import { Button, Card, Drawer, Menu, Space, Typography } from 'antd';
import { MenuOutlined } from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { useIsMobile } from '../../hooks/useIsMobile';

const { Title, Paragraph } = Typography;

/**
 * One entry in the workspace's left-side secondary navigation.
 * `key` is what `activeKey` matches against; `onClick` lets a workspace
 * swap inner tab content without forcing a full route change.
 */
export interface WorkspaceTab {
  key: string;
  label: React.ReactNode;
  icon?: React.ReactNode;
  disabled?: boolean;
}

export interface WorkspaceLayoutProps {
  /** Workspace title shown at the top of the KPI bar. */
  title: React.ReactNode;
  /** One-line subtitle / context blurb under the title. */
  subtitle?: React.ReactNode;
  /** Secondary navigation rendered in the 220px left rail. */
  tabs?: WorkspaceTab[];
  /** Currently selected tab key. */
  activeKey?: string;
  /** Selection callback for left-rail tab clicks. */
  onTabChange?: (key: string) => void;
  /**
   * KPI strip slot rendered to the right of the title.
   * Renders inside a 96px-tall band; typically a row of `Statistic`s or chips.
   */
  kpiSlot?: React.ReactNode;
  /** Right-aligned action area in the KPI bar (e.g. refresh / settings buttons). */
  headerActions?: React.ReactNode;
  /** Main content area for the active tab. */
  children?: React.ReactNode;
  /**
   * Phase 12 — optional hero slot rendered ABOVE the KPI bar.
   * Pass a fully styled `<WorkspaceHero ... />` from the workspace.
   * When set, the KPI bar still renders for sticky reference numbers.
   */
  hero?: React.ReactNode;
  /**
   * Phase 12 — opt into the unified themed cards/tables/inputs.
   * When true, the content wrapper gets `.ws-themed-area` which cascades
   * the Phase 12 design system to all inner `.ant-card`/`.ant-table`
   * via the `ws-card-themed` rules.
   */
  themed?: boolean;
}

/**
 * Shared shell for the unified workspaces (US-002, refined in Phase 5 2026-06-27).
 *
 * Layout (desktop, ≥ 768px):
 *   ┌──────────── KPI bar (auto height, min 56px) ─────┐
 *   │ title │ kpiSlot │ headerActions                   │
 *   ├──────────┬───────────────────────────────────────┤
 *   │ 180px    │                                       │
 *   │ tabs     │   children                            │
 *   │ rail     │                                       │
 *   └──────────┴───────────────────────────────────────┘
 *
 * Mobile (< 768px, US-095): drawer-triggered tabs, KPI bar wraps.
 *
 * Phase 5 visual notes (docs/audit/design_system_2026_06_27.md):
 *   - KPI bar height: 固定 96px → auto (min 56px), 让标题+KPI 单行紧凑.
 *   - Tabs rail width: 220px → 180px, brand-soft selected pill, 删除 box-shadow.
 *   - 删除外层 Card 包裹的"假浮岛"感, 改为底部 1px border 分隔.
 */
const WorkspaceLayout: React.FC<WorkspaceLayoutProps> = ({
  title,
  subtitle,
  tabs,
  activeKey,
  onTabChange,
  kpiSlot,
  headerActions,
  children,
  hero,
  themed,
}) => {
  const isMobile = useIsMobile();
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);

  const menuItems: MenuProps['items'] = useMemo(
    () =>
      (tabs || []).map(tab => ({
        key: tab.key,
        icon: tab.icon,
        label: tab.label,
        disabled: tab.disabled,
      })),
    [tabs]
  );

  const hasTabs = Boolean(tabs && tabs.length > 0);
  const activeTab = useMemo(() => (tabs || []).find(t => t.key === activeKey), [tabs, activeKey]);

  // Tap-then-go: when user taps a tab in the mobile drawer, switch + close.
  const handleMobileMenuClick: MenuProps['onClick'] = ({ key }) => {
    onTabChange?.(String(key));
    setMobileDrawerOpen(false);
  };

  return (
    <div className="workspace-shell">
      {hero ? <div className="workspace-hero-slot">{hero}</div> : null}
      <Card
        className="workspace-kpi-bar"
        bodyStyle={{ padding: '12px 20px' }}
        style={{ marginBottom: 16 }}
      >
        <div className="workspace-kpi-bar__inner">
          <div className="workspace-kpi-bar__title">
            <Title level={4} style={{ margin: 0 }}>
              {title}
            </Title>
            {subtitle ? (
              <Paragraph type="secondary" style={{ margin: 0, fontSize: 12 }}>
                {subtitle}
              </Paragraph>
            ) : null}
          </div>
          <div className="workspace-kpi-bar__metrics">{kpiSlot}</div>
          <div className="workspace-kpi-bar__actions">
            {headerActions ? <Space size={8}>{headerActions}</Space> : null}
          </div>
        </div>
      </Card>

      {hasTabs && isMobile ? (
        <div className="workspace-mobile-tab-bar">
          <Button
            icon={<MenuOutlined />}
            onClick={() => setMobileDrawerOpen(true)}
            size="large"
            block
            style={{ textAlign: 'left' }}
          >
            <span style={{ marginLeft: 8 }}>
              切换标签{activeTab ? ` · ${activeTab.label}` : ''}
            </span>
          </Button>
        </div>
      ) : null}

      <div
        className="workspace-body"
        style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}
      >
        {hasTabs && !isMobile ? (
          <nav className="workspace-side-tabs" style={{ width: 184, flexShrink: 0 }}>
            <div className="workspace-side-tabs__eyebrow">视图</div>
            <Menu
              mode="inline"
              selectedKeys={activeKey ? [activeKey] : []}
              onClick={({ key }) => onTabChange?.(String(key))}
              items={menuItems}
              style={{ border: 'none', background: 'transparent' }}
            />
          </nav>
        ) : null}
        <div
          className={['workspace-content', themed ? 'ws-themed-area' : ''].filter(Boolean).join(' ')}
          style={{ flex: 1, minWidth: 0 }}
        >
          {children}
        </div>
      </div>

      {hasTabs ? (
        <Drawer
          title="工作区标签"
          placement="top"
          height="auto"
          open={mobileDrawerOpen}
          onClose={() => setMobileDrawerOpen(false)}
          styles={{ body: { padding: 8 } }}
          className="workspace-mobile-drawer"
        >
          <Menu
            mode="inline"
            selectedKeys={activeKey ? [activeKey] : []}
            onClick={handleMobileMenuClick}
            items={menuItems}
            style={{ border: 'none', background: 'transparent' }}
          />
        </Drawer>
      ) : null}
    </div>
  );
};

export default WorkspaceLayout;
