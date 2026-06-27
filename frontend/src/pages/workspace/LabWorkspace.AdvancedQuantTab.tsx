/**
 * LabWorkspace.AdvancedQuantTab — Sprint 1-3 五大新模块统一面板
 *
 * 5 个 sub-section（card 形式垂直堆叠）：
 *   1. ResearchIntegrity — 显示最近 audit + 触发新 audit + verdict 分布
 *   2. ExecutionFeasibility — 单股查询 + 最近批量
 *   3. MetaLabel — 模型状态 + 最近决策列表
 *   4. PortfolioConstruction — 最近优化结果
 *   5. EquityCurveGovernor — 当前 tier + 历史时间序列
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Form,
  Input,
  InputNumber,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  ExclamationCircleOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
  TrophyOutlined,
} from '@ant-design/icons';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import dayjs from 'dayjs';
import {
  runResearchAudit,
  listResearchAudits,
  checkExecutionFeasibility,
  listExecutionFeasibility,
  getMetaLabelModel,
  listMetaLabelDecisions,
  listPortfolioConstructions,
  evaluateGovernorAll,
  getGovernorHistory,
  ResearchIntegrityReport,
  ExecutionFeasibilityReport,
  MetaLabelDecisionResult,
  PortfolioConstructionResult,
  GovernorEvaluateResult,
} from '../../services/advancedQuantService';

const { Text, Paragraph } = Typography;

const VERDICT_COLOR: Record<string, string> = {
  PASS: 'green',
  WARN: 'orange',
  FAIL: 'red',
  INSUFFICIENT: 'default',
};

const TIER_COLOR: Record<string, string> = {
  healthy: 'green',
  cautious: 'lime',
  defensive: 'gold',
  critical: 'orange',
  observe_only: 'red',
};

const TIER_LABEL: Record<string, string> = {
  healthy: '健康',
  cautious: '谨慎',
  defensive: '防守',
  critical: '危机',
  observe_only: '仅观察',
};

const DECISION_COLOR: Record<string, string> = {
  fillable: 'green',
  risky: 'orange',
  blocked: 'red',
  bet: 'blue',
  skip: 'default',
};

const AdvancedQuantTab: React.FC = () => {
  // === Research Integrity ===
  const [auditList, setAuditList] = useState<ResearchIntegrityReport[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditRunning, setAuditRunning] = useState(false);
  const [auditForm] = Form.useForm();

  // === Execution Feasibility ===
  const [feasibilityList, setFeasibilityList] = useState<ExecutionFeasibilityReport[]>([]);
  const [feasibilityLoading, setFeasibilityLoading] = useState(false);
  const [feasibilityForm] = Form.useForm();
  const [feasibilityResult, setFeasibilityResult] = useState<ExecutionFeasibilityReport | null>(null);
  const [checkingFeasibility, setCheckingFeasibility] = useState(false);

  // === Meta-label ===
  const [metaModel, setMetaModel] = useState<any>(null);
  const [metaDecisions, setMetaDecisions] = useState<MetaLabelDecisionResult[]>([]);
  const [metaLoading, setMetaLoading] = useState(false);

  // === Portfolio Construction ===
  const [portfolioList, setPortfolioList] = useState<PortfolioConstructionResult[]>([]);
  const [portfolioLoading, setPortfolioLoading] = useState(false);

  // === Governor ===
  const [governorByTier, setGovernorByTier] = useState<Record<string, number>>({});
  const [governorList, setGovernorList] = useState<GovernorEvaluateResult[]>([]);
  const [governorHistory, setGovernorHistory] = useState<GovernorEvaluateResult[]>([]);
  const [governorLoading, setGovernorLoading] = useState(false);
  const [governorEvaluating, setGovernorEvaluating] = useState(false);

  // === Load all data on mount ===
  const refreshAll = useCallback(async () => {
    setAuditLoading(true);
    setFeasibilityLoading(true);
    setMetaLoading(true);
    setPortfolioLoading(true);
    setGovernorLoading(true);
    try {
      const [audits, feasibilities, model, decisions, portfolios] = await Promise.allSettled([
        listResearchAudits(30),
        listExecutionFeasibility(30),
        getMetaLabelModel(),
        listMetaLabelDecisions(30),
        listPortfolioConstructions(30),
      ]);
      if (audits.status === 'fulfilled') setAuditList(audits.value.data.data || []);
      if (feasibilities.status === 'fulfilled') setFeasibilityList(feasibilities.value.data.data || []);
      if (model.status === 'fulfilled') setMetaModel(model.value.data.data);
      if (decisions.status === 'fulfilled') setMetaDecisions(decisions.value.data.data || []);
      if (portfolios.status === 'fulfilled') setPortfolioList(portfolios.value.data.data || []);
    } finally {
      setAuditLoading(false);
      setFeasibilityLoading(false);
      setMetaLoading(false);
      setPortfolioLoading(false);
      setGovernorLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  // === Research Integrity handlers ===
  const handleRunAudit = useCallback(async () => {
    try {
      const values = await auditForm.validateFields();
      setAuditRunning(true);
      const { data } = await runResearchAudit({
        strategy_key: values.strategy_key || null,
        observed_sharpe: values.observed_sharpe,
        oos_sharpe: values.oos_sharpe ?? null,
        num_trials: values.num_trials ?? 1,
        sample_length: values.sample_length ?? 252,
        scan_strategy_code: values.scan_strategy_code === true,
        persist: true,
      });
      if (data?.success) {
        message.success(`审计完成: ${data.data.verdict}`);
        setAuditList(prev => [data.data, ...prev]);
      }
    } catch (e: any) {
      message.error(e?.response?.data?.message || e?.message || '审计失败');
    } finally {
      setAuditRunning(false);
    }
  }, [auditForm]);

  // === Execution Feasibility handlers ===
  const handleCheckFeasibility = useCallback(async () => {
    try {
      const values = await feasibilityForm.validateFields();
      setCheckingFeasibility(true);
      const { data } = await checkExecutionFeasibility({
        symbol: values.symbol,
        side: values.side,
        target_qty: Number(values.target_qty),
        target_price: values.target_price ? Number(values.target_price) : null,
        as_of_date: dayjs().format('YYYY-MM-DD'),
      });
      if (data?.success) {
        setFeasibilityResult(data.data);
        message.success(`评分完成: ${data.data.decision} (${data.data.composite_score.toFixed(0)})`);
      }
    } catch (e: any) {
      message.error(e?.response?.data?.message || e?.message || '评估失败');
    } finally {
      setCheckingFeasibility(false);
    }
  }, [feasibilityForm]);

  // === Governor handlers ===
  const handleEvaluateAll = useCallback(async () => {
    try {
      setGovernorEvaluating(true);
      const { data } = await evaluateGovernorAll();
      if (data?.success) {
        setGovernorByTier(data.data.by_tier);
        setGovernorList(data.data.results || []);
        message.success(`已评估 ${data.data.evaluated} 个 portfolio`);
      }
    } catch (e: any) {
      message.error(e?.response?.data?.message || e?.message || '评估失败');
    } finally {
      setGovernorEvaluating(false);
    }
  }, []);

  // === Render ===
  return (
    <div>
      <Alert
        type="info"
        showIcon
        message="高级量化模块 — 研究严谨性 / 执行可行性 / Meta-label / 组合构造 / Governor"
        description="Sprint 1-3 引入的 5 个 service，把系统从「策略研究员」升级到「组合经理 + 风控官 + 执行交易员」。"
        style={{ marginBottom: 16 }}
      />

      {/* === Section 1: Research Integrity === */}
      <Card
        title={
          <Space>
            <SafetyCertificateOutlined style={{ color: '#1677ff' }} />
            <span>研究严谨性 (Sprint 1A)</span>
            <Text type="secondary" style={{ fontSize: 12 }}>
              DSR / PBO / 未来函数扫描 / Survivorship 检测
            </Text>
          </Space>
        }
        size="small"
        style={{ marginBottom: 16 }}
        extra={
          <Button icon={<ReloadOutlined />} size="small" onClick={() => void refreshAll()}>
            刷新
          </Button>
        }
      >
        <Row gutter={16}>
          <Col span={10}>
            <Form form={auditForm} layout="vertical" size="small">
              <Form.Item name="strategy_key" label="策略 key (可选)">
                <Input placeholder="multi_factor_alpha" />
              </Form.Item>
              <Row gutter={8}>
                <Col span={12}>
                  <Form.Item
                    name="observed_sharpe"
                    label="观测 sharpe"
                    rules={[{ required: true, message: '必填' }]}
                  >
                    <InputNumber style={{ width: '100%' }} step={0.1} placeholder="1.5" />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name="oos_sharpe" label="OOS sharpe (可选)">
                    <InputNumber style={{ width: '100%' }} step={0.1} placeholder="0.8" />
                  </Form.Item>
                </Col>
              </Row>
              <Row gutter={8}>
                <Col span={12}>
                  <Form.Item name="num_trials" label="试验次数" initialValue={1}>
                    <InputNumber style={{ width: '100%' }} min={1} />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name="sample_length" label="样本天数" initialValue={252}>
                    <InputNumber style={{ width: '100%' }} min={2} />
                  </Form.Item>
                </Col>
              </Row>
              <Form.Item name="scan_strategy_code" valuePropName="checked" initialValue={false}>
                <label style={{ display: 'flex', alignItems: 'center' }}>
                  <input
                    type="checkbox"
                    style={{ marginRight: 8 }}
                    onChange={e => auditForm.setFieldValue('scan_strategy_code', e.target.checked)}
                  />
                  <span>扫描策略源码 (Lookahead 检测，耗时长)</span>
                </label>
              </Form.Item>
              <Button
                type="primary"
                icon={<SafetyCertificateOutlined />}
                onClick={handleRunAudit}
                loading={auditRunning}
                block
              >
                运行审计
              </Button>
            </Form>
          </Col>
          <Col span={14}>
            <Table
              size="small"
              loading={auditLoading}
              dataSource={auditList}
              rowKey={r => r.id || `${r.backtest_id}-${r.created_at}`}
              pagination={{ pageSize: 8 }}
              columns={[
                {
                  title: 'verdict',
                  dataIndex: 'verdict',
                  key: 'verdict',
                  width: 100,
                  render: (v: string) => <Tag color={VERDICT_COLOR[v]}>{v}</Tag>,
                },
                {
                  title: '策略',
                  dataIndex: 'strategy_key',
                  key: 'strategy_key',
                  ellipsis: true,
                  render: (v: string | null) => v || '—',
                },
                {
                  title: 'DSR',
                  dataIndex: 'dsr',
                  key: 'dsr',
                  width: 80,
                  render: (v: number | null) => (v !== null ? v.toFixed(3) : '—'),
                },
                {
                  title: 'PBO',
                  dataIndex: 'pbo',
                  key: 'pbo',
                  width: 80,
                  render: (v: number | null) => (v !== null ? v.toFixed(3) : '—'),
                },
                {
                  title: 'OOS decay',
                  dataIndex: 'oos_decay_ratio',
                  key: 'oos_decay_ratio',
                  width: 100,
                  render: (v: number | null) => (v !== null ? v.toFixed(2) : '—'),
                },
                {
                  title: '时间',
                  dataIndex: 'created_at',
                  key: 'created_at',
                  width: 140,
                  render: (v: string) => (v ? dayjs(v).format('MM-DD HH:mm') : '—'),
                },
              ]}
              expandable={{
                expandedRowRender: r => (
                  <div>
                    <Paragraph style={{ marginBottom: 4 }}>
                      <Text strong>{r.summary_message}</Text>
                    </Paragraph>
                    {r.lookahead_issues.length > 0 && (
                      <div style={{ marginTop: 8 }}>
                        <Text type="danger">Lookahead 嫌疑 ({r.lookahead_issues.length}):</Text>
                        <ul style={{ paddingLeft: 20, fontSize: 12 }}>
                          {r.lookahead_issues.slice(0, 5).map((iss, i) => (
                            <li key={i}>
                              <Tag color={iss.severity === 'high' ? 'red' : 'orange'}>{iss.severity}</Tag>
                              {iss.pattern} @ {iss.file.split('/').slice(-2).join('/')}:{iss.line}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {r.survivorship_issues.length > 0 && (
                      <div style={{ marginTop: 8 }}>
                        <Text type="warning">Survivorship 问题:</Text>
                        <ul style={{ paddingLeft: 20, fontSize: 12 }}>
                          {r.survivorship_issues.map((iss, i) => (
                            <li key={i}>{iss.detail}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                ),
              }}
            />
          </Col>
        </Row>
      </Card>

      {/* === Section 2: Execution Feasibility === */}
      <Card
        title={
          <Space>
            <ThunderboltOutlined style={{ color: '#fa8c16' }} />
            <span>执行可行性 (Sprint 1B)</span>
            <Text type="secondary" style={{ fontSize: 12 }}>
              涨跌停距离 / 成交额覆盖率 / 价差 / T+1 综合评分
            </Text>
          </Space>
        }
        size="small"
        style={{ marginBottom: 16 }}
      >
        <Row gutter={16}>
          <Col span={10}>
            <Form form={feasibilityForm} layout="vertical" size="small">
              <Row gutter={8}>
                <Col span={14}>
                  <Form.Item name="symbol" label="symbol" rules={[{ required: true }]}>
                    <Input placeholder="sh.600000" />
                  </Form.Item>
                </Col>
                <Col span={10}>
                  <Form.Item name="side" label="side" initialValue="BUY">
                    <Select>
                      <Select.Option value="BUY">BUY</Select.Option>
                      <Select.Option value="SELL">SELL</Select.Option>
                    </Select>
                  </Form.Item>
                </Col>
              </Row>
              <Row gutter={8}>
                <Col span={12}>
                  <Form.Item name="target_qty" label="数量 (股)" rules={[{ required: true }]}>
                    <InputNumber style={{ width: '100%' }} min={100} step={100} placeholder="1000" />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name="target_price" label="目标价 (可选)">
                    <InputNumber style={{ width: '100%' }} step={0.01} placeholder="10.50" />
                  </Form.Item>
                </Col>
              </Row>
              <Button
                type="primary"
                icon={<ThunderboltOutlined />}
                onClick={handleCheckFeasibility}
                loading={checkingFeasibility}
                block
              >
                评估可行性
              </Button>
              {feasibilityResult && (
                <div style={{ marginTop: 12 }}>
                  <Alert
                    type={
                      feasibilityResult.decision === 'fillable'
                        ? 'success'
                        : feasibilityResult.decision === 'risky'
                          ? 'warning'
                          : 'error'
                    }
                    showIcon
                    message={feasibilityResult.summary}
                  />
                  <Row gutter={4} style={{ marginTop: 8 }}>
                    <Col span={6}>
                      <Statistic
                        title="涨跌停距"
                        value={feasibilityResult.limit_proximity_score ?? '—'}
                        valueStyle={{ fontSize: 14 }}
                      />
                    </Col>
                    <Col span={6}>
                      <Statistic
                        title="量覆盖"
                        value={feasibilityResult.volume_coverage_score ?? '—'}
                        valueStyle={{ fontSize: 14 }}
                      />
                    </Col>
                    <Col span={6}>
                      <Statistic title="价差" value={feasibilityResult.spread_score ?? '—'} valueStyle={{ fontSize: 14 }} />
                    </Col>
                    <Col span={6}>
                      <Statistic
                        title="状态"
                        value={feasibilityResult.status_score ?? '—'}
                        valueStyle={{ fontSize: 14 }}
                      />
                    </Col>
                  </Row>
                </div>
              )}
            </Form>
          </Col>
          <Col span={14}>
            <Table
              size="small"
              loading={feasibilityLoading}
              dataSource={feasibilityList}
              rowKey={r => r.id || `${r.symbol}-${r.created_at}`}
              pagination={{ pageSize: 8 }}
              columns={[
                {
                  title: 'symbol',
                  dataIndex: 'symbol',
                  key: 'symbol',
                  width: 90,
                },
                {
                  title: 'side',
                  dataIndex: 'side',
                  key: 'side',
                  width: 60,
                  render: (v: string) => <Tag color={v === 'BUY' ? 'green' : 'red'}>{v}</Tag>,
                },
                {
                  title: '决策',
                  dataIndex: 'decision',
                  key: 'decision',
                  width: 90,
                  render: (v: string) => <Tag color={DECISION_COLOR[v]}>{v}</Tag>,
                },
                {
                  title: 'score',
                  dataIndex: 'composite_score',
                  key: 'composite_score',
                  width: 80,
                  render: (v: number) => v.toFixed(1),
                },
                {
                  title: '时间',
                  dataIndex: 'created_at',
                  key: 'created_at',
                  width: 110,
                  render: (v: string) => (v ? dayjs(v).format('MM-DD HH:mm') : '—'),
                },
              ]}
            />
          </Col>
        </Row>
      </Card>

      {/* === Section 3 + 4: Meta-label + Portfolio Construction side by side === */}
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={12}>
          <Card
            title={
              <Space>
                <CheckCircleOutlined style={{ color: '#722ed1' }} />
                <span>Meta-label 决策 (Sprint 2A)</span>
              </Space>
            }
            size="small"
            extra={
              metaModel ? (
                <Tag color="blue">{metaModel.version} (acc={metaModel.insample_accuracy})</Tag>
              ) : (
                <Tag color="default">无训练模型 (fallback rule)</Tag>
              )
            }
          >
            <Table
              size="small"
              loading={metaLoading}
              dataSource={metaDecisions}
              rowKey={r => r.id || `${r.symbol}-${r.created_at}`}
              pagination={{ pageSize: 8 }}
              columns={[
                {
                  title: 'symbol',
                  dataIndex: 'symbol',
                  key: 'symbol',
                  width: 100,
                  ellipsis: true,
                },
                {
                  title: 'decision',
                  dataIndex: 'decision',
                  key: 'decision',
                  width: 80,
                  render: (v: string) => <Tag color={DECISION_COLOR[v]}>{v}</Tag>,
                },
                {
                  title: 'conf',
                  dataIndex: 'confidence',
                  key: 'confidence',
                  width: 80,
                  render: (v: number) => v.toFixed(3),
                },
                {
                  title: '时间',
                  dataIndex: 'created_at',
                  key: 'created_at',
                  width: 100,
                  render: (v: string) => (v ? dayjs(v).format('MM-DD HH:mm') : '—'),
                },
              ]}
            />
          </Card>
        </Col>
        <Col span={12}>
          <Card
            title={
              <Space>
                <TrophyOutlined style={{ color: '#13c2c2' }} />
                <span>组合构造 (Sprint 2B)</span>
              </Space>
            }
            size="small"
          >
            <Table
              size="small"
              loading={portfolioLoading}
              dataSource={portfolioList}
              rowKey={r => r.id || `${r.as_of_date}-${r.method}`}
              pagination={{ pageSize: 8 }}
              columns={[
                {
                  title: 'method',
                  dataIndex: 'method',
                  key: 'method',
                  width: 110,
                  render: (v: string) => <Tag color="blue">{v}</Tag>,
                },
                {
                  title: 'N',
                  dataIndex: 'symbols',
                  key: 'symbols',
                  width: 50,
                  render: (s: string[]) => s.length,
                },
                {
                  title: '总仓',
                  dataIndex: 'total_allocation',
                  key: 'total_allocation',
                  width: 70,
                  render: (v: number) => `${(v * 100).toFixed(0)}%`,
                },
                {
                  title: '日期',
                  dataIndex: 'as_of_date',
                  key: 'as_of_date',
                  width: 110,
                },
              ]}
              expandable={{
                expandedRowRender: r => (
                  <div style={{ fontSize: 12 }}>
                    <Paragraph>{r.summary}</Paragraph>
                    <Text type="secondary">行业暴露: </Text>
                    {Object.entries(r.industry_exposure || {}).map(([k, v]) => (
                      <Tag key={k} color="blue">
                        {k}: {(v * 100).toFixed(1)}%
                      </Tag>
                    ))}
                  </div>
                ),
              }}
            />
          </Card>
        </Col>
      </Row>

      {/* === Section 5: Equity Curve Governor === */}
      <Card
        title={
          <Space>
            <ExclamationCircleOutlined style={{ color: '#eb2f96' }} />
            <span>资金曲线 Governor (Sprint 3)</span>
            <Text type="secondary" style={{ fontSize: 12 }}>
              5 档梯度风险治理 (healthy / cautious / defensive / critical / observe_only)
            </Text>
          </Space>
        }
        size="small"
        extra={
          <Button
            type="primary"
            size="small"
            icon={<ReloadOutlined />}
            loading={governorEvaluating}
            onClick={handleEvaluateAll}
          >
            评估所有 portfolio
          </Button>
        }
      >
        <Row gutter={8} style={{ marginBottom: 12 }}>
          {['healthy', 'cautious', 'defensive', 'critical', 'observe_only'].map(tier => (
            <Col key={tier} span={4}>
              <Card size="small" bordered hoverable>
                <Statistic
                  title={
                    <Tag color={TIER_COLOR[tier]} style={{ fontSize: 12 }}>
                      {TIER_LABEL[tier]}
                    </Tag>
                  }
                  value={governorByTier[tier] ?? 0}
                  suffix="个"
                  valueStyle={{ fontSize: 18 }}
                />
              </Card>
            </Col>
          ))}
        </Row>
        {governorList.length === 0 ? (
          <Empty description="尚未评估，点击右上角按钮触发" />
        ) : (
          <Table
            size="small"
            dataSource={governorList}
            rowKey={r => `${r.portfolio_id}-${r.as_of_date}`}
            pagination={{ pageSize: 10 }}
            columns={[
              {
                title: 'portfolio',
                dataIndex: 'portfolio_id',
                key: 'portfolio_id',
                width: 90,
              },
              {
                title: '档位',
                dataIndex: 'tier',
                key: 'tier',
                width: 100,
                render: (v: string) => <Tag color={TIER_COLOR[v]}>{TIER_LABEL[v]}</Tag>,
              },
              {
                title: 'Kelly ×',
                dataIndex: 'kelly_multiplier',
                key: 'kelly_multiplier',
                width: 80,
                render: (v: number) => v.toFixed(2),
              },
              {
                title: '回撤',
                dataIndex: 'current_drawdown_pct',
                key: 'current_drawdown_pct',
                width: 80,
                render: (v: number | null) => (v !== null ? `${v.toFixed(1)}%` : '—'),
              },
              {
                title: 'sharpe30d',
                dataIndex: 'recent_sharpe_30d',
                key: 'recent_sharpe_30d',
                width: 100,
                render: (v: number | null) => (v !== null ? v.toFixed(2) : '—'),
              },
              {
                title: 'win_rate',
                dataIndex: 'recent_winrate_30d',
                key: 'recent_winrate_30d',
                width: 90,
                render: (v: number | null) => (v !== null ? `${(v * 100).toFixed(0)}%` : '—'),
              },
              {
                title: '触发原因',
                dataIndex: 'trigger_reason',
                key: 'trigger_reason',
                ellipsis: true,
              },
            ]}
          />
        )}
      </Card>
    </div>
  );
};

export default AdvancedQuantTab;
