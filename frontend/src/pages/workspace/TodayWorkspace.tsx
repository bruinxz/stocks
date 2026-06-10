import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Empty,
  Input,
  List,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import type { TableRowSelection } from 'antd/es/table/interface';
import {
  AlertOutlined,
  BellOutlined,
  CheckCircleOutlined,
  FireOutlined,
  FundOutlined,
  ReloadOutlined,
  RiseOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import WorkspaceLayout, { WorkspaceTab } from '../../components/layout/WorkspaceLayout';
import AIStockAnalysisModal from '../../components/trading/AIStockAnalysisModal';
import { useIsMobile } from '../../hooks/useIsMobile';
import dayjs, { Dayjs } from 'dayjs';
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
import { getMarketBriefToday, MarketBriefResult } from '../../services/marketBriefService';
import {
  listRiskAlerts,
  markAlertsAsRead,
  markAllRiskAlertsRead,
  RiskAlertItem,
  RiskAlertListParams,
  AlertCategory,
  ALERT_CATEGORY_LABEL,
} from '../../services/riskAlertService';

const { Text, Paragraph } = Typography;
const { RangePicker } = DatePicker;

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
    { key: 'risk_center', label: '风控中心', icon: <SafetyCertificateOutlined /> },
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
  } else if (activeKey === 'risk_center') {
    body = <RiskAlertCenterPanel onUnreadCountChange={refresh} />;
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
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <MarketBriefCard />
          {body}
        </Space>
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
// MarketBriefCard (US-073) — 顶部 AI 大盘速读
// ---------------------------------------------------------------------------

/**
 * 「AI 大盘速读」开盘前一张卡片。
 *
 * 5 个数值 KPI + 1 句 AI 观点 ─ 全部数据由 GET /api/ai/market-brief/today 一次返回。
 * 后端 SchedulerService 每个交易日 08:30 cron 触发生成；首次访问 / cron miss
 * 时 controller 走 getTodayBrief 懒求值兜底。
 *
 * 状态语义：
 *   - ok            → 5 维齐全，淡蓝色 banner；
 *   - partial       → 部分维度缺失，黄色 banner；
 *   - failed        → 5 维全缺，红色 banner 但 AI heuristic 仍可显示「数据待补」。
 *
 * 容错：
 *   - getMarketBriefToday throw → 卡片内显示 Alert，刷新按钮重试，不影响下方信号面板；
 *   - components.<x>.error 单项失败 → KPI 渲染「—」，无 tooltip 噪音。
 */
const MarketBriefCard: React.FC = () => {
  const [brief, setBrief] = useState<MarketBriefResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadBrief = useCallback(async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const result = await getMarketBriefToday({ refresh });
      setBrief(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadBrief();
  }, [loadBrief]);

  const titleNode = (
    <Space size={8}>
      <RobotOutlined style={{ color: '#722ed1' }} />
      <span>AI 大盘速读</span>
      {brief?.trade_date && <Tag color="purple">{brief.trade_date}</Tag>}
      {brief?.status === 'partial' && <Tag color="orange">部分数据待补</Tag>}
      {brief?.status === 'failed' && <Tag color="red">数据全缺</Tag>}
      {brief?.nlp_engine && (
        <Tag color={brief.nlp_engine === 'trading_agents' ? 'blue' : 'default'}>
          {brief.nlp_engine === 'trading_agents' ? 'TradingAgents' : '启发式兜底'}
        </Tag>
      )}
    </Space>
  );

  const extra = (
    <Button
      size="small"
      icon={<ReloadOutlined />}
      loading={loading}
      onClick={() => void loadBrief(true)}
    >
      重新生成
    </Button>
  );

  if (loading && !brief) {
    return (
      <Card size="small" title={titleNode} extra={extra}>
        <div style={{ textAlign: 'center', padding: 24 }}>
          <Spin tip="加载 AI 大盘速读..." />
        </div>
      </Card>
    );
  }

  if (error && !brief) {
    return (
      <Card size="small" title={titleNode} extra={extra}>
        <Alert
          type="error"
          showIcon
          message="AI 大盘速读加载失败"
          description={error}
          action={
            <Button size="small" onClick={() => void loadBrief()}>
              重试
            </Button>
          }
        />
      </Card>
    );
  }

  if (!brief) {
    return (
      <Card size="small" title={titleNode} extra={extra}>
        <Empty description="暂无数据" />
      </Card>
    );
  }

  const benchmark = brief.components?.benchmark;
  const northbound = brief.components?.northbound;
  const limitUp = brief.components?.limit_up;
  const aiView = brief.ai_view || '今日观点暂无';

  return (
    <Card size="small" title={titleNode} extra={extra}>
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Row gutter={[24, 8]} align="middle">
          <Col xs={12} md={8} lg={5}>
            <Statistic
              title="上日收盘 (沪深300)"
              value={brief.prev_close ?? '—'}
              precision={brief.prev_close == null ? undefined : 2}
              valueStyle={{ fontSize: 18 }}
            />
          </Col>
          <Col xs={12} md={8} lg={5}>
            <Tooltip title={benchmark?.error || ''}>
              <Statistic
                title={
                  brief.open_change_pct != null
                    ? `今日开盘 (${brief.open_change_pct >= 0 ? '+' : ''}${brief.open_change_pct.toFixed(2)}%)`
                    : '今日开盘'
                }
                value={brief.today_open ?? '—'}
                precision={brief.today_open == null ? undefined : 2}
                valueStyle={{
                  fontSize: 18,
                  color: openChangeColor(brief.open_change_pct),
                }}
              />
            </Tooltip>
          </Col>
          <Col xs={12} md={8} lg={5}>
            <Tooltip title={northbound?.error || ''}>
              <Statistic
                title="昨日北向净买入"
                value={brief.northbound_net_amount ?? '—'}
                precision={brief.northbound_net_amount == null ? undefined : 2}
                suffix={brief.northbound_net_amount == null ? '' : ' 亿'}
                valueStyle={{
                  fontSize: 18,
                  color: northboundColor(brief.northbound_net_amount),
                }}
              />
            </Tooltip>
          </Col>
          <Col xs={12} md={8} lg={4}>
            <Tooltip title={limitUp?.error || ''}>
              <Statistic
                title="昨日涨停数"
                value={brief.limit_up_count ?? '—'}
                suffix={brief.limit_up_count == null ? '' : ' 家'}
                valueStyle={{
                  fontSize: 18,
                  color: limitUpColor(brief.limit_up_count),
                }}
              />
            </Tooltip>
          </Col>
          <Col xs={24} md={24} lg={5}>
            <div style={{ paddingLeft: 8, borderLeft: '3px solid #722ed1' }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                AI 一句话观点
              </Text>
              <Paragraph
                style={{
                  margin: '4px 0 0',
                  fontSize: 13,
                  lineHeight: 1.5,
                  color: '#262626',
                }}
              >
                {aiView}
              </Paragraph>
            </div>
          </Col>
        </Row>
        {brief.status !== 'ok' && (
          <Alert
            type={brief.status === 'failed' ? 'error' : 'warning'}
            showIcon
            message={brief.message}
            style={{ marginBottom: 0 }}
          />
        )}
      </Space>
    </Card>
  );
};

// ---------------------------------------------------------------------------
// SignalsPanel — 中部 3 列卡片 + 底部 2 列（事件 + 告警预览）
// ---------------------------------------------------------------------------

const SignalsPanel: React.FC<{ data: TodaySignalsData }> = ({ data }) => {
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Row gutter={[16, 16]}>
        <Col xs={24}>
          <MultiFactorCard
            tradeDate={data.multi_factor.trade_date}
            signals={data.multi_factor.signals}
            newPicks={data.multi_factor.new_picks}
            drops={data.multi_factor.drops}
            keeps={data.multi_factor.keeps}
            error={data.multi_factor.error}
          />
        </Col>
        <Col xs={24} lg={12}>
          <DragonHeadCard
            tradeDate={data.dragon_head.trade_date}
            candidates={data.dragon_head.candidates}
            eligibleCount={data.dragon_head.eligible_count}
            limitUpPoolSize={data.dragon_head.limit_up_pool_size}
            marketSentimentValue={data.dragon_head.market_sentiment_value}
            marketSentimentBlocked={data.dragon_head.market_sentiment_blocked}
            filterStats={data.dragon_head.filter_stats}
            error={data.dragon_head.error}
          />
        </Col>
        <Col xs={24} lg={12}>
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
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const [aiTarget, setAiTarget] = useState<{ symbol: string; name: string | null } | null>(null);
  const buys = signals.filter(s => s.signal === 'buy').slice(0, 30);
  const sells = signals.filter(s => s.signal === 'sell').slice(0, 10);
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
              {isMobile ? (
                <div className="workspace-mobile-card-list">
                  {buys.map(row => (
                    <Card key={row.stock_code} size="small">
                      <Space direction="vertical" size={2} style={{ width: '100%' }}>
                        <Space size={8}>
                          <Text strong style={{ fontSize: 14 }}>
                            {row.name ?? row.stock_code}
                          </Text>
                          <Text code style={{ fontSize: 11 }}>
                            {row.stock_code}
                          </Text>
                          {row.industry && <Tag color="geekblue">{row.industry}</Tag>}
                        </Space>
                        <div className="workspace-mobile-card-row">
                          <span className="label">总分</span>
                          <span className="value">
                            <Text strong>{row.composite_score?.toFixed(2)}</Text>
                          </span>
                        </div>
                        <div className="workspace-mobile-card-actions">
                          <Button
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
                        </div>
                      </Space>
                    </Card>
                  ))}
                </div>
              ) : (
                <Table
                  size="small"
                  rowKey="stock_code"
                  dataSource={buys}
                  pagination={false}
                  scroll={{ x: 'max-content' }}
                  columns={[
                    {
                      title: '代码',
                      dataIndex: 'stock_code',
                      width: 92,
                      render: (v: string) => (
                        <a onClick={() => navigate(`/stock/${v}`)}>
                          <Text code>{v}</Text>
                        </a>
                      ),
                    },
                    {
                      title: '名称',
                      dataIndex: 'name',
                      width: 110,
                      render: (v: string | null | undefined, row: MultiFactorAlphaSignal) =>
                        v ? <a onClick={() => navigate(`/stock/${row.stock_code}`)}>{v}</a> : '—',
                    },
                    {
                      title: '行业',
                      dataIndex: 'industry',
                      width: 110,
                      render: (v: string | null | undefined) =>
                        v ? <Tag color="geekblue">{v}</Tag> : '—',
                    },
                    {
                      title: '综合分',
                      dataIndex: 'composite_score',
                      width: 78,
                      align: 'right' as const,
                      sorter: (a: MultiFactorAlphaSignal, b: MultiFactorAlphaSignal) =>
                        (a.composite_score ?? 0) - (b.composite_score ?? 0),
                      render: (v: number) => (
                        <Text strong style={{ color: '#cf1322' }}>{v?.toFixed(3)}</Text>
                      ),
                    },
                    {
                      title: '主要因子',
                      key: 'top_factors',
                      width: 220,
                      render: (_: unknown, row: MultiFactorAlphaSignal) => {
                        const zs = row.factor_z_scores || {};
                        const sorted = Object.entries(zs)
                          .filter(([_k, v]) => typeof v === 'number' && Math.abs(v as number) > 0.5)
                          .sort((a, b) => Math.abs(b[1] as number) - Math.abs(a[1] as number))
                          .slice(0, 3);
                        if (!sorted.length) return <Text type="secondary">—</Text>;
                        return (
                          <Space size={4} wrap>
                            {sorted.map(([k, v]) => (
                              <Tag
                                key={k}
                                color={(v as number) > 0 ? 'red' : 'green'}
                              >
                                {k}: {(v as number).toFixed(2)}
                              </Tag>
                            ))}
                          </Space>
                        );
                      },
                    },
                    {
                      title: '操作',
                      key: 'actions',
                      width: 160,
                      fixed: 'right' as const,
                      render: (_: unknown, row: MultiFactorAlphaSignal) => (
                        <Space size={4}>
                          <Button
                            size="small"
                            type="link"
                            onClick={() => navigate(`/stock/${row.stock_code}`)}
                          >
                            趋势
                          </Button>
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
                            AI
                          </Button>
                        </Space>
                      ),
                    },
                  ]}
                />
              )}
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
  limitUpPoolSize?: number;
  marketSentimentValue?: number | null;
  marketSentimentBlocked?: boolean;
  filterStats?: Record<string, number>;
  error?: string;
}> = ({ tradeDate, candidates, eligibleCount, limitUpPoolSize, marketSentimentValue, marketSentimentBlocked, filterStats, error }) => {
  const isMobile = useIsMobile();
  // 自动诊断 0 候选原因
  const diagnosisReason = useMemo(() => {
    if (candidates.length > 0) return null;
    if (marketSentimentBlocked) {
      return `市场情绪指数 ${marketSentimentValue?.toFixed(1)} 低于阈值，已暂停新开仓。已有持仓正常出场。`;
    }
    if (limitUpPoolSize === 0) {
      return `当日无涨停股。等待今日盘后龙虎榜 + 涨停板数据同步。`;
    }
    if (filterStats) {
      const topFail = Object.entries(filterStats)
        .filter(([, v]) => v > 0)
        .sort((a, b) => b[1] - a[1])[0];
      if (topFail) {
        const labelMap: Record<string, string> = {
          fail_industry_top: '行业不在 top10',
          fail_industry_unknown: '股票行业未知',
          fail_continuous_days: '连板数超范围',
          fail_meta_missing: '缺市值数据',
          fail_market_cap: '市值不在 30-200 亿',
          fail_famous_yz: '无游资席位净流入',
          one_word_board: '一字板（无法参与）',
          sentiment_blocked: '市场情绪低被阻塞',
        };
        return `涨停池 ${limitUpPoolSize} 股，全部被过滤。主要原因: ${labelMap[topFail[0]] || topFail[0]}（${topFail[1]} 只）`;
      }
    }
    return null;
  }, [candidates.length, limitUpPoolSize, marketSentimentBlocked, marketSentimentValue, filterStats]);

  return (
    <Card
      size="small"
      title={
        <Space>
          <RiseOutlined style={{ color: '#fa541c' }} />
          <span>短线龙头候选</span>
          {tradeDate && <Tag color="orange">{tradeDate}</Tag>}
          {marketSentimentValue != null && (
            <Tooltip title={`市场情绪 ${marketSentimentValue.toFixed(1)} / 阈值 30`}>
              <Tag color={marketSentimentBlocked ? 'red' : 'green'}>
                情绪 {marketSentimentValue.toFixed(1)}
              </Tag>
            </Tooltip>
          )}
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
              title="涨停池"
              value={limitUpPoolSize ?? 0}
              suffix="只"
              valueStyle={{ color: '#999', fontSize: 18 }}
            />
            <Statistic
              title="通过 5 维"
              value={eligibleCount}
              valueStyle={{ color: '#999', fontSize: 18 }}
            />
          </Space>
          {diagnosisReason && (
            <Alert
              type={marketSentimentBlocked ? 'info' : 'warning'}
              message={diagnosisReason}
              showIcon
              style={{ fontSize: 12 }}
            />
          )}
          {candidates.length === 0 ? (
            <Empty description="今日无符合条件的龙头候选" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          ) : isMobile ? (
            <div className="workspace-mobile-card-list">
              {candidates.map(row => (
                <Card key={row.stock_code} size="small">
                  <Space direction="vertical" size={2} style={{ width: '100%' }}>
                    <Space size={8}>
                      <Text strong style={{ fontSize: 14 }}>
                        {row.name ?? row.stock_code}
                      </Text>
                      <Text code style={{ fontSize: 11 }}>
                        {row.stock_code}
                      </Text>
                      {row.continuous_days != null && (
                        <Tag color="red">{row.continuous_days}板</Tag>
                      )}
                      {row.industry && <Tag color="geekblue">{row.industry}</Tag>}
                    </Space>
                    {row.reason && (
                      <Paragraph
                        style={{ margin: '4px 0 0 0', fontSize: 12 }}
                        type="secondary"
                      >
                        {row.reason}
                      </Paragraph>
                    )}
                  </Space>
                </Card>
              ))}
            </div>
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
  const isMobile = useIsMobile();
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
          ) : isMobile ? (
            <div className="workspace-mobile-card-list">
              {candidates.map(row => (
                <Card key={row.stock_code} size="small">
                  <Space direction="vertical" size={2} style={{ width: '100%' }}>
                    <Space size={8}>
                      <Text strong style={{ fontSize: 14 }}>
                        {row.name ?? row.stock_code}
                      </Text>
                      <Text code style={{ fontSize: 11 }}>
                        {row.stock_code}
                      </Text>
                      {row.profit_change_low != null && (
                        <Tag color="red">{`${Math.round(row.profit_change_low)}%+`}</Tag>
                      )}
                      {row.forecast_type && <Tag color="green">{row.forecast_type}</Tag>}
                    </Space>
                    {row.reason && (
                      <Paragraph
                        style={{ margin: '4px 0 0 0', fontSize: 12 }}
                        type="secondary"
                      >
                        {row.reason}
                      </Paragraph>
                    )}
                  </Space>
                </Card>
              ))}
            </div>
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
// US-077 RiskAlertCenterPanel — 风控告警中心（分页 + 过滤 + 批量已读）
// ---------------------------------------------------------------------------

/**
 * 风控告警中心 sub-tab。
 *
 * 与 `AlertsPanel`（前 3 tab 的未读预览）的区别：
 *   - AlertsPanel = 来自 /api/today/signals 的最近 N 条未读 list view（只展示）；
 *   - 本组件 = 来自 /api/risk-alerts/list 的全量分页 table（可过滤 / 批量已读）。
 *
 * Filter：level (HIGH/MEDIUM/LOW) / type (持仓/市场/单股) / date range / is_read。
 * 批量已读：表格 rowSelection multiple → 顶部按钮 "标记选中已读 (N)"；
 *           标记完后自动 reload 当前分页，并通过 `onUnreadCountChange` 让父组件
 *           更新 KPI 条的未读徽标。
 *
 * 错误处理：单 try/catch + 顶部 Alert + 重试按钮（同 SignalsPanel / AlertsPanel）。
 */
const RiskAlertCenterPanel: React.FC<{ onUnreadCountChange?: () => void }> = ({
  onUnreadCountChange,
}) => {
  const [items, setItems] = useState<RiskAlertItem[]>([]);
  const [total, setTotal] = useState(0);
  const [unreadCount, setUnreadCount] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(30);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [filterLevel, setFilterLevel] = useState<'HIGH' | 'MEDIUM' | 'LOW' | undefined>(undefined);
  const [filterType, setFilterType] = useState<AlertCategory | undefined>(undefined);
  const [filterDateRange, setFilterDateRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);
  const [filterIsRead, setFilterIsRead] = useState<boolean | undefined>(undefined);
  const [filterSearch, setFilterSearch] = useState<string>('');

  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [marking, setMarking] = useState(false);

  // 组装 query — useMemo 让 effect deps 稳定
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
      // 切换分页 / 过滤后清空选中（防止跨页选 ID 误标）
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

  const rowSelection: TableRowSelection<RiskAlertItem> = {
    selectedRowKeys: selectedIds,
    onChange: keys => setSelectedIds(keys.map(k => Number(k))),
    getCheckboxProps: row => ({
      // 已读告警不需要再次标记 (post-action 状态防呆)
      disabled: row.is_read,
    }),
  };

  // 当前分页内的未读条数（用于 "已全选" 边界感知）
  const unreadOnPage = useMemo(() => items.filter(i => !i.is_read).length, [items]);

  return (
    <Card
      size="small"
      title={
        <Space>
          <SafetyCertificateOutlined style={{ color: '#722ed1' }} />
          <span>风控告警中心</span>
          <Tag color={unreadCount > 0 ? 'red' : 'green'}>未读 {unreadCount}</Tag>
          <Tag color="default">总计 {total}</Tag>
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

        {/* 过滤栏 */}
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
              value={
                filterIsRead === undefined ? 'all' : filterIsRead ? 'read' : 'unread'
              }
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
                <Text type="secondary">
                  已选 {selectedIds.length} 条（当前页未读 {unreadOnPage} 条）
                </Text>
              )}
            </Space>
          </Col>
        </Row>

        <Table<RiskAlertItem>
          size="small"
          rowKey="id"
          loading={loading}
          dataSource={items}
          rowSelection={rowSelection}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            pageSizeOptions: ['20', '30', '50', '100'],
            showTotal: (n, range) => `共 ${n} 条，当前 ${range[0]}-${range[1]}`,
            onChange: (p, ps) => {
              setPage(p);
              if (ps !== pageSize) setPageSize(ps);
            },
          }}
          locale={{ emptyText: <Empty description="无符合过滤条件的告警" /> }}
          columns={[
            {
              title: '级别',
              dataIndex: 'level',
              width: 80,
              render: (v: string) => levelTag(v),
              filters: [
                { text: '高', value: 'HIGH' },
                { text: '中', value: 'MEDIUM' },
                { text: '低', value: 'LOW' },
              ],
              onFilter: (val, row) => row.level === val,
            },
            {
              title: '类型',
              dataIndex: 'category',
              width: 80,
              render: (v: AlertCategory) => categoryTag(v),
            },
            {
              title: '代码 / 名称',
              key: 'symbol_name',
              width: 240,
              render: (_: unknown, row: RiskAlertItem) => (
                <Space direction="vertical" size={0}>
                  <Text code style={{ fontSize: 12 }}>
                    {row.symbol}
                  </Text>
                  <Text strong>{row.name}</Text>
                </Space>
              ),
            },
            {
              title: '内容',
              dataIndex: 'message',
              ellipsis: { showTitle: false },
              render: (v: string) => (
                <Tooltip title={v} placement="topLeft">
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {v}
                  </Text>
                </Tooltip>
              ),
            },
            {
              title: '规则',
              dataIndex: 'rule_id',
              width: 140,
              ellipsis: true,
              render: (v: string | null | undefined) =>
                v ? (
                  <Tag color="purple" style={{ fontSize: 11 }}>
                    {v}
                  </Tag>
                ) : (
                  <Text type="secondary">—</Text>
                ),
            },
            {
              title: '时间',
              dataIndex: 'created_at',
              width: 150,
              render: (v: string) => (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {dayjs(v).format('MM-DD HH:mm:ss')}
                </Text>
              ),
              sorter: (a, b) => dayjs(a.created_at).valueOf() - dayjs(b.created_at).valueOf(),
              defaultSortOrder: 'descend',
            },
            {
              title: '状态',
              dataIndex: 'is_read',
              width: 70,
              render: (v: boolean) =>
                v ? <Tag color="default">已读</Tag> : <Tag color="red">未读</Tag>,
            },
          ]}
        />
      </Space>
    </Card>
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

/** US-073 沪深300 开盘涨跌色：>0 红涨，<0 绿跌，0/null 中性 */
function openChangeColor(value: number | null): string | undefined {
  if (value == null || !Number.isFinite(value) || value === 0) return undefined;
  return value > 0 ? '#cf1322' : '#52c41a';
}

/** US-073 北向资金色：净流入红，净流出绿 */
function northboundColor(value: number | null): string | undefined {
  if (value == null || !Number.isFinite(value) || value === 0) return undefined;
  return value > 0 ? '#cf1322' : '#52c41a';
}

/** US-073 涨停数色：≥80 红（赚钱效应强），≤30 灰（赚钱效应弱），否则默认 */
function limitUpColor(value: number | null): string | undefined {
  if (value == null || !Number.isFinite(value)) return undefined;
  if (value >= 80) return '#cf1322';
  if (value <= 30) return '#8c8c8c';
  return undefined;
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

/** US-077 风控中心 — 告警类别 tag */
function categoryTag(category: AlertCategory): React.ReactNode {
  if (category === 'position') return <Tag color="blue">{ALERT_CATEGORY_LABEL.position}</Tag>;
  if (category === 'market') return <Tag color="purple">{ALERT_CATEGORY_LABEL.market}</Tag>;
  return <Tag color="cyan">{ALERT_CATEGORY_LABEL.individual}</Tag>;
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
