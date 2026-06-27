/**
 * SettingsWorkspace.BlackSwanHistoryTab — US-133 [PR-018]
 *
 * 黑天鹅事件历史 tab — 让 ops / 操盘手 review 历史黑天鹅 + 关联复盘 (postmortem) 报告.
 *
 * 2 个区域:
 *   1. **事件列表** — 分页 + 过滤 (event_type / severity / scope / status / symbol / 日期).
 *      每行 row click 弹详情抽屉.
 *   2. **事件详情 Drawer** — event 全字段 + postmortem 4 段 JSONB (可能 null = 待生成).
 *
 * 沿用 [[SettingsWorkspace.TodoSuggestionsTab]] 同款 "fetch + render + navigate" 思想:
 *   - 所有逻辑 (severity 颜色 / 文案 / cap / 排序 / 4 段完成度) 全在 [[blackSwanHistoryHelpers]]
 *     pure function, 本组件只 fetch + render;
 *   - 与 [[Codebase Patterns]] "UI 提示 + backend 独立执行" 二元结构对齐 — UI 只读, 任何
 *     "写"语义 (强 resolve / 调 severity) 走未来 PR;
 *   - 无 React Query / SWR — 用最简 useEffect + useState (项目其它 tab 同款), 用户 refresh
 *     按钮主动触发, 抽屉关闭不丢列表 state.
 *
 * 接入 SettingsWorkspace.tsx:
 *   - tabs[] 加 'black-swan' 一行;
 *   - headerActions 加 case (Tag US-133 PR-018);
 *   - render switch 加 case;
 *   不动 kpiSlot (KPI 由本 tab 内部顶部 Statistic 自管, 不挤主面板 KPI).
 *
 * 与 [[Codebase Patterns]] "fail-OPEN UI" 一脉相承:
 *   - 列表 fetch 失败 → setLoadError → 顶部 Alert + retry, 不阻塞 tab 切换;
 *   - 详情 fetch 失败 → 抽屉内 Alert + 关闭按钮, 主列表保留;
 *   - postmortem=null (PR-013 cron 还没跑) → 详情抽屉显示 "复盘报告待生成" placeholder,
 *     不报错.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Drawer,
  Empty,
  Input,
  Row,
  Select,
  Space,
  Spin,
  Statistic,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { AlertOutlined, ReloadOutlined, SearchOutlined, FileTextOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import {
  listBlackSwanEvents,
  getBlackSwanEvent,
  type BlackSwanEventRow,
  type BlackSwanPostmortemRow,
  type ListEventsFilters,
} from '../../services/blackSwanService';
import {
  BLACK_SWAN_DEFAULT_PAGE_LIMIT,
  BLACK_SWAN_EVENT_TYPES,
  computePostmortemSectionStatus,
  eventTypeLabel,
  scopeColor,
  scopeLabel,
  severityColor,
  severityLabel,
  statusColor,
  statusLabel,
  summarizeBlackSwanEvents,
  truncateText,
  BLACK_SWAN_TITLE_MAX_CHARS,
} from './blackSwanHistoryHelpers';

const { Text, Paragraph } = Typography;
const { Search } = Input;

const SEVERITY_OPTIONS = [
  { value: '', label: '全部' },
  { value: 'critical', label: '极端 critical' },
  { value: 'high', label: '高 high' },
  { value: 'medium', label: '中 medium' },
  { value: 'low', label: '低 low' },
];

const SCOPE_OPTIONS = [
  { value: '', label: '全部' },
  { value: 'symbol', label: '单股 symbol' },
  { value: 'sector', label: '行业 sector' },
  { value: 'market', label: '全市场 market' },
  { value: 'portfolio', label: '组合 portfolio' },
];

const STATUS_OPTIONS = [
  { value: '', label: '全部' },
  { value: 'open', label: '进行中 open' },
  { value: 'resolved', label: '已解决 resolved' },
  { value: 'expired', label: '已过期 expired' },
];

const EVENT_TYPE_OPTIONS = [
  { value: '', label: '全部' },
  ...BLACK_SWAN_EVENT_TYPES.map(t => ({ value: t, label: `${eventTypeLabel(t)} (${t})` })),
];

const BlackSwanHistoryTab: React.FC = () => {
  const [items, setItems] = useState<BlackSwanEventRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [limit] = useState(BLACK_SWAN_DEFAULT_PAGE_LIMIT);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [filterEventType, setFilterEventType] = useState<string>('');
  const [filterSeverity, setFilterSeverity] = useState<string>('');
  const [filterScope, setFilterScope] = useState<string>('');
  const [filterStatus, setFilterStatus] = useState<string>('');
  const [filterSymbol, setFilterSymbol] = useState<string>('');

  // 详情抽屉 state
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [drawerError, setDrawerError] = useState<string | null>(null);
  const [drawerEvent, setDrawerEvent] = useState<BlackSwanEventRow | null>(null);
  const [drawerPostmortem, setDrawerPostmortem] = useState<BlackSwanPostmortemRow | null>(null);

  const refresh = useCallback(
    async (overridePage?: number): Promise<void> => {
      setLoading(true);
      setLoadError(null);
      try {
        const filters: ListEventsFilters = {
          page: overridePage ?? page,
          limit,
        };
        if (filterEventType) filters.event_type = filterEventType as any;
        if (filterSeverity) filters.severity = filterSeverity as any;
        if (filterScope) filters.scope = filterScope as any;
        if (filterStatus) filters.status = filterStatus as any;
        if (filterSymbol) filters.symbol = filterSymbol;
        const result = await listBlackSwanEvents(filters);
        setItems(result.items || []);
        setTotal(result.total || 0);
        if (overridePage != null) setPage(overridePage);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : '加载黑天鹅事件列表失败');
      } finally {
        setLoading(false);
      }
    },
    [page, limit, filterEventType, filterSeverity, filterScope, filterStatus, filterSymbol]
  );

  useEffect(() => {
    void refresh(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const summary = useMemo(() => summarizeBlackSwanEvents(items), [items]);

  const openDrawer = useCallback(async (row: BlackSwanEventRow) => {
    setDrawerOpen(true);
    setDrawerLoading(true);
    setDrawerError(null);
    setDrawerEvent(null);
    setDrawerPostmortem(null);
    try {
      const detail = await getBlackSwanEvent(row.id);
      setDrawerEvent(detail.event);
      setDrawerPostmortem(detail.postmortem);
    } catch (err) {
      setDrawerError(err instanceof Error ? err.message : '加载事件详情失败');
    } finally {
      setDrawerLoading(false);
    }
  }, []);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    setDrawerEvent(null);
    setDrawerPostmortem(null);
    setDrawerError(null);
  }, []);

  const handleApplyFilters = useCallback(() => {
    void refresh(1);
  }, [refresh]);

  const handleResetFilters = useCallback(() => {
    setFilterEventType('');
    setFilterSeverity('');
    setFilterScope('');
    setFilterStatus('');
    setFilterSymbol('');
    // 重置后立即刷新 — useEffect 依赖项变化也会触发, 但显式调避免一帧延迟
    setTimeout(() => void refresh(1), 0);
  }, [refresh]);

  const columns: ColumnsType<BlackSwanEventRow> = [
    {
      title: '检测时间',
      dataIndex: 'detected_at',
      width: 170,
      render: (v: string) => (v ? new Date(v).toLocaleString('zh-CN') : '—'),
    },
    {
      title: '类型',
      dataIndex: 'event_type',
      width: 140,
      render: (v: string) => <Tag>{eventTypeLabel(v)}</Tag>,
    },
    {
      title: '严重度',
      dataIndex: 'severity',
      width: 100,
      render: (v: string) => <Tag color={severityColor(v)}>{severityLabel(v)}</Tag>,
    },
    {
      title: '影响面',
      dataIndex: 'scope',
      width: 110,
      render: (v: string) => <Tag color={scopeColor(v)}>{scopeLabel(v)}</Tag>,
    },
    {
      title: '代码',
      dataIndex: 'symbol',
      width: 110,
      render: (v: string | null) => v || '—',
    },
    {
      title: '标题',
      dataIndex: 'title',
      ellipsis: true,
      render: (v: string) => truncateText(v, BLACK_SWAN_TITLE_MAX_CHARS),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 110,
      render: (v: string) => <Tag color={statusColor(v)}>{statusLabel(v)}</Tag>,
    },
    {
      title: '操作',
      width: 90,
      align: 'center' as const,
      render: (_: unknown, row: BlackSwanEventRow) => (
        <Button type="link" size="small" onClick={() => void openDrawer(row)}>
          详情
        </Button>
      ),
    },
  ];

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="黑天鹅事件历史"
        description={
          <Space direction="vertical" size={4}>
            <Text>
              全市场黑天鹅事件 (ST / 停牌 / 重大利空新闻 / 大股东减持 / 大盘极端) 的检测历史 +
              复盘报告. 数据由 PR-011 BlackSwanDetector cron 每 30 分钟巡检自动落表,
              PR-013/014/015/016 异步生成 4 段复盘报告.
            </Text>
            <Text type="secondary">
              本页只读 — 任何&quot;手动 resolve / 调 severity&quot; 类操作走后续 PR.
              想看&quot;自己持仓的黑天鹅告警&quot;请打开顶部 AlertsBell.
            </Text>
          </Space>
        }
      />

      {/* 顶部 KPI bar */}
      <Row gutter={16}>
        <Col span={4}>
          <Statistic title="总数 (当前页)" value={summary.total} />
        </Col>
        <Col span={4}>
          <Statistic title="极端" value={summary.critical} valueStyle={{ color: '#dc2626' }} />
        </Col>
        <Col span={4}>
          <Statistic title="高" value={summary.high} valueStyle={{ color: '#fa541c' }} />
        </Col>
        <Col span={4}>
          <Statistic title="中" value={summary.medium} valueStyle={{ color: '#faad14' }} />
        </Col>
        <Col span={4}>
          <Statistic title="低" value={summary.low} />
        </Col>
        <Col span={4}>
          <Statistic title="总记录数" value={total} />
        </Col>
      </Row>

      {/* 过滤栏 */}
      <Card size="small" data-testid="black-swan-filters">
        <Space size={12} wrap>
          <Select
            value={filterEventType}
            onChange={setFilterEventType}
            style={{ width: 200 }}
            options={EVENT_TYPE_OPTIONS}
            placeholder="事件类型"
            data-testid="black-swan-filter-event-type"
          />
          <Select
            value={filterSeverity}
            onChange={setFilterSeverity}
            style={{ width: 160 }}
            options={SEVERITY_OPTIONS}
            placeholder="严重度"
            data-testid="black-swan-filter-severity"
          />
          <Select
            value={filterScope}
            onChange={setFilterScope}
            style={{ width: 160 }}
            options={SCOPE_OPTIONS}
            placeholder="影响面"
            data-testid="black-swan-filter-scope"
          />
          <Select
            value={filterStatus}
            onChange={setFilterStatus}
            style={{ width: 160 }}
            options={STATUS_OPTIONS}
            placeholder="状态"
            data-testid="black-swan-filter-status"
          />
          <Search
            placeholder="代码模糊匹配"
            value={filterSymbol}
            onChange={e => setFilterSymbol(e.target.value)}
            onSearch={handleApplyFilters}
            style={{ width: 180 }}
            enterButton={<SearchOutlined />}
            data-testid="black-swan-filter-symbol"
          />
          <Button type="primary" onClick={handleApplyFilters} loading={loading}>
            应用过滤
          </Button>
          <Button onClick={handleResetFilters} icon={<ReloadOutlined />}>
            重置
          </Button>
        </Space>
      </Card>

      {/* 列表 / 错误 / 加载 */}
      {loadError ? (
        <Alert
          type="error"
          message="加载失败"
          description={loadError}
          showIcon
          action={
            <Button size="small" onClick={() => void refresh()}>
              重试
            </Button>
          }
        />
      ) : (
        <Card
          title={
            <Space>
              <AlertOutlined />
              <span>事件列表</span>
            </Space>
          }
          data-testid="black-swan-event-list"
        >
          <Table<BlackSwanEventRow>
            rowKey="id"
            dataSource={items}
            columns={columns}
            loading={loading}
            size="small"
            pagination={{
              current: page,
              total,
              pageSize: limit,
              showSizeChanger: false,
              showTotal: t => `共 ${t} 条`,
              onChange: nextPage => void refresh(nextPage),
            }}
            locale={{
              emptyText: loading ? <Spin tip="加载中…" /> : <Empty description="暂无黑天鹅事件" />,
            }}
            onRow={row => ({
              onClick: () => void openDrawer(row),
              style: { cursor: 'pointer' },
            })}
          />
        </Card>
      )}

      {/* 详情抽屉 */}
      <BlackSwanEventDetailDrawer
        open={drawerOpen}
        loading={drawerLoading}
        error={drawerError}
        event={drawerEvent}
        postmortem={drawerPostmortem}
        onClose={closeDrawer}
      />
    </Space>
  );
};

// ---------------------------------------------------------------------------
// 详情抽屉子组件
// ---------------------------------------------------------------------------

interface BlackSwanEventDetailDrawerProps {
  open: boolean;
  loading: boolean;
  error: string | null;
  event: BlackSwanEventRow | null;
  postmortem: BlackSwanPostmortemRow | null;
  onClose: () => void;
}

const BlackSwanEventDetailDrawer: React.FC<BlackSwanEventDetailDrawerProps> = ({
  open,
  loading,
  error,
  event,
  postmortem,
  onClose,
}) => {
  const sectionStatus = useMemo(() => computePostmortemSectionStatus(postmortem), [postmortem]);

  return (
    <Drawer
      title={
        <Space>
          <AlertOutlined />
          <span>黑天鹅事件详情 {event ? `#${event.id}` : ''}</span>
          {postmortem && (
            <Tag color="blue">
              复盘 {sectionStatus.filled}/{sectionStatus.total} 段
            </Tag>
          )}
        </Space>
      }
      open={open}
      onClose={onClose}
      width={720}
      data-testid="black-swan-event-detail-drawer"
    >
      {loading ? (
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Spin tip="加载详情…" />
        </div>
      ) : error ? (
        <Alert type="error" message="加载失败" description={error} showIcon />
      ) : event ? (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {/* 事件 hero */}
          <Card size="small">
            <Descriptions column={2} size="small" bordered>
              <Descriptions.Item label="类型">{eventTypeLabel(event.event_type)}</Descriptions.Item>
              <Descriptions.Item label="严重度">
                <Tag color={severityColor(event.severity)}>{severityLabel(event.severity)}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="影响面">
                <Tag color={scopeColor(event.scope)}>{scopeLabel(event.scope)}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="状态">
                <Tag color={statusColor(event.status)}>{statusLabel(event.status)}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="代码">{event.symbol || '—'}</Descriptions.Item>
              <Descriptions.Item label="来源">{event.source || '—'}</Descriptions.Item>
              <Descriptions.Item label="检测时间" span={2}>
                {event.detected_at ? new Date(event.detected_at).toLocaleString('zh-CN') : '—'}
              </Descriptions.Item>
              {event.resolved_at && (
                <Descriptions.Item label="解决时间" span={2}>
                  {new Date(event.resolved_at).toLocaleString('zh-CN')}
                  {event.resolved_reason ? ` — ${event.resolved_reason}` : ''}
                </Descriptions.Item>
              )}
              <Descriptions.Item label="标题" span={2}>
                {event.title || '—'}
              </Descriptions.Item>
              <Descriptions.Item label="签名" span={2}>
                <Text code copyable>
                  {event.signature || '—'}
                </Text>
              </Descriptions.Item>
            </Descriptions>
            {event.description && (
              <Paragraph style={{ marginTop: 12, color: '#475569' }}>{event.description}</Paragraph>
            )}
          </Card>

          {/* detail / scope_detail / metadata JSONB */}
          <Card size="small" title="事件 detail (JSONB)">
            <pre
              style={{
                fontSize: 12,
                maxHeight: 200,
                overflow: 'auto',
                background: '#f6f8fa',
                padding: 8,
                borderRadius: 8,
              }}
            >
              {JSON.stringify(event.detail || {}, null, 2)}
            </pre>
          </Card>

          {/* postmortem 4 段 */}
          <Card
            size="small"
            title={
              <Space>
                <FileTextOutlined />
                <span>复盘报告 (Postmortem)</span>
                {postmortem ? (
                  <Tag color="success">
                    已生成 {sectionStatus.filled}/{sectionStatus.total} 段
                  </Tag>
                ) : (
                  <Tag color="warning">待生成</Tag>
                )}
              </Space>
            }
          >
            {postmortem ? (
              <Tabs
                items={[
                  {
                    key: 'event_summary',
                    label: `事件总结 ${sectionStatus.event_summary ? '✓' : '○'}`,
                    children: (
                      <PostmortemSectionView
                        section={postmortem.event_summary}
                        emptyHint="event_summary 段待生成 (PR-013 主入口)"
                      />
                    ),
                  },
                  {
                    key: 'counterfactual_baselines',
                    label: `Counterfactual ${sectionStatus.counterfactual_baselines ? '✓' : '○'}`,
                    children: (
                      <PostmortemSectionView
                        section={postmortem.counterfactual_baselines}
                        emptyHint="counterfactual_baselines 段待生成 (PR-014)"
                      />
                    ),
                  },
                  {
                    key: 'event_timeline',
                    label: `时间轴 ${sectionStatus.event_timeline ? '✓' : '○'}`,
                    children: (
                      <PostmortemSectionView
                        section={postmortem.event_timeline}
                        emptyHint="event_timeline 段待生成 (PR-015)"
                      />
                    ),
                  },
                  {
                    key: 'improvement_suggestions',
                    label: `改进建议 ${sectionStatus.improvement_suggestions ? '✓' : '○'}`,
                    children: (
                      <PostmortemSectionView
                        section={postmortem.improvement_suggestions}
                        emptyHint="improvement_suggestions 段待生成 (PR-016)"
                      />
                    ),
                  },
                ]}
              />
            ) : (
              <Empty
                description={
                  <Space direction="vertical" size={2}>
                    <Text>复盘报告尚未生成</Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      PR-013 BlackSwanPostmortemService 每 30min 自动生成. 新事件可能需要等待 下次
                      cron 触发.
                    </Text>
                  </Space>
                }
              />
            )}
          </Card>
        </Space>
      ) : (
        <Empty description="无事件数据" />
      )}
    </Drawer>
  );
};

interface PostmortemSectionViewProps {
  section: Record<string, unknown> | null | undefined;
  emptyHint: string;
}

const PostmortemSectionView: React.FC<PostmortemSectionViewProps> = ({ section, emptyHint }) => {
  if (!section || (typeof section === 'object' && Object.keys(section).length === 0)) {
    return <Empty description={emptyHint} />;
  }
  return (
    <pre
      style={{
        fontSize: 12,
        maxHeight: 360,
        overflow: 'auto',
        background: '#f6f8fa',
        padding: 8,
        borderRadius: 8,
      }}
    >
      {JSON.stringify(section, null, 2)}
    </pre>
  );
};

export default BlackSwanHistoryTab;
