import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Progress,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowRightOutlined,
  FundProjectionScreenOutlined,
  LineChartOutlined,
  NodeIndexOutlined,
  RadarChartOutlined,
  ReloadOutlined,
  ReadOutlined,
  SafetyCertificateOutlined,
  TrophyOutlined,
} from '@ant-design/icons';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import RecommendationTradeOutcomes from './RecommendationTradeOutcomes';
import RecommendationPerformance from './RecommendationPerformance';
import AgentTailAlphaLedger from './AgentTailAlphaLedger';
import TradingJournal from './TradingJournal';
import api from '../services/api';

const { Text, Paragraph } = Typography;

const tabPathMap: Record<string, string> = {
  overview: '/review',
  trades: '/review/trades',
  performance: '/review/performance',
  tail: '/review/agent-tail',
  journal: '/review/journal',
};

const formatMoney = (value?: number | null) => {
  const num = Number(value || 0);
  const prefix = num > 0 ? '+¥' : num < 0 ? '-¥' : '¥';
  return `${prefix}${Math.abs(num).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
};

const formatPercent = (value?: number | null) => `${Number(value || 0).toFixed(2)}%`;
const pnlColor = (value?: number | null) => (Number(value || 0) >= 0 ? '#b42318' : '#047857');
const clampPercent = (value?: number | null) => Math.max(0, Math.min(100, Number(value || 0)));

const sourceColor = (value?: string) => {
  if (value === 'quant_recommendation') return 'blue';
  if (value === 'tradingagents') return 'purple';
  if (value === 'daily_screener') return 'cyan';
  return 'default';
};

const toneTag = (tone?: string) => {
  if (tone === 'good') return <Tag color="red">可小幅放大</Tag>;
  if (tone === 'danger') return <Tag color="volcano">风控优先</Tag>;
  if (tone === 'reduce') return <Tag color="green">降仓验证</Tag>;
  return <Tag color="gold">继续观察</Tag>;
};

const ReviewOverview: React.FC = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [horizon, setHorizon] = useState('5d');
  const [lookbackDays, setLookbackDays] = useState(365);
  const [data, setData] = useState<any>(null);

  const fetchCenter = async (silent = false) => {
    setLoading(true);
    try {
      const response = await api.get('/review/performance-center', {
        params: { horizon, lookback_days: lookbackDays, limit: 2000 },
      });
      setData(response.data?.data);
      if (!silent) message.success('收益复盘中心已刷新');
    } catch (error: any) {
      message.error(error.response?.data?.message || '获取收益复盘中心失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCenter(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [horizon, lookbackDays]);

  const summary = data?.summary || {};
  const conclusion = data?.conclusion || {};
  const sourceRows = data?.source_comparison || [];
  const bestSegments = data?.best_segments || [];
  const weakSegments = data?.weak_segments || [];
  const actionItems = data?.action_items || [];
  const equityCurve = data?.equity_curve || [];
  const latestOutcomes = data?.outcome?.latest_outcomes || [];

  const sourceColumns = [
    {
      title: '来源',
      dataIndex: 'label',
      render: (value: string, record: any) => (
        <Space>
          <Tag color={sourceColor(record.key)}>{value}</Tag>
          {record.gate_label && <Text type="secondary">{record.gate_label}</Text>}
        </Space>
      ),
    },
    {
      title: '闭环/跟踪',
      width: 120,
      render: (_: any, record: any) => `${record.closed_count || 0}/${record.tracked_count || 0}`,
    },
    {
      title: '综合盈亏',
      width: 130,
      render: (_: any, record: any) => (
        <Text strong style={{ color: pnlColor(record.total_pnl) }}>
          {formatMoney(record.total_pnl)}
        </Text>
      ),
    },
    {
      title: '平均超额',
      width: 120,
      render: (_: any, record: any) => (
        <Text style={{ color: pnlColor(record.avg_excess_return_pct) }}>
          {formatPercent(record.avg_excess_return_pct)}
        </Text>
      ),
    },
    {
      title: '质量分',
      width: 150,
      render: (_: any, record: any) => (
        <Progress
          percent={clampPercent(record.quality_score)}
          size="small"
          strokeColor={record.quality_score >= 70 ? '#b7791f' : '#2764b8'}
        />
      ),
    },
  ];

  return (
    <div className="review-overview-page fade-in-up">
      <div className="review-overview-hero">
        <div>
          <div className="review-overview-kicker">Performance Review Center</div>
          <h1>收益复盘中心</h1>
          <Paragraph>
            把模拟交易闭环、信号后验、Agent
            尾盘账本和组合风控收敛到一页，先看结论，再决定下一轮是否放大、降权或暂停。
          </Paragraph>
          <Space wrap>
            {toneTag(conclusion.tone)}
            <Tag>周期 {data?.filters?.horizon || horizon}</Tag>
            <Tag>样本窗口 {data?.filters?.lookback_days || lookbackDays} 天</Tag>
            <Tag color={summary.no_data_signals > 0 ? 'orange' : 'green'}>
              缺行情 {summary.no_data_signals || 0}
            </Tag>
          </Space>
        </div>
        <div className="review-overview-verdict">
          <span>复盘结论</span>
          <strong>{conclusion.headline || '等待收益样本生成'}</strong>
          <em>{conclusion.reason || '暂无可用结论，请先运行自动荐股闭环和收益刷新。'}</em>
          {conclusion.next_action && <em>下一步：{conclusion.next_action}</em>}
        </div>
      </div>

      <Card className="modern-card review-toolbar-card" variant="borderless">
        <Space wrap>
          <Select value={horizon} onChange={setHorizon} style={{ width: 120 }}>
            {['1d', '3d', '5d', '10d', '20d'].map(item => (
              <Select.Option value={item} key={item}>
                {item}
              </Select.Option>
            ))}
          </Select>
          <Select value={lookbackDays} onChange={setLookbackDays} style={{ width: 140 }}>
            <Select.Option value={60}>近60天</Select.Option>
            <Select.Option value={180}>近180天</Select.Option>
            <Select.Option value={365}>近365天</Select.Option>
            <Select.Option value={1200}>全部样本</Select.Option>
          </Select>
          <Button icon={<ReloadOutlined />} onClick={() => fetchCenter(false)} loading={loading}>
            刷新复盘
          </Button>
          <Button type="primary" onClick={() => navigate('/review/trades')}>
            查看交易明细 <ArrowRightOutlined />
          </Button>
          <Text type="secondary">最后生成：{data?.generated_at || '--'}</Text>
        </Space>
      </Card>

      <Row gutter={[18, 18]}>
        <Col xs={12} lg={6}>
          <Card className="modern-card review-stat-card" variant="borderless" loading={loading}>
            <Statistic
              title="推荐闭环盈亏"
              value={summary.total_pnl || 0}
              precision={2}
              prefix="¥"
              valueStyle={{ color: pnlColor(summary.total_pnl) }}
            />
            <Text type="secondary">
              已闭环 {summary.closed_count || 0} / 持仓 {summary.open_count || 0}
            </Text>
          </Card>
        </Col>
        <Col xs={12} lg={6}>
          <Card className="modern-card review-stat-card" variant="borderless" loading={loading}>
            <Statistic
              title="平均超额"
              value={summary.avg_excess_return_pct || 0}
              precision={2}
              suffix="%"
              prefix={<TrophyOutlined />}
              valueStyle={{ color: pnlColor(summary.avg_excess_return_pct) }}
            />
            <Text type="secondary">超额胜率 {formatPercent(summary.excess_win_rate)}</Text>
          </Card>
        </Col>
        <Col xs={12} lg={6}>
          <Card className="modern-card review-stat-card" variant="borderless" loading={loading}>
            <Statistic
              title="信号质量"
              value={summary.signal_quality_score || 0}
              precision={0}
              prefix={<LineChartOutlined />}
            />
            <Text type="secondary">
              后验样本 {summary.signal_completed_samples || 0}/{summary.signal_total || 0}
            </Text>
          </Card>
        </Col>
        <Col xs={12} lg={6}>
          <Card className="modern-card review-stat-card" variant="borderless" loading={loading}>
            <Statistic
              title="组合仓位"
              value={summary.exposure_pct || 0}
              precision={2}
              suffix="%"
              prefix={<SafetyCertificateOutlined />}
            />
            <Text type="secondary">
              {summary.risk_label || '未生成'} · 现金 {formatPercent(summary.cash_pct)}
            </Text>
          </Card>
        </Col>
      </Row>

      <Row gutter={[18, 18]}>
        <Col xs={24} xl={15}>
          <Card className="modern-card" variant="borderless" title="推荐交易累计盈亏">
            {equityCurve.length > 0 ? (
              <div style={{ height: 320 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={equityCurve} margin={{ left: 8, right: 18, top: 12, bottom: 0 }}>
                    <defs>
                      <linearGradient id="reviewEquity" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#2764b8" stopOpacity={0.26} />
                        <stop offset="100%" stopColor="#0fa6a6" stopOpacity={0.03} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid
                      strokeDasharray="3 3"
                      vertical={false}
                      stroke="rgba(15,23,42,.08)"
                    />
                    <XAxis
                      dataKey="date"
                      tick={{ fill: '#65727e', fontSize: 12 }}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      tick={{ fill: '#65727e', fontSize: 12 }}
                      tickLine={false}
                      axisLine={false}
                    />
                    <RechartsTooltip
                      formatter={(value: number) => [formatMoney(value), '累计盈亏']}
                    />
                    <Area
                      type="monotone"
                      dataKey="cumulative_pnl"
                      stroke="#2764b8"
                      strokeWidth={3}
                      fill="url(#reviewEquity)"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <Empty description="暂无闭环收益曲线" />
            )}
          </Card>
        </Col>
        <Col xs={24} xl={9}>
          <Card className="modern-card" variant="borderless" title="来源对比">
            {sourceRows.length > 0 ? (
              <Table
                size="small"
                columns={sourceColumns}
                dataSource={sourceRows}
                rowKey="key"
                pagination={false}
              />
            ) : (
              <Empty description="暂无来源对比样本" />
            )}
          </Card>
        </Col>
      </Row>

      <Row gutter={[18, 18]}>
        <Col xs={24} lg={8}>
          <Card className="modern-card review-segment-card" variant="borderless" title="优胜片段">
            {bestSegments.length > 0 ? (
              <Space direction="vertical" style={{ width: '100%' }}>
                {bestSegments.slice(0, 5).map((item: any) => (
                  <div
                    className="review-segment-row good"
                    key={`best-${item.dimension}-${item.key}`}
                  >
                    <div>
                      <strong>{item.label}</strong>
                      <span>
                        {item.dimension} · 样本 {item.count}
                      </span>
                    </div>
                    <em>{formatPercent(item.avg_excess_return_pct)}</em>
                  </div>
                ))}
              </Space>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无优胜片段" />
            )}
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card className="modern-card review-segment-card" variant="borderless" title="待降权片段">
            {weakSegments.length > 0 ? (
              <Space direction="vertical" style={{ width: '100%' }}>
                {weakSegments.slice(0, 5).map((item: any) => (
                  <div
                    className="review-segment-row weak"
                    key={`weak-${item.dimension}-${item.key}`}
                  >
                    <div>
                      <strong>{item.label}</strong>
                      <span>
                        {item.dimension} · 样本 {item.count}
                      </span>
                    </div>
                    <em>{formatPercent(item.avg_excess_return_pct)}</em>
                  </div>
                ))}
              </Space>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无弱片段" />
            )}
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card className="modern-card review-segment-card" variant="borderless" title="下一步动作">
            {actionItems.length > 0 ? (
              <Space direction="vertical" style={{ width: '100%' }}>
                {actionItems.slice(0, 6).map((item: string, index: number) => (
                  <Alert
                    key={`action-${index}`}
                    type={index === 0 ? 'info' : 'success'}
                    showIcon
                    message={item}
                  />
                ))}
              </Space>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无动作建议" />
            )}
          </Card>
        </Col>
      </Row>

      <Row gutter={[18, 18]}>
        <Col xs={24} xl={10}>
          <Card className="modern-card" variant="borderless" title="优胜来源柱状图">
            {sourceRows.length > 0 ? (
              <div style={{ height: 260 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={sourceRows}
                    layout="vertical"
                    margin={{ left: 8, right: 18, top: 8, bottom: 8 }}
                  >
                    <CartesianGrid
                      strokeDasharray="3 3"
                      horizontal={false}
                      stroke="rgba(15,23,42,.08)"
                    />
                    <XAxis
                      type="number"
                      tick={{ fill: '#65727e', fontSize: 12 }}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      type="category"
                      dataKey="label"
                      width={92}
                      tick={{ fill: '#65727e', fontSize: 12 }}
                      tickLine={false}
                      axisLine={false}
                    />
                    <RechartsTooltip
                      formatter={(value: number) => [`${Number(value).toFixed(2)}`, '综合分']}
                    />
                    <Bar dataKey="composite_score" radius={[0, 10, 10, 0]} fill="#2764b8" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <Empty description="暂无来源分布" />
            )}
          </Card>
        </Col>
        <Col xs={24} xl={14}>
          <Card
            className="modern-card table-card-no-padding"
            variant="borderless"
            title="最近推荐交易"
          >
            <Table
              size="small"
              rowKey="id"
              dataSource={latestOutcomes}
              pagination={false}
              columns={[
                {
                  title: '标的',
                  render: (_: any, record: any) => (
                    <Space direction="vertical" size={0}>
                      <Text strong>{record.name || record.symbol}</Text>
                      <Text type="secondary">{record.symbol}</Text>
                    </Space>
                  ),
                },
                {
                  title: '状态',
                  width: 90,
                  render: (_: any, record: any) => (
                    <Tag color={record.trade_status === 'closed' ? 'purple' : 'blue'}>
                      {record.trade_status === 'closed' ? '已平仓' : '持仓中'}
                    </Tag>
                  ),
                },
                {
                  title: '收益',
                  width: 120,
                  render: (_: any, record: any) => (
                    <Text strong style={{ color: pnlColor(record.total_pnl_pct) }}>
                      {formatPercent(record.total_pnl_pct)}
                    </Text>
                  ),
                },
                {
                  title: '超额',
                  width: 120,
                  render: (_: any, record: any) => (
                    <Text style={{ color: pnlColor(record.excess_return_pct) }}>
                      {formatPercent(record.excess_return_pct)}
                    </Text>
                  ),
                },
                {
                  title: '链路',
                  width: 82,
                  render: (_: any, record: any) => (
                    <Button
                      type="link"
                      size="small"
                      onClick={() => navigate(`/recommendation-trade-outcomes/${record.id}`)}
                    >
                      追踪
                    </Button>
                  ),
                },
              ]}
              locale={{ emptyText: <Empty description="暂无推荐交易" /> }}
            />
          </Card>
        </Col>
      </Row>
    </div>
  );
};

const ReviewCenter: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();

  const activeKey = useMemo(() => {
    if (location.pathname === '/review') return 'overview';
    if (location.pathname.includes('/review/performance')) return 'performance';
    if (location.pathname.includes('/review/agent-tail')) return 'tail';
    if (location.pathname.includes('/review/journal')) return 'journal';
    return 'trades';
  }, [location.pathname]);

  return (
    <div className="review-center-page">
      <Tabs
        activeKey={activeKey}
        onChange={key => navigate(tabPathMap[key] || '/review/trades')}
        className="review-center-tabs"
        items={[
          {
            key: 'overview',
            label: (
              <span>
                <RadarChartOutlined /> 复盘总览
              </span>
            ),
            children: <ReviewOverview />,
          },
          {
            key: 'trades',
            label: (
              <span>
                <NodeIndexOutlined /> 交易闭环
              </span>
            ),
            children: <RecommendationTradeOutcomes />,
          },
          {
            key: 'performance',
            label: (
              <span>
                <FundProjectionScreenOutlined /> 信号绩效
              </span>
            ),
            children: <RecommendationPerformance />,
          },
          {
            key: 'tail',
            label: (
              <span>
                <RadarChartOutlined /> Agent尾盘
              </span>
            ),
            children: <AgentTailAlphaLedger />,
          },
          {
            key: 'journal',
            label: (
              <span>
                <ReadOutlined /> 交易日记
              </span>
            ),
            children: <TradingJournal />,
          },
        ]}
      />
    </div>
  );
};

export default ReviewCenter;
