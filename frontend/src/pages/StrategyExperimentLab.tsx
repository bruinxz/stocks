import React, { useEffect, useMemo, useState } from 'react';
import {
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
  BranchesOutlined,
  ExperimentOutlined,
  FireOutlined,
  ReloadOutlined,
  TrophyOutlined,
} from '@ant-design/icons';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import api from '../services/api';

const { Text } = Typography;

type VariantResult = {
  key: string;
  label: string;
  universe: string;
  style: string;
  generated: { total_candidates: number; analyzed_candidates: number };
  metrics: {
    avg_score: number;
    avg_position_pct: number;
    strong_count: number;
    trial_count: number;
    watch_count: number;
    avoid_count: number;
    low_risk_count: number;
    medium_risk_count: number;
    high_risk_count: number;
    feedback_adjusted_count: number;
    quality_score: number;
  };
  top_symbols: Array<{
    symbol: string;
    name?: string;
    score: number;
    tier?: string;
    tier_label?: string;
    risk_level?: string;
    suggested_position_pct?: number;
  }>;
};

type ExperimentData = {
  generated_at: string;
  filters: Record<string, any>;
  champion?: VariantResult;
  variants: VariantResult[];
  overlaps: Array<{ symbol: string; variant_count: number; variants: string[] }>;
  insights: string[];
};

const universeOptions = [
  { label: '全市场', value: 'market' },
  { label: '自选池', value: 'favorites' },
];

const formatPct = (value?: number | null) => `${Number(value || 0).toFixed(1)}%`;
const tierColorMap: Record<string, string> = {
  strong_recommend: 'volcano',
  trial_position: 'gold',
  watchlist: 'blue',
  avoid: 'default',
};

const StrategyExperimentLab: React.FC = () => {
  const [data, setData] = useState<ExperimentData | null>(null);
  const [loading, setLoading] = useState(false);
  const [universe, setUniverse] = useState('market');
  const [limit, setLimit] = useState(12);

  const fetchExperiment = async (silent = false) => {
    setLoading(true);
    try {
      const response = await api.get('/ai/recommendations/strategy-experiment', {
        params: {
          universe,
          limit,
          candidate_pool_limit: universe === 'market' ? Math.max(limit * 12, 160) : undefined,
          lookback_days: 120,
          min_market_cap_yi: universe === 'market' ? 30 : undefined,
          exclude_st: true,
        },
      });
      if (response.data.success) {
        setData(response.data.data);
        if (!silent) message.success('策略实验已刷新');
      }
    } catch (error: any) {
      message.error(error.response?.data?.message || '运行策略实验失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchExperiment(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [universe, limit]);

  const champion = data?.champion;
  const chartData = useMemo(
    () =>
      (data?.variants || []).map(({ style: variant_style, ...item }) => ({
        ...item,
        variant_style,
      })),
    [data]
  );

  const columns = [
    {
      title: '实验策略',
      key: 'variant',
      fixed: 'left' as const,
      width: 210,
      render: (_: any, record: VariantResult) => (
        <Space direction="vertical" size={2}>
          <Text strong>{record.label}</Text>
          <Text type="secondary">
            {record.key} · {record.style}
          </Text>
          {champion?.key === record.key && <Tag color="volcano">当前冠军</Tag>}
        </Space>
      ),
    },
    {
      title: '质量分',
      dataIndex: ['metrics', 'quality_score'],
      key: 'quality_score',
      width: 150,
      sorter: (a: VariantResult, b: VariantResult) =>
        a.metrics.quality_score - b.metrics.quality_score,
      render: (value: number) => (
        <Space direction="vertical" size={0} style={{ width: 120 }}>
          <Text strong style={{ fontSize: 18, color: value >= 72 ? '#cf1322' : '#9f6b25' }}>
            {Number(value || 0).toFixed(1)}
          </Text>
          <Progress
            percent={Math.round(value || 0)}
            size="small"
            showInfo={false}
            strokeColor="#d6a64f"
          />
        </Space>
      ),
    },
    {
      title: '分层结构',
      key: 'tiers',
      width: 230,
      render: (_: any, record: VariantResult) => (
        <Space wrap size={[4, 4]}>
          <Tag color="volcano">强 {record.metrics.strong_count}</Tag>
          <Tag color="gold">轻仓 {record.metrics.trial_count}</Tag>
          <Tag color="blue">观察 {record.metrics.watch_count}</Tag>
          <Tag>回避 {record.metrics.avoid_count}</Tag>
        </Space>
      ),
    },
    {
      title: '风险结构',
      key: 'risk',
      width: 180,
      render: (_: any, record: VariantResult) => (
        <Space direction="vertical" size={2}>
          <Text>低/中/高</Text>
          <Text type="secondary">
            {record.metrics.low_risk_count}/{record.metrics.medium_risk_count}/
            {record.metrics.high_risk_count}
          </Text>
        </Space>
      ),
    },
    {
      title: '均分 / 仓位',
      key: 'score_position',
      width: 150,
      render: (_: any, record: VariantResult) => (
        <Space direction="vertical" size={2}>
          <Text strong>{record.metrics.avg_score}</Text>
          <Text type="secondary">均仓 {formatPct(record.metrics.avg_position_pct)}</Text>
        </Space>
      ),
    },
    {
      title: 'Top 共识',
      key: 'top',
      render: (_: any, record: VariantResult) => (
        <Space wrap size={[4, 4]}>
          {record.top_symbols.slice(0, 5).map(item => (
            <Tag key={item.symbol} color={tierColorMap[item.tier || 'watchlist']}>
              {item.name || item.symbol} {Number(item.score || 0).toFixed(0)}
            </Tag>
          ))}
        </Space>
      ),
    },
  ];

  return (
    <div className="strategy-experiment-page fade-in-up">
      <div className="strategy-experiment-hero">
        <div>
          <div className="strategy-experiment-kicker">Strategy A/B Arena</div>
          <h1>荐股策略实验室</h1>
          <p>
            同时比较均衡、动量、价值、低波等策略风格，观察候选质量、分层结构、风险分布和多策略共识标的，为后续自动选择最优策略做准备。
          </p>
          <Space wrap>
            <Tag icon={<ExperimentOutlined />}>A/B Test</Tag>
            <Tag icon={<BranchesOutlined />}>Style Ranking</Tag>
            <Tag icon={<TrophyOutlined />}>Champion Policy</Tag>
          </Space>
        </div>
        <div className="strategy-experiment-champion">
          <span>CHAMPION</span>
          <strong>{champion?.label || '--'}</strong>
          <em>质量分 {champion?.metrics?.quality_score ?? 0}</em>
        </div>
      </div>

      <Card className="modern-card strategy-experiment-toolbar" variant="borderless">
        <Space wrap>
          <Select
            value={universe}
            onChange={setUniverse}
            options={universeOptions}
            style={{ width: 120 }}
          />
          <Select
            value={limit}
            onChange={setLimit}
            options={[8, 12, 20, 30].map(value => ({ label: `${value}只`, value }))}
            style={{ width: 100 }}
          />
          <Button
            icon={<ReloadOutlined />}
            onClick={() => fetchExperiment(false)}
            loading={loading}
          >
            刷新实验
          </Button>
          <Text type="secondary">最后生成：{data?.generated_at || '--'}</Text>
        </Space>
      </Card>

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={12} md={6}>
          <Card className="modern-card" variant="borderless">
            <Statistic
              title="策略版本"
              value={data?.variants?.length || 0}
              prefix={<BranchesOutlined />}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card className="modern-card" variant="borderless">
            <Statistic
              title="共识标的"
              value={data?.overlaps?.length || 0}
              prefix={<FireOutlined />}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card className="modern-card" variant="borderless">
            <Statistic title="冠军强推荐" value={champion?.metrics?.strong_count || 0} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card className="modern-card" variant="borderless">
            <Statistic title="冠军轻仓" value={champion?.metrics?.trial_count || 0} />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={24} xl={15}>
          <Card className="modern-card" variant="borderless" title="策略质量分排行">
            <div style={{ height: 310 }}>
              {chartData.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(100, 116, 139, 0.18)" />
                    <XAxis dataKey="label" />
                    <YAxis />
                    <Tooltip />
                    <Bar
                      dataKey="metrics.quality_score"
                      fill="#d6a64f"
                      radius={[10, 10, 0, 0]}
                      name="质量分"
                    />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <Empty description="暂无实验结果" />
              )}
            </div>
          </Card>
        </Col>
        <Col xs={24} xl={9}>
          <Card
            className="modern-card strategy-experiment-insights"
            variant="borderless"
            title="实验结论"
          >
            <Space direction="vertical" size={10} style={{ width: '100%' }}>
              {(data?.insights || []).map((item, index) => (
                <div className="strategy-experiment-note" key={index}>
                  {item}
                </div>
              ))}
              {data?.overlaps?.slice(0, 8).map(item => (
                <div className="strategy-experiment-consensus" key={item.symbol}>
                  <strong>{item.symbol}</strong>
                  <span>{item.variant_count} 个策略共识</span>
                </div>
              ))}
              {!data?.insights?.length && <Empty description="暂无洞察" />}
            </Space>
          </Card>
        </Col>
      </Row>

      <Card className="modern-card" variant="borderless" title="策略实验明细">
        <Table
          columns={columns}
          dataSource={data?.variants || []}
          rowKey="key"
          loading={loading}
          scroll={{ x: 1080 }}
          pagination={false}
          locale={{ emptyText: <Empty description="暂无策略实验结果" /> }}
        />
      </Card>
    </div>
  );
};

export default StrategyExperimentLab;
