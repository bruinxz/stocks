import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Progress,
  Row,
  Select,
  Space,
  Spin,
  Statistic,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  CopyOutlined,
  EditOutlined,
  ExperimentOutlined,
  PlayCircleOutlined,
  PlusSquareOutlined,
  ReloadOutlined,
  SwapOutlined,
} from '@ant-design/icons';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import dayjs, { Dayjs } from 'dayjs';
import WorkspaceLayout, { WorkspaceTab } from '../../components/layout/WorkspaceLayout';
import {
  labService,
  QuantStrategyItem,
  BacktestTask,
  BacktestCompareResponse,
  BacktestCompareItem,
  CreateBacktestPayload,
} from '../../services/labService';
import StrategyCopilotPanel from '../../components/trading/StrategyCopilotPanel';

const { Text, Paragraph } = Typography;
const { RangePicker } = DatePicker;

/**
 * 策略实验室 (Lab Workspace) — US-016 完整实现。
 *
 * 3 个 tab：
 *  - 我的策略：列表展示后端注册的所有策略（含 MultiFactorAlpha/DragonHeadMomentum/EarningsSurprise 三个内置），
 *              支持"克隆"（基于策略 default_params 预填新建回测表单）与"编辑参数"（查看 default_params）。
 *  - 新建回测：表单选择策略 + 起止日期 + 初始资金 + 基准。提交后轮询 /quant/backtests/:id 拉取进度。
 *  - 回测对比：勾选 2-4 个已完成回测，POST /quant/backtests/compare 拉取对比数据，叠加 Recharts 净值曲线 + KPI 表。
 *
 * 数据流：
 *  - 装载时并发：listQuantStrategies + listBacktestTasks（painting "我的策略" + "回测对比" 两个 tab 的初始数据）
 *  - 用户点 "提交回测" → POST /quant/backtests + 启动 3000ms 轮询直到 COMPLETED/FAILED
 *  - 用户点 "开始对比" → POST /quant/backtests/compare（独立请求，不污染主状态）
 */

const DEFAULT_INITIAL_CAPITAL = 200000;
const DEFAULT_BENCHMARK = 'sh.000300'; // 沪深 300
const POLL_INTERVAL_MS = 3000;

const LabWorkspace: React.FC = () => {
  const tabs: WorkspaceTab[] = [
    { key: 'mine', label: '我的策略', icon: <ExperimentOutlined /> },
    { key: 'new', label: '新建回测', icon: <PlusSquareOutlined /> },
    { key: 'compare', label: '回测对比', icon: <SwapOutlined /> },
  ];
  const [activeKey, setActiveKey] = useState('mine');

  // ---- 主数据：策略列表 + 回测任务列表 ----
  const [strategies, setStrategies] = useState<QuantStrategyItem[]>([]);
  const [tasks, setTasks] = useState<BacktestTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [strategyList, taskList] = await Promise.all([
        labService.listQuantStrategies(),
        labService.listBacktestTasks(50),
      ]);
      setStrategies(strategyList);
      setTasks(taskList);
    } catch (err: unknown) {
      const messageStr = err instanceof Error ? err.message : String(err);
      setLoadError(messageStr);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // ---- 表单（"新建回测" tab 用）；克隆策略时被 setSeedPayload 填充 ----
  const [form] = Form.useForm();
  const [seedStrategyKey, setSeedStrategyKey] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pollingTaskId, setPollingTaskId] = useState<number | null>(null);

  // ---- 编辑参数 drawer ----
  const [editingStrategy, setEditingStrategy] = useState<QuantStrategyItem | null>(null);

  // ---- 选中的对比 task_ids ----
  const [selectedCompareIds, setSelectedCompareIds] = useState<number[]>([]);
  const [compareLoading, setCompareLoading] = useState(false);
  const [compareResult, setCompareResult] = useState<BacktestCompareResponse | null>(null);

  // ---- 轮询任务进度直至 COMPLETED/FAILED ----
  useEffect(() => {
    if (!pollingTaskId) return undefined;
    const timer = window.setInterval(async () => {
      try {
        const detail = await labService.getBacktestDetail(pollingTaskId);
        const status = detail?.task?.status;
        // 顺便刷新整个任务列表，让用户能看到最新进度
        const list = await labService.listBacktestTasks(50);
        setTasks(list);
        if (status === 'COMPLETED' || status === 'FAILED') {
          setPollingTaskId(null);
          message[status === 'COMPLETED' ? 'success' : 'error'](
            status === 'COMPLETED' ? '回测完成 ✓' : `回测失败：${detail?.task?.error_message || ''}`
          );
        }
      } catch {
        // 网络失败时静默重试，让用户能看到下一次轮询的结果
      }
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [pollingTaskId]);

  const handleClone = useCallback(
    (strategy: QuantStrategyItem) => {
      // 克隆 = 跳到"新建回测" tab + 预填 strategy_keys + 把 default_params 透传给 params_by_strategy
      const defaults = strategy.default_params || {};
      const today = dayjs();
      const startDate = today.subtract(2, 'year');
      form.setFieldsValue({
        task_name: `克隆-${strategy.name || strategy.strategy_key}-${today.format('YYYYMMDD')}`,
        strategy_keys: [strategy.strategy_key],
        range: [startDate, today],
        initial_capital: DEFAULT_INITIAL_CAPITAL,
        benchmark_symbol: DEFAULT_BENCHMARK,
        universe: 'favorites',
        params_text: Object.keys(defaults).length ? JSON.stringify(defaults, null, 2) : '',
      });
      setSeedStrategyKey(strategy.strategy_key);
      setActiveKey('new');
      message.info(`已加载策略 "${strategy.name || strategy.strategy_key}" 的默认参数到新建回测表单`);
    },
    [form]
  );

  const handleSubmitBacktest = useCallback(async () => {
    try {
      const values = await form.validateFields();
      const [start, end]: [Dayjs, Dayjs] = values.range || [];
      if (!start || !end) {
        message.error('请选择回测时间段');
        return;
      }
      let paramsByStrategy: Record<string, Record<string, any>> = {};
      if (values.params_text && String(values.params_text).trim()) {
        try {
          const parsed = JSON.parse(values.params_text);
          if (parsed && typeof parsed === 'object') {
            // 自动应用到每个选中策略；如果是 {strategy_key: {...}} 形式则直接用
            const isPerStrategy =
              Object.values(parsed).every(v => v && typeof v === 'object' && !Array.isArray(v)) &&
              Object.keys(parsed).every(k => (values.strategy_keys || []).includes(k));
            if (isPerStrategy) {
              paramsByStrategy = parsed;
            } else {
              for (const key of values.strategy_keys || []) {
                paramsByStrategy[key] = parsed;
              }
            }
          }
        } catch (e) {
          message.error('参数 JSON 解析失败，请检查格式');
          return;
        }
      }
      const payload: CreateBacktestPayload = {
        task_name: values.task_name || `回测-${dayjs().format('MMDD-HHmm')}`,
        universe: values.universe,
        strategy_keys: values.strategy_keys,
        start_date: start.format('YYYY-MM-DD'),
        end_date: end.format('YYYY-MM-DD'),
        initial_capital: Number(values.initial_capital) || DEFAULT_INITIAL_CAPITAL,
        benchmark_symbol: values.benchmark_symbol || DEFAULT_BENCHMARK,
        max_positions: Number(values.max_positions) || undefined,
        candidate_limit: Number(values.candidate_limit) || undefined,
        execution_timing: values.execution_timing,
        enable_t_plus_one: values.enable_t_plus_one !== false,
        params_by_strategy: Object.keys(paramsByStrategy).length ? paramsByStrategy : undefined,
      };
      setSubmitting(true);
      const result = await labService.createBacktestTask(payload);
      const createdTaskId =
        result?.task?.task?.id || result?.task?.id || (result as any)?.id || null;
      if (createdTaskId) {
        message.success(`回测任务已创建（task_id=${createdTaskId}），正在轮询执行进度…`);
        setPollingTaskId(Number(createdTaskId));
        await refresh();
        setActiveKey('mine');
      } else {
        message.warning('任务已创建但未取到 task_id，请手动刷新');
        await refresh();
      }
    } catch (err: unknown) {
      const messageStr = err instanceof Error ? err.message : String(err);
      // form.validateFields 自身的错误也会进这里，但 antd 会同时把校验错误显示在 field 旁
      if (messageStr && !messageStr.includes('Cannot')) {
        message.error(`创建回测失败：${messageStr}`);
      }
    } finally {
      setSubmitting(false);
    }
  }, [form, refresh]);

  const handleCompare = useCallback(async () => {
    if (selectedCompareIds.length < 2) {
      message.error('请选择至少 2 个已完成回测');
      return;
    }
    if (selectedCompareIds.length > 4) {
      message.error('最多支持同时对比 4 个回测');
      return;
    }
    setCompareLoading(true);
    try {
      const data = await labService.compareBacktests(selectedCompareIds);
      setCompareResult(data);
      if (data.missing_task_ids.length) {
        message.warning(`部分任务未找到：${data.missing_task_ids.join(', ')}`);
      } else {
        message.success(`已加载 ${data.task_count} 个回测的对比数据`);
      }
    } catch (err: unknown) {
      const messageStr = err instanceof Error ? err.message : String(err);
      message.error(`对比失败：${messageStr}`);
    } finally {
      setCompareLoading(false);
    }
  }, [selectedCompareIds]);

  // ---- KPI 计算 ----
  const completedTasks = useMemo(
    () => tasks.filter(t => String(t.status).toUpperCase() === 'COMPLETED'),
    [tasks]
  );
  const runningTasks = useMemo(
    () =>
      tasks.filter(t => ['RUNNING', 'QUEUED'].includes(String(t.status || '').toUpperCase())),
    [tasks]
  );
  const last7DaysCount = useMemo(() => {
    const cutoff = dayjs().subtract(7, 'day').valueOf();
    return completedTasks.filter(t => dayjs(t.created_at).valueOf() >= cutoff).length;
  }, [completedTasks]);

  const kpiSlot = (
    <Space size={32}>
      <Statistic title="已注册策略" value={strategies.length} suffix="个" />
      <Statistic title="进行中回测" value={runningTasks.length} suffix="项" />
      <Statistic title="最近 7 日完成" value={last7DaysCount} suffix="次" />
    </Space>
  );

  const headerActions = (
    <Button icon={<ReloadOutlined />} onClick={refresh} loading={loading}>
      刷新
    </Button>
  );

  // ---- render tab body ----
  let body: React.ReactNode;
  if (loadError) {
    body = (
      <Alert
        type="error"
        showIcon
        message="加载失败"
        description={loadError}
        action={
          <Button size="small" onClick={refresh}>
            重试
          </Button>
        }
      />
    );
  } else if (activeKey === 'mine') {
    body = (
      <MyStrategiesTab
        strategies={strategies}
        loading={loading}
        onClone={handleClone}
        onEdit={setEditingStrategy}
      />
    );
  } else if (activeKey === 'new') {
    body = (
      <NewBacktestTab
        form={form}
        strategies={strategies}
        submitting={submitting}
        seedStrategyKey={seedStrategyKey}
        onSubmit={handleSubmitBacktest}
        pollingTaskId={pollingTaskId}
        tasks={tasks}
      />
    );
  } else {
    body = (
      <CompareTab
        completedTasks={completedTasks}
        selectedIds={selectedCompareIds}
        onSelectionChange={setSelectedCompareIds}
        compareLoading={compareLoading}
        compareResult={compareResult}
        onCompare={handleCompare}
      />
    );
  }

  return (
    <WorkspaceLayout
      title="策略实验室"
      subtitle="新建策略、跑分回测、版本对比 — 策略迭代的统一工作台。"
      tabs={tabs}
      activeKey={activeKey}
      onTabChange={setActiveKey}
      kpiSlot={kpiSlot}
      headerActions={headerActions}
    >
      {body}
      <Drawer
        title={editingStrategy ? `编辑参数 · ${editingStrategy.name}` : ''}
        width={520}
        open={Boolean(editingStrategy)}
        onClose={() => setEditingStrategy(null)}
        destroyOnClose
      >
        {editingStrategy && (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Alert
              type="info"
              showIcon
              message="只读视图"
              description="这里展示策略的默认参数。要修改并跑回测，请点 “克隆” 把参数复制到“新建回测” tab 编辑后提交。"
            />
            <div>
              <Text type="secondary">策略 key</Text>
              <Paragraph copyable>{editingStrategy.strategy_key}</Paragraph>
            </div>
            <div>
              <Text type="secondary">描述</Text>
              <Paragraph>{editingStrategy.description || '—'}</Paragraph>
            </div>
            <div>
              <Text type="secondary">默认参数（default_params）</Text>
              <pre
                style={{
                  background: '#fafafa',
                  border: '1px solid #f0f0f0',
                  borderRadius: 4,
                  padding: 12,
                  maxHeight: 360,
                  overflow: 'auto',
                }}
              >
                {JSON.stringify(editingStrategy.default_params || {}, null, 2)}
              </pre>
            </div>
            <Button
              type="primary"
              icon={<CopyOutlined />}
              onClick={() => {
                handleClone(editingStrategy);
                setEditingStrategy(null);
              }}
            >
              克隆并跳到新建回测
            </Button>
          </Space>
        )}
      </Drawer>
      <StrategyCopilotPanel
        currentStrategyKey={seedStrategyKey}
        onApplySuggestedParams={(params, strategyKey) => {
          // Copilot 建议参数 → 把建议合并进新建回测表单的 params_text JSON
          const targetKey = strategyKey || seedStrategyKey;
          if (!targetKey) {
            message.warning('请先在"我的策略"克隆一条策略，Copilot 才能把建议参数写入新建回测表单');
            return;
          }
          const existingRaw = (form.getFieldValue('params_text') as string) || '';
          let merged: Record<string, any> = { ...params };
          if (existingRaw.trim()) {
            try {
              const existing = JSON.parse(existingRaw);
              if (existing && typeof existing === 'object') {
                merged = { ...existing, ...params };
              }
            } catch {
              /* ignore invalid existing JSON; replace with suggested */
            }
          }
          form.setFieldsValue({
            strategy_keys: [targetKey],
            params_text: JSON.stringify(merged, null, 2),
          });
          setSeedStrategyKey(targetKey);
          setActiveKey('new');
        }}
      />
    </WorkspaceLayout>
  );
};

// ============================================================================
// Tab 1 — 我的策略
// ============================================================================

const STRATEGY_CATEGORY_DISPLAY: Record<string, { label: string; color: string }> = {
  multi_factor: { label: '多因子', color: 'blue' },
  momentum: { label: '动量', color: 'orange' },
  event_driven: { label: '事件驱动', color: 'volcano' },
  trend: { label: '趋势', color: 'cyan' },
  reversal: { label: '反转', color: 'purple' },
  value: { label: '价值', color: 'green' },
  quality: { label: '质量', color: 'gold' },
  pattern: { label: '形态', color: 'magenta' },
  other: { label: '其他', color: 'default' },
};

const STRATEGY_RISK_DISPLAY: Record<string, { label: string; color: string }> = {
  low: { label: '低风险', color: 'green' },
  medium: { label: '中风险', color: 'gold' },
  high: { label: '高风险', color: 'red' },
};

const MyStrategiesTab: React.FC<{
  strategies: QuantStrategyItem[];
  loading: boolean;
  onClone: (s: QuantStrategyItem) => void;
  onEdit: (s: QuantStrategyItem) => void;
}> = ({ strategies, loading, onClone, onEdit }) => {
  if (loading && strategies.length === 0) {
    return (
      <Card>
        <div style={{ display: 'flex', justifyContent: 'center', padding: 64 }}>
          <Spin tip="加载策略列表…" />
        </div>
      </Card>
    );
  }
  if (strategies.length === 0) {
    return (
      <Card>
        <Empty description="尚未注册任何策略" />
      </Card>
    );
  }
  return (
    <Row gutter={[16, 16]}>
      {strategies.map(strategy => {
        const category =
          STRATEGY_CATEGORY_DISPLAY[strategy.category || 'other'] ?? STRATEGY_CATEGORY_DISPLAY.other;
        const risk = STRATEGY_RISK_DISPLAY[strategy.risk_level || 'medium'];
        return (
          <Col xs={24} sm={12} lg={8} xxl={6} key={strategy.strategy_key}>
            <Card
              hoverable
              style={{ height: '100%' }}
              title={
                <Space size={6}>
                  <Text strong>{strategy.name || strategy.display_name || strategy.strategy_key}</Text>
                  {strategy.enabled === false && <Tag>停用</Tag>}
                </Space>
              }
              extra={
                <Space size={4}>
                  <Tag color={category.color}>{category.label}</Tag>
                  {risk && <Tag color={risk.color}>{risk.label}</Tag>}
                </Space>
              }
              actions={[
                <Tooltip key="clone-tooltip" title="基于此策略的默认参数预填新建回测表单">
                  <a key="clone" onClick={() => onClone(strategy)}>
                    <CopyOutlined /> 克隆
                  </a>
                </Tooltip>,
                <a key="edit" onClick={() => onEdit(strategy)}>
                  <EditOutlined /> 查看/编辑参数
                </a>,
              ]}
            >
              <Text type="secondary" style={{ fontSize: 12, display: 'block', minHeight: 48 }}>
                {strategy.description || '—'}
              </Text>
              <div style={{ marginTop: 8 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  策略 key：
                </Text>
                <Text code>{strategy.strategy_key}</Text>
              </div>
              {Array.isArray(strategy.tags) && strategy.tags.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  {strategy.tags.slice(0, 4).map(tag => (
                    <Tag key={tag} style={{ marginBottom: 4 }}>
                      {tag}
                    </Tag>
                  ))}
                </div>
              )}
            </Card>
          </Col>
        );
      })}
    </Row>
  );
};

// ============================================================================
// Tab 2 — 新建回测
// ============================================================================

const NewBacktestTab: React.FC<{
  form: any;
  strategies: QuantStrategyItem[];
  submitting: boolean;
  seedStrategyKey: string | null;
  onSubmit: () => void;
  pollingTaskId: number | null;
  tasks: BacktestTask[];
}> = ({ form, strategies, submitting, seedStrategyKey, onSubmit, pollingTaskId, tasks }) => {
  const pollingTask = useMemo(
    () => tasks.find(t => t.id === pollingTaskId),
    [tasks, pollingTaskId]
  );

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {seedStrategyKey && (
        <Alert
          type="info"
          showIcon
          message={`已加载策略 "${seedStrategyKey}" 的默认参数 — 可在表单中修改后提交`}
          closable
        />
      )}

      {pollingTaskId && (
        <Card title="任务执行进度" extra={<Tag color="blue">轮询中</Tag>}>
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Text strong>
              {pollingTask?.task_name || `任务 ${pollingTaskId}`} ·{' '}
              <Tag color={statusColor(pollingTask?.status)}>{statusLabel(pollingTask?.status)}</Tag>
            </Text>
            <Progress
              percent={Number(pollingTask?.progress || 0)}
              status={
                pollingTask?.status === 'FAILED'
                  ? 'exception'
                  : pollingTask?.status === 'COMPLETED'
                  ? 'success'
                  : 'active'
              }
            />
            {pollingTask?.error_message && (
              <Alert type="error" showIcon message={pollingTask.error_message} />
            )}
            <Text type="secondary" style={{ fontSize: 12 }}>
              页面会每 3 秒自动刷新此任务状态，无需手动操作。
            </Text>
          </Space>
        </Card>
      )}

      <Card title="新建回测">
        <Form
          form={form}
          layout="vertical"
          initialValues={{
            universe: 'favorites',
            initial_capital: DEFAULT_INITIAL_CAPITAL,
            benchmark_symbol: DEFAULT_BENCHMARK,
            execution_timing: 'next_open',
            enable_t_plus_one: true,
            range: [dayjs().subtract(2, 'year'), dayjs()],
            max_positions: 10,
            candidate_limit: 30,
          }}
        >
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item
                label="任务名称"
                name="task_name"
                rules={[{ required: true, message: '请输入任务名称' }]}
              >
                <Input placeholder="例如：MultiFactorAlpha 月度调仓 2024" />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item label="股票池" name="universe">
                <Select
                  options={[
                    { value: 'favorites', label: '自选股' },
                    { value: 'all', label: '全市场' },
                  ]}
                />
              </Form.Item>
            </Col>
            <Col xs={24}>
              <Form.Item
                label="策略"
                name="strategy_keys"
                rules={[{ required: true, message: '请选择至少 1 个策略' }]}
              >
                <Select
                  mode="multiple"
                  placeholder="选择 1 个或多个策略（多个会并行跑分，便于横向对比）"
                  showSearch
                  filterOption={(input, option) =>
                    String(option?.label || '').toLowerCase().includes(input.toLowerCase())
                  }
                  options={strategies.map(s => ({
                    value: s.strategy_key,
                    label: `${s.name || s.strategy_key} (${s.strategy_key})`,
                    disabled: s.enabled === false,
                  }))}
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item
                label="回测时间段"
                name="range"
                rules={[{ required: true, message: '请选择起止日期' }]}
              >
                <RangePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={6}>
              <Form.Item label="初始资金" name="initial_capital">
                <InputNumber<number>
                  min={10000}
                  max={100000000}
                  step={10000}
                  formatter={value => `¥ ${value}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}
                  parser={value => Number(String(value || '').replace(/[^\d]/g, '')) || 0}
                  style={{ width: '100%' }}
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={6}>
              <Form.Item label="基准指数" name="benchmark_symbol">
                <Select
                  options={[
                    { value: 'sh.000300', label: '沪深 300' },
                    { value: 'sh.000905', label: '中证 500' },
                    { value: 'sh.000852', label: '中证 1000' },
                    { value: 'sh.000016', label: '上证 50' },
                  ]}
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={6}>
              <Form.Item label="最大持仓数" name="max_positions">
                <InputNumber min={1} max={200} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={6}>
              <Form.Item label="候选池上限" name="candidate_limit">
                <InputNumber min={5} max={500} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item label="撮合时机" name="execution_timing">
                <Select
                  options={[
                    { value: 'next_open', label: '次日开盘（默认）' },
                    { value: 'same_close', label: '当日收盘' },
                    { value: 'twap_proxy', label: 'TWAP 代理（OHLC/4）' },
                  ]}
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={6}>
              <Form.Item label="T+1 限制" name="enable_t_plus_one" valuePropName="checked">
                <Switch checkedChildren="开" unCheckedChildren="关" />
              </Form.Item>
            </Col>
            <Col xs={24}>
              <Form.Item
                label="参数覆盖（JSON，可选）"
                name="params_text"
                extra="留空使用策略默认参数；填 { key: value } 形式会应用到所有选中策略；填 { strategy_key: { ... } } 形式会按策略分别覆盖。"
              >
                <Input.TextArea
                  rows={6}
                  placeholder={`{\n  "topN": 30,\n  "rebalancePeriod": "monthly"\n}`}
                  style={{ fontFamily: 'monospace' }}
                />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item>
            <Space>
              <Button
                type="primary"
                icon={<PlayCircleOutlined />}
                onClick={onSubmit}
                loading={submitting}
                disabled={Boolean(pollingTaskId)}
              >
                {pollingTaskId ? '等待当前任务完成…' : '提交回测'}
              </Button>
              <Button onClick={() => form.resetFields()}>重置表单</Button>
            </Space>
          </Form.Item>
        </Form>
      </Card>
    </Space>
  );
};

// ============================================================================
// Tab 3 — 回测对比
// ============================================================================

const CompareTab: React.FC<{
  completedTasks: BacktestTask[];
  selectedIds: number[];
  onSelectionChange: (ids: number[]) => void;
  compareLoading: boolean;
  compareResult: BacktestCompareResponse | null;
  onCompare: () => void;
}> = ({ completedTasks, selectedIds, onSelectionChange, compareLoading, compareResult, onCompare }) => {
  const selectionColumns = [
    {
      title: '任务',
      dataIndex: 'task_name',
      key: 'task_name',
      render: (text: string, row: BacktestTask) => (
        <Space direction="vertical" size={0}>
          <Text strong>{text}</Text>
          <Text type="secondary" style={{ fontSize: 11 }}>
            #{row.id} · 创建 {dayjs(row.created_at).format('MM-DD HH:mm')}
          </Text>
        </Space>
      ),
    },
    {
      title: '时间段',
      key: 'range',
      width: 200,
      render: (_: any, row: BacktestTask) => (
        <Text style={{ fontSize: 12 }}>
          {compactDate(row.start_date)} ~ {compactDate(row.end_date)}
        </Text>
      ),
    },
    {
      title: '策略',
      dataIndex: 'strategy_keys',
      key: 'strategy_keys',
      width: 220,
      render: (keys: string[]) => (
        <Space size={4} wrap>
          {(keys || []).slice(0, 3).map(k => (
            <Tag key={k} style={{ fontSize: 11 }}>
              {k}
            </Tag>
          ))}
          {(keys || []).length > 3 && <Text type="secondary">+{(keys || []).length - 3}</Text>}
        </Space>
      ),
    },
    {
      title: '冠军收益',
      key: 'best',
      width: 140,
      render: (_: any, row: BacktestTask) => {
        const ret = row.run_summary?.best_return_pct;
        return Number.isFinite(Number(ret)) ? (
          <Text strong style={{ color: Number(ret) >= 0 ? '#cf1322' : '#0f8f6b' }}>
            {Number(ret).toFixed(2)}%
          </Text>
        ) : (
          <Text type="secondary">—</Text>
        );
      },
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title={
          <Space>
            <SwapOutlined />
            选择 2-4 个已完成的回测进行对比
          </Space>
        }
        extra={
          <Space>
            <Tag color="blue">已选 {selectedIds.length} / 4</Tag>
            <Button
              type="primary"
              icon={<PlayCircleOutlined />}
              onClick={onCompare}
              loading={compareLoading}
              disabled={selectedIds.length < 2}
            >
              开始对比
            </Button>
          </Space>
        }
      >
        {completedTasks.length === 0 ? (
          <Empty description="还没有已完成的回测任务 — 请先在 “新建回测” tab 提交一个" />
        ) : (
          <Table<BacktestTask>
            size="small"
            rowKey="id"
            columns={selectionColumns}
            dataSource={completedTasks}
            pagination={{ pageSize: 8 }}
            rowSelection={{
              type: 'checkbox',
              selectedRowKeys: selectedIds,
              onChange: keys => onSelectionChange(keys.map(k => Number(k))),
              getCheckboxProps: row => ({
                disabled: !selectedIds.includes(row.id) && selectedIds.length >= 4,
              }),
            }}
          />
        )}
      </Card>

      {compareResult && compareResult.items.length > 0 && (
        <>
          <CompareChartCard items={compareResult.items} />
          <CompareTableCard result={compareResult} />
        </>
      )}
    </Space>
  );
};

const COMPARE_COLORS = ['#1677ff', '#52c41a', '#fa8c16', '#eb2f96'];

const CompareChartCard: React.FC<{ items: BacktestCompareItem[] }> = ({ items }) => {
  // 将每个任务的 best_equity_curve 转成 [{ date, [task_id_X]: returnPct, ...}] 的形式
  // 净值用 cumulative_return_pct（若 equity_curve 有就用；否则用 total_value/initial * 100 - 100 算）
  const data = useMemo(() => {
    const dateMap = new Map<string, Record<string, any>>();
    items.forEach(item => {
      const initial = item.initial_capital || 1;
      (item.best_equity_curve || []).forEach((point: any) => {
        const date = point?.date;
        if (!date) return;
        if (!dateMap.has(date)) dateMap.set(date, { date });
        const row = dateMap.get(date)!;
        const total = Number(point?.total_value || 0);
        const cum =
          Number.isFinite(Number(point?.cumulative_return_pct))
            ? Number(point.cumulative_return_pct)
            : total > 0 && initial > 0
            ? (total / initial - 1) * 100
            : 0;
        row[`task_${item.task_id}`] = Number(cum.toFixed(2));
      });
    });
    return Array.from(dateMap.values()).sort((a, b) =>
      String(a.date).localeCompare(String(b.date))
    );
  }, [items]);

  if (data.length === 0) {
    return (
      <Card title="净值曲线对比">
        <Empty description="所选回测都没有曲线数据" />
      </Card>
    );
  }
  return (
    <Card title="净值曲线对比（累计收益 %，以冠军策略为准）">
      <div style={{ width: '100%', height: 380 }}>
        <ResponsiveContainer>
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
            <XAxis dataKey="date" tick={{ fontSize: 11 }} minTickGap={30} />
            <YAxis tickFormatter={v => `${v}%`} tick={{ fontSize: 11 }} />
            <RechartsTooltip
              formatter={(value: any) => [`${Number(value).toFixed(2)}%`, '累计收益']}
            />
            <Legend />
            {items.map((item, idx) => (
              <Line
                key={item.task_id}
                type="monotone"
                dataKey={`task_${item.task_id}`}
                name={`${item.task_name}${
                  item.best_strategy_name ? ' · ' + item.best_strategy_name : ''
                }`}
                stroke={COMPARE_COLORS[idx % COMPARE_COLORS.length]}
                dot={false}
                strokeWidth={2}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
};

const CompareTableCard: React.FC<{ result: BacktestCompareResponse }> = ({ result }) => {
  // 行 = 策略，列 = 每个 task 的指标。
  // 也展示一个"任务总览"表（行 = 任务，列 = 冠军策略 KPI）方便快速概览。
  const taskSummaryRows = result.items.map(item => ({
    key: item.task_id,
    task_id: item.task_id,
    task_name: item.task_name,
    range_label: `${item.start_date} ~ ${item.end_date}`,
    best_strategy_name: item.best_strategy_name || '—',
    initial_capital: item.initial_capital,
    summary: item.run_summary,
  }));

  const taskColumns = [
    { title: '任务', dataIndex: 'task_name', key: 'task_name' },
    {
      title: '时间段',
      dataIndex: 'range_label',
      key: 'range_label',
      width: 200,
    },
    { title: '冠军策略', dataIndex: 'best_strategy_name', key: 'best_strategy_name', width: 200 },
    {
      title: '初始资金',
      dataIndex: 'initial_capital',
      key: 'initial_capital',
      width: 130,
      render: (v: number) => (Number.isFinite(v) ? `¥${v.toLocaleString()}` : '—'),
    },
    {
      title: '总收益',
      key: 'total_return_pct',
      width: 100,
      render: (_: any, row: any) => percentTag(row.summary?.best_return_pct),
    },
    {
      title: '超额',
      key: 'excess',
      width: 100,
      render: (_: any, row: any) => percentTag(row.summary?.best_excess_return_pct),
    },
    {
      title: '最大回撤',
      key: 'max_drawdown',
      width: 110,
      render: (_: any, row: any) => percentTag(row.summary?.best_max_drawdown_pct),
    },
    {
      title: '夏普',
      key: 'sharpe',
      width: 90,
      render: (_: any, row: any) => (
        <Text>{Number(row.summary?.best_sharpe_ratio || 0).toFixed(2)}</Text>
      ),
    },
    {
      title: '交易笔数',
      key: 'trades',
      width: 100,
      render: (_: any, row: any) => <Text>{row.summary?.best_trade_count || 0}</Text>,
    },
  ];

  // 每个策略 × 每个任务的 cell 表
  const strategyComparisonColumns: any[] = [
    {
      title: '策略 key',
      dataIndex: 'strategy_key',
      key: 'strategy_key',
      fixed: 'left' as const,
      width: 220,
      render: (v: string) => <Text code>{v}</Text>,
    },
    ...result.items.map((item, idx) => ({
      title: (
        <Space direction="vertical" size={0}>
          <Text strong style={{ fontSize: 12 }}>
            {item.task_name}
          </Text>
          <Text type="secondary" style={{ fontSize: 11 }}>
            #{item.task_id}
          </Text>
        </Space>
      ),
      key: `task_${item.task_id}`,
      width: 220,
      render: (_: any, row: any) => {
        const cell = row.cells.find((c: any) => c.task_id === item.task_id);
        if (!cell?.present) {
          return (
            <Tooltip title="该策略在此回测中没有结果">
              <CloseCircleOutlined style={{ color: '#bfbfbf' }} />
            </Tooltip>
          );
        }
        return (
          <Space direction="vertical" size={0}>
            <Space size={4}>
              <CheckCircleOutlined style={{ color: COMPARE_COLORS[idx % COMPARE_COLORS.length] }} />
              {percentTag(cell.total_return_pct)}
              <Text type="secondary" style={{ fontSize: 11 }}>
                / 超额 {fmtPct(cell.excess_return_pct)}
              </Text>
            </Space>
            <Text type="secondary" style={{ fontSize: 11 }}>
              回撤 {fmtPct(cell.max_drawdown_pct)} · 夏普{' '}
              {Number(cell.sharpe_ratio || 0).toFixed(2)} · {cell.trade_count || 0} 笔 · 换手{' '}
              {fmtPct(cell.turnover_rate ? cell.turnover_rate * 100 : 0)}
            </Text>
          </Space>
        );
      },
    })),
  ];
  const strategyComparisonData = result.strategy_comparison.map(row => ({
    key: row.strategy_key,
    strategy_key: row.strategy_key,
    cells: row.cells,
  }));

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card title="任务总览（按冠军策略 KPI）">
        <Table
          size="small"
          pagination={false}
          columns={taskColumns}
          dataSource={taskSummaryRows}
        />
      </Card>
      <Card title={`每策略横向对比（${result.strategy_comparison.length} 个策略）`}>
        <Table
          size="small"
          pagination={false}
          columns={strategyComparisonColumns}
          dataSource={strategyComparisonData}
          scroll={{ x: 'max-content' }}
        />
      </Card>
    </Space>
  );
};

// ============================================================================
// Helpers
// ============================================================================

function fmtPct(value?: number | null, precision = 2) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  return `${Number(value).toFixed(precision)}%`;
}

function percentTag(value?: number | null) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return <Text type="secondary">—</Text>;
  }
  const v = Number(value);
  return (
    <Text strong style={{ color: v >= 0 ? '#cf1322' : '#0f8f6b' }}>
      {v.toFixed(2)}%
    </Text>
  );
}

function compactDate(value?: string | null) {
  if (!value) return '—';
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format('YYYY-MM-DD') : String(value).slice(0, 10);
}

function statusColor(status?: string) {
  const s = String(status || '').toUpperCase();
  if (s === 'COMPLETED') return 'green';
  if (s === 'FAILED') return 'red';
  if (s === 'QUEUED') return 'gold';
  if (s === 'RUNNING') return 'blue';
  return 'default';
}

function statusLabel(status?: string) {
  const labels: Record<string, string> = {
    COMPLETED: '已完成',
    FAILED: '失败',
    QUEUED: '队列中',
    RUNNING: '运行中',
    PENDING: '待运行',
  };
  return labels[String(status || '').toUpperCase()] || status || '—';
}

export default LabWorkspace;
