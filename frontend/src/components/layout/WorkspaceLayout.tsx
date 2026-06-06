import React, { useMemo } from 'react';
import { Card, Menu, Space, Typography } from 'antd';
import type { MenuProps } from 'antd';

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
 * Layout:
 *   ┌──────────── KPI bar (96px) ──────────────────────┐
 *   │ title / subtitle │ kpiSlot │ headerActions       │
 *   ├──────────┬───────────────────────────────────────┤
 *   │ 220px    │                                       │
 *   │ tabs     │   children                            │
 *   │ rail     │                                       │
 *   └──────────┴───────────────────────────────────────┘
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

  return (
    <div className="workspace-shell">
      <Card
        className="workspace-kpi-bar"
        bodyStyle={{ padding: '16px 24px', height: '100%' }}
        style={{ height: 96, marginBottom: 16 }}
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

      <div
        className="workspace-body"
        style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}
      >
        {hasTabs ? (
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
    </div>
  );
};

export default WorkspaceLayout;
