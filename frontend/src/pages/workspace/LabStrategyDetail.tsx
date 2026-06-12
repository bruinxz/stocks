import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  message,
  Modal,
  Row,
  Select,
  Space,
  Spin,
  Statistic,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  ArrowLeftOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  CodeOutlined,
  CopyOutlined,
  EditOutlined,
  ExperimentOutlined,
  FileTextOutlined,
  LinkOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  RightOutlined,
  SaveOutlined,
} from '@ant-design/icons';
import { Link, useNavigate, useParams } from 'react-router-dom';
import dayjs from 'dayjs';
import WorkspaceLayout from '../../components/layout/WorkspaceLayout';
import MonacoSourceViewer from '../../components/monaco/MonacoSourceViewer';
import {
  labService,
  StrategyDetailBacktest,
  StrategyDetailResponse,
  StrategySourceResponse,
  EdgeHypothesisPayload,
} from '../../services/labService';

const { Text, Paragraph } = Typography;

/**
 * 策略详情页（US-078）— 路由 `/workspace/lab/strategies/:id`。
 *
 * 嵌套在 LabWorkspace 概念之下（复用 WorkspaceLayout chrome / 左侧仍高亮"策略实验室"），
 * 但作为独立 Route 渲染，省去 LabWorkspace 三 tab 切换的负担。
 *
 * 数据来源：单次 GET /api/quant/strategies/:id/detail 拉 4 段聚合数据。
 *
 * 3 个动作按钮都走 navigate + state 把用户带回 LabWorkspace 复用现有 form/drawer，
 * 避免本页重写 Drawer/Form 两份实现：
 *  - 克隆策略     → /workspace/lab + state.intent='clone'   → LabWorkspace 装载后调 handleClone(strategy)
 *  - 编辑参数     → /workspace/lab + state.intent='edit'    → LabWorkspace 装载后 openEditingStrategy(strategy)
 *  - 启动新回测   → /workspace/lab + state.intent='newRun'  → LabWorkspace 装载后切到 'new' tab + 预填 default_params
 */
const LabStrategyDetail: React.FC = () => {
  const params = useParams<{ id: string }>();
  const strategyKey = decodeURIComponent(params.id || '');
  const navigate = useNavigate();
  const [detail, setDetail] = useState<StrategyDetailResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // US-093: 顶层 tab —— 'detail' 复用 US-078 4 卡片；'source' 是 Monaco 只读源码视图。
  // 默认 'detail' 不预拉源码（节省 ~1.5MB monaco chunk 直到用户主动点击 tab）。
  const [activeTab, setActiveTab] = useState<'detail' | 'source'>('detail');
  // 源码 3 态缓存（与 US-074 lazy-load tab 数据范式一致：data 已得 / 正在拉 / 已错过 都 short-circuit）。
  const [source, setSource] = useState<StrategySourceResponse | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!strategyKey) return;
    setLoading(true);
    setLoadError(null);
    try {
      const data = await labService.getStrategyDetail(strategyKey);
      setDetail(data);
    } catch (err: unknown) {
      const messageStr = err instanceof Error ? err.message : String(err);
      setLoadError(messageStr);
    } finally {
      setLoading(false);
    }
  }, [strategyKey]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // US-093: 源码加载 — 切换 strategy 或首次进入 'source' tab 时按需 fire。
  // 3 态短路：已得到 / 正在拉 / 已错过都不重复 fetch；强刷靠 reloadSource。
  const reloadSource = useCallback(async () => {
    if (!strategyKey) return;
    setSourceLoading(true);
    setSourceError(null);
    try {
      const data = await labService.getStrategySource(strategyKey);
      setSource(data);
    } catch (err: unknown) {
      const messageStr = err instanceof Error ? err.message : String(err);
      setSourceError(messageStr);
    } finally {
      setSourceLoading(false);
    }
  }, [strategyKey]);

  useEffect(() => {
    // 切换 strategy 时清空源码缓存，下次进 'source' tab 才重新 fetch。
    setSource(null);
    setSourceError(null);
    setSourceLoading(false);
  }, [strategyKey]);

  useEffect(() => {
    if (activeTab !== 'source') return;
    if (source || sourceLoading || sourceError) return;
    void reloadSource();
  }, [activeTab, source, sourceLoading, sourceError, reloadSource]);

  const handleBackToLab = useCallback(() => navigate('/workspace/lab'), [navigate]);

  const handleClone = useCallback(
    () =>
      navigate('/workspace/lab', {
        state: { seedStrategyKey: strategyKey, intent: 'clone' },
      }),
    [navigate, strategyKey]
  );

  const handleEdit = useCallback(
    () =>
      navigate('/workspace/lab', {
        state: { seedStrategyKey: strategyKey, intent: 'edit' },
      }),
    [navigate, strategyKey]
  );

  const handleNewRun = useCallback(
    () =>
      navigate('/workspace/lab', {
        state: { seedStrategyKey: strategyKey, intent: 'newRun' },
      }),
    [navigate, strategyKey]
  );

  // ---- KPI strip ----
  const championCount = useMemo(
    () =>
      (detail?.backtests || []).filter(
        bt => bt.strategy_metrics.present && bt.strategy_metrics.is_champion
      ).length,
    [detail]
  );
  const totalBacktests = detail?.backtests?.length || 0;
  const icIr = detail?.latest_ic?.ic_ir;

  const kpiSlot = (
    <Space size={32}>
      <Statistic title="历史回测" value={totalBacktests} suffix="次" />
      <Statistic title="夺冠次数" value={championCount} suffix="次" />
      <Statistic
        title="最新 IC_IR"
        value={icIr === null || icIr === undefined ? '—' : Number(icIr).toFixed(2)}
      />
    </Space>
  );

  const headerActions = (
    <>
      <Button icon={<ArrowLeftOutlined />} onClick={handleBackToLab}>
        返回
      </Button>
      <Button icon={<ReloadOutlined />} onClick={refresh} loading={loading}>
        刷新
      </Button>
      <Button icon={<CopyOutlined />} onClick={handleClone} disabled={!detail}>
        克隆策略
      </Button>
      <Button icon={<EditOutlined />} onClick={handleEdit} disabled={!detail}>
        编辑参数
      </Button>
      <Button
        type="primary"
        icon={<PlayCircleOutlined />}
        onClick={handleNewRun}
        disabled={!detail}
      >
        启动新回测
      </Button>
    </>
  );

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
  } else if (loading && !detail) {
    body = (
      <Card>
        <div style={{ display: 'flex', justifyContent: 'center', padding: 64 }}>
          <Spin tip="加载策略详情…" />
        </div>
      </Card>
    );
  } else if (!detail) {
    body = (
      <Card>
        <Empty description="未找到策略" />
      </Card>
    );
  } else {
    // US-093: Tabs 切换 — '详情' 复用既有 4 卡片；'代码视图' 内嵌 Monaco 只读编辑器。
    // 默认 'detail'，'source' 是 lazy-load（用户首次点击才加载源码 + monaco chunk）。
    const detailPane = (
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <StrategyMetaCard detail={detail} onUpdated={refresh} />
        <LiveBindingCard detail={detail} />
        <BacktestListCard backtests={detail.backtests} />
        <LatestICCard detail={detail} />
      </Space>
    );

    const sourcePane = (
      <StrategySourceTab
        loading={sourceLoading}
        error={sourceError}
        source={source}
        onReload={reloadSource}
      />
    );

    body = (
      <Tabs
        activeKey={activeTab}
        onChange={key => setActiveTab(key as 'detail' | 'source')}
        items={[
          {
            key: 'detail',
            label: (
              <Space size={6}>
                <FileTextOutlined />
                详情
              </Space>
            ),
            children: detailPane,
          },
          {
            key: 'source',
            label: (
              <Space size={6}>
                <CodeOutlined />
                代码视图
              </Space>
            ),
            children: sourcePane,
          },
        ]}
      />
    );
  }

  return (
    <WorkspaceLayout
      title={detail?.strategy?.name || strategyKey || '策略详情'}
      subtitle={
        <Space size={6}>
          <Text type="secondary">策略 key：</Text>
          <Text code copyable>
            {strategyKey}
          </Text>
        </Space>
      }
      kpiSlot={kpiSlot}
      headerActions={headerActions}
    >
      {body}
    </WorkspaceLayout>
  );
};

// ============================================================================
// 子卡片
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
  mean_reversion: { label: '均值回归', color: 'purple' },
  other: { label: '其他', color: 'default' },
};

const STRATEGY_RISK_DISPLAY: Record<string, { label: string; color: string }> = {
  low: { label: '低风险', color: 'green' },
  medium: { label: '中风险', color: 'gold' },
  high: { label: '高风险', color: 'red' },
};

const StrategyMetaCard: React.FC<{
  detail: StrategyDetailResponse;
  onUpdated?: () => void | Promise<void>;
}> = ({ detail, onUpdated }) => {
  const { strategy } = detail;
  const category =
    STRATEGY_CATEGORY_DISPLAY[strategy.category || 'other'] ?? STRATEGY_CATEGORY_DISPLAY.other;
  const risk = STRATEGY_RISK_DISPLAY[strategy.risk_level || 'medium'];
  const defaultParams = strategy.default_params || {};
  const executionPolicy = strategy.execution_policy || {};
  // US-083: dry-run 标志存储在 lifecycle_policy.dry_run（JSONB 子字段）。
  // 后端 PaperTradingFacade.applyAutomation 会读取此字段，dry-run=true 时该策略的信号
  // 只写 QuantSignal 表，不实际下单。前端用 antd Switch 让用户开/关，loading 期间禁用
  // 避免多次点击触发竞态；toggle 成功后通过 onUpdated 回调刷新整页保证 UI 与后端一致。
  const dryRun = strategy.lifecycle_policy?.dry_run === true;
  const [toggling, setToggling] = useState(false);

  const handleToggleDryRun = useCallback(
    (next: boolean) => {
      const verb = next ? '开启' : '关闭';
      Modal.confirm({
        title: `确认${verb} dry-run 模式？`,
        content: next
          ? '开启后，本策略产生的信号将写入信号表但不会真实下单。适合先观察一段时间再决定是否启用真实跟单。'
          : '关闭后，本策略产生的信号将恢复正常自动跟单流程（PaperTradingFacade.applyAutomation 会调 placeOrder 真实下单）。',
        okText: `${verb} dry-run`,
        okButtonProps: { type: 'primary', danger: !next },
        cancelText: '取消',
        onOk: async () => {
          setToggling(true);
          try {
            await labService.setStrategyDryRun(strategy.strategy_key, next);
            message.success(`已${verb} dry-run 模式：${strategy.name || strategy.strategy_key}`);
            if (onUpdated) {
              await onUpdated();
            }
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            message.error(`${verb} dry-run 失败：${msg}`);
          } finally {
            setToggling(false);
          }
        },
      });
    },
    [strategy.strategy_key, strategy.name, onUpdated]
  );

  return (
    <Card
      title="策略描述与默认参数"
      extra={
        <Space size={12}>
          <Tooltip
            title={
              dryRun
                ? '当前为 dry-run 模式：信号只写入 QuantSignal 表，不调用 placeOrder 真实下单。'
                : '当前为实盘模式：策略信号会触发真实自动跟单。'
            }
          >
            <Space size={6}>
              <ExperimentOutlined style={{ color: dryRun ? '#fa8c16' : '#999' }} />
              <Text type={dryRun ? 'warning' : 'secondary'} strong={dryRun}>
                dry-run
              </Text>
              <Switch
                checked={dryRun}
                loading={toggling}
                onChange={handleToggleDryRun}
                checkedChildren="开"
                unCheckedChildren="关"
              />
            </Space>
          </Tooltip>
        </Space>
      }
    >
      {dryRun ? (
        <Alert
          type="warning"
          showIcon
          message="dry-run 模式已开启"
          description="本策略产生的信号会照常写入信号表，但 PaperTradingFacade 不会触发 placeOrder 真实下单。可先观察策略表现一段时间，再决定是否关闭 dry-run 启用真实跟单。"
          style={{ marginBottom: 12 }}
        />
      ) : null}
      <Descriptions column={2} size="small" bordered>
        <Descriptions.Item label="分类">
          <Tag color={category.color}>{category.label}</Tag>
        </Descriptions.Item>
        <Descriptions.Item label="风险等级">
          {risk ? <Tag color={risk.color}>{risk.label}</Tag> : <Text type="secondary">—</Text>}
        </Descriptions.Item>
        <Descriptions.Item label="状态">
          {strategy.enabled === false ? (
            <Tag color="default">停用</Tag>
          ) : (
            <Tag color="green" icon={<CheckCircleOutlined />}>
              启用
            </Tag>
          )}
        </Descriptions.Item>
        <Descriptions.Item label="标签">
          {Array.isArray(strategy.tags) && strategy.tags.length > 0 ? (
            strategy.tags.map(tag => <Tag key={tag}>{tag}</Tag>)
          ) : (
            <Text type="secondary">—</Text>
          )}
        </Descriptions.Item>
        <Descriptions.Item label="描述" span={2}>
          <Paragraph style={{ marginBottom: 0 }}>{strategy.description || '—'}</Paragraph>
        </Descriptions.Item>
      </Descriptions>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} md={12}>
          <Card type="inner" size="small" title="默认参数（default_params）">
            <pre
              style={{
                background: '#fafafa',
                border: '1px solid #f0f0f0',
                borderRadius: 4,
                padding: 12,
                maxHeight: 240,
                overflow: 'auto',
                fontSize: 12,
                margin: 0,
              }}
            >
              {Object.keys(defaultParams).length
                ? JSON.stringify(defaultParams, null, 2)
                : '（无默认参数）'}
            </pre>
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card type="inner" size="small" title="执行策略（execution_policy）">
            <pre
              style={{
                background: '#fafafa',
                border: '1px solid #f0f0f0',
                borderRadius: 4,
                padding: 12,
                maxHeight: 240,
                overflow: 'auto',
                fontSize: 12,
                margin: 0,
              }}
            >
              {Object.keys(executionPolicy).length
                ? JSON.stringify(executionPolicy, null, 2)
                : '（无执行策略）'}
            </pre>
          </Card>
        </Col>
      </Row>

      {/* Phase 4: Edge Hypothesis 卡片 */}
      <EdgeHypothesisCard
        strategyKey={strategy.strategy_key}
        hypothesis={strategy.edge_hypothesis}
        onUpdated={onUpdated}
      />
    </Card>
  );
};

/**
 * Phase 4: 策略 edge_hypothesis 编辑 Drawer
 * 用户/Lab 可在线编辑 thesis / category / expected_edge / kill_switch_metric / failure_modes
 * 等字段，PATCH /api/quant/strategies/:id 保存。
 *
 * **必填字段** (Phase 4 promotion 门禁):
 *   - thesis (≥10 字符)
 *   - category
 *   - kill_switch_metric
 * 否则会被 PromotionGate 拦截 promote 成 champion。
 */
const EdgeHypothesisEditor: React.FC<{
  open: boolean;
  strategyKey: string;
  initial?: Record<string, any>;
  onClose: () => void;
  onSaved?: () => void | Promise<void>;
}> = ({ open, strategyKey, initial, onClose, onSaved }) => {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      const hypo = initial || {};
      form.setFieldsValue({
        thesis: hypo.thesis || '',
        category: hypo.category || undefined,
        expected_edge_pct: typeof hypo.expected_edge_pct === 'number' ? hypo.expected_edge_pct : null,
        expected_holding_days:
          typeof hypo.expected_holding_days === 'number' ? hypo.expected_holding_days : null,
        key_factors: Array.isArray(hypo.key_factors) ? hypo.key_factors : [],
        failure_modes: Array.isArray(hypo.failure_modes) ? hypo.failure_modes : [],
        kill_switch_metric: hypo.kill_switch_metric || '',
        kill_switch_threshold:
          typeof hypo.kill_switch_threshold === 'number' ? hypo.kill_switch_threshold : null,
        evidence_link: hypo.evidence_link || '',
      });
    }
  }, [open, initial, form]);

  const onSubmit = useCallback(async () => {
    const values = await form.validateFields().catch(() => null);
    if (!values) return;
    setSaving(true);
    try {
      const payload: EdgeHypothesisPayload = {
        thesis: String(values.thesis || '').trim(),
        category: values.category || undefined,
        expected_edge_pct:
          values.expected_edge_pct === null || values.expected_edge_pct === undefined
            ? undefined
            : Number(values.expected_edge_pct),
        expected_holding_days:
          values.expected_holding_days === null || values.expected_holding_days === undefined
            ? undefined
            : Number(values.expected_holding_days),
        key_factors: Array.isArray(values.key_factors) ? values.key_factors : [],
        failure_modes: Array.isArray(values.failure_modes) ? values.failure_modes : [],
        kill_switch_metric: String(values.kill_switch_metric || '').trim() || undefined,
        kill_switch_threshold:
          values.kill_switch_threshold === null || values.kill_switch_threshold === undefined
            ? undefined
            : Number(values.kill_switch_threshold),
        evidence_link: String(values.evidence_link || '').trim() || undefined,
      };
      await labService.setStrategyEdgeHypothesis(strategyKey, payload);
      message.success('Edge Hypothesis 已保存');
      onClose();
      if (onSaved) await onSaved();
    } catch (err: any) {
      message.error(err?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  }, [form, strategyKey, onClose, onSaved]);

  return (
    <Drawer
      title={
        <Space>
          <EditOutlined />
          <Text strong>编辑 Edge Hypothesis</Text>
          <Tag color="processing">Phase 4</Tag>
        </Space>
      }
      placement="right"
      width={560}
      open={open}
      onClose={onClose}
      destroyOnClose
      extra={
        <Space>
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={onSubmit}>
            保存
          </Button>
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="Phase 4 promotion 门禁"
        description="必填字段：thesis (≥10 字符) / category / kill_switch_metric。未填齐这 3 项的策略将被 PromotionGate 拦截，无法 promote 成 champion。"
      />
      <Form form={form} layout="vertical">
        <Form.Item
          name="thesis"
          label="假设 (thesis) ★ 必填"
          rules={[
            { required: true, message: '必须填写假设' },
            { min: 10, message: '至少 10 个字符（promotion 门禁要求）' },
          ]}
          tooltip="一句话描述这个策略为什么能赚钱。要可证伪，不要写'本策略稳定盈利'。"
        >
          <Input.TextArea
            rows={3}
            placeholder="e.g. 持有 ROE > 15% 且 PEG < 1 的 GARP 股票，能在 3-6 个月跑赢沪深 300（来源：Fama-French quality factor）"
            maxLength={500}
            showCount
          />
        </Form.Item>

        <Row gutter={12}>
          <Col span={12}>
            <Form.Item
              name="category"
              label="类别 ★ 必填"
              rules={[{ required: true, message: '必须选择类别' }]}
            >
              <Select
                placeholder="选择策略类别"
                options={[
                  { value: 'momentum', label: 'momentum (动量)' },
                  { value: 'mean_reversion', label: 'mean_reversion (均值回归)' },
                  { value: 'value', label: 'value (价值)' },
                  { value: 'growth', label: 'growth (成长)' },
                  { value: 'quality', label: 'quality (质量)' },
                  { value: 'structural', label: 'structural (结构性, e.g. 多因子)' },
                  { value: 'event_driven', label: 'event_driven (事件驱动)' },
                  { value: 'macro', label: 'macro (宏观)' },
                  { value: 'sentiment', label: 'sentiment (情绪)' },
                  { value: 'other', label: 'other (其他)' },
                ]}
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              name="kill_switch_metric"
              label="熔断指标 ★ 必填"
              rules={[{ required: true, message: '必须填写熔断指标' }]}
              tooltip="哪个指标低于阈值就停掉这个策略（e.g. sharpe_30d, win_rate, monthly_return）"
            >
              <Input placeholder="e.g. sharpe_30d / win_rate_60d" />
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={12}>
          <Col span={12}>
            <Form.Item
              name="expected_edge_pct"
              label="预期年化 alpha (%)"
              tooltip="超额收益的预期值（相对基准）。带正负号"
            >
              <InputNumber min={-50} max={50} step={0.5} style={{ width: '100%' }} placeholder="3.5" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              name="expected_holding_days"
              label="预期持仓天数"
              tooltip="平均持仓周期。短线 1-5 / 中线 20-90 / 长线 180+"
            >
              <InputNumber min={1} max={1000} style={{ width: '100%' }} placeholder="30" />
            </Form.Item>
          </Col>
        </Row>

        <Form.Item
          name="kill_switch_threshold"
          label="熔断阈值"
          tooltip="kill_switch_metric 的数值阈值，低于此值触发停用"
        >
          <InputNumber step={0.1} style={{ width: '100%' }} placeholder="0.5 (e.g. sharpe<0.5 停用)" />
        </Form.Item>

        <Form.Item
          name="key_factors"
          label="关键因子"
          tooltip="本策略依赖的核心因子（e.g. roe, peg, volume_ratio）"
        >
          <Select
            mode="tags"
            placeholder="按 Enter 添加，e.g. roe, peg, momentum_20d"
            tokenSeparators={[',', '，']}
            style={{ width: '100%' }}
          />
        </Form.Item>

        <Form.Item
          name="failure_modes"
          label="已知失效场景"
          tooltip="哪些市场状态下本策略会跑输（e.g. 熊市/小盘股回撤期）"
        >
          <Select
            mode="tags"
            placeholder="按 Enter 添加，e.g. 熊市初期, 流动性枯竭, 板块单边下跌"
            tokenSeparators={[',', '，']}
            style={{ width: '100%' }}
          />
        </Form.Item>

        <Form.Item
          name="evidence_link"
          label="学术引用 / 实证链接 (evidence_link)"
          tooltip="支撑本假设的论文 / 研究报告 URL，便于审核"
        >
          <Input placeholder="https://... 或论文标题" />
        </Form.Item>
      </Form>
    </Drawer>
  );
};

/**
 * Phase 4: 策略 edge_hypothesis 展示卡片
 * 显示 thesis / category / expected_edge / kill_switch_metric / failure_modes 等
 * 让用户一眼看清这个策略的"alpha 假设"
 * 右上角有"编辑"按钮，打开 EdgeHypothesisEditor Drawer
 */
const EdgeHypothesisCard: React.FC<{
  strategyKey: string;
  hypothesis?: Record<string, any>;
  onUpdated?: () => void | Promise<void>;
}> = ({ strategyKey, hypothesis, onUpdated }) => {
  const [editorOpen, setEditorOpen] = useState(false);
  const hypo = hypothesis || {};
  const hasContent = hypo && typeof hypo === 'object' && Object.keys(hypo).length > 0;
  if (!hasContent) {
    return (
      <>
        <Alert
          style={{ marginTop: 16 }}
          type="warning"
          showIcon
          message="缺少 Edge Hypothesis"
          description={
            <Space direction="vertical" size={8}>
              <Text>
                本策略尚未填写可证伪的 alpha 假设。Phase 4 promotion 门禁要求所有策略必须填写
                edge_hypothesis.thesis (≥10 字符) 才能 promote 成 champion。
              </Text>
              <Button type="primary" icon={<EditOutlined />} onClick={() => setEditorOpen(true)}>
                立即填写
              </Button>
            </Space>
          }
        />
        <EdgeHypothesisEditor
          open={editorOpen}
          strategyKey={strategyKey}
          initial={hypo}
          onClose={() => setEditorOpen(false)}
          onSaved={onUpdated}
        />
      </>
    );
  }
  const thesis = String(hypo.thesis || '').trim();
  const category = hypo.category || null;
  const expectedEdge = typeof hypo.expected_edge_pct === 'number' ? hypo.expected_edge_pct : null;
  const expectedHolding = typeof hypo.expected_holding_days === 'number' ? hypo.expected_holding_days : null;
  const keyFactors = Array.isArray(hypo.key_factors) ? hypo.key_factors : [];
  const failureModes = Array.isArray(hypo.failure_modes) ? hypo.failure_modes : [];
  const killMetric = hypo.kill_switch_metric || null;
  const killThreshold = typeof hypo.kill_switch_threshold === 'number' ? hypo.kill_switch_threshold : null;
  const evidence = hypo.evidence_link || null;

  return (
    <>
      <Card
        type="inner"
        size="small"
        style={{ marginTop: 16 }}
        title={
          <Space>
            <Text strong>Edge Hypothesis (alpha 假设)</Text>
            <Tag color="processing">Phase 4</Tag>
          </Space>
        }
        extra={
          <Button size="small" icon={<EditOutlined />} onClick={() => setEditorOpen(true)}>
            编辑
          </Button>
        }
      >
      {thesis && (
        <Paragraph style={{ marginBottom: 12, fontSize: 14, lineHeight: 1.6 }}>
          <Text type="secondary">假设：</Text>
          <Text strong>{thesis}</Text>
        </Paragraph>
      )}
      <Row gutter={[16, 8]}>
        {category && (
          <Col xs={12} md={6}>
            <Text type="secondary">类别：</Text>
            <Tag color="blue">{category}</Tag>
          </Col>
        )}
        {expectedEdge !== null && (
          <Col xs={12} md={6}>
            <Text type="secondary">预期年化 alpha：</Text>
            <Text strong style={{ color: expectedEdge > 0 ? '#3f8600' : '#cf1322' }}>
              {expectedEdge.toFixed(1)}%
            </Text>
          </Col>
        )}
        {expectedHolding !== null && (
          <Col xs={12} md={6}>
            <Text type="secondary">预期持仓：</Text>
            <Text strong>{expectedHolding} 天</Text>
          </Col>
        )}
        {killMetric && (
          <Col xs={12} md={6}>
            <Text type="secondary">熔断指标：</Text>
            <Tag color="red">
              {killMetric} {killThreshold !== null ? `< ${killThreshold}` : ''}
            </Tag>
          </Col>
        )}
      </Row>
      {keyFactors.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <Text type="secondary">关键因子：</Text>
          <Space size={[4, 4]} wrap>
            {keyFactors.map((f: string) => (
              <Tag key={f}>{f}</Tag>
            ))}
          </Space>
        </div>
      )}
      {failureModes.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <Text type="secondary">已知失效场景：</Text>
          <ul style={{ marginBottom: 0, paddingLeft: 20, color: '#666' }}>
            {failureModes.map((m: string, i: number) => (
              <li key={i} style={{ fontSize: 13 }}>{m}</li>
            ))}
          </ul>
        </div>
      )}
      {evidence && (
        <div style={{ marginTop: 8 }}>
          <Text type="secondary">学术引用：</Text>
          <Text code>{evidence}</Text>
        </div>
      )}
      </Card>
      <EdgeHypothesisEditor
        open={editorOpen}
        strategyKey={strategyKey}
        initial={hypo}
        onClose={() => setEditorOpen(false)}
        onSaved={onUpdated}
      />
    </>
  );
};

const LiveBindingCard: React.FC<{ detail: StrategyDetailResponse }> = ({ detail }) => {
  const { live_binding } = detail;
  const bound = live_binding.enabled && live_binding.recent_signal_count > 0;
  return (
    <Card title="实盘绑定状态">
      <Row gutter={24}>
        <Col xs={24} md={8}>
          <Statistic
            title="启用状态"
            value={live_binding.enabled ? '已启用' : '已停用'}
            valueStyle={{ color: live_binding.enabled ? '#0f8f6b' : '#999' }}
          />
        </Col>
        <Col xs={24} md={8}>
          <Statistic
            title="近 7 日信号数"
            value={live_binding.recent_signal_count}
            suffix="条"
            valueStyle={{ color: bound ? '#cf1322' : undefined }}
          />
        </Col>
        <Col xs={24} md={8}>
          <Statistic
            title="最近一次信号"
            value={
              live_binding.last_signal_date
                ? dayjs(live_binding.last_signal_date).format('YYYY-MM-DD')
                : '—'
            }
          />
        </Col>
      </Row>
      <div style={{ marginTop: 16 }}>
        {bound ? (
          <Tag color="red" icon={<CheckCircleOutlined />}>
            实盘运行中 — 该策略近 7 个交易日均有信号生成
          </Tag>
        ) : live_binding.enabled ? (
          <Tag color="gold" icon={<CloseCircleOutlined />}>
            策略启用但近 7 日无信号 — 可能处于事件驱动 / 月度调仓的等待期
          </Tag>
        ) : (
          <Tag color="default">策略已停用 — 不会参与每日信号生成</Tag>
        )}
      </div>
    </Card>
  );
};

const BacktestListCard: React.FC<{ backtests: StrategyDetailBacktest[] }> = ({ backtests }) => {
  if (backtests.length === 0) {
    return (
      <Card title="近 10 次历史回测">
        <Empty description={'还没有该策略的回测 — 点右上角"启动新回测"去跑一个'} />
      </Card>
    );
  }
  const columns = [
    {
      title: '任务',
      dataIndex: 'task_name',
      key: 'task_name',
      render: (text: string, row: StrategyDetailBacktest) => (
        <Space direction="vertical" size={0}>
          <Link to={`/legacy/backtest/${row.id}`}>
            <Text strong>{text}</Text>
          </Link>
          <Text type="secondary" style={{ fontSize: 11 }}>
            #{row.id} · 创建 {dayjs(row.created_at).format('MM-DD HH:mm')}
          </Text>
        </Space>
      ),
    },
    {
      title: '时间段',
      key: 'range',
      width: 220,
      render: (_: any, row: StrategyDetailBacktest) => (
        <Text style={{ fontSize: 12 }}>
          {compactDate(row.start_date)} ~ {compactDate(row.end_date)}
        </Text>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 90,
      render: (s: string) => <Tag color={statusColor(s)}>{statusLabel(s)}</Tag>,
    },
    {
      title: '本策略收益',
      key: 'my_return',
      width: 130,
      render: (_: any, row: StrategyDetailBacktest) => {
        if (!row.strategy_metrics.present) {
          return <Text type="secondary">—</Text>;
        }
        return (
          <Space size={4}>
            {percentTag(row.strategy_metrics.total_return_pct)}
            {row.strategy_metrics.is_champion && (
              <Tooltip title="该策略在此回测中夺冠">
                <Tag color="gold" style={{ marginInlineEnd: 0 }}>
                  冠
                </Tag>
              </Tooltip>
            )}
          </Space>
        );
      },
    },
    {
      title: '年化',
      key: 'annual',
      width: 100,
      render: (_: any, row: StrategyDetailBacktest) =>
        row.strategy_metrics.present ? (
          percentTag(row.strategy_metrics.annual_return_pct)
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
    {
      title: '夏普',
      key: 'sharpe',
      width: 80,
      render: (_: any, row: StrategyDetailBacktest) =>
        row.strategy_metrics.present ? (
          <Text>{Number(row.strategy_metrics.sharpe_ratio).toFixed(2)}</Text>
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
    {
      title: '最大回撤',
      key: 'drawdown',
      width: 110,
      render: (_: any, row: StrategyDetailBacktest) =>
        row.strategy_metrics.present ? (
          percentTag(row.strategy_metrics.max_drawdown_pct)
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
    {
      title: '交易笔数',
      key: 'trades',
      width: 90,
      render: (_: any, row: StrategyDetailBacktest) =>
        row.strategy_metrics.present ? (
          <Text>{row.strategy_metrics.trade_count}</Text>
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
  ];
  return (
    <Card title={`近 10 次历史回测（${backtests.length} 条）`}>
      <Table<StrategyDetailBacktest>
        size="small"
        rowKey="id"
        pagination={false}
        columns={columns}
        dataSource={backtests}
      />
    </Card>
  );
};

const LatestICCard: React.FC<{ detail: StrategyDetailResponse }> = ({ detail }) => {
  const navigate = useNavigate();
  const { latest_ic } = detail;
  if (!latest_ic) {
    return (
      <Card
        title="最新 IC 报告"
        extra={
          <Tooltip title="跳到因子工作区查看完整 IC 报告">
            <Button
              size="small"
              icon={<RightOutlined />}
              onClick={() => navigate('/workspace/factors')}
            >
              查看因子工作区
            </Button>
          </Tooltip>
        }
      >
        <Empty
          description={
            <>
              该策略尚无 IC 报告 — IC 报告需要因子名（factor_name）与策略 key 一致才能匹配
              <br />
              <Text type="secondary" style={{ fontSize: 12 }}>
                如果该策略是组合级（如 MultiFactorAlpha），IC 评估通常作用于其底层因子而非策略本身。
              </Text>
            </>
          }
        />
      </Card>
    );
  }
  return (
    <Card
      title={
        <Space>
          最新 IC 报告
          <Tag color="cyan">{latest_ic.look_forward_days} 日窗口</Tag>
        </Space>
      }
      extra={
        <Button size="small" icon={<LinkOutlined />} onClick={() => navigate('/workspace/factors')}>
          完整 IC 报告
        </Button>
      }
    >
      <Row gutter={[24, 16]}>
        <Col xs={12} md={6}>
          <Statistic
            title="IC 均值"
            value={latest_ic.ic_mean === null ? '—' : Number(latest_ic.ic_mean).toFixed(4)}
            valueStyle={{
              color:
                latest_ic.ic_mean !== null && Number(latest_ic.ic_mean) > 0 ? '#cf1322' : '#0f8f6b',
            }}
          />
        </Col>
        <Col xs={12} md={6}>
          <Statistic
            title="IC_IR"
            value={latest_ic.ic_ir === null ? '—' : Number(latest_ic.ic_ir).toFixed(2)}
            valueStyle={{
              color:
                latest_ic.ic_ir !== null && Number(latest_ic.ic_ir) >= 0.5 ? '#cf1322' : undefined,
            }}
          />
        </Col>
        <Col xs={12} md={6}>
          <Statistic
            title="IC 正比例"
            value={
              latest_ic.ic_positive_ratio === null
                ? '—'
                : `${(Number(latest_ic.ic_positive_ratio) * 100).toFixed(1)}%`
            }
          />
        </Col>
        <Col xs={12} md={6}>
          <Statistic title="样本数" value={latest_ic.sample_count} suffix="日" />
        </Col>
      </Row>
      <div style={{ marginTop: 16 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          区间 {latest_ic.period_start} ~ {latest_ic.period_end} · 计算时间{' '}
          {dayjs(latest_ic.computed_at).format('YYYY-MM-DD HH:mm')}
        </Text>
      </div>
    </Card>
  );
};

// ============================================================================
// Helpers (duplicated from LabWorkspace 保持自洽，避免循环依赖)
// ============================================================================

/**
 * US-093: 代码视图 tab — 加载状态 / 错误 / Monaco 编辑器三态切换。
 *
 * - loading：Spin 占位（首次点击 tab 时；包括拉源码 + monaco chunk 加载）
 * - error：Alert + 重试按钮（403/404/413/500 都走此路径）
 * - source：MonacoSourceViewer 只读 600px 高度 + 搜索 / 行号 / 符号跳转
 *
 * 与 detail tab 分离的卡片设计：source 失败不影响 detail tab 渲染；用户切回
 * detail tab 仍能查看回测 / IC 等数据。
 */
const StrategySourceTab: React.FC<{
  loading: boolean;
  error: string | null;
  source: StrategySourceResponse | null;
  onReload: () => void | Promise<void>;
}> = ({ loading, error, source, onReload }) => {
  if (loading && !source) {
    return (
      <Card>
        <div style={{ display: 'flex', justifyContent: 'center', padding: 64 }}>
          <Spin tip="加载策略源码…" />
        </div>
      </Card>
    );
  }
  if (error) {
    return (
      <Alert
        type="error"
        showIcon
        message="加载源码失败"
        description={error}
        action={
          <Button size="small" onClick={() => void onReload()}>
            重试
          </Button>
        }
      />
    );
  }
  if (!source) {
    return (
      <Card>
        <Empty description="暂无源码内容" />
      </Card>
    );
  }
  return (
    <Card
      title={
        <Space size={8}>
          <CodeOutlined />
          <Text strong>{source.filename}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {source.file_path} · {(source.byte_size / 1024).toFixed(1)} KB
          </Text>
        </Space>
      }
      extra={
        <Space size={8}>
          <Tooltip title="Cmd/Ctrl+F 搜索 · Cmd/Ctrl+Shift+O 跳转到符号">
            <Tag color="blue" style={{ marginInlineEnd: 0 }}>
              只读
            </Tag>
          </Tooltip>
          <Button size="small" icon={<ReloadOutlined />} onClick={() => void onReload()}>
            刷新源码
          </Button>
        </Space>
      }
      bodyStyle={{ padding: 0 }}
    >
      <MonacoSourceViewer
        content={source.content}
        language="typescript"
        height={640}
        filename={source.filename}
      />
    </Card>
  );
};

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

export default LabStrategyDetail;
