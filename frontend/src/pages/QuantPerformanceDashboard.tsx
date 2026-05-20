import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Progress,
  Row,
  Space,
  Statistic,
  Table,
  type TableColumnsType,
  Tag,
  Timeline,
  Typography,
  message,
} from 'antd';
import {
  ApiOutlined,
  BarChartOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  DatabaseOutlined,
  ExperimentOutlined,
  FundProjectionScreenOutlined,
  ReloadOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
  TrophyOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import api from '../services/api';

const { Text } = Typography;

type IndicatorGroup = {
  key: string;
  name: string;
  indicators: string[];
  purpose: string;
  strategies: string[];
};

type BacktestItem = {
  strategy_key: string;
  strategy_name?: string;
  task_name?: string;
  start_date?: string;
  end_date?: string;
  total_return_pct?: number;
  benchmark_return_pct?: number;
  excess_return_pct?: number;
  annual_return_pct?: number;
  max_drawdown_pct?: number;
  sharpe_ratio?: number;
  win_rate?: number;
  trade_count?: number;
};

type OutcomeFamily = {
  key: string;
  label: string;
  description: string;
  total_count: number;
  open_count: number;
  closed_count: number;
  win_rate: number;
  excess_win_rate: number;
  avg_return_pct: number;
  avg_excess_return_pct: number;
  total_pnl: number;
  best_symbol?: string;
  best_name?: string;
  best_return_pct?: number;
  worst_symbol?: string;
  worst_name?: string;
  worst_return_pct?: number;
};

type PortfolioFamily = {
  key: string;
  label: string;
  name: string;
  description: string;
  exists?: boolean;
  portfolio_id?: number | null;
  total_value?: number;
  total_pnl?: number;
  total_return_pct?: number;
  current_cash?: number;
  position_value?: number;
  open_position_count?: number;
  trade_count?: number;
  outcome_count?: number;
  closed_outcome_count?: number;
  win_rate?: number;
  avg_closed_return_pct?: number;
};

type StrategyExperiment = {
  id: number;
  strategy_key: string;
  strategy_name?: string;
  start_date?: string;
  end_date?: string;
  total_return_pct?: number;
  excess_return_pct?: number;
  max_drawdown_pct?: number;
  sharpe_ratio?: number;
  win_rate?: number;
  trade_count?: number;
  rank_score?: number;
  conclusion?: string;
  execution_diagnostics?: Record<string, any>;
};

type ParamEnvironmentSegment = {
  key: string;
  label: string;
  segment_type?: string;
  total_count?: number;
  completed_count?: number;
  pending_count?: number;
  avg_return_pct?: number;
  avg_excess_return_pct?: number;
  win_rate?: number;
  rank_score?: number;
  best_version?: {
    version_key?: string;
    strategy_key?: string;
    strategy_name?: string;
    avg_excess_return_pct?: number;
    completed_count?: number;
    rank_score?: number;
  } | null;
  best_symbol?: string;
  best_name?: string;
  best_return_pct?: number;
};

type ParamTradeAttributionRow = {
  param_version_key: string;
  strategy_keys?: string[];
  total_count?: number;
  open_count?: number;
  closed_count?: number;
  win_rate?: number;
  excess_win_rate?: number;
  avg_return_pct?: number;
  avg_excess_return_pct?: number;
  total_pnl?: number;
  rank_score?: number;
  best_symbol?: string;
  best_name?: string;
  best_return_pct?: number;
  worst_symbol?: string;
  worst_name?: string;
  worst_return_pct?: number;
};

type ScheduleTask = {
  id: number;
  name: string;
  type?: string;
  cron_expression: string;
  is_active: boolean;
  last_run_at?: string;
  last_run_status?: string;
  latest_log?: {
    id: number;
    status: string;
    started_at?: string;
    completed_at?: string;
    error_message?: string;
    total_items?: number;
    completed_items?: number;
    failed_items?: number;
  } | null;
  parameters?: Record<string, any>;
};

type RuntimeHealthCheck = {
  key: string;
  label: string;
  status: 'ok' | 'warn' | 'risk' | string;
  metric?: string;
  conclusion?: string;
};

type RuntimeHealth = {
  generated_at?: string;
  status?: 'ready' | 'warn' | 'risk' | string;
  score?: number;
  summary?: {
    risk_count?: number;
    warn_count?: number;
    check_count?: number;
    enabled_strategy_count?: number;
    policy_ready_strategy_count?: number;
    open_task_count?: number;
    watchdog_task_count?: number;
    factor_min_coverage_rate?: number;
    factor_real_provider_rate?: number;
    conclusion?: string;
  };
  checks?: RuntimeHealthCheck[];
  runtime_schema?: {
    status?: string;
    summary?: {
      required_columns?: number;
      existing_columns?: number;
      missing_columns?: number;
      critical_issues?: number;
      warnings?: number;
    };
    critical_issues?: Array<{ code?: string; message?: string }>;
  };
  factor_coverage?: {
    latest_trade_date?: string | null;
    latest_factor_date?: string | null;
    latest_landed_factor_date?: string | null;
    factor_lag_days?: number | null;
    coverage_status?: string;
    universe_stock_count?: number;
    coverage_rate?: {
      valuation?: number;
      money_flow?: number;
      fundamental?: number;
    };
    source_quality?: {
      real_provider_rate?: number;
      primary_source?: string | null;
    };
  };
};

type DashboardData = {
  generated_at?: string;
  indicator_catalog?: {
    indicator_count: number;
    group_count: number;
    strategy_count: number;
    groups: IndicatorGroup[];
  };
  latest_backtests?: {
    best_strategy?: BacktestItem | null;
    strategy_count?: number;
    leaderboard?: BacktestItem[];
    latest_task?: any;
    overview?: {
      completed_task_count?: number;
      result_count?: number;
      trade_count?: number;
      avg_total_return_pct?: number;
      avg_excess_return_pct?: number;
      positive_result_count?: number;
      positive_result_rate?: number;
      best_total_return_pct?: number;
      best_strategy_key?: string | null;
      latest_result_at?: string | null;
      latest_task_range?: string | null;
    };
    top_results?: BacktestItem[];
  };
  signal_summary?: {
    latest_quant_trade_date?: string | null;
    latest_fusion_signal_date?: string | null;
    quant_signal_count?: number;
    quant_buy_count?: number;
    quant_watch_count?: number;
    quant_avg_score?: number;
    fusion_count?: number;
    fusion_buy_count?: number;
    fusion_watch_count?: number;
    fusion_avg_score?: number;
  };
  schedule_summary?: {
    quant_pipeline_task_count?: number;
    watchdog_task_count?: number;
    tasks?: ScheduleTask[];
  };
  outcome_comparison?: { summary?: any; families?: OutcomeFamily[]; by_strategy_key?: any[] };
  data_quality_center?: {
    quote_persistence?: {
      persisted?: boolean;
      latest_quote_time?: string | null;
      latest_trade_date?: string | null;
      latest_trade_date_snapshot_count?: number;
      latest_trade_date_symbol_count?: number;
      age_minutes?: number | null;
      freshness_status?: string;
      is_fresh?: boolean;
    };
    latest_backtest_task_id?: number | null;
    latest_backtest_task_name?: string | null;
    execution_diagnostics?: Array<{
      strategy_key: string;
      strategy_name?: string;
      execution_diagnostics?: Record<string, any>;
    }>;
    summary?: {
      realtime_persisted?: boolean;
      realtime_fresh?: boolean;
      diagnostics_strategy_count?: number;
      execution_warning_count?: number;
    };
  };
  runtime_health?: RuntimeHealth;
  data_freshness?: {
    status?: 'ok' | 'warn' | 'risk';
    summary?: {
      risk_count?: number;
      warn_count?: number;
      conclusion?: string;
    };
    checks?: Record<
      string,
      {
        status?: 'ok' | 'warn' | 'risk';
        conclusion?: string;
        latest_quote_time?: string | null;
        latest_trade_date?: string | null;
        today_count?: number;
        pending_count?: number;
        completed_count?: number;
        open_count?: number;
        closed_count?: number;
      }
    >;
    issues?: Array<{ key: string; status: string; conclusion: string }>;
  };
  strategy_experiments?: {
    total?: number;
    best?: StrategyExperiment | null;
    by_strategy?: any[];
    experiments?: StrategyExperiment[];
  };
  experiment_param_suggestions?: {
    summary?: {
      experiment_count?: number;
      strategy_count?: number;
      use_count?: number;
      observe_count?: number;
      keep_default_count?: number;
      conclusion?: string;
    };
    suggestions?: Array<{
      strategy_key: string;
      strategy_name?: string;
      action: string;
      confidence?: number;
      stable_count?: number;
      experiment_count?: number;
      reason?: string;
      source_experiment?: StrategyExperiment | null;
    }>;
  };
  param_validation_dashboard?: {
    summary?: {
      version_count?: number;
      active_candidate_count?: number;
      champion_count?: number;
      degraded_count?: number;
      rolled_back_count?: number;
      validation_count?: number;
      completed_count?: number;
      pending_count?: number;
      conclusion?: string;
    };
    champion?: {
      version_key: string;
      strategy_key: string;
      strategy_name?: string;
      version_type?: string;
      status?: string;
      completed_count?: number;
      pending_count?: number;
      avg_return_pct?: number;
      avg_excess_return_pct?: number;
      recent_avg_excess_return_pct?: number;
      win_rate?: number;
      rank_score?: number;
    } | null;
    lifecycle?: {
      summary?: {
        promotion_count?: number;
        degradation_count?: number;
        rollback_count?: number;
        observation_count?: number;
        conclusion?: string;
      };
      environment_guard?: {
        version_count?: number;
        min_positive_environment_buckets?: number;
        max_negative_environment_buckets?: number;
      };
      trade_guard?: {
        version_count?: number;
        degrade_min_closed_samples?: number;
        rollback_min_closed_samples?: number;
        rollback_total_pnl?: number;
      };
      promotions?: any[];
      degradations?: any[];
      rollbacks?: any[];
      observations?: any[];
    };
    environment_attribution?: {
      summary?: {
        market_regime_count?: number;
        industry_regime_count?: number;
        industry_count?: number;
        completed_count?: number;
        conclusion?: string;
        best_market_regime?: ParamEnvironmentSegment | null;
        weakest_market_regime?: ParamEnvironmentSegment | null;
        best_industry_regime?: ParamEnvironmentSegment | null;
      };
      by_market_regime?: ParamEnvironmentSegment[];
      by_industry_regime?: ParamEnvironmentSegment[];
      by_industry?: ParamEnvironmentSegment[];
    };
    trade_attribution?: {
      portfolio_name?: string;
      portfolio_ids?: number[];
      rows?: ParamTradeAttributionRow[];
      summary?: {
        portfolio_count?: number;
        attributed_version_count?: number;
        outcome_count?: number;
        closed_count?: number;
        champion?: ParamTradeAttributionRow | null;
        conclusion?: string;
      };
      error?: string;
    };
    summary_by_version?: Array<{
      version_key: string;
      strategy_key: string;
      strategy_name?: string;
      version_type?: string;
      status?: string;
      total_count?: number;
      completed_count?: number;
      pending_count?: number;
      avg_return_pct?: number;
      avg_excess_return_pct?: number;
      recent_avg_excess_return_pct?: number;
      win_rate?: number;
      rank_score?: number;
      best_symbol?: string;
      best_name?: string;
      best_return_pct?: number;
    }>;
  };
  portfolio_family_comparison?: {
    summary?: {
      family_count?: number;
      active_family_count?: number;
      champion?: PortfolioFamily;
      conclusion?: string;
    } | null;
    families?: PortfolioFamily[];
  };
  readiness?: {
    score: number;
    ready: boolean;
    conclusion: string;
    checks: Array<{ key: string; label: string; ok: boolean }>;
  };
};

const formatPct = (value?: number | string | null, precision = 2) =>
  Number.isFinite(Number(value)) ? `${Number(value).toFixed(precision)}%` : '--';

const formatMoney = (value?: number | string | null) =>
  Number.isFinite(Number(value)) ? `¥${Number(value).toLocaleString()}` : '--';

const formatDateTime = (value?: string | null) => {
  if (!value) return '尚未运行';
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format('MM-DD HH:mm') : value;
};

const familyTone: Record<string, { color: string; icon: React.ReactNode }> = {
  pure_quant: { color: '#2764b8', icon: <ThunderboltOutlined /> },
  agent_fusion: { color: '#b7791f', icon: <RobotOutlined /> },
  agent_only: { color: '#0f8f6b', icon: <RobotOutlined /> },
  ai_daily: { color: '#7c3aed', icon: <ApiOutlined /> },
  other: { color: '#64748b', icon: <FundProjectionScreenOutlined /> },
};

const QuantPerformanceDashboard: React.FC = () => {
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [runtimeHealth, setRuntimeHealth] = useState<RuntimeHealth | null>(null);
  const [loading, setLoading] = useState(false);
  const [runtimeLoading, setRuntimeLoading] = useState(false);

  const fetchRuntimeHealth = async (silent = false) => {
    setRuntimeLoading(true);
    try {
      const response = await api.get('/quant/runtime-health');
      if (response.data.success) {
        setRuntimeHealth(response.data.data || null);
        if (!silent) message.success('量化运行时健康已刷新');
        return response.data.data || null;
      }
    } catch (error: any) {
      if (!silent) message.error(error.response?.data?.message || '获取量化运行时健康失败');
    } finally {
      setRuntimeLoading(false);
    }
    return null;
  };

  const fetchDashboard = async (silent = false) => {
    setLoading(true);
    try {
      const [response, runtimeResponse] = await Promise.allSettled([
        api.get('/quant/performance-dashboard'),
        api.get('/quant/runtime-health'),
      ]);
      if (response.status === 'fulfilled' && response.value.data.success) {
        setDashboard(response.value.data.data || null);
        if (!silent) message.success('量化收益驾驶舱已刷新');
      } else if (response.status === 'rejected') {
        throw response.reason;
      }
      if (runtimeResponse.status === 'fulfilled' && runtimeResponse.value.data.success) {
        setRuntimeHealth(runtimeResponse.value.data.data || null);
      }
    } catch (error: any) {
      message.error(error.response?.data?.message || '获取量化收益驾驶舱失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDashboard(true);
  }, []);

  const best = dashboard?.latest_backtests?.best_strategy || null;
  const backtestOverview = dashboard?.latest_backtests?.overview;
  const indicatorCatalog = dashboard?.indicator_catalog;
  const signalSummary = dashboard?.signal_summary;
  const readiness = dashboard?.readiness;
  const effectiveRuntimeHealth = runtimeHealth || dashboard?.runtime_health || null;
  const dataQuality = dashboard?.data_quality_center;
  const dataFreshness = dashboard?.data_freshness;
  const dataFreshnessChecks = dataFreshness?.checks || {};
  const strategyExperiments = dashboard?.strategy_experiments;
  const experimentParamSuggestions = dashboard?.experiment_param_suggestions;
  const paramValidation = dashboard?.param_validation_dashboard;
  const environmentAttribution = paramValidation?.environment_attribution;
  const paramTradeAttribution = paramValidation?.trade_attribution;
  const portfolioFamilyComparison = dashboard?.portfolio_family_comparison;
  const quotePersistence = dataQuality?.quote_persistence;
  const openTask = useMemo(
    () =>
      (dashboard?.schedule_summary?.tasks || []).find(
        task => task.type === 'QUANT_DAILY_PIPELINE' && String(task.name).includes('开盘')
      ),
    [dashboard]
  );
  const watchdogTask = useMemo(
    () =>
      (dashboard?.schedule_summary?.tasks || []).find(task => task.type === 'QUANT_OPEN_WATCHDOG'),
    [dashboard]
  );
  const closeTask = useMemo(
    () =>
      (dashboard?.schedule_summary?.tasks || []).find(
        task => task.type === 'QUANT_DAILY_PIPELINE' && String(task.name).includes('全市场')
      ),
    [dashboard]
  );
  const families = dashboard?.outcome_comparison?.families || [];
  const pureQuant = families.find(item => item.key === 'pure_quant');
  const agentFusion = families.find(item => item.key === 'agent_fusion');
  const portfolioFamilies = portfolioFamilyComparison?.families || [];
  const topMarketSegments = environmentAttribution?.by_market_regime || [];
  const topIndustrySegments = environmentAttribution?.by_industry_regime || [];
  const paramTradeRows = paramTradeAttribution?.rows || [];

  const backtestColumns: TableColumnsType<BacktestItem> = [
    {
      title: '策略',
      dataIndex: 'strategy_name',
      key: 'strategy_name',
      fixed: 'left' as const,
      width: 180,
      render: (text: string, record: BacktestItem) => (
        <Space direction="vertical" size={0}>
          <Text strong>{text || record.strategy_key}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {record.start_date || '--'} ~ {record.end_date || '--'}
          </Text>
        </Space>
      ),
    },
    {
      title: '总收益',
      dataIndex: 'total_return_pct',
      key: 'total_return_pct',
      sorter: (a: BacktestItem, b: BacktestItem) =>
        Number(a.total_return_pct || 0) - Number(b.total_return_pct || 0),
      render: (value: number) => (
        <Text strong style={{ color: Number(value || 0) >= 0 ? '#b42318' : '#08795f' }}>
          {formatPct(value)}
        </Text>
      ),
    },
    {
      title: '超额',
      dataIndex: 'excess_return_pct',
      key: 'excess_return_pct',
      sorter: (a: BacktestItem, b: BacktestItem) =>
        Number(a.excess_return_pct || 0) - Number(b.excess_return_pct || 0),
      render: (value: number) => formatPct(value),
    },
    {
      title: '基准',
      dataIndex: 'benchmark_return_pct',
      key: 'benchmark_return_pct',
      render: (value: number) => formatPct(value),
    },
    {
      title: '最大回撤',
      dataIndex: 'max_drawdown_pct',
      key: 'max_drawdown_pct',
      render: (value: number) => formatPct(value),
    },
    {
      title: '夏普',
      dataIndex: 'sharpe_ratio',
      key: 'sharpe_ratio',
      render: (value: number) => Number(value || 0).toFixed(2),
    },
    {
      title: '胜率',
      dataIndex: 'win_rate',
      key: 'win_rate',
      render: (value: number) => formatPct(value),
    },
    { title: '交易', dataIndex: 'trade_count', key: 'trade_count' },
  ];

  return (
    <div className="quant-research-page quant-dashboard-page fade-in-up">
      <div className="quant-research-hero quant-dashboard-hero">
        <div>
          <div className="quant-research-kicker">QUANT PERFORMANCE COCKPIT</div>
          <h1>收益驾驶舱</h1>
          <p>
            一页看清「完整量化指标 → 历史收益跑分 → 明日开盘自动推荐 → Agent融合复核 →
            20W模拟盘验证」的闭环状态。这里是决定明天开盘是否值得跟踪的主控台。
          </p>
          <Space wrap>
            <Tag icon={<BarChartOutlined />}>
              完整指标 {indicatorCatalog?.indicator_count || 0} 项
            </Tag>
            <Tag icon={<ExperimentOutlined />}>
              历史跑分 {dashboard?.latest_backtests?.strategy_count || 0} 策略
            </Tag>
            <Tag icon={<RobotOutlined />}>Agent 融合 {signalSummary?.fusion_count || 0} 条</Tag>
            <Tag icon={<DatabaseOutlined />}>
              实时行情 {quotePersistence?.persisted ? '已落盘' : '未落盘'}
            </Tag>
            <Tag icon={<FundProjectionScreenOutlined />}>
              模拟盘闭环 {dashboard?.outcome_comparison?.summary?.total_count || 0} 笔
            </Tag>
          </Space>
        </div>
        <div className="quant-readiness-card">
          <span>OPEN READY</span>
          <strong>{readiness ? `${readiness.score}%` : '--'}</strong>
          <Progress
            percent={readiness?.score || 0}
            showInfo={false}
            strokeColor={readiness?.ready ? '#0f8f6b' : '#d6a64f'}
          />
          <p>{readiness?.conclusion || '正在读取量化闭环状态。'}</p>
          <div className="quant-readiness-checks">
            {(readiness?.checks || []).map(check => (
              <Tag key={check.key} color={check.ok ? 'green' : 'gold'}>
                {check.ok ? '✓' : '!'} {check.label}
              </Tag>
            ))}
          </div>
        </div>
      </div>

      <Card
        className={`modern-card quant-runtime-health-card quant-runtime-health-card--${
          effectiveRuntimeHealth?.status || 'unknown'
        }`}
        variant="borderless"
        loading={(loading && !effectiveRuntimeHealth) || runtimeLoading}
      >
        <div className="quant-section-heading quant-runtime-heading">
          <div>
            <span>RUNTIME HEALTH</span>
            <h2>开盘运行时健康</h2>
          </div>
          <Space wrap>
            <Tag
              color={
                effectiveRuntimeHealth?.status === 'ready'
                  ? 'green'
                  : effectiveRuntimeHealth?.status === 'risk'
                  ? 'red'
                  : 'gold'
              }
            >
              {effectiveRuntimeHealth?.status === 'ready'
                ? '可自动运行'
                : effectiveRuntimeHealth?.status === 'risk'
                ? '有阻断风险'
                : '需要观察'}
            </Tag>
            <Button
              size="small"
              icon={<ReloadOutlined />}
              loading={runtimeLoading}
              onClick={() => fetchRuntimeHealth(false)}
            >
              刷新健康
            </Button>
          </Space>
        </div>
        <div className="quant-runtime-health-layout">
          <div className="quant-runtime-score">
            <span>HEALTH</span>
            <strong>{effectiveRuntimeHealth?.score ?? '--'}</strong>
            <Progress
              percent={Number(effectiveRuntimeHealth?.score || 0)}
              showInfo={false}
              strokeColor={
                effectiveRuntimeHealth?.status === 'ready'
                  ? '#0f8f6b'
                  : effectiveRuntimeHealth?.status === 'risk'
                  ? '#b42318'
                  : '#d6a64f'
              }
            />
            <p>
              {effectiveRuntimeHealth?.summary?.conclusion ||
                '正在检查数据库字段、策略注册、实时行情、参数版本和自动任务。'}
            </p>
            <div className="quant-runtime-score-meta">
              <Tag>风险 {effectiveRuntimeHealth?.summary?.risk_count || 0}</Tag>
              <Tag>观察 {effectiveRuntimeHealth?.summary?.warn_count || 0}</Tag>
              <Tag>策略 {effectiveRuntimeHealth?.summary?.enabled_strategy_count || 0}</Tag>
              <Tag>开盘任务 {effectiveRuntimeHealth?.summary?.open_task_count || 0}</Tag>
              <Tag>
                因子覆盖 {effectiveRuntimeHealth?.summary?.factor_min_coverage_rate ?? '--'}%
              </Tag>
              <Tag>
                真实源 {effectiveRuntimeHealth?.summary?.factor_real_provider_rate ?? '--'}%
              </Tag>
            </div>
            <div className="quant-runtime-factor-strip">
              <span>FACTOR</span>
              <strong>
                {effectiveRuntimeHealth?.factor_coverage?.coverage_status === 'real_ready'
                  ? '真实源就绪'
                  : effectiveRuntimeHealth?.factor_coverage?.coverage_status === 'derived_ready'
                  ? '派生因子可用'
                  : effectiveRuntimeHealth?.factor_coverage?.coverage_status === 'limited'
                  ? '覆盖不足'
                  : '等待落盘'}
              </strong>
              <em>
                因子日{' '}
                {effectiveRuntimeHealth?.factor_coverage?.latest_factor_date ||
                  effectiveRuntimeHealth?.factor_coverage?.latest_landed_factor_date ||
                  '--'}{' '}
                · 主来源{' '}
                {effectiveRuntimeHealth?.factor_coverage?.source_quality?.primary_source || '--'}
              </em>
            </div>
          </div>
          <div className="quant-runtime-check-grid">
            {(effectiveRuntimeHealth?.checks || []).map(item => (
              <div
                className={`quant-runtime-check-item ${item.status || 'unknown'}`}
                key={item.key}
              >
                <span>{item.label}</span>
                <strong>{item.metric || (item.status === 'ok' ? 'OK' : item.status)}</strong>
                <em>{item.conclusion || '等待检查结果'}</em>
              </div>
            ))}
            {!(effectiveRuntimeHealth?.checks || []).length &&
              ['数据库字段', '策略注册', '实时行情', '自动参数', '自动任务', '闭环新鲜度'].map(
                label => (
                  <div className="quant-runtime-check-item unknown" key={label}>
                    <span>{label}</span>
                    <strong>--</strong>
                    <em>等待检查结果</em>
                  </div>
                )
              )}
          </div>
        </div>
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} md={12} xl={6}>
          <Card className="modern-card quant-dashboard-stat" variant="borderless" loading={loading}>
            <Statistic
              title="历史冠军收益"
              value={Number(best?.total_return_pct || 0)}
              precision={2}
              suffix="%"
              prefix={<TrophyOutlined />}
            />
            <Text type="secondary">{best?.strategy_name || '等待历史跑分'}</Text>
          </Card>
        </Col>
        <Col xs={24} md={12} xl={6}>
          <Card className="modern-card quant-dashboard-stat" variant="borderless" loading={loading}>
            <Statistic
              title="纯量化模拟收益"
              value={Number(pureQuant?.avg_return_pct || 0)}
              precision={2}
              suffix="%"
              prefix={<ThunderboltOutlined />}
            />
            <Text type="secondary">
              {pureQuant?.closed_count || 0} 笔闭环 · PnL {formatMoney(pureQuant?.total_pnl)}
            </Text>
          </Card>
        </Col>
        <Col xs={24} md={12} xl={6}>
          <Card className="modern-card quant-dashboard-stat" variant="borderless" loading={loading}>
            <Statistic
              title="Agent融合模拟收益"
              value={Number(agentFusion?.avg_return_pct || 0)}
              precision={2}
              suffix="%"
              prefix={<RobotOutlined />}
            />
            <Text type="secondary">
              {agentFusion?.closed_count || 0} 笔闭环 · PnL {formatMoney(agentFusion?.total_pnl)}
            </Text>
          </Card>
        </Col>
        <Col xs={24} md={12} xl={6}>
          <Card className="modern-card quant-dashboard-stat" variant="borderless" loading={loading}>
            <Statistic
              title="实时行情落盘"
              value={quotePersistence?.latest_trade_date_symbol_count || 0}
              prefix={<DatabaseOutlined />}
            />
            <Text type="secondary">
              {quotePersistence?.latest_trade_date || '--'} ·{' '}
              {quotePersistence?.freshness_status || 'unknown'} ·{' '}
              {quotePersistence?.age_minutes ?? '--'} 分钟
            </Text>
          </Card>
        </Col>
      </Row>

      <Card
        className="modern-card quant-data-freshness-board"
        variant="borderless"
        loading={loading}
      >
        <div className="quant-section-heading">
          <div>
            <span>OPEN CHAIN TRUST</span>
            <h2>今日推荐链路可信度</h2>
          </div>
          <Tag
            color={
              dataFreshness?.status === 'ok'
                ? 'green'
                : dataFreshness?.status === 'risk'
                ? 'red'
                : 'gold'
            }
          >
            风险 {dataFreshness?.summary?.risk_count || 0} / 观察{' '}
            {dataFreshness?.summary?.warn_count || 0}
          </Tag>
        </div>
        <Alert
          type={
            dataFreshness?.status === 'ok'
              ? 'success'
              : dataFreshness?.status === 'risk'
              ? 'error'
              : 'warning'
          }
          showIcon
          message={
            dataFreshness?.summary?.conclusion ||
            '正在读取实时行情、信号归档、Agent融合和模拟盘收益闭环。'
          }
          style={{ marginBottom: 12 }}
        />
        <div className="quant-data-freshness-grid">
          {[
            ['实时行情', dataFreshnessChecks.realtime_quotes],
            ['量化信号', dataFreshnessChecks.quant_signals],
            ['推荐归档', dataFreshnessChecks.archived_quant_recommendations],
            ['Agent融合', dataFreshnessChecks.agent_fusion_audits],
            ['参数A/B', dataFreshnessChecks.param_validations],
            ['模拟盘收益', dataFreshnessChecks.paper_trade_outcomes],
          ].map(([label, item]: any) => (
            <div className={`quant-data-freshness-item ${item?.status || 'unknown'}`} key={label}>
              <span>{label}</span>
              <strong>
                {item?.status === 'ok' ? '正常' : item?.status === 'risk' ? '风险' : '观察'}
              </strong>
              <em>{item?.conclusion || '等待检查结果'}</em>
            </div>
          ))}
        </div>
      </Card>

      <Card className="modern-card quant-execution-board" variant="borderless" loading={loading}>
        <div className="quant-section-heading">
          <div>
            <span>BACKTEST OVERVIEW</span>
            <h2>全市场历史跑分概览</h2>
          </div>
          <Text type="secondary">
            {backtestOverview?.latest_task_range || '等待跑分范围'} · 最近完成{' '}
            {formatDateTime(backtestOverview?.latest_result_at || undefined)}
          </Text>
        </div>
        <Row gutter={[12, 12]} className="quant-backtest-overview-row">
          <Col xs={12} md={6}>
            <Statistic title="完成任务" value={backtestOverview?.completed_task_count || 0} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="策略结果" value={backtestOverview?.result_count || 0} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="交易样本" value={backtestOverview?.trade_count || 0} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic
              title="正收益率"
              value={backtestOverview?.positive_result_rate || 0}
              precision={1}
              suffix="%"
            />
          </Col>
        </Row>
        <Alert
          className="quant-inline-note"
          type={Number(backtestOverview?.result_count || 0) > 0 ? 'success' : 'warning'}
          showIcon
          message={
            Number(backtestOverview?.result_count || 0) > 0
              ? `历史跑分已恢复：${backtestOverview?.result_count || 0} 个策略结果、${
                  backtestOverview?.trade_count || 0
                } 笔交易；平均收益 ${formatPct(
                  backtestOverview?.avg_total_return_pct
                )}，平均超额 ${formatPct(backtestOverview?.avg_excess_return_pct)}。`
              : '暂无历史跑分概览，请先在量化跑分实验室发起一次回测。'
          }
        />
      </Card>

      <Card className="modern-card quant-execution-board" variant="borderless" loading={loading}>
        <div className="quant-section-heading">
          <div>
            <span>TOMORROW OPEN LOOP</span>
            <h2>明日开盘自动运行链路</h2>
          </div>
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => fetchDashboard(false)}>
            刷新状态
          </Button>
        </div>
        <Timeline
          className="quant-open-timeline"
          items={[
            {
              color: openTask?.is_active ? 'green' : 'gold',
              dot: <ClockCircleOutlined />,
              children: (
                <div>
                  <strong>09:35 开盘机会扫描</strong>
                  <p>
                    {openTask
                      ? `${openTask.cron_expression} · ${
                          openTask.is_active ? '已启用' : '未启用'
                        } · 上次${formatDateTime(openTask.last_run_at)}`
                      : '尚未创建开盘量化任务'}
                  </p>
                  <Space wrap size={[6, 6]}>
                    <Tag>全市场</Tag>
                    <Tag>实时价刷新</Tag>
                    <Tag>纯量化模拟盘</Tag>
                    <Tag>Agent复核</Tag>
                    <Tag>20W组合风控</Tag>
                  </Space>
                </div>
              ),
            },
            {
              color:
                watchdogTask?.last_run_status === 'FAILED'
                  ? 'red'
                  : watchdogTask?.is_active
                  ? 'green'
                  : 'gold',
              dot:
                watchdogTask?.last_run_status === 'FAILED' ? (
                  <WarningOutlined />
                ) : (
                  <SafetyCertificateOutlined />
                ),
              children: (
                <div>
                  <strong>09:55 看门狗校验 + 飞书告警</strong>
                  <p>
                    {watchdogTask
                      ? `${watchdogTask.cron_expression} · ${
                          watchdogTask.is_active ? '已启用' : '未启用'
                        } · 最近 ${
                          watchdogTask.latest_log?.status ||
                          watchdogTask.last_run_status ||
                          '等待运行'
                        }`
                      : '尚未创建量化开盘链路看门狗'}
                  </p>
                  <Space wrap size={[6, 6]}>
                    <Tag>任务日志</Tag>
                    <Tag>信号数量</Tag>
                    <Tag>归档数量</Tag>
                    <Tag>行情新鲜度</Tag>
                    <Tag>飞书结论</Tag>
                  </Space>
                  {watchdogTask?.latest_log?.error_message && (
                    <p className="quant-watchdog-error">{watchdogTask.latest_log.error_message}</p>
                  )}
                </div>
              ),
            },
            {
              color: 'blue',
              dot: <ThunderboltOutlined />,
              children: (
                <div>
                  <strong>量化指标先筛</strong>
                  <p>
                    最近 {signalSummary?.latest_quant_trade_date || '--'} 生成
                    {signalSummary?.quant_signal_count || 0} 条信号，均分
                    {Number(signalSummary?.quant_avg_score || 0).toFixed(1)}。
                  </p>
                </div>
              ),
            },
            {
              color: signalSummary?.fusion_count ? 'green' : 'gold',
              dot: <RobotOutlined />,
              children: (
                <div>
                  <strong>Agent 融合复核</strong>
                  <p>
                    最近 {signalSummary?.latest_fusion_signal_date || '--'} 产生
                    {signalSummary?.fusion_count || 0} 条融合审计；买入
                    {signalSummary?.fusion_buy_count || 0}，观察{' '}
                    {signalSummary?.fusion_watch_count || 0}。
                  </p>
                </div>
              ),
            },
            {
              color: closeTask?.is_active ? 'green' : 'blue',
              dot: <SafetyCertificateOutlined />,
              children: (
                <div>
                  <strong>15:32 收盘复扫 + 收益闭环</strong>
                  <p>
                    {closeTask
                      ? `${closeTask.cron_expression} · ${
                          closeTask.last_run_status || '等待运行'
                        } · 用日内结果继续修正策略权重和风控。`
                      : '收盘量化扫描任务尚未读取到。'}
                  </p>
                </div>
              ),
            },
          ]}
        />
      </Card>

      <Card className="modern-card quant-data-quality-board" variant="borderless" loading={loading}>
        <div className="quant-section-heading">
          <div>
            <span>DATA QUALITY CENTER</span>
            <h2>数据质量与真实回测护栏</h2>
          </div>
          <Text type="secondary">避免“看起来赚钱”的脏数据/未来函数，先让信号可信。</Text>
        </div>
        <Row gutter={[12, 12]}>
          <Col xs={24} md={8}>
            <div className="quant-quality-tile">
              <span>实时行情</span>
              <strong>{quotePersistence?.persisted ? '已落盘' : '待落盘'}</strong>
              <p>
                {quotePersistence?.latest_trade_date || '--'} ·{' '}
                {quotePersistence?.latest_trade_date_snapshot_count || 0} 条快照 ·{' '}
                {quotePersistence?.latest_trade_date_symbol_count || 0} 只股票
              </p>
            </div>
          </Col>
          <Col xs={24} md={8}>
            <div className="quant-quality-tile">
              <span>新鲜度</span>
              <strong>{quotePersistence?.is_fresh ? '新鲜' : '需观察'}</strong>
              <p>
                最新 {formatDateTime(quotePersistence?.latest_quote_time || undefined)} · 延迟{' '}
                {quotePersistence?.age_minutes ?? '--'} 分钟
              </p>
            </div>
          </Col>
          <Col xs={24} md={8}>
            <div className="quant-quality-tile">
              <span>A股真实执行诊断</span>
              <strong>{dataQuality?.summary?.execution_warning_count || 0}</strong>
              <p>
                最新跑分：{dataQuality?.latest_backtest_task_name || '等待真实规则跑分'}；覆盖{' '}
                {dataQuality?.summary?.diagnostics_strategy_count || 0} 个策略
              </p>
            </div>
          </Col>
        </Row>
      </Card>

      <Card className="modern-card quant-experiment-board" variant="borderless" loading={loading}>
        <div className="quant-section-heading">
          <div>
            <span>EXPERIMENT LEDGER</span>
            <h2>策略实验版本与真实执行排行</h2>
          </div>
          <Text type="secondary">
            每次跑分完成后自动沉淀参数、收益和执行阻塞，后续用于反向优化策略权重。
          </Text>
        </div>
        <Row gutter={[12, 12]}>
          <Col xs={24} md={8}>
            <div className="quant-quality-tile">
              <span>实验版本</span>
              <strong>{strategyExperiments?.total || 0}</strong>
              <p>已记录的策略参数/真实执行结果，可用于横向比较。</p>
            </div>
          </Col>
          <Col xs={24} md={8}>
            <div className="quant-quality-tile">
              <span>当前冠军</span>
              <strong>
                {strategyExperiments?.best?.rank_score !== undefined
                  ? Number(strategyExperiments.best.rank_score).toFixed(1)
                  : '--'}
              </strong>
              <p>
                {strategyExperiments?.best?.strategy_name ||
                  strategyExperiments?.best?.strategy_key ||
                  '等待跑分实验沉淀'}
              </p>
            </div>
          </Col>
          <Col xs={24} md={8}>
            <div className="quant-quality-tile">
              <span>冠军超额</span>
              <strong>{formatPct(strategyExperiments?.best?.excess_return_pct)}</strong>
              <p>
                回撤 {formatPct(strategyExperiments?.best?.max_drawdown_pct)} · 交易{' '}
                {strategyExperiments?.best?.trade_count || 0} 笔
              </p>
            </div>
          </Col>
        </Row>
        <div className="quant-experiment-list">
          {(strategyExperiments?.experiments || []).slice(0, 5).map(item => {
            const diagnostics = item.execution_diagnostics || {};
            const blocked =
              Number(diagnostics.blocked_buy_count || 0) +
              Number(diagnostics.blocked_sell_count || 0);
            return (
              <div className="quant-experiment-row" key={item.id}>
                <div>
                  <Space wrap size={6}>
                    <strong>{item.strategy_name || item.strategy_key}</strong>
                    <Tag color={Number(item.rank_score || 0) >= 15 ? 'green' : 'blue'}>
                      实验分 {Number(item.rank_score || 0).toFixed(1)}
                    </Tag>
                    <Tag>超额 {formatPct(item.excess_return_pct)}</Tag>
                  </Space>
                  <p>{item.conclusion || '暂无实验结论'}</p>
                </div>
                <div>
                  <Text type="secondary">
                    {item.start_date || '--'} ~ {item.end_date || '--'}
                  </Text>
                  <Text type="secondary">
                    成交 {diagnostics.buy_fill_count || 0}/{diagnostics.buy_attempt_count || 0} ·
                    阻塞 {blocked}
                  </Text>
                </div>
              </div>
            );
          })}
          {!strategyExperiments?.experiments?.length && <Empty description="暂无策略实验版本" />}
        </div>
      </Card>

      <Card
        className="modern-card quant-param-suggestion-board"
        variant="borderless"
        loading={loading}
      >
        <div className="quant-section-heading">
          <div>
            <span>PARAMETER FEEDBACK</span>
            <h2>实验参数反哺开盘扫描</h2>
          </div>
          <Text type="secondary">
            从真实执行跑分中挑选稳定领先的参数，自动生成明日开盘 `params_by_strategy`
            建议；未达标的策略保持默认。
          </Text>
        </div>
        <Row gutter={[12, 12]}>
          <Col xs={24} md={8}>
            <div className="quant-quality-tile">
              <span>自动采用</span>
              <strong>{experimentParamSuggestions?.summary?.use_count || 0}</strong>
              <p>{experimentParamSuggestions?.summary?.conclusion || '等待实验参数沉淀。'}</p>
            </div>
          </Col>
          <Col xs={24} md={8}>
            <div className="quant-quality-tile">
              <span>观察中</span>
              <strong>{experimentParamSuggestions?.summary?.observe_count || 0}</strong>
              <p>有实验样本但尚未同时满足收益、回撤、成交与稳定门槛。</p>
            </div>
          </Col>
          <Col xs={24} md={8}>
            <div className="quant-quality-tile">
              <span>默认参数</span>
              <strong>{experimentParamSuggestions?.summary?.keep_default_count || 0}</strong>
              <p>
                覆盖 {experimentParamSuggestions?.summary?.strategy_count || 0} 个策略 · 实验{' '}
                {experimentParamSuggestions?.summary?.experiment_count || 0} 条
              </p>
            </div>
          </Col>
        </Row>
        <div className="quant-param-suggestion-list">
          {(experimentParamSuggestions?.suggestions || []).slice(0, 6).map(item => (
            <div className="quant-param-suggestion-row" key={item.strategy_key}>
              <div>
                <Space wrap size={6}>
                  <strong>{item.strategy_name || item.strategy_key}</strong>
                  <Tag
                    color={
                      item.action === 'use'
                        ? 'green'
                        : item.action === 'observe'
                        ? 'gold'
                        : 'default'
                    }
                  >
                    {item.action === 'use'
                      ? '自动采用'
                      : item.action === 'observe'
                      ? '继续观察'
                      : '默认参数'}
                  </Tag>
                  <Tag>信心 {Number(item.confidence || 0).toFixed(0)}</Tag>
                  <Tag>稳定 {item.stable_count || 0}</Tag>
                </Space>
                <p>{item.reason || '暂无参数建议'}</p>
              </div>
              <div>
                <Text type="secondary">
                  超额 {formatPct(item.source_experiment?.excess_return_pct)}
                </Text>
                <Text type="secondary">交易 {item.source_experiment?.trade_count || 0} 笔</Text>
              </div>
            </div>
          ))}
          {!experimentParamSuggestions?.suggestions?.length && <Empty description="暂无参数建议" />}
        </div>
      </Card>

      <Card className="modern-card quant-ab-board" variant="borderless" loading={loading}>
        <div className="quant-section-heading">
          <div>
            <span>PARAMETER A/B VALIDATION</span>
            <h2>策略参数 A/B 验证闭环</h2>
          </div>
          <Text type="secondary">
            每次量化扫描会把采用的默认/实验/手工参数版本写入信号，并追踪 1/3/5/10
            日收益，防止单次回测冠军过拟合后被直接放大。
          </Text>
        </div>
        <Row gutter={[12, 12]}>
          <Col xs={24} md={6}>
            <div className="quant-quality-tile">
              <span>参数版本</span>
              <strong>{paramValidation?.summary?.version_count || 0}</strong>
              <p>默认基线、实验候选和手工覆盖均会独立留痕。</p>
            </div>
          </Col>
          <Col xs={24} md={6}>
            <div className="quant-quality-tile">
              <span>冠军/候选</span>
              <strong>
                {(paramValidation?.summary?.champion_count || 0) +
                  (paramValidation?.summary?.active_candidate_count || 0)}
              </strong>
              <p>
                冠军 {paramValidation?.summary?.champion_count || 0} · 候选{' '}
                {paramValidation?.summary?.active_candidate_count || 0}
              </p>
            </div>
          </Col>
          <Col xs={24} md={6}>
            <div className="quant-quality-tile">
              <span>验证完成</span>
              <strong>{paramValidation?.summary?.completed_count || 0}</strong>
              <p>待完成 {paramValidation?.summary?.pending_count || 0} 条，按交易日滚动更新。</p>
            </div>
          </Col>
          <Col xs={24} md={6}>
            <div className="quant-quality-tile">
              <span>当前冠军</span>
              <strong>
                {paramValidation?.champion?.avg_excess_return_pct !== undefined
                  ? formatPct(paramValidation.champion.avg_excess_return_pct)
                  : '--'}
              </strong>
              <p>
                {paramValidation?.champion?.strategy_name ||
                  paramValidation?.champion?.strategy_key ||
                  '等待 A/B 样本完成'}
              </p>
            </div>
          </Col>
        </Row>
        <Row gutter={[12, 12]} className="quant-lifecycle-strip">
          <Col xs={24} md={8}>
            <div className="quant-lifecycle-tile promote">
              <span>可推广</span>
              <strong>{paramValidation?.lifecycle?.summary?.promotion_count || 0}</strong>
              <p>需同时通过样本、超额、胜率、相对默认优势和环境分桶护栏后升级为 champion。</p>
            </div>
          </Col>
          <Col xs={24} md={8}>
            <div className="quant-lifecycle-tile degrade">
              <span>需降级</span>
              <strong>{paramValidation?.lifecycle?.summary?.degradation_count || 0}</strong>
              <p>近期收益、整体超额、环境稳定性或实验盘交易转弱时，自动降为 degraded。</p>
            </div>
          </Col>
          <Col xs={24} md={8}>
            <div className="quant-lifecycle-tile rollback">
              <span>需回滚</span>
              <strong>{paramValidation?.lifecycle?.summary?.rollback_count || 0}</strong>
              <p>持续跑输、近期恶化或实验盘 PnL 跌破护栏时回滚默认参数。</p>
            </div>
          </Col>
        </Row>
        <div className="quant-lifecycle-guard-note">
          <Tag color="blue">
            环境护栏覆盖 {paramValidation?.lifecycle?.environment_guard?.version_count || 0} 个版本
          </Tag>
          <Tag color="gold">
            推广至少{' '}
            {paramValidation?.lifecycle?.environment_guard?.min_positive_environment_buckets || 0}{' '}
            个优势环境桶
          </Tag>
          <Tag color="purple">
            实验盘护栏覆盖 {paramValidation?.lifecycle?.trade_guard?.version_count || 0} 个版本
          </Tag>
          <Tag color="red">
            回滚PnL ≤ {formatMoney(paramValidation?.lifecycle?.trade_guard?.rollback_total_pnl)}
          </Tag>
        </div>
        <div className="quant-ab-list">
          {(paramValidation?.summary_by_version || []).slice(0, 6).map(item => (
            <div className="quant-ab-row" key={item.version_key}>
              <div>
                <Space wrap size={6}>
                  <strong>{item.strategy_name || item.strategy_key}</strong>
                  <Tag color={item.status === 'active_candidate' ? 'green' : 'blue'}>
                    {item.status || item.version_type || 'version'}
                  </Tag>
                  <Tag>样本 {item.completed_count || 0}</Tag>
                  <Tag>胜率 {formatPct(item.win_rate)}</Tag>
                </Space>
                <p>
                  {item.version_key} · 平均收益 {formatPct(item.avg_return_pct)} · 平均超额{' '}
                  {formatPct(item.avg_excess_return_pct)} · 近期超额{' '}
                  {formatPct(item.recent_avg_excess_return_pct)} · 最佳{' '}
                  {item.best_name || item.best_symbol || '--'}{' '}
                  {item.best_return_pct !== undefined ? formatPct(item.best_return_pct) : ''}
                </p>
              </div>
              <div>
                <Text strong>{Number(item.rank_score || 0).toFixed(1)}</Text>
                <Text type="secondary">A/B 分</Text>
              </div>
            </div>
          ))}
          {!paramValidation?.summary_by_version?.length && (
            <Empty description="暂无参数 A/B 验证样本，下一次量化扫描后会自动生成" />
          )}
        </div>
        <Row gutter={[12, 12]} className="quant-param-attribution-grid">
          <Col xs={24} xl={12}>
            <div className="quant-attribution-panel">
              <div className="quant-mini-heading">
                <span>ENVIRONMENT FIT</span>
                <strong>市场/行业分桶适配</strong>
              </div>
              <p>
                {environmentAttribution?.summary?.conclusion ||
                  '按市场强弱、行业温度拆开看参数，不让单一行情里的冠军被全局放大。'}
              </p>
              <div className="quant-segment-list">
                {topMarketSegments.slice(0, 3).map(segment => (
                  <div className="quant-segment-row" key={`market-${segment.key}`}>
                    <div>
                      <strong>{segment.label || segment.key}</strong>
                      <Text type="secondary">
                        样本 {segment.completed_count || 0} · 胜率 {formatPct(segment.win_rate)}
                      </Text>
                    </div>
                    <div>
                      <Text strong>{formatPct(segment.avg_excess_return_pct)}</Text>
                      <Text type="secondary">
                        {segment.best_version?.strategy_name ||
                          segment.best_version?.strategy_key ||
                          '等待版本'}
                      </Text>
                    </div>
                  </div>
                ))}
                {topIndustrySegments.slice(0, 2).map(segment => (
                  <div className="quant-segment-row industry" key={`industry-${segment.key}`}>
                    <div>
                      <strong>{segment.label || segment.key}</strong>
                      <Text type="secondary">行业温度 · 样本 {segment.completed_count || 0}</Text>
                    </div>
                    <div>
                      <Text strong>{formatPct(segment.avg_excess_return_pct)}</Text>
                      <Text type="secondary">A/B {Number(segment.rank_score || 0).toFixed(1)}</Text>
                    </div>
                  </div>
                ))}
                {!topMarketSegments.length && !topIndustrySegments.length && (
                  <Empty description="暂无环境分桶样本" />
                )}
              </div>
            </div>
          </Col>
          <Col xs={24} xl={12}>
            <div className="quant-attribution-panel trade">
              <div className="quant-mini-heading">
                <span>PARAM PAPER ATTRIBUTION</span>
                <strong>参数实验盘交易归因</strong>
              </div>
              <p>
                {paramTradeAttribution?.summary?.conclusion ||
                  '候选参数会用更小仓位进入独立模拟盘，并按 param_version_key 回看真实交易收益。'}
              </p>
              <div className="quant-param-trade-list">
                {paramTradeRows.slice(0, 4).map(row => (
                  <div className="quant-param-trade-row" key={row.param_version_key}>
                    <div>
                      <Space wrap size={6}>
                        <strong>{row.param_version_key}</strong>
                        <Tag>闭环 {row.closed_count || 0}</Tag>
                        <Tag color={Number(row.avg_excess_return_pct || 0) >= 0 ? 'red' : 'green'}>
                          超额 {formatPct(row.avg_excess_return_pct)}
                        </Tag>
                      </Space>
                      <Text type="secondary">
                        {row.strategy_keys?.slice(0, 3).join(' / ') || '策略待识别'} · 最佳{' '}
                        {row.best_name || row.best_symbol || '--'}{' '}
                        {row.best_return_pct !== undefined ? formatPct(row.best_return_pct) : ''}
                      </Text>
                    </div>
                    <div>
                      <Text strong>{formatMoney(row.total_pnl)}</Text>
                      <Text type="secondary">胜率 {formatPct(row.win_rate)}</Text>
                    </div>
                  </div>
                ))}
                {!paramTradeRows.length && <Empty description="暂无参数实验盘交易归因" />}
              </div>
            </div>
          </Col>
        </Row>
        <Alert
          className="quant-inline-note"
          type="info"
          showIcon
          message={
            paramValidation?.lifecycle?.summary?.conclusion ||
            paramValidation?.summary?.conclusion ||
            '等待参数版本与收益样本沉淀。'
          }
        />
      </Card>

      <Card
        className="modern-card quant-portfolio-family-board"
        variant="borderless"
        loading={loading}
      >
        <div className="quant-section-heading">
          <div>
            <span>PAPER ACCOUNT FAMILY</span>
            <h2>独立模拟账户对照组</h2>
          </div>
          <Text type="secondary">
            将纯量化、量化+Agent、Agent独立和参数实验拆成不同 20W 账户，收益互不串盘。
          </Text>
        </div>
        <Row gutter={[12, 12]}>
          {portfolioFamilies.map(family => (
            <Col xs={24} md={12} xl={8} key={family.key}>
              <div className="quant-portfolio-family-card">
                <Space wrap size={6}>
                  <Tag color={family.exists ? 'green' : 'default'}>
                    {family.exists ? '已运行' : '待建仓'}
                  </Tag>
                  <Tag>{family.name}</Tag>
                </Space>
                <strong>{family.label}</strong>
                <p>{family.description}</p>
                <div className="quant-family-metrics">
                  <span>收益 {formatPct(family.total_return_pct)}</span>
                  <span>PnL {formatMoney(family.total_pnl)}</span>
                  <span>持仓 {family.open_position_count || 0}</span>
                  <span>交易 {family.trade_count || 0}</span>
                  <span>胜率 {formatPct(family.win_rate)}</span>
                </div>
              </div>
            </Col>
          ))}
          {!portfolioFamilies.length && (
            <Col span={24}>
              <Empty description="暂无独立模拟账户数据" />
            </Col>
          )}
        </Row>
        <Alert
          className="quant-inline-note"
          type="success"
          showIcon
          message={
            portfolioFamilyComparison?.summary?.conclusion ||
            '独立模拟账户将在后续开盘/收盘扫描时自动沉淀收益。'
          }
        />
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={10}>
          <Card
            className="modern-card quant-outcome-compare"
            variant="borderless"
            loading={loading}
          >
            <div className="quant-section-heading">
              <div>
                <span>PAPER ALPHA</span>
                <h2>模拟盘：纯量化 vs Agent融合</h2>
              </div>
              <Text type="secondary">基于已进入20W模拟盘的真实闭环/持仓样本。</Text>
            </div>
            <div className="quant-family-list">
              {families.slice(0, 5).map(family => {
                const tone = familyTone[family.key] || familyTone.other;
                return (
                  <div className="quant-family-card" key={family.key}>
                    <div className="quant-family-icon" style={{ color: tone.color }}>
                      {tone.icon}
                    </div>
                    <div>
                      <Space wrap size={6}>
                        <strong>{family.label}</strong>
                        <Tag>{family.total_count} 条</Tag>
                        <Tag color={Number(family.avg_return_pct || 0) >= 0 ? 'red' : 'green'}>
                          均收 {formatPct(family.avg_return_pct)}
                        </Tag>
                      </Space>
                      <p>{family.description}</p>
                      <div className="quant-family-metrics">
                        <span>闭环 {family.closed_count}</span>
                        <span>持仓 {family.open_count}</span>
                        <span>胜率 {formatPct(family.win_rate)}</span>
                        <span>超额胜率 {formatPct(family.excess_win_rate)}</span>
                        <span>PnL {formatMoney(family.total_pnl)}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
              {!families.length && <Empty description="暂无模拟盘收益样本" />}
            </div>
          </Card>
        </Col>
        <Col xs={24} xl={14}>
          <Card className="modern-card" variant="borderless" loading={loading}>
            <div className="quant-section-heading">
              <div>
                <span>HISTORICAL SCOREBOARD</span>
                <h2>历史数据收益排行榜</h2>
              </div>
              <Text type="secondary">按最新完成跑分中各策略的超额收益排序。</Text>
            </div>
            <Table
              columns={backtestColumns}
              dataSource={dashboard?.latest_backtests?.leaderboard || []}
              rowKey="strategy_key"
              size="small"
              scroll={{ x: 940 }}
              pagination={{ pageSize: 6 }}
              locale={{ emptyText: <Empty description="暂无跑分结果，请先在跑分验证页执行一次" /> }}
            />
          </Card>
        </Col>
      </Row>

      <Card className="modern-card quant-indicator-board" variant="borderless" loading={loading}>
        <div className="quant-section-heading">
          <div>
            <span>INDICATOR MAP</span>
            <h2>完整量化指标地图</h2>
          </div>
          <Alert
            type="info"
            showIcon
            message={`当前覆盖 ${indicatorCatalog?.group_count || 0} 个指标族、${
              indicatorCatalog?.indicator_count || 0
            } 个指标，后续新增策略只需绑定指标族即可进入看板。`}
          />
        </div>
        <Row gutter={[12, 12]}>
          {(indicatorCatalog?.groups || []).map(group => (
            <Col xs={24} md={12} xl={8} key={group.key}>
              <div className="quant-indicator-card">
                <div className="quant-indicator-card-head">
                  <strong>{group.name}</strong>
                  <Tag>{group.indicators.length} 项</Tag>
                </div>
                <p>{group.purpose}</p>
                <Space wrap size={[6, 6]}>
                  {group.indicators.map(indicator => (
                    <Tag key={indicator}>{indicator}</Tag>
                  ))}
                </Space>
                <div className="quant-indicator-strategies">
                  <CheckCircleOutlined /> 覆盖策略：{group.strategies.join(' / ')}
                </div>
              </div>
            </Col>
          ))}
        </Row>
      </Card>

      <Card className="modern-card quant-schedule-board" variant="borderless" loading={loading}>
        <div className="quant-section-heading">
          <div>
            <span>SCHEDULER</span>
            <h2>量化定时任务</h2>
          </div>
          <Text type="secondary">开盘跑推荐，收盘复盘回写收益；两者共用同一套风控纪律。</Text>
        </div>
        <Row gutter={[12, 12]}>
          {(dashboard?.schedule_summary?.tasks || []).map(task => (
            <Col xs={24} md={12} key={task.id}>
              <div className="quant-schedule-card">
                <Space wrap>
                  <Tag color={task.is_active ? 'green' : 'default'}>
                    {task.is_active ? '启用' : '停用'}
                  </Tag>
                  <Tag>{task.cron_expression}</Tag>
                  <Tag color={task.last_run_status === 'FAILED' ? 'red' : 'blue'}>
                    {task.last_run_status || '未运行'}
                  </Tag>
                </Space>
                <strong>{task.name}</strong>
                <Text type="secondary">上次运行：{formatDateTime(task.last_run_at)}</Text>
                <div className="quant-schedule-tags">
                  <Tag>{task.parameters?.agent_session === 'open' ? '开盘' : '收盘'}</Tag>
                  <Tag>
                    Agent {task.parameters?.submit_agent_analysis === false ? '关闭' : '开启'}
                  </Tag>
                  <Tag>模拟盘 {task.parameters?.run_paper_trading === false ? '关闭' : '开启'}</Tag>
                  <Tag>单次 {task.parameters?.paper_trade_limit || 3} 票</Tag>
                </div>
              </div>
            </Col>
          ))}
          {!dashboard?.schedule_summary?.tasks?.length && (
            <Col span={24}>
              <Empty description="暂无量化调度任务" />
            </Col>
          )}
        </Row>
      </Card>
    </div>
  );
};

export default QuantPerformanceDashboard;
