import React, { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  Col,
  Collapse,
  DatePicker,
  Empty,
  Form,
  InputNumber,
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
  ExperimentOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  TrophyOutlined,
} from '@ant-design/icons';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import dayjs from 'dayjs';
import api from '../services/api';

const { RangePicker } = DatePicker;
const { Text } = Typography;

type Strategy = { strategy_key: string; name: string };
type BacktestTask = {
  id: number;
  task_name: string;
  status: string;
  progress: number;
  start_date: string;
  end_date: string;
  created_at: string;
};
type BacktestResult = {
  strategy_key: string;
  strategy_name: string;
  total_return_pct: number;
  excess_return_pct?: number;
  benchmark_return_pct?: number;
  max_drawdown_pct: number;
  sharpe_ratio: number;
  win_rate: number;
  trade_count: number;
  equity_curve_json: any[];
};

type BacktestDetail = { task: BacktestTask; results: BacktestResult[]; trades: any[] };

const QuantBacktestLab: React.FC = () => {
  const [form] = Form.useForm();
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [tasks, setTasks] = useState<BacktestTask[]>([]);
  const [detail, setDetail] = useState<BacktestDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [pollingTaskId, setPollingTaskId] = useState<number | null>(null);

  const fetchStrategies = async () => {
    const response = await api.get('/quant/strategies');
    if (response.data.success) setStrategies(response.data.data || []);
  };

  const fetchTasks = async () => {
    const response = await api.get('/quant/backtests');
    if (response.data.success) setTasks(response.data.data || []);
  };

  const fetchDetail = async (id: number) => {
    setLoading(true);
    try {
      const response = await api.get(`/quant/backtests/${id}`);
      if (response.data.success) setDetail(response.data.data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStrategies();
    fetchTasks();
  }, []);

  const runBacktest = async () => {
    const values = await form.validateFields();
    const [start, end] = values.range || [];
    setRunning(true);
    try {
      const response = await api.post('/quant/backtests', {
        task_name: values.task_name || '量化多策略跑分',
        universe: values.universe,
        strategy_keys: values.strategy_keys,
        start_date: start.format('YYYY-MM-DD'),
        end_date: end.format('YYYY-MM-DD'),
        initial_capital: values.initial_capital,
        candidate_limit: values.candidate_limit,
        max_positions: values.max_positions,
        position_pct: values.position_pct,
        min_score: values.min_score,
      });
      if (response.data.success) {
        const taskDetail = response.data.data?.task;
        const taskRecord = taskDetail?.task || taskDetail;
        if (taskRecord?.id && taskRecord.status !== 'COMPLETED') {
          setPollingTaskId(taskRecord.id);
          message.success('跑分任务已进入队列，页面会自动刷新结果');
        } else {
          message.success('跑分完成');
        }
        await fetchTasks();
        setDetail(taskDetail);
      }
    } catch (error: any) {
      message.error(error.response?.data?.message || '运行跑分失败');
    } finally {
      setRunning(false);
    }
  };

  useEffect(() => {
    if (!pollingTaskId) return undefined;
    const timer = window.setInterval(async () => {
      const response = await api.get(`/quant/backtests/${pollingTaskId}`);
      if (!response.data.success) return;
      const nextDetail = response.data.data;
      setDetail(nextDetail);
      await fetchTasks();
      const status = nextDetail?.task?.status;
      if (status === 'COMPLETED' || status === 'FAILED') {
        setPollingTaskId(null);
        message[status === 'COMPLETED' ? 'success' : 'error'](
          status === 'COMPLETED' ? '跑分完成' : '跑分失败，请查看任务错误'
        );
      }
    }, 3000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollingTaskId]);

  const best = useMemo(
    () =>
      [...(detail?.results || [])].sort(
        (a, b) => Number(b.total_return_pct) - Number(a.total_return_pct)
      )[0],
    [detail]
  );
  const curve = best?.equity_curve_json || [];

  const resultColumns = [
    {
      title: '策略',
      dataIndex: 'strategy_name',
      key: 'strategy_name',
      fixed: 'left' as const,
      width: 180,
    },
    {
      title: '总收益',
      dataIndex: 'total_return_pct',
      key: 'total_return_pct',
      sorter: (a: BacktestResult, b: BacktestResult) => a.total_return_pct - b.total_return_pct,
      render: (v: number) => (
        <Text strong style={{ color: Number(v) >= 0 ? '#cf1322' : '#0f8f6b' }}>
          {Number(v || 0).toFixed(2)}%
        </Text>
      ),
    },
    {
      title: '最大回撤',
      dataIndex: 'max_drawdown_pct',
      key: 'max_drawdown_pct',
      render: (v: number) => `${Number(v || 0).toFixed(2)}%`,
    },
    {
      title: '夏普',
      dataIndex: 'sharpe_ratio',
      key: 'sharpe_ratio',
      render: (v: number) => Number(v || 0).toFixed(2),
    },
    {
      title: '超额收益',
      dataIndex: 'excess_return_pct',
      key: 'excess_return_pct',
      render: (v: number) => `${Number(v || 0).toFixed(2)}%`,
    },
    {
      title: '胜率',
      dataIndex: 'win_rate',
      key: 'win_rate',
      render: (v: number) => `${Number(v || 0).toFixed(1)}%`,
    },
    { title: '交易次数', dataIndex: 'trade_count', key: 'trade_count' },
  ];

  return (
    <div className="quant-research-page fade-in-up">
      <div className="quant-research-hero compact">
        <div>
          <div className="quant-research-kicker">BACKTEST SCORE LAB</div>
          <h1>策略跑分实验室</h1>
          <p>
            选择多个策略、股票池和时间区间，自动跑出收益率、回撤、夏普、胜率和交易明细，用真实历史数据验证策略是否值得进入自动荐股闭环。
          </p>
        </div>
        <div className="quant-research-meter">
          <span>BEST</span>
          <strong>{best ? `${Number(best.total_return_pct).toFixed(1)}%` : '--'}</strong>
          <em>{best?.strategy_name || '等待跑分'}</em>
        </div>
      </div>

      <Card className="modern-card quant-backtest-form" variant="borderless">
        <Form
          form={form}
          layout="vertical"
          initialValues={{
            universe: 'market',
            strategy_keys: [
              'multi_factor_ranking',
              'relative_strength_momentum',
              'volume_price_confirmation',
              'low_volatility_quality',
            ],
            range: [dayjs().subtract(180, 'day'), dayjs()],
            initial_capital: 200000,
            candidate_limit: 80,
            max_positions: 8,
            position_pct: 10,
            min_score: 68,
          }}
        >
          <Row gutter={[14, 0]}>
            <Col xs={24} md={6}>
              <Form.Item label="股票池" name="universe">
                <Select
                  options={[
                    { label: '全市场', value: 'market' },
                    { label: '自选股', value: 'favorites' },
                  ]}
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={10}>
              <Form.Item label="策略" name="strategy_keys" rules={[{ required: true }]}>
                <Select
                  mode="multiple"
                  options={strategies.map(s => ({ label: s.name, value: s.strategy_key }))}
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item label="时间范围" name="range" rules={[{ required: true }]}>
                <RangePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={4}>
              <Form.Item label="执行">
                <Button
                  type="primary"
                  icon={<PlayCircleOutlined />}
                  loading={running}
                  onClick={runBacktest}
                  block
                >
                  开始跑分
                </Button>
              </Form.Item>
            </Col>
            <Col span={24}>
              <Collapse
                ghost
                className="quant-advanced-collapse"
                items={[
                  {
                    key: 'advanced',
                    label: '高级参数（默认已按 20W 模拟资金和 8 只持仓配置）',
                    children: (
                      <Row gutter={[14, 0]}>
                        <Col xs={12} md={4}>
                          <Form.Item label="初始资金" name="initial_capital">
                            <InputNumber style={{ width: '100%' }} min={10000} />
                          </Form.Item>
                        </Col>
                        <Col xs={12} md={4}>
                          <Form.Item label="候选上限" name="candidate_limit">
                            <InputNumber style={{ width: '100%' }} min={10} max={500} />
                          </Form.Item>
                        </Col>
                        <Col xs={12} md={4}>
                          <Form.Item label="最大持仓" name="max_positions">
                            <InputNumber style={{ width: '100%' }} min={1} max={30} />
                          </Form.Item>
                        </Col>
                        <Col xs={12} md={4}>
                          <Form.Item label="单票仓位%" name="position_pct">
                            <InputNumber style={{ width: '100%' }} min={1} max={30} />
                          </Form.Item>
                        </Col>
                        <Col xs={12} md={4}>
                          <Form.Item label="最低分" name="min_score">
                            <InputNumber style={{ width: '100%' }} min={0} max={100} />
                          </Form.Item>
                        </Col>
                      </Row>
                    ),
                  },
                ]}
              />
            </Col>
          </Row>
        </Form>
      </Card>

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={24} xl={7}>
          <Card
            className="modern-card"
            title="历史跑分任务"
            extra={<Button icon={<ReloadOutlined />} onClick={fetchTasks} />}
            loading={loading}
          >
            <Space direction="vertical" style={{ width: '100%' }}>
              {tasks.slice(0, 10).map(task => (
                <div className="quant-task-row" key={task.id} onClick={() => fetchDetail(task.id)}>
                  <strong>{task.task_name}</strong>
                  <span>
                    {task.start_date}~{task.end_date}
                  </span>
                  <Space size={6}>
                    <Tag
                      color={
                        task.status === 'COMPLETED'
                          ? 'green'
                          : task.status === 'FAILED'
                          ? 'red'
                          : task.status === 'QUEUED'
                          ? 'gold'
                          : 'blue'
                      }
                    >
                      {task.status}
                    </Tag>
                    {['QUEUED', 'RUNNING'].includes(task.status) && (
                      <Progress
                        percent={Number(task.progress || 0)}
                        size="small"
                        style={{ width: 72 }}
                        showInfo={false}
                      />
                    )}
                  </Space>
                </div>
              ))}
              {!tasks.length && <Empty description="暂无跑分任务" />}
            </Space>
          </Card>
        </Col>
        <Col xs={24} xl={17}>
          <Card className="modern-card" title="冠军策略资金曲线" loading={loading}>
            <div style={{ height: 320 }}>
              {curve.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={curve}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(15,23,42,.08)" />
                    <XAxis dataKey="date" />
                    <YAxis />
                    <Tooltip />
                    <Area
                      type="monotone"
                      dataKey="total_value"
                      stroke="#2764b8"
                      fill="rgba(39,100,184,.14)"
                      strokeWidth={3}
                      name="总资产"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <Empty description="请选择或运行一个跑分任务" />
              )}
            </div>
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={12} md={6}>
          <Card className="modern-card">
            <Statistic
              title="冠军策略"
              value={best?.strategy_name || '--'}
              prefix={<TrophyOutlined />}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card className="modern-card">
            <Statistic
              title="总收益"
              value={Number(best?.total_return_pct || 0)}
              suffix="%"
              precision={2}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card className="modern-card">
            <Statistic
              title="超额收益"
              value={Number(best?.excess_return_pct || 0)}
              suffix="%"
              precision={2}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card className="modern-card">
            <Statistic
              title="交易次数"
              value={best?.trade_count || 0}
              prefix={<ExperimentOutlined />}
            />
          </Card>
        </Col>
      </Row>

      <Card className="modern-card" title="策略跑分对比">
        <Table
          columns={resultColumns}
          dataSource={detail?.results || []}
          rowKey="strategy_key"
          scroll={{ x: 900 }}
          pagination={false}
          locale={{ emptyText: <Empty description="暂无跑分结果" /> }}
        />
      </Card>
    </div>
  );
};

export default QuantBacktestLab;
