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
  ExperimentOutlined,
  FundProjectionScreenOutlined,
  ReloadOutlined,
  RiseOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
  TrophyOutlined,
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

type ScheduleTask = {
  id: number;
  name: string;
  cron_expression: string;
  is_active: boolean;
  last_run_at?: string;
  last_run_status?: string;
  parameters?: Record<string, any>;
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
  schedule_summary?: { quant_pipeline_task_count?: number; tasks?: ScheduleTask[] };
  outcome_comparison?: { summary?: any; families?: OutcomeFamily[]; by_strategy_key?: any[] };
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
  const [loading, setLoading] = useState(false);

  const fetchDashboard = async (silent = false) => {
    setLoading(true);
    try {
      const response = await api.get('/quant/performance-dashboard');
      if (response.data.success) {
        setDashboard(response.data.data || null);
        if (!silent) message.success('量化收益驾驶舱已刷新');
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
  const indicatorCatalog = dashboard?.indicator_catalog;
  const signalSummary = dashboard?.signal_summary;
  const readiness = dashboard?.readiness;
  const openTask = useMemo(
    () =>
      (dashboard?.schedule_summary?.tasks || []).find(task => String(task.name).includes('开盘')),
    [dashboard]
  );
  const closeTask = useMemo(
    () =>
      (dashboard?.schedule_summary?.tasks || []).find(task => String(task.name).includes('全市场')),
    [dashboard]
  );
  const families = dashboard?.outcome_comparison?.families || [];
  const pureQuant = families.find(item => item.key === 'pure_quant');
  const agentFusion = families.find(item => item.key === 'agent_fusion');

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
              title="最新信号"
              value={signalSummary?.quant_signal_count || 0}
              prefix={<RiseOutlined />}
            />
            <Text type="secondary">
              {signalSummary?.latest_quant_trade_date || '--'} · 买入{' '}
              {signalSummary?.quant_buy_count || 0}
            </Text>
          </Card>
        </Col>
      </Row>

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
