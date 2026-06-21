/**
 * tradeReasonBuilder — AL-3 (2026-06-21)
 *
 * 把不同 BUY/SELL 写入入口的"为什么这笔交易发生"压成统一 JSONB 写回
 * paper_trading_trades.trade_reason + trade_reason_summary.
 *
 * 用户原话: "当你买入卖出的时候，你需要额外补充上原因，你是怎么判断的要进行这个操作的。"
 *
 * 6+ 写入入口:
 *   1. PaperTradingFacade._placeOrderInner BUY   → manual / caller-supplied reason
 *   2. PaperTradingFacade._placeOrderInner SELL  → manual / 强平 / 透传 caller reason
 *   3. PaperTradingAutomationService.createBuyTrade → buildTradeReasonFromSignal
 *   4. PaperTradingAutomationService.createSellTrade (run-risk-check)
 *      → buildTradeReasonFromRiskGuard(exitReason, ...)
 *   5. GuardSellExecutor.executeGuardSells → 透传给 facade.placeOrder
 *   6. IndustryConcentrationGuard / RebalanceEngine → buildTradeReasonFromRiskGuard
 *
 * 设计原则:
 *   - **fail-safe**: 任何分支失败 / 信号缺字段 → 返回 source='unknown' + 1 条占位 evidence,
 *     不破写 trade 链路 (因为这条 reason 不写满不影响成交).
 *   - **简短可读**: summary ≤ 120 字符, evidence label ≤ 30 字符. UI table cell 一行装得下.
 *   - **可追溯**: signal_id / ai_report_id / strategy_key 都进结构化字段, 后续 RCA cron
 *     可按 source group by 统计 "本周自动跟单 12 笔, 风控强平 3 笔".
 */

export type TradeReasonSource =
  | 'manual'
  | 'auto_buy_from_signals'
  | 'analysis_engine_hard'
  | 'rebalance'
  | 'trailing_stop'
  | 'drawdown_breaker'
  | 'industry_concentration'
  | 'per_stock_stop_loss'
  | 'black_swan'
  | 'restricted_share'
  | 'market_regime_alert'
  | 'kill_switch'
  | 'close_position'
  | 'take_profit'
  | 'stop_loss'
  | 'trailing_take_profit'
  | 'sell_signal'
  | 'technical_breakdown'
  | 'unknown';

export interface TradeReasonEvidence {
  label: string;
  detail?: string;
  weight?: number;
}

export interface TradeReason {
  source: TradeReasonSource;
  strategy_key?: string;
  signal_id?: number;
  ai_report_id?: string;
  evidence: TradeReasonEvidence[];
  confidence?: number;
  key_reasons: string[];
  risk_trigger?: {
    type: string;
    threshold?: number;
    actual?: number;
    indicator?: string;
  };
  ai_summary?: string;
}

const MAX_EVIDENCE = 8;
const MAX_KEY_REASONS = 6;
const MAX_SUMMARY_CHARS = 200;

function toFiniteNumber(v: any): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function pickString(...candidates: any[]): string | undefined {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return undefined;
}

function uniqStringArray(input: any, limit: number): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    if (typeof item !== 'string') continue;
    const t = item.trim();
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 从 AI signal + AI report 构造 BUY reason. signal/aiReport 缺字段 / null 都 OK,
 * 返回的 evidence 会尽量塞满 (strategy / score / factors / market_environment).
 */
export function buildTradeReasonFromSignal(
  signal:
    | {
        id?: number;
        strategy_key?: string;
        score?: number | string;
        confidence_score?: number | string;
        factors?: any;
        reasons?: any;
        rationale?: string;
        market_environment?: any;
        metadata?: any;
        source_type?: string;
        source_id?: string;
      }
    | null
    | undefined,
  aiReport?: {
    id?: number | string;
    confidence_score?: number | string;
    key_points?: any;
    recommendation?: string;
    ai_summary?: string;
  } | null
): TradeReason {
  const meta = (signal as any)?.metadata || {};
  const strategyKey = pickString(
    (signal as any)?.strategy_key,
    meta?.strategy_key,
    meta?.signal_metadata?.strategy_key
  );

  const score = toFiniteNumber((signal as any)?.confidence_score ?? (signal as any)?.score);
  const aiConfidence = toFiniteNumber(aiReport?.confidence_score);
  const confidence = aiConfidence ?? score;

  const evidence: TradeReasonEvidence[] = [];

  if (strategyKey) {
    evidence.push({
      label: `策略: ${strategyKey}`,
      detail: score !== undefined ? `score=${score.toFixed(1)}` : undefined,
      weight: score,
    });
  }

  // 从 metadata.factors / signal.factors 拿因子明细
  const factorsRaw = (signal as any)?.factors ?? meta?.factors ?? meta?.signal_factors ?? null;
  if (factorsRaw && typeof factorsRaw === 'object') {
    const entries = Array.isArray(factorsRaw)
      ? factorsRaw
          .filter((x: any) => x && (x.label || x.name))
          .map((x: any) => ({
            label: String(x.label || x.name).slice(0, 30),
            detail: x.value !== undefined ? `value=${x.value}` : x.detail || undefined,
            weight: toFiniteNumber(x.weight ?? x.score),
          }))
      : Object.entries(factorsRaw)
          .slice(0, 6)
          .map(([k, v]) => ({
            label: String(k).slice(0, 30),
            detail: v !== null && v !== undefined ? String(v).slice(0, 80) : undefined,
          }));
    for (const e of entries) {
      if (evidence.length >= MAX_EVIDENCE) break;
      evidence.push(e);
    }
  }

  // market_environment 概要
  const env = (signal as any)?.market_environment ?? meta?.market_environment;
  if (env && typeof env === 'object') {
    const regime = pickString(env.market_regime, env.regime);
    const breadth = toFiniteNumber(env.breadth?.up_20d_ratio ?? env.up_20d_ratio);
    const vol = toFiniteNumber(env.volatility_pct ?? env.recent_volatility_pct);
    const parts: string[] = [];
    if (regime) parts.push(`regime=${regime}`);
    if (breadth !== undefined) parts.push(`breadth=${(breadth * 100).toFixed(0)}%`);
    if (vol !== undefined) parts.push(`vol=${(vol * 100).toFixed(1)}%`);
    if (parts.length > 0 && evidence.length < MAX_EVIDENCE) {
      evidence.push({ label: '市场环境', detail: parts.join(', ') });
    }
  }

  // AI key_points
  if (aiReport?.key_points && evidence.length < MAX_EVIDENCE) {
    const pts = uniqStringArray(aiReport.key_points, 3);
    for (const p of pts) {
      if (evidence.length >= MAX_EVIDENCE) break;
      evidence.push({ label: 'AI 要点', detail: p.slice(0, 80) });
    }
  }

  // signal.reasons (string[])
  const reasonsList = uniqStringArray(
    (signal as any)?.reasons ?? meta?.reasons ?? meta?.signal_reasons,
    MAX_KEY_REASONS
  );

  // 兜底: rationale 拆 ; / ；
  let keyReasons = reasonsList;
  if (keyReasons.length === 0) {
    const rationale = pickString((signal as any)?.rationale, meta?.rationale);
    if (rationale) {
      keyReasons = uniqStringArray(
        rationale.split(/[;；\n]/).map(s => s.trim()),
        MAX_KEY_REASONS
      );
    }
  }

  // 若 evidence 依然空, 至少占位
  if (evidence.length === 0) {
    evidence.push({
      label: strategyKey ? `策略: ${strategyKey}` : '自动跟单',
      detail: score !== undefined ? `score=${score.toFixed(1)}` : '来自 AI signal',
    });
  }

  const sourceType = pickString((signal as any)?.source_type);
  const isAnalysisEngine = sourceType === 'analysis_engine';

  return {
    source: isAnalysisEngine ? 'analysis_engine_hard' : 'auto_buy_from_signals',
    strategy_key: strategyKey,
    signal_id: toFiniteNumber((signal as any)?.id),
    ai_report_id: aiReport?.id !== undefined ? String(aiReport.id) : undefined,
    evidence: evidence.slice(0, MAX_EVIDENCE),
    confidence,
    key_reasons: keyReasons,
    ai_summary: pickString(aiReport?.ai_summary, aiReport?.recommendation),
  };
}

/**
 * Risk guard 触发的 SELL — 把 guard 名 + 触发上下文转 reason.
 */
export function buildTradeReasonFromRiskGuard(
  guardName: string,
  context: {
    position?: { symbol?: string; quantity?: number; avg_cost?: number; current_price?: number };
    threshold?: number;
    actual?: number;
    indicator?: string;
    detail?: Record<string, any>;
    message?: string;
  } = {}
): TradeReason {
  const norm = String(guardName || '').toLowerCase();
  const sourceMap: Record<string, TradeReasonSource> = {
    trailing_stop: 'trailing_stop',
    trailing_take_profit: 'trailing_take_profit',
    take_profit: 'take_profit',
    stop_loss: 'stop_loss',
    per_stock_stop_loss: 'per_stock_stop_loss',
    per_stock_mass: 'per_stock_stop_loss',
    drawdown_breaker: 'drawdown_breaker',
    drawdown_level_2: 'drawdown_breaker',
    drawdown_level_3: 'drawdown_breaker',
    industry_concentration: 'industry_concentration',
    black_swan: 'black_swan',
    restricted_share: 'restricted_share',
    market_regime_alert: 'market_regime_alert',
    kill_switch: 'kill_switch',
    rebalance: 'rebalance',
    close_position: 'close_position',
    sell_signal: 'sell_signal',
    technical_breakdown: 'technical_breakdown',
  };
  const source: TradeReasonSource = sourceMap[norm] || 'unknown';

  const evidence: TradeReasonEvidence[] = [];
  const keyReasons: string[] = [];

  const labelMap: Record<TradeReasonSource, string> = {
    trailing_stop: '触发动态止损 (回撤超阈)',
    trailing_take_profit: '触发动态止盈 (高点回落)',
    take_profit: '触发止盈线',
    stop_loss: '触发止损线',
    per_stock_stop_loss: '触发个股止损',
    drawdown_breaker: '组合回撤断路器触发',
    industry_concentration: '行业集中度超限再平衡',
    black_swan: '黑天鹅事件触发清仓',
    restricted_share: '限售/限制股名单触发',
    market_regime_alert: '市场环境恶化告警',
    kill_switch: '策略 Kill Switch 触发',
    rebalance: '组合再平衡',
    close_position: '用户显式平仓',
    sell_signal: 'AI 卖出信号',
    technical_breakdown: '技术破位 (跌破 MA20 + 放量)',
    auto_buy_from_signals: '自动跟单',
    analysis_engine_hard: '多维分析引擎 hard',
    manual: '手动',
    unknown: '未知风控触发',
  };

  const headline = labelMap[source] || `风控触发: ${guardName}`;
  evidence.push({ label: headline, detail: context.message?.slice(0, 80) });
  keyReasons.push(headline);

  if (context.threshold !== undefined && context.actual !== undefined) {
    const detail = `${context.indicator || 'value'}: ${context.actual} (阈值 ${context.threshold})`;
    evidence.push({ label: '阈值对比', detail });
    keyReasons.push(detail);
  } else if (context.actual !== undefined) {
    evidence.push({
      label: '触发值',
      detail: `${context.indicator || 'value'}=${context.actual}`,
    });
  }

  if (context.position) {
    const { quantity, avg_cost, current_price, symbol } = context.position;
    if (current_price !== undefined && avg_cost !== undefined && Number(avg_cost) > 0) {
      const pnlPct = (Number(current_price) - Number(avg_cost)) / Number(avg_cost);
      evidence.push({
        label: '持仓盈亏',
        detail: `${symbol || ''} qty=${quantity ?? '-'} pnl=${(pnlPct * 100).toFixed(2)}%`,
      });
    }
  }

  if (context.detail) {
    const detailKeys = Object.keys(context.detail).slice(0, 3);
    for (const k of detailKeys) {
      if (evidence.length >= MAX_EVIDENCE) break;
      const v = context.detail[k];
      if (v === null || v === undefined) continue;
      evidence.push({ label: k, detail: String(v).slice(0, 80) });
    }
  }

  return {
    source,
    evidence: evidence.slice(0, MAX_EVIDENCE),
    key_reasons: uniqStringArray(keyReasons, MAX_KEY_REASONS),
    risk_trigger: {
      type: guardName,
      threshold: toFiniteNumber(context.threshold),
      actual: toFiniteNumber(context.actual),
      indicator: context.indicator,
    },
  };
}

/**
 * 手动下单 (UI 点买/卖). caller 通常没传 reason — 给一个简单占位.
 * 若 caller 传了 reason/notes (例如 closePosition 强平), 进 evidence.
 */
export function buildTradeReasonForManualOrder(
  orderInput?: {
    reason?: string;
    notes?: string;
    source?: TradeReasonSource;
  } | null
): TradeReason {
  const source = orderInput?.source || 'manual';
  const evidence: TradeReasonEvidence[] = [];
  const keyReasons: string[] = [];
  const text = pickString(orderInput?.reason, orderInput?.notes);
  if (text) {
    evidence.push({ label: '用户备注', detail: text.slice(0, 120) });
    keyReasons.push(text.slice(0, 120));
  } else if (source === 'close_position') {
    evidence.push({ label: '用户显式平仓', detail: '通过 UI 一键平仓按钮触发' });
    keyReasons.push('用户显式平仓');
  } else {
    evidence.push({ label: '手动下单', detail: '用户通过 UI 直接下单 (未填理由)' });
    keyReasons.push('手动下单');
  }
  return {
    source,
    evidence,
    key_reasons: keyReasons,
  };
}

/**
 * 把 TradeReason 压成一句话总结. ≤ 200 字符. UI 列表 / 周报 / 飞书消息直接用.
 */
export function summarizeTradeReason(reason: TradeReason | null | undefined): string {
  if (!reason || typeof reason !== 'object') return '';
  const isBuy =
    !/(stop|drawdown|industry|black_swan|restricted|kill|rebalance|close|sell_signal|technical)/.test(
      reason.source
    );
  const verb = isBuy ? '买入' : '卖出';

  const labelMap: Record<TradeReasonSource, string> = {
    manual: '手动',
    auto_buy_from_signals: '自动跟单',
    analysis_engine_hard: '多维分析引擎',
    rebalance: '再平衡',
    trailing_stop: '动态止损',
    drawdown_breaker: '回撤断路器',
    industry_concentration: '行业集中度',
    per_stock_stop_loss: '个股止损',
    black_swan: '黑天鹅',
    restricted_share: '限售名单',
    market_regime_alert: '市场告警',
    kill_switch: 'Kill Switch',
    close_position: '一键平仓',
    take_profit: '止盈线',
    stop_loss: '止损线',
    trailing_take_profit: '动态止盈',
    sell_signal: 'AI 卖出信号',
    technical_breakdown: '技术破位',
    unknown: '未知',
  };

  const head = `${verb}: ${labelMap[reason.source] || reason.source}`;
  const parts: string[] = [head];

  if (reason.strategy_key) parts.push(`策略 ${reason.strategy_key}`);
  if (reason.confidence !== undefined && Number.isFinite(reason.confidence)) {
    parts.push(`置信 ${Number(reason.confidence).toFixed(1)}`);
  }

  const topReasons = Array.isArray(reason.key_reasons)
    ? reason.key_reasons.slice(0, 3).filter(s => s && s.length > 0)
    : [];
  if (topReasons.length > 0) {
    parts.push(topReasons.join(' + '));
  } else if (Array.isArray(reason.evidence) && reason.evidence.length > 0) {
    const top = reason.evidence
      .slice(0, 3)
      .map(e => (e.label ? `${e.label}${e.detail ? ` (${e.detail})` : ''}` : ''))
      .filter(Boolean);
    if (top.length > 0) parts.push(top.join(' + '));
  }

  if (reason.risk_trigger?.actual !== undefined && reason.risk_trigger?.threshold !== undefined) {
    parts.push(
      `${reason.risk_trigger.indicator || 'value'}=${reason.risk_trigger.actual} (阈 ${
        reason.risk_trigger.threshold
      })`
    );
  }

  const out = parts.join(' | ');
  return out.length > MAX_SUMMARY_CHARS ? `${out.slice(0, MAX_SUMMARY_CHARS - 1)}…` : out;
}

/** convenience — pack reason + summary in one call (use this at every write site). */
export function packReason(reason: TradeReason): {
  trade_reason: TradeReason;
  trade_reason_summary: string;
} {
  return { trade_reason: reason, trade_reason_summary: summarizeTradeReason(reason) };
}

/** 兜底: 任何 caller throw / 缺数据 → safe empty reason, 不破写入链路. */
export function emptyTradeReason(source: TradeReasonSource = 'unknown'): TradeReason {
  return {
    source,
    evidence: [{ label: '理由缺失', detail: '上游未传 trade_reason; 见 RCA cron' }],
    key_reasons: [],
  };
}
