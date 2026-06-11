/**
 * SettingsWorkspace.SizingPolicyTab — Phase 2 用户 sizing 策略编辑 UI
 *
 * 三种 method:
 *   - equal_pct (默认, Phase 0 行为): equity * position_pct
 *   - vol_target: 让每个仓位贡献同样年化波动 (RiskParity 简化)
 *   - atr_based: Turtle/Van Tharp ATR 反比 sizing
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
      <Alert
        type="info"
        showIcon
        message="Phase 2 多元化仓位 sizing — 当前为 shadow mode"
        description={
          <Paragraph style={{ marginBottom: 0 }}>
            选择 vol_target / atr_based 后，PaperTradingAutomationService 会在每次下单时**并行计算**新 sizing 结果并写入日志
            (<Text code>[shadow-sizing]</Text>)，但**实际下单仍使用现有 equal_pct 行为**。
            等观察 1-2 周后会切换为硬接入。现在可以提前配置，方便我们对比 shadow 数据。
          </Paragraph>
        }
      />

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
                    <div style={{ fontSize: 11, color: '#888' }}>{o.desc}</div>
                  </div>
                ),
              }))}
            />
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
    </Space>
  );
};

export default SizingPolicyTab;
