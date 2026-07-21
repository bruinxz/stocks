/**
 * TradeReasonCell — AL-3 (2026-06-21)
 *
 * 单元格组件:
 *   - 行内显示 trade_reason_summary (一句话)
 *   - 鼠标 hover / 点击展开 Popover 显示完整 evidence + key_reasons + risk_trigger
 *
 * 用户原话: "当你买入卖出的时候，你需要额外补充上原因，你是怎么判断的要进行这个操作的"
 *
 * 复用在 3 处:
 *   1. PortfolioWorkspace 交易明细 table 的"操作理由"列
 *   2. PortfolioWorkspace 手机端 TradeMobileCard
 *   3. AIStockAnalysisModal action plan 区块 (展示该笔潜在 BUY/SELL 的理由 — 未持仓时
 *      用 mock reason; 已持仓时取 last trade.trade_reason)
 */

import React from 'react';
import { Popover, Tag, Typography, Space, Divider, Empty } from 'antd';
import { InfoCircleOutlined } from '@ant-design/icons';
import type { TradeReasonPayload, TradeReasonSource } from '../../types/tradeReason';

const { Text, Paragraph } = Typography;

const SOURCE_LABEL: Record<TradeReasonSource, string> = {
  manual: '手动',
  auto_buy_from_signals: '自动跟单',
  analysis_engine_hard: '多维分析引擎',
  rebalance: '组合再平衡',
  trailing_stop: '动态止损',
  drawdown_breaker: '回撤断路器',
  industry_concentration: '行业集中度',
  per_stock_stop_loss: '个股止损',
  black_swan: '黑天鹅',
  restricted_share: '限售名单',
  market_regime_alert: '市场告警',
  kill_switch: 'Kill Switch',
  close_position: '一键平仓',
  take_profit: '止盈',
  stop_loss: '止损',
  trailing_take_profit: '动态止盈',
  sell_signal: 'AI 卖出信号',
  technical_breakdown: '技术破位',
  unknown: '未知',
};

const SOURCE_COLOR: Record<TradeReasonSource, string> = {
  manual: 'default',
  auto_buy_from_signals: 'blue',
  analysis_engine_hard: 'purple',
  rebalance: 'cyan',
  trailing_stop: 'orange',
  drawdown_breaker: 'volcano',
  industry_concentration: 'gold',
  per_stock_stop_loss: 'red',
  black_swan: 'magenta',
  restricted_share: 'red',
  market_regime_alert: 'orange',
  kill_switch: 'red',
  close_position: 'default',
  take_profit: 'green',
  stop_loss: 'red',
  trailing_take_profit: 'green',
  sell_signal: 'orange',
  technical_breakdown: 'volcano',
  unknown: 'default',
};

export interface TradeReasonCellProps {
  trade_reason?: TradeReasonPayload | null;
  trade_reason_summary?: string | null;
  /** 列宽限制 — 超出截断 + Popover */
  maxInlineChars?: number;
  /** 紧凑模式: 不显示 source tag, 只 summary */
  compact?: boolean;
}

function ReasonDetailContent({ reason }: { reason: TradeReasonPayload | null | undefined }) {
  if (!reason || !reason.source) {
    return (
      <Empty description="无理由数据 (historical trade)" image={Empty.PRESENTED_IMAGE_SIMPLE} />
    );
  }
  const sourceLabel = SOURCE_LABEL[reason.source] || reason.source;
  return (
    <div style={{ maxWidth: 420 }}>
      <Space wrap size={4} style={{ marginBottom: 8 }}>
        <Tag color={SOURCE_COLOR[reason.source] || 'default'}>{sourceLabel}</Tag>
        {reason.strategy_key && <Tag color="geekblue">策略: {reason.strategy_key}</Tag>}
        {typeof reason.confidence === 'number' && (
          <Tag color="purple">置信 {reason.confidence.toFixed(1)}</Tag>
        )}
        {typeof reason.signal_id === 'number' && (
          <Tag color="default">signal #{reason.signal_id}</Tag>
        )}
      </Space>

      {Array.isArray(reason.evidence) && reason.evidence.length > 0 && (
        <>
          <Text strong>触发依据</Text>
          <ul style={{ paddingLeft: 18, margin: '4px 0 8px 0' }}>
            {reason.evidence.slice(0, 8).map((e, i) => (
              <li key={i}>
                <Text>{e.label}</Text>
                {e.detail && (
                  <>
                    {': '}
                    <Text type="secondary">{e.detail}</Text>
                  </>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {Array.isArray(reason.key_reasons) && reason.key_reasons.length > 0 && (
        <>
          <Divider style={{ margin: '6px 0' }} />
          <Text strong>关键理由</Text>
          <ul style={{ paddingLeft: 18, margin: '4px 0 8px 0' }}>
            {reason.key_reasons.slice(0, 6).map((r, i) => (
              <li key={i}>
                <Text type="secondary">{r}</Text>
              </li>
            ))}
          </ul>
        </>
      )}

      {reason.risk_trigger && (
        <>
          <Divider style={{ margin: '6px 0' }} />
          <Text strong>风控触发</Text>
          <div style={{ marginTop: 4 }}>
            <Text type="secondary">
              type={reason.risk_trigger.type}
              {reason.risk_trigger.indicator && ` · ${reason.risk_trigger.indicator}`}
              {reason.risk_trigger.actual !== undefined && ` · 实际=${reason.risk_trigger.actual}`}
              {reason.risk_trigger.threshold !== undefined &&
                ` · 阈值=${reason.risk_trigger.threshold}`}
            </Text>
          </div>
        </>
      )}

      {reason.ai_summary && (
        <>
          <Divider style={{ margin: '6px 0' }} />
          <Text strong>AI 总结</Text>
          <Paragraph
            type="secondary"
            ellipsis={{ rows: 4, expandable: true, symbol: '展开' }}
            style={{ marginBottom: 0, marginTop: 4 }}
          >
            {reason.ai_summary}
          </Paragraph>
        </>
      )}
    </div>
  );
}

export const TradeReasonCell: React.FC<TradeReasonCellProps> = ({
  trade_reason,
  trade_reason_summary,
  maxInlineChars = 40,
  compact = false,
}) => {
  const hasData =
    !!trade_reason ||
    (typeof trade_reason_summary === 'string' && trade_reason_summary.trim().length > 0);
  if (!hasData) {
    return (
      <Text type="secondary" style={{ fontSize: 12 }}>
        —
      </Text>
    );
  }
  const summary = (trade_reason_summary || '').trim();
  const truncated =
    summary.length > maxInlineChars ? `${summary.slice(0, maxInlineChars - 1)}…` : summary;
  const sourceLabel = trade_reason?.source ? SOURCE_LABEL[trade_reason.source] : '';

  return (
    <Popover
      content={<ReasonDetailContent reason={trade_reason || null} />}
      title="操作理由 (trade_reason)"
      trigger={['hover', 'click']}
      placement="left"
    >
      <Space size={4} style={{ cursor: 'pointer' }}>
        {!compact && trade_reason?.source && (
          <Tag color={SOURCE_COLOR[trade_reason.source] || 'default'} style={{ marginRight: 0 }}>
            {sourceLabel}
          </Tag>
        )}
        <Text style={{ fontSize: 12 }}>{truncated || sourceLabel || '查看'}</Text>
        <InfoCircleOutlined style={{ color: '#1677ff', fontSize: 12 }} />
      </Space>
    </Popover>
  );
};

export default TradeReasonCell;
