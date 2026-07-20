import React from 'react';
import { Alert, Tag, Typography } from 'antd';
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import type {
  AIPriceDecisionPlan,
  AIPriceMarketSnapshot,
} from '../../services/aiStockAnalysisService';
import './AIPriceDecisionCard.css';

const { Text } = Typography;

const FRESHNESS_LABEL: Record<AIPriceMarketSnapshot['freshness'], string> = {
  live: '实时可用',
  same_day: '当日延迟',
  previous_close: '上一收盘',
  stale: '行情过期',
};

function price(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? '—' : `¥${value.toFixed(2)}`;
}

function zone(value: [number, number] | null | undefined): string {
  return value ? `${price(value[0])} – ${price(value[1])}` : '—';
}

function localTime(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString('zh-CN', { hour12: false });
}

export interface AIPriceDecisionCardProps {
  market: AIPriceMarketSnapshot;
  plan: AIPriceDecisionPlan;
}

/**
 * 当前价交易测算票据。视觉采用“研究员手写报价单”：大号现价、双栏价格尺、
 * 明确的数据时间与风险边界，避免把 AI 文本包装成确定收益承诺。
 */
const AIPriceDecisionCard: React.FC<AIPriceDecisionCardProps> = ({ market, plan }) => {
  const change = market.change_percent;
  const changeUp = change != null && change >= 0;
  const actionTone =
    plan.action === 'strong_buy' || plan.action === 'buy'
      ? 'buy'
      : plan.action === 'strong_sell' || plan.action === 'sell'
        ? 'sell'
        : 'wait';

  return (
    <section className={`ai-price-ticket ai-price-ticket--${actionTone}`}>
      <header className="ai-price-ticket__header">
        <div>
          <div className="ai-price-ticket__eyebrow">TRADINGAGENTS · PRICE PLAN</div>
          <div className="ai-price-ticket__quote-line">
            <span className="ai-price-ticket__price">{price(market.current_price)}</span>
            {change != null && (
              <span
                className={`ai-price-ticket__change ${
                  changeUp ? 'ai-price-ticket__change--up' : 'ai-price-ticket__change--down'
                }`}
              >
                {changeUp ? <ArrowUpOutlined /> : <ArrowDownOutlined />}
                {changeUp ? '+' : ''}
                {change.toFixed(2)}%
              </span>
            )}
          </div>
          <div className="ai-price-ticket__timestamp">
            <ClockCircleOutlined /> {localTime(market.quote_time)} · {market.quote_source}
          </div>
        </div>
        <div className="ai-price-ticket__verdict">
          <span>{plan.action_label}</span>
          <Tag color={plan.execution_ready ? 'success' : 'warning'}>
            {plan.execution_ready ? '可形成计划' : '等待确认'}
          </Tag>
          <Tag>{FRESHNESS_LABEL[market.freshness]}</Tag>
        </div>
      </header>

      <div className="ai-price-ticket__grid">
        <div className="ai-price-level ai-price-level--entry">
          <span>计划买入区间</span>
          <strong>{zone(plan.entry_zone)}</strong>
          <small>{plan.position_action_label}</small>
        </div>
        <div className="ai-price-level ai-price-level--exit">
          <span>计划卖出区间</span>
          <strong>{zone(plan.sell_zone)}</strong>
          <small>
            {plan.take_profit != null ? `参考止盈 ${price(plan.take_profit)}` : '现价附近退出'}
          </small>
        </div>
        <div className="ai-price-level">
          <span>风险失效线</span>
          <strong>{price(plan.stop_loss)}</strong>
          <small>跌破后重新评估，不机械补仓</small>
        </div>
        <div className="ai-price-level">
          <span>仓位上限</span>
          <strong>
            {plan.suggested_position_pct != null
              ? `${(plan.suggested_position_pct * 100).toFixed(1)}%`
              : plan.position_action_label}
          </strong>
          <small>
            {plan.suggested_shares != null
              ? `按计划资金约 ${plan.suggested_shares} 股`
              : plan.planned_position_value != null
                ? `约 ${price(plan.planned_position_value)}`
                : '可填写计划资金估算整手数量'}
          </small>
        </div>
      </div>

      <div className="ai-price-ticket__metrics">
        <span>支撑 {price(plan.support_level)}</span>
        <span>压力 {price(plan.resistance_level)}</span>
        <span>ATR(14) {price(plan.atr_14)}</span>
        <span>
          风险收益比{' '}
          {plan.risk_reward_ratio != null ? `${plan.risk_reward_ratio.toFixed(2)} : 1` : '—'}
        </span>
        {plan.holding_pnl_pct != null && (
          <span className={plan.holding_pnl_pct >= 0 ? 'is-up' : 'is-down'}>
            按成本浮盈亏 {plan.holding_pnl_pct >= 0 ? '+' : ''}
            {(plan.holding_pnl_pct * 100).toFixed(2)}%
          </span>
        )}
      </div>

      <div className="ai-price-ticket__basis">
        <div>
          <CheckCircleOutlined /> 测算依据
        </div>
        <ul>
          {plan.decision_basis.slice(0, 4).map(item => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>

      <Alert
        className="ai-price-ticket__notice"
        type={plan.execution_ready ? 'info' : 'warning'}
        showIcon
        icon={<SafetyCertificateOutlined />}
        message={plan.execution_note}
        description={
          plan.risk_warnings.length ? (
            <ul>
              {plan.risk_warnings.slice(0, 4).map(item => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : undefined
        }
      />

      <footer className="ai-price-ticket__footer">
        <Text type="secondary">
          方向来自 TradingAgents；价格来自行情快照与近 60 日波动测算。仅供研究参考，不构成投资建议。
        </Text>
      </footer>
    </section>
  );
};

export default AIPriceDecisionCard;
