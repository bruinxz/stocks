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
  Segmented,
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
  InfoCircleOutlined,
  LeftOutlined,
  NodeIndexOutlined,
  PlayCircleOutlined,
  PlusSquareOutlined,
  ReloadOutlined,
  RightOutlined,
  SafetyCertificateOutlined,
  SwapOutlined,
} from '@ant-design/icons';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import ReactECharts from 'echarts-for-react';
import dayjs, { Dayjs } from 'dayjs';
import { AnimatePresence, motion } from 'framer-motion';
import { useLocation, useNavigate } from 'react-router-dom';
import WorkspaceLayout, { WorkspaceTab } from '../../components/layout/WorkspaceLayout';
import WorkspaceHero from '../../components/layout/WorkspaceHero';
import LeaderboardTab from './LabWorkspace.LeaderboardTab';
import WalkForwardTab from './LabWorkspace.WalkForwardTab';
import QuarterlyRetrainTab from './LabWorkspace.QuarterlyRetrainTab';
import OverfitMetricsTab from './LabWorkspace.OverfitMetricsTab';
import WorkflowReadinessTab from './LabWorkspace.WorkflowReadinessTab';
import {
  labService,
  QuantStrategyItem,
  BacktestTask,
  BacktestCompareResponse,
  BacktestCompareItem,
  BacktestDrawdownSeriesResponse,
  BacktestMonthlyReturnsResponse,
  BacktestRollingSharpeResponse,
  CreateBacktestPayload,
  OptimizationRunSummary,
  ResearchExperiment,
  BacktestResearchAudit,
  BacktestExecutionConstraintAudit,
} from '../../services/labService';
import {
  formatRelative as formatLabRelative,
  formatDateTime as formatLabDateTime,
} from '../../utils/timeFormat';

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

const labStoryHints = {
  newBacktest: '把策略、股票池、区间和假设固定下来，方便以后复盘这次研究从哪来。',
  dataAudit: '确认当时真的能看到这些数据，避免用未来公告、未来成分股或补齐后的数据作弊。',
  execution: '把理论信号放进 A 股真实限制里，看看涨跌停、停牌、T+1 和资金是否挡单。',
  returns: '先看未经审计、审计后、可成交三层收益差异，再决定要不要深挖。',
  ledger: '账本负责把假设、回测任务、审计 artifact 和最终结论串起来。',
  initialCapital: '初始资金会影响仓位规模、资金不足阻断和最终收益解释。',
} as const;

const labStoryTooltipIconStyle: React.CSSProperties = {
  color: 'rgba(0, 0, 0, 0.45)',
  cursor: 'help',
  fontSize: 13,
};

const StoryTooltip: React.FC<{ story: keyof typeof labStoryHints }> = ({ story }) => (
  <Tooltip title={labStoryHints[story]}>
    <InfoCircleOutlined style={labStoryTooltipIconStyle} />
  </Tooltip>
);

const LabWorkspace: React.FC = () => {
  // Phase 9 (2026-06-28): tab 11 → 4 (普通用户) / 4 (admin).
  // 用户原话"页面太复杂、Tab 太多, 完全不知道怎么操作". 进一步把 Phase 3 的 11 项收成 4 个一级 tab:
  //   1. 我的策略  ← 旧 mine + leaderboard (内部 Segmented 切"列表 / 排行")
  //   2. 新建回测  ← 旧 new
  //   3. 评估报告  ← 阶段一研究审计 + walk_forward + optimization + overfit_metrics + quarterly_retrain
  //   4. 进阶      ← 旧 compare + workflow_readiness + advanced_quant
  //                  (内部 Segmented "回测对比 / 工作流体检 / 高级量化", 默认对比)
  // 旧 tab 的 React 组件全部保留, 只是重新挂在新 4 项之下 (Segmented 子视图).
  const tabs: WorkspaceTab[] = useMemo(() => {
    return [
      { key: 'my-strategies', label: '我的策略', icon: <ExperimentOutlined /> },
      { key: 'new-backtest', label: '新建回测', icon: <PlusSquareOutlined /> },
      { key: 'evaluation', label: '评估报告', icon: <SafetyCertificateOutlined /> },
      { key: 'advanced', label: '进阶', icon: <NodeIndexOutlined /> },
    ];
  }, []);
  const [activeKey, setActiveKey] = useState('my-strategies');

  // Phase 9 — 每个一级 tab 内的子视图 Segmented 状态
  const [mineSubView, setMineSubView] = useState<'list' | 'leaderboard'>('list');
  const [evalSubView, setEvalSubView] = useState<
    | 'overview'
    | 'ledger'
    | 'data-audit'
    | 'execution'
    | 'walkforward'
    | 'optimization'
    | 'overfit'
    | 'quarterly'
  >('overview');
  // Tab 收敛 (2026-07-04, v2): 评估报告改为 hub-and-spoke —— 总览卡片网格即导航,
  // 点卡片进细分视图, 细分视图顶部"返回评估总览"回到 hub. 去掉三层 Segmented 嵌套.
  const [advancedSubView, setAdvancedSubView] = useState<'compare' | 'workflow'>(
    'compare'
  );

  // US-078: 从策略详情页跳回来时携带 location.state，自动触发 clone/edit/newRun
  const location = useLocation();
  const navigate = useNavigate();

  // ---- 主数据：策略列表 + 回测任务列表 ----
  const [strategies, setStrategies] = useState<QuantStrategyItem[]>([]);
  const [tasks, setTasks] = useState<BacktestTask[]>([]);
  const [researchExperiments, setResearchExperiments] = useState<ResearchExperiment[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [strategyList, taskList, experimentList] = await Promise.all([
        labService.listQuantStrategies(),
        labService.listBacktestTasks(50),
        labService.listResearchExperiments(50).catch(() => []),
      ]);
      setStrategies(strategyList);
      setTasks(taskList);
      setResearchExperiments(experimentList);
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

  // ---- 轮询任务进度直至 COMPLETED/FAILED；带超时保护，避免 worker 挂掉永久 polling ----
  useEffect(() => {
    if (!pollingTaskId) return undefined;
    const startedAt = Date.now();
    const MAX_POLL_MS = 10 * 60 * 1000; // 10 分钟超时
    const timer = window.setInterval(async () => {
      // 超时退出
      if (Date.now() - startedAt > MAX_POLL_MS) {
        setPollingTaskId(null);
        message.warning('回测运行已超过 10 分钟，停止轮询。请手动点列表刷新查看最新状态。');
        return;
      }
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
        hypothesis: `验证 ${strategy.name || strategy.strategy_key} 在当前股票池和时间窗口内是否具备可复现收益。`,
        range: [startDate, today],
        initial_capital: DEFAULT_INITIAL_CAPITAL,
        benchmark_symbol: DEFAULT_BENCHMARK,
        universe: 'favorites',
        params_text: Object.keys(defaults).length ? JSON.stringify(defaults, null, 2) : '',
      });
      setSeedStrategyKey(strategy.strategy_key);
      setActiveKey('new-backtest');
      message.info(
        `已加载策略 "${strategy.name || strategy.strategy_key}" 的默认参数到新建回测表单`
      );
    },
    [form]
  );

  // US-078: 详情页通过 navigate('/workspace/lab', { state: { seedStrategyKey, intent } }) 触发回流，
  // 等 strategies 列表装载完成后定位到对应 strategy 自动执行 clone/edit/newRun，然后 clear state
  // 避免回退键 / 刷新时重复触发。
  useEffect(() => {
    const state = location.state as {
      seedStrategyKey?: string;
      intent?: 'clone' | 'edit' | 'newRun';
    } | null;
    if (!state?.seedStrategyKey || !state?.intent) return;
    if (strategies.length === 0) return; // 等 refresh 完成
    const target = strategies.find(s => s.strategy_key === state.seedStrategyKey);
    if (!target) {
      message.warning(`未找到策略 "${state.seedStrategyKey}"，无法 ${state.intent}`);
      navigate(location.pathname, { replace: true, state: null });
      return;
    }
    if (state.intent === 'clone') {
      handleClone(target);
    } else if (state.intent === 'edit') {
      setEditingStrategy(target);
    } else if (state.intent === 'newRun') {
      // newRun 与 clone 共享相同的"预填表单"路径，只是语义上"立即去跑"
      handleClone(target);
    }
    navigate(location.pathname, { replace: true, state: null });
  }, [location, navigate, strategies, handleClone]);

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
        create_research_experiment: true,
        hypothesis:
          values.hypothesis ||
          `验证 ${values.strategy_keys?.join(', ')} 在当前股票池的可复现收益。`,
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
        data_policy_json: {
          point_in_time: true,
          disclosure_date_required: true,
          universe_as_of_required: true,
          missing_policy: 'insufficient',
          audit_coverage: {
            disclosure_date: 'strategy_factor_as_of_guard',
            universe_visibility: 'backtest_universe_as_of_guard',
          },
        },
        constraint_policy_json: {
          market: 'A_SHARE',
          t_plus_one: values.enable_t_plus_one !== false,
          block_limit_up: true,
          block_limit_down: true,
          block_suspended: true,
          lot_size: 100,
        },
      };
      setSubmitting(true);
      const result = await labService.createBacktestTask(payload);
      const createdTaskId =
        result?.task?.task?.id || result?.task?.id || (result as any)?.id || null;
      if (createdTaskId) {
        message.success(`回测任务已创建（task_id=${createdTaskId}），正在轮询执行进度…`);
        setPollingTaskId(Number(createdTaskId));
        await refresh();
        setActiveKey('my-strategies');
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
    () => tasks.filter(t => ['RUNNING', 'QUEUED'].includes(String(t.status || '').toUpperCase())),
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

  // ---- render tab body (Phase 9: 4 个一级 tab, 每个内部用 Segmented 切子视图) ----
  // 每个一级 tab 顶部统一加 ws-tab-header (eyebrow + title + subtitle) Stripe 风
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
  } else if (activeKey === 'my-strategies') {
    // ===== Tab 1: 我的策略 (列表 + 排行) =====
    body = (
      <>
        <div className="ws-tab-header">
          <div className="ws-tab-eyebrow">LAB · 策略实验室</div>
          <h1 className="ws-tab-title">我的策略</h1>
          <p className="ws-tab-subtitle">
            查看已注册的所有量化策略, 克隆参数或跳转策略详情, 切到 “策略排行” 看历史回测综合得分。
          </p>
        </div>
        <Segmented
          className="ws-tab-segmented"
          options={[
            { label: '策略列表', value: 'list' },
            { label: '策略排行', value: 'leaderboard' },
          ]}
          value={mineSubView}
          onChange={v => setMineSubView(v as typeof mineSubView)}
        />
        {mineSubView === 'list' ? (
          <MyStrategiesTab
            strategies={strategies}
            tasks={tasks}
            loading={loading}
            onClone={handleClone}
            onEdit={setEditingStrategy}
            onOpenDetail={s =>
              navigate(`/workspace/lab/strategies/${encodeURIComponent(s.strategy_key)}`)
            }
          />
        ) : (
          <LeaderboardTab
            strategiesMeta={strategies.map(s => ({
              strategy_key: s.strategy_key,
              name: (s as any).name || s.strategy_key,
            }))}
          />
        )}
      </>
    );
  } else if (activeKey === 'new-backtest') {
    // ===== Tab 2: 新建回测 =====
    body = (
      <>
        <div className="ws-tab-header">
          <div className="ws-tab-eyebrow">LAB · 策略实验室</div>
          <h1 className="ws-tab-title">新建回测</h1>
          <p className="ws-tab-subtitle">
            选择策略 + 时间窗 + 资金参数, 后端 worker 跑完即可在 “我的策略” 或 “进阶 · 回测对比”
            看结果。
          </p>
        </div>
        <NewBacktestTab
          form={form}
          strategies={strategies}
          submitting={submitting}
          seedStrategyKey={seedStrategyKey}
          onSubmit={handleSubmitBacktest}
          pollingTaskId={pollingTaskId}
          tasks={tasks}
        />
      </>
    );
  } else if (activeKey === 'evaluation') {
    // ===== Tab 3: 评估报告 (研究审计 / 走查 / 寻优 / 影子 / 过拟合 / 季度) =====
    body = (
      <>
        <div className="ws-tab-header">
          <div className="ws-tab-eyebrow">LAB · 策略实验室</div>
          <h1 className="ws-tab-title">评估报告</h1>
          <p className="ws-tab-subtitle">
            综合评估当前策略的可信度和样本外稳定性 · 包含实验账本 / 数据审计 / 成交约束 /
            Walk-Forward / 寻优历史 / Shadow Run。
          </p>
        </div>
        {evalSubView !== 'overview' && (
          <div className="ws-eval-back">
            <Button
              type="text"
              size="small"
              icon={<LeftOutlined />}
              onClick={() => setEvalSubView('overview')}
            >
              返回评估总览
            </Button>
          </div>
        )}
        {evalSubView === 'overview' ? (
          <Card>
            <Space direction="vertical" size={16} style={{ width: '100%' }}>
              <Alert
                type="info"
                showIcon
                message="综合评估总览"
                description={
                  <Space direction="vertical" size={4}>
                    <Text>
                      策略上线前的 “体检套件”——从数据、成交、泛化和稳定性角度独立打分, 任何一项严重
                      fail 都建议 暂缓上线。点下方任意卡片进入对应细分视图查看详情。
                    </Text>
                    <Text type="secondary">
                      推荐路径: 实验账本 → 数据审计 → 成交约束 → Walk-Forward 走查 → 过拟合诊断 →
                      Shadow 影子运行 (≥ 2 周) → 上线。
                    </Text>
                  </Space>
                }
              />
              <Row gutter={[16, 16]}>
                <Col xs={24} md={8}>
                  <Card hoverable onClick={() => setEvalSubView('ledger')}>
                    <Statistic title="实验账本" value={researchExperiments.length} suffix="条" />
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      串起假设、回测任务、审计 artifact 和最终结论。
                    </Text>
                  </Card>
                </Col>
                <Col xs={24} md={8}>
                  <Card hoverable onClick={() => setEvalSubView('data-audit')}>
                    <Statistic title="数据审计" value="PIT / as-of" />
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      检查是否误用未来公告、未来成分股或补齐后的数据。
                    </Text>
                  </Card>
                </Col>
                <Col xs={24} md={8}>
                  <Card hoverable onClick={() => setEvalSubView('execution')}>
                    <Statistic title="成交约束" value="A 股规则" />
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      统一查看涨跌停、停牌、T+1、整手和资金阻断。
                    </Text>
                  </Card>
                </Col>
                <Col xs={24} md={8}>
                  <Card hoverable onClick={() => setEvalSubView('walkforward')}>
                    <Statistic title="Walk-Forward" value="样本外稳定" suffix="↗" />
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      滚动 train→test 验证, 看策略在未见过的窗口表现是否衰减。
                    </Text>
                  </Card>
                </Col>
                <Col xs={24} md={8}>
                  <Card hoverable onClick={() => setEvalSubView('optimization')}>
                    <Statistic title="参数寻优" value="GridSearch / Bayesian" />
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      过往寻优历史 + 每组 trial 的 in-sample / out-sample 表现。
                    </Text>
                  </Card>
                </Col>
                <Col xs={24} md={8}>
                  <Card hoverable onClick={() => setEvalSubView('overfit')}>
                    <Statistic title="过拟合诊断" value="DSR / PBO" />
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      Deflated Sharpe Ratio + Probability of Backtest Overfitting。
                    </Text>
                  </Card>
                </Col>
                <Col xs={24} md={8}>
                  <Card hoverable onClick={() => setEvalSubView('quarterly')}>
                    <Statistic title="季度重训" value="参数刷新" />
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      每季度按 lifecycle policy 重训, 防止策略静态老化。
                    </Text>
                  </Card>
                </Col>
              </Row>
            </Space>
          </Card>
        ) : evalSubView === 'ledger' ? (
          <ResearchLedgerTab
            experiments={researchExperiments}
            tasks={tasks}
            loading={loading}
            onRefresh={refresh}
          />
        ) : evalSubView === 'data-audit' ? (
          <DataAuditTab tasks={tasks} experiments={researchExperiments} />
        ) : evalSubView === 'execution' ? (
          <ExecutionConstraintAuditTab tasks={tasks} experiments={researchExperiments} />
        ) : evalSubView === 'walkforward' ? (
          <WalkForwardTab strategies={strategies} />
        ) : evalSubView === 'optimization' ? (
          <OptimizationRunsTab />
        ) : evalSubView === 'overfit' ? (
          <OverfitMetricsTab />
        ) : (
          <QuarterlyRetrainTab
            strategies={
              strategies as Array<QuantStrategyItem & { lifecycle_policy?: Record<string, any> }>
            }
          />
        )}
      </>
    );
  } else {
    // ===== Tab 4: 进阶 (回测对比 / 工作流体检 / 高级量化) =====
    body = (
      <>
        <div className="ws-tab-header">
          <div className="ws-tab-eyebrow">LAB · 策略实验室</div>
          <h1 className="ws-tab-title">进阶</h1>
          <p className="ws-tab-subtitle">
            研究员级别工具 — 横向对比 N 个回测、检查工作流装配是否齐备、调整高级量化引擎参数。
            新手可跳过, 按需展开使用。
          </p>
        </div>
        <Segmented
          className="ws-tab-segmented"
          options={[
            { label: '回测对比', value: 'compare' },
            { label: '工作流体检', value: 'workflow' },
          ]}
          value={advancedSubView}
          onChange={v => setAdvancedSubView(v as typeof advancedSubView)}
        />
        {advancedSubView === 'compare' ? (
          <CompareTab
            completedTasks={completedTasks}
            selectedIds={selectedCompareIds}
            onSelectionChange={setSelectedCompareIds}
            compareLoading={compareLoading}
            compareResult={compareResult}
            onCompare={handleCompare}
          />
        ) : (
          <WorkflowReadinessTab strategies={strategies} tasks={tasks} />
        )}
      </>
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
      hero={
        <WorkspaceHero
          eyebrow="Lab · 策略实验室"
          title="策略实验室"
          subtitle="29+ 个真实策略 · 一站式回测 / 寻优 / 影子运行 / Walk-Forward 体检"
          variant="violet"
          metrics={[
            { label: '注册策略', value: strategies.length, unit: '个', emphasis: true },
            { label: '进行中回测', value: runningTasks.length, unit: '项' },
            { label: '近 7 日完成', value: last7DaysCount, unit: '次' },
            {
              label: '总回测',
              value: tasks.length,
              unit: '次',
            },
          ]}
        />
      }
      themed
    >
      <AnimatePresence mode="wait">
        <motion.div
          key={activeKey}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        >
          {body}
        </motion.div>
      </AnimatePresence>
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
                  borderRadius: 8,
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
    </WorkspaceLayout>
  );
};

// ============================================================================
// Tab 1 — 我的策略
// ============================================================================

const STRATEGY_CATEGORY_DISPLAY: Record<string, { label: string; color: string }> = {
  multi_factor: { label: '多因子', color: 'blue' },
  momentum: { label: '动量', color: 'orange' },
  event_driven: { label: '事件驱动', color: 'red' },
  trend: { label: '趋势', color: 'blue' },
  reversal: { label: '反转', color: 'blue' },
  value: { label: '价值', color: 'green' },
  quality: { label: '质量', color: 'default' },
  pattern: { label: '形态', color: 'red' },
  other: { label: '其他', color: 'default' },
};

const STRATEGY_RISK_DISPLAY: Record<string, { label: string; color: string }> = {
  low: { label: '低风险', color: 'green' },
  medium: { label: '中风险', color: 'default' },
  high: { label: '高风险', color: 'red' },
};

const MyStrategiesTab: React.FC<{
  strategies: QuantStrategyItem[];
  tasks: BacktestTask[];
  loading: boolean;
  onClone: (s: QuantStrategyItem) => void;
  onEdit: (s: QuantStrategyItem) => void;
  onOpenDetail: (s: QuantStrategyItem) => void;
}> = ({ strategies, tasks, loading, onClone, onEdit, onOpenDetail }) => {
  // Phase 10 — 每条策略的"最近回测时间" — 从 tasks 列表里挑最新一条命中此 strategy_key
  // 的 created_at. tasks 接 listBacktestTasks (limit=50), 覆盖最近 50 次, 足够"最近活动"
  // 这种语义. 没有命中时显 "暂无回测".
  const lastBacktestByKey = useMemo(() => {
    const map = new Map<string, BacktestTask>();
    for (const t of tasks) {
      const keys = Array.isArray(t.strategy_keys) ? t.strategy_keys : [];
      for (const k of keys) {
        const prev = map.get(k);
        // 取 updated_at > created_at; 任一更新的 task 覆盖
        const tTime = new Date(t.updated_at || t.created_at).getTime();
        const prevTime = prev ? new Date(prev.updated_at || prev.created_at).getTime() : 0;
        if (!prev || tTime > prevTime) map.set(k, t);
      }
    }
    return map;
  }, [tasks]);
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
          STRATEGY_CATEGORY_DISPLAY[strategy.category || 'other'] ??
          STRATEGY_CATEGORY_DISPLAY.other;
        const risk = STRATEGY_RISK_DISPLAY[strategy.risk_level || 'medium'];
        return (
          <Col xs={24} sm={12} lg={8} xxl={6} key={strategy.strategy_key}>
            <Card
              hoverable
              style={{ height: '100%' }}
              title={
                <Space size={6}>
                  <a onClick={() => onOpenDetail(strategy)} style={{ color: 'inherit' }}>
                    <Text strong>
                      {strategy.name || strategy.display_name || strategy.strategy_key}
                    </Text>
                  </a>
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
                <Tooltip
                  key="detail-tooltip"
                  title="进入策略详情页 — 含历史回测列表与实盘绑定状态（US-078）"
                >
                  <a key="detail" onClick={() => onOpenDetail(strategy)}>
                    <RightOutlined /> 详情
                  </a>
                </Tooltip>,
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
              {/* Phase 10 — 数据新鲜度: 最近一次回测时间 */}
              <div style={{ marginTop: 6 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  最近回测：
                </Text>
                {(() => {
                  const last = lastBacktestByKey.get(strategy.strategy_key);
                  if (!last) {
                    return (
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        暂无 (近 50 次回测中未出现)
                      </Text>
                    );
                  }
                  return (
                    <Tooltip title={formatLabDateTime(last.updated_at || last.created_at)}>
                      <Text style={{ fontSize: 12, fontFamily: 'var(--font-mono)' }}>
                        {formatLabRelative(last.updated_at || last.created_at)}
                      </Text>
                    </Tooltip>
                  );
                })()}
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
                    String(option?.label || '')
                      .toLowerCase()
                      .includes(input.toLowerCase())
                  }
                  options={strategies.map(s => ({
                    value: s.strategy_key,
                    label: `${s.name || s.strategy_key} (${s.strategy_key})`,
                    disabled: s.enabled === false,
                  }))}
                />
              </Form.Item>
            </Col>
            <Col xs={24}>
              <Form.Item
                label={
                  <Space size={4}>
                    研究假设
                    <StoryTooltip story="newBacktest" />
                  </Space>
                }
                name="hypothesis"
                rules={[{ required: true, message: '请输入本次实验要验证的假设' }]}
                extra="实验账本会记录这个假设，并把后续数据审计、成交约束审计和回测结论挂在同一条链路下。"
              >
                <Input.TextArea
                  rows={2}
                  placeholder="例如：验证低波动多因子在最近两年自选股池中是否能获得稳定超额收益"
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
              <Form.Item
                label={
                  <Space size={4}>
                    初始资金
                    <StoryTooltip story="initialCapital" />
                  </Space>
                }
                name="initial_capital"
              >
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
// Tab 3 — 阶段一：实验账本 / 数据审计 / 成交约束
// ============================================================================

const ResearchLedgerTab: React.FC<{
  experiments: ResearchExperiment[];
  tasks: BacktestTask[];
  loading: boolean;
  onRefresh: () => void;
}> = ({ experiments, tasks, loading, onRefresh }) => {
  const [auditLoadingId, setAuditLoadingId] = useState<number | null>(null);
  const taskById = useMemo(() => new Map(tasks.map(task => [task.id, task])), [tasks]);

  const runAudit = async (id: number) => {
    setAuditLoadingId(id);
    try {
      await labService.runResearchExperimentAudit(id);
      message.success('审计已刷新');
      await onRefresh();
    } catch (error: any) {
      message.error(`审计失败：${error?.message || error}`);
    } finally {
      setAuditLoadingId(null);
    }
  };

  const columns = [
    {
      title: '实验账本',
      key: 'ledger',
      render: (_: any, row: ResearchExperiment) => (
        <Space direction="vertical" size={2}>
          <Text strong>{row.hypothesis || row.experiment_key}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            #{row.id} · {row.strategy_key} · {compactDate(row.start_date)} ~{' '}
            {compactDate(row.end_date)}
          </Text>
        </Space>
      ),
    },
    {
      title: '审计状态',
      dataIndex: 'verdict',
      key: 'verdict',
      width: 130,
      render: (verdict: string) => researchVerdictTag(verdict),
    },
    {
      title: '回测任务',
      key: 'task',
      width: 220,
      render: (_: any, row: ResearchExperiment) => {
        const task = row.task_id ? taskById.get(Number(row.task_id)) : null;
        return task ? (
          <Space direction="vertical" size={0}>
            <Text>{task.task_name}</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              #{task.id} · {statusLabel(task.status)}
            </Text>
          </Space>
        ) : (
          <Text type="secondary">未绑定回测</Text>
        );
      },
    },
    {
      title: '操作',
      key: 'actions',
      width: 160,
      render: (_: any, row: ResearchExperiment) => (
        <Button
          size="small"
          icon={<ReloadOutlined />}
          loading={auditLoadingId === row.id}
          disabled={!row.task_id}
          onClick={() => runAudit(row.id)}
        >
          重新审计
        </Button>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message={
          <Space size={6}>
            阶段一实验账本
            <StoryTooltip story="ledger" />
          </Space>
        }
        description="每次研究回测都会绑定研究假设、数据策略、成交约束和审计 artifact，用来回答：结果从哪里来、有没有偷看未来、真实 A 股规则下还能不能成交。"
      />
      <Card
        title={
          <Space size={6}>
            实验账本
            <StoryTooltip story="ledger" />
          </Space>
        }
        extra={<Button onClick={onRefresh}>刷新</Button>}
      >
        <Table<ResearchExperiment>
          rowKey="id"
          loading={loading}
          columns={columns}
          dataSource={experiments}
          pagination={{ pageSize: 10 }}
        />
      </Card>
    </Space>
  );
};

const DataAuditTab: React.FC<{
  tasks: BacktestTask[];
  experiments: ResearchExperiment[];
}> = ({ tasks, experiments }) => {
  const completedTasks = useMemo(
    () => tasks.filter(task => String(task.status).toUpperCase() === 'COMPLETED'),
    [tasks]
  );
  const [taskId, setTaskId] = useState<number | null>(completedTasks[0]?.id || null);
  const [audit, setAudit] = useState<BacktestResearchAudit | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!taskId && completedTasks[0]?.id) setTaskId(completedTasks[0].id);
  }, [completedTasks, taskId]);

  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    setLoading(true);
    labService
      .getBacktestResearchAudit(taskId)
      .then(data => {
        if (!cancelled) setAudit(data);
      })
      .catch(error => {
        if (!cancelled) {
          setAudit(null);
          message.warning(`数据审计暂不可用：${error?.message || error}`);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  const selectedTask = tasks.find(task => task.id === taskId) || null;
  const backtestArtifact = audit?.artifacts.find(item => item.artifact_type === 'backtest');
  const integrityArtifact = audit?.artifacts.find(item => item.artifact_type === 'integrity_audit');
  const pitArtifact = audit?.artifacts.find(item => item.artifact_type === 'point_in_time_audit');
  const auditedReturnArtifact = audit?.artifacts.find(
    item => item.artifact_type === 'audited_return_replay'
  );
  const credibility = audit?.credibility_verdict;
  const taskExperiment = experiments.find(item => item.task_id === taskId);
  const auditedReturnPayload = auditedReturnArtifact?.payload_json || {};
  const theoreticalReturn = pickFiniteNumber(
    auditedReturnPayload.theoretical_return_pct,
    selectedTask?.run_summary?.best_return_pct ?? 0
  );
  const auditedReturn = pickFiniteNumber(
    auditedReturnPayload.audited_return_pct,
    credibility?.verdict === 'reject' || credibility?.verdict === 'insufficient'
      ? 0
      : theoreticalReturn
  );
  const executableReturn = pickFiniteNumber(
    auditedReturnPayload.executable_return_pct,
    theoreticalReturn
  );

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title={
          <Space size={6}>
            数据审计
            <StoryTooltip story="dataAudit" />
          </Space>
        }
        extra={
          <Select
            style={{ width: 360 }}
            placeholder="选择已完成回测"
            value={taskId || undefined}
            onChange={value => setTaskId(Number(value))}
            options={completedTasks.map(task => ({
              value: task.id,
              label: `#${task.id} ${task.task_name}`,
            }))}
          />
        }
      >
        {completedTasks.length === 0 ? (
          <Empty description="还没有已完成回测" />
        ) : loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
            <Spin tip="读取数据审计…" />
          </div>
        ) : (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Alert
              type={
                credibility?.verdict === 'reject'
                  ? 'error'
                  : credibility?.verdict === 'pass'
                    ? 'success'
                    : 'warning'
              }
              showIcon
              message={credibility?.title || '审计状态待生成'}
              description={credibility?.summary || '回测完成后会自动生成研究审计。'}
            />
            <Row gutter={[16, 16]}>
              <Col xs={24} md={8}>
                <AuditArtifactCard title="回测来源" artifact={backtestArtifact} />
              </Col>
              <Col xs={24} md={8}>
                <AuditArtifactCard title="未来数据检查" artifact={integrityArtifact} />
              </Col>
              <Col xs={24} md={8}>
                <AuditArtifactCard title="点时数据审计" artifact={pitArtifact} />
              </Col>
            </Row>
            <Card
              size="small"
              title={
                <Space size={6}>
                  理论收益 vs 审计后收益 vs 可成交收益
                  <StoryTooltip story="returns" />
                </Space>
              }
            >
              <Row gutter={[16, 16]}>
                <Col xs={24} md={8}>
                  <Statistic title="理论收益" value={theoreticalReturn} precision={2} suffix="%" />
                </Col>
                <Col xs={24} md={8}>
                  <Statistic title="审计后收益" value={auditedReturn} precision={2} suffix="%" />
                </Col>
                <Col xs={24} md={8}>
                  <Statistic title="可成交收益" value={executableReturn} precision={2} suffix="%" />
                </Col>
              </Row>
              <Text type="secondary" style={{ display: 'block', marginTop: 12 }}>
                实验 #{taskExperiment?.id || audit?.experiment?.id || '—'} ·{' '}
                {selectedTask?.task_name || '—'} ·{' '}
                {auditedReturnArtifact?.summary || '后端回放收益生成后会优先展示。'}
              </Text>
            </Card>
          </Space>
        )}
      </Card>
    </Space>
  );
};

const ExecutionConstraintAuditTab: React.FC<{
  tasks: BacktestTask[];
  experiments: ResearchExperiment[];
}> = ({ tasks, experiments }) => {
  const completedTasks = useMemo(
    () => tasks.filter(task => String(task.status).toUpperCase() === 'COMPLETED'),
    [tasks]
  );
  const [taskId, setTaskId] = useState<number | null>(completedTasks[0]?.id || null);
  const [audit, setAudit] = useState<BacktestExecutionConstraintAudit | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!taskId && completedTasks[0]?.id) setTaskId(completedTasks[0].id);
  }, [completedTasks, taskId]);

  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    setLoading(true);
    labService
      .getBacktestExecutionConstraintAudit(taskId)
      .then(data => {
        if (!cancelled) setAudit(data);
      })
      .catch(error => {
        if (!cancelled) {
          setAudit(null);
          message.warning(`成交约束审计暂不可用：${error?.message || error}`);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  const selectedTask = tasks.find(task => task.id === taskId) || null;
  const taskExperiment = experiments.find(item => item.task_id === taskId);
  const reasonRows = audit?.grouped_reasons || [];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title={
          <Space size={6}>
            成交约束
            <StoryTooltip story="execution" />
          </Space>
        }
        extra={
          <Select
            style={{ width: 360 }}
            placeholder="选择已完成回测"
            value={taskId || undefined}
            onChange={value => setTaskId(Number(value))}
            options={completedTasks.map(task => ({
              value: task.id,
              label: `#${task.id} ${task.task_name}`,
            }))}
          />
        }
      >
        {completedTasks.length === 0 ? (
          <Empty description="还没有已完成回测" />
        ) : loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
            <Spin tip="读取成交约束审计…" />
          </div>
        ) : (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Alert
              type={
                audit?.status === 'reject' || audit?.status === 'error'
                  ? 'error'
                  : audit?.status === 'pass'
                    ? 'success'
                    : 'warning'
              }
              showIcon
              message={audit?.title || 'A股成交约束'}
              description={audit?.summary || '等待回测生成成交约束结论。'}
            />
            <Row gutter={[16, 16]}>
              <Col xs={24} md={6}>
                <Statistic title="跳过/拒单" value={audit?.rejected_order_count || 0} suffix="笔" />
              </Col>
              <Col xs={24} md={6}>
                <Statistic
                  title="买入成交"
                  value={audit?.diagnostics?.buy_fill_count || 0}
                  suffix="笔"
                />
              </Col>
              <Col xs={24} md={6}>
                <Statistic
                  title="卖出成交"
                  value={audit?.diagnostics?.sell_fill_count || 0}
                  suffix="笔"
                />
              </Col>
              <Col xs={24} md={6}>
                <Statistic title="审计状态" value={audit?.status || 'pending'} />
              </Col>
            </Row>
            <Table
              size="small"
              rowKey="reason"
              columns={[
                { title: '原因', dataIndex: 'label', key: 'label' },
                { title: '代码', dataIndex: 'reason', key: 'reason' },
                { title: '数量', dataIndex: 'count', key: 'count', width: 100 },
              ]}
              dataSource={reasonRows}
              pagination={false}
              locale={{ emptyText: '没有涨停、跌停、停牌或 T+1 阻断记录' }}
            />
            <Text type="secondary">
              实验 #{taskExperiment?.id || audit?.experiment?.id || '—'} ·{' '}
              {selectedTask?.task_name || '—'}
            </Text>
          </Space>
        )}
      </Card>
    </Space>
  );
};

const AuditArtifactCard: React.FC<{
  title: string;
  artifact?: BacktestResearchAudit['artifacts'][number];
}> = ({ title, artifact }) => (
  <Card size="small" title={title} extra={artifact ? artifactStatusTag(artifact.status) : null}>
    <Paragraph style={{ minHeight: 72 }}>{artifact?.summary || '暂无审计结论。'}</Paragraph>
    {artifact?.payload_json?.issue_slots && (
      <Space wrap>
        {artifact.payload_json.issue_slots.map((slot: any) => (
          <Tag key={slot.key} color={artifactStatusColor(slot.status)}>
            {slot.label || slot.key}: {slot.status}
          </Tag>
        ))}
      </Space>
    )}
  </Card>
);

// ============================================================================
// Tab 4 — 回测对比
// ============================================================================

const CompareTab: React.FC<{
  completedTasks: BacktestTask[];
  selectedIds: number[];
  onSelectionChange: (ids: number[]) => void;
  compareLoading: boolean;
  compareResult: BacktestCompareResponse | null;
  onCompare: () => void;
}> = ({
  completedTasks,
  selectedIds,
  onSelectionChange,
  compareLoading,
  compareResult,
  onCompare,
}) => {
  // ----- US-075: 子图数据 (回撤 / 月度热力 / 滚动夏普) -----
  // 一次 compare 之后并发拉这三套 series；任一失败的 task 在本地保留 error 字段，
  // 各子卡片自己降级渲染 (Alert)，不阻塞其他 task 显示。
  const [drawdownByTask, setDrawdownByTask] = useState<Map<number, BacktestDrawdownSeriesResponse>>(
    new Map()
  );
  const [monthlyByTask, setMonthlyByTask] = useState<Map<number, BacktestMonthlyReturnsResponse>>(
    new Map()
  );
  const [sharpeByTask, setSharpeByTask] = useState<Map<number, BacktestRollingSharpeResponse>>(
    new Map()
  );
  const [seriesLoading, setSeriesLoading] = useState(false);
  const [seriesErrors, setSeriesErrors] = useState<Record<number, string>>({});

  const compareKey = useMemo(
    () => (compareResult?.items || []).map(i => i.task_id).join(','),
    [compareResult]
  );

  useEffect(() => {
    if (!compareResult || compareResult.items.length === 0) {
      setDrawdownByTask(new Map());
      setMonthlyByTask(new Map());
      setSharpeByTask(new Map());
      setSeriesErrors({});
      return;
    }
    let cancelled = false;
    setSeriesLoading(true);
    setSeriesErrors({});
    const tasks = compareResult.items.map(it => it.task_id);
    const fetchOne = async (taskId: number) => {
      const [dd, mm, sh] = await Promise.allSettled([
        labService.getBacktestDrawdownSeries(taskId),
        labService.getBacktestMonthlyReturns(taskId),
        labService.getBacktestRollingSharpeSeries(taskId, 90),
      ]);
      return { taskId, dd, mm, sh };
    };
    Promise.all(tasks.map(fetchOne))
      .then(results => {
        if (cancelled) return;
        const ddMap = new Map<number, BacktestDrawdownSeriesResponse>();
        const mmMap = new Map<number, BacktestMonthlyReturnsResponse>();
        const shMap = new Map<number, BacktestRollingSharpeResponse>();
        const errMap: Record<number, string> = {};
        for (const r of results) {
          const errs: string[] = [];
          if (r.dd.status === 'fulfilled') ddMap.set(r.taskId, r.dd.value);
          else errs.push(`回撤: ${r.dd.reason?.message || r.dd.reason || '请求失败'}`);
          if (r.mm.status === 'fulfilled') mmMap.set(r.taskId, r.mm.value);
          else errs.push(`月度: ${r.mm.reason?.message || r.mm.reason || '请求失败'}`);
          if (r.sh.status === 'fulfilled') shMap.set(r.taskId, r.sh.value);
          else errs.push(`夏普: ${r.sh.reason?.message || r.sh.reason || '请求失败'}`);
          if (errs.length) errMap[r.taskId] = errs.join(' · ');
        }
        setDrawdownByTask(ddMap);
        setMonthlyByTask(mmMap);
        setSharpeByTask(shMap);
        setSeriesErrors(errMap);
      })
      .finally(() => {
        if (!cancelled) setSeriesLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // 依赖 compareKey 而非 compareResult — compareResult 引用每次 setCompareResult 都会变，
    // 但 task_ids 没变就不该重拉 (复合 PK 等价)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compareKey]);

  const selectionColumns = [
    {
      title: '任务',
      dataIndex: 'task_name',
      key: 'task_name',
      render: (text: string, row: BacktestTask) => (
        <Space direction="vertical" size={0}>
          <Text strong>{text}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
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
            <Tag key={k} style={{ fontSize: 12 }}>
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
          <Text strong style={{ color: Number(ret) >= 0 ? '#dc2626' : '#0f8f6b' }}>
            {Number(ret).toFixed(2)}%
          </Text>
        ) : (
          <Text type="secondary">—</Text>
        );
      },
    },
    {
      title: '审计状态',
      key: 'research_verdict',
      width: 120,
      render: (_: any, row: BacktestTask) => researchVerdictTag(row.run_summary?.research_verdict),
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
          <CompareDrawdownCard
            items={compareResult.items}
            data={drawdownByTask}
            loading={seriesLoading}
            errors={seriesErrors}
          />
          <CompareRollingSharpeCard
            items={compareResult.items}
            data={sharpeByTask}
            loading={seriesLoading}
            errors={seriesErrors}
          />
          <CompareMonthlyReturnsCard
            items={compareResult.items}
            data={monthlyByTask}
            loading={seriesLoading}
            errors={seriesErrors}
          />
          <CompareTableCard result={compareResult} />
        </>
      )}
    </Space>
  );
};

const COMPARE_COLORS = ['#1677ff', '#16a34a', '#fa8c16', '#eb2f96'];

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
        const cum = Number.isFinite(Number(point?.cumulative_return_pct))
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
            <XAxis dataKey="date" tick={{ fontSize: 12 }} minTickGap={30} />
            <YAxis tickFormatter={v => `${v}%`} tick={{ fontSize: 12 }} />
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

// ----------------------------------------------------------------------------
// US-075 (1)/(3) — 回撤曲线 / 滚动夏普曲线（Recharts 多 task 叠加）
// US-075 (2) — 月度收益热力图（echarts heatmap，每 task 一张矩阵）
// ----------------------------------------------------------------------------

/**
 * 把 N 个 task 的 series 合并成 Recharts 单 data array 共享 X 轴 (date)。
 * 输出 [{ date, task_<id>: <value>|null, ... }, ...]，缺失日期对应 task 列为 null
 * 让 Recharts <Line connectNulls /> 自然跳过断段。
 *
 * Codebase pattern: "Recharts multi-series 必须共享 X 轴" — N 条曲线 ≠ N 个 data array。
 */
function mergeSeriesByDate<T extends { date: string }>(
  taskSeries: Array<{ taskId: number; series: T[] }>,
  pickValue: (point: T) => number | null
): Array<Record<string, number | string | null>> {
  const dateMap = new Map<string, Record<string, number | string | null>>();
  for (const { taskId, series } of taskSeries) {
    for (const p of series) {
      if (!p.date) continue;
      if (!dateMap.has(p.date)) dateMap.set(p.date, { date: p.date });
      const row = dateMap.get(p.date)!;
      row[`task_${taskId}`] = pickValue(p);
    }
  }
  return Array.from(dateMap.values()).sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

const CompareDrawdownCard: React.FC<{
  items: BacktestCompareItem[];
  data: Map<number, BacktestDrawdownSeriesResponse>;
  loading: boolean;
  errors: Record<number, string>;
}> = ({ items, data, loading, errors }) => {
  const seriesList = useMemo(
    () =>
      items
        .map(it => {
          const r = data.get(it.task_id);
          return r
            ? {
                taskId: it.task_id,
                series: r.series.map(p => ({ ...p, drawdown_pct: -Math.abs(p.drawdown_pct) })),
              }
            : null;
        })
        .filter((x): x is { taskId: number; series: any[] } => x !== null),
    [items, data]
  );
  const merged = useMemo(
    () => mergeSeriesByDate(seriesList, (p: any) => Number(p.drawdown_pct ?? 0)),
    [seriesList]
  );

  const errorAlerts = items
    .filter(it => errors[it.task_id]?.includes('回撤'))
    .map(it => ({
      task_id: it.task_id,
      task_name: it.task_name,
      message: errors[it.task_id]!,
    }));

  if (loading && merged.length === 0) {
    return (
      <Card title="回撤曲线对比（%，往下越深）">
        <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
          <Spin tip="加载回撤序列…" />
        </div>
      </Card>
    );
  }
  if (merged.length === 0) {
    return (
      <Card title="回撤曲线对比（%，往下越深）">
        {errorAlerts.length > 0 && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message="部分任务回撤数据加载失败"
            description={errorAlerts
              .map(e => `#${e.task_id} ${e.task_name}: ${e.message}`)
              .join('；')}
          />
        )}
        <Empty description="所选回测都没有回撤数据" />
      </Card>
    );
  }
  return (
    <Card title="回撤曲线对比（%，往下越深 — 冠军策略）">
      {errorAlerts.length > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="部分任务回撤数据加载失败"
          description={errorAlerts
            .map(e => `#${e.task_id} ${e.task_name}: ${e.message}`)
            .join('；')}
        />
      )}
      <div style={{ width: '100%', height: 320 }}>
        <ResponsiveContainer>
          <AreaChart data={merged}>
            <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
            <XAxis dataKey="date" tick={{ fontSize: 12 }} minTickGap={30} />
            <YAxis tickFormatter={v => `${v}%`} tick={{ fontSize: 12 }} domain={['auto', 0]} />
            <RechartsTooltip formatter={(value: any) => [`${Number(value).toFixed(2)}%`, '回撤']} />
            <ReferenceLine y={0} stroke="#999" />
            <Legend />
            {items.map((item, idx) => {
              if (!data.has(item.task_id)) return null;
              return (
                <Area
                  key={item.task_id}
                  type="monotone"
                  dataKey={`task_${item.task_id}`}
                  name={`${item.task_name}${
                    item.best_strategy_name ? ' · ' + item.best_strategy_name : ''
                  }`}
                  stroke={COMPARE_COLORS[idx % COMPARE_COLORS.length]}
                  fill={COMPARE_COLORS[idx % COMPARE_COLORS.length]}
                  fillOpacity={0.18}
                  strokeWidth={2}
                  isAnimationActive={false}
                  connectNulls
                />
              );
            })}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
};

const CompareRollingSharpeCard: React.FC<{
  items: BacktestCompareItem[];
  data: Map<number, BacktestRollingSharpeResponse>;
  loading: boolean;
  errors: Record<number, string>;
}> = ({ items, data, loading, errors }) => {
  const windowDays = useMemo(() => {
    for (const it of items) {
      const r = data.get(it.task_id);
      if (r) return r.window_days;
    }
    return 90;
  }, [items, data]);

  const seriesList = useMemo(
    () =>
      items
        .map(it => {
          const r = data.get(it.task_id);
          return r ? { taskId: it.task_id, series: r.series } : null;
        })
        .filter((x): x is { taskId: number; series: any[] } => x !== null),
    [items, data]
  );
  const merged = useMemo(
    () =>
      mergeSeriesByDate(seriesList, (p: any) =>
        p.sharpe === null || p.sharpe === undefined ? null : Number(p.sharpe)
      ),
    [seriesList]
  );

  const errorAlerts = items
    .filter(it => errors[it.task_id]?.includes('夏普'))
    .map(it => ({
      task_id: it.task_id,
      task_name: it.task_name,
      message: errors[it.task_id]!,
    }));

  if (loading && merged.length === 0) {
    return (
      <Card title={`滚动夏普曲线（${windowDays} 日窗口）`}>
        <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
          <Spin tip="加载滚动夏普序列…" />
        </div>
      </Card>
    );
  }
  if (merged.length === 0) {
    return (
      <Card title={`滚动夏普曲线（${windowDays} 日窗口）`}>
        {errorAlerts.length > 0 && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message="部分任务滚动夏普数据加载失败"
            description={errorAlerts
              .map(e => `#${e.task_id} ${e.task_name}: ${e.message}`)
              .join('；')}
          />
        )}
        <Empty description="所选回测都没有滚动夏普数据" />
      </Card>
    );
  }
  return (
    <Card
      title={`滚动夏普曲线（${windowDays} 日窗口 — 冠军策略，越高越稳）`}
      extra={
        <Tooltip title="窗口不足的日期不显示（Recharts connectNulls 跳过）。年化系数 sqrt(252)。">
          <Tag color="blue">window={windowDays}</Tag>
        </Tooltip>
      }
    >
      {errorAlerts.length > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="部分任务滚动夏普数据加载失败"
          description={errorAlerts
            .map(e => `#${e.task_id} ${e.task_name}: ${e.message}`)
            .join('；')}
        />
      )}
      <div style={{ width: '100%', height: 320 }}>
        <ResponsiveContainer>
          <LineChart data={merged}>
            <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
            <XAxis dataKey="date" tick={{ fontSize: 12 }} minTickGap={30} />
            <YAxis tick={{ fontSize: 12 }} />
            <RechartsTooltip
              formatter={(value: any) =>
                value === null || value === undefined
                  ? ['—', '滚动夏普']
                  : [Number(value).toFixed(2), '滚动夏普']
              }
            />
            <ReferenceLine y={0} stroke="#999" />
            <Legend />
            {items.map((item, idx) => {
              if (!data.has(item.task_id)) return null;
              return (
                <Line
                  key={item.task_id}
                  type="monotone"
                  dataKey={`task_${item.task_id}`}
                  name={`${item.task_name}${
                    item.best_strategy_name ? ' · ' + item.best_strategy_name : ''
                  }`}
                  stroke={COMPARE_COLORS[idx % COMPARE_COLORS.length]}
                  strokeWidth={2}
                  dot={false}
                  connectNulls
                  isAnimationActive={false}
                />
              );
            })}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
};

const CompareMonthlyReturnsCard: React.FC<{
  items: BacktestCompareItem[];
  data: Map<number, BacktestMonthlyReturnsResponse>;
  loading: boolean;
  errors: Record<number, string>;
}> = ({ items, data, loading, errors }) => {
  const errorAlerts = items
    .filter(it => errors[it.task_id]?.includes('月度'))
    .map(it => ({
      task_id: it.task_id,
      task_name: it.task_name,
      message: errors[it.task_id]!,
    }));

  if (loading && data.size === 0) {
    return (
      <Card title="月度收益热力图（每策略一张）">
        <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
          <Spin tip="加载月度收益矩阵…" />
        </div>
      </Card>
    );
  }
  const rendered = items.filter(it => data.has(it.task_id));
  if (rendered.length === 0) {
    return (
      <Card title="月度收益热力图（每策略一张）">
        {errorAlerts.length > 0 && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message="部分任务月度收益数据加载失败"
            description={errorAlerts
              .map(e => `#${e.task_id} ${e.task_name}: ${e.message}`)
              .join('；')}
          />
        )}
        <Empty description="所选回测都没有月度收益数据" />
      </Card>
    );
  }
  return (
    <Card title="月度收益热力图（每策略一张 — 红涨绿跌，A 股语义）">
      {errorAlerts.length > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="部分任务月度收益数据加载失败"
          description={errorAlerts
            .map(e => `#${e.task_id} ${e.task_name}: ${e.message}`)
            .join('；')}
        />
      )}
      <Row gutter={[16, 16]}>
        {rendered.map((item, idx) => {
          const r = data.get(item.task_id)!;
          return (
            <Col xs={24} md={rendered.length === 1 ? 24 : 12} key={item.task_id}>
              <Card
                size="small"
                type="inner"
                title={
                  <Space size={6}>
                    <Tag color={COMPARE_COLORS[idx % COMPARE_COLORS.length]}>#{item.task_id}</Tag>
                    <Text strong style={{ fontSize: 12 }}>
                      {item.task_name}
                    </Text>
                    {item.best_strategy_name && (
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        · {item.best_strategy_name}
                      </Text>
                    )}
                  </Space>
                }
              >
                <MonthlyHeatmap response={r} />
              </Card>
            </Col>
          );
        })}
      </Row>
    </Card>
  );
};

const MonthlyHeatmap: React.FC<{ response: BacktestMonthlyReturnsResponse }> = ({ response }) => {
  const { years, cells } = response;
  const months =
    response.months && response.months.length
      ? response.months
      : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

  const option = useMemo(() => {
    if (!cells.length || !years.length) return null;
    // echarts heatmap data: [xIdx, yIdx, value]
    // xIdx = month index in `months`; yIdx = year index in `years`
    // 找极值用于 visualMap 对称范围
    let absMax = 0;
    cells.forEach(c => {
      const v = Math.abs(Number(c.return_pct));
      if (Number.isFinite(v) && v > absMax) absMax = v;
    });
    const symMax = Math.max(2, absMax);
    const monthLabels = months.map(m => `${m}月`);
    const yearLabels = years.map(y => String(y));
    const monthIdx = new Map(months.map((m, i) => [m, i]));
    const yearIdx = new Map(years.map((y, i) => [y, i]));
    const seriesData = cells
      .map(c => {
        const xi = monthIdx.get(c.month);
        const yi = yearIdx.get(c.year);
        if (xi === undefined || yi === undefined) return null;
        return [xi, yi, Number(c.return_pct.toFixed(2))];
      })
      .filter(Boolean) as Array<[number, number, number]>;

    return {
      tooltip: {
        position: 'top',
        formatter: (params: any) => {
          const [xi, yi, v] = params.data || [];
          const m = months[xi];
          const y = years[yi];
          if (m === undefined || y === undefined) return '';
          const color = v >= 0 ? '#dc2626' : '#0f8f6b';
          return `<b>${y}年${m}月</b><br/><span style="color:${color}">${v >= 0 ? '+' : ''}${Number(
            v
          ).toFixed(2)}%</span>`;
        },
      },
      grid: { left: 60, right: 24, top: 16, bottom: 56 },
      xAxis: {
        type: 'category',
        data: monthLabels,
        splitArea: { show: true },
        axisLabel: { fontSize: 12 },
      },
      yAxis: {
        type: 'category',
        data: yearLabels,
        splitArea: { show: true },
        axisLabel: { fontSize: 12 },
      },
      visualMap: {
        min: -symMax,
        max: symMax,
        calculable: true,
        orient: 'horizontal',
        left: 'center',
        bottom: 4,
        itemWidth: 14,
        itemHeight: 110,
        textStyle: { fontSize: 12 },
        // A 股语义：red = up（赚钱）, green = down（亏钱）
        inRange: {
          color: [
            '#1a9850',
            '#66bd63',
            '#a6d96a',
            '#d9ef8b',
            '#ffffff',
            '#fee08b',
            '#fdae61',
            '#f46d43',
            '#d73027',
          ],
        },
      },
      series: [
        {
          name: '月度收益',
          type: 'heatmap',
          data: seriesData,
          label: {
            show: true,
            fontSize: 12,
            formatter: (p: any) =>
              p.data?.[2] !== undefined ? `${Number(p.data[2]).toFixed(1)}%` : '',
          },
          emphasis: { itemStyle: { shadowBlur: 6, shadowColor: 'rgba(0,0,0,0.4)' } },
        },
      ],
    };
  }, [cells, years, months]);

  if (!option) {
    return <Empty description="无月度收益数据" />;
  }
  const height = Math.max(180, years.length * 36 + 100);
  return (
    <ReactECharts
      option={option}
      style={{ width: '100%', height }}
      notMerge
      opts={{ renderer: 'canvas' }}
    />
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
          <Text type="secondary" style={{ fontSize: 12 }}>
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
              <Text type="secondary" style={{ fontSize: 12 }}>
                / 超额 {fmtPct(cell.excess_return_pct)}
              </Text>
            </Space>
            <Text type="secondary" style={{ fontSize: 12 }}>
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
        <Table size="small" pagination={false} columns={taskColumns} dataSource={taskSummaryRows} />
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

function pickFiniteNumber(value: unknown, fallback: number) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

function percentTag(value?: number | null) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return <Text type="secondary">—</Text>;
  }
  const v = Number(value);
  return (
    <Text strong style={{ color: v >= 0 ? '#dc2626' : '#0f8f6b' }}>
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

function artifactStatusColor(status?: string) {
  const s = String(status || '').toLowerCase();
  if (s === 'pass') return 'green';
  if (s === 'watch') return 'gold';
  if (s === 'reject' || s === 'error') return 'red';
  if (s === 'insufficient' || s === 'pending') return 'orange';
  return 'default';
}

function artifactStatusLabel(status?: string) {
  const labels: Record<string, string> = {
    pass: '通过',
    watch: '需谨慎',
    reject: '阻断',
    insufficient: '数据不足',
    pending: '待生成',
    error: '失败',
  };
  return labels[String(status || '').toLowerCase()] || status || '待生成';
}

function artifactStatusTag(status?: string) {
  return <Tag color={artifactStatusColor(status)}>{artifactStatusLabel(status)}</Tag>;
}

function researchVerdictTag(verdict?: string | null) {
  return artifactStatusTag(verdict || 'pending');
}

// ============================================================
// Phase 7+: OptimizationRunsTab - 统一 GridSearch / Bayesian / Walk-Forward dashboard
// ============================================================

const OptimizationRunsTab: React.FC = () => {
  const [runs, setRuns] = useState<OptimizationRunSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [optimizerType, setOptimizerType] = useState<
    'all' | 'grid_search' | 'bayesian' | 'walk_forward'
  >('all');
  const [strategyFilter, setStrategyFilter] = useState<string>('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await labService.listOptimizationRuns({
        optimizer_type: optimizerType,
        strategy_name: strategyFilter || undefined,
        limit: 100,
      });
      setRuns(data);
    } catch (err: any) {
      setError(err?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [optimizerType, strategyFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const typeMeta: Record<string, { color: string; label: string }> = {
    grid_search: { color: 'blue', label: 'Grid Search' },
    bayesian: { color: 'blue', label: 'Bayesian' },
    walk_forward: { color: 'red', label: 'Walk-Forward' },
  };

  const verdictMeta: Record<string, { color: string; label: string }> = {
    PASS: { color: 'green', label: '✅ PASS' },
    FAIL: { color: 'red', label: '❌ FAIL' },
    INSUFFICIENT: { color: 'orange', label: '⚠ INSUFFICIENT' },
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        size="small"
        title={
          <Space>
            <NodeIndexOutlined />
            <Text strong>优化历史统一视图</Text>
            <Tag color="blue">Phase 7+</Tag>
          </Space>
        }
        extra={
          <Space size={8}>
            <span style={{ fontSize: 12 }}>类型:</span>
            <Select
              size="small"
              value={optimizerType}
              onChange={v => setOptimizerType(v)}
              style={{ width: 140 }}
              options={[
                { value: 'all', label: '全部' },
                { value: 'grid_search', label: 'Grid Search' },
                { value: 'bayesian', label: 'Bayesian' },
                { value: 'walk_forward', label: 'Walk-Forward' },
              ]}
            />
            <span style={{ fontSize: 12 }}>策略:</span>
            <Input
              size="small"
              value={strategyFilter}
              onChange={e => setStrategyFilter(e.target.value)}
              placeholder="留空 = 全部"
              style={{ width: 160 }}
              allowClear
            />
            <Button size="small" icon={<ReloadOutlined />} onClick={load} loading={loading}>
              刷新
            </Button>
          </Space>
        }
      >
        {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="三种 optimizer 统一视图"
          description={
            <Space direction="vertical" size={2}>
              <Text style={{ fontSize: 12 }}>
                • <Text code>Grid Search</Text>：穷举参数网格找最优 in-sample 表现
              </Text>
              <Text style={{ fontSize: 12 }}>
                • <Text code>Bayesian</Text>：GP + EI 高效搜索连续参数空间
              </Text>
              <Text style={{ fontSize: 12 }}>
                • <Text code>Walk-Forward</Text>：滚动 train→test 验证 + DSR/PBO
                过拟合检测，最严格的真实样本外检验
              </Text>
            </Space>
          }
        />
        <Table
          size="small"
          dataSource={runs}
          rowKey="id"
          loading={loading}
          pagination={{ pageSize: 20 }}
          scroll={{ x: 1100 }}
          columns={[
            {
              title: '类型',
              dataIndex: 'optimizer_type',
              width: 110,
              render: (v: string) => {
                const meta = typeMeta[v] || { color: 'default', label: v };
                return <Tag color={meta.color}>{meta.label}</Tag>;
              },
            },
            { title: '策略', dataIndex: 'strategy_name', width: 180, ellipsis: true },
            {
              title: '状态',
              dataIndex: 'status',
              width: 90,
              render: (s: string) => <Tag color={statusColor(s)}>{statusLabel(s)}</Tag>,
            },
            {
              title: '总组合',
              dataIndex: 'total_combos',
              width: 80,
              render: (v: number) => v ?? '—',
            },
            {
              title: '完成 / 失败',
              key: 'progress',
              width: 100,
              render: (_: any, r: OptimizationRunSummary) => (
                <span style={{ fontSize: 12 }}>
                  {r.completed_combos}
                  <Text type={r.failed_combos > 0 ? 'danger' : 'secondary'}>
                    {' '}
                    / {r.failed_combos}
                  </Text>
                </span>
              ),
            },
            // WF-only 列：verdict / mean_test_sharpe / DSR / PBO
            {
              title: 'verdict',
              key: 'verdict',
              width: 110,
              render: (_: any, r: OptimizationRunSummary) => {
                const v = r.summary?.verdict;
                if (!v) return '—';
                const meta = verdictMeta[v] || { color: 'default', label: v };
                return <Tag color={meta.color}>{meta.label}</Tag>;
              },
            },
            {
              title: 'mean test sharpe',
              key: 'mean_sharpe',
              width: 130,
              render: (_: any, r: OptimizationRunSummary) => {
                const v = r.summary?.mean_test_sharpe;
                if (v === undefined || v === null) return '—';
                return (
                  <Text style={{ color: v > 0 ? '#16a34a' : v < 0 ? '#dc2626' : '#888' }}>
                    {Number(v).toFixed(3)}
                  </Text>
                );
              },
            },
            {
              title: 'DSR',
              key: 'dsr',
              width: 80,
              render: (_: any, r: OptimizationRunSummary) => {
                const v = r.summary?.dsr;
                return v === undefined || v === null ? '—' : Number(v).toFixed(3);
              },
            },
            {
              title: 'PBO',
              key: 'pbo',
              width: 80,
              render: (_: any, r: OptimizationRunSummary) => {
                const v = r.summary?.pbo;
                if (v === undefined || v === null) return '—';
                // PBO > 0.5 表示过拟合可能性高
                return (
                  <Text style={{ color: v > 0.5 ? '#dc2626' : '#888' }}>
                    {Number(v).toFixed(3)}
                  </Text>
                );
              },
            },
            {
              // Sprint 44-C: GridSearch / Bayesian 的 DSR (Deflated Sharpe Ratio)
              // 显示 P(observed > expected_max | H0). DSR > 0.95 = 95% 置信度真有 alpha.
              title: 'DSR',
              key: 'dsr',
              width: 80,
              render: (_: any, r: OptimizationRunSummary) => {
                const v = r.metadata_json?.deflated_sharpe?.deflated_sharpe;
                if (v === undefined || v === null) return '—';
                const sig = r.metadata_json?.deflated_sharpe?.is_significant;
                return (
                  <Tooltip title={r.metadata_json?.deflated_sharpe?.explanation || ''}>
                    <Text
                      style={{ color: sig ? '#16a34a' : '#dc2626', fontWeight: sig ? 600 : 400 }}
                    >
                      {Number(v).toFixed(3)}
                      {sig ? ' ✓' : ' ✗'}
                    </Text>
                  </Tooltip>
                );
              },
            },
            {
              title: '创建时间',
              dataIndex: 'created_at',
              width: 140,
              render: (v: string) =>
                v ? <span style={{ fontSize: 12 }}>{dayjs(v).format('MM-DD HH:mm')}</span> : '—',
            },
            {
              title: '耗时',
              key: 'duration',
              width: 80,
              render: (_: any, r: OptimizationRunSummary) => {
                if (!r.started_at || !r.finished_at) return '—';
                const s = dayjs(r.finished_at).diff(dayjs(r.started_at), 'second');
                if (s < 60) return `${s}s`;
                if (s < 3600) return `${Math.round(s / 60)}m`;
                return `${(s / 3600).toFixed(1)}h`;
              },
            },
          ]}
          expandable={{
            expandedRowRender: (r: OptimizationRunSummary) => (
              <Space direction="vertical" size={4} style={{ width: '100%' }}>
                <div style={{ fontSize: 12 }}>
                  <Text strong>backtest_config:</Text>
                  <pre
                    style={{
                      background: '#f8fafc',
                      padding: 8,
                      borderRadius: 8,
                      fontSize: 12,
                      maxHeight: 200,
                      overflow: 'auto',
                    }}
                  >
                    {JSON.stringify(r.backtest_config_json || {}, null, 2)}
                  </pre>
                </div>
                {r.summary && (
                  <div style={{ fontSize: 12 }}>
                    <Text strong>walk-forward summary:</Text>
                    <pre
                      style={{
                        background: '#f8fafc',
                        padding: 8,
                        borderRadius: 8,
                        fontSize: 12,
                        maxHeight: 200,
                        overflow: 'auto',
                      }}
                    >
                      {JSON.stringify(r.summary, null, 2)}
                    </pre>
                  </div>
                )}
                <div style={{ fontSize: 12 }}>
                  <Text strong>param 空间:</Text>
                  <pre
                    style={{
                      background: '#f8fafc',
                      padding: 8,
                      borderRadius: 8,
                      fontSize: 12,
                      maxHeight: 200,
                      overflow: 'auto',
                    }}
                  >
                    {JSON.stringify(r.param_grid_json || {}, null, 2)}
                  </pre>
                </div>
              </Space>
            ),
          }}
          locale={{
            emptyText: (
              <Empty description="暂无 optimization run。在 Walk-Forward 或 CLI 触发后会出现。" />
            ),
          }}
        />
      </Card>
    </Space>
  );
};

export default LabWorkspace;
