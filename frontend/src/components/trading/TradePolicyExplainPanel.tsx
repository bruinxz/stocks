import React from 'react';
import { Alert, Empty, Space, Tag } from 'antd';
import {
  AuditOutlined,
  CheckCircleOutlined,
  ExperimentOutlined,
  SafetyCertificateOutlined,
  StopOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';

type PolicyTone = 'success' | 'warning' | 'danger' | 'info' | 'default';

interface TradePolicyExplainPanelProps {
  policy?: any;
  outcome?: any;
  compact?: boolean;
  title?: string;
  className?: string;
}

const toneToColor: Record<PolicyTone, string> = {
  success: 'green',
  warning: 'gold',
  danger: 'volcano',
  info: 'blue',
  default: 'default',
};

const formatMoney = (value?: number | string | null) => {
  const num = Number(value);
  if (!Number.isFinite(num) || num === 0) return '--';
  return `¥${num.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const formatPercent = (value?: number | string | null, fallback = '--') => {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return `${num.toFixed(2)}%`;
};

const compactText = (value?: any, max = 96) => {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

const pnlColor = (value?: any) => (Number(value || 0) >= 0 ? '#b42318' : '#047857');

const hasValue = (value?: any) => value !== undefined && value !== null && value !== '';

const metric = (label: string, value?: any, options?: { accent?: string }) => (
  <span className="trade-policy-metric" key={label}>
    <em>{label}</em>
    <strong style={options?.accent ? { color: options.accent } : undefined}>
      {hasValue(value) ? value : '--'}
    </strong>
  </span>
);

const TradePolicyExplainPanel: React.FC<TradePolicyExplainPanelProps> = ({
  policy,
  outcome,
  compact = false,
  title = '策略预算 / 风控放行',
  className = '',
}) => {
  const data = policy || {};
  const strategyBudget = data.strategy_budget || {};
  const environmentBudget = data.environment_budget || {};
  const riskGate = data.risk_gate || {};
  const entryGuard = data.entry_risk_guard || {};
  const profitGate = data.profit_gate || {};
  const feedbackGate = data.outcome_feedback || {};
  const dataQuality = data.data_quality || {};
  const outcomeData = { ...(data.outcome || {}), ...(outcome || {}) };
  const available = data.available !== false && Boolean(policy);
  const allowed = data.allowed !== false;
  const chips = Array.isArray(data.chips) ? data.chips : [];

  if (!available) {
    return (
      <div className={`trade-policy-panel ${compact ? 'compact' : ''} ${className}`}>
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="暂无策略预算/风控放行记录，通常是早期历史信号或手动交易。"
        />
      </div>
    );
  }

  return (
    <div className={`trade-policy-panel ${compact ? 'compact' : ''} ${className}`}>
      <div className="trade-policy-head">
        <div>
          <div className="trade-policy-kicker">POLICY REPLAY</div>
          <h3>{title}</h3>
          <p>{compactText(data.reason, compact ? 120 : 220)}</p>
        </div>
        <Tag
          className={`trade-policy-status ${allowed ? 'allowed' : 'blocked'}`}
          icon={allowed ? <CheckCircleOutlined /> : <StopOutlined />}
        >
          {data.headline || (allowed ? '已放行' : '未完全放行')}
        </Tag>
      </div>

      {chips.length > 0 && (
        <div className="trade-policy-chips">
          {chips.slice(0, compact ? 5 : 10).map((chip: any, index: number) => (
            <Tag
              key={`${chip.label || 'chip'}-${index}`}
              color={toneToColor[chip.tone as PolicyTone] || 'blue'}
            >
              {chip.label}：{chip.value}
            </Tag>
          ))}
        </div>
      )}

      <div className="trade-policy-grid">
        <section className="trade-policy-tile strategy">
          <div className="trade-policy-tile-title">
            <ThunderboltOutlined /> 策略预算
          </div>
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            {metric('策略', strategyBudget.strategy_name || strategyBudget.strategy_key)}
            {metric('策略预算', formatPercent(strategyBudget.allocation_pct))}
            {metric('单票上限', formatPercent(strategyBudget.max_single_trade_pct))}
            {metric('单票金额', formatMoney(strategyBudget.max_single_trade_amount))}
          </Space>
          {strategyBudget.reason && <p>{compactText(strategyBudget.reason, compact ? 82 : 140)}</p>}
        </section>

        <section className="trade-policy-tile environment">
          <div className="trade-policy-tile-title">
            <ExperimentOutlined /> 环境预算
          </div>
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            {metric('动作', environmentBudget.action_label || environmentBudget.action)}
            {metric(
              '倍率',
              hasValue(environmentBudget.multiplier)
                ? `${Number(environmentBudget.multiplier).toFixed(2)}x`
                : '--'
            )}
            {metric(
              '策略版本',
              environmentBudget.version_id
                ? `${environmentBudget.version_id}${
                    environmentBudget.version_hash ? ` · ${environmentBudget.version_hash}` : ''
                  }`
                : '--'
            )}
            {metric('市场', environmentBudget.market_regime_label)}
          </Space>
          {(environmentBudget.policy_reason || environmentBudget.reason) && (
            <p>{compactText(environmentBudget.policy_reason || environmentBudget.reason, 140)}</p>
          )}
          {(environmentBudget.guard_action || environmentBudget.rollback_action) && (
            <div className="trade-policy-footnote">
              {environmentBudget.guard_action && (
                <Tag color="gold">保护 {environmentBudget.guard_action}</Tag>
              )}
              {environmentBudget.rollback_action && (
                <Tag color="volcano">回滚 {environmentBudget.rollback_source || '记录'}</Tag>
              )}
            </div>
          )}
        </section>

        <section className={`trade-policy-tile risk ${allowed ? 'success' : 'danger'}`}>
          <div className="trade-policy-tile-title">
            <SafetyCertificateOutlined /> 风控放行
          </div>
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            {metric('组合闸门', riskGate.action_label || riskGate.action || '允许小仓')}
            {metric(
              '默认仓位',
              formatPercent(riskGate.effective_default_position_pct || outcomeData.position_pct)
            )}
            {metric('最大仓位', formatPercent(riskGate.effective_max_position_pct))}
            {metric(
              '今日买入',
              hasValue(entryGuard.today_buy_count)
                ? `${entryGuard.today_buy_count}/${entryGuard.max_daily_new_positions || '--'}`
                : '--'
            )}
          </Space>
          {(riskGate.reason || entryGuard.reason) && (
            <p>{compactText(riskGate.reason || entryGuard.reason, compact ? 90 : 150)}</p>
          )}
          {Array.isArray(entryGuard.risk_notes) && entryGuard.risk_notes.length > 0 && (
            <div className="trade-policy-footnote">
              {entryGuard.risk_notes.slice(0, 2).map((note: string, index: number) => (
                <Tag key={`risk-note-${index}`} color="blue">
                  {compactText(note, 30)}
                </Tag>
              ))}
            </div>
          )}
        </section>

        <section className="trade-policy-tile outcome">
          <div className="trade-policy-tile-title">
            <AuditOutlined /> 后验收益
          </div>
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            {metric('状态', outcomeData.trade_status === 'closed' ? '已平仓' : '跟踪中')}
            {metric(
              '买入/当前',
              `${formatMoney(outcomeData.entry_price)} / ${formatMoney(
                outcomeData.latest_price || outcomeData.exit_price
              )}`
            )}
            {metric('收益', formatMoney(outcomeData.total_pnl), {
              accent: pnlColor(outcomeData.total_pnl),
            })}
            {metric('收益率', formatPercent(outcomeData.total_pnl_pct), {
              accent: pnlColor(outcomeData.total_pnl_pct),
            })}
            {metric('超额', formatPercent(outcomeData.excess_return_pct), {
              accent: pnlColor(outcomeData.excess_return_pct),
            })}
          </Space>
          <div className="trade-policy-footnote">
            {hasValue(outcomeData.holding_days) && <Tag>持有 {outcomeData.holding_days} 天</Tag>}
            {profitGate.enabled && <Tag color="gold">收益闸门 {profitGate.label || '已启用'}</Tag>}
            {feedbackGate.enabled && (
              <Tag color="blue">闭环反哺 {feedbackGate.closed_samples || 0} 样本</Tag>
            )}
            {hasValue(dataQuality.score) && <Tag color="cyan">数据质量 {dataQuality.score}</Tag>}
          </div>
        </section>
      </div>

      {!allowed && (
        <Alert
          className="trade-policy-alert"
          type="warning"
          showIcon
          message="这笔记录存在预算或风控限制"
          description="如果后续仍发生买入，建议重点复盘是否来自人工交易、早期规则、保护回滚或执行侧兜底。"
        />
      )}
    </div>
  );
};

export default TradePolicyExplainPanel;
