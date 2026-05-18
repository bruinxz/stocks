import React, { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Empty,
  Row,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import {
  AimOutlined,
  ApiOutlined,
  CheckCircleOutlined,
  DatabaseOutlined,
  NodeIndexOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import api from '../services/api';

const { Text } = Typography;

type Strategy = { strategy_key: string; name: string; enabled?: boolean };
const DEFAULT_STRATEGY_KEYS = [
  'multi_factor_ranking',
  'relative_strength_momentum',
  'volume_price_confirmation',
  'low_volatility_quality',
];

type QuantSignal = {
  id: number;
  trade_date: string;
  symbol: string;
  name?: string;
  strategy_key: string;
  signal: string;
  score: number;
  confidence: number;
  entry_price?: number;
  stop_loss_price?: number;
  take_profit_price?: number;
  reason?: string;
  risk_flags?: string[];
  raw_factors?: Record<string, any>;
  agent_eligible?: boolean;
  agent_status?: string;
};
type FusionAudit = {
  id: number;
  symbol: string;
  name?: string;
  signal_date: string;
  quant_score?: number;
  agent_score?: number;
  final_score?: number;
  final_decision?: string;
  current_price?: number;
  rationale?: string;
  risk_level?: string;
  created_at?: string;
};
type RankingItem = {
  rank: number;
  symbol: string;
  name?: string;
  trade_date?: string;
  signal?: string;
  score?: number;
  confidence?: number;
  entry_price?: number;
  strategy_key?: string;
  strategy_keys?: string[];
  consensus_count?: number;
  reason?: string;
  risk_flags?: string[];
  agent_eligible?: boolean;
  market_regime?: string;
  industry_regime?: string;
  price_source?: string;
  latest_quote_time?: string | null;
};
type FusionRankingItem = {
  rank: number;
  id: number;
  symbol: string;
  name?: string;
  signal_date?: string;
  strategy_key?: string;
  strategy_keys?: string[];
  quant_score?: number;
  agent_score?: number;
  final_score?: number;
  score_delta?: number;
  final_decision?: string;
  agent_decision?: string;
  risk_level?: string;
  current_price?: number;
  rationale?: string;
  disagreement_penalty?: number;
  created_at?: string;
};
type RankingDashboard = {
  generated_at?: string;
  trade_date?: string | null;
  signal_date?: string | null;
  quant_rankings?: RankingItem[];
  fusion_rankings?: FusionRankingItem[];
  summary?: {
    signal_count?: number;
    buy_count?: number;
    watch_count?: number;
    fusion_count?: number;
    quant_scored?: boolean;
    agent_rescored?: boolean;
    realtime_persisted?: boolean;
    avg_quant_score?: number;
    avg_final_score?: number;
    quote_persistence?: {
      persisted?: boolean;
      latest_quote_time?: string | null;
      latest_trade_date?: string | null;
      latest_trade_date_snapshot_count?: number;
      latest_trade_date_symbol_count?: number;
      age_minutes?: number | null;
      freshness_threshold_minutes?: number;
      is_fresh?: boolean;
      freshness_status?: string;
    };
  };
};

const signalColor: Record<string, string> = {
  buy: 'volcano',
  watch: 'gold',
  hold: 'blue',
  sell: 'green',
  avoid: 'default',
};
const signalLabel: Record<string, string> = {
  buy: '买入',
  watch: '观察',
  hold: '持有',
  sell: '卖出',
  avoid: '回避',
};
const decisionLabel: Record<string, string> = {
  buy: '买入',
  watch: '观察',
  hold: '持有',
  avoid: '回避',
};

const marketRegimeLabel: Record<string, string> = {
  bull: '强势市',
  bear: '弱势市',
  range: '震荡市',
  rebound: '反弹市',
  stress: '压力市',
  unknown: '环境未知',
};

const formatPrice = (value?: number | string | null) => {
  const parsed = Number(value || 0);
  return parsed > 0 ? `¥${parsed.toFixed(2)}` : '--';
};

const scoreTone = (value?: number) => {
  const score = Number(value || 0);
  if (score >= 78) return '#b42318';
  if (score >= 70) return '#c87511';
  return '#2764b8';
};

const compactDateTime = (value?: string | null) => {
  if (!value) return '--';
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format('MM-DD HH:mm') : value;
};

const QuantSignalPool: React.FC = () => {
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [signals, setSignals] = useState<QuantSignal[]>([]);
  const [tradeDate, setTradeDate] = useState(dayjs());
  const [strategyKeys, setStrategyKeys] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [pipelineRunning, setPipelineRunning] = useState(false);
  const [pipelineMode, setPipelineMode] = useState(true);
  const [conclusionOnly, setConclusionOnly] = useState(true);
  const [fusionAudits, setFusionAudits] = useState<FusionAudit[]>([]);
  const [rankingDashboard, setRankingDashboard] = useState<RankingDashboard | null>(null);

  const fetchStrategies = async () => {
    const response = await api.get('/quant/strategies');
    if (response.data.success) {
      const strategyList = response.data.data || [];
      setStrategies(strategyList);
      setStrategyKeys(current => {
        if (current.length > 0) return current;
        const enabledKeys = strategyList
          .filter((item: any) => item.enabled !== false)
          .map((item: any) => item.strategy_key);
        const preferred = DEFAULT_STRATEGY_KEYS.filter(key => enabledKeys.includes(key));
        return preferred.length > 0 ? preferred : enabledKeys;
      });
    }
  };

  const fetchSignals = async () => {
    setLoading(true);
    try {
      const currentTradeDate = tradeDate.format('YYYY-MM-DD');
      const [signalResponse, auditResponse, rankingResponse] = await Promise.all([
        api.get('/quant/signals', {
          params: { trade_date: currentTradeDate, limit: 300 },
        }),
        api.get('/quant/fusion-audits', { params: { limit: 20 } }),
        api.get('/quant/rankings', { params: { trade_date: currentTradeDate, limit: 30 } }),
      ]);
      if (signalResponse.data.success) setSignals(signalResponse.data.data || []);
      if (auditResponse.data.success) setFusionAudits(auditResponse.data.data || []);
      if (rankingResponse.data.success) setRankingDashboard(rankingResponse.data.data || null);
    } finally {
      setLoading(false);
    }
  };

  const generateSignals = async () => {
    setGenerating(true);
    try {
      const response = await api.post('/quant/signals/generate', {
        trade_date: tradeDate.format('YYYY-MM-DD'),
        universe: 'market',
        strategy_keys: strategyKeys,
        candidate_limit: 120,
        min_score: 55,
        persist: true,
      });
      if (response.data.success) {
        message.success(`已生成 ${response.data.data.signal_count} 条量化信号`);
        await fetchSignals();
      }
    } catch (error: any) {
      message.error(error.response?.data?.message || '生成量化信号失败');
    } finally {
      setGenerating(false);
    }
  };

  const runDailyPipeline = async () => {
    setPipelineRunning(true);
    try {
      const response = await api.post('/quant/daily-pipeline/run', {
        trade_date: tradeDate.format('YYYY-MM-DD'),
        universe: 'market',
        strategy_keys: strategyKeys,
        candidate_limit: 180,
        min_score: 55,
        archive_limit: 30,
        max_industry_candidates: 4,
        max_strategy_candidates: 8,
        submit_agent_analysis: pipelineMode,
        agent_max_count: 5,
        agent_min_score: 72,
        run_paper_trading: pipelineMode,
        dry_run: false,
      });
      if (response.data.success) {
        const data = response.data.data || {};
        message.success(
          `闭环完成：归档 ${data.archive?.total || 0} 条，Agent提交 ${
            data.agent_analysis?.submitted?.length || 0
          } 条`
        );
        await fetchSignals();
      }
    } catch (error: any) {
      message.error(error.response?.data?.message || '运行量化闭环失败');
    } finally {
      setPipelineRunning(false);
    }
  };

  useEffect(() => {
    fetchStrategies();
    fetchSignals();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const buyCount = signals.filter(item => item.signal === 'buy').length;
  const agentCount = signals.filter(item => item.agent_eligible).length;
  const avgScore = signals.length
    ? signals.reduce((sum, item) => sum + Number(item.score || 0), 0) / signals.length
    : 0;
  const quotePersistence = rankingDashboard?.summary?.quote_persistence;
  const quantRankings = rankingDashboard?.quant_rankings || [];
  const fusionRankings = rankingDashboard?.fusion_rankings || [];

  const baseColumns = [
    {
      title: '股票',
      key: 'stock',
      fixed: 'left' as const,
      width: 170,
      render: (_: any, record: QuantSignal) => (
        <Space direction="vertical" size={0}>
          <Text strong>{record.name || record.symbol}</Text>
          <Text type="secondary">{record.symbol}</Text>
        </Space>
      ),
    },
    {
      title: '策略',
      dataIndex: 'strategy_key',
      key: 'strategy_key',
      width: 190,
      render: (value: string) =>
        strategies.find(item => item.strategy_key === value)?.name || value,
    },
    {
      title: '动作',
      dataIndex: 'signal',
      key: 'signal',
      width: 90,
      render: (value: string) => (
        <Tag color={signalColor[value]}>{signalLabel[value] || value}</Tag>
      ),
    },
    {
      title: '量化分',
      dataIndex: 'score',
      key: 'score',
      width: 120,
      sorter: (a: QuantSignal, b: QuantSignal) => Number(a.score) - Number(b.score),
      render: (value: number) => (
        <Text strong style={{ color: scoreTone(value) }}>
          {Number(value || 0).toFixed(1)}
        </Text>
      ),
    },
    {
      title: '当前价/止损/止盈',
      key: 'levels',
      width: 170,
      render: (_: any, record: QuantSignal) => (
        <Text type="secondary">
          {Number(record.entry_price || 0).toFixed(2)} /{' '}
          {Number(record.stop_loss_price || 0).toFixed(2)} /{' '}
          {Number(record.take_profit_price || 0).toFixed(2)}
        </Text>
      ),
    },
    { title: '核心理由', dataIndex: 'reason', key: 'reason', ellipsis: true },
  ];

  const advancedColumns = [
    {
      title: '风险',
      dataIndex: 'risk_flags',
      key: 'risk_flags',
      width: 220,
      render: (flags: string[]) => (
        <Space wrap size={[4, 4]}>
          {(flags || []).slice(0, 3).map(flag => (
            <Tag color="orange" key={flag}>
              {flag}
            </Tag>
          ))}
        </Space>
      ),
    },
    {
      title: 'Agent',
      dataIndex: 'agent_eligible',
      key: 'agent_eligible',
      width: 110,
      render: (value: boolean) => (
        <Tag color={value ? 'purple' : 'default'}>{value ? '可深研' : '暂不进入'}</Tag>
      ),
    },
  ];

  const columns = conclusionOnly
    ? baseColumns.filter(column => !['strategy_key'].includes(String(column.key)))
    : [...baseColumns, ...advancedColumns];

  const topSignal = [...signals].sort((a, b) => Number(b.score || 0) - Number(a.score || 0))[0];
  const latestAudit = fusionAudits[0];
  const topMarketEnvironment = topSignal?.raw_factors?.market_environment || {};
  const topMarketLabel =
    marketRegimeLabel[topMarketEnvironment.market_regime] ||
    topMarketEnvironment.market_regime ||
    '环境未知';
  const topIndustryLabel =
    topMarketEnvironment.industry?.label || topMarketEnvironment.industry?.regime || '行业未知';

  const rankingColumns = [
    {
      title: 'Rank',
      dataIndex: 'rank',
      width: 70,
      render: (value: number) => <span className="quant-rank-badge">#{value}</span>,
    },
    {
      title: '股票',
      key: 'stock',
      width: 170,
      render: (_: any, record: RankingItem) => (
        <Space direction="vertical" size={0}>
          <Text strong>{record.name || record.symbol}</Text>
          <Text type="secondary">{record.symbol}</Text>
        </Space>
      ),
    },
    {
      title: '量化分',
      dataIndex: 'score',
      width: 96,
      render: (value: number) => (
        <Text strong style={{ color: scoreTone(value) }}>
          {Number(value || 0).toFixed(1)}
        </Text>
      ),
    },
    {
      title: '当前价',
      dataIndex: 'entry_price',
      width: 96,
      render: (value: number) => <Text>{formatPrice(value)}</Text>,
    },
    {
      title: '动作',
      dataIndex: 'signal',
      width: 88,
      render: (value: string) => (
        <Tag color={signalColor[value]}>{signalLabel[value] || value}</Tag>
      ),
    },
    {
      title: '共识',
      dataIndex: 'consensus_count',
      width: 82,
      render: (value: number) => <Tag>{value || 1} 策略</Tag>,
    },
    {
      title: '价格源',
      key: 'price_source',
      width: 112,
      render: (_: any, record: RankingItem) => (
        <Tag color={record.price_source === 'realtime_quote' ? 'green' : 'default'}>
          {record.price_source === 'realtime_quote'
            ? '实时'
            : record.price_source === 'stock_snapshot'
            ? '快照'
            : '日线'}
        </Tag>
      ),
    },
    { title: '核心理由', dataIndex: 'reason', ellipsis: true },
  ];

  const fusionColumns = [
    {
      title: 'Rank',
      dataIndex: 'rank',
      width: 70,
      render: (value: number) => <span className="quant-rank-badge fusion">#{value}</span>,
    },
    {
      title: '股票',
      key: 'stock',
      width: 170,
      render: (_: any, record: FusionRankingItem) => (
        <Space direction="vertical" size={0}>
          <Text strong>{record.name || record.symbol}</Text>
          <Text type="secondary">{record.symbol}</Text>
        </Space>
      ),
    },
    {
      title: '融合分',
      dataIndex: 'final_score',
      width: 96,
      render: (value: number) => (
        <Text strong style={{ color: scoreTone(value) }}>
          {Number(value || 0).toFixed(1)}
        </Text>
      ),
    },
    {
      title: '量化/Agent',
      key: 'score_pair',
      width: 126,
      render: (_: any, record: FusionRankingItem) => (
        <Text type="secondary">
          {Number(record.quant_score || 0).toFixed(0)} /{' '}
          {Number(record.agent_score || 0).toFixed(0)}
        </Text>
      ),
    },
    {
      title: '变化',
      dataIndex: 'score_delta',
      width: 86,
      render: (value: number) => (
        <Tag color={Number(value || 0) >= 0 ? 'red' : 'blue'}>
          {Number(value || 0) >= 0 ? '+' : ''}
          {Number(value || 0).toFixed(1)}
        </Tag>
      ),
    },
    {
      title: '最终动作',
      dataIndex: 'final_decision',
      width: 96,
      render: (value: string) => (
        <Tag color={value === 'buy' ? 'volcano' : value === 'avoid' ? 'default' : 'blue'}>
          {decisionLabel[value] || value || '待定'}
        </Tag>
      ),
    },
    {
      title: '当前价',
      dataIndex: 'current_price',
      width: 96,
      render: (value: number) => <Text>{formatPrice(value)}</Text>,
    },
    { title: '融合理由', dataIndex: 'rationale', ellipsis: true },
  ];

  return (
    <div className="quant-research-page fade-in-up">
      <div className="quant-research-hero compact">
        <div>
          <div className="quant-research-kicker">QUANT SIGNAL POOL</div>
          <h1>量化信号池</h1>
          <p>
            每日对全市场执行多策略打分，沉淀买入、观察、卖出和回避信号；高分且风险可控的股票进入
            TradingAgent 深研候选。融合闭环会自动控制行业/策略集中度，并按不同市场环境微调策略权重。
          </p>
          <div className="quant-status-strip">
            <Tooltip title="AKShare 实时行情现在会写入 realtime_quotes，并同步刷新 Stock 最新价快照。超过新鲜度阈值会提示过期。">
              <span
                className={
                  quotePersistence?.persisted && quotePersistence?.is_fresh ? 'ok' : 'warn'
                }
              >
                <DatabaseOutlined /> 实时落盘：
                {quotePersistence?.persisted
                  ? `${quotePersistence.latest_trade_date_symbol_count || 0} 只 / ${compactDateTime(
                      quotePersistence.latest_quote_time
                    )}${
                      quotePersistence.is_fresh
                        ? ''
                        : ` · 已过期${quotePersistence.age_minutes || 0}分钟`
                    }`
                  : '等待行情写入'}
              </span>
            </Tooltip>
            <span className={rankingDashboard?.summary?.quant_scored ? 'ok' : 'warn'}>
              <CheckCircleOutlined /> 指标跑分：
              {rankingDashboard?.summary?.quant_scored ? '已生成排行榜' : '等待生成'}
            </span>
            <span className={rankingDashboard?.summary?.agent_rescored ? 'ok' : 'warn'}>
              <ApiOutlined /> Agent复核：
              {rankingDashboard?.summary?.agent_rescored ? '已有融合分' : '等待异步完成'}
            </span>
          </div>
        </div>
        <div className="quant-research-meter">
          <span>SIGNALS</span>
          <strong>{signals.length}</strong>
          <em>
            {buyCount} 条买入 · {agentCount} 条可进入 Agent
          </em>
        </div>
      </div>

      <Card className="modern-card quant-toolbar" variant="borderless">
        <Space wrap>
          <DatePicker value={tradeDate} onChange={value => value && setTradeDate(value)} />
          <Select
            mode="multiple"
            value={strategyKeys}
            onChange={setStrategyKeys}
            style={{ minWidth: 360 }}
            options={strategies.map(item => ({ label: item.name, value: item.strategy_key }))}
          />
          <Space size={6}>
            <Switch size="small" checked={pipelineMode} onChange={setPipelineMode} />
            <Text type="secondary">Agent+模拟盘</Text>
          </Space>
          <Space size={6}>
            <Switch size="small" checked={conclusionOnly} onChange={setConclusionOnly} />
            <Text type="secondary">只看结论</Text>
          </Space>
          <Button icon={<ReloadOutlined />} onClick={fetchSignals} loading={loading}>
            刷新信号
          </Button>
          <Button
            type="primary"
            icon={<ThunderboltOutlined />}
            onClick={generateSignals}
            loading={generating}
          >
            生成今日信号
          </Button>
          <Button
            icon={<SafetyCertificateOutlined />}
            onClick={runDailyPipeline}
            loading={pipelineRunning}
          >
            运行融合闭环
          </Button>
        </Space>
      </Card>

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={12} md={6}>
          <Card className="modern-card">
            <Statistic title="信号总数" value={signals.length} prefix={<AimOutlined />} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card className="modern-card">
            <Statistic title="买入信号" value={buyCount} prefix={<ThunderboltOutlined />} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card className="modern-card">
            <Statistic title="Agent候选" value={agentCount} prefix={<ApiOutlined />} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card className="modern-card">
            <Statistic
              title="平均量化分"
              value={avgScore}
              precision={1}
              prefix={<NodeIndexOutlined />}
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={24} lg={14}>
          <Card className="modern-card quant-conclusion-card" title="今日最该看的结论">
            {topSignal ? (
              <div>
                <Space wrap style={{ marginBottom: 10 }}>
                  <Tag color={signalColor[topSignal.signal]}>
                    {signalLabel[topSignal.signal] || topSignal.signal}
                  </Tag>
                  <Tag>量化分 {Number(topSignal.score || 0).toFixed(1)}</Tag>
                  <Tag>当前价 {formatPrice(topSignal.entry_price)}</Tag>
                  <Tag color={topSignal.agent_eligible ? 'purple' : 'default'}>
                    {topSignal.agent_eligible ? '进入Agent候选' : '暂不深研'}
                  </Tag>
                  <Tag color="blue">{topMarketLabel}</Tag>
                  <Tag color="cyan">{topIndustryLabel}</Tag>
                </Space>
                <h2>
                  {topSignal.name || topSignal.symbol} <span>{topSignal.symbol}</span>
                </h2>
                <p>{topSignal.reason || '量化策略给出候选，但理由不足，需要继续观察。'}</p>
                <Text type="secondary">
                  止损 {formatPrice(topSignal.stop_loss_price)} · 止盈{' '}
                  {formatPrice(topSignal.take_profit_price)}
                </Text>
              </div>
            ) : (
              <Empty description="暂无今日候选" />
            )}
          </Card>
        </Col>
        <Col xs={24} lg={10}>
          <Card className="modern-card quant-conclusion-card" title="最近Agent融合审计">
            {latestAudit ? (
              <div>
                <Space wrap style={{ marginBottom: 10 }}>
                  <Tag color={latestAudit.final_decision === 'buy' ? 'red' : 'blue'}>
                    {decisionLabel[latestAudit.final_decision || ''] ||
                      latestAudit.final_decision ||
                      '待定'}
                  </Tag>
                  <Tag>最终分 {Number(latestAudit.final_score || 0).toFixed(1)}</Tag>
                  <Tag>当前价 {formatPrice(latestAudit.current_price)}</Tag>
                </Space>
                <h2>
                  {latestAudit.name || latestAudit.symbol} <span>{latestAudit.symbol}</span>
                </h2>
                <p>{latestAudit.rationale || '暂无融合理由'}</p>
                <Text type="secondary">
                  量化 {Number(latestAudit.quant_score || 0).toFixed(1)} · Agent{' '}
                  {Number(latestAudit.agent_score || 0).toFixed(1)}
                </Text>
              </div>
            ) : (
              <Alert
                type="info"
                showIcon
                message="暂无Agent融合审计"
                description="当量化高分候选完成 TradingAgents 复核后，会在这里展示最终动作和分歧理由。"
              />
            )}
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={24} xl={12}>
          <Card
            className="modern-card quant-ranking-card"
            title="量化排行榜"
            extra={
              <Text type="secondary">
                {rankingDashboard?.trade_date || tradeDate.format('YYYY-MM-DD')}
              </Text>
            }
            loading={loading}
          >
            <Table
              size="small"
              columns={rankingColumns}
              dataSource={quantRankings}
              rowKey={record => `${record.symbol}-${record.rank}`}
              pagination={false}
              scroll={{ x: 860 }}
              locale={{ emptyText: <Empty description="暂无量化排名，先生成今日信号" /> }}
            />
          </Card>
        </Col>
        <Col xs={24} xl={12}>
          <Card
            className="modern-card quant-ranking-card"
            title="Agent融合后排行榜"
            extra={
              <Text type="secondary">
                {rankingDashboard?.summary?.agent_rescored
                  ? `平均融合分 ${Number(rankingDashboard.summary.avg_final_score || 0).toFixed(1)}`
                  : '等待异步复核'}
              </Text>
            }
            loading={loading}
          >
            <Table
              size="small"
              columns={fusionColumns}
              dataSource={fusionRankings}
              rowKey={record => `${record.id}-${record.symbol}`}
              pagination={false}
              scroll={{ x: 980 }}
              locale={{
                emptyText: <Empty description="Agent完成复核后会展示二次跑分排名" />,
              }}
            />
          </Card>
        </Col>
      </Row>

      <Card className="modern-card" title="量化信号明细" loading={loading}>
        <Table
          columns={columns}
          dataSource={signals}
          rowKey="id"
          scroll={{ x: 1200 }}
          pagination={{ pageSize: 12 }}
          locale={{ emptyText: <Empty description="暂无量化信号，点击生成今日信号" /> }}
        />
      </Card>
    </div>
  );
};

export default QuantSignalPool;
