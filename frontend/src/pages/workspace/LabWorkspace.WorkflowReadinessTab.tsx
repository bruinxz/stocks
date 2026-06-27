/**
 * LabWorkspace.WorkflowReadinessTab — phase 1-3 quant workflow readiness UI.
 *
 * This tab turns the backend self-assessment scorer into an operator-facing checklist:
 * simple preset → research credibility → paper-trading acceptance.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Form,
  Input,
  InputNumber,
  List,
  Progress,
  Row,
  Select,
  Space,
  Spin,
  Statistic,
  Switch,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  ExperimentOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import {
  labService,
  BacktestTask,
  QuantStrategyItem,
  QuantWorkflowPreset,
  QuantWorkflowReadiness,
  QuantWorkflowReadinessInput,
  QuantWorkflowStage,
  QuantWorkflowStatus,
} from '../../services/labService';

const { Text, Paragraph } = Typography;

interface WorkflowReadinessTabProps {
  strategies: QuantStrategyItem[];
  tasks: BacktestTask[];
}

const STATUS_META: Record<
  QuantWorkflowStatus,
  {
    label: string;
    color: string;
    progress: 'success' | 'normal' | 'exception';
    icon: React.ReactNode;
  }
> = {
  ready: {
    label: '通过',
    color: 'green',
    progress: 'success',
    icon: <CheckCircleOutlined />,
  },
  degraded: {
    label: '需复核',
    color: 'default',
    progress: 'normal',
    icon: <WarningOutlined />,
  },
  blocked: {
    label: '阻断',
    color: 'red',
    progress: 'exception',
    icon: <CloseCircleOutlined />,
  },
};

const DEFAULT_PRESET_KEY = 'steady_momentum_basic';

const WorkflowReadinessTab: React.FC<WorkflowReadinessTabProps> = ({ strategies, tasks }) => {
  const [form] = Form.useForm();
  const [presets, setPresets] = useState<QuantWorkflowPreset[]>([]);
  const [selectedPresetKey, setSelectedPresetKey] = useState(DEFAULT_PRESET_KEY);
  const [readiness, setReadiness] = useState<QuantWorkflowReadiness | null>(null);
  const [loading, setLoading] = useState(false);
  const [evaluating, setEvaluating] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const completedTasks = useMemo(
    () => tasks.filter(task => String(task.status || '').toUpperCase() === 'COMPLETED'),
    [tasks]
  );
  const latestCompletedTask = useMemo(
    () =>
      [...completedTasks].sort(
        (a, b) =>
          dayjs(b.updated_at || b.created_at).valueOf() -
          dayjs(a.updated_at || a.created_at).valueOf()
      )[0],
    [completedTasks]
  );

  const selectedPreset = useMemo(
    () =>
      presets.find(preset => preset.preset_key === selectedPresetKey) ||
      presets.find(preset => preset.preset_key === DEFAULT_PRESET_KEY) ||
      presets[0],
    [presets, selectedPresetKey]
  );

  const selectedStrategy = useMemo(
    () => strategies.find(strategy => strategy.strategy_key === selectedPreset?.strategy_key),
    [strategies, selectedPreset]
  );

  const runEvaluation = useCallback(
    async (overrideValues?: Record<string, any>, overridePreset?: QuantWorkflowPreset) => {
      const preset = overridePreset || selectedPreset;
      if (!preset) return;
      const values = overrideValues || form.getFieldsValue(true);
      setEvaluating(true);
      try {
        const payload = buildWorkflowPayload(values, preset);
        const data = await labService.evaluateWorkflowReadiness(payload);
        setReadiness(data);
      } catch (err: any) {
        message.error(err?.message || '工作流体检失败');
      } finally {
        setEvaluating(false);
      }
    },
    [form, selectedPreset]
  );

  const loadPresets = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await labService.listWorkflowPresets();
      setPresets(data);
      const first = data.find(preset => preset.preset_key === selectedPresetKey) || data[0];
      if (first) {
        setSelectedPresetKey(first.preset_key);
        const values = buildStarterValues(first);
        form.setFieldsValue(values);
        await runEvaluation(values, first);
      }
    } catch (err: any) {
      setLoadError(err?.message || '加载工作流预设失败');
    } finally {
      setLoading(false);
    }
  }, [form, runEvaluation, selectedPresetKey]);

  useEffect(() => {
    void loadPresets();
    // only on mount; selectedPresetKey changes are handled by onPresetChange
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onPresetChange = useCallback(
    async (presetKey: string) => {
      const preset = presets.find(item => item.preset_key === presetKey);
      if (!preset) return;
      setSelectedPresetKey(presetKey);
      const values = buildStarterValues(preset);
      form.setFieldsValue(values);
      await runEvaluation(values, preset);
    },
    [form, presets, runEvaluation]
  );

  const applyLatestBacktest = useCallback(() => {
    if (!selectedPreset) return;
    if (!latestCompletedTask) {
      message.info('还没有已完成回测，先在“新建回测”里跑一组结果。');
      return;
    }
    const values = {
      ...form.getFieldsValue(true),
      ...buildBacktestValuesFromTask(latestCompletedTask),
    };
    form.setFieldsValue(values);
    void runEvaluation(values, selectedPreset);
  }, [form, latestCompletedTask, runEvaluation, selectedPreset]);

  const applyPassingExample = useCallback(() => {
    if (!selectedPreset) return;
    const values = buildPassingExampleValues(selectedPreset);
    form.setFieldsValue(values);
    void runEvaluation(values, selectedPreset);
  }, [form, runEvaluation, selectedPreset]);

  if (loading && presets.length === 0) {
    return (
      <Card className="modern-card">
        <div style={{ display: 'flex', justifyContent: 'center', padding: 64 }}>
          <Spin tip="加载工作流体检配置..." />
        </div>
      </Card>
    );
  }

  if (loadError) {
    return (
      <Alert
        type="error"
        showIcon
        message="工作流体检加载失败"
        description={loadError}
        action={
          <Button size="small" icon={<ReloadOutlined />} onClick={loadPresets}>
            重试
          </Button>
        }
      />
    );
  }

  if (!selectedPreset) {
    return (
      <Card className="modern-card">
        <Empty description="后端还没有返回工作流预设" />
      </Card>
    );
  }

  const verdict = readiness?.verdict;
  const statusMeta = STATUS_META[verdict?.status || 'blocked'];

  return (
    <Space
      direction="vertical"
      size={16}
      style={{ width: '100%' }}
      data-testid="workflow-readiness-tab"
    >
      <Alert
        type={
          verdict?.status === 'ready'
            ? 'success'
            : verdict?.status === 'degraded'
              ? 'warning'
              : 'info'
        }
        showIcon
        message="阶段 1-3 量化工作流体检"
        description="这是自评表单：不会自动拉取数据库、启动回测或解锁真实 canary；结论只用于提示下一步人工操作。"
      />

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={9}>
          <Card
            className="modern-card workflow-preset-card"
            title={
              <Space>
                <ExperimentOutlined />
                策略预设
              </Space>
            }
            extra={
              <Tag color={riskColor(selectedPreset.risk_level)}>
                {riskLabel(selectedPreset.risk_level)}
              </Tag>
            }
          >
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <Select
                value={selectedPresetKey}
                style={{ width: '100%' }}
                data-testid="workflow-readiness-preset-select"
                onChange={onPresetChange}
                options={presets.map(preset => ({
                  value: preset.preset_key,
                  label: `${preset.display_name} · ${preset.strategy_key}`,
                }))}
              />
              <div>
                <Text type="secondary">当前策略</Text>
                <Paragraph style={{ marginBottom: 0 }}>
                  <Text strong>{selectedPreset.display_name}</Text>
                  <br />
                  <Text code>{selectedPreset.strategy_key}</Text>
                </Paragraph>
              </div>
              <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                {selectedPreset.description}
              </Paragraph>
              <Space size={6} wrap>
                {selectedPreset.data_requirements.required_features.map(feature => (
                  <Tag key={feature}>{feature}</Tag>
                ))}
              </Space>
              <Row gutter={[8, 8]}>
                <Col span={8}>
                  <Statistic
                    title="默认仓位"
                    value={selectedPreset.paper_trading_defaults.default_position_pct}
                    suffix="%"
                  />
                </Col>
                <Col span={8}>
                  <Statistic
                    title="最多持仓"
                    value={selectedPreset.paper_trading_defaults.max_positions}
                    suffix="只"
                  />
                </Col>
                <Col span={8}>
                  <Statistic
                    title="样本要求"
                    value={selectedPreset.paper_trading_defaults.min_completed_trades}
                    suffix="笔"
                  />
                </Col>
              </Row>
              {selectedStrategy ? (
                <Alert
                  type="success"
                  showIcon
                  message="已匹配系统策略"
                  description={selectedStrategy.name || selectedStrategy.strategy_key}
                />
              ) : (
                <Alert
                  type="warning"
                  showIcon
                  message="策略库暂未匹配"
                  description="预设可以先用于理解流程；正式运行前需要确认策略已在后端注册。"
                />
              )}
            </Space>
          </Card>
        </Col>
        <Col xs={24} xl={15}>
          <Card
            className={`modern-card workflow-verdict-card status-${verdict?.status || 'blocked'}`}
            title={
              <Space>
                <SafetyCertificateOutlined />
                当前结论
              </Space>
            }
            extra={<Tag color={statusMeta.color}>{statusMeta.label}</Tag>}
          >
            <Row gutter={[16, 16]} align="middle">
              <Col xs={24} md={8}>
                <Progress
                  type="dashboard"
                  percent={Math.round(((verdict?.current_stage || 0) / 3) * 100)}
                  status={statusMeta.progress}
                  format={() => `阶段 ${verdict?.current_stage || 0}/3`}
                />
              </Col>
              <Col xs={24} md={16}>
                <Space direction="vertical" size={10} style={{ width: '100%' }}>
                  <Text strong style={{ fontSize: 18 }}>
                    {verdict?.status_label || '等待体检'}
                  </Text>
                  <Paragraph style={{ marginBottom: 0 }}>
                    {verdict?.conclusion || '填写体检输入后运行评估。'}
                  </Paragraph>
                  <Space size={8} wrap>
                    <GateTag ok={Boolean(verdict?.can_start_backtest)} label="可启动回测" />
                    <GateTag
                      ok={Boolean(verdict?.can_start_paper_trading)}
                      label="可进入纸面交易"
                    />
                    <GateTag
                      ok={Boolean(verdict?.can_promote_paper_to_canary)}
                      label="可进入小仓观察"
                    />
                  </Space>
                </Space>
              </Col>
            </Row>
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        {(readiness?.stages || []).map(stage => (
          <Col xs={24} lg={8} key={stage.stage_key}>
            <StageCard stage={stage} />
          </Col>
        ))}
      </Row>

      <Card
        className="modern-card workflow-input-card"
        title="体检输入"
        extra={
          <Space wrap>
            <Tooltip title="用最近一次已完成回测的冠军指标填入回测区块">
              <Button onClick={applyLatestBacktest}>从最近回测填充</Button>
            </Tooltip>
            <Button onClick={applyPassingExample}>填入示例值</Button>
            <Button
              type="primary"
              icon={<ReloadOutlined />}
              loading={evaluating}
              data-testid="workflow-readiness-refresh"
              onClick={() => void runEvaluation()}
            >
              运行体检
            </Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical">
          <Row gutter={[16, 8]}>
            <SectionTitle title="数据准备" description="阶段 1：决定能不能启动一个可信回测。" />
            <Col xs={24} md={8}>
              <Form.Item label="K 线覆盖率 (%)" name="daily_bar_coverage_pct">
                <InputNumber min={0} max={100} precision={1} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item label="因子覆盖率 (%)" name="factor_coverage_pct">
                <InputNumber min={0} max={100} precision={1} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item label="最新交易日" name="latest_trade_date">
                <Input placeholder="YYYY-MM-DD" />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item label="过期股票数量" name="stale_symbol_count">
                <InputNumber min={0} precision={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={16}>
              <Space size={24} wrap className="workflow-switch-row">
                <Form.Item label="点时数据" name="point_in_time_ready" valuePropName="checked">
                  <Switch checkedChildren="是" unCheckedChildren="否" />
                </Form.Item>
                <Form.Item
                  label="复权处理"
                  name="corporate_action_adjusted"
                  valuePropName="checked"
                >
                  <Switch checkedChildren="是" unCheckedChildren="否" />
                </Form.Item>
                <Form.Item label="基准可用" name="benchmark_ready" valuePropName="checked">
                  <Switch checkedChildren="是" unCheckedChildren="否" />
                </Form.Item>
              </Space>
            </Col>

            <SectionTitle title="研究可信度" description="阶段 2：决定策略能不能进入纸面交易。" />
            <Col xs={24} md={12}>
              <Form.Item label="Alpha 假设" name="thesis">
                <Input.TextArea rows={3} />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item label="目标股票池" name="target_universe">
                <Input.TextArea rows={3} />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item label="预期持有天数" name="expected_holding_days">
                <InputNumber min={0} precision={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item label="回测交易日" name="backtest_trading_days">
                <InputNumber min={0} precision={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item label="回测成交数" name="backtest_trade_count">
                <InputNumber min={0} precision={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item label="失效规则" name="invalidation_rule">
                <Input.TextArea rows={2} />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item label="风险边界" name="risk_notes">
                <Input.TextArea rows={2} />
              </Form.Item>
            </Col>
            <Col xs={24} md={6}>
              <Form.Item label="夏普" name="sharpe_ratio">
                <InputNumber step={0.1} precision={2} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={6}>
              <Form.Item label="最大回撤 (%)" name="backtest_max_drawdown_pct">
                <InputNumber min={0} max={100} precision={1} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={6}>
              <Form.Item label="超额收益 (%)" name="benchmark_excess_return_pct">
                <InputNumber precision={1} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={6}>
              <Form.Item label="过拟合风险分" name="overfit_score">
                <InputNumber min={0} max={1} step={0.05} precision={2} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item label="Walk-forward 结论" name="walk_forward_verdict">
                <Select
                  options={[
                    { value: 'pass', label: 'pass' },
                    { value: 'warn', label: 'warn' },
                    { value: 'fail', label: 'fail' },
                  ]}
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item label="样本外切分" name="validation_split" valuePropName="checked">
                <Switch checkedChildren="已开" unCheckedChildren="未开" />
              </Form.Item>
            </Col>

            <SectionTitle title="纸面交易验收" description="阶段 3：决定能不能进入小仓观察。" />
            <Col xs={24} md={6}>
              <Form.Item label="纸面观察天数" name="paper_trading_days">
                <InputNumber min={0} precision={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={6}>
              <Form.Item label="纸面完成交易" name="paper_completed_trades">
                <InputNumber min={0} precision={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={6}>
              <Form.Item label="纸面胜率" name="paper_win_rate">
                <InputNumber min={0} max={1} step={0.01} precision={2} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={6}>
              <Form.Item label="纸面盈亏比" name="paper_profit_loss_ratio">
                <InputNumber min={0} step={0.1} precision={2} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={6}>
              <Form.Item label="纸面最大回撤 (%)" name="paper_max_drawdown_pct">
                <InputNumber min={0} max={100} precision={1} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={6}>
              <Form.Item label="平均滑点 (bps)" name="average_slippage_bps">
                <InputNumber min={0} precision={1} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={6}>
              <Form.Item label="回测/纸面相关性" name="backtest_to_paper_correlation">
                <InputNumber min={-1} max={1} step={0.01} precision={2} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={6}>
              <Form.Item label="风控硬违规" name="risk_guard_breaches">
                <InputNumber min={0} precision={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={6}>
              <Form.Item label="人工覆盖次数" name="manual_override_count">
                <InputNumber min={0} precision={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Card>
    </Space>
  );
};

const SectionTitle: React.FC<{ title: string; description: string }> = ({ title, description }) => (
  <Col span={24}>
    <div className="workflow-input-section-title">
      <Text strong>{title}</Text>
      <Text type="secondary">{description}</Text>
    </div>
  </Col>
);

const StageCard: React.FC<{ stage: QuantWorkflowStage }> = ({ stage }) => {
  const meta = STATUS_META[stage.status];
  const failedChecks = stage.checks.filter(check => check.status !== 'ready');
  return (
    <Card
      className={`modern-card workflow-stage-card status-${stage.status}`}
      title={
        <Space>
          {meta.icon}
          {stage.title}
        </Space>
      }
      extra={<Tag color={meta.color}>{meta.label}</Tag>}
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Progress percent={stage.score} status={meta.progress} />
        <Space size={8} wrap>
          {stage.checks.map(check => (
            <Tooltip key={check.key} title={`${check.label}: ${check.message}`}>
              <Tag color={STATUS_META[check.status].color}>{check.label}</Tag>
            </Tooltip>
          ))}
        </Space>
        <div className="workflow-next-actions">
          <Text strong>下一步</Text>
          {stage.next_actions.length > 0 ? (
            <List
              size="small"
              dataSource={stage.next_actions}
              renderItem={item => <List.Item>{item}</List.Item>}
            />
          ) : (
            <Text type="secondary">本阶段暂无阻断项。</Text>
          )}
        </div>
        {failedChecks.length > 0 ? (
          <Text type="secondary" style={{ fontSize: 12 }}>
            未通过检查 {failedChecks.length} 项；必填项会阻断阶段晋级。
          </Text>
        ) : null}
      </Space>
    </Card>
  );
};

const GateTag: React.FC<{ ok: boolean; label: string }> = ({ ok, label }) => (
  <Tag
    color={ok ? 'green' : 'default'}
    icon={ok ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
  >
    {label}
  </Tag>
);

function buildStarterValues(preset: QuantWorkflowPreset): Record<string, any> {
  return {
    daily_bar_coverage_pct: 0,
    factor_coverage_pct: 0,
    latest_trade_date: '',
    stale_symbol_count: 0,
    point_in_time_ready: false,
    corporate_action_adjusted: false,
    benchmark_ready: false,
    thesis: '',
    target_universe: '',
    expected_holding_days: 0,
    invalidation_rule: '',
    risk_notes: '',
    backtest_trading_days: 0,
    backtest_trade_count: 0,
    sharpe_ratio: 0,
    backtest_max_drawdown_pct: 0,
    benchmark_excess_return_pct: 0,
    validation_split: preset.backtest_defaults.validation_split,
    walk_forward_verdict: 'fail',
    overfit_score: 1,
    paper_trading_days: 0,
    paper_completed_trades: 0,
    paper_win_rate: 0,
    paper_profit_loss_ratio: 0,
    paper_max_drawdown_pct: 0,
    average_slippage_bps: 0,
    backtest_to_paper_correlation: 0,
    risk_guard_breaches: 0,
    manual_override_count: 0,
  };
}

function buildPassingExampleValues(preset: QuantWorkflowPreset): Record<string, any> {
  return {
    daily_bar_coverage_pct: Math.max(98, preset.data_requirements.min_daily_bar_coverage_pct),
    factor_coverage_pct: Math.max(94, preset.data_requirements.min_factor_coverage_pct),
    latest_trade_date: dayjs().format('YYYY-MM-DD'),
    stale_symbol_count: 0,
    point_in_time_ready: true,
    corporate_action_adjusted: true,
    benchmark_ready: true,
    thesis: '中期相对强度领先且未过热的股票，在流动性充足时更容易延续趋势。',
    target_universe: 'A 股流动性充足的中大盘股票，排除 ST、停牌和连续涨停标的。',
    expected_holding_days: 15,
    invalidation_rule: '相对强度跌破市场中位数或波动放大时退出观察。',
    risk_notes: '限制单票仓位，避开异常成交和高滑点环境。',
    backtest_trading_days: 252,
    backtest_trade_count: 42,
    sharpe_ratio: 1.25,
    backtest_max_drawdown_pct: 11,
    benchmark_excess_return_pct: 8,
    validation_split: true,
    walk_forward_verdict: 'pass',
    overfit_score: 0.22,
    paper_trading_days: Math.max(35, preset.paper_trading_defaults.min_paper_trading_days),
    paper_completed_trades: Math.max(36, preset.paper_trading_defaults.min_completed_trades),
    paper_win_rate: 0.58,
    paper_profit_loss_ratio: 1.45,
    paper_max_drawdown_pct: 5,
    average_slippage_bps: 12,
    backtest_to_paper_correlation: 0.51,
    risk_guard_breaches: 0,
    manual_override_count: 1,
  };
}

function buildBacktestValuesFromTask(task: BacktestTask): Record<string, any> {
  const summary = task.run_summary || {};
  const tradingDays =
    task.start_date && task.end_date
      ? Math.max(0, dayjs(task.end_date).diff(dayjs(task.start_date), 'day'))
      : 0;
  return {
    backtest_trading_days: tradingDays,
    backtest_trade_count: summary.best_trade_count || 0,
    sharpe_ratio: summary.best_sharpe_ratio || 0,
    backtest_max_drawdown_pct: summary.best_max_drawdown_pct || 0,
    benchmark_excess_return_pct: summary.best_excess_return_pct || 0,
    validation_split: true,
  };
}

function buildWorkflowPayload(
  values: Record<string, any>,
  preset: QuantWorkflowPreset
): QuantWorkflowReadinessInput {
  return {
    strategy: {
      preset_key: preset.preset_key,
      strategy_key: preset.strategy_key,
      edge_hypothesis: {
        thesis: values.thesis,
        target_universe: values.target_universe,
        expected_holding_days: Number(values.expected_holding_days || 0),
        invalidation_rule: values.invalidation_rule,
        risk_notes: values.risk_notes,
      },
    },
    data: {
      daily_bar_coverage_pct: Number(values.daily_bar_coverage_pct || 0),
      factor_coverage_pct: Number(values.factor_coverage_pct || 0),
      latest_trade_date: values.latest_trade_date,
      stale_symbol_count: Number(values.stale_symbol_count || 0),
      point_in_time_ready: Boolean(values.point_in_time_ready),
      corporate_action_adjusted: Boolean(values.corporate_action_adjusted),
      benchmark_ready: Boolean(values.benchmark_ready),
    },
    backtest: {
      trading_days: Number(values.backtest_trading_days || 0),
      trade_count: Number(values.backtest_trade_count || 0),
      sharpe_ratio: Number(values.sharpe_ratio || 0),
      max_drawdown_pct: Number(values.backtest_max_drawdown_pct || 0),
      benchmark_excess_return_pct: Number(values.benchmark_excess_return_pct || 0),
      validation_split: Boolean(values.validation_split),
      walk_forward_verdict: values.walk_forward_verdict || 'fail',
      overfit_score: Number(values.overfit_score || 1),
    },
    paper: {
      trading_days: Number(values.paper_trading_days || 0),
      completed_trades: Number(values.paper_completed_trades || 0),
      win_rate: Number(values.paper_win_rate || 0),
      profit_loss_ratio: Number(values.paper_profit_loss_ratio || 0),
      max_drawdown_pct: Number(values.paper_max_drawdown_pct || 0),
      average_slippage_bps: Number(values.average_slippage_bps || 0),
      backtest_to_paper_correlation: Number(values.backtest_to_paper_correlation || 0),
      risk_guard_breaches: Number(values.risk_guard_breaches || 0),
      manual_override_count: Number(values.manual_override_count || 0),
    },
  };
}

function riskColor(level: string): string {
  if (level === 'low') return 'green';
  if (level === 'high') return 'red';
  return 'gold';
}

function riskLabel(level: string): string {
  if (level === 'low') return '低风险';
  if (level === 'high') return '高风险';
  return '中风险';
}

export default WorkflowReadinessTab;
