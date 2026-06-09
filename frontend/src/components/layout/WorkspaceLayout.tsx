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
}

/**
 * Shared shell for the 6 unified workspaces introduced in US-002.
 *
 * Layout (desktop, ≥ 768px):
 *   ┌──────────── KPI bar (96px) ──────────────────────┐
 *   │ title / subtitle │ kpiSlot │ headerActions       │
 *   ├──────────┬───────────────────────────────────────┤
 *   │ 220px    │                                       │
 *   │ tabs     │   children                            │
 *   │ rail     │                                       │
 *   └──────────┴───────────────────────────────────────┘
 *
 * Mobile (< 768px, US-095):
 *   - Left-rail Menu is hidden; a 「☰ 标签」button appears at top-left of the
 *     content area which opens a top-anchored Drawer with the same Menu.
 *   - Tab selection closes the Drawer automatically (tap-then-go UX).
 *   - KPI bar wraps onto multiple lines; the inner flex collapses gracefully
 *     via `.workspace-kpi-bar__inner` media query in index.css.
 *
 * The shell deliberately stays presentational — tab content is fully owned by
 * the parent workspace page. Workspace shells that don't need secondary nav
 * can simply omit `tabs` to get a clean header + content split.
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
  const activeTab = useMemo(
    () => (tabs || []).find(t => t.key === activeKey),
    [tabs, activeKey]
  );

  // Tap-then-go: when user taps a tab in the mobile drawer, switch + close.
  const handleMobileMenuClick: MenuProps['onClick'] = ({ key }) => {
    onTabChange?.(String(key));
    setMobileDrawerOpen(false);
  };

  return (
    <div className="workspace-shell">
      <Card
        className="workspace-kpi-bar"
        bodyStyle={{ padding: '16px 24px', height: '100%' }}
        style={{ height: isMobile ? 'auto' : 96, marginBottom: 16 }}
      >
        <div className="workspace-kpi-bar__inner">
          <div className="workspace-kpi-bar__title">
            <Title level={4} style={{ margin: 0 }}>
              {title}
            </Title>
            {subtitle ? (
              <Paragraph type="secondary" style={{ margin: 0, fontSize: 13 }}>
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
          <Card
            className="workspace-side-tabs"
            bodyStyle={{ padding: 8 }}
            style={{ width: 220, flexShrink: 0 }}
          >
            <Menu
              mode="inline"
              selectedKeys={activeKey ? [activeKey] : []}
              onClick={({ key }) => onTabChange?.(String(key))}
              items={menuItems}
              style={{ border: 'none', background: 'transparent' }}
            />
          </Card>
        ) : null}
        <div className="workspace-content" style={{ flex: 1, minWidth: 0 }}>
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
