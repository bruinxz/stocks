import React, { useMemo, useState } from 'react';
import { Button, Card, Drawer, Space, Tabs, Typography } from 'antd';
import { MenuOutlined } from '@ant-design/icons';

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
 * Phase 24 (2026-07-04) — 去重复标题:
 *   页面同时传 hero (WorkspaceHero 已展示大标题/副标题) 与 title/subtitle 时,
 *   KPI bar 不再重复渲染 title/subtitle —— 仅当 hero 缺席时才在 KPI bar 顶部
 *   显示标题块. 另外, 若 KPI bar 内既无标题块、也无 kpiSlot / headerActions,
 *   则整条 KPI bar 不渲染, 避免留下一条空 Card.
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

  const hasTabs = Boolean(tabs && tabs.length > 0);
  const activeTab = useMemo(() => (tabs || []).find(t => t.key === activeKey), [tabs, activeKey]);

  // Phase 24 去重复: hero 已经承载了标题/副标题, KPI bar 里就不再重复。
  const showKpiTitle = !hero;
  const hasKpiBar = showKpiTitle || Boolean(kpiSlot) || Boolean(headerActions);

  return (
    <div className="workspace-shell">
      {hero ? <div className="workspace-hero-slot">{hero}</div> : null}
      {hasKpiBar ? (
        <Card
          className={['workspace-kpi-bar', showKpiTitle ? '' : 'workspace-kpi-bar--no-title']
            .filter(Boolean)
            .join(' ')}
          bodyStyle={{ padding: '12px 20px' }}
          style={{ marginBottom: 16 }}
        >
          <div className="workspace-kpi-bar__inner">
            {showKpiTitle ? (
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
            ) : null}
            <div className="workspace-kpi-bar__metrics">{kpiSlot}</div>
            <div className="workspace-kpi-bar__actions">
              {headerActions ? <Space size={8}>{headerActions}</Space> : null}
            </div>
          </div>
        </Card>
      ) : null}

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

      <div className="workspace-body">
        {hasTabs && !isMobile ? (
          <Tabs
            activeKey={activeKey}
            onChange={key => onTabChange?.(key)}
            className="workspace-top-tabs"
            style={{ marginBottom: 16 }}
            items={(tabs || []).map(tab => ({
              key: tab.key,
              label: (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  {tab.icon}{tab.label}
                </span>
              ),
              disabled: tab.disabled,
            }))}
          />
        ) : null}
        <div
          className={['workspace-content', themed ? 'ws-themed-area' : ''].filter(Boolean).join(' ')}
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
          <Tabs
            activeKey={activeKey}
            onChange={key => { onTabChange?.(key); setMobileDrawerOpen(false); }}
            tabPosition="left"
            items={(tabs || []).map(tab => ({
              key: tab.key,
              label: (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  {tab.icon}{tab.label}
                </span>
              ),
              disabled: tab.disabled,
            }))}
          />
        </Drawer>
      ) : null}
    </div>
  );
};

export default WorkspaceLayout;
