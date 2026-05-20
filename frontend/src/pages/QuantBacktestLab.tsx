import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
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
  Tooltip as AntTooltip,
  Typography,
  message,
} from 'antd';
import {
  ClockCircleOutlined,
  ExperimentOutlined,
  FieldTimeOutlined,
  PlayCircleOutlined,
  RedoOutlined,
  ReloadOutlined,
  StockOutlined,
  WarningOutlined,
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

type Strategy = { strategy_key: string; name: string; enabled?: boolean };
type RunSummary = {
  task_id?: number;
  status?: string;
  progress?: number;
  universe?: string;
  start_date?: string;
  end_date?: string;
  range_label?: string;
  strategy_count?: number;
  symbol_count?: number;
  candidate_limit?: number;
  initial_capital?: number;
  run_started_at?: string | null;
  run_finished_at?: string | null;
  run_completed_at?: string | null;
  run_failed_at?: string | null;
  duration_seconds?: number;
  duration_label?: string;
  queue_wait_seconds?: number;
  queue_wait_label?: string;
  last_stage?: string | null;
  retry_count?: number;
  last_error?: string | null;
  scanned_stocks?: number;
  benchmark_return_pct?: number;
  best_strategy_key?: string | null;
  best_strategy_name?: string | null;
  best_return_pct?: number;
  best_excess_return_pct?: number;
  best_max_drawdown_pct?: number;
  best_sharpe_ratio?: number;
  best_trade_count?: number;
  worst_strategy_key?: string | null;
  worst_return_pct?: number;
  result_count?: number;
  retryable?: boolean;
  resumable?: boolean;
  conclusion?: string;
  best_validation_verdict?: string;
};
type BacktestTask = {
  id: number;
  task_name: string;
  status: string;
  progress: number;
  start_date: string;
  end_date: string;
  created_at: string;
  updated_at?: string;
  error_message?: string;
  universe?: string;
  strategy_keys?: string[];
  symbols?: string[];
  initial_capital?: number;
  parameters?: Record<string, any>;
  run_summary?: RunSummary;
};
type BacktestResult = {
  strategy_key: string;
  strategy_name: string;
  total_return_pct: number;
  annual_return_pct?: number;
  excess_return_pct?: number;
  benchmark_return_pct?: number;
  max_drawdown_pct: number;
  sharpe_ratio: number;
  win_rate: number;
  profit_factor?: number;
  trade_count: number;
  avg_holding_days?: number;
  equity_curve_json: any[];
  metrics_json?: Record<string, any>;
};

type BacktestDetail = {
  task: BacktestTask;
  results: BacktestResult[];
  trades: any[];
  run_summary?: RunSummary;
};
type GridSearchSummary = {
  group_count: number;
  param_versions?: {
    upserted_count?: number;
    conclusion?: string;
    versions?: Array<{
      version_key: string;
      strategy_key: string;
      version_type: string;
      status: string;
      source_rank_score?: number;
      source_excess_return_pct?: number;
      adoption_reason?: string;
    }>;
  } | null;
  groups: Array<{
    group_id: string;
    parent_task_name: string;
    total_tasks: number;
    completed_tasks: number;
    failed_tasks: number;
    running_tasks: number;
    conclusion: string;
    best?: any;
    candidates: any[];
  }>;
};

const pct = (value?: number | string | null, precision = 2) =>
  Number.isFinite(Number(value)) ? `${Number(value).toFixed(precision)}%` : '--';

const money = (value?: number | string | null) =>
  Number.isFinite(Number(value)) ? `¥${Number(value).toLocaleString()}` : '--';

const compactDate = (value?: string | null) => {
  if (!value) return '--';
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format('YYYY-MM-DD') : String(value).slice(0, 10);
};

const formatTime = (value?: string | null) => {
  if (!value) return '--';
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format('MM-DD HH:mm') : value;
};

const formatDateTime = (value?: string | null) => {
  if (!value) return '--';
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format('YYYY-MM-DD HH:mm:ss') : value;
};

const statusColor = (status?: string) => {
  if (status === 'COMPLETED') return 'green';
  if (status === 'FAILED') return 'red';
  if (status === 'QUEUED') return 'gold';
  if (status === 'RUNNING') return 'blue';
  return 'default';
};

const statusLabel = (status?: string) => {
  const labels: Record<string, string> = {
    COMPLETED: '已完成',
    FAILED: '失败',
    QUEUED: '队列中',
    RUNNING: '运行中',
    PENDING: '待运行',
  };
  return labels[status || ''] || status || '--';
};

const universeLabel = (value?: string) => (value === 'favorites' ? '自选股' : '全市场');
const isQueueLockFailure = (messageText?: string | null) =>
  /stalled|missing lock|lock/i.test(messageText || '');
const validationLabel = (value?: string) =>
  value === 'passed' ? '通过' : value === 'watch' ? '观察' : '--';
const validationColor = (value?: string) =>
  value === 'passed' ? 'green' : value === 'watch' ? 'gold' : 'default';

const stageLabel = (stage?: string | null) => {
  const labels: Record<string, string> = {
    queued_retry: '重试排队',
    prepare_contexts: '准备股票数据',
    resolve_benchmark: '计算基准收益',
    run_engine: '执行策略引擎',
    persist_results: '写入跑分结果',
    completed: '完成',
  };
  return labels[stage || ''] || stage || '--';
};

const QuantBacktestLab: React.FC = () => {
  const [form] = Form.useForm();
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [tasks, setTasks] = useState<BacktestTask[]>([]);
  const [detail, setDetail] = useState<BacktestDetail | null>(null);
  const [gridSummary, setGridSummary] = useState<GridSearchSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [walking, setWalking] = useState(false);
  const [gridSearching, setGridSearching] = useState(false);
  const [upsertingGrid, setUpsertingGrid] = useState(false);
  const [retryingId, setRetryingId] = useState<number | null>(null);
  const [pollingTaskId, setPollingTaskId] = useState<number | null>(null);

  const fetchStrategies = useCallback(async () => {
    const response = await api.get('/quant/strategies');
    if (response.data.success) {
      const strategyList = response.data.data || [];
      setStrategies(strategyList);
      const enabledKeys = strategyList
        .filter((item: Strategy) => item.enabled !== false)
        .map((item: Strategy) => item.strategy_key);
      const currentKeys = form.getFieldValue('strategy_keys') || [];
      if (!currentKeys.length && enabledKeys.length) {
        form.setFieldValue('strategy_keys', enabledKeys.slice(0, 6));
      }
    }
  }, [form]);

  const fetchTasks = useCallback(async () => {
    const response = await api.get('/quant/backtests');
    if (response.data.success) setTasks(response.data.data || []);
  }, []);

  const fetchGridSummary = useCallback(async () => {
    const response = await api.get('/quant/backtests/grid-search/summary');
    if (response.data.success) setGridSummary(response.data.data || null);
  }, []);

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
    fetchGridSummary();
  }, [fetchStrategies, fetchTasks, fetchGridSummary]);

  useEffect(() => {
    if (!detail && tasks[0]?.id) fetchDetail(tasks[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, detail]);

  const selectedSummary = detail?.run_summary || detail?.task?.run_summary;
  const selectedTask = detail?.task;

  const buildBacktestPayload = (values: any, start: dayjs.Dayjs, end: dayjs.Dayjs) => ({
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
    execution_timing: values.execution_timing,
    enable_t_plus_one: values.enable_t_plus_one,
    lot_size: values.lot_size,
    min_commission: values.min_commission,
    stamp_tax_rate: values.stamp_tax_rate,
    block_limit_up: values.block_limit_up,
    block_limit_down: values.block_limit_down,
    block_suspended: values.block_suspended,
    dynamic_slippage: values.dynamic_slippage,
    min_turnover_yuan: values.min_turnover_yuan,
    max_trade_amount_pct_of_turnover: values.max_trade_amount_pct_of_turnover,
    validation_split: {
      enabled: true,
      train_pct: values.validation_train_pct,
      validation_pct: values.validation_pct,
      test_pct: Math.max(
        0,
        100 - Number(values.validation_train_pct || 60) - Number(values.validation_pct || 20)
      ),
    },
  });

  const runBacktest = async () => {
    const values = await form.validateFields();
    const [start, end] = values.range || [];
    setRunning(true);
    try {
      const response = await api.post('/quant/backtests', buildBacktestPayload(values, start, end));
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
        if (taskRecord?.id) await fetchDetail(taskRecord.id);
      }
    } catch (error: any) {
      message.error(error.response?.data?.message || '运行跑分失败');
    } finally {
      setRunning(false);
    }
  };

  const runWalkForward = async () => {
    const values = await form.validateFields();
    const [start, end] = values.range || [];
    setWalking(true);
    try {
      const response = await api.post('/quant/backtests/walk-forward', {
        ...buildBacktestPayload(values, start, end),
        parent_task_name: values.task_name || '量化滚动验证',
        windows: values.walk_windows,
        window_days: values.walk_window_days,
        step_days: values.walk_step_days,
      });
      if (response.data.success) {
        const tasksCreated = response.data.data?.tasks || [];
        const firstTask = tasksCreated[0]?.task?.task || tasksCreated[0]?.task || tasksCreated[0];
        if (firstTask?.id) setPollingTaskId(firstTask.id);
        message.success(response.data.message || `已创建 ${tasksCreated.length} 个滚动验证任务`);
        await fetchTasks();
        await fetchGridSummary();
        if (firstTask?.id) await fetchDetail(firstTask.id);
      }
    } catch (error: any) {
      message.error(error.response?.data?.message || '创建滚动验证失败');
    } finally {
      setWalking(false);
    }
  };

  const runGridSearch = async () => {
    const values = await form.validateFields();
    const [start, end] = values.range || [];
    setGridSearching(true);
    try {
      const response = await api.post('/quant/backtests/grid-search', {
        ...buildBacktestPayload(values, start, end),
        parent_task_name: values.task_name || '量化参数网格搜索',
        max_tasks: values.grid_max_tasks,
      });
      if (response.data.success) {
        const tasksCreated = response.data.data?.tasks || [];
        const firstTask = tasksCreated[0]?.task?.task || tasksCreated[0]?.task || tasksCreated[0];
        if (firstTask?.id) setPollingTaskId(firstTask.id);
        message.success(response.data.message || `已创建 ${tasksCreated.length} 个参数搜索任务`);
        await fetchTasks();
        await fetchGridSummary();
        if (firstTask?.id) await fetchDetail(firstTask.id);
      }
    } catch (error: any) {
      message.error(error.response?.data?.message || '创建参数网格搜索失败');
    } finally {
      setGridSearching(false);
    }
  };

  const upsertGridParamVersions = async () => {
    setUpsertingGrid(true);
    try {
      const response = await api.get('/quant/backtests/grid-search/summary', {
        params: { upsert_versions: true },
      });
      if (response.data.success) {
        setGridSummary(response.data.data || null);
        const count = response.data.data?.param_versions?.upserted_count || 0;
        message.success(count ? `已沉淀 ${count} 个网格参数版本` : '暂无达到门槛的网格冠军参数');
      }
    } catch (error: any) {
      message.error(error.response?.data?.message || '沉淀网格参数版本失败');
    } finally {
      setUpsertingGrid(false);
    }
  };

  const retryBacktest = async (task: BacktestTask) => {
    setRetryingId(task.id);
    try {
      const response = await api.post(`/quant/backtests/${task.id}/retry`);
      if (response.data.success) {
        const taskDetail = response.data.data?.task;
        const taskRecord = taskDetail?.task || taskDetail;
        setPollingTaskId(taskRecord?.id || task.id);
        message.success(response.data.data?.message || '已重新入队');
        await fetchTasks();
        await fetchDetail(task.id);
      }
    } catch (error: any) {
      message.error(error.response?.data?.message || '重试跑分失败');
    } finally {
      setRetryingId(null);
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
      await fetchGridSummary();
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
  const latestFailed = tasks.find(task => task.status === 'FAILED');
  const lastTask = tasks[0];
  const taskStrategies =
    selectedTask?.strategy_keys || selectedTask?.parameters?.strategy_keys || [];
  const scannedStocks =
    selectedSummary?.scanned_stocks ||
    selectedTask?.parameters?.scanned_stocks ||
    selectedSummary?.candidate_limit ||
    selectedTask?.parameters?.scanned_stocks ||
    selectedTask?.symbols?.length ||
    0;
  const selectedErrorText = selectedTask?.error_message || selectedSummary?.last_error;
  const selectedQueueLockFailure = isQueueLockFailure(selectedErrorText);
  const selectedValidation = best?.metrics_json?.validation || {};

  const resultColumns = [
    {
      title: '策略',
      dataIndex: 'strategy_name',
      key: 'strategy_name',
      fixed: 'left' as const,
      width: 190,
      render: (text: string, record: BacktestResult) => (
        <Space direction="vertical" size={0}>
          <Text strong>{text || record.strategy_key}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {record.strategy_key}
          </Text>
        </Space>
      ),
    },
    {
      title: '总收益 / 超额',
      key: 'return_pair',
      width: 150,
      sorter: (a: BacktestResult, b: BacktestResult) => a.total_return_pct - b.total_return_pct,
      render: (_: any, record: BacktestResult) => (
        <Space direction="vertical" size={0}>
          <Text
            strong
            style={{ color: Number(record.total_return_pct) >= 0 ? '#cf1322' : '#0f8f6b' }}
          >
            {pct(record.total_return_pct)}
          </Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            超额 {pct(record.excess_return_pct)} · 基准 {pct(record.benchmark_return_pct)}
          </Text>
        </Space>
      ),
    },
    {
      title: '风险',
      key: 'risk',
      width: 130,
      render: (_: any, record: BacktestResult) => (
        <Space direction="vertical" size={0}>
          <Text>回撤 {pct(record.max_drawdown_pct)}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            夏普 {Number(record.sharpe_ratio || 0).toFixed(2)}
          </Text>
        </Space>
      ),
    },
    {
      title: '胜率/交易',
      key: 'win_trade',
      width: 128,
      render: (_: any, record: BacktestResult) => (
        <Space direction="vertical" size={0}>
          <Text>{pct(record.win_rate, 1)}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {record.trade_count || 0} 笔 · 持仓 {Number(record.avg_holding_days || 0).toFixed(1)}天
          </Text>
        </Space>
      ),
    },
    {
      title: '真实执行诊断',
      key: 'execution_diagnostics',
      width: 240,
      render: (_: any, record: BacktestResult) => {
        const diagnostics = record.metrics_json?.execution_diagnostics || {};
        const blocked =
          Number(diagnostics.blocked_buy_count || 0) + Number(diagnostics.blocked_sell_count || 0);
        return (
          <Space direction="vertical" size={0}>
            <Text>
              买入 {diagnostics.buy_fill_count || 0}/{diagnostics.buy_attempt_count || 0} · 卖出{' '}
              {diagnostics.sell_fill_count || 0}/{diagnostics.sell_attempt_count || 0}
            </Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              阻塞 {blocked} · 成本 ¥
              {Number(
                Number(diagnostics.total_commission || 0) +
                  Number(diagnostics.total_stamp_tax || 0) +
                  Number(diagnostics.total_slippage_cost || 0)
              ).toLocaleString()}
            </Text>
          </Space>
        );
      },
    },
    {
      title: '样本外验证',
      key: 'validation',
      width: 220,
      render: (_: any, record: BacktestResult) => {
        const validation = record.metrics_json?.validation || {};
        return (
          <Space direction="vertical" size={0}>
            <Tag color={validationColor(validation.verdict)}>
              {validationLabel(validation.verdict)}
            </Tag>
            <Text type="secondary" style={{ fontSize: 12 }}>
              验证超额 {pct(validation.segments?.validation?.excess_return_pct)} · 测试超额{' '}
              {pct(validation.segments?.test?.excess_return_pct)}
            </Text>
          </Space>
        );
      },
    },
  ];

  return (
    <div className="quant-research-page quant-backtest-page fade-in-up">
      <div className="quant-research-hero compact quant-backtest-hero">
        <div>
          <div className="quant-research-kicker">BACKTEST SCORE LAB</div>
          <h1>策略跑分实验室</h1>
          <p>
            一页看清本次跑分的范围、时间、耗时、收益和失败原因；失败任务可以按原参数一键重试/续跑，避免重复配置。
          </p>
          <Space wrap className="quant-backtest-hero-tags">
            <Tag icon={<StockOutlined />}>{universeLabel(lastTask?.universe)}优先</Tag>
            <Tag icon={<FieldTimeOutlined />}>A股真实成交护栏</Tag>
            <Tag icon={<ClockCircleOutlined />}>队列自动刷新</Tag>
            <Tag icon={<ExperimentOutlined />}>参数实验可沉淀</Tag>
            <Tag icon={<ExperimentOutlined />}>因子表已参与多因子/量价/质量策略</Tag>
          </Space>
        </div>
        <div className="quant-research-meter">
          <span>BEST</span>
          <strong>{best ? pct(best.total_return_pct, 1) : '--'}</strong>
          <em>{best?.strategy_name || selectedSummary?.best_strategy_name || '等待跑分'}</em>
        </div>
      </div>

      {latestFailed && (
        <Alert
          className="quant-backtest-failure-alert"
          type="error"
          showIcon
          icon={<WarningOutlined />}
          message={`最近失败：${latestFailed.task_name}`}
          description={
            <Space direction="vertical" size={4}>
              <Text>{latestFailed.error_message || '未知错误'}</Text>
              <Text type="secondary">
                已运行 {latestFailed.run_summary?.duration_label || '--'} · 范围{' '}
                {latestFailed.run_summary?.range_label ||
                  `${compactDate(latestFailed.start_date)} ~ ${compactDate(latestFailed.end_date)}`}
                。
                {isQueueLockFailure(latestFailed.error_message)
                  ? '线上日志显示该任务来自 Bull 长任务锁续约丢失（job stalled / missing lock），已加长跑分队列锁周期并降低默认并发，可直接重试。'
                  : '可以按原参数重新入队；重试会刷新同一个任务的结果，避免重复配置。'}
              </Text>
              <Button
                danger
                icon={<RedoOutlined />}
                loading={retryingId === latestFailed.id}
                onClick={() => retryBacktest(latestFailed)}
              >
                按原参数重试/续跑
              </Button>
            </Space>
          }
        />
      )}

      <Card className="modern-card quant-backtest-form" variant="borderless">
        <Form
          form={form}
          layout="vertical"
          initialValues={{
            universe: 'market',
            strategy_keys: [],
            range: [dayjs().subtract(180, 'day'), dayjs()],
            initial_capital: 200000,
            candidate_limit: 80,
            max_positions: 8,
            position_pct: 10,
            min_score: 68,
            execution_timing: 'next_open',
            enable_t_plus_one: true,
            lot_size: 100,
            min_commission: 5,
            stamp_tax_rate: 0.001,
            block_limit_up: true,
            block_limit_down: true,
            block_suspended: true,
            dynamic_slippage: true,
            min_turnover_yuan: 0,
            max_trade_amount_pct_of_turnover: 1,
            validation_train_pct: 60,
            validation_pct: 20,
            walk_windows: 3,
            walk_window_days: 180,
            walk_step_days: 60,
            grid_max_tasks: 12,
          }}
        >
          <Alert
            showIcon
            type="info"
            style={{ marginBottom: 14 }}
            message="默认使用 A 股真实回测护栏"
            description="跑分默认按次日开盘成交、T+1、一手100股、最低佣金、印花税、动态滑点、涨跌停/停牌/流动性约束执行，减少未来函数和不可成交收益。"
          />
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
            <Col xs={24} md={4}>
              <Form.Item label="稳健验证">
                <Button loading={walking} onClick={runWalkForward} block>
                  滚动验证
                </Button>
              </Form.Item>
            </Col>
            <Col xs={24} md={4}>
              <Form.Item label="参数实验">
                <Button loading={gridSearching} onClick={runGridSearch} block>
                  网格搜索
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
                        <Col xs={12} md={4}>
                          <Form.Item label="成交时点" name="execution_timing">
                            <Select
                              options={[
                                { label: '次日开盘', value: 'next_open' },
                                { label: '当日收盘', value: 'same_close' },
                              ]}
                            />
                          </Form.Item>
                        </Col>
                        <Col xs={12} md={4}>
                          <Form.Item label="T+1" name="enable_t_plus_one">
                            <Select
                              options={[
                                { label: '开启', value: true },
                                { label: '关闭', value: false },
                              ]}
                            />
                          </Form.Item>
                        </Col>
                        <Col xs={12} md={4}>
                          <Form.Item label="一手股数" name="lot_size">
                            <InputNumber style={{ width: '100%' }} min={1} max={1000} />
                          </Form.Item>
                        </Col>
                        <Col xs={12} md={4}>
                          <Form.Item label="最低佣金" name="min_commission">
                            <InputNumber style={{ width: '100%' }} min={0} max={50} />
                          </Form.Item>
                        </Col>
                        <Col xs={12} md={4}>
                          <Form.Item label="印花税率" name="stamp_tax_rate">
                            <InputNumber
                              style={{ width: '100%' }}
                              min={0}
                              max={0.01}
                              step={0.0001}
                            />
                          </Form.Item>
                        </Col>
                        <Col xs={12} md={4}>
                          <Form.Item label="动态滑点" name="dynamic_slippage">
                            <Select
                              options={[
                                { label: '开启', value: true },
                                { label: '关闭', value: false },
                              ]}
                            />
                          </Form.Item>
                        </Col>
                        <Col xs={12} md={4}>
                          <Form.Item label="涨停禁买" name="block_limit_up">
                            <Select
                              options={[
                                { label: '开启', value: true },
                                { label: '关闭', value: false },
                              ]}
                            />
                          </Form.Item>
                        </Col>
                        <Col xs={12} md={4}>
                          <Form.Item label="跌停禁卖" name="block_limit_down">
                            <Select
                              options={[
                                { label: '开启', value: true },
                                { label: '关闭', value: false },
                              ]}
                            />
                          </Form.Item>
                        </Col>
                        <Col xs={12} md={4}>
                          <Form.Item label="停牌过滤" name="block_suspended">
                            <Select
                              options={[
                                { label: '开启', value: true },
                                { label: '关闭', value: false },
                              ]}
                            />
                          </Form.Item>
                        </Col>
                        <Col xs={12} md={4}>
                          <Form.Item label="最低成交额" name="min_turnover_yuan">
                            <InputNumber style={{ width: '100%' }} min={0} step={1000000} />
                          </Form.Item>
                        </Col>
                        <Col xs={12} md={4}>
                          <Form.Item label="成交额占比%" name="max_trade_amount_pct_of_turnover">
                            <InputNumber style={{ width: '100%' }} min={0.01} max={10} step={0.1} />
                          </Form.Item>
                        </Col>
                        <Col xs={12} md={4}>
                          <Form.Item label="训练集%" name="validation_train_pct">
                            <InputNumber style={{ width: '100%' }} min={10} max={90} />
                          </Form.Item>
                        </Col>
                        <Col xs={12} md={4}>
                          <Form.Item label="验证集%" name="validation_pct">
                            <InputNumber style={{ width: '100%' }} min={5} max={60} />
                          </Form.Item>
                        </Col>
                        <Col xs={12} md={4}>
                          <Form.Item label="滚动窗口数" name="walk_windows">
                            <InputNumber style={{ width: '100%' }} min={1} max={8} />
                          </Form.Item>
                        </Col>
                        <Col xs={12} md={4}>
                          <Form.Item label="窗口天数" name="walk_window_days">
                            <InputNumber style={{ width: '100%' }} min={60} max={720} />
                          </Form.Item>
                        </Col>
                        <Col xs={12} md={4}>
                          <Form.Item label="步长天数" name="walk_step_days">
                            <InputNumber style={{ width: '100%' }} min={20} max={360} />
                          </Form.Item>
                        </Col>
                        <Col xs={12} md={4}>
                          <Form.Item label="网格任务上限" name="grid_max_tasks">
                            <InputNumber style={{ width: '100%' }} min={1} max={48} />
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

      <Row gutter={[16, 16]} className="quant-backtest-summary-row">
        <Col xs={12} md={6}>
          <Card className="modern-card quant-backtest-kpi">
            <Statistic title="跑分范围" value={selectedSummary?.range_label || '--'} />
            <Text type="secondary">
              {universeLabel(selectedTask?.universe)} · {taskStrategies.length || 0} 策略 · 候选{' '}
              {scannedStocks || '--'}
            </Text>
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card className="modern-card quant-backtest-kpi">
            <Statistic title="运行耗时" value={selectedSummary?.duration_label || '--'} />
            <Text type="secondary">
              创建 {formatTime(selectedTask?.created_at)} · 更新{' '}
              {formatTime(selectedTask?.updated_at)}
            </Text>
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card className="modern-card quant-backtest-kpi">
            <Statistic
              title="冠军收益"
              value={Number(best?.total_return_pct || 0)}
              suffix="%"
              precision={2}
            />
            <Text type="secondary">
              超额 {pct(best?.excess_return_pct)} · 回撤 {pct(best?.max_drawdown_pct)}
            </Text>
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card className="modern-card quant-backtest-kpi">
            <Statistic
              title="交易次数"
              value={best?.trade_count || 0}
              prefix={<ExperimentOutlined />}
            />
            <Text type="secondary">
              胜率 {pct(best?.win_rate, 1)} · 夏普 {Number(best?.sharpe_ratio || 0).toFixed(2)}
            </Text>
          </Card>
        </Col>
      </Row>

      {best && selectedValidation?.segments && (
        <Card className="modern-card quant-validation-card" variant="borderless">
          <div className="quant-run-detail-header">
            <div>
              <span>OUT-OF-SAMPLE</span>
              <strong>训练 / 验证 / 测试分区</strong>
            </div>
            <Tag color={validationColor(selectedValidation.verdict)}>
              {validationLabel(selectedValidation.verdict)}
            </Tag>
          </div>
          <Alert
            showIcon
            type={selectedValidation.verdict === 'passed' ? 'success' : 'warning'}
            message={selectedValidation.conclusion || '分区指标已生成'}
            description="训练集用于观察策略适配，验证集用于筛选参数，测试集用于最终验收；该拆分能降低过拟合和未来函数风险。"
            style={{ marginBottom: 12 }}
          />
          <Row gutter={[12, 12]}>
            {(['train', 'validation', 'test'] as const).map(key => {
              const item = selectedValidation.segments?.[key] || {};
              const labelMap = { train: '训练集', validation: '验证集', test: '测试集' };
              return (
                <Col xs={24} md={8} key={key}>
                  <div className="quant-validation-segment">
                    <span>{labelMap[key]}</span>
                    <strong>{pct(item.total_return_pct)}</strong>
                    <em>
                      超额 {pct(item.excess_return_pct)} · 回撤 {pct(item.max_drawdown_pct)} ·{' '}
                      {item.trade_count || 0} 笔
                    </em>
                    <Text type="secondary">
                      {item.start_date || '--'} ~ {item.end_date || '--'}
                    </Text>
                  </div>
                </Col>
              );
            })}
          </Row>
          <div className="quant-validation-footnote">
            泛化差距 {pct(selectedValidation.generalization_gap_pct)} ·{' '}
            {selectedValidation.split_plan?.note || '按时间顺序切分。'}
          </div>
        </Card>
      )}

      {!!gridSummary?.groups?.length && (
        <Card className="modern-card quant-grid-summary-card" variant="borderless">
          <div className="quant-run-detail-header">
            <div>
              <span>PARAMETER GRID</span>
              <strong>参数网格搜索摘要</strong>
            </div>
            <Button size="small" icon={<ReloadOutlined />} onClick={fetchGridSummary}>
              刷新
            </Button>
            <Button size="small" loading={upsertingGrid} onClick={upsertGridParamVersions}>
              沉淀参数版本
            </Button>
          </div>
          <Alert
            showIcon
            type={Number(gridSummary.param_versions?.upserted_count || 0) > 0 ? 'success' : 'info'}
            message={
              gridSummary.param_versions?.conclusion ||
              '网格冠军可沉淀为 grid_search 参数版本；沉淀后会在每日量化扫描中按“手工 > 冠军 > 网格/实验候选 > 默认”自动选用，并进入 A/B 收益验证。'
            }
            description={
              Number(gridSummary.param_versions?.upserted_count || 0) > 0
                ? `本次沉淀 ${gridSummary.param_versions?.upserted_count} 个版本，后续开盘扫描会自动读取可用冠军/候选参数。`
                : '建议只沉淀验证/测试集表现都不差的候选；测试集超额较弱的参数只做观察，不要直接放大仓位。'
            }
            style={{ marginBottom: 12 }}
          />
          {!!gridSummary.param_versions?.versions?.length && (
            <div className="quant-grid-version-strip">
              {gridSummary.param_versions.versions.slice(0, 6).map(version => (
                <Tag
                  key={version.version_key}
                  color={version.status === 'active_candidate' ? 'blue' : 'gold'}
                >
                  {version.strategy_key} · {version.status} · 分{' '}
                  {Number(version.source_rank_score || 0).toFixed(1)}
                </Tag>
              ))}
            </div>
          )}
          <Space direction="vertical" style={{ width: '100%' }}>
            {gridSummary.groups.slice(0, 3).map(group => (
              <div className="quant-grid-group" key={group.group_id}>
                <div>
                  <Text strong>{group.parent_task_name}</Text>
                  <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
                    {group.completed_tasks}/{group.total_tasks} 完成 · 运行中 {group.running_tasks}{' '}
                    · 失败 {group.failed_tasks}
                  </Text>
                </div>
                <div className="quant-grid-group-verdict">
                  <Tag color={group.best?.validation_verdict === 'passed' ? 'green' : 'gold'}>
                    {validationLabel(group.best?.validation_verdict)}
                  </Tag>
                  <Text>{group.conclusion}</Text>
                </div>
                <div className="quant-grid-candidates">
                  {(group.candidates || []).slice(0, 4).map(candidate => (
                    <button
                      type="button"
                      key={`${group.group_id}-${candidate.task_id}`}
                      onClick={() => fetchDetail(candidate.task_id)}
                    >
                      <span>
                        {candidate.strategy_key} #{candidate.grid_index}
                      </span>
                      <strong>{pct(candidate.total_return_pct)}</strong>
                      <em>测试超额 {pct(candidate.test_excess_return_pct)}</em>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </Space>
        </Card>
      )}

      {selectedTask && (
        <Alert
          className="quant-backtest-conclusion"
          type={
            selectedTask.status === 'FAILED'
              ? 'error'
              : selectedTask.status === 'COMPLETED'
              ? 'success'
              : 'info'
          }
          showIcon
          message={selectedSummary?.conclusion || '请选择一个跑分任务查看详情'}
          description={
            selectedTask.status === 'FAILED' && selectedQueueLockFailure
              ? '原因判断：该错误属于队列锁/长任务保活问题，不是策略逻辑收益计算失败；本次已将锁周期加长到默认 90 分钟、锁检查降低频率，并把默认跑分并发降为 1，适合长区间重试。'
              : undefined
          }
          action={
            selectedTask.status === 'FAILED' ? (
              <Button
                size="small"
                danger
                icon={<RedoOutlined />}
                loading={retryingId === selectedTask.id}
                onClick={() => retryBacktest(selectedTask)}
              >
                重试/续跑
              </Button>
            ) : null
          }
        />
      )}

      {selectedTask && (
        <Card className="modern-card quant-run-detail-card" variant="borderless">
          <div className="quant-run-detail-header">
            <div>
              <span>RUN CONTEXT</span>
              <strong>本次跑分信息</strong>
            </div>
            <Tag color={statusColor(selectedTask.status)}>{statusLabel(selectedTask.status)}</Tag>
          </div>
          <div className="quant-run-detail-grid">
            <div>
              <span>跑分范围</span>
              <strong>{selectedSummary?.range_label || '--'}</strong>
            </div>
            <div>
              <span>开始时间</span>
              <strong>{formatDateTime(selectedSummary?.run_started_at)}</strong>
            </div>
            <div>
              <span>结束时间</span>
              <strong>
                {formatDateTime(
                  selectedSummary?.run_finished_at ||
                    selectedSummary?.run_completed_at ||
                    selectedSummary?.run_failed_at
                )}
              </strong>
            </div>
            <div>
              <span>运行耗时</span>
              <strong>{selectedSummary?.duration_label || '--'}</strong>
            </div>
            <div>
              <span>队列等待</span>
              <strong>{selectedSummary?.queue_wait_label || '--'}</strong>
            </div>
            <div>
              <span>运行阶段</span>
              <strong>{stageLabel(selectedSummary?.last_stage)}</strong>
            </div>
            <div>
              <span>扫描股票</span>
              <strong>{selectedSummary?.scanned_stocks || scannedStocks || '--'}</strong>
            </div>
            <div>
              <span>基准收益</span>
              <strong>{pct(selectedSummary?.benchmark_return_pct)}</strong>
            </div>
            <div>
              <span>策略结果</span>
              <strong>{selectedSummary?.result_count ?? detail?.results?.length ?? 0}</strong>
            </div>
            <div>
              <span>重试次数</span>
              <strong>{selectedSummary?.retry_count || 0}</strong>
            </div>
          </div>
        </Card>
      )}

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={24} xl={8}>
          <Card
            className="modern-card quant-task-list-card"
            title="历史跑分任务"
            extra={<Button icon={<ReloadOutlined />} onClick={fetchTasks} />}
            loading={loading}
          >
            <Space direction="vertical" style={{ width: '100%' }}>
              {tasks.slice(0, 12).map(task => {
                const summary = task.run_summary || {};
                return (
                  <div
                    className={`quant-task-row ${detail?.task?.id === task.id ? 'active' : ''}`}
                    key={task.id}
                    onClick={() => fetchDetail(task.id)}
                  >
                    <div className="quant-task-row-main">
                      <strong>{task.task_name}</strong>
                      <span>
                        {summary.range_label ||
                          `${compactDate(task.start_date)} ~ ${compactDate(task.end_date)}`}
                      </span>
                      {task.error_message && <em>{task.error_message}</em>}
                    </div>
                    <div className="quant-task-row-side">
                      <Tag color={statusColor(task.status)}>{statusLabel(task.status)}</Tag>
                      <Text strong>
                        {summary.best_return_pct !== undefined
                          ? pct(summary.best_return_pct)
                          : '--'}
                      </Text>
                      <Text type="secondary">{summary.duration_label || '--'}</Text>
                      {task.status === 'FAILED' && (
                        <AntTooltip title="按原参数重新入队">
                          <Button
                            size="small"
                            danger
                            icon={<RedoOutlined />}
                            loading={retryingId === task.id}
                            onClick={event => {
                              event.stopPropagation();
                              retryBacktest(task);
                            }}
                          />
                        </AntTooltip>
                      )}
                    </div>
                    {['QUEUED', 'RUNNING'].includes(task.status) && (
                      <Progress
                        percent={Number(task.progress || 0)}
                        size="small"
                        showInfo={false}
                      />
                    )}
                  </div>
                );
              })}
              {!tasks.length && <Empty description="暂无跑分任务" />}
            </Space>
          </Card>
        </Col>
        <Col xs={24} xl={16}>
          <Card
            className="modern-card quant-equity-card"
            title="冠军策略资金曲线"
            loading={loading}
          >
            <div className="quant-equity-meta">
              <Tag color={statusColor(selectedTask?.status)}>
                {statusLabel(selectedTask?.status)}
              </Tag>
              <Tag>{selectedSummary?.range_label || '未选择区间'}</Tag>
              <Tag>{best?.strategy_name || '等待冠军策略'}</Tag>
              <Tag>
                初始资金 {money(selectedSummary?.initial_capital || selectedTask?.initial_capital)}
              </Tag>
            </div>
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

      <Card className="modern-card" title="策略跑分对比">
        <Table
          columns={resultColumns}
          dataSource={detail?.results || []}
          rowKey="strategy_key"
          scroll={{ x: 980 }}
          pagination={false}
          locale={{ emptyText: <Empty description="暂无跑分结果" /> }}
        />
      </Card>
    </div>
  );
};

export default QuantBacktestLab;
