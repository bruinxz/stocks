import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  List,
  Modal,
  Popconfirm,
  Row,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import {
  AlertOutlined,
  BellOutlined,
  CheckCircleOutlined,
  FireOutlined,
  FundOutlined,
  ReloadOutlined,
  RiseOutlined,
  RobotOutlined,
  ThunderboltOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import WorkspaceLayout, { WorkspaceTab } from '../../components/layout/WorkspaceLayout';
import AIStockAnalysisModal from '../../components/trading/AIStockAnalysisModal';
import {
  todayWorkspaceService,
  TodaySignalsData,
  ApplySignalsData,
  MultiFactorAlphaSignal,
  DragonHeadSignal,
  EarningsSurpriseSignal,
  KeyEventItem,
  UnreadRiskAlertItem,
} from '../../services/todayWorkspaceService';

const { Text, Paragraph } = Typography;

/**
 * 今日作战 (Today Workspace) — US-018 完整实现。
 *
 * 布局：
 *   - 顶部 KPI 条：账户余额 / 昨日盈亏 / 当月收益 / 未读风险提醒数
 *     右上角 "一键应用全部信号到模拟盘" 按钮
 *   - 中部 3 列：MultiFactorAlpha 调仓 / DragonHead 候选 / EarningsSurprise 入选
 *   - 底部 2 列：今日关键事件（业绩预告 + 高连板涨停） / 风险告警未读列表
 *
 * 数据装载：mount 时调一次 GET /api/today/signals，全部数据放在一个 `data`
 * state 里；refresh 按钮重新拉取；一键应用按钮成功后跳转到 /workspace/portfolio。
 */

const TodayWorkspace: React.FC = () => {
  const navigate = useNavigate();
  const tabs: WorkspaceTab[] = [
    { key: 'signals', label: '今日信号', icon: <ThunderboltOutlined /> },
    { key: 'events', label: '关键事件', icon: <BellOutlined /> },
    { key: 'alerts', label: '风险提醒', icon: <AlertOutlined /> },
  ];
  const [activeKey, setActiveKey] = useState('signals');

  const [data, setData] = useState<TodaySignalsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<ApplySignalsData | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await todayWorkspaceService.getTodaySignals();
      setData(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setLoadError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // ----- 顶部 KPI -----
  const kpiSlot = useMemo(() => {
    const account = data?.account;
    const totalValue = account?.total_value ?? 0;
    const pnlYesterday = account?.pnl_yesterday ?? null;
    const pnlMonth = account?.pnl_month_to_date ?? null;
    const unreadCount = data?.unread_alert_count ?? 0;
    return (
      <Space size={32}>
        <Statistic
          title="账户净值"
          value={totalValue}
          precision={2}
          prefix="¥"
          valueStyle={{ color: '#1677ff' }}
        />
        <Statistic
          title="昨日盈亏"
          value={pnlYesterday ?? 0}
          precision={2}
          prefix={pnlYesterday != null ? '¥' : ''}
          suffix={pnlYesterday == null ? ' —' : ''}
          valueStyle={{ color: pnlColor(pnlYesterday) }}
        />
        <Statistic
          title="当月收益"
          value={pnlMonth ?? 0}
          precision={2}
          prefix={pnlMonth != null ? '¥' : ''}
          suffix={pnlMonth == null ? ' —' : ''}
          valueStyle={{ color: pnlColor(pnlMonth) }}
        />
        <Statistic
          title="未读风险"
          value={unreadCount}
          suffix="条"
          valueStyle={{ color: unreadCount > 0 ? '#cf1322' : '#52c41a' }}
        />
      </Space>
    );
  }, [data]);

  // ----- 一键应用全部信号 -----
  const totalBuyCount = useMemo(() => {
    if (!data) return 0;
    const mfa = data.multi_factor.signals.filter(s => s.signal === 'buy').length;
    const dh = data.dragon_head.candidates.filter(s => s.signal === 'buy').length;
    const ev = data.earnings_surprise.candidates.filter(s => s.signal === 'buy').length;
    return mfa + dh + ev;
  }, [data]);

  const handleApplyAll = useCallback(async () => {
    if (!data || totalBuyCount === 0) {
      message.info('当前没有可下单的 BUY 信号');
      return;
    }
    setApplying(true);
    try {
      const result = await todayWorkspaceService.applyTodaySignals({
        trade_date: data.trade_date ?? undefined,
      });
      setApplyResult(result);
      message.success(
        `下单完成：成功 ${result.placed} 条，跳过 ${result.skipped} 条 — 即将跳转持仓页`
      );
      // 2 秒后跳转持仓页（给用户时间看到 modal）
      setTimeout(() => {
        navigate('/workspace/portfolio');
      }, 1800);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      message.error(`一键应用失败：${msg}`);
    } finally {
      setApplying(false);
    }
  }, [data, totalBuyCount, navigate]);

  const headerActions = (
    <Space>
      <Button icon={<ReloadOutlined />} onClick={() => void refresh()} loading={loading}>
        刷新
      </Button>
      <Popconfirm
        title="一键应用全部信号到模拟盘"
        description={`将下单 ${totalBuyCount} 条 BUY 信号（每笔 5000 元，已持有跳过），下单后跳转持仓页`}
        okText="确认下单"
        cancelText="取消"
        disabled={!data || totalBuyCount === 0 || applying}
        onConfirm={handleApplyAll}
      >
        <Button
          type="primary"
          icon={<CheckCircleOutlined />}
          loading={applying}
          disabled={!data || totalBuyCount === 0}
        >
          一键应用全部信号 ({totalBuyCount})
        </Button>
      </Popconfirm>
    </Space>
  );

  // ----- body -----
  let body: React.ReactNode = null;
  if (loading && !data) {
    body = (
      <Card>
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Spin tip="加载今日作战信号..." />
        </div>
      </Card>
    );
  } else if (loadError) {
    body = (
      <Card>
        <Alert
          message="加载失败"
          description={loadError}
          type="error"
          showIcon
          action={
            <Button size="small" onClick={() => void refresh()}>
              重试
            </Button>
          }
        />
      </Card>
    );
  } else if (!data) {
    body = (
      <Card>
        <Empty description="暂无数据" />
      </Card>
    );
  } else if (activeKey === 'signals') {
    body = <SignalsPanel data={data} />;
  } else if (activeKey === 'events') {
    body = <EventsPanel events={data.key_events} tradeDate={data.trade_date} />;
  } else if (activeKey === 'alerts') {
    body = (
      <AlertsPanel alerts={data.unread_alerts} totalCount={data.unread_alert_count} />
    );
  }

  const subtitle = data?.trade_date
    ? `开盘前一目了然 · 信号 as-of ${data.trade_date}`
    : '开盘前一目了然：多策略当日信号、关键事件与风险提醒。';

  return (
    <>
      <WorkspaceLayout
        title="今日作战"
        subtitle={subtitle}
        tabs={tabs}
        activeKey={activeKey}
        onTabChange={setActiveKey}
        kpiSlot={kpiSlot}
        headerActions={headerActions}
      >
        {body}
      </WorkspaceLayout>
      <ApplyResultModal
        result={applyResult}
        onClose={() => setApplyResult(null)}
        onGotoPortfolio={() => {
          setApplyResult(null);
          navigate('/workspace/portfolio');
        }}
      />
    </>
  );
};

// ---------------------------------------------------------------------------
// SignalsPanel — 中部 3 列卡片 + 底部 2 列（事件 + 告警预览）
// ---------------------------------------------------------------------------

const SignalsPanel: React.FC<{ data: TodaySignalsData }> = ({ data }) => {
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={8}>
          <MultiFactorCard
            tradeDate={data.multi_factor.trade_date}
            signals={data.multi_factor.signals}
            newPicks={data.multi_factor.new_picks}
            drops={data.multi_factor.drops}
            keeps={data.multi_factor.keeps}
            error={data.multi_factor.error}
          />
        </Col>
        <Col xs={24} lg={8}>
          <DragonHeadCard
            tradeDate={data.dragon_head.trade_date}
            candidates={data.dragon_head.candidates}
            eligibleCount={data.dragon_head.eligible_count}
            error={data.dragon_head.error}
          />
        </Col>
        <Col xs={24} lg={8}>
          <EarningsSurpriseCard
            tradeDate={data.earnings_surprise.trade_date}
            candidates={data.earnings_surprise.candidates}
            forecastPoolSize={data.earnings_surprise.forecast_pool_size}
            eligibleCount={data.earnings_surprise.eligible_count}
            error={data.earnings_surprise.error}
          />
        </Col>
      </Row>
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card
            size="small"
            title={
              <Space>
                <FireOutlined style={{ color: '#fa541c' }} />
                <span>今日关键事件</span>
                <Tag color="orange">{data.key_events.length}</Tag>
              </Space>
            }
          >
            <KeyEventsList events={data.key_events.slice(0, 8)} compact />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card
            size="small"
            title={
              <Space>
                <AlertOutlined style={{ color: '#f5222d' }} />
                <span>风险告警 · 未读</span>
                <Tag color="red">{data.unread_alert_count}</Tag>
              </Space>
            }
          >
            <RiskAlertsList alerts={data.unread_alerts.slice(0, 8)} compact />
          </Card>
        </Col>
      </Row>
    </Space>
  );
};

// ---------------------------------------------------------------------------
// 3 个策略卡片
// ---------------------------------------------------------------------------

const MultiFactorCard: React.FC<{
  tradeDate: string | null;
  signals: MultiFactorAlphaSignal[];
  newPicks: number;
  drops: number;
  keeps: number;
  error?: string;
}> = ({ tradeDate, signals, newPicks, drops, keeps, error }) => {
  const [aiTarget, setAiTarget] = useState<{ symbol: string; name: string | null } | null>(null);
  const buys = signals.filter(s => s.signal === 'buy').slice(0, 8);
  const sells = signals.filter(s => s.signal === 'sell').slice(0, 4);
  return (
    <Card
      size="small"
      title={
        <Space>
          <FundOutlined style={{ color: '#1677ff' }} />
          <span>多因子 Alpha 调仓</span>
          {tradeDate && <Tag color="blue">{tradeDate}</Tag>}
        </Space>
      }
    >
      {error ? (
        <Alert type="warning" message={error} showIcon />
      ) : (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Space size={24}>
            <Statistic
              title="新进入选"
              value={newPicks}
              valueStyle={{ color: '#cf1322', fontSize: 18 }}
            />
            <Statistic
              title="保留"
              value={keeps}
              valueStyle={{ color: '#1677ff', fontSize: 18 }}
            />
            <Statistic title="剔除" value={drops} valueStyle={{ color: '#999', fontSize: 18 }} />
          </Space>
          {buys.length > 0 && (
            <>
              <Text strong style={{ fontSize: 12 }}>
                新进入选 (top {buys.length})
              </Text>
              <Table
                size="small"
                rowKey="stock_code"
                dataSource={buys}
                pagination={false}
                columns={[
                  {
                    title: '代码',
                    dataIndex: 'stock_code',
                    width: 80,
                    render: (v: string) => <Text code>{v}</Text>,
                  },
                  {
                    title: '名称',
                    dataIndex: 'name',
                    ellipsis: true,
                    render: (v: string | null | undefined) => v ?? '—',
                  },
                  {
                    title: '行业',
                    dataIndex: 'industry',
                    width: 80,
                    ellipsis: true,
                    render: (v: string | null | undefined) =>
                      v ? <Tag color="geekblue">{v}</Tag> : '—',
                  },
                  {
                    title: '总分',
                    dataIndex: 'composite_score',
                    width: 60,
                    align: 'right' as const,
                    render: (v: number) => <Text strong>{v?.toFixed(2)}</Text>,
                  },
                  {
                    title: 'AI',
                    key: 'ai',
                    width: 90,
                    render: (_: unknown, row: MultiFactorAlphaSignal) => (
                      <Button
                        size="small"
                        icon={<RobotOutlined />}
                        onClick={() =>
                          setAiTarget({
                            symbol: row.stock_code,
                            name: row.name || null,
                          })
                        }
                      >
                        AI 解读
                      </Button>
                    ),
                  },
                ]}
              />
            </>
          )}
          {sells.length > 0 && (
            <>
              <Text strong style={{ fontSize: 12 }}>
                剔除 ({drops} 只，展示前 {sells.length} 只)
              </Text>
              <List
                size="small"
                dataSource={sells}
                renderItem={item => (
                  <List.Item style={{ padding: '4px 0' }}>
                    <Space>
                      <Text code>{item.stock_code}</Text>
                      <Text type="secondary">{item.name ?? ''}</Text>
                    </Space>
                  </List.Item>
                )}
              />
            </>
          )}
          {buys.length === 0 && sells.length === 0 && (
            <Empty description="今日无调仓变动" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          )}
        </Space>
      )}
      {aiTarget && (
        <AIStockAnalysisModal
          open={!!aiTarget}
          onClose={() => setAiTarget(null)}
          stockCode={aiTarget.symbol}
          stockName={aiTarget.name}
          taskLabel="today_multifactor_pick"
        />
      )}
    </Card>
  );
};

const DragonHeadCard: React.FC<{
  tradeDate: string | null;
  candidates: DragonHeadSignal[];
  eligibleCount: number;
  error?: string;
}> = ({ tradeDate, candidates, eligibleCount, error }) => {
  return (
    <Card
      size="small"
      title={
        <Space>
          <RiseOutlined style={{ color: '#fa541c' }} />
          <span>短线龙头候选</span>
          {tradeDate && <Tag color="orange">{tradeDate}</Tag>}
        </Space>
      }
    >
      {error ? (
        <Alert type="warning" message={error} showIcon />
      ) : (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Space size={24}>
            <Statistic
              title="今日 BUY"
              value={candidates.length}
              valueStyle={{ color: '#cf1322', fontSize: 18 }}
            />
            <Statistic
              title="过滤前候选"
              value={eligibleCount}
              valueStyle={{ color: '#999', fontSize: 18 }}
            />
          </Space>
          {candidates.length === 0 ? (
            <Empty description="今日无符合条件的龙头候选" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          ) : (
            <Table
              size="small"
              rowKey="stock_code"
              dataSource={candidates}
              pagination={false}
              columns={[
                {
                  title: '代码',
                  dataIndex: 'stock_code',
                  width: 80,
                  render: (v: string) => <Text code>{v}</Text>,
                },
                {
                  title: '名称',
                  dataIndex: 'name',
                  ellipsis: true,
                  render: (v: string | null | undefined) => v ?? '—',
                },
                {
                  title: '连板',
                  dataIndex: 'continuous_days',
                  width: 56,
                  align: 'right' as const,
                  render: (v: number | undefined) =>
                    v != null ? <Tag color="red">{v}板</Tag> : '—',
                },
                {
                  title: '行业',
                  dataIndex: 'industry',
                  width: 80,
                  ellipsis: true,
                  render: (v: string | null | undefined) =>
                    v ? <Tag color="geekblue">{v}</Tag> : '—',
                },
              ]}
              expandable={{
                expandedRowRender: (row: DragonHeadSignal) => (
                  <Paragraph style={{ margin: 0, fontSize: 12 }} type="secondary">
                    {row.reason}
                  </Paragraph>
                ),
                rowExpandable: (row: DragonHeadSignal) => !!row.reason,
              }}
            />
          )}
        </Space>
      )}
    </Card>
  );
};

const EarningsSurpriseCard: React.FC<{
  tradeDate: string | null;
  candidates: EarningsSurpriseSignal[];
  forecastPoolSize: number;
  eligibleCount: number;
  error?: string;
}> = ({ tradeDate, candidates, forecastPoolSize, eligibleCount, error }) => {
  return (
    <Card
      size="small"
      title={
        <Space>
          <ThunderboltOutlined style={{ color: '#52c41a' }} />
          <span>业绩超预期入选</span>
          {tradeDate && <Tag color="green">{tradeDate}</Tag>}
        </Space>
      }
    >
      {error ? (
        <Alert type="warning" message={error} showIcon />
      ) : (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Space size={24}>
            <Statistic
              title="今日 BUY"
              value={candidates.length}
              valueStyle={{ color: '#cf1322', fontSize: 18 }}
            />
            <Statistic
              title="当日公告"
              value={forecastPoolSize}
              valueStyle={{ color: '#999', fontSize: 18 }}
            />
            <Statistic
              title="双确认通过"
              value={eligibleCount}
              valueStyle={{ color: '#1677ff', fontSize: 18 }}
            />
          </Space>
          {candidates.length === 0 ? (
            <Empty
              description="今日无通过双确认的业绩超预期入选"
              image={Empty.PRESENTED_IMAGE_SIMPLE}
            />
          ) : (
            <Table
              size="small"
              rowKey="stock_code"
              dataSource={candidates}
              pagination={false}
              columns={[
                {
                  title: '代码',
                  dataIndex: 'stock_code',
                  width: 80,
                  render: (v: string) => <Text code>{v}</Text>,
                },
                {
                  title: '名称',
                  dataIndex: 'name',
                  ellipsis: true,
                  render: (v: string | null | undefined) => v ?? '—',
                },
                {
                  title: '预告',
                  dataIndex: 'forecast_type',
                  width: 60,
                  render: (v: string | null | undefined) => v ?? '—',
                },
                {
                  title: '增幅',
                  dataIndex: 'profit_change_low',
                  width: 70,
                  align: 'right' as const,
                  render: (v: number | null | undefined) =>
                    v != null ? <Tag color="red">{`${Math.round(v)}%+`}</Tag> : '—',
                },
              ]}
              expandable={{
                expandedRowRender: (row: EarningsSurpriseSignal) => (
                  <Paragraph style={{ margin: 0, fontSize: 12 }} type="secondary">
                    {row.reason}
                  </Paragraph>
                ),
                rowExpandable: (row: EarningsSurpriseSignal) => !!row.reason,
              }}
            />
          )}
        </Space>
      )}
    </Card>
  );
};

// ---------------------------------------------------------------------------
// 关键事件 + 风险告警 panel/list
// ---------------------------------------------------------------------------

const EventsPanel: React.FC<{ events: KeyEventItem[]; tradeDate: string | null }> = ({
  events,
  tradeDate,
}) => {
  return (
    <Card
      size="small"
      title={
        <Space>
          <FireOutlined style={{ color: '#fa541c' }} />
          <span>今日关键事件{tradeDate ? ` · ${tradeDate}` : ''}</span>
        </Space>
      }
      extra={<Tag color="orange">{events.length}</Tag>}
    >
      <KeyEventsList events={events} />
    </Card>
  );
};

const KeyEventsList: React.FC<{ events: KeyEventItem[]; compact?: boolean }> = ({
  events,
  compact = false,
}) => {
  if (events.length === 0) {
    return <Empty description="今日无关键事件" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }
  return (
    <List
      size={compact ? 'small' : 'default'}
      dataSource={events}
      renderItem={item => (
        <List.Item style={{ padding: compact ? '6px 0' : '10px 0' }}>
          <Space align="start" style={{ width: '100%' }}>
            {eventTypeIcon(item.event_type)}
            <div style={{ flex: 1 }}>
              <Space>
                <Text code>{item.stock_code}</Text>
                <Text strong>{item.stock_name ?? '—'}</Text>
                {eventTypeTag(item.event_type)}
              </Space>
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {item.summary}
                </Text>
              </div>
            </div>
          </Space>
        </List.Item>
      )}
    />
  );
};

const AlertsPanel: React.FC<{ alerts: UnreadRiskAlertItem[]; totalCount: number }> = ({
  alerts,
  totalCount,
}) => {
  return (
    <Card
      size="small"
      title={
        <Space>
          <AlertOutlined style={{ color: '#f5222d' }} />
          <span>风险告警未读列表</span>
          <Tag color="red">{totalCount}</Tag>
        </Space>
      }
    >
      <RiskAlertsList alerts={alerts} />
    </Card>
  );
};

const RiskAlertsList: React.FC<{ alerts: UnreadRiskAlertItem[]; compact?: boolean }> = ({
  alerts,
  compact = false,
}) => {
  if (alerts.length === 0) {
    return <Empty description="暂无未读风险告警" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }
  return (
    <List
      size={compact ? 'small' : 'default'}
      dataSource={alerts}
      renderItem={item => (
        <List.Item style={{ padding: compact ? '6px 0' : '10px 0' }}>
          <Space align="start" style={{ width: '100%' }}>
            {levelIcon(item.level)}
            <div style={{ flex: 1 }}>
              <Space>
                <Text code>{item.symbol}</Text>
                <Text strong>{item.name}</Text>
                {levelTag(item.level)}
              </Space>
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {item.message}
                </Text>
              </div>
            </div>
          </Space>
        </List.Item>
      )}
    />
  );
};

// ---------------------------------------------------------------------------
// 下单结果 modal
// ---------------------------------------------------------------------------

const ApplyResultModal: React.FC<{
  result: ApplySignalsData | null;
  onClose: () => void;
  onGotoPortfolio: () => void;
}> = ({ result, onClose, onGotoPortfolio }) => {
  return (
    <Modal
      open={!!result}
      title="一键应用信号结果"
      onCancel={onClose}
      footer={[
        <Button key="close" onClick={onClose}>
          关闭
        </Button>,
        <Button key="goto" type="primary" onClick={onGotoPortfolio}>
          前往持仓页
        </Button>,
      ]}
      width={720}
    >
      {result && (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Space size={24}>
            <Statistic title="成功" value={result.placed} valueStyle={{ color: '#52c41a' }} />
            <Statistic title="跳过/失败" value={result.skipped} valueStyle={{ color: '#999' }} />
            <Statistic title="交易日" value={result.trade_date ?? '—'} />
          </Space>
          <Table
            size="small"
            rowKey={(r, idx) => `${r.symbol}-${idx}`}
            dataSource={result.orders}
            pagination={false}
            scroll={{ y: 320 }}
            columns={[
              {
                title: '策略',
                dataIndex: 'strategy',
                width: 110,
                render: (v: string) => strategyTag(v),
              },
              { title: '代码', dataIndex: 'symbol', width: 100 },
              { title: '名称', dataIndex: 'name', ellipsis: true },
              {
                title: '数量',
                dataIndex: 'quantity',
                width: 80,
                align: 'right' as const,
              },
              {
                title: '状态',
                dataIndex: 'status',
                width: 80,
                render: (v: string) => orderStatusTag(v),
              },
              { title: '原因', dataIndex: 'reason', ellipsis: true },
            ]}
          />
        </Space>
      )}
    </Modal>
  );
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function pnlColor(value: number | null): string {
  if (value == null || value === 0) return undefined as unknown as string;
  return value > 0 ? '#cf1322' : '#52c41a';
}

function eventTypeTag(t: KeyEventItem['event_type']): React.ReactNode {
  if (t === 'earnings_surprise') return <Tag color="red">超预期</Tag>;
  if (t === 'earnings_announcement') return <Tag color="blue">业绩</Tag>;
  return <Tag color="orange">连板</Tag>;
}

function eventTypeIcon(t: KeyEventItem['event_type']): React.ReactNode {
  if (t === 'earnings_surprise') return <ThunderboltOutlined style={{ color: '#f5222d' }} />;
  if (t === 'earnings_announcement') return <FundOutlined style={{ color: '#1677ff' }} />;
  return <RiseOutlined style={{ color: '#fa541c' }} />;
}

function levelTag(level: string): React.ReactNode {
  const upper = (level || '').toUpperCase();
  if (upper === 'HIGH') return <Tag color="red">高</Tag>;
  if (upper === 'MEDIUM') return <Tag color="orange">中</Tag>;
  if (upper === 'LOW') return <Tag color="blue">低</Tag>;
  return <Tag>{level}</Tag>;
}

function levelIcon(level: string): React.ReactNode {
  const upper = (level || '').toUpperCase();
  if (upper === 'HIGH') return <WarningOutlined style={{ color: '#f5222d' }} />;
  return <AlertOutlined style={{ color: '#fa8c16' }} />;
}

function strategyTag(strategy: string): React.ReactNode {
  if (strategy === 'multi_factor') return <Tag color="blue">多因子</Tag>;
  if (strategy === 'dragon_head') return <Tag color="orange">龙头</Tag>;
  if (strategy === 'earnings_surprise') return <Tag color="green">业绩超预期</Tag>;
  return <Tag>{strategy}</Tag>;
}

function orderStatusTag(status: string): React.ReactNode {
  if (status === 'placed') return <Tag color="green">成功</Tag>;
  if (status === 'skipped') return <Tag color="default">跳过</Tag>;
  return <Tag color="red">失败</Tag>;
}

export default TodayWorkspace;
