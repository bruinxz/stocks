import React from 'react';
import { Space, Tag, Typography } from 'antd';
import { TaskParameterAuditLog } from '../../services/taskService';

const { Text } = Typography;

type FormatRiskLimitValue = (key: string, value: any) => string;

type Props = {
  audit: TaskParameterAuditLog;
};

type ParameterProps = Props & {
  riskLimitKeyLabels: Record<string, string>;
  formatRiskLimitValue: FormatRiskLimitValue;
};

export const DeploymentAuditSummary: React.FC<Props> = ({ audit }) => {
  if (!String(audit.event_type || '').startsWith('deployment_smoke_')) return null;
  const after = audit.after_parameters || {};
  const metadata = audit.metadata || {};
  const localRegression = after.local_regression || metadata.local_regression;
  const results = Array.isArray(metadata.results) ? metadata.results : [];
  const failures = results.filter((item: any) => item?.status === 'fail');
  return (
    <div className="deployment-audit-summary">
      <div className="deployment-audit-summary__head">
        <div>
          <Text type="secondary">部署验证结论</Text>
          <strong>
            {audit.event_type === 'deployment_smoke_failed'
              ? '未通过'
              : audit.event_type === 'deployment_smoke_skipped'
                ? '已跳过'
                : '已通过'}
          </strong>
        </div>
        <Space wrap size={6}>
          <Tag color={audit.event_type === 'deployment_smoke_failed' ? 'red' : 'green'}>
            API {after.passed || 0}/{Number(after.passed || 0) + Number(after.failed || 0)}
          </Tag>
          {localRegression && (
            <Tag color={localRegression.success ? 'green' : 'red'}>
              本地回归 {localRegression.passed || 0}/{localRegression.total || 0}
            </Tag>
          )}
        </Space>
      </div>
      <div className="deployment-audit-summary__grid">
        <span>失败 {after.failed || 0}</span>
        <span>关键失败 {after.critical_failed || 0}</span>
        <span>可选失败 {after.optional_failed || 0}</span>
        <span>跳过 {after.skipped || 0}</span>
      </div>
      {after.base_url && <Text type="secondary">目标：{after.base_url}</Text>}
      {after.skip_reason && <Tag color="gold">跳过原因：{after.skip_reason}</Tag>}
      {failures.length > 0 && (
        <div className="deployment-audit-summary__failures">
          <Text strong>失败检查点</Text>
          {failures.slice(0, 4).map((item: any, index: number) => (
            <div key={`${item.name || item.path}-${index}`}>
              <Text ellipsis={{ tooltip: item.message }}>
                {item.name || item.path || '未知检查点'}
              </Text>
              <Tag color={item.critical ? 'red' : 'orange'}>{item.critical ? '关键' : '可选'}</Tag>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export const ParameterAuditSummary: React.FC<ParameterProps> = ({
  audit,
  riskLimitKeyLabels,
  formatRiskLimitValue,
}) => {
  if (String(audit.event_type || '').startsWith('deployment_smoke_')) return null;
  const after = audit.after_parameters || {};
  const diffs = audit.diffs || [];
  if (!diffs.length && !audit.changed_keys?.length) return null;
  const fromOutcomeAdvice =
    after.risk_threshold_field_gate_update_source === 'filled_from_outcome_advice';
  const visibleDiffs = diffs.slice(0, 8);
  return (
    <div className="parameter-audit-summary">
      <div className="parameter-audit-summary__head">
        <div>
          <Text type="secondary">参数变更摘要</Text>
          <strong>变更 {audit.changed_keys?.length || diffs.length || 0} 项</strong>
        </div>
        <Space wrap size={6}>
          {fromOutcomeAdvice && <Tag color="cyan">收益后验建议</Tag>}
          {audit.source_loop_run_id && <Tag color="blue">来源闭环</Tag>}
        </Space>
      </div>
      {after.risk_threshold_stability_update_note && (
        <Text type="secondary">说明：{after.risk_threshold_stability_update_note}</Text>
      )}
      <div className="parameter-audit-summary__diffs">
        {visibleDiffs.map(diff => (
          <div key={`${diff.key}-${String(diff.after)}`}>
            <Text>{riskLimitKeyLabels[diff.key] || diff.key}</Text>
            <span>
              {formatRiskLimitValue(diff.key, diff.before)} →{' '}
              <b>{formatRiskLimitValue(diff.key, diff.after)}</b>
            </span>
          </div>
        ))}
      </div>
      {diffs.length > visibleDiffs.length && (
        <Tag>还有 {diffs.length - visibleDiffs.length} 项变更，见完整 JSON</Tag>
      )}
    </div>
  );
};
