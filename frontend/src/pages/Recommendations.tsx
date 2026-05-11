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
  Tag,
  Typography,
  message,
} from 'antd';
import {
  BarChartOutlined,
  DatabaseOutlined,
  ExperimentOutlined,
  FundProjectionScreenOutlined,
  ReloadOutlined,
  RobotOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { Area, AreaChart, ResponsiveContainer } from 'recharts';
import { useNavigate } from 'react-router-dom';
import api from '../services/api';

const { Text, Paragraph } = Typography;

interface FactorScore {
  name: string;
  label: string;
  score: number;
  weight: number;
  value?: number | string;
  reason: string;
}

interface RecommendationFeedback {
  signal_count: number;
  completed_count: number;
  avg_return_pct: number | null;
  positive_rate: number | null;
  best_horizon?: string;
  score_adjustment: number;
  confidence_boost: number;
  latest_signal_date?: string;
}

interface RecommendationItem {
  symbol: string;
  name: string;
  market?: string;
  industry?: string;
  score: number;
  rating: string;
  risk_level: 'low' | 'medium' | 'high';
  confidence: number;
  current_price: number;
  change_percent?: number;
  factors: FactorScore[];
  reasons: string[];
  warnings: string[];
  metrics: Record<string, number | null>;
  feedback?: RecommendationFeedback;
  trend?: Array<{ time: string; close: number }>;
}

interface RecommendationResponse {
  as_of: string;
  universe: string;
  style: string;
  total_candidates: number;
  analyzed_candidates: number;
  recommendations: RecommendationItem[];
}

interface SignalStats {
  total_signals: number;
  by_decision: Record<string, { count: number; avg_confidence_score: number }>;
  horizon_summary: Record<
    string,
    {
      count: number;
      avg_return_pct: number;
      positive_count: number;
      positive_rate?: number;
    }
  >;
}

const riskColorMap: Record<string, string> = {
  low: 'green',
  medium: 'gold',
  high: 'red',
};

const styleOptions = [
  { label: '均衡推荐', value: 'balanced' },
  { label: '趋势动量', value: 'momentum' },
  { label: '价值安全', value: 'value' },
  { label: '低波稳健', value: 'low_risk' },
];

const universeOptions = [
  { label: '我的自选池优先', value: 'favorites' },
  { label: '全市场样本', value: 'market' },
];

const Recommendations: React.FC = () => {
  const navigate = useNavigate();
  const [data, setData] = useState<RecommendationResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [analyzeLoading, setAnalyzeLoading] = useState(false);
  const [profileLoading, setProfileLoading] = useState(false);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [statsLoading, setStatsLoading] = useState(false);
  const [signalStats, setSignalStats] = useState<SignalStats | null>(null);
  const [style, setStyle] = useState('balanced');
  const [universe, setUniverse] = useState('favorites');
  const [limit, setLimit] = useState(20);

  const fetchRecommendations = async () => {
    setLoading(true);
    try {
      const response = await api.get('/ai/recommendations', {
        params: { style, universe, limit },
      });
      if (response.data.success) {
        setData(response.data.data);
      }
    } catch (error: any) {
      message.error(error.response?.data?.message || '获取多因子候选推荐失败');
    } finally {
      setLoading(false);
    }
  };

  const fetchSignalStats = async () => {
    setStatsLoading(true);
    try {
      const response = await api.get('/ai/signals/stats', {
        params: { source_type: 'quant_recommendation' },
      });
      if (response.data.success) {
        setSignalStats(response.data.data);
      }
    } catch (error: any) {
      message.warning(error.response?.data?.message || '获取推荐后验统计失败');
    } finally {
      setStatsLoading(false);
    }
  };

  useEffect(() => {
    fetchRecommendations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [style, universe, limit]);

  useEffect(() => {
    fetchSignalStats();
  }, []);

  const topItems = useMemo(() => data?.recommendations?.slice(0, 5) || [], [data]);
  const avgScore = useMemo(() => {
    const list = data?.recommendations || [];
    if (list.length === 0) return 0;
    return list.reduce((sum, item) => sum + item.score, 0) / list.length;
  }, [data]);

  const feedbackOverview = useMemo(() => {
    const list = data?.recommendations || [];
    const tracked = list.filter(item => Number(item.feedback?.signal_count || 0) > 0);
    const completed = tracked.filter(item => Number(item.feedback?.completed_count || 0) > 0);
    const avgAdjustment =
      tracked.length > 0
        ? tracked.reduce((sum, item) => sum + Number(item.feedback?.score_adjustment || 0), 0) /
          tracked.length
        : 0;
    const avgReturn =
      completed.length > 0
        ? completed.reduce((sum, item) => sum + Number(item.feedback?.avg_return_pct || 0), 0) /
          completed.length
        : 0;
    return {
      tracked: tracked.length,
      completed: completed.length,
      avgAdjustment,
      avgReturn,
    };
  }, [data]);

  const profileQuality = useMemo(() => {
    const list = data?.recommendations || [];
    const missingValuation = list.filter(
      item => !item.metrics?.pe_dynamic && !item.metrics?.pb && !item.metrics?.total_market_cap_yi
    ).length;
    const missingIndustry = list.filter(item => !item.industry).length;
    const total = list.length || 1;
    return {
      missingValuation,
      missingIndustry,
      valuationCompleteness: ((total - missingValuation) / total) * 100,
      industryCompleteness: ((total - missingIndustry) / total) * 100,
    };
  }, [data]);

  const syncCandidateProfiles = async () => {
    const candidates = data?.recommendations || [];
    if (candidates.length === 0) {
      message.warning('暂无候选标的可补全');
      return;
    }

    setProfileLoading(true);
    try {
      const response = await api.post('/ai/recommendations/sync-profiles', {
        symbols: candidates.map(item => item.symbol),
        limit: candidates.length,
      });
      const result = response.data.data;
      message.success(`画像补全完成：成功 ${result.success}，失败 ${result.failed}`);
      await fetchRecommendations();
    } catch (error: any) {
      message.error(error.response?.data?.message || '补全股票画像失败');
    } finally {
      setProfileLoading(false);
    }
  };

  const submitTopToTradingAgents = async () => {
    if (topItems.length === 0) {
      message.warning('暂无可提交的候选标的');
      return;
    }

    setAnalyzeLoading(true);
    try {
      const response = await api.post('/ai/recommendations/analyze', {
        symbols: topItems,
        max_count: topItems.length,
      });
      const submitted = response.data.data?.submitted || [];
      const failed = response.data.data?.failed || [];
      message.success(
        `已提交 ${submitted.length} 个深度研报任务${
          failed.length ? `，失败 ${failed.length} 个` : ''
        }`
      );
    } catch (error: any) {
      message.error(error.response?.data?.message || '提交 TradingAgents 深度研报失败');
    } finally {
      setAnalyzeLoading(false);
    }
  };

  const archiveCurrentRecommendations = async () => {
    const candidates = data?.recommendations || [];
    if (candidates.length === 0) {
      message.warning('暂无候选标的可归档');
      return;
    }

    setArchiveLoading(true);
    try {
      const response = await api.post('/ai/recommendations/archive', {
        candidates,
        universe,
        style,
        as_of: data?.as_of,
        verify: true,
      });
      const result = response.data.data;
      const sync = result?.sync || {};
      message.success(
        `已归档 ${sync.total || 0} 条候选信号，新增 ${sync.created || 0}，更新 ${sync.updated || 0}`
      );
      if (result?.stats) {
        setSignalStats(result.stats);
      } else {
        await fetchSignalStats();
      }
    } catch (error: any) {
      message.error(error.response?.data?.message || '归档候选后验信号失败');
    } finally {
      setArchiveLoading(false);
    }
  };

  const openAIAdvisor = (symbol: string) => {
    localStorage.setItem('aiAdvisor_ticker', symbol);
    navigate(`/ai-advisor?ticker=${encodeURIComponent(symbol)}`);
  };

  const renderReturn = (value?: number | null) => {
    if (value === undefined || value === null) return <Text type="secondary">--</Text>;
    const color = value > 0 ? '#cf1322' : value < 0 ? '#3f8600' : '#64748b';
    return <Text style={{ color, fontWeight: 700 }}>{value.toFixed(2)}%</Text>;
  };

  const horizonStats = useMemo(
    () =>
      Object.entries(signalStats?.horizon_summary || {}).sort(
        ([a], [b]) => Number(a.replace('d', '')) - Number(b.replace('d', ''))
      ),
    [signalStats]
  );

  const columns = [
    {
      title: '候选标的',
      key: 'stock',
      width: 220,
      render: (_: any, record: RecommendationItem) => (
        <Space direction="vertical" size={2}>
          <Space>
            <Text strong>{record.name}</Text>
            <Tag color="blue">{record.rating}</Tag>
          </Space>
          <Text type="secondary">
            {record.symbol} · {record.industry || record.market || '未分类'}
          </Text>
        </Space>
      ),
    },
    {
      title: '综合分',
      dataIndex: 'score',
      key: 'score',
      width: 150,
      sorter: (a: RecommendationItem, b: RecommendationItem) => a.score - b.score,
      render: (score: number) => (
        <Space direction="vertical" size={0} style={{ width: 120 }}>
          <Text strong style={{ color: score >= 75 ? '#cf1322' : '#faad14', fontSize: 18 }}>
            {score.toFixed(1)}
          </Text>
          <Progress percent={Math.round(score)} size="small" showInfo={false} />
        </Space>
      ),
    },
    {
      title: '价格 / 20日',
      key: 'price',
      width: 140,
      render: (_: any, record: RecommendationItem) => (
        <Space direction="vertical" size={0}>
          <Text strong>{record.current_price}</Text>
          {renderReturn(record.metrics?.return_20d)}
        </Space>
      ),
    },
    {
      title: '后验反馈',
      key: 'feedback',
      width: 150,
      render: (_: any, record: RecommendationItem) => {
        const feedback = record.feedback;
        if (!feedback || feedback.signal_count === 0) {
          return <Text type="secondary">暂无样本</Text>;
        }
        const adjustment = Number(feedback.score_adjustment || 0);
        return (
          <Space direction="vertical" size={2}>
            <Text strong style={{ color: adjustment >= 0 ? '#cf1322' : '#3f8600' }}>
              {adjustment >= 0 ? '+' : ''}
              {adjustment.toFixed(1)} 分
            </Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {feedback.completed_count}样本 · 胜率 {feedback.positive_rate ?? '--'}%
            </Text>
            {feedback.avg_return_pct !== null && renderReturn(feedback.avg_return_pct)}
          </Space>
        );
      },
    },
    {
      title: '风险',
      key: 'risk',
      width: 100,
      render: (_: any, record: RecommendationItem) => (
        <Tag color={riskColorMap[record.risk_level]}>{record.risk_level.toUpperCase()}</Tag>
      ),
    },
    {
      title: '近期趋势',
      key: 'trend',
      width: 170,
      render: (_: any, record: RecommendationItem) => {
        const trend = record.trend || [];
        if (trend.length === 0) return <Text type="secondary">暂无</Text>;
        const isUp = trend[trend.length - 1].close >= trend[0].close;
        const color = isUp ? '#cf1322' : '#3f8600';
        return (
          <div style={{ height: 42, width: 150 }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={trend}>
                <defs>
                  <linearGradient id={`recommend-${record.symbol}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={color} stopOpacity={0.28} />
                    <stop offset="95%" stopColor={color} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <Area
                  type="monotone"
                  dataKey="close"
                  stroke={color}
                  strokeWidth={1.6}
                  fill={`url(#recommend-${record.symbol})`}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        );
      },
    },
    {
      title: '解释',
      key: 'reasons',
      render: (_: any, record: RecommendationItem) => (
        <Space direction="vertical" size={4} style={{ maxWidth: 520 }}>
          {record.reasons.slice(0, 2).map(reason => (
            <Text key={reason}>{reason}</Text>
          ))}
          {record.warnings.slice(0, 2).map(warning => (
            <Tag key={warning} color="orange">
              {warning}
            </Tag>
          ))}
          <Space wrap size={[4, 4]}>
            {record.factors.slice(0, 5).map(factor => (
              <Tag
                key={factor.name}
                color={factor.score >= 70 ? 'green' : factor.score >= 55 ? 'blue' : 'default'}
              >
                {factor.label} {factor.score.toFixed(0)}
              </Tag>
            ))}
          </Space>
        </Space>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 150,
      render: (_: any, record: RecommendationItem) => (
        <Space direction="vertical" size="small">
          <Button
            type="primary"
            size="small"
            icon={<RobotOutlined />}
            onClick={() => openAIAdvisor(record.symbol)}
          >
            深度推演
          </Button>
          <Button size="small" onClick={() => navigator.clipboard?.writeText(record.symbol)}>
            复制代码
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div className="fade-in-up">
      <div className="page-header-modern">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            width: '100%',
          }}
        >
          <div>
            <h1 className="page-title-modern">智能候选推荐</h1>
            <p className="page-subtitle-modern">
              本地行情多因子初筛 + TradingAgents 深度研报，先筛候选池，再做智能体复核
            </p>
          </div>
          <Space wrap>
            <Select
              value={universe}
              onChange={setUniverse}
              options={universeOptions}
              style={{ width: 150 }}
            />
            <Select
              value={style}
              onChange={setStyle}
              options={styleOptions}
              style={{ width: 130 }}
            />
            <Select
              value={limit}
              onChange={setLimit}
              options={[10, 20, 30, 50].map(value => ({ label: `${value}只`, value }))}
              style={{ width: 90 }}
            />
            <Button icon={<ReloadOutlined />} onClick={fetchRecommendations} loading={loading}>
              刷新
            </Button>
            <Button onClick={syncCandidateProfiles} loading={profileLoading}>
              补全画像
            </Button>
            <Button
              icon={<DatabaseOutlined />}
              onClick={archiveCurrentRecommendations}
              loading={archiveLoading}
            >
              归档后验
            </Button>
            <Button
              icon={<FundProjectionScreenOutlined />}
              onClick={() => navigate('/recommendation-performance')}
            >
              绩效实验室
            </Button>
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              onClick={submitTopToTradingAgents}
              loading={analyzeLoading}
            >
              Top5 深度研报
            </Button>
          </Space>
        </div>
      </div>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="推荐逻辑说明"
        description={`该页面使用趋势动量、量能活跃、基础质量、估值安全、风险约束和历史后验反馈进行可解释排序。当前候选估值完整度 ${profileQuality.valuationCompleteness.toFixed(
          0
        )}%，行业完整度 ${profileQuality.industryCompleteness.toFixed(0)}%；已有 ${
          feedbackOverview.tracked
        } 只候选具备历史推荐反馈，平均反馈调分 ${feedbackOverview.avgAdjustment.toFixed(1)}。`}
      />

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={12} md={6}>
          <Card className="modern-card" variant="borderless">
            <Statistic
              title="候选样本"
              value={data?.total_candidates || 0}
              prefix={<ExperimentOutlined />}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card className="modern-card" variant="borderless">
            <Statistic
              title="有效评分"
              value={data?.analyzed_candidates || 0}
              prefix={<BarChartOutlined />}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card className="modern-card" variant="borderless">
            <Statistic title="平均得分" value={avgScore} precision={1} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card className="modern-card" variant="borderless">
            <Statistic
              title="高分候选"
              value={(data?.recommendations || []).filter(item => item.score >= 70).length}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card className="modern-card" variant="borderless">
            <Statistic
              title="估值完整度"
              value={profileQuality.valuationCompleteness}
              precision={0}
              suffix="%"
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card className="modern-card" variant="borderless">
            <Statistic title="后验覆盖" value={feedbackOverview.tracked} suffix="只" />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card className="modern-card" variant="borderless">
            <Statistic
              title="反馈调分"
              value={feedbackOverview.avgAdjustment}
              precision={1}
              valueStyle={{ color: feedbackOverview.avgAdjustment >= 0 ? '#cf1322' : '#3f8600' }}
            />
          </Card>
        </Col>
      </Row>

      <Card
        className="modern-card"
        variant="borderless"
        title="量化初筛后验表现"
        extra={
          <Button size="small" onClick={fetchSignalStats} loading={statsLoading}>
            刷新统计
          </Button>
        }
        style={{ marginBottom: 16 }}
      >
        <Row gutter={[16, 16]} align="middle">
          <Col xs={24} md={5}>
            <Statistic
              title="已归档量化信号"
              value={signalStats?.total_signals || 0}
              prefix={<DatabaseOutlined />}
            />
          </Col>
          <Col xs={24} md={5}>
            <Statistic
              title="买入/强买信号"
              value={
                (signalStats?.by_decision?.buy?.count || 0) +
                (signalStats?.by_decision?.strong_buy?.count || 0)
              }
            />
          </Col>
          <Col xs={24} md={14}>
            {horizonStats.length > 0 ? (
              <Space wrap size={[12, 8]}>
                {horizonStats.map(([horizon, stats]) => (
                  <Card key={horizon} size="small" style={{ minWidth: 132 }}>
                    <Statistic
                      title={`${horizon} 平均收益`}
                      value={stats.avg_return_pct}
                      precision={2}
                      suffix="%"
                      valueStyle={{ color: stats.avg_return_pct >= 0 ? '#cf1322' : '#3f8600' }}
                    />
                    <Text type="secondary">
                      胜率 {stats.positive_rate ?? 0}% · 样本 {stats.count}
                    </Text>
                  </Card>
                ))}
              </Space>
            ) : (
              <Text type="secondary">
                暂无完成的后验样本。点击“归档后验”后，系统会按 1/3/5/10/20 交易日持续验证收益。
              </Text>
            )}
          </Col>
        </Row>
      </Card>

      <Card
        className="modern-card"
        variant="borderless"
        title="多因子候选池"
        extra={<Text type="secondary">更新时间：{data?.as_of || '--'}</Text>}
      >
        <Table
          columns={columns}
          dataSource={data?.recommendations || []}
          rowKey="symbol"
          loading={loading}
          pagination={{ pageSize: 10, showSizeChanger: false }}
          expandable={{
            expandedRowRender: record => (
              <Row gutter={[16, 16]}>
                {record.feedback && record.feedback.signal_count > 0 && (
                  <Col xs={24} md={8} lg={6} key="feedback-summary">
                    <Card size="small" title="历史后验反馈">
                      <Statistic
                        title="综合调分"
                        value={record.feedback.score_adjustment}
                        precision={1}
                        valueStyle={{
                          color: record.feedback.score_adjustment >= 0 ? '#cf1322' : '#3f8600',
                        }}
                      />
                      <Paragraph style={{ marginBottom: 0, marginTop: 8 }}>
                        历史信号 {record.feedback.signal_count} 次，完成样本{' '}
                        {record.feedback.completed_count} 个，平均收益{' '}
                        {record.feedback.avg_return_pct ?? '--'}%，胜率{' '}
                        {record.feedback.positive_rate ?? '--'}%。
                      </Paragraph>
                    </Card>
                  </Col>
                )}
                {record.factors.map(factor => (
                  <Col xs={24} md={8} lg={6} key={factor.name}>
                    <Card size="small" title={factor.label}>
                      <Progress percent={Math.round(factor.score)} size="small" />
                      <Paragraph style={{ marginBottom: 0, marginTop: 8 }}>
                        {factor.reason}
                      </Paragraph>
                    </Card>
                  </Col>
                ))}
              </Row>
            ),
          }}
          locale={{ emptyText: <Empty description="暂无候选结果，请先同步行情或添加自选股" /> }}
        />
      </Card>
    </div>
  );
};

export default Recommendations;
