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
  GlobalOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  RobotOutlined,
  RocketOutlined,
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
  avg_excess_return_pct?: number | null;
  positive_rate: number | null;
  excess_positive_rate?: number | null;
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
  action?: 'buy' | 'watch' | 'hold' | 'avoid';
  action_label?: string;
  suggested_position_pct?: number;
  stop_loss_pct?: number;
  take_profit_pct?: number;
  metrics: Record<string, number | null>;
  feedback?: RecommendationFeedback;
  recommendation_tier?: 'strong_recommend' | 'trial_position' | 'watchlist' | 'avoid';
  recommendation_tier_label?: string;
  tier_reason?: string;
  tier_rank?: number;
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
      avg_excess_return_pct?: number;
      positive_count: number;
      positive_rate?: number;
      excess_positive_rate?: number;
    }
  >;
}

interface AutoTradeItem {
  symbol: string;
  name?: string;
  quantity?: number;
  execute_price?: number;
  amount?: number;
  target_position_pct?: number;
  stop_loss_pct?: number;
  take_profit_pct?: number;
  reason?: string;
}

interface AutoTradeResult {
  dry_run: boolean;
  scanned: number;
  eligible: number;
  executed: number;
  planned: number;
  skipped: number;
  trades: AutoTradeItem[];
  skipped_items: AutoTradeItem[];
  snapshot?: {
    total_value: number;
    current_cash: number;
    position_value: number;
  };
  profit_gate_policy?: {
    enabled: boolean;
    allow_entries: boolean;
    horizon: string;
    min_samples: number;
    min_quality_score: number;
    completed_samples: number;
    quality_score: number;
    gate_label?: string;
    effective_position_multiplier: number;
    reason?: string;
  };
}

interface AutoLoopResult {
  generated?: RecommendationResponse;
  archive?: {
    total?: number;
    created?: number;
    updated?: number;
    verification?: any;
  };
  agent_analysis?: {
    enabled?: boolean;
    submitted?: Array<{ symbol: string; name?: string; task_id?: string; score?: number }>;
    failed?: Array<{ symbol: string; name?: string; error?: string }>;
  };
  verification?: {
    total?: number;
    verified?: number;
    pending?: number;
    no_data?: number;
  };
  paper_trading?: AutoTradeResult;
  quality_report?: {
    overview?: any;
  };
}

const riskColorMap: Record<string, string> = {
  low: 'green',
  medium: 'gold',
  high: 'red',
};

const actionColorMap: Record<string, string> = {
  buy: 'red',
  watch: 'blue',
  hold: 'gold',
  avoid: 'default',
};

const tierColorMap: Record<string, string> = {
  strong_recommend: 'volcano',
  trial_position: 'gold',
  watchlist: 'blue',
  avoid: 'default',
};

const tierToneMap: Record<string, { title: string; subtitle: string; className: string }> = {
  strong_recommend: {
    title: '强推荐池',
    subtitle: '高分、低风险、无硬警告，优先提交 Agent 复核',
    className: 'strong',
  },
  trial_position: {
    title: '轻仓试错池',
    subtitle: '具备交易候选价值，仅适合小仓或 dry-run 验证',
    className: 'trial',
  },
  watchlist: {
    title: '观察池',
    subtitle: '有机会但条件未完全共振，先跟踪不买入',
    className: 'watch',
  },
  avoid: {
    title: '回避池',
    subtitle: '风险或后验表现不满足自动交易要求',
    className: 'avoid',
  },
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
  const [autoLoopLoading, setAutoLoopLoading] = useState(false);
  const [autoLoopResult, setAutoLoopResult] = useState<AutoLoopResult | null>(null);
  const [autoTradeLoading, setAutoTradeLoading] = useState(false);
  const [autoTradePreviewLoading, setAutoTradePreviewLoading] = useState(false);
  const [autoTradeResult, setAutoTradeResult] = useState<AutoTradeResult | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [signalStats, setSignalStats] = useState<SignalStats | null>(null);
  const [style, setStyle] = useState('balanced');
  const [universe, setUniverse] = useState('market');
  const [limit, setLimit] = useState(20);

  const fetchRecommendations = async () => {
    setLoading(true);
    try {
      const response = await api.get('/ai/recommendations', {
        params: {
          style,
          universe,
          limit,
          candidate_pool_limit: universe === 'market' ? Math.max(limit * 12, 240) : undefined,
          min_market_cap_yi: universe === 'market' ? 30 : undefined,
          exclude_st: true,
        },
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

  const runPaperTradingSync = async (dryRun: boolean) => {
    const setRunning = dryRun ? setAutoTradePreviewLoading : setAutoTradeLoading;
    setRunning(true);
    try {
      const response = await api.post('/paper-trading/auto-sync-recommendations', {
        refresh_recommendations: true,
        universe,
        style,
        candidate_limit: Math.max(limit, 10),
        candidate_pool_limit: universe === 'market' ? Math.max(limit * 12, 240) : undefined,
        lookback_days: 120,
        source_type: 'quant_recommendation',
        limit: 3,
        scan_limit: 100,
        min_score: 72,
        max_positions: 8,
        default_position_pct: 5,
        max_position_pct: 10,
        min_trade_amount: 3000,
        require_action_buy: true,
        use_profit_gate: true,
        profit_gate_horizon: '5d',
        profit_gate_min_samples: 5,
        profit_gate_min_quality_score: 45,
        dry_run: dryRun,
        report_to_feishu: !dryRun,
      });
      const result = response.data.data as AutoTradeResult;
      setAutoTradeResult(result);
      message.success(
        dryRun
          ? `预演完成：计划 ${result.planned || result.trades?.length || 0} 笔，跳过 ${
              result.skipped || 0
            } 条`
          : `模拟跟单完成：成交 ${result.executed || 0} 笔，跳过 ${result.skipped || 0} 条`
      );
      if (!dryRun) {
        await fetchSignalStats();
      }
    } catch (error: any) {
      message.error(error.response?.data?.message || '模拟盘跟单执行失败');
    } finally {
      setRunning(false);
    }
  };

  const runAutomatedLoop = async () => {
    setAutoLoopLoading(true);
    try {
      const response = await api.post('/ai/recommendations/auto-loop', {
        universe,
        style,
        candidate_limit: Math.max(limit, 20),
        candidate_pool_limit: universe === 'market' ? Math.max(limit * 12, 240) : undefined,
        lookback_days: 120,
        archive_limit: Math.max(limit, 20),
        verify_signals: true,
        submit_agent_analysis: true,
        agent_max_count: 5,
        agent_min_score: 72,
        agent_session: 'close',
        run_paper_trading: true,
        dry_run: true,
        paper_trade_limit: 3,
        use_profit_gate: true,
        profit_gate_horizon: '5d',
        profit_gate_min_samples: 5,
        profit_gate_min_quality_score: 45,
        report_to_feishu: false,
      });
      const result = response.data.data as AutoLoopResult;
      setAutoLoopResult(result);
      if (result.generated) setData(result.generated);
      if (result.paper_trading) setAutoTradeResult(result.paper_trading);
      await fetchSignalStats();
      message.success(
        `闭环完成：归档 ${result.archive?.total || 0} 条，Agent 提交 ${
          result.agent_analysis?.submitted?.length || 0
        } 个，模拟盘预演 ${result.paper_trading?.planned || 0} 笔`
      );
    } catch (error: any) {
      message.error(error.response?.data?.message || '全市场荐股闭环执行失败');
    } finally {
      setAutoLoopLoading(false);
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

  const tierBuckets = useMemo(() => {
    const list = data?.recommendations || [];
    const buckets = ['strong_recommend', 'trial_position', 'watchlist', 'avoid'].map(key => {
      const items = list.filter(item => (item.recommendation_tier || 'watchlist') === key);
      const avg =
        items.length > 0
          ? items.reduce((sum, item) => sum + Number(item.score || 0), 0) / items.length
          : 0;
      const maxPosition = items.reduce(
        (sum, item) => sum + Number(item.suggested_position_pct || 0),
        0
      );
      return {
        key,
        items,
        avg_score: avg,
        planned_position_pct: maxPosition,
        ...(tierToneMap[key] || tierToneMap.watchlist),
      };
    });
    return buckets;
  }, [data]);

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
            <Tag color={tierColorMap[record.recommendation_tier || 'watchlist']}>
              {record.recommendation_tier_label || '观察池'}
            </Tag>
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
      width: 150,
      render: (_: any, record: RecommendationItem) => (
        <Space direction="vertical" size={4}>
          <Tag color={riskColorMap[record.risk_level]}>{record.risk_level.toUpperCase()}</Tag>
          {record.action_label && (
            <Tag color={actionColorMap[record.action || 'hold']}>{record.action_label}</Tag>
          )}
          {record.tier_reason && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {record.tier_reason}
            </Text>
          )}
        </Space>
      ),
    },
    {
      title: '仓位纪律',
      key: 'position_plan',
      width: 150,
      render: (_: any, record: RecommendationItem) => (
        <Space direction="vertical" size={2}>
          <Text strong>{record.suggested_position_pct ?? 0}%</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            止损 {record.stop_loss_pct ?? '--'}% · 止盈 {record.take_profit_pct ?? '--'}%
          </Text>
        </Space>
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
              全市场机会雷达 + 可解释多因子初筛 + 后验超额收益反哺，形成自动荐股闭环
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
              ghost
              icon={<GlobalOutlined />}
              onClick={runAutomatedLoop}
              loading={autoLoopLoading}
            >
              跑全市场闭环
            </Button>
            <Button
              icon={<PlayCircleOutlined />}
              onClick={() => runPaperTradingSync(true)}
              loading={autoTradePreviewLoading}
            >
              预演跟单
            </Button>
            <Button
              icon={<RocketOutlined />}
              onClick={() => runPaperTradingSync(false)}
              loading={autoTradeLoading}
            >
              一键模拟跟单
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
        message={universe === 'market' ? '全市场自动发现模式已开启' : '自选池优先模式'}
        description={`系统会先用趋势动量、量能活跃、基础质量、估值安全、风险约束做初筛，再用历史后验反馈和基准超额收益给候选降权/加权。当前候选估值完整度 ${profileQuality.valuationCompleteness.toFixed(
          0
        )}%，行业完整度 ${profileQuality.industryCompleteness.toFixed(0)}%；已有 ${
          feedbackOverview.tracked
        } 只候选具备历史推荐反馈，平均反馈调分 ${feedbackOverview.avgAdjustment.toFixed(
          1
        )}。每日“全市场荐股闭环”会自动归档、验证并接入模拟盘。`}
      />

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        {tierBuckets.map(bucket => (
          <Col xs={24} sm={12} xl={6} key={bucket.key}>
            <div className={`recommendation-tier-card ${bucket.className}`}>
              <div className="recommendation-tier-head">
                <div>
                  <span>{bucket.title}</span>
                  <strong>{bucket.items.length}</strong>
                </div>
                <Tag color={tierColorMap[bucket.key]}>{bucket.avg_score.toFixed(1)}均分</Tag>
              </div>
              <p>{bucket.subtitle}</p>
              <div className="recommendation-tier-meta">
                <em>计划仓位 {bucket.planned_position_pct.toFixed(1)}%</em>
                <em>Top {bucket.items[0]?.name || '--'}</em>
              </div>
              <Space wrap size={[6, 6]} style={{ marginTop: 12 }}>
                {bucket.items.slice(0, 4).map(item => (
                  <Tag key={item.symbol} color={tierColorMap[bucket.key]}>
                    {item.name || item.symbol} {item.score.toFixed(0)}
                  </Tag>
                ))}
                {bucket.items.length === 0 && <Text type="secondary">暂无标的</Text>}
              </Space>
            </div>
          </Col>
        ))}
      </Row>

      {autoTradeResult && (
        <Card
          className="modern-card"
          variant="borderless"
          style={{
            marginBottom: 16,
            background:
              'linear-gradient(135deg, rgba(15,23,42,0.96), rgba(30,41,59,0.94) 48%, rgba(127,29,29,0.88))',
            border: '1px solid rgba(248,250,252,0.12)',
            boxShadow: '0 18px 46px rgba(15,23,42,0.18)',
          }}
        >
          <Row gutter={[16, 16]} align="middle">
            <Col xs={24} md={7}>
              <Space direction="vertical" size={4}>
                <Tag color={autoTradeResult.dry_run ? 'blue' : 'red'}>
                  {autoTradeResult.dry_run ? '纸面预演' : '已写入模拟盘'}
                </Tag>
                <Text style={{ color: '#f8fafc', fontSize: 18, fontWeight: 800 }}>
                  推荐信号 → 模拟盘闭环回执
                </Text>
                <Text style={{ color: 'rgba(248,250,252,0.68)' }}>
                  扫描 {autoTradeResult.scanned} 条，符合 {autoTradeResult.eligible} 条，跳过{' '}
                  {autoTradeResult.skipped} 条
                </Text>
                {autoTradeResult.profit_gate_policy?.enabled && (
                  <Text style={{ color: 'rgba(254,226,226,0.86)' }}>
                    Profit Gate：{autoTradeResult.profit_gate_policy.gate_label || '--'} · 质量分{' '}
                    {autoTradeResult.profit_gate_policy.quality_score}/
                    {autoTradeResult.profit_gate_policy.min_quality_score} · 仓位倍率{' '}
                    {autoTradeResult.profit_gate_policy.effective_position_multiplier}x
                  </Text>
                )}
              </Space>
            </Col>
            <Col xs={12} md={4}>
              <Statistic
                title={<span style={{ color: 'rgba(248,250,252,0.7)' }}>成交/计划</span>}
                value={autoTradeResult.dry_run ? autoTradeResult.planned : autoTradeResult.executed}
                suffix="笔"
                valueStyle={{ color: '#fecaca' }}
              />
            </Col>
            <Col xs={12} md={4}>
              <Statistic
                title={<span style={{ color: 'rgba(248,250,252,0.7)' }}>总资产</span>}
                value={autoTradeResult.snapshot?.total_value || 0}
                precision={0}
                prefix="¥"
                valueStyle={{ color: '#f8fafc' }}
              />
            </Col>
            <Col xs={24} md={9}>
              {autoTradeResult.trades?.length > 0 ? (
                <Space wrap>
                  {autoTradeResult.trades.slice(0, 4).map(item => (
                    <Tag key={item.symbol} color="volcano">
                      {item.name || item.symbol} · {item.quantity}股 · {item.target_position_pct}%
                    </Tag>
                  ))}
                </Space>
              ) : (
                <Text style={{ color: 'rgba(248,250,252,0.72)' }}>
                  本轮没有可执行标的：
                  {autoTradeResult.skipped_items?.[0]?.reason ||
                    '可能是持仓已满、风险过滤或资金不足'}
                </Text>
              )}
            </Col>
          </Row>
        </Card>
      )}

      {autoLoopResult && (
        <Card
          className="modern-card"
          variant="borderless"
          style={{
            marginBottom: 16,
            background:
              'linear-gradient(135deg, rgba(2,44,34,0.96), rgba(6,78,59,0.9) 42%, rgba(15,23,42,0.96))',
            border: '1px solid rgba(167,243,208,0.18)',
            boxShadow: '0 18px 46px rgba(6,78,59,0.16)',
          }}
        >
          <Row gutter={[16, 16]} align="middle">
            <Col xs={24} md={7}>
              <Space direction="vertical" size={4}>
                <Tag color="green">自动荐股闭环</Tag>
                <Text style={{ color: '#f0fdf4', fontSize: 18, fontWeight: 800 }}>
                  全市场扫描 → 归档验证 → Agent复核 → 模拟盘预演
                </Text>
                <Text style={{ color: 'rgba(220,252,231,0.72)' }}>
                  候选 {autoLoopResult.generated?.analyzed_candidates || 0}/
                  {autoLoopResult.generated?.total_candidates || 0}，归档{' '}
                  {autoLoopResult.archive?.total || 0} 条
                </Text>
              </Space>
            </Col>
            <Col xs={12} md={4}>
              <Statistic
                title={<span style={{ color: 'rgba(220,252,231,0.7)' }}>Agent提交</span>}
                value={autoLoopResult.agent_analysis?.submitted?.length || 0}
                suffix="个"
                valueStyle={{ color: '#bbf7d0' }}
              />
            </Col>
            <Col xs={12} md={4}>
              <Statistic
                title={<span style={{ color: 'rgba(220,252,231,0.7)' }}>验证完成</span>}
                value={autoLoopResult.verification?.verified || 0}
                suffix="条"
                valueStyle={{ color: '#f0fdf4' }}
              />
            </Col>
            <Col xs={12} md={4}>
              <Statistic
                title={<span style={{ color: 'rgba(220,252,231,0.7)' }}>质量分</span>}
                value={autoLoopResult.quality_report?.overview?.quality_score || 0}
                valueStyle={{ color: '#fde68a' }}
              />
            </Col>
            <Col xs={24} md={9}>
              {autoLoopResult.agent_analysis?.submitted?.length ? (
                <Space wrap>
                  {autoLoopResult.agent_analysis.submitted.slice(0, 5).map(item => (
                    <Tag key={item.task_id || item.symbol} color="green">
                      {item.name || item.symbol} · {item.score ?? '--'}分
                    </Tag>
                  ))}
                </Space>
              ) : (
                <Text style={{ color: 'rgba(220,252,231,0.72)' }}>
                  本轮没有达到 Agent 复核阈值的候选，系统仍会保留归档后验。
                </Text>
              )}
            </Col>
          </Row>
        </Card>
      )}

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={12} md={6}>
          <Card className="modern-card" variant="borderless">
            <Statistic
              title="候选样本"
              value={data?.total_candidates || 0}
              prefix={universe === 'market' ? <GlobalOutlined /> : <ExperimentOutlined />}
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
                      title={`${horizon} 平均超额`}
                      value={stats.avg_excess_return_pct ?? stats.avg_return_pct}
                      precision={2}
                      suffix="%"
                      valueStyle={{
                        color:
                          (stats.avg_excess_return_pct ?? stats.avg_return_pct) >= 0
                            ? '#cf1322'
                            : '#3f8600',
                      }}
                    />
                    <Text type="secondary">
                      超额胜率 {stats.excess_positive_rate ?? stats.positive_rate ?? 0}% · 样本{' '}
                      {stats.count}
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
                        {record.feedback.completed_count} 个，平均超额{' '}
                        {record.feedback.avg_excess_return_pct ??
                          record.feedback.avg_return_pct ??
                          '--'}
                        %，超额胜率{' '}
                        {record.feedback.excess_positive_rate ??
                          record.feedback.positive_rate ??
                          '--'}
                        %。
                      </Paragraph>
                    </Card>
                  </Col>
                )}
                <Col xs={24} md={8} lg={6} key="action-plan">
                  <Card size="small" title="交易纪律">
                    <Space direction="vertical" size={8}>
                      <Tag color={actionColorMap[record.action || 'hold']}>
                        {record.action_label || '继续观察'}
                      </Tag>
                      <Text>建议单票仓位：{record.suggested_position_pct ?? 0}%</Text>
                      <Text type="secondary">
                        {`止损 ${record.stop_loss_pct ?? '--'}% / 止盈 ${
                          record.take_profit_pct ?? '--'
                        }%`}
                      </Text>
                    </Space>
                  </Card>
                </Col>
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
