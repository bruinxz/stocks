/**
 * SettingsWorkspace.AnalysisEngineTab — US-065 / FE-026
 *
 * 让用户切 AnalysisEngine (analysis-engine 多维度评分服务) 的接入模式 (off/shadow/hard).
 *
 * 行为对比 (与 backend ShadowDoubleRunService 的 cfg.mode 对齐):
 *   - off (默认): AIAdvisorService.analyzeSingleStock 末尾 maybeRunShadow() 立即返回,
 *     零开销, 零旁路写入. analysis_engine 不参与.
 *   - shadow: setImmediate 异步调 AnalysisEngineService.analyzeStock(...), 写一份
 *     `AIStockAnalysisReport(engine_variant='multi_dim_v1', shadow_of_report_id=prod_id)`
 *     用于离线对账; **不**写 AIInvestmentSignal (不污染跟单). 主路径决策完全不变.
 *   - hard: 在 shadow 行为基础上, **追加** 调 archiveAnalysisEngineResult 把决策落
 *     AIInvestmentSignal (source_type=ANALYSIS_ENGINE), 让 PaperTradingAutomationService
 *     真正可以跟单. archive 失败 fail-OPEN, 仅 logger.warn 不阻塞主路径.
 *
 * 配置存于 `User.risk_config.analysis_engine` JSONB:
 *   { mode: 'off'|'shadow'|'hard', enabled_analyzers?: string[], weights?: object }
 *
 * 抄 PortfolioConstructionTab 同款 draft / view 双状态范式 — 用户调多个字段最后一次 Save.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Form, Radio, Space, Tag, Tooltip, Typography, message } from 'antd';
import { QuestionCircleOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import api from '../../services/api';

const { Text, Paragraph } = Typography;

export type AnalysisEngineMode = 'off' | 'shadow' | 'hard';

export interface AnalysisEngineConfig {
  mode: AnalysisEngineMode;
  enabled_analyzers?: string[];
  weights?: Record<string, number>;
}

interface AEConfigResponse {
  config: AnalysisEngineConfig;
  is_default: boolean;
  default: AnalysisEngineConfig;
}

/** Tag tone 与 PortfolioConstructionTab 对齐, 让 ops 跨 tab 一眼认得 mode 风险等级. */
export const MODE_OPTIONS: ReadonlyArray<{
  value: AnalysisEngineMode;
  label: string;
  desc: string;
  tone: string;
}> = Object.freeze([
  Object.freeze({
    value: 'off' as AnalysisEngineMode,
    label: 'Off (默认)',
    desc: '完全跟以前一样 — analysis-engine 不参与, 旁路无任何写入, 零开销',
    tone: 'default',
  }),
  Object.freeze({
    value: 'shadow' as AnalysisEngineMode,
    label: 'Shadow (预演)',
    desc: '后台跑 multi_dim_v1 → 写 AIStockAnalysisReport (engine_variant=multi_dim_v1) 用于对账, 但 **不** 写 AIInvestmentSignal, 跟单流程零变化',
    tone: 'warning',
  }),
  Object.freeze({
    value: 'hard' as AnalysisEngineMode,
    label: 'Hard (真切换)',
    desc: '在 shadow 行为基础上 **追加** 把决策落 AIInvestmentSignal (source_type=ANALYSIS_ENGINE), PaperTradingAutomationService 会真的跟单',
    tone: 'error',
  }),
]);

const AnalysisEngineTab: React.FC = () => {
  const [view, setView] = useState<AEConfigResponse | null>(null);
  const [draft, setDraft] = useState<AnalysisEngineConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await api.get('/risk/analysis-engine-config');
      const data: AEConfigResponse = resp.data?.data;
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
      const resp = await api.put('/risk/analysis-engine-config', draft);
      const next: { config: AnalysisEngineConfig } = resp.data?.data;
      // 重置 view + draft 用 server 归一化后值 — 防止 lenient normalize 让 hasChanges 永真
      setView(prev =>
        prev
          ? { ...prev, config: next.config, is_default: false }
          : { config: next.config, is_default: false, default: next.config }
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
          <span style={{ fontWeight: 600 }}>分析引擎 (AnalysisEngine) 接入</span>
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
        message="L1-L8 决策流水线 · 多维度分析引擎 (analysis-engine) 接入"
        description={
          <div>
            <Paragraph style={{ marginBottom: 4 }}>
              当前模式 <strong>{currentMode}</strong> — {currentModeInfo?.desc}
            </Paragraph>
            <Paragraph style={{ marginBottom: 0, fontSize: 12, color: 'var(--text-muted)' }}>
              建议升级路径: <code>off → shadow</code> 跑一周, 在 LabWorkspace · Shadow Run tab 观察
              consistency_rate / analyzer_health 指标; 数据收敛后 <code>shadow → hard</code>
              真切换. 任何阶段都可一键回 <code>off</code>.
            </Paragraph>
          </div>
        }
      />

      {!draft ? (
        <Alert type="warning" message="加载中..." />
      ) : (
        <Form layout="vertical">
          <Form.Item
            label={
              <Space size={4}>
                <span>接入模式 (mode)</span>
                <Tooltip title="off: 不接入 / shadow: 跑分析仅写对账 report 不影响跟单 / hard: 追加写 AIInvestmentSignal 真跟单">
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

          {currentMode === 'hard' && (
            <Alert
              type="warning"
              showIcon
              style={{ marginTop: 12 }}
              message="Hard 模式提示"
              description={
                <Text style={{ fontSize: 12 }}>
                  Hard 模式会让 analysis-engine 的决策 **直接写入** AIInvestmentSignal
                  (source_type=ANALYSIS_ENGINE), 与 quant_recommendation 信号同等参与
                  PaperTradingAutomationService.autoBuyFromSignals 跟单。建议先在 shadow 模式 跑 ≥ 1
                  周, 在 LabWorkspace 看 consistency_rate ≥ 0.7 再切到 hard。
                </Text>
              }
            />
          )}

          {currentMode === 'shadow' && (
            <Alert
              type="info"
              showIcon
              style={{ marginTop: 12 }}
              message="Shadow 模式提示"
              description={
                <Text style={{ fontSize: 12 }}>
                  Shadow 路径完全 fail-OPEN: 任何 analyzer 失败 / DB 写失败都会被
                  ShadowDoubleRunService 吞掉, 不会影响主推荐结果。打开后可在 LabWorkspace · Shadow
                  Run tab 看到一致性 / analyzer 健康度面板。
                </Text>
              }
            />
          )}
        </Form>
      )}

      <Paragraph style={{ marginTop: 16, fontSize: 11, color: 'var(--text-muted)' }}>
        配置存于 <code>User.risk_config.analysis_engine</code> JSONB. 调用方:{' '}
        <code>backend/src/services/analysis-engine/ShadowDoubleRunService.ts</code>. 修改后{' '}
        <strong>下一次 AIAdvisorService.analyzeSingleStock 调用时生效</strong> (不影响当前已在 loop
        中的批次).
      </Paragraph>
    </Card>
  );
};

export default AnalysisEngineTab;
