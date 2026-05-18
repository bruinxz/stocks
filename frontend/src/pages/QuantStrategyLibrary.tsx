import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Progress,
  Row,
  Space,
  Statistic,
  Switch,
  Tag,
  Typography,
  message,
} from 'antd';
import {
  BranchesOutlined,
  DollarOutlined,
  ExperimentOutlined,
  ReloadOutlined,
  SlidersOutlined,
  ThunderboltOutlined,
  TrophyOutlined,
} from '@ant-design/icons';
import api from '../services/api';

const { Text } = Typography;

type QuantStrategy = {
  id?: number;
  strategy_key: string;
  name: string;
  description?: string;
  category: string;
  default_params: Record<string, any>;
  enabled: boolean;
  risk_level?: string;
  tags?: string[];
  latest_metrics?: Record<string, any>;
};

type StrategyWeight = {
  id: number;
  strategy_key: string;
  strategy_name?: string;
  weight: number;
  action: string;
  quality_score?: number;
  sample_count: number;
  closed_count: number;
  reason?: string;
  metrics?: Record<string, any>;
  last_evaluated_at?: string;
};

type AllocationItem = {
  strategy_key: string;
  strategy_name?: string;
  action: string;
  quality_score: number;
  closed_count: number;
  sample_count: number;
  strategy_weight: number;
  allocation_pct: number;
  capital_amount: number;
  max_single_trade_pct: number;
  max_single_trade_amount: number;
  reason?: string;
};

type AllocationPolicy = {
  generated_at: string;
  capital: number;
  allocation_count: number;
  allocations: AllocationItem[];
  summary?: {
    total_allocation_pct: number;
    paused_count: number;
    reduced_count: number;
    boosted_count: number;
  };
  rule?: string;
};

const categoryLabel: Record<string, string> = {
  trend: '趋势跟随',
  momentum: '动量强弱',
  mean_reversion: '均值回归',
  breakout: '突破启动',
  multi_factor: '多因子',
  risk_control: '风险质量',
};

const categoryColor: Record<string, string> = {
  trend: 'blue',
  momentum: 'volcano',
  mean_reversion: 'cyan',
  breakout: 'gold',
  multi_factor: 'purple',
  risk_control: 'green',
};

const actionLabel: Record<string, string> = {
  increase: '加权',
  slight_increase: '轻加权',
  observe: '观察',
  reduce: '降权',
  pause: '暂停',
};

const actionColor: Record<string, string> = {
  increase: 'red',
  slight_increase: 'volcano',
  observe: 'blue',
  reduce: 'gold',
  pause: 'default',
};

const QuantStrategyLibrary: React.FC = () => {
  const [strategies, setStrategies] = useState<QuantStrategy[]>([]);
  const [weights, setWeights] = useState<StrategyWeight[]>([]);
  const [allocationPolicy, setAllocationPolicy] = useState<AllocationPolicy | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshingWeights, setRefreshingWeights] = useState(false);
  const [editingStrategy, setEditingStrategy] = useState<QuantStrategy | null>(null);
  const [savingConfig, setSavingConfig] = useState(false);
  const [form] = Form.useForm();

  const fetchStrategies = async (silent = false) => {
    setLoading(true);
    try {
      const [strategyResponse, weightResponse] = await Promise.all([
        api.get('/quant/strategies'),
        api.get('/quant/strategy-weights'),
      ]);
      const response = strategyResponse;
      if (response.data.success) {
        setStrategies(response.data.data || []);
        if (!silent) message.success('量化策略库已刷新');
      }
      if (weightResponse.data.success) {
        setWeights(weightResponse.data.data || []);
      }
      const allocationResponse = await api.get('/quant/allocation-policy', {
        params: { capital: 200000 },
      });
      if (allocationResponse.data.success) {
        setAllocationPolicy(allocationResponse.data.data || null);
      }
    } catch (error: any) {
      message.error(error.response?.data?.message || '获取量化策略失败');
    } finally {
      setLoading(false);
    }
  };

  const refreshWeights = async () => {
    setRefreshingWeights(true);
    try {
      const response = await api.post('/quant/strategy-weights/refresh', {
        lookback_days: 365,
      });
      if (response.data.success) {
        setWeights(response.data.data?.weights || []);
        const allocationResponse = await api.get('/quant/allocation-policy', {
          params: { capital: 200000 },
        });
        if (allocationResponse.data.success) {
          setAllocationPolicy(allocationResponse.data.data || null);
        }
        message.success('策略后验权重已刷新');
      }
    } catch (error: any) {
      message.error(error.response?.data?.message || '刷新策略权重失败');
    } finally {
      setRefreshingWeights(false);
    }
  };

  const openStrategyConfig = (strategy: QuantStrategy) => {
    setEditingStrategy(strategy);
    form.setFieldsValue({
      enabled: strategy.enabled,
      default_params: strategy.default_params || {},
    });
  };

  const saveStrategyConfig = async () => {
    if (!editingStrategy) return;
    const values = await form.validateFields();
    setSavingConfig(true);
    try {
      const response = await api.patch(`/quant/strategies/${editingStrategy.strategy_key}`, {
        enabled: values.enabled,
        default_params: values.default_params || {},
      });
      if (response.data.success) {
        message.success('策略配置已保存，后续信号/跑分会使用新默认参数');
        setEditingStrategy(null);
        await fetchStrategies(true);
      }
    } catch (error: any) {
      message.error(error.response?.data?.message || '保存策略配置失败');
    } finally {
      setSavingConfig(false);
    }
  };

  const resetStrategyConfig = () => {
    if (!editingStrategy) return;
    Modal.confirm({
      title: '恢复默认参数？',
      content: '该操作会把当前抽屉中的参数恢复为打开时的默认值，保存后才会写入后端。',
      okText: '恢复',
      cancelText: '取消',
      onOk: () => {
        form.setFieldsValue({
          enabled: editingStrategy.enabled,
          default_params: editingStrategy.default_params || {},
        });
      },
    });
  };

  useEffect(() => {
    fetchStrategies(true);
  }, []);

  const stats = useMemo(() => {
    const enabled = strategies.filter(item => item.enabled).length;
    const categories = new Set(strategies.map(item => item.category)).size;
    const core = strategies.filter(
      item => item.category === 'multi_factor' || item.category === 'momentum'
    ).length;
    const boosted = weights.filter(item =>
      ['increase', 'slight_increase'].includes(item.action)
    ).length;
    return { enabled, categories, core, boosted };
  }, [strategies, weights]);

  const weightsByKey = useMemo(
    () => new Map(weights.map(item => [item.strategy_key, item])),
    [weights]
  );
  const topWeights = useMemo(
    () => [...weights].sort((a, b) => Number(b.quality_score || 0) - Number(a.quality_score || 0)),
    [weights]
  );
  const allocationStats = useMemo(
    () => ({
      de_risk_count:
        (allocationPolicy?.summary?.reduced_count || 0) +
        (allocationPolicy?.summary?.paused_count || 0),
      total_allocation_pct: allocationPolicy?.summary?.total_allocation_pct || 0,
      generated_at: allocationPolicy?.generated_at
        ? new Date(allocationPolicy.generated_at).toLocaleString()
        : '',
    }),
    [allocationPolicy]
  );

  return (
    <div className="quant-research-page fade-in-up">
      <div className="quant-research-hero">
        <div>
          <div className="quant-research-kicker">QUANT STRATEGY LIBRARY</div>
          <h1>量化策略库</h1>
          <p>
            把趋势、动量、均值回归、突破和多因子策略沉淀成可扩展的策略组件；每个策略都能独立跑分，也能进入每日量化信号池与
            TradingAgent 融合。
          </p>
          <Space wrap>
            <Tag icon={<BranchesOutlined />}>可插拔策略注册</Tag>
            <Tag icon={<ExperimentOutlined />}>支持回测跑分</Tag>
            <Tag icon={<ThunderboltOutlined />}>可进入自动荐股闭环</Tag>
          </Space>
        </div>
        <div className="quant-research-meter">
          <span>ENABLED</span>
          <strong>
            {stats.enabled}/{strategies.length}
          </strong>
          <em>
            {stats.categories} 类策略 · {stats.core} 个核心初筛策略 · {stats.boosted} 个后验加权
          </em>
        </div>
      </div>

      <Card className="modern-card quant-toolbar" variant="borderless">
        <Space wrap>
          <Button
            icon={<ReloadOutlined />}
            loading={loading}
            onClick={() => fetchStrategies(false)}
          >
            刷新策略库
          </Button>
          <Button icon={<TrophyOutlined />} loading={refreshingWeights} onClick={refreshWeights}>
            刷新后验权重
          </Button>
          <Text type="secondary">
            新增策略只需实现统一 QuantStrategy 接口并注册到 StrategyRegistry。
          </Text>
        </Space>
      </Card>

      <Card className="modern-card quant-weight-board" variant="borderless">
        <div className="quant-section-heading">
          <div>
            <span>POST-TRADE FEEDBACK</span>
            <h2>真实收益反哺策略权重</h2>
          </div>
          <Text type="secondary">根据模拟盘已闭环交易的胜率、超额收益和样本数动态加减权。</Text>
        </div>
        <Row gutter={[12, 12]}>
          {topWeights.slice(0, 4).map(weight => (
            <Col xs={24} md={12} xl={6} key={weight.strategy_key}>
              <div className="quant-weight-tile">
                <Space size={6} wrap>
                  <Tag color={actionColor[weight.action] || 'default'}>
                    {actionLabel[weight.action] || weight.action}
                  </Tag>
                  <Tag>{Number(weight.weight || 1).toFixed(2)}x</Tag>
                </Space>
                <strong>{weight.strategy_name || weight.strategy_key}</strong>
                <div className="quant-weight-score">
                  <span>质量分</span>
                  <b>{Number(weight.quality_score || 0).toFixed(1)}</b>
                </div>
                <Text type="secondary">
                  样本 {weight.sample_count || 0} / 闭环 {weight.closed_count || 0}
                </Text>
                <p>{weight.reason || '暂无足够样本，维持观察。'}</p>
              </div>
            </Col>
          ))}
          {!topWeights.length && (
            <Col span={24}>
              <Empty description="暂无策略收益闭环样本；模拟盘交易平仓后会自动反哺权重" />
            </Col>
          )}
        </Row>
      </Card>

      <Card className="modern-card quant-allocation-board" variant="borderless">
        <div className="quant-section-heading">
          <div>
            <span>CAPITAL ALLOCATION</span>
            <h2>20W 模拟资金策略组合建议</h2>
          </div>
          <Text type="secondary">
            资金只在策略层做预算约束，单票仍由风控/模拟盘执行层控制，避免单策略过度拥挤。
          </Text>
        </div>
        <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
          <Col xs={12} md={6}>
            <Statistic
              title="组合资金"
              value={allocationPolicy?.capital || 200000}
              prefix={<DollarOutlined />}
            />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="参与策略" value={allocationPolicy?.allocation_count || 0} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="加权策略" value={allocationPolicy?.summary?.boosted_count || 0} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="降权/暂停" value={allocationStats.de_risk_count} />
          </Col>
        </Row>
        <div className="quant-allocation-note">
          <span>预算覆盖 {Number(allocationStats.total_allocation_pct || 0).toFixed(1)}%</span>
          <Text type="secondary">
            {allocationPolicy?.rule ||
              '按策略后验质量、样本置信度和动作倍率生成预算；下单时会用单票上限做二次约束。'}
          </Text>
          {allocationStats.generated_at && (
            <Text type="secondary">更新时间：{allocationStats.generated_at}</Text>
          )}
        </div>
        <div className="quant-allocation-list">
          {(allocationPolicy?.allocations || []).slice(0, 8).map(item => (
            <div className="quant-allocation-row" key={item.strategy_key}>
              <div>
                <Space size={6} wrap>
                  <strong>{item.strategy_name || item.strategy_key}</strong>
                  <Tag color={actionColor[item.action] || 'default'}>
                    {actionLabel[item.action] || item.action}
                  </Tag>
                </Space>
                <Text type="secondary">
                  质量 {Number(item.quality_score || 0).toFixed(1)} · 闭环 {item.closed_count || 0}
                  笔 · 单票≤{Number(item.max_single_trade_pct || 0).toFixed(1)}%
                </Text>
              </div>
              <div className="quant-allocation-bar">
                <Progress
                  percent={Math.round(Number(item.allocation_pct || 0))}
                  showInfo={false}
                  strokeColor="#0f8f6b"
                />
                <span>
                  {Number(item.allocation_pct || 0).toFixed(1)}% / ¥
                  {Number(item.capital_amount || 0).toLocaleString()}
                </span>
              </div>
            </div>
          ))}
          {!allocationPolicy?.allocations?.length && (
            <Empty description="暂无资金分配建议，刷新后验权重后自动生成" />
          )}
        </div>
      </Card>

      <Row gutter={[16, 16]}>
        {strategies.map(strategy => {
          const paramCount = Object.keys(strategy.default_params || {}).length;
          const weight = weightsByKey.get(strategy.strategy_key);
          const readiness = strategy.enabled
            ? Math.min(100, Number(weight?.quality_score || 68) + paramCount * 2)
            : 28;
          return (
            <Col xs={24} md={12} xl={8} key={strategy.strategy_key}>
              <Card
                className="modern-card quant-strategy-card"
                variant="borderless"
                loading={loading}
              >
                <div className="quant-strategy-topline">
                  <Tag color={categoryColor[strategy.category] || 'default'}>
                    {categoryLabel[strategy.category] || strategy.category}
                  </Tag>
                  <Tag color={strategy.enabled ? 'green' : 'default'}>
                    {strategy.enabled ? '启用' : '停用'}
                  </Tag>
                </div>
                <h2>{strategy.name}</h2>
                <p>{strategy.description}</p>
                <div className="quant-strategy-score">
                  <span>{weight ? '后验质量分' : '扩展完备度'}</span>
                  <strong>{readiness}</strong>
                  <Progress percent={readiness} showInfo={false} strokeColor="#2764b8" />
                </div>
                <Space wrap size={[6, 6]}>
                  {(strategy.tags || []).map(tag => (
                    <Tag key={tag}>{tag}</Tag>
                  ))}
                  <Tag icon={<SlidersOutlined />}>{paramCount} 个默认参数</Tag>
                  <Tag
                    color={
                      strategy.risk_level === 'high'
                        ? 'volcano'
                        : strategy.risk_level === 'low'
                        ? 'green'
                        : 'gold'
                    }
                  >
                    风险 {strategy.risk_level || 'medium'}
                  </Tag>
                  {weight && (
                    <Tag color={actionColor[weight.action] || 'default'}>
                      {actionLabel[weight.action] || weight.action} ·{' '}
                      {Number(weight.weight || 1).toFixed(2)}x
                    </Tag>
                  )}
                </Space>
                {weight?.reason && (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {weight.reason}
                  </Text>
                )}
                <Button
                  block
                  icon={<SlidersOutlined />}
                  onClick={() => openStrategyConfig(strategy)}
                >
                  配置启停与默认参数
                </Button>
              </Card>
            </Col>
          );
        })}
        {!strategies.length && (
          <Col span={24}>
            <Empty description="暂无量化策略" />
          </Col>
        )}
      </Row>

      <Drawer
        title={editingStrategy ? `策略配置 · ${editingStrategy.name}` : '策略配置'}
        open={Boolean(editingStrategy)}
        onClose={() => setEditingStrategy(null)}
        width={520}
        extra={
          <Space>
            <Button onClick={resetStrategyConfig}>恢复</Button>
            <Button type="primary" loading={savingConfig} onClick={saveStrategyConfig}>
              保存配置
            </Button>
          </Space>
        }
      >
        {editingStrategy && (
          <Form form={form} layout="vertical">
            <Form.Item
              label="是否启用"
              name="enabled"
              valuePropName="checked"
              tooltip="关闭后，未显式选择策略时不会进入默认今日信号和跑分策略池。"
            >
              <Switch checkedChildren="启用" unCheckedChildren="停用" />
            </Form.Item>
            <div className="strategy-config-param-grid">
              {Object.entries(editingStrategy.default_params || {}).map(([key, value]) => (
                <Form.Item
                  key={key}
                  label={key}
                  name={['default_params', key]}
                  tooltip={`当前默认值：${String(value)}`}
                >
                  {typeof value === 'boolean' ? (
                    <Switch checkedChildren="true" unCheckedChildren="false" />
                  ) : typeof value === 'number' ? (
                    <InputNumber style={{ width: '100%' }} precision={4} />
                  ) : (
                    <Input placeholder={String(value)} />
                  )}
                </Form.Item>
              ))}
            </div>
            <Alert
              showIcon
              type="info"
              message="配置说明"
              description="这里是普通用户可理解的可视化策略配置层；新增策略仍通过后端 StrategyRegistry 注册，页面自动识别默认参数并提供编辑入口。"
            />
          </Form>
        )}
      </Drawer>
    </div>
  );
};

export default QuantStrategyLibrary;
