import React, { useState, useEffect } from 'react';
import {
  Card,
  Typography,
  Table,
  Tag,
  Button,
  Space,
  message,
  Descriptions,
  Empty,
  Drawer,
  Statistic,
  Row,
  Col,
} from 'antd';
import { RocketOutlined, EyeOutlined, SyncOutlined, BarChartOutlined } from '@ant-design/icons';
import { AreaChart, Area, ResponsiveContainer } from 'recharts';
import dayjs from 'dayjs';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import api from '../services/api';
import { Link } from 'react-router-dom';

const { Title, Text, Paragraph } = Typography;

interface ScreenerRecord {
  id: number;
  date: string;
  symbol: string;
  name: string;
  decision: string;
  rationale: string;
  detail: string;
  score: number;
  scores: any;
  current_price?: number;
  price_change_pct?: number;
  created_at?: string;
  recentTrend?: { time: string; close: number }[];
}

interface AISignalRecord {
  id: number;
  source_type: string;
  source_id: string;
  symbol: string;
  name?: string;
  signal_date: string;
  decision: string;
  normalized_decision: string;
  confidence_score?: number;
  risk_level?: string;
  rationale?: string;
  forward_returns?: {
    entry_date?: string;
    entry_price?: number;
    horizons?: Record<string, { status: string; return_pct?: number; exit_date?: string }>;
  };
  verification_status: string;
}

interface AISignalStats {
  total_signals: number;
  by_decision: Record<string, { count: number; avg_confidence_score: number }>;
  horizon_summary: Record<
    string,
    { count: number; avg_return_pct: number; positive_count: number; positive_rate: number }
  >;
}

const Screener: React.FC = () => {
  const [data, setData] = useState<ScreenerRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [detailVisible, setDetailVisible] = useState(false);
  const [selectedRecord, setSelectedRecord] = useState<ScreenerRecord | null>(null);
  const [signals, setSignals] = useState<AISignalRecord[]>([]);
  const [signalStats, setSignalStats] = useState<AISignalStats | null>(null);
  const [signalLoading, setSignalLoading] = useState(false);

  const fetchScreenerData = async () => {
    setLoading(true);
    try {
      const response = await api.get('/ai/screener');
      if (response.data.success) {
        setData(response.data.data);
      }
    } catch (error) {
      message.error('获取 AI 每日优选数据失败');
    } finally {
      setLoading(false);
    }
  };

  const fetchSignalData = async () => {
    setSignalLoading(true);
    try {
      const [signalsResp, statsResp] = await Promise.all([
        api.get('/ai/signals', { params: { limit: 20 } }),
        api.get('/ai/signals/stats'),
      ]);
      if (signalsResp.data.success) {
        setSignals(signalsResp.data.data.signals || []);
      }
      if (statsResp.data.success) {
        setSignalStats(statsResp.data.data);
      }
    } catch (error) {
      message.warning('AI 信号表现暂不可用，请先同步信号');
    } finally {
      setSignalLoading(false);
    }
  };

  const handleSyncSignals = async () => {
    setSignalLoading(true);
    try {
      await api.post('/ai/signals/sync-screeners');
      message.success('AI 信号已同步并完成收益验证');
      await fetchSignalData();
    } catch (error: any) {
      message.error(error.response?.data?.message || '同步 AI 信号失败');
    } finally {
      setSignalLoading(false);
    }
  };

  useEffect(() => {
    fetchScreenerData();
    fetchSignalData();
  }, []);

  const getDecisionColor = (dec: string) => {
    if (dec.toUpperCase().includes('STRONG_BUY')) return 'magenta';
    if (dec.toUpperCase().includes('BUY')) return 'green';
    if (dec.toUpperCase().includes('SELL')) return 'red';
    return 'gold';
  };

  const renderReturn = (value?: number) => {
    if (value === undefined || value === null) return <Text type="secondary">--</Text>;
    const color = value > 0 ? '#cf1322' : value < 0 ? '#3f8600' : '#64748b';
    return <Text style={{ color, fontWeight: 700 }}>{value.toFixed(2)}%</Text>;
  };

  const getHorizonReturn = (signal: AISignalRecord, key: string) => {
    const item = signal.forward_returns?.horizons?.[key];
    return item?.status === 'completed' ? Number(item.return_pct) : undefined;
  };

  const signalColumns = [
    {
      title: '信号',
      key: 'signal',
      render: (_: any, record: AISignalRecord) => (
        <Space direction="vertical" size={0}>
          <Text strong>{record.name || record.symbol}</Text>
          <Text type="secondary">
            {record.symbol} · {record.signal_date}
          </Text>
        </Space>
      ),
    },
    {
      title: '建议',
      dataIndex: 'decision',
      key: 'decision',
      render: (text: string) => <Tag color={getDecisionColor(text)}>{text}</Tag>,
    },
    {
      title: '1日',
      key: 'r1',
      render: (_: any, record: AISignalRecord) => renderReturn(getHorizonReturn(record, '1d')),
    },
    {
      title: '3日',
      key: 'r3',
      render: (_: any, record: AISignalRecord) => renderReturn(getHorizonReturn(record, '3d')),
    },
    {
      title: '5日',
      key: 'r5',
      render: (_: any, record: AISignalRecord) => renderReturn(getHorizonReturn(record, '5d')),
    },
    {
      title: '10日',
      key: 'r10',
      render: (_: any, record: AISignalRecord) => renderReturn(getHorizonReturn(record, '10d')),
    },
    {
      title: '20日',
      key: 'r20',
      render: (_: any, record: AISignalRecord) => renderReturn(getHorizonReturn(record, '20d')),
    },
    {
      title: '验证',
      dataIndex: 'verification_status',
      key: 'verification_status',
      render: (status: string) => <Tag>{status}</Tag>,
    },
  ];

  const columns = [
    {
      title: '股票名称',
      dataIndex: 'name',
      key: 'name',
      render: (text: string, record: ScreenerRecord) => (
        <Space direction="vertical" size={0}>
          <Text strong>{text}</Text>
          <Text type="secondary">{record.symbol}</Text>
        </Space>
      ),
    },
    {
      title: 'AI 综合评分',
      dataIndex: 'score',
      key: 'score',
      render: (score: number) => {
        const color = score >= 80 ? '#f5222d' : score >= 60 ? '#faad14' : '#52c41a';
        return (
          <Text strong style={{ color, fontSize: 18 }}>
            {score || '-'}
          </Text>
        );
      },
      sorter: (a: ScreenerRecord, b: ScreenerRecord) => a.score - b.score,
      defaultSortOrder: 'descend' as const,
    },
    {
      title: '投资建议',
      dataIndex: 'decision',
      key: 'decision',
      render: (text: string) => (
        <Tag color={getDecisionColor(text)} style={{ padding: '4px 12px', fontSize: 14 }}>
          {text}
        </Tag>
      ),
    },
    {
      title: '核心理由',
      dataIndex: 'rationale',
      key: 'rationale',
      render: (text: string) => (
        <Paragraph ellipsis={{ rows: 2, expandable: false }} style={{ margin: 0, maxWidth: 400 }}>
          {text}
        </Paragraph>
      ),
    },
    {
      title: '评估时间',
      dataIndex: 'created_at',
      key: 'created_at',
      render: (text: string) => dayjs(text).format('YYYY-MM-DD HH:mm:ss'),
    },
    {
      title: '当前价 / 涨跌',
      key: 'price',
      render: (_: any, record: ScreenerRecord) => {
        const price =
          record.current_price !== undefined && record.current_price !== null
            ? record.current_price
            : '-';
        const change =
          record.price_change_pct !== undefined && record.price_change_pct !== null
            ? record.price_change_pct
            : '-';
        const isUp = typeof change === 'number' && change > 0;
        const isDown = typeof change === 'number' && change < 0;
        const color = isUp ? '#cf1322' : isDown ? '#3f8600' : 'inherit';

        return (
          <Space direction="vertical" size={0}>
            <Text strong style={{ color }}>
              {price}
            </Text>
            <Text style={{ color, fontSize: 12 }}>{change !== '-' ? `${change}%` : '-'}</Text>
          </Space>
        );
      },
    },
    {
      title: '近期趋势 (30天)',
      key: 'trend',
      width: 150,
      render: (_: any, record: ScreenerRecord) => {
        if (!record.recentTrend || record.recentTrend.length === 0) {
          return (
            <Text type="secondary" style={{ fontSize: 12 }}>
              暂无数据
            </Text>
          );
        }

        const isUp =
          record.recentTrend[record.recentTrend.length - 1].close >= record.recentTrend[0].close;
        const color = isUp ? '#cf1322' : '#3f8600'; // 红色涨，绿色跌

        return (
          <div style={{ height: 40, width: '100%' }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={record.recentTrend}>
                <defs>
                  <linearGradient id={`color-${record.id}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={color} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={color} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <Area
                  type="monotone"
                  dataKey="close"
                  stroke={color}
                  strokeWidth={1.5}
                  fill={`url(#color-${record.id})`}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        );
      },
    },
    {
      title: '操作',
      key: 'action',
      render: (_: any, record: ScreenerRecord) => (
        <Button
          type="link"
          icon={<EyeOutlined />}
          onClick={async () => {
            // 列表接口为性能优化不再返回 detail 大字段，点详情时按需拉取
            setSelectedRecord(record);
            setDetailVisible(true);
            if (!record.detail) {
              try {
                const resp = await api.get(`/ai/screener/${record.id}`);
                if (resp.data?.success && resp.data.data) {
                  setSelectedRecord({ ...record, detail: resp.data.data.detail });
                }
              } catch {
                // 忽略，Drawer 里会有 fallback 提示
              }
            }
          }}
        >
          查看详情
        </Button>
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
            <h1 className="page-title-modern">AI 每日优选</h1>
            <p className="page-subtitle-modern">基于多智能体深度分析的每日自选股研报汇总</p>
          </div>
          <Space>
            <Button icon={<BarChartOutlined />} onClick={handleSyncSignals} loading={signalLoading}>
              同步信号表现
            </Button>
            <Button
              icon={<SyncOutlined />}
              onClick={() => {
                fetchScreenerData();
                fetchSignalData();
              }}
              loading={loading || signalLoading}
            >
              刷新数据
            </Button>
            <Link to="/ai-advisor">
              <Button type="primary" icon={<RocketOutlined />}>
                发起实时推演
              </Button>
            </Link>
          </Space>
        </div>
      </div>

      <Card className="modern-card" variant="borderless" style={{ marginBottom: 16 }}>
        <Row gutter={[16, 16]} align="middle">
          <Col xs={12} md={6}>
            <Statistic title="归档信号" value={signalStats?.total_signals || 0} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic
              title="5日平均收益"
              value={signalStats?.horizon_summary?.['5d']?.avg_return_pct || 0}
              precision={2}
              suffix="%"
              valueStyle={{
                color:
                  (signalStats?.horizon_summary?.['5d']?.avg_return_pct || 0) >= 0
                    ? '#cf1322'
                    : '#3f8600',
              }}
            />
          </Col>
          <Col xs={12} md={6}>
            <Statistic
              title="10日胜率"
              value={signalStats?.horizon_summary?.['10d']?.positive_rate || 0}
              precision={1}
              suffix="%"
            />
          </Col>
          <Col xs={12} md={6}>
            <Statistic
              title="BUY信号数"
              value={
                (signalStats?.by_decision?.buy?.count || 0) +
                (signalStats?.by_decision?.strong_buy?.count || 0)
              }
            />
          </Col>
        </Row>
      </Card>

      <Card
        className="modern-card"
        variant="borderless"
        title="AI 建议后验表现"
        style={{ marginBottom: 16 }}
        extra={
          <Button size="small" onClick={fetchSignalData} loading={signalLoading}>
            刷新表现
          </Button>
        }
      >
        <Table
          columns={signalColumns}
          dataSource={signals}
          rowKey="id"
          size="small"
          loading={signalLoading}
          pagination={false}
          locale={{ emptyText: <Empty description="暂无归档信号，点击“同步信号表现”生成" /> }}
        />
      </Card>

      <Card className="card-modern" bodyStyle={{ padding: 0 }}>
        <Table
          columns={columns}
          dataSource={data}
          rowKey="id"
          loading={loading}
          pagination={{ pageSize: 10, showSizeChanger: false }}
          locale={{
            emptyText: <Empty description="今日暂无 AI 优选数据，请等待定时任务执行" />,
          }}
        />
      </Card>

      <Drawer
        title={
          selectedRecord ? (
            <Space>
              <RocketOutlined style={{ color: '#1677ff' }} />
              <span>
                {selectedRecord.name} ({selectedRecord.symbol}) - 完整推理过程
              </span>
            </Space>
          ) : (
            '推理详情'
          )
        }
        width={800}
        placement="right"
        onClose={() => setDetailVisible(false)}
        open={detailVisible}
      >
        {selectedRecord && (
          <div>
            <Descriptions column={2} bordered size="small" style={{ marginBottom: 24 }}>
              <Descriptions.Item label="评估时间">
                {dayjs(selectedRecord.created_at).format('YYYY-MM-DD HH:mm:ss')}
              </Descriptions.Item>
              <Descriptions.Item label="当时股价">
                <Text strong>{selectedRecord.current_price || '-'}</Text>
                <Text type="secondary" style={{ marginLeft: 8 }}>
                  (
                  {selectedRecord.price_change_pct !== undefined
                    ? `${selectedRecord.price_change_pct}%`
                    : '-'}
                  )
                </Text>
              </Descriptions.Item>
              <Descriptions.Item label="综合评分">
                <Text strong style={{ color: selectedRecord.score >= 80 ? '#f5222d' : '#faad14' }}>
                  {selectedRecord.score}
                </Text>
              </Descriptions.Item>
              <Descriptions.Item label="投资建议">
                <Tag color={getDecisionColor(selectedRecord.decision)}>
                  {selectedRecord.decision}
                </Tag>
              </Descriptions.Item>
            </Descriptions>

            <Title level={5}>完整研报 (TradingAgent)</Title>
            <div
              style={{
                background: '#f8fafc',
                padding: '24px',
                borderRadius: '8px',
                border: '1px solid #e2e8f0',
              }}
            >
              {selectedRecord.detail ? (
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    h1: ({ node: _node, ...props }) => <Title level={2} {...props} />,
                    h2: ({ node: _node, ...props }) => <Title level={3} {...props} />,
                    h3: ({ node: _node, ...props }) => <Title level={4} {...props} />,
                    h4: ({ node: _node, ...props }) => <Title level={5} {...props} />,
                    p: ({ node: _node, ...props }) => <Paragraph {...props} />,
                  }}
                >
                  {selectedRecord.detail}
                </ReactMarkdown>
              ) : (
                <Empty description="该条记录暂无完整的推演明细" />
              )}
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
};

export default Screener;
