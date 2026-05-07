import React, { useEffect, useState } from 'react';
import {
  Card,
  Row,
  Col,
  Table,
  Button,
  Tag,
  Space,
  Skeleton,
  Typography,
  Progress,
  Empty,
} from 'antd';
import {
  PlusOutlined,
  EyeOutlined,
  RocketOutlined,
  DatabaseOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
  ArrowRightOutlined,
} from '@ant-design/icons';
import { AreaChart, Area, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import { backtestService, BacktestResponse } from '../services/backtestService';
import api, { getMarketOverview } from '../services/api';
import { useNavigate } from 'react-router-dom';

const { Text } = Typography;

interface OpsOverview {
  dataSource?: any;
  dataQuality?: any;
  aiHealth?: any;
  signalStats?: any;
  recommendations?: any;
  errors: Record<string, string>;
}

interface InsightCardProps {
  title: string;
  value: React.ReactNode;
  description: React.ReactNode;
  icon: React.ReactNode;
  accent: string;
  loading?: boolean;
  extra?: React.ReactNode;
  footer?: React.ReactNode;
  actionLabel?: string;
  onAction?: () => void;
}

const getSentimentColor = (score: number) => {
  if (score > 70) return '#cf1322';
  if (score < 30) return '#3f8600';
  return '#faad14';
};

const toNumber = (value: any, fallback = 0) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const clampPercent = (value: any) => Math.max(0, Math.min(100, toNumber(value, 0)));

const formatPercent = (value: any, digits = 2) => `${toNumber(value, 0).toFixed(digits)}%`;

const getStatusMeta = (status?: string) => {
  const normalized = String(status || 'unknown').toLowerCase();
  if (['healthy', 'ok', 'success'].includes(normalized)) {
    return { color: 'success', text: '健康' };
  }
  if (['degraded', 'warning', 'partial'].includes(normalized)) {
    return { color: 'warning', text: '需关注' };
  }
  if (['unhealthy', 'error', 'failed'].includes(normalized)) {
    return { color: 'error', text: '异常' };
  }
  if (normalized === 'disabled') {
    return { color: 'default', text: '停用' };
  }
  return { color: 'processing', text: '探测中' };
};

const getSignalHorizon = (stats: any, preferred = ['20d', '10d', '5d']) => {
  const summary = stats?.horizon_summary || {};
  return preferred.map(key => ({ key, value: summary[key] })).find(item => item.value)?.value || {};
};

const InsightCard: React.FC<InsightCardProps> = ({
  title,
  value,
  description,
  icon,
  accent,
  loading,
  extra,
  footer,
  actionLabel,
  onAction,
}) => (
  <Card
    className="modern-card"
    variant="borderless"
    hoverable={Boolean(onAction)}
    onClick={onAction}
    bodyStyle={{
      minHeight: 176,
      padding: 20,
      background: `linear-gradient(135deg, ${accent}12 0%, #ffffff 58%)`,
      borderRadius: 14,
      cursor: onAction ? 'pointer' : 'default',
    }}
  >
    <Skeleton loading={loading} active paragraph={{ rows: 2 }} title={false}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        <div
          style={{
            width: 42,
            height: 42,
            borderRadius: 14,
            background: accent,
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 20,
            boxShadow: `0 12px 24px ${accent}30`,
            flex: '0 0 auto',
          }}
        >
          {icon}
        </div>
        {extra}
      </div>
      <div style={{ marginTop: 18 }}>
        <Text type="secondary" style={{ fontSize: 13 }}>
          {title}
        </Text>
        <div
          style={{
            marginTop: 4,
            fontSize: 30,
            lineHeight: 1.1,
            fontWeight: 760,
            letterSpacing: -0.5,
            color: 'var(--text-main)',
          }}
        >
          {value}
        </div>
        <div style={{ marginTop: 8, minHeight: 22 }}>
          <Text type="secondary" style={{ fontSize: 13 }}>
            {description}
          </Text>
        </div>
      </div>
      {footer && <div style={{ marginTop: 14 }}>{footer}</div>}
      {actionLabel && onAction && (
        <Button
          type="link"
          size="small"
          style={{ paddingLeft: 0, marginTop: 6, color: accent }}
          onClick={event => {
            event.stopPropagation();
            onAction();
          }}
        >
          {actionLabel}
          <ArrowRightOutlined />
        </Button>
      )}
    </Skeleton>
  </Card>
);

const Dashboard: React.FC = () => {
  const [stats, setStats] = useState({
    totalBacktests: 0,
    avgReturn: 0,
    avgSharpeRatio: 0,
    win_rate: 0,
  });
  const [recentBacktests, setRecentBacktests] = useState<BacktestResponse[]>([]);
  const [loading, setLoading] = useState(false);
  const [marketOverview, setMarketOverview] = useState<any>(null);
  const [opsOverview, setOpsOverview] = useState<OpsOverview>({ errors: {} });
  const [opsLoading, setOpsLoading] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    loadDashboardData();
    loadMarketOverview();
    loadOpsOverview();
  }, []);

  const loadMarketOverview = async () => {
    try {
      const response = await getMarketOverview();
      if (response.data.success) {
        setMarketOverview(response.data.data);
      }
    } catch (error) {
      console.error('加载大盘概览失败:', error);
    }
  };

  const loadOpsOverview = async () => {
    setOpsLoading(true);
    try {
      const requests = await Promise.allSettled([
        api.get('/market/data-sources/health'),
        api.get('/market/data-quality', {
          params: { scope: 'favorites', lookback_days: 180, limit: 20 },
        }),
        api.get('/ai/health'),
        api.get('/ai/signals/stats', {
          params: { source_type: 'quant_recommendation' },
        }),
        api.get('/ai/recommendations', {
          params: { universe: 'favorites', style: 'balanced', limit: 5 },
        }),
      ]);

      const errors: Record<string, string> = {};
      const pickData = (index: number, label: string) => {
        const result = requests[index];
        if (result.status === 'fulfilled' && result.value.data?.success) {
          return result.value.data.data;
        }
        errors[label] =
          result.status === 'rejected'
            ? result.reason?.message || '加载失败'
            : result.value.data?.message || result.value.data?.error || '加载失败';
        return undefined;
      };

      setOpsOverview({
        dataSource: pickData(0, 'dataSource'),
        dataQuality: pickData(1, 'dataQuality'),
        aiHealth: pickData(2, 'aiHealth'),
        signalStats: pickData(3, 'signalStats'),
        recommendations: pickData(4, 'recommendations'),
        errors,
      });
    } catch (error) {
      console.error('加载研究运营数据失败:', error);
    } finally {
      setOpsLoading(false);
    }
  };

  const loadDashboardData = async () => {
    setLoading(true);
    try {
      const response = await backtestService.getBacktestList(1, 10);
      const backtests = response.data.backtests || [];

      // 计算统计数据
      const completedBacktests = backtests.filter(
        (b: any) => b.status === 'completed' && b.total_return !== undefined
      );
      const totalCompleted = completedBacktests.length;

      let avgReturn = 0;
      let avgSharpeRatio = 0;
      let win_rate = 0;

      if (totalCompleted > 0) {
        const totalReturnSum = completedBacktests.reduce(
          (sum: number, b: any) => sum + (b.total_return || 0),
          0
        );
        const sharpeSum = completedBacktests.reduce(
          (sum: number, b: any) => sum + (b.sharpe_ratio || 0),
          0
        );
        const winningTrades = completedBacktests.filter(
          (b: any) => (b.total_return || 0) > 0
        ).length;

        avgReturn = (totalReturnSum / totalCompleted) * 100;
        avgSharpeRatio = sharpeSum / totalCompleted;
        win_rate = (winningTrades / totalCompleted) * 100;
      }

      setStats({
        totalBacktests: response.data.pagination?.total || backtests.length,
        avgReturn,
        avgSharpeRatio,
        win_rate,
      });

      // 最近回测（按创建时间排序，取前5个）
      const sorted = [...backtests]
        .sort(
          (a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        )
        .slice(0, 5);
      setRecentBacktests(sorted);
    } catch (error) {
      console.error('加载仪表板数据失败:', error);
    } finally {
      setLoading(false);
    }
  };

  const columns = [
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      render: (text: string) => <span style={{ fontWeight: 500 }}>{text}</span>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (status: BacktestResponse['status']) => {
        const statusConfig: Record<string, { color: string; text: string }> = {
          pending: { color: 'blue', text: '等待中' },
          running: { color: 'orange', text: '运行中' },
          completed: { color: 'green', text: '已完成' },
          failed: { color: 'red', text: '失败' },
        };
        const config = statusConfig[status] || { color: 'default', text: status };
        return <Tag color={config.color}>{config.text}</Tag>;
      },
    },
    {
      title: '收益率',
      dataIndex: 'total_return',
      key: 'total_return',
      render: (returnRate: number | undefined) => {
        if (returnRate === undefined) return <span style={{ color: '#bfbfbf' }}>--</span>;
        const color = returnRate >= 0 ? '#52c41a' : '#ff4d4f';
        return <span style={{ color, fontWeight: 600 }}>{(returnRate * 100).toFixed(2)}%</span>;
      },
    },
    {
      title: '操作',
      key: 'action',
      render: (_: any, record: BacktestResponse) => (
        <Space size="small">
          {record.status === 'completed' && (
            <Button
              type="link"
              size="small"
              icon={<EyeOutlined />}
              onClick={() => navigate(`/backtest/${record.id}`)}
            >
              查看
            </Button>
          )}
        </Space>
      ),
    },
  ];

  const dataSourceSummary = opsOverview.dataSource?.summary || {};
  const dataSourceStatus = getStatusMeta(opsOverview.dataSource?.status);
  const enabledProviders = toNumber(dataSourceSummary.enabled_providers);
  const healthyProviders = toNumber(dataSourceSummary.healthy_providers);
  const dataSourceScore = clampPercent(dataSourceSummary.avg_health_score);

  const qualitySummary = opsOverview.dataQuality?.summary || {};
  const qualityScore = clampPercent(qualitySummary.avg_quality_score);
  const lowQualityRate = clampPercent(qualitySummary.low_quality_rate);
  const scannedStocks = toNumber(qualitySummary.scanned_stocks);
  const staleCount = toNumber(qualitySummary.stale_count);

  const aiStatus = getStatusMeta(opsOverview.aiHealth?.status);
  const aiHealthScore = clampPercent(opsOverview.aiHealth?.health_score);
  const aiLatency = opsOverview.aiHealth?.last_latency_ms
    ? `${Math.round(toNumber(opsOverview.aiHealth.last_latency_ms))}ms`
    : '--';

  const signalHorizon = getSignalHorizon(opsOverview.signalStats);
  const signalPositiveRate = clampPercent(signalHorizon.positive_rate);
  const totalSignals = toNumber(opsOverview.signalStats?.total_signals);
  const topRecommendations = opsOverview.recommendations?.recommendations || [];

  return (
    <div className="fade-in-up">
      {/* 页面标题与快速操作区 */}
      <div
        className="page-header-modern"
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}
      >
        <div>
          <h1 className="page-title-modern">仪表盘</h1>
          <p className="page-subtitle-modern">欢迎回来，以下是您的系统概览</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button icon={<ThunderboltOutlined />} onClick={() => navigate('/recommendations')}>
            智能推荐
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/backtest')}>
            新建回测
          </Button>
          <Button icon={<RocketOutlined />} onClick={() => navigate('/portfolio')}>
            组合模拟
          </Button>
        </div>
      </div>

      {/* 研究运营闭环：数据源、数据质量、AI 投研与推荐后验 */}
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={24} sm={12} xl={6}>
          <InsightCard
            loading={opsLoading}
            title="数据源韧性"
            icon={<DatabaseOutlined />}
            accent="#1677ff"
            value={dataSourceScore.toFixed(0)}
            description={`${healthyProviders}/${
              enabledProviders || '--'
            } 个可用源 · fallback 自动接管`}
            extra={<Tag color={dataSourceStatus.color}>{dataSourceStatus.text}</Tag>}
            footer={
              <Progress
                percent={dataSourceScore}
                showInfo={false}
                strokeColor="#1677ff"
                trailColor="#dbeafe"
              />
            }
            actionLabel="查看数据源"
            onAction={() => navigate('/data-update')}
          />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <InsightCard
            loading={opsLoading}
            title="行情质量画像"
            icon={<SafetyCertificateOutlined />}
            accent="#16a34a"
            value={qualityScore.toFixed(0)}
            description={`${scannedStocks || '--'} 只样本 · 低质量率 ${formatPercent(
              lowQualityRate,
              1
            )} · 滞后 ${staleCount}`}
            extra={<Tag color={qualityScore >= 75 ? 'success' : 'warning'}>质量分</Tag>}
            footer={
              <Progress
                percent={qualityScore}
                showInfo={false}
                strokeColor="#16a34a"
                trailColor="#dcfce7"
              />
            }
            actionLabel="修复缺口"
            onAction={() => navigate('/data-update')}
          />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <InsightCard
            loading={opsLoading}
            title="TradingAgents 连接"
            icon={<RobotOutlined />}
            accent="#7c3aed"
            value={aiHealthScore ? aiHealthScore.toFixed(0) : aiStatus.text}
            description={`延迟 ${aiLatency} · ${
              opsOverview.aiHealth?.base_url ? '远端服务已纳入健康巡检' : '等待探测'
            }`}
            extra={<Tag color={aiStatus.color}>{aiStatus.text}</Tag>}
            footer={
              <Progress
                percent={aiHealthScore}
                showInfo={false}
                strokeColor="#7c3aed"
                trailColor="#ede9fe"
              />
            }
            actionLabel="发起研报"
            onAction={() => navigate('/ai-advisor')}
          />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <InsightCard
            loading={opsLoading}
            title="量化推荐后验"
            icon={<ThunderboltOutlined />}
            accent="#f97316"
            value={signalPositiveRate ? `${signalPositiveRate.toFixed(0)}%` : '--'}
            description={`${totalSignals} 条已归档 · 平均收益 ${formatPercent(
              signalHorizon.avg_return_pct,
              2
            )}`}
            extra={<Tag color="processing">闭环验证</Tag>}
            footer={
              <Progress
                percent={signalPositiveRate}
                showInfo={false}
                strokeColor="#f97316"
                trailColor="#ffedd5"
              />
            }
            actionLabel="打开推荐池"
            onAction={() => navigate('/recommendations')}
          />
        </Col>
      </Row>

      {/* 第一行：大盘概览 (走势图) */}
      <Row gutter={[16, 16]}>
        <Col span={24}>
          <Card
            className="modern-card"
            variant="borderless"
            title={<span style={{ fontSize: 16, fontWeight: 600 }}>大盘核心指数 (近30天)</span>}
          >
            <Row gutter={[16, 16]}>
              {marketOverview?.indices?.map((index: any) => {
                const isUp = index.change >= 0;
                const color = isUp ? '#cf1322' : '#3f8600';

                return (
                  <Col xs={24} sm={12} lg={6} key={index.symbol}>
                    <Card
                      size="small"
                      variant="borderless"
                      style={{ background: '#f8fafc', borderRadius: 8 }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          marginBottom: 8,
                        }}
                      >
                        <Text strong>{index.name}</Text>
                        <Text style={{ color, fontWeight: 600 }}>
                          {isUp ? '+' : ''}
                          {index.change_percent.toFixed(2)}%
                        </Text>
                      </div>
                      <div
                        style={{
                          fontSize: 20,
                          fontWeight: 'bold',
                          marginBottom: 16,
                          color: 'var(--text-main)',
                        }}
                      >
                        {Number(index.current_price).toFixed(2)}
                      </div>
                      <div style={{ height: 60, width: '100%' }}>
                        <ResponsiveContainer width="100%" height="100%">
                          <AreaChart data={index.trend}>
                            <defs>
                              <linearGradient
                                id={`color-${index.symbol}`}
                                x1="0"
                                y1="0"
                                x2="0"
                                y2="1"
                              >
                                <stop offset="5%" stopColor={color} stopOpacity={0.3} />
                                <stop offset="95%" stopColor={color} stopOpacity={0} />
                              </linearGradient>
                            </defs>
                            <Area
                              type="monotone"
                              dataKey="close"
                              stroke={color}
                              strokeWidth={2}
                              fill={`url(#color-${index.symbol})`}
                              isAnimationActive={false}
                            />
                            <YAxis domain={['auto', 'auto']} hide />
                            <XAxis dataKey="time" hide />
                          </AreaChart>
                        </ResponsiveContainer>
                      </div>
                    </Card>
                  </Col>
                );
              })}
            </Row>
          </Card>
        </Col>
      </Row>

      {/* 第二行：核心 KPI 与市场情绪 */}
      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} lg={18}>
          <Card
            className="modern-card"
            variant="borderless"
            title={<span style={{ fontSize: 16, fontWeight: 600 }}>回测数据概览</span>}
            style={{ height: '100%' }}
          >
            <Row gutter={[16, 16]}>
              <Col xs={12} sm={6}>
                <Card
                  variant="borderless"
                  bodyStyle={{ padding: '16px 20px', background: '#f8fafc', borderRadius: 8 }}
                >
                  <Skeleton loading={loading} active paragraph={{ rows: 1 }} title={false}>
                    <div className="metric-title" style={{ fontSize: 13 }}>
                      总回测次数
                    </div>
                    <div className="metric-value" style={{ fontSize: 24 }}>
                      {stats.totalBacktests}
                    </div>
                  </Skeleton>
                </Card>
              </Col>
              <Col xs={12} sm={6}>
                <Card
                  variant="borderless"
                  bodyStyle={{ padding: '16px 20px', background: '#f8fafc', borderRadius: 8 }}
                >
                  <Skeleton loading={loading} active paragraph={{ rows: 1 }} title={false}>
                    <div className="metric-title" style={{ fontSize: 13 }}>
                      平均收益率
                    </div>
                    <div
                      className="metric-value"
                      style={{ color: stats.avgReturn >= 0 ? '#16a34a' : '#dc2626', fontSize: 24 }}
                    >
                      {stats.avgReturn >= 0 ? '+' : ''}
                      {stats.avgReturn.toFixed(2)}%
                    </div>
                  </Skeleton>
                </Card>
              </Col>
              <Col xs={12} sm={6}>
                <Card
                  variant="borderless"
                  bodyStyle={{ padding: '16px 20px', background: '#f8fafc', borderRadius: 8 }}
                >
                  <Skeleton loading={loading} active paragraph={{ rows: 1 }} title={false}>
                    <div className="metric-title" style={{ fontSize: 13 }}>
                      平均夏普比率
                    </div>
                    <div className="metric-value" style={{ fontSize: 24 }}>
                      {stats.avgSharpeRatio.toFixed(2)}
                    </div>
                  </Skeleton>
                </Card>
              </Col>
              <Col xs={12} sm={6}>
                <Card
                  variant="borderless"
                  bodyStyle={{ padding: '16px 20px', background: '#f8fafc', borderRadius: 8 }}
                >
                  <Skeleton loading={loading} active paragraph={{ rows: 1 }} title={false}>
                    <div className="metric-title" style={{ fontSize: 13 }}>
                      胜率
                    </div>
                    <div className="metric-value" style={{ fontSize: 24 }}>
                      {stats.win_rate.toFixed(1)}%
                    </div>
                  </Skeleton>
                </Card>
              </Col>
            </Row>
          </Card>
        </Col>

        {/* 市场情绪面板 */}
        <Col xs={24} lg={6}>
          <Card
            className="modern-card"
            variant="borderless"
            title={<span style={{ fontSize: 16, fontWeight: 600 }}>市场情绪雷达</span>}
            style={{ height: '100%', display: 'flex', flexDirection: 'column' }}
            bodyStyle={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
            }}
          >
            {marketOverview?.sentiment ? (
              <div style={{ textAlign: 'center', margin: 'auto 0' }}>
                <Progress
                  type="dashboard"
                  percent={marketOverview.sentiment.score}
                  strokeColor={{
                    '0%': '#3f8600', // 极度恐惧
                    '50%': '#faad14', // 中性
                    '100%': '#cf1322', // 极度贪婪
                  }}
                  format={percent => (
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                      <span style={{ fontSize: 32, fontWeight: 'bold' }}>{percent}</span>
                    </div>
                  )}
                  size={140}
                />
                <div style={{ marginTop: 16, fontSize: 16, fontWeight: 'bold' }}>
                  当前状态：
                  <Text
                    style={{
                      color: getSentimentColor(marketOverview.sentiment.score),
                      marginLeft: 8,
                    }}
                  >
                    {marketOverview.sentiment.label}
                  </Text>
                </div>
              </div>
            ) : loading ? (
              <Skeleton active />
            ) : (
              <Empty description="暂无情绪数据" />
            )}
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} lg={16}>
          <Card
            className="modern-card"
            variant="borderless"
            title={<span style={{ fontSize: 16, fontWeight: 600 }}>最近回测</span>}
            extra={
              <Button type="link" size="small" onClick={() => navigate('/backtest')}>
                查看全部
              </Button>
            }
            bodyStyle={{ padding: '0 24px 24px 24px' }}
          >
            <Table
              columns={columns}
              dataSource={recentBacktests}
              rowKey="id"
              loading={loading}
              pagination={false}
              size="middle"
              locale={{ emptyText: <Empty description="暂无最近回测记录" /> }}
            />
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card
            className="modern-card"
            variant="borderless"
            title={<span style={{ fontSize: 16, fontWeight: 600 }}>研究运营中心</span>}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              >
                <span style={{ color: 'var(--text-secondary)' }}>多源行情</span>
                <Tag color={dataSourceStatus.color}>{dataSourceStatus.text}</Tag>
              </div>
              <div
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              >
                <span style={{ color: 'var(--text-secondary)' }}>数据质量</span>
                <Text strong>{qualityScore ? `${qualityScore.toFixed(0)} 分` : '--'}</Text>
              </div>
              <div
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              >
                <span style={{ color: 'var(--text-secondary)' }}>AI 研报服务</span>
                <Tag color={aiStatus.color}>{aiStatus.text}</Tag>
              </div>
              <div
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              >
                <span style={{ color: 'var(--text-secondary)' }}>推荐样本</span>
                <Text strong>{topRecommendations.length || '--'} 只</Text>
              </div>
            </div>

            <div
              style={{
                marginTop: 20,
                paddingTop: 18,
                borderTop: '1px solid rgba(148, 163, 184, 0.18)',
              }}
            >
              <Text strong>当前候选</Text>
              <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                {topRecommendations.length > 0 ? (
                  topRecommendations.slice(0, 3).map((item: any, index: number) => (
                    <div
                      key={`${item.symbol}-${index}`}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '10px 12px',
                        borderRadius: 12,
                        background: '#f8fafc',
                      }}
                    >
                      <div>
                        <Text strong>{item.name || item.symbol}</Text>
                        <div>
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            {item.symbol}
                          </Text>
                        </div>
                      </div>
                      <Tag color={toNumber(item.score) >= 80 ? 'red' : 'orange'}>
                        {toNumber(item.score).toFixed(0)}
                      </Tag>
                    </div>
                  ))
                ) : (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无候选样本" />
                )}
              </div>
            </div>

            {Object.keys(opsOverview.errors).length > 0 && (
              <div style={{ marginTop: 14 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  部分运营指标暂不可用，已自动降级显示。
                </Text>
              </div>
            )}

            <Space style={{ width: '100%', marginTop: 20 }} direction="vertical">
              <Button block onClick={() => navigate('/recommendations')}>
                进入智能候选推荐
              </Button>
              <Button block onClick={() => navigate('/data-update')}>
                查看系统监控详情
              </Button>
            </Space>
          </Card>
        </Col>
      </Row>
    </div>
  );
};

export default Dashboard;
