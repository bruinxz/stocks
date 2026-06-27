/**
 * SettingsWorkspace.PortfolioConstructionTab — Sprint 30 (基于 Sprint 29 后端)
 *
 * 让用户切 PortfolioConstruction 接入模式 (off / shadow / hard) + 调 method /
 * lookback / max_weight / max_industry_weight / max_candidates 等参数.
 *
 * 行为对比:
 *   - off (默认): adapter 不跑, buy-decision loop 走 per-signal 流程, 零变化
 *   - shadow: adapter 跑构建 + log + activation L4 mark, 但 effectiveTargetPct 不变.
 *     用于"预演" — 让 ActivationDashboard 能看到组合构建会给出什么 weights, 决定是否值得开 hard
 *   - hard: adapter 输出 weight × 100 替换 effectiveTargetPct. 这才真正改变下单行为.
 *
 * draft / view 双状态模式 (US-080 范式) — 用户调多个字段最后一次 Save.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Form,
  InputNumber,
  Radio,
  Row,
  Select,
  Space,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import { QuestionCircleOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import api from '../../services/api';

const { Text, Paragraph } = Typography;

type ConstructionMode = 'off' | 'shadow' | 'hard';
type ConstructionMethod = 'risk_parity' | 'equal_weight' | 'min_variance' | 'max_sharpe' | 'hrp';

interface PortfolioConstructionConfig {
  mode: ConstructionMode;
  method: ConstructionMethod;
  lookback_days: number;
  max_candidates: number;
  max_weight?: number;
  max_industry_weight?: number;
}

interface PCConfigResponse {
  config: PortfolioConstructionConfig;
  is_default: boolean;
  default: PortfolioConstructionConfig;
}

const MODE_OPTIONS: Array<{ value: ConstructionMode; label: string; desc: string; tone: string }> = [
  {
    value: 'off',
    label: 'Off (默认)',
    desc: '完全跟以前一样 — buy-decision loop 走 per-signal 流程, 零行为变化',
    tone: 'default',
  },
  {
    value: 'shadow',
    label: 'Shadow (预演)',
    desc: '后台跑组合构建 + 日志 + Activation Dashboard 可见, 但实际下单仓位**不**替换. 用于"看看会怎样"',
    tone: 'warning',
  },
  {
    value: 'hard',
    label: 'Hard (真切换)',
    desc: '用组合构建输出的 weight × 100 替换 per-signal 仓位. **真正改变下单行为**',
    tone: 'error',
  },
];

const METHOD_OPTIONS: Array<{ value: ConstructionMethod; label: string; desc: string }> = [
  {
    value: 'risk_parity',
    label: 'Risk Parity (ERC, 推荐)',
    desc: '每仓贡献相同风险. 经典 De Prado 法, 适合中等候选数 (3-30)',
  },
  {
    value: 'hrp',
    label: 'HRP (层次聚类)',
    desc: 'López de Prado 2016. 不需要 invert cov 矩阵, 在 N 大时更稳健',
  },
  {
    value: 'min_variance',
    label: 'Min Variance',
    desc: '直接最小化组合方差. 风险厌恶者偏好',
  },
  {
    value: 'max_sharpe',
    label: 'Max Sharpe',
    desc: '最大化期望 sharpe. 需 alpha_score 信号 (signal.confidence_score)',
  },
  {
    value: 'equal_weight',
    label: 'Equal Weight (退化)',
    desc: '等权 1/N. cov_matrix 计算失败时也会自动退化到此',
  },
];

const PortfolioConstructionTab: React.FC = () => {
  const [view, setView] = useState<PCConfigResponse | null>(null);
  const [draft, setDraft] = useState<PortfolioConstructionConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await api.get('/paper-trading/portfolio-construction-config');
      const data: PCConfigResponse = resp.data?.data;
      setView(data);
      setDraft(data?.config || null);
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const hasChanges = useMemo(() => {
    if (!view || !draft) return false;
    return JSON.stringify(draft) !== JSON.stringify(view.config);
  }, [draft, view]);

  const save = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const resp = await api.put('/paper-trading/portfolio-construction-config', draft);
      const next: { config: PortfolioConstructionConfig } = resp.data?.data;
      // 重置 view + draft (用 server 归一化后值 — 防止 lenient normalize 让 hasChanges 永真)
      setView(prev =>
        prev ? { ...prev, config: next.config, is_default: false } : { config: next.config, is_default: false, default: next.config }
      );
      setDraft(next.config);
      message.success(resp.data?.message || '已保存');
    } catch (err: any) {
      message.error(err?.response?.data?.message || err?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  }, [draft]);

  const currentMode = draft?.mode || 'off';
  const currentModeInfo = MODE_OPTIONS.find(o => o.value === currentMode);

  return (
    <Card
      className="modern-card"
      variant="borderless"
      size="small"
      title={
        <Space>
          <span style={{ fontWeight: 600 }}>组合构建 (PortfolioConstruction) 接入</span>
          {view?.is_default && <Tag>系统默认</Tag>}
          {hasChanges && <Tag color="warning">有未保存的改动</Tag>}
        </Space>
      }
      extra={
        <Space>
          <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={load}>
            刷新
          </Button>
          <Button
            type="primary"
            size="small"
            icon={<SaveOutlined />}
            loading={saving}
            disabled={!hasChanges}
            onClick={save}
          >
            保存
          </Button>
        </Space>
      }
    >
      {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 12 }} />}

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="L1-L8 决策流水线第 4 层 (L4 组合) 接入"
        description={
          <div>
            <Paragraph style={{ marginBottom: 4 }}>
              当前模式 <strong>{currentMode}</strong> — {currentModeInfo?.desc}
            </Paragraph>
            <Paragraph style={{ marginBottom: 0, fontSize: 12, color: 'var(--text-muted)' }}>
              建议升级路径: <code>off → shadow</code> 看一周 Activation Dashboard 上 L4 数据,
              确认组合构建的权重分布是否合理, 再 <code>shadow → hard</code> 真切换.
              任何阶段都可一键回 <code>off</code>.
            </Paragraph>
          </div>
        }
      />

      {!draft ? (
        <Alert type="warning" message="加载中..." />
      ) : (
        <Form layout="vertical">
          <Row gutter={[16, 8]}>
            <Col xs={24}>
              <Form.Item
                label={
                  <Space size={4}>
                    <span>接入模式 (mode)</span>
                    <Tooltip title="off: 不接入 / shadow: 跑构建仅 log 不改下单 / hard: 用 weight 替换下单仓位">
                      <QuestionCircleOutlined style={{ color: 'var(--text-muted)' }} />
                    </Tooltip>
                  </Space>
                }
              >
                <Radio.Group
                  value={draft.mode}
                  onChange={e => setDraft(prev => (prev ? { ...prev, mode: e.target.value } : prev))}
                  style={{ width: '100%' }}
                >
                  <Space direction="vertical" style={{ width: '100%' }}>
                    {MODE_OPTIONS.map(opt => (
                      <Radio key={opt.value} value={opt.value} style={{ width: '100%' }}>
                        <Space>
                          <Tag color={opt.tone}>{opt.label}</Tag>
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            {opt.desc}
                          </Text>
                        </Space>
                      </Radio>
                    ))}
                  </Space>
                </Radio.Group>
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={[16, 8]} style={{ marginTop: 8 }}>
            <Col xs={24} md={12}>
              <Form.Item
                label={
                  <Space size={4}>
                    <span>求解方法 (method)</span>
                    <Tooltip title="risk_parity 是 De Prado 推荐默认; HRP 在 N 大时更稳健; max_sharpe 需要 alpha_score 强信号">
                      <QuestionCircleOutlined style={{ color: 'var(--text-muted)' }} />
                    </Tooltip>
                  </Space>
                }
              >
                <Select
                  value={draft.method}
                  onChange={v => setDraft(prev => (prev ? { ...prev, method: v } : prev))}
                  options={METHOD_OPTIONS.map(o => ({
                    value: o.value,
                    label: o.label,
                    title: o.desc,
                  }))}
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item
                label={
                  <Space size={4}>
                    <span>历史回看天数 (lookback_days)</span>
                    <Tooltip title="cov_matrix 估算用的历史 daily_returns 长度. LedoitWolf 需要 T >> N, 范围 [20, 252]">
                      <QuestionCircleOutlined style={{ color: 'var(--text-muted)' }} />
                    </Tooltip>
                  </Space>
                }
              >
                <InputNumber
                  min={20}
                  max={252}
                  value={draft.lookback_days}
                  onChange={v =>
                    setDraft(prev =>
                      prev ? { ...prev, lookback_days: Number(v ?? 60) } : prev
                    )
                  }
                  style={{ width: '100%' }}
                  addonAfter="天"
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item
                label={
                  <Space size={4}>
                    <span>候选池上限 (max_candidates)</span>
                    <Tooltip title="按 alpha_score 降序取 top-N candidates 进入构建. 0=不限制. 大候选 (>50) 会拖慢 ERC 收敛">
                      <QuestionCircleOutlined style={{ color: 'var(--text-muted)' }} />
                    </Tooltip>
                  </Space>
                }
              >
                <InputNumber
                  min={0}
                  max={200}
                  value={draft.max_candidates}
                  onChange={v =>
                    setDraft(prev =>
                      prev ? { ...prev, max_candidates: Number(v ?? 30) } : prev
                    )
                  }
                  style={{ width: '100%' }}
                  addonAfter="只"
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item
                label={
                  <Space size={4}>
                    <span>单股权重上限 (max_weight)</span>
                    <Tooltip title="单只票最大权重. 默认 0.15 (15%). 配合 max_position_pct 风控双重约束">
                      <QuestionCircleOutlined style={{ color: 'var(--text-muted)' }} />
                    </Tooltip>
                  </Space>
                }
              >
                <InputNumber
                  min={0.01}
                  max={1}
                  step={0.01}
                  value={draft.max_weight}
                  onChange={v =>
                    setDraft(prev =>
                      prev ? { ...prev, max_weight: Number(v ?? 0.15) } : prev
                    )
                  }
                  style={{ width: '100%' }}
                  addonAfter="比例 (0-1)"
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item
                label={
                  <Space size={4}>
                    <span>行业权重上限 (max_industry_weight)</span>
                    <Tooltip title="单行业最大权重. 默认 0.40 (40%). 配合 risk/IndustryConcentrationGuard 双重约束">
                      <QuestionCircleOutlined style={{ color: 'var(--text-muted)' }} />
                    </Tooltip>
                  </Space>
                }
              >
                <InputNumber
                  min={0.05}
                  max={1}
                  step={0.05}
                  value={draft.max_industry_weight}
                  onChange={v =>
                    setDraft(prev =>
                      prev ? { ...prev, max_industry_weight: Number(v ?? 0.4) } : prev
                    )
                  }
                  style={{ width: '100%' }}
                  addonAfter="比例 (0-1)"
                />
              </Form.Item>
            </Col>
          </Row>

          {currentMode === 'hard' && (
            <Alert
              type="warning"
              showIcon
              style={{ marginTop: 12 }}
              message="Hard 模式提示"
              description={
                <Text style={{ fontSize: 12 }}>
                  Hard 模式会直接替换每笔信号的下单仓位为组合构建输出的 weight × 100.
                  历史数据不足的候选会被 PortfolioConstructionService 退化为 equal_weight;
                  cov 矩阵无法估算时 adapter 返回 null 走 fail-open (回退到 per-signal).
                  建议先在 shadow 模式跑 ≥ 1 周再切到 hard.
                </Text>
              }
            />
          )}
        </Form>
      )}

      <Paragraph style={{ marginTop: 16, fontSize: 12, color: 'var(--text-muted)' }}>
        配置存于 <code>User.risk_config.portfolio_construction</code> JSONB. 调用方:{' '}
        <code>backend/src/portfolio/internal/PortfolioConstructionAdapter.ts</code>.
        修改后 <strong>下一次 autopilot cron 跑时生效</strong> (不影响当前已在 loop 中的批次).
      </Paragraph>
    </Card>
  );
};

export default PortfolioConstructionTab;
