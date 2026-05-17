import React from 'react';
import { Alert, Button, Empty, Modal, Space, Tag, Typography } from 'antd';
import { ReloadOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { RiskLimitSuggestionApplyResult } from '../../services/taskService';

const { Text } = Typography;

type Props = {
  open: boolean;
  loading: boolean;
  preview: RiskLimitSuggestionApplyResult | null;
  riskFieldGateAdvice?: any;
  riskFieldGateAdjustmentAttribution?: any;
  riskFieldGateSuggestedParams: Record<string, any>;
  riskLimitKeyLabels: Record<string, string>;
  riskLimitKeyPriority: Record<string, number>;
  onCancel: () => void;
  onPreview: () => void;
  onApply: () => void;
  formatPercent: (value?: number | string | null) => string;
  formatRiskLimitValue: (key: string, value: any) => string;
  getRiskFieldEvidenceScore: (evidence: any) => number;
};

const decisionColor = (action?: string) =>
  action === 'support' ? 'green' : action === 'caution' ? 'orange' : action === 'observe' ? 'blue' : 'default';

export const RiskLimitPreviewModal: React.FC<Props> = ({
  open,
  loading,
  preview,
  riskFieldGateAdvice,
  riskFieldGateAdjustmentAttribution,
  riskFieldGateSuggestedParams,
  riskLimitKeyLabels,
  riskLimitKeyPriority,
  onCancel,
  onPreview,
  onApply,
  formatPercent,
  formatRiskLimitValue,
  getRiskFieldEvidenceScore,
}) => (
  <Modal
    title={
      <Space>
        <SafetyCertificateOutlined />
        风险阈值建议应用预览
      </Space>
    }
    open={open}
    onCancel={onCancel}
    width={860}
    footer={[
      <Button key="close" onClick={onCancel}>
        关闭
      </Button>,
      <Button key="preview" icon={<ReloadOutlined />} loading={loading} onClick={onPreview}>
        重新预览
      </Button>,
      <Button
        key="apply"
        type="primary"
        loading={loading}
        disabled={!preview?.changes?.length || preview.applied || !preview.stability?.can_apply}
        onClick={onApply}
      >
        {preview?.applied ? '已应用' : '确认应用到任务'}
      </Button>,
    ]}
  >
    {preview ? (
      <Space direction="vertical" size={14} style={{ width: '100%' }}>
        <Alert
          type={preview.applied ? 'success' : 'info'}
          showIcon
          message={preview.message}
          description={
            <Space direction="vertical" size={4}>
              <Text type="secondary">
                来源闭环：{preview.source_loop_run_id || '-'} · 动作：{preview.action || 'observe'}
              </Text>
              {preview.stability && (
                <Space wrap>
                  <Tag color={preview.stability.can_apply ? 'green' : 'blue'}>
                    {preview.stability.label}
                  </Tag>
                  <Text type="secondary">
                    连续同向 {preview.stability.consecutive_same_action} 次 / 置信度{' '}
                    {formatPercent((preview.stability.confidence || 0) * 100)}
                  </Text>
                </Space>
              )}
              {preview.stability?.reason && <Text>{preview.stability.reason}</Text>}
              {preview.reason && <Text>{preview.reason}</Text>}
            </Space>
          }
        />

        {riskFieldGateAdvice && (
          <div className="risk-field-gate-advice">
            <Text strong>字段门槛后验参考</Text>
            <Text type="secondary">
              {riskFieldGateAdvice.conclusion || '暂无明确字段级门槛调整信号。'}
            </Text>
            {riskFieldGateAdjustmentAttribution?.decision && (
              <div className="risk-field-gate-decision">
                <Space wrap size={8}>
                  <Tag color={decisionColor(riskFieldGateAdjustmentAttribution.decision.action)}>
                    {riskFieldGateAdjustmentAttribution.decision.label ||
                      riskFieldGateAdjustmentAttribution.decision.action}
                  </Tag>
                  <Text type="secondary">
                    人工采纳后验 · 置信度{' '}
                    {formatPercent(
                      Number(riskFieldGateAdjustmentAttribution.decision.confidence || 0) * 100
                    )}
                  </Text>
                </Space>
                <Text type="secondary">{riskFieldGateAdjustmentAttribution.decision.reason}</Text>
              </div>
            )}
            {riskFieldGateAdvice.current_parameters && (
              <Space wrap size={[6, 6]}>
                <Tag>
                  置信≥
                  {Number(
                    riskFieldGateAdvice.current_parameters.risk_threshold_field_min_confidence ?? 0.45
                  ).toFixed(2)}
                </Tag>
                <Tag>
                  样本≥
                  {riskFieldGateAdvice.current_parameters.risk_threshold_field_min_sample_count ?? 3}
                </Tag>
                <Tag>
                  触发≥
                  {riskFieldGateAdvice.current_parameters.risk_threshold_field_min_triggered_count ??
                    1}
                </Tag>
                <Tag>
                  同向≥
                  {riskFieldGateAdvice.current_parameters
                    .risk_threshold_field_stability_min_consecutive_same_action ?? 2}
                </Tag>
              </Space>
            )}
            {Object.keys(riskFieldGateSuggestedParams).length > 0 && (
              <Space direction="vertical" size={4}>
                {Object.entries(riskFieldGateSuggestedParams).map(([key, value]) => (
                  <Text type="secondary" key={key}>
                    {riskLimitKeyLabels[key] || key}：
                    {formatRiskLimitValue(key, riskFieldGateAdvice.current_parameters?.[key])} →{' '}
                    {formatRiskLimitValue(key, value)}
                  </Text>
                ))}
              </Space>
            )}
            <Text type="secondary">本次确认只写入风险阈值，不会自动修改字段级证据门槛。</Text>
          </div>
        )}

        {preview.changes?.length ? (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            {preview.changes.map(change => (
              <div className="risk-limit-preview-card" key={change.id}>
                <div className="risk-limit-preview-card__head">
                  <div>
                    <Text strong>{change.name}</Text>
                    <div>
                      <Tag color="blue">{change.type}</Tag>
                      <Text type="secondary">更新 {change.changed_keys.length} 个阈值</Text>
                    </div>
                  </div>
                  <Tag color={preview.applied ? 'green' : 'gold'}>
                    {preview.applied ? '已写入' : '待确认'}
                  </Tag>
                </div>
                <div className="risk-limit-diff-grid">
                  {change.diffs.map(diff => (
                    <div className="risk-limit-diff-item" key={`${change.id}-${diff.key}`}>
                      <Text type="secondary">{riskLimitKeyLabels[diff.key] || diff.key}</Text>
                      <div>
                        <span>{formatRiskLimitValue(diff.key, diff.current_value)}</span>
                        <strong>→</strong>
                        <b>{formatRiskLimitValue(diff.key, diff.suggested_value)}</b>
                      </div>
                      {change.field_evidence?.[diff.key] && (
                        <Text
                          type={change.field_evidence[diff.key].can_apply ? 'secondary' : 'warning'}
                          className="risk-limit-field-evidence"
                        >
                          字段证据：
                          {change.field_evidence[diff.key].can_apply ? '已放行' : '观察'} · 样本{' '}
                          {change.field_evidence[diff.key].triggered_count || 0}/
                          {change.field_evidence[diff.key].sample_count || 0} · 同向{' '}
                          {change.field_evidence[diff.key].stability?.consecutive_same_action || 0}/
                          {change.field_evidence[diff.key].stability?.min_consecutive_same_action ||
                            2}{' '}
                          · 门槛：置信≥
                          {Number(
                            change.field_evidence[diff.key].stability?.min_confidence ?? 0.45
                          ).toFixed(2)}
                          ，样本≥
                          {change.field_evidence[diff.key].stability?.min_sample_count || 3}，触发≥
                          {change.field_evidence[diff.key].stability?.min_triggered_count || 1}
                        </Text>
                      )}
                    </div>
                  ))}
                </div>
                {Object.entries(change.field_evidence || {}).some(
                  ([key, evidence]) => !evidence?.can_apply && !change.changed_keys.includes(key)
                ) && (
                  <div className="risk-limit-observe-strip">
                    <Text strong>观察未写入</Text>
                    <Space wrap size={[6, 6]}>
                      {Object.entries(change.field_evidence || {})
                        .filter(
                          ([key, evidence]) =>
                            !evidence?.can_apply && !change.changed_keys.includes(key)
                        )
                        .sort(
                          ([leftKey, leftEvidence], [rightKey, rightEvidence]) =>
                            (riskLimitKeyPriority[leftKey] || 99) -
                              (riskLimitKeyPriority[rightKey] || 99) ||
                            getRiskFieldEvidenceScore(rightEvidence) -
                              getRiskFieldEvidenceScore(leftEvidence)
                        )
                        .slice(0, 4)
                        .map(([key, evidence]) => (
                          <Tag key={`${change.id}-${key}-observe`} color="default">
                            {riskLimitKeyLabels[key] || key} · {evidence?.reason || '证据不足'}
                          </Tag>
                        ))}
                    </Space>
                  </div>
                )}
              </div>
            ))}
          </Space>
        ) : (
          <Empty description="当前关键任务参数已经与建议一致，无需应用" />
        )}
      </Space>
    ) : (
      <Empty description="请先点击预览差异" />
    )}
  </Modal>
);
