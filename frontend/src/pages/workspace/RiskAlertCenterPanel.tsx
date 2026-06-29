/**
 * PR-C 风控告警中心 v2 — Stripe Dashboard-style 告警中心.
 *
 * 重构动机 (基于 prod 真实数据):
 *   prod 近 7 日 196 条 risk_alerts 里 177 (90%) 是 `wizard_compliance` MEDIUM
 *   (BUY 信号合规阻断). 真正"关键事件" `per_stock_stop_loss HIGH` (宝钢止损)
 *   仅 1 条, 被埋到第 6 页 — 用户感觉"关键事件没同步"实为信号噪音淹没.
 *
 * 5 大改造:
 *   1. 顶部 secondary hero (eyebrow + 大标题 + 4 metric Stripe-风)
 *   2. Segmented 智能视图 (关键事件 / 持仓相关 / 数据健康 / 全部); 默认 critical
 *   3. rule_id 中文映射 + emoji icon + 浅色背景胶囊 (替代生硬英文)
 *   4. 同 (rule_id, symbol, day) 24h 聚合: 同组折叠成 1 行 + 展开 row 看每条
 *   5. 内容列 2 行 clamp, 不再依赖 hover Tooltip 看全文; 展开 row 显示全部 message
 *   6. HIGH/CRITICAL 未读 sticky banner — 顶部 Alert 让用户先解决最重要的
 *
 * 与原 US-077 `RiskAlertCenterPanel` (TodayWorkspace.tsx 内) 的差异:
 *   - 抽到独立文件 → 可被 PortfolioWorkspace "我的提醒" 复用 (positionSymbols 限定);
 *   - 默认进入 critical view (用户不需要翻页找关键事件);
 *   - rule_id 中文化 + 4 智能视图 + 24h 聚合 — 让"关键事件不再被噪音淹没".
 *
 * 与 PR-A (backend filter) / PR-B (利好 rule_id) 的边界:
 *   - PR-A 改 backend (server-side filter), PR-B 加新 rule_id (利好事件);
 *   - 本 PR-C 改 frontend, 0 文件冲突. RULE_ID_META 已含 PR-B 的 stock_bullish_event.
 *
 * Props:
 *   - onUnreadCountChange: 改完已读后通知父组件刷新 KPI 红点
 *   - positionSymbols: 用户持仓代码 list (positions view 用; PortfolioWorkspace 传, TodayWorkspace 不传)
 *   - initialView: 默认进入哪个 view (TodayWorkspace 用 'critical', PortfolioWorkspace 用 'positions')
 *   - title: 卡片标题文案 (admin / 普通用户文案差异)
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Empty,
  Input,
  Popconfirm,
  Row,
  Segmented,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import type { TableRowSelection } from 'antd/es/table/interface';
import {
  CheckCircleOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import dayjs, { Dayjs } from 'dayjs';
import {
  listRiskAlerts,
  markAlertsAsRead,
  markAllRiskAlertsRead,
  RiskAlertItem,
  RiskAlertListParams,
  AlertCategory,
  ALERT_CATEGORY_LABEL,
} from '../../services/riskAlertService';
import {
  AlertView,
  ALERT_VIEW_OPTIONS,
  AggregatedAlert,
  aggregateAlertsByRuleAndSymbol,
  computeRiskCenterHeroStats,
  countUnreadHighAlerts,
  filterAlertsByView,
  getRuleIdMeta,
} from './riskCenterHelpers';

const { Text, Paragraph } = Typography;
const { RangePicker } = DatePicker;

// ---------------------------------------------------------------------------
// 私有工具函数 — 颜色 / Tag / 文案小工具
// ---------------------------------------------------------------------------

function levelTag(level: string): React.ReactNode {
  const upper = (level || '').toUpperCase();
  if (upper === 'HIGH' || upper === 'CRITICAL') return <Tag color="red">高</Tag>;
  if (upper === 'MEDIUM') return <Tag color="orange">中</Tag>;
  if (upper === 'LOW') return <Tag color="blue">低</Tag>;
  return <Tag>{level}</Tag>;
}

function categoryTag(category: AlertCategory): React.ReactNode {
  const label = ALERT_CATEGORY_LABEL[category] || String(category);
  return (
    <Tag color="default" style={{ fontSize: 11 }}>
      {label}
    </Tag>
  );
}

// ---------------------------------------------------------------------------
// Secondary hero — 复用 .ws-hero CSS class, 看上去与 WorkspaceHero 一致
// ---------------------------------------------------------------------------

interface RiskCenterHeroProps {
  newToday: number;
  weekTotal: number;
  highRatio: number;
  dataHealth: 'healthy' | 'degraded';
  dataIssueCount: number;
}

/**
 * 风控中心专属 hero — 与 WorkspaceHero 视觉对齐, 但 inline 在 panel 内 (不替代
 * 工作区 hero). variant=admin (深灰色), 与 admin-only 入口属性匹配.
 *
 * 复用 .ws-hero CSS class 让样式 0 增量 (bundle 友好).
 */
const RiskCenterHero: React.FC<RiskCenterHeroProps> = ({
  newToday,
  weekTotal,
  highRatio,
  dataHealth,
  dataIssueCount,
}) => {
  const highPct = `${(highRatio * 100).toFixed(0)}%`;
  const healthDot = dataHealth === 'healthy' ? '●' : '○';
  const healthColor = dataHealth === 'healthy' ? '#10b981' : '#dc2626';
  const healthLabel = dataHealth === 'healthy' ? '健康' : `异常 ${dataIssueCount}`;

  return (
    <section className="ws-hero ws-hero--admin" style={{ marginBottom: 16 }}>
      <div className="ws-hero__inner">
        <div className="ws-hero__left">
          <span className="ws-hero__eyebrow">Risk Center · 风控告警中心</span>
          <h1 className="ws-hero__title">
            今日 {newToday} 条新告警
          </h1>
          <p className="ws-hero__subtitle">
            关键事件优先, 噪音自动聚合 — 别被 90% 的合规噪音淹没真正的风险
          </p>
        </div>
        <div className="ws-hero__right">
          <div className="ws-hero__metric">
            <span className="ws-hero__metric-label">今日新增</span>
            <span className="ws-hero__metric-value ws-hero__metric-value--lg">{newToday}</span>
          </div>
          <div className="ws-hero__metric">
            <span className="ws-hero__metric-label">本周累计</span>
            <span className="ws-hero__metric-value">{weekTotal}</span>
          </div>
          <div className="ws-hero__metric">
            <span className="ws-hero__metric-label">HIGH 占比</span>
            <span className="ws-hero__metric-value">{highPct}</span>
          </div>
          <div className="ws-hero__metric">
            <span className="ws-hero__metric-label">数据健康</span>
            <span className="ws-hero__metric-value" style={{ color: healthColor }}>
              <span style={{ marginRight: 4 }}>{healthDot}</span>
              {healthLabel}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
};

// ---------------------------------------------------------------------------
// 主组件 props
// ---------------------------------------------------------------------------

export interface RiskAlertCenterPanelProps {
  /** 改完已读后通知父组件刷新顶部 KPI 红点 */
  onUnreadCountChange?: () => void;
  /** 用户持仓代码 list — positions view 据此过滤 */
  positionSymbols?: ReadonlyArray<string> | null;
  /** 默认进入视图 (TodayWorkspace='critical', PortfolioWorkspace='positions') */
  initialView?: AlertView;
  /** Card 标题文案 — 普通用户可传 "我的提醒" */
  title?: string;
}

// ---------------------------------------------------------------------------
// RiskAlertCenterPanel
// ---------------------------------------------------------------------------

const RiskAlertCenterPanel: React.FC<RiskAlertCenterPanelProps> = ({
  onUnreadCountChange,
  positionSymbols,
  initialView = 'critical',
  title = '风控告警中心',
}) => {
  // ---- backend list ----
  const [items, setItems] = useState<RiskAlertItem[]>([]);
  const [total, setTotal] = useState(0);
  const [unreadCount, setUnreadCount] = useState(0);
  // PR-C: 让 backend 拉一个较大的页 (limit=200) 让前端做智能视图过滤 + 聚合.
  // 这与原来 server-side 分页不同 - 但风控告警基本不会超过 200/天, OK.
  // 若超出 200, footer 提示用户用 date_from 缩窄 (现有 filter 仍生效).
  const [page, setPage] = useState(1);
  // pageSize 固定 200 (前端聚合 + 视图过滤后再做客户端分页 30/页)
  const pageSize = 200;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ---- view + 二级 filter (与原 panel 同) ----
  const [view, setView] = useState<AlertView>(initialView);
  const [filterLevel, setFilterLevel] = useState<'HIGH' | 'MEDIUM' | 'LOW' | undefined>(undefined);
  const [filterType, setFilterType] = useState<AlertCategory | undefined>(undefined);
  const [filterDateRange, setFilterDateRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);
  const [filterIsRead, setFilterIsRead] = useState<boolean | undefined>(undefined);
  const [filterSearch, setFilterSearch] = useState<string>('');

  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [marking, setMarking] = useState(false);

  // ---- 组装 backend query — useMemo 让 effect deps 稳定 ----
  const queryParams = useMemo<RiskAlertListParams>(() => {
    const params: RiskAlertListParams = { page, limit: pageSize };
    if (filterLevel) params.level = filterLevel;
    if (filterType) params.type = filterType;
    if (filterIsRead !== undefined) params.is_read = filterIsRead;
    if (filterSearch.trim()) params.search = filterSearch.trim();
    if (filterDateRange?.[0]) params.date_from = filterDateRange[0].format('YYYY-MM-DD');
    if (filterDateRange?.[1]) params.date_to = filterDateRange[1].format('YYYY-MM-DD');
    return params;
  }, [page, pageSize, filterLevel, filterType, filterIsRead, filterSearch, filterDateRange]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listRiskAlerts(queryParams);
      setItems(res.items);
      setTotal(res.total);
      setUnreadCount(res.unread_count);
      setSelectedIds([]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [queryParams]);

  useEffect(() => {
    void load();
  }, [load]);

  // ---- 智能视图过滤 + 24h 聚合 ----
  const viewFiltered = useMemo(
    () => filterAlertsByView(items, view, positionSymbols ?? null),
    [items, view, positionSymbols]
  );
  const aggregated = useMemo<AggregatedAlert[]>(
    () => aggregateAlertsByRuleAndSymbol(viewFiltered),
    [viewFiltered]
  );

  // ---- hero 统计 (基于全量当前 items, 不基于 view 过滤) ----
  const heroStats = useMemo(() => computeRiskCenterHeroStats(items), [items]);
  const highUnreadCount = useMemo(() => countUnreadHighAlerts(items), [items]);

  // ---- 批量已读 ----
  const handleMarkSelected = useCallback(async () => {
    if (selectedIds.length === 0) {
      message.info('请先选择告警');
      return;
    }
    setMarking(true);
    try {
      const res = await markAlertsAsRead(selectedIds);
      message.success(`已标记 ${res.updated} 条告警为已读`);
      setSelectedIds([]);
      await load();
      onUnreadCountChange?.();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      message.error(`批量标记失败：${msg}`);
    } finally {
      setMarking(false);
    }
  }, [selectedIds, load, onUnreadCountChange]);

  const handleMarkAll = useCallback(async () => {
    setMarking(true);
    try {
      await markAllRiskAlertsRead();
      message.success('已将全部未读告警标记为已读');
      await load();
      onUnreadCountChange?.();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      message.error(`一键已读失败：${msg}`);
    } finally {
      setMarking(false);
    }
  }, [load, onUnreadCountChange]);

  const handleResetFilters = useCallback(() => {
    setFilterLevel(undefined);
    setFilterType(undefined);
    setFilterDateRange(null);
    setFilterIsRead(undefined);
    setFilterSearch('');
    setPage(1);
  }, []);

  // ---- sticky banner: 直接跳到 critical view ----
  const handleJumpToCritical = useCallback(() => {
    setView('critical');
    setFilterIsRead(false); // 仅看未读
  }, []);

  // ---- rowSelection: 已读不可选 (post-action 防呆) ----
  const rowSelection: TableRowSelection<AggregatedAlert> = {
    selectedRowKeys: selectedIds,
    onChange: keys => setSelectedIds(keys.map(k => Number(k))),
    getCheckboxProps: row => ({
      disabled: row.is_read,
    }),
  };

  return (
    <Space direction="vertical" size={0} style={{ width: '100%' }}>
      {/* 1. Secondary hero */}
      <RiskCenterHero
        newToday={heroStats.newToday}
        weekTotal={heroStats.weekTotal}
        highRatio={heroStats.highRatio}
        dataHealth={heroStats.dataHealth}
        dataIssueCount={heroStats.dataIssueCount}
      />

      {/* 2. Sticky HIGH banner — 未读 HIGH > 0 才显示 */}
      {highUnreadCount > 0 && (
        <Alert
          type="error"
          showIcon
          icon={<WarningOutlined />}
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 10,
            marginBottom: 16,
          }}
          message={`${highUnreadCount} 条 HIGH 告警未处理`}
          description="点击右侧按钮直接进入关键事件视图, 优先处理这些."
          action={
            <Button
              size="small"
              danger
              type="primary"
              onClick={handleJumpToCritical}
              data-testid="risk-center-jump-critical"
            >
              立即查看
            </Button>
          }
        />
      )}

      {/* 3. 主 Card */}
      <Card
        size="small"
        title={
          <Space>
            <SafetyCertificateOutlined style={{ color: '#722ed1' }} />
            <span>{title}</span>
            <Tag color={unreadCount > 0 ? 'red' : 'green'}>未读 {unreadCount}</Tag>
            <Tag color="default">本视图 {aggregated.length} 组 / 全部 {total}</Tag>
          </Space>
        }
        extra={
          <Space>
            <Button
              icon={<ReloadOutlined />}
              onClick={() => void load()}
              loading={loading}
              size="small"
            >
              刷新
            </Button>
            <Button
              type="primary"
              icon={<CheckCircleOutlined />}
              disabled={selectedIds.length === 0 || marking}
              loading={marking && selectedIds.length > 0}
              onClick={() => void handleMarkSelected()}
              size="small"
            >
              标记选中已读 ({selectedIds.length})
            </Button>
            <Popconfirm
              title="将所有未读告警标记为已读？"
              description={`此操作会更新 ${unreadCount} 条未读告警，无法撤销`}
              okText="确认"
              cancelText="取消"
              onConfirm={handleMarkAll}
              disabled={unreadCount === 0 || marking}
            >
              <Button
                danger
                disabled={unreadCount === 0 || marking}
                loading={marking && selectedIds.length === 0}
                size="small"
              >
                一键全部已读
              </Button>
            </Popconfirm>
          </Space>
        }
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {error && (
            <Alert
              type="error"
              showIcon
              message="加载失败"
              description={error}
              action={
                <Button size="small" onClick={() => void load()}>
                  重试
                </Button>
              }
            />
          )}

          {/* Segmented 智能视图 — 默认 critical (关键事件) */}
          <Segmented<AlertView>
            value={view}
            onChange={v => setView(v as AlertView)}
            options={ALERT_VIEW_OPTIONS as { label: string; value: AlertView }[]}
            data-testid="risk-center-view-segmented"
          />

          {/* 高级过滤栏 — 默认折叠级别/类型/日期等, 视图已足够覆盖大多数场景 */}
          <Row gutter={[8, 8]} align="middle">
            <Col xs={12} md={4}>
              <Select<'HIGH' | 'MEDIUM' | 'LOW'>
                placeholder="级别"
                allowClear
                style={{ width: '100%' }}
                value={filterLevel}
                onChange={v => {
                  setFilterLevel(v);
                  setPage(1);
                }}
                options={[
                  { label: '高 (HIGH)', value: 'HIGH' },
                  { label: '中 (MEDIUM)', value: 'MEDIUM' },
                  { label: '低 (LOW)', value: 'LOW' },
                ]}
              />
            </Col>
            <Col xs={12} md={4}>
              <Select<AlertCategory>
                placeholder="类型"
                allowClear
                style={{ width: '100%' }}
                value={filterType}
                onChange={v => {
                  setFilterType(v);
                  setPage(1);
                }}
                options={[
                  { label: '持仓', value: 'position' },
                  { label: '市场', value: 'market' },
                  { label: '单股', value: 'individual' },
                ]}
              />
            </Col>
            <Col xs={24} md={7}>
              <RangePicker
                style={{ width: '100%' }}
                value={filterDateRange ?? undefined}
                onChange={dates => {
                  setFilterDateRange(dates as [Dayjs | null, Dayjs | null] | null);
                  setPage(1);
                }}
                placeholder={['开始日期', '结束日期']}
              />
            </Col>
            <Col xs={12} md={4}>
              <Select<'all' | 'unread' | 'read'>
                placeholder="读取状态"
                style={{ width: '100%' }}
                value={filterIsRead === undefined ? 'all' : filterIsRead ? 'read' : 'unread'}
                onChange={v => {
                  setFilterIsRead(v === 'all' ? undefined : v === 'read');
                  setPage(1);
                }}
                options={[
                  { label: '全部', value: 'all' },
                  { label: '未读', value: 'unread' },
                  { label: '已读', value: 'read' },
                ]}
              />
            </Col>
            <Col xs={24} md={5}>
              <Input.Search
                placeholder="代码/名称模糊搜索"
                allowClear
                value={filterSearch}
                onChange={e => setFilterSearch(e.target.value)}
                onSearch={() => setPage(1)}
              />
            </Col>
            <Col xs={24} md={24}>
              <Space>
                <Button size="small" onClick={handleResetFilters}>
                  重置过滤
                </Button>
                {selectedIds.length > 0 && (
                  <Text type="secondary">已选 {selectedIds.length} 条</Text>
                )}
              </Space>
            </Col>
          </Row>

          {/* 主表格 — aggregated rows, 同 (rule_id/symbol/day) 折叠 */}
          <Table<AggregatedAlert>
            size="small"
            rowKey="id"
            loading={loading}
            dataSource={aggregated}
            rowSelection={rowSelection}
            pagination={{
              defaultPageSize: 30,
              pageSize: 30,
              total: aggregated.length,
              showSizeChanger: false,
              showTotal: (n) => `共 ${n} 组 (24h 聚合后)`,
            }}
            expandable={{
              expandedRowRender: record => (
                <NestedAlertList alerts={record.aggregated_alerts} />
              ),
              rowExpandable: record => record.aggregated_count > 1 || (record.message?.length || 0) > 80,
            }}
            locale={{
              emptyText: (
                <Empty
                  description={
                    view === 'critical'
                      ? '当前视图无关键事件 — 这是好消息'
                      : '当前视图无符合条件的告警'
                  }
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                />
              ),
            }}
            columns={[
              {
                title: '级别',
                dataIndex: 'level',
                width: 70,
                render: (v: string) => levelTag(v),
              },
              {
                title: '规则',
                key: 'rule_id_pill',
                width: 140,
                render: (_: unknown, row: AggregatedAlert) => {
                  const meta = getRuleIdMeta(row.rule_id);
                  return (
                    <span
                      data-testid={`risk-center-rule-pill-${row.id}`}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                        padding: '2px 8px',
                        borderRadius: 999,
                        background: `${meta.color}1a`,
                        color: meta.color,
                        fontSize: 12,
                        fontWeight: 500,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      <span aria-hidden style={{ fontSize: 13 }}>
                        {meta.icon}
                      </span>
                      <span>{meta.label}</span>
                    </span>
                  );
                },
              },
              {
                title: '类型',
                dataIndex: 'category',
                width: 64,
                render: (v: AlertCategory) => categoryTag(v),
              },
              {
                title: '代码 / 名称',
                key: 'symbol_name',
                width: 200,
                render: (_: unknown, row: AggregatedAlert) => (
                  <Space direction="vertical" size={0}>
                    <Text code style={{ fontSize: 12 }}>
                      {row.symbol}
                    </Text>
                    <Text strong>{row.name || '—'}</Text>
                  </Space>
                ),
              },
              {
                title: '内容',
                dataIndex: 'message',
                render: (v: string, row: AggregatedAlert) => (
                  <div>
                    <Paragraph
                      style={{
                        marginBottom: 0,
                        fontSize: 12,
                        color: 'rgba(0, 0, 0, 0.65)',
                        lineHeight: 1.4,
                      }}
                      ellipsis={{ rows: 2, expandable: false }}
                    >
                      {v}
                    </Paragraph>
                    {row.aggregated_count > 1 && (
                      <Tag
                        color="purple"
                        style={{ marginTop: 4, fontSize: 11 }}
                        data-testid={`risk-center-aggregated-count-${row.id}`}
                      >
                        重复 {row.aggregated_count} 次 (24h)
                      </Tag>
                    )}
                  </div>
                ),
              },
              {
                title: '时间',
                dataIndex: 'created_at',
                width: 130,
                render: (v: string) => (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {dayjs(v).format('MM-DD HH:mm')}
                  </Text>
                ),
              },
              {
                title: '状态',
                dataIndex: 'is_read',
                width: 60,
                render: (v: boolean) =>
                  v ? <Tag color="default">已读</Tag> : <Tag color="red">未读</Tag>,
              },
            ]}
          />
        </Space>
      </Card>
    </Space>
  );
};

// ---------------------------------------------------------------------------
// NestedAlertList — expandable row 展开后的子列表
// ---------------------------------------------------------------------------

/**
 * 同组内的所有 raw alert. 用紧凑列表展示 (id + 时间 + 完整 message), 不再折叠.
 * 与 [[AlertsPanel]] List.Item 同款 dense 风格.
 */
const NestedAlertList: React.FC<{ alerts: ReadonlyArray<RiskAlertItem> }> = ({ alerts }) => {
  if (!alerts || alerts.length === 0) {
    return <Text type="secondary">无更多明细</Text>;
  }
  return (
    <div
      style={{
        background: '#fafafa',
        padding: 12,
        borderRadius: 6,
        border: '1px solid #f0f0f0',
      }}
    >
      <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 8 }}>
        同组明细 ({alerts.length} 条)
      </Text>
      {alerts.map((a, idx) => (
        <div
          key={a.id}
          style={{
            display: 'flex',
            gap: 12,
            padding: '6px 0',
            borderTop: idx > 0 ? '1px dashed #e5e7eb' : 'none',
            fontSize: 12,
          }}
        >
          <Text type="secondary" style={{ width: 110, flexShrink: 0 }}>
            {dayjs(a.created_at).format('MM-DD HH:mm:ss')}
          </Text>
          <div style={{ flex: 1, color: 'rgba(0,0,0,0.72)' }}>{a.message}</div>
          {a.is_read ? (
            <Tag color="default" style={{ flexShrink: 0 }}>
              已读
            </Tag>
          ) : (
            <Tag color="red" style={{ flexShrink: 0 }}>
              未读
            </Tag>
          )}
        </div>
      ))}
    </div>
  );
};

export default RiskAlertCenterPanel;
