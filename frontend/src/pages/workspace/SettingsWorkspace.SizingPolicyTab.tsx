/**
 * SettingsWorkspace.SizingPolicyTab — Phase 2 用户 sizing 策略编辑 UI
 *
 * 四种 method:
 *   - equal_pct (默认, Phase 0 行为): equity * position_pct
 *   - vol_target: 让每个仓位贡献同样年化波动 (RiskParity 简化)
 *   - atr_based: Turtle/Van Tharp ATR 反比 sizing
 *   - kelly: 分数 Kelly (f* = (pb-q)/b)，依赖策略历史胜率/赔率 + 样本量门槛
 *
 * 编辑后立即 PUT /api/risk/sizing-policy 保存。
 * 当前在 PaperTradingAutomationService 跑 shadow mode (只 log 不替换)，
 * 给 UI 一个 alert 让用户知道是 "观察期"。
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Form,
  InputNumber,
  Row,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import { QuestionCircleOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import {
  sizingPolicyService,
  SizingPolicyConfig,
  SizingPolicyWithDefaults,
  SizingMethod,
  SizingAuditReport,
  KillSwitchMonitorResult,
} from '../../services/sizingPolicyService';

const { Text, Paragraph } = Typography;

const METHOD_OPTIONS: Array<{ value: SizingMethod; label: string; desc: string }> = [
  {
    value: 'equal_pct',
    label: '等权固定百分比 (equal_pct)',
    desc: 'target = equity × base_position_pct。最简单可预测，Phase 0 默认行为。',
  },
  {
    value: 'vol_target',
    label: '波动率目标 (vol_target)',
    desc: '让每个仓位贡献相同的年化波动 (RiskParity 简化)。高波股拿小仓，低波股拿大仓。',
  },
  {
    value: 'atr_based',
    label: 'ATR 反比 (atr_based)',
    desc: 'Turtle/Van Tharp 经典：每笔最多亏 risk_pct，ATR 越大仓位越小。',
  },
  {
    value: 'kelly',
    label: '分数 Kelly (kelly)',
    desc: 'Edward Thorp / Ralph Vince 经典。f* = (pb-q)/b × Kelly乘数。需 50+ 笔历史。',
  },
];

const SizingPolicyTab: React.FC = () => {
  const [view, setView] = useState<SizingPolicyWithDefaults | null>(null);
  const [draft, setDraft] = useState<SizingPolicyConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form] = Form.useForm();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await sizingPolicyService.getSizingPolicy();
      setView(data);
      setDraft(data.current);
      form.setFieldsValue(data.current);
    } catch (err: any) {
      setError(err?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [form]);

  useEffect(() => {
    load();
  }, [load]);

  const hasChanges = useMemo(() => {
    if (!view || !draft) return false;
    return JSON.stringify(draft) !== JSON.stringify(view.current);
  }, [draft, view]);

  const onSubmit = useCallback(
    async (values: SizingPolicyConfig) => {
      setSaving(true);
      try {
        const saved = await sizingPolicyService.updateSizingPolicy(values);
        message.success(`已保存：method=${saved.method}`);
        // 刷新对比 baseline
        setView({ current: saved, defaults: view?.defaults || saved });
        setDraft(saved);
      } catch (err: any) {
        message.error(err?.message || '保存失败');
      } finally {
        setSaving(false);
      }
    },
    [view]
  );

  const onReset = useCallback(() => {
    if (view?.defaults) {
      form.setFieldsValue(view.defaults);
      setDraft(view.defaults);
      message.info('已重置为默认值，点击保存生效');
    }
  }, [form, view]);

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {draft?.hard_cutover_enabled ? (
        <Alert
          type="success"
          showIcon
          message="Phase 2 硬切换已启用 — 实际下单按 sizing 策略执行"
          description={
            <Paragraph style={{ marginBottom: 0 }}>
              当前 method=<Text code>{draft?.method}</Text>，PaperTradingAutomationService 每笔下单的实际仓位
              都由 decideSizing 计算后**真正生效** (替换 effectiveTargetPct)。日志 prefix
              <Text code>[hard-sizing]</Text>。Kelly 负 edge 或决策 = 0 时会跳过该笔交易。
            </Paragraph>
          }
        />
      ) : (
        <Alert
          type="info"
          showIcon
          message="Phase 2 多元化仓位 sizing — 当前为 shadow mode"
          description={
            <Paragraph style={{ marginBottom: 0 }}>
              选择 vol_target / atr_based / kelly 后，PaperTradingAutomationService 会在每次下单时**并行计算**新 sizing 结果并写入日志
              (<Text code>[shadow-sizing]</Text>)，但**实际下单仍使用现有 equal_pct 行为**。
              观察 7-14 天后，开启下方「硬切换」开关让 sizing 决策真正生效。
            </Paragraph>
          }
        />
      )}

      {error && <Alert type="error" showIcon message={error} />}

      <Card
        className="modern-card"
        title="Sizing 策略配置"
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>
              刷新
            </Button>
            <Button onClick={onReset} disabled={!view?.defaults}>
              重置默认
            </Button>
          </Space>
        }
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={onSubmit}
          onValuesChange={(_, values) => setDraft(values as SizingPolicyConfig)}
          initialValues={view?.current}
        >
          <Form.Item
            name="method"
            label={
              <Space>
                <Text strong>Sizing 方法</Text>
                <Tooltip title="选择仓位计算算法；不同算法对应不同的风险逻辑">
                  <QuestionCircleOutlined style={{ color: '#999' }} />
                </Tooltip>
              </Space>
            }
            rules={[{ required: true }]}
          >
            <Select
              options={METHOD_OPTIONS.map(o => ({
                value: o.value,
                label: (
                  <div>
                    <div style={{ fontWeight: 600 }}>{o.label}</div>
                    <div style={{ fontSize: 12, color: '#888' }}>{o.desc}</div>
                  </div>
                ),
              }))}
            />
          </Form.Item>

          <Form.Item
            noStyle
            shouldUpdate={(prev, curr) => prev.method !== curr.method}
          >
            {({ getFieldValue }) => {
              const method = getFieldValue('method');
              if (method === 'equal_pct') return null;
              return (
                <Card
                  size="small"
                  style={{ marginBottom: 12, background: '#fff1f0', border: '1px solid #ffa39e' }}
                >
                  <Row align="middle" gutter={16}>
                    <Col flex="auto">
                      <Space direction="vertical" size={2}>
                        <Space>
                          <Text strong style={{ color: '#a8071a' }}>
                            ⚠ 硬切换开关 (hard_cutover_enabled)
                          </Text>
                          <Tooltip title="false=shadow mode 只 log 不替换；true=sizing 决策真正生效">
                            <QuestionCircleOutlined style={{ color: '#a8071a' }} />
                          </Tooltip>
                        </Space>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          开启后，下一笔下单将按所选 sizing 方法实际计算的仓位生效，
                          不再是 equal_pct 行为。建议先观察 7-14 天 shadow log 后再开。
                        </Text>
                      </Space>
                    </Col>
                    <Col flex="none">
                      <Form.Item name="hard_cutover_enabled" valuePropName="checked" noStyle>
                        <Switch checkedChildren="开" unCheckedChildren="关" />
                      </Form.Item>
                    </Col>
                  </Row>
                </Card>
              );
            }}
          </Form.Item>

          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                name="base_position_pct"
                label="base_position_pct (基础仓位 %)"
                tooltip="equal_pct 直接用；其他方法在数据缺失时 fallback 到这个"
                rules={[{ required: true }]}
              >
                <InputNumber min={0.5} max={30} step={0.5} suffix="%" style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="max_position_pct"
                label="max_position_pct (单股最大仓位 %)"
                tooltip="任何方法都不超过这个上限"
                rules={[{ required: true }]}
              >
                <InputNumber min={1} max={50} step={1} suffix="%" style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>

          <Form.Item
            noStyle
            shouldUpdate={(prev, curr) => prev.method !== curr.method}
          >
            {({ getFieldValue }) => {
              const method = getFieldValue('method') as SizingMethod;
              if (method === 'vol_target') {
                return (
                  <Card size="small" style={{ marginBottom: 12, background: '#f8fafc' }}>
                    <Text strong>vol_target 参数</Text>
                    <Row gutter={16} style={{ marginTop: 12 }}>
                      <Col span={12}>
                        <Form.Item
                          name="vol_target_pct"
                          label="vol_target_pct (目标年化波动)"
                          tooltip="每个仓位的年化波动率目标，比如 0.15 = 15%"
                        >
                          <InputNumber min={0.05} max={1.0} step={0.05} style={{ width: '100%' }} />
                        </Form.Item>
                      </Col>
                      <Col span={12}>
                        <Form.Item
                          name="vol_max_lookback_days"
                          label="vol 计算回看天数"
                        >
                          <InputNumber min={5} max={252} style={{ width: '100%' }} />
                        </Form.Item>
                      </Col>
                    </Row>
                  </Card>
                );
              }
              if (method === 'atr_based') {
                return (
                  <Card size="small" style={{ marginBottom: 12, background: '#f8fafc' }}>
                    <Text strong>atr_based 参数</Text>
                    <Row gutter={16} style={{ marginTop: 12 }}>
                      <Col span={12}>
                        <Form.Item
                          name="atr_risk_pct"
                          label="atr_risk_pct (每笔最大亏损 %)"
                          tooltip="每笔交易最多亏 X% equity，默认 1%"
                        >
                          <InputNumber min={0.1} max={5} step={0.1} suffix="%" style={{ width: '100%' }} />
                        </Form.Item>
                      </Col>
                      <Col span={12}>
                        <Form.Item
                          name="atr_period"
                          label="ATR 计算周期"
                          tooltip="ATR 用多少日窗口"
                        >
                          <InputNumber min={5} max={60} style={{ width: '100%' }} />
                        </Form.Item>
                      </Col>
                    </Row>
                  </Card>
                );
              }
              if (method === 'kelly') {
                return (
                  <Card size="small" style={{ marginBottom: 12, background: '#fff7e6' }}>
                    <Text strong>kelly 参数</Text>
                    <Paragraph style={{ marginTop: 8, marginBottom: 8, fontSize: 12, color: '#666' }}>
                      <Text strong>公式：</Text>f* = (p×b - q) / b，其中 p=胜率, q=1-p, b=平均盈利/平均亏损。
                      <br />
                      <Text strong>实际仓位：</Text>equity × f* × Kelly乘数。业界惯用 0.25 (Quarter Kelly) 或 0.5 (Half Kelly)
                      因为满 Kelly 波动太大。
                      <br />
                      <Text strong>样本量门槛：</Text>历史交易数 &lt; 阈值时自动退化到 base_position_pct，防止数据噪声放大。
                      胜率/赔率从策略历史 outcome 聚合，定期刷新。
                    </Paragraph>
                    <Row gutter={16} style={{ marginTop: 12 }}>
                      <Col span={12}>
                        <Form.Item
                          name="kelly_fraction_multiplier"
                          label="kelly_fraction_multiplier (Kelly 乘数)"
                          tooltip="0.25 = 1/4 Kelly (稳健推荐); 0.5 = 1/2 Kelly; 1.0 = 满 Kelly (激进)"
                        >
                          <InputNumber
                            min={0.05}
                            max={1.0}
                            step={0.05}
                            style={{ width: '100%' }}
                          />
                        </Form.Item>
                      </Col>
                      <Col span={12}>
                        <Form.Item
                          name="kelly_min_sample_size"
                          label="kelly_min_sample_size (最少历史交易数)"
                          tooltip="低于此样本数退化到 base_position_pct。50 是统计意义最低门槛，100+ 更稳"
                        >
                          <InputNumber min={10} max={500} step={5} style={{ width: '100%' }} />
                        </Form.Item>
                      </Col>
                    </Row>
                  </Card>
                );
              }
              return null;
            }}
          </Form.Item>

          <Space>
            <Button
              type="primary"
              icon={<SaveOutlined />}
              htmlType="submit"
              loading={saving}
              disabled={!hasChanges}
            >
              保存配置
            </Button>
            {hasChanges && <Tag color="orange">有未保存改动</Tag>}
          </Space>
        </Form>
      </Card>

      <SizingAuditPanel />
      <KillSwitchPanel />
    </Space>
  );
};

export default SizingPolicyTab;

// ============================================================
// SizingAuditPanel — Phase 2+ A/B 决策审计面板
// ============================================================

const SizingAuditPanel: React.FC = () => {
  const [report, setReport] = useState<SizingAuditReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lookbackDays, setLookbackDays] = useState(30);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await sizingPolicyService.getSizingAudit({ lookback_days: lookbackDays });
      setReport(r);
    } catch (err: any) {
      setError(err?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [lookbackDays]);

  useEffect(() => {
    load();
  }, [load]);

  const summary = report?.summary;
  const byStrategy = report?.by_strategy || [];
  const recentRows = report?.recent_rows || [];

  return (
    <Card
      className="modern-card"
      title="Sizing 决策审计 (Phase 2+)"
      extra={
        <Space>
          <Select
            size="small"
            value={lookbackDays}
            onChange={v => setLookbackDays(v)}
            options={[
              { value: 7, label: '7 天' },
              { value: 30, label: '30 天' },
              { value: 90, label: '90 天' },
            ]}
            style={{ width: 100 }}
          />
          <Button icon={<ReloadOutlined />} onClick={load} loading={loading} size="small">
            刷新
          </Button>
        </Space>
      }
    >
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
      {!error && summary && summary.count === 0 && (
        <Alert
          type="info"
          showIcon
          message="暂无 sizing 决策记录"
          description="切换 sizing 方法 (vol_target / atr_based / kelly) 后下一笔自动跟单会开始写入决策审计。"
        />
      )}
      {summary && summary.count > 0 && (
        <>
          <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
            <Col xs={12} sm={8} md={6}>
              <Statistic title="决策行数" value={summary.count} />
            </Col>
            <Col xs={12} sm={8} md={6}>
              <Statistic
                title="硬切换 / Shadow"
                value={`${summary.hard_cutover_count} / ${summary.shadow_count}`}
              />
            </Col>
            <Col xs={12} sm={8} md={6}>
              <Statistic
                title="平均实际仓位 %"
                value={summary.avg_actual_pct}
                precision={2}
                suffix="%"
              />
            </Col>
            <Col xs={12} sm={8} md={6}>
              <Statistic
                title="平均决策仓位 %"
                value={summary.avg_decision_pct}
                precision={2}
                suffix="%"
              />
            </Col>
            <Col xs={12} sm={8} md={6}>
              <Tooltip title="决策 - 实际。正数=sizing 倾向加仓，负数=减仓">
                <Statistic
                  title="平均 Δ %"
                  value={summary.avg_delta_pct}
                  precision={2}
                  suffix="%"
                  valueStyle={{ color: summary.avg_delta_pct > 0 ? '#cf1322' : '#3f8600' }}
                />
              </Tooltip>
            </Col>
            <Col xs={12} sm={8} md={6}>
              <Statistic
                title={`最大 |Δ| (${summary.max_abs_delta_symbol || '—'})`}
                value={summary.max_abs_delta_pct}
                precision={2}
                suffix="%"
              />
            </Col>
            <Col xs={12} sm={8} md={6}>
              <Statistic
                title="触顶 max %"
                value={summary.capped_by_max_pct}
                precision={1}
                suffix="%"
                valueStyle={{ color: summary.capped_by_max_pct > 30 ? '#cf1322' : '#666' }}
              />
            </Col>
            <Col xs={12} sm={8} md={6}>
              <Statistic
                title="触顶 cash %"
                value={summary.capped_by_cash_pct}
                precision={1}
                suffix="%"
                valueStyle={{ color: summary.capped_by_cash_pct > 30 ? '#cf1322' : '#666' }}
              />
            </Col>
          </Row>

          {byStrategy.length > 0 && (
            <>
              <Typography.Title level={5} style={{ marginTop: 16 }}>
                按策略聚合
              </Typography.Title>
              <Table
                size="small"
                dataSource={byStrategy}
                rowKey="strategy_key"
                pagination={false}
                scroll={{ x: 600 }}
                columns={[
                  { title: '策略', dataIndex: 'strategy_key', width: 160 },
                  { title: '决策数', dataIndex: 'count', width: 80 },
                  {
                    title: '平均实际 %',
                    dataIndex: 'avg_actual_pct',
                    width: 100,
                    render: (v: number) => `${v.toFixed(2)}%`,
                  },
                  {
                    title: '平均决策 %',
                    dataIndex: 'avg_decision_pct',
                    width: 100,
                    render: (v: number) => `${v.toFixed(2)}%`,
                  },
                  {
                    title: '平均 Δ %',
                    dataIndex: 'avg_delta_pct',
                    width: 100,
                    render: (v: number) => (
                      <span style={{ color: v > 0 ? '#cf1322' : '#3f8600' }}>{v.toFixed(2)}%</span>
                    ),
                  },
                  {
                    title: 'method 分布',
                    dataIndex: 'method_breakdown',
                    render: (m: Record<string, number>) => (
                      <Space size={4}>
                        {Object.entries(m).map(([k, v]) => (
                          <Tag key={k} color="blue" style={{ margin: 0 }}>
                            {k}:{v}
                          </Tag>
                        ))}
                      </Space>
                    ),
                  },
                ]}
              />
            </>
          )}

          {recentRows.length > 0 && (
            <>
              <Typography.Title level={5} style={{ marginTop: 16 }}>
                最近 {recentRows.length} 笔决策
              </Typography.Title>
              <Table
                size="small"
                dataSource={recentRows}
                rowKey="id"
                pagination={{ pageSize: 10 }}
                scroll={{ x: 800 }}
                columns={[
                  {
                    title: '时间',
                    dataIndex: 'created_at',
                    width: 140,
                    render: (v: string) => new Date(v).toLocaleString('zh-CN'),
                  },
                  { title: 'Symbol', dataIndex: 'symbol', width: 100 },
                  { title: '策略', dataIndex: 'strategy_key', width: 140 },
                  {
                    title: '模式',
                    dataIndex: 'hard_cutover',
                    width: 80,
                    render: (v: boolean) =>
                      v ? <Tag color="red">hard</Tag> : <Tag color="default">shadow</Tag>,
                  },
                  { title: 'method', dataIndex: 'method', width: 100 },
                  {
                    title: '实际 %',
                    dataIndex: 'actual_pct',
                    width: 80,
                    render: (v: number) => `${Number(v).toFixed(2)}%`,
                  },
                  {
                    title: '决策 %',
                    dataIndex: 'decision_pct',
                    width: 80,
                    render: (v: number) => `${Number(v).toFixed(2)}%`,
                  },
                  {
                    title: 'Δ %',
                    dataIndex: 'delta',
                    width: 80,
                    render: (v: number) => {
                      const n = Number(v);
                      return (
                        <span style={{ color: n > 0 ? '#cf1322' : n < 0 ? '#3f8600' : '#999' }}>
                          {n.toFixed(2)}%
                        </span>
                      );
                    },
                  },
                  {
                    title: '原因',
                    dataIndex: 'reason',
                    ellipsis: true,
                  },
                ]}
              />
            </>
          )}
        </>
      )}
    </Card>
  );
};

// ============================================================
// KillSwitchPanel — Phase 4+ 策略熔断状态面板
// ============================================================

const KillSwitchPanel: React.FC = () => {
  const [report, setReport] = useState<KillSwitchMonitorResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await sizingPolicyService.getKillSwitchStatus(true);
      setReport(r);
    } catch (err: any) {
      setError(err?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onApply = useCallback(async () => {
    if (!report || report.triggered === 0) return;
    setApplying(true);
    try {
      const r = await sizingPolicyService.getKillSwitchStatus(false); // 真正禁用
      setReport(r);
      message.success(`已禁用 ${r.triggered} 个触发熔断的策略`);
    } catch (err: any) {
      message.error(err?.message || '执行失败');
    } finally {
      setApplying(false);
    }
  }, [report]);

  return (
    <Card
      className="modern-card"
      title="策略熔断监控 (Phase 4+)"
      extra={
        <Space>
          <Button icon={<ReloadOutlined />} onClick={load} loading={loading} size="small">
            刷新
          </Button>
          {report && report.triggered > 0 && (
            <Button
              danger
              type="primary"
              loading={applying}
              onClick={onApply}
              size="small"
            >
              立即禁用 {report.triggered} 个触发策略
            </Button>
          )}
        </Space>
      }
    >
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
      {report && (
        <>
          <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
            <Col xs={12} sm={8} md={6}>
              <Statistic title="总策略" value={report.total_strategies} />
            </Col>
            <Col xs={12} sm={8} md={6}>
              <Statistic title="已评估" value={report.evaluated} />
            </Col>
            <Col xs={12} sm={8} md={6}>
              <Statistic
                title="触发熔断"
                value={report.triggered}
                valueStyle={{ color: report.triggered > 0 ? '#cf1322' : '#3f8600' }}
              />
            </Col>
            <Col xs={12} sm={8} md={6}>
              <Statistic
                title="样本不足"
                value={report.skipped_insufficient_data}
                valueStyle={{ color: '#666' }}
              />
            </Col>
          </Row>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message={
              <Space wrap>
                <span>
                  共 {report.skipped_no_kill_switch} 个策略未配置 kill_switch
                </span>
                <span>·</span>
                <span>{report.skipped_disabled} 个已禁用</span>
                <span>·</span>
                <span>{report.evaluated} 个评估中</span>
              </Space>
            }
          />
          {report.evaluations.length > 0 && (
            <Table
              size="small"
              dataSource={report.evaluations}
              rowKey="strategy_key"
              pagination={false}
              scroll={{ x: 700 }}
              columns={[
                { title: '策略', dataIndex: 'strategy_key', width: 160 },
                { title: 'metric', dataIndex: 'metric', width: 140 },
                {
                  title: '阈值',
                  dataIndex: 'threshold',
                  width: 80,
                  render: (v: number) => v.toFixed(3),
                },
                {
                  title: '观测值',
                  dataIndex: 'observed_value',
                  width: 100,
                  render: (v: number | null) =>
                    v === null ? <Text type="secondary">—</Text> : v.toFixed(3),
                },
                { title: '样本数', dataIndex: 'sample_size', width: 80 },
                {
                  title: '状态',
                  dataIndex: 'triggered',
                  width: 90,
                  render: (t: boolean, row: any) =>
                    t ? (
                      <Tag color="error">熔断</Tag>
                    ) : row.reason?.startsWith('skipped') ? (
                      <Tag color="default">{row.reason.split(':')[0]}</Tag>
                    ) : (
                      <Tag color="success">正常</Tag>
                    ),
                },
                {
                  title: '原因',
                  dataIndex: 'reason',
                  ellipsis: true,
                },
              ]}
            />
          )}
          {report.errors.length > 0 && (
            <Alert
              type="warning"
              showIcon
              style={{ marginTop: 12 }}
              message={`${report.errors.length} 个策略评估出错`}
              description={
                <ul style={{ marginBottom: 0, paddingLeft: 20 }}>
                  {report.errors.slice(0, 5).map(e => (
                    <li key={e.strategy_key}>
                      <Text code>{e.strategy_key}</Text>: {e.message}
                    </li>
                  ))}
                </ul>
              }
            />
          )}
        </>
      )}
    </Card>
  );
};
