/**
 * ExecutionFeasibilityService — Sprint 1B 执行可行性评分
 *
 * 对一个候选订单 (symbol, side, target_qty, target_price?, as_of_date) 算
 * fillable_score ∈ [0, 100]，并给出 decision = 'fillable' | 'risky' | 'blocked'。
 *
 * **4 个子分量**（每个 0-100；加权后给 composite_score）：
 *
 *   1. limit_proximity_score (权重 0.3) — 当日价格距离涨跌停板的距离
 *      - BUY 看离涨停的距离 (越近越不易成交)
 *      - SELL 看离跌停的距离
 *      - 距离 / 涨跌停幅度 → score：5%+ = 100, 0% = 0
 *
 *   2. volume_coverage_score (权重 0.3) — target_qty / avg_5d_volume
 *      - ratio < 0.001 (千分一) → 100
 *      - ratio > 0.1 (一成) → 0
 *
 *   3. spread_score (权重 0.2) — 估算的 bid-ask spread
 *      - 用 (recent_high - recent_low) / close 作 proxy
 *      - spread < 1% → 100，spread > 5% → 0
 *
 *   4. status_score (权重 0.2) — 硬约束 (suspended/ST/limit_up/limit_down/T+1)
 *      - 任一硬约束触发 → 0 (并加入 block_reasons)
 *      - 否则 100
 *
 * **决策规则**:
 *   - 任一 block_reason → 'blocked' (composite 自动 0)
 *   - composite >= 70 → 'fillable'
 *   - 30 <= composite < 70 → 'risky'
 *   - composite < 30 → 'blocked'
 *
 * **设计选择**:
 *   - 4 子分量全 export pure function 独立单测
 *   - DataSource DI: PRODUCTION 走 DailyBar / Stock; 测试注入 fake
 *   - persist 可选（每个候选都写一行会膨胀；默认 persist=false 由 caller 显式开启）
 *   - T+1 规则：BUY 后当日不能 SELL — 调用方传入 holding_buy_date 才能检
 */

import { Op } from 'sequelize';
import { ExecutionFeasibilityRecord } from '../../models/ExecutionFeasibilityRecord';
import { logger } from '../../utils/logger';
import {
  expectedImpactCost,
  impactCostToScore,
  AlmgrenChrissParams,
} from './almgren-chriss';

// ============================================================
// Constants
// ============================================================

export const LIMIT_PROXIMITY_WEIGHT = 0.3;
export const VOLUME_COVERAGE_WEIGHT = 0.3;
export const SPREAD_WEIGHT = 0.2;
export const STATUS_WEIGHT = 0.2;

/** A 股普通股涨跌停幅度 */
export const STANDARD_LIMIT_PCT = 0.10;
/** ST 股涨跌停幅度 */
export const ST_LIMIT_PCT = 0.05;
/** 创业板 / 科创板涨跌停幅度 */
export const CHINEXT_LIMIT_PCT = 0.20;
/** 北交所涨跌停幅度 */
export const BJ_LIMIT_PCT = 0.30;

/** composite ≥ 此值即 fillable */
export const FILLABLE_THRESHOLD = 70;
/** composite < 此值即 blocked */
export const BLOCKED_THRESHOLD = 30;

// ============================================================
// Types
// ============================================================

export interface MarketSnapshot {
  /** 最新 close（用于估算可成交价） */
  close: number;
  /** 当日开盘 */
  open?: number | null;
  /** 当日 high */
  high?: number | null;
  /** 当日 low */
  low?: number | null;
  /** 前收（用于涨跌停幅度计算的基准） */
  prev_close?: number | null;
  /** 当日成交量 (股) */
  volume?: number | null;
  /** 近 5 日平均成交量 (股) */
  avg_volume_5d?: number | null;
  /** 当前是否触及涨停 */
  is_limit_up?: boolean;
  /** 当前是否触及跌停 */
  is_limit_down?: boolean;
  /** 是否停牌 */
  is_suspended?: boolean;
  /** 是否 ST */
  is_st?: boolean;
  /**
   * Sprint 34 (短板 #3b): 实时盘口 1 档. caller (PaperTradingAutomationService)
   * 从 RealtimeQuote.raw_payload 抽出. 缺则 spread 评分回退 (high-low)/close 代理.
   */
  bid1_price?: number | null;
  ask1_price?: number | null;
  bid1_volume?: number | null;
  ask1_volume?: number | null;
}

export interface ExecutionFeasibilityInput {
  symbol: string;
  side: 'BUY' | 'SELL';
  target_qty: number;
  target_price?: number | null;
  as_of_date: string;
  /** 用户 ID (持久化用) */
  user_id?: number | null;
  /** in-memory 模式：直接传 snapshot；不传则从 DataSource 加载 */
  market_snapshot?: MarketSnapshot;
  /** 用于 T+1 校验：若 side=SELL，需提供当前持仓的 buy_date */
  holding_buy_date?: string | null;
  /** 市场类型 ('main' | 'chinext' | 'star' | 'bj') 决定涨跌停幅度；不传则按 symbol 推断 */
  market_segment?: 'main' | 'chinext' | 'star' | 'bj' | 'st';
}

export interface ExecutionFeasibilityOptions {
  persist?: boolean;
  data_source?: ExecutionFeasibilityDataSource;
  /** v2: 启用 Almgren-Chriss linear impact model (默认 false 保持 v1) */
  use_almgren_chriss?: boolean;
}

export interface ExecutionFeasibilityReport {
  symbol: string;
  side: 'BUY' | 'SELL';
  target_qty: number;
  target_price: number | null;
  as_of_date: string;
  composite_score: number;
  limit_proximity_score: number | null;
  volume_coverage_score: number | null;
  spread_score: number | null;
  status_score: number | null;
  decision: 'fillable' | 'risky' | 'blocked';
  block_reasons: string[];
  summary: string;
  metadata: Record<string, any>;
  persisted_id: number | null;
  generated_at: Date;
}

// ============================================================
// Pure helpers — 全 export
// ============================================================

/**
 * 按 symbol 推断市场类型
 *   - 60xxxx / 90xxxx → 沪主板
 *   - 68xxxx → 科创板 (star, 20%)
 *   - 30xxxx → 创业板 (chinext, 20%)
 *   - 8xxxxx / 4xxxxx → 北交所 (bj, 30%)
 *   - 00xxxx → 深主板
 *   - ST 股需要 name 才能识别，这里默认 'main'
 */
export function inferMarketSegment(symbol: string): 'main' | 'chinext' | 'star' | 'bj' {
  const m = String(symbol || '').toLowerCase().replace(/^(sh|sz|bj)\.?/, '').replace(/\..+$/, '');
  if (m.startsWith('68')) return 'star';
  if (m.startsWith('30')) return 'chinext';
  if (m.startsWith('8') || m.startsWith('4')) return 'bj';
  return 'main';
}

/**
 * 按市场段返回涨跌停幅度
 */
export function getLimitPct(segment: 'main' | 'chinext' | 'star' | 'bj' | 'st'): number {
  switch (segment) {
    case 'star':
    case 'chinext':
      return CHINEXT_LIMIT_PCT;
    case 'bj':
      return BJ_LIMIT_PCT;
    case 'st':
      return ST_LIMIT_PCT;
    default:
      return STANDARD_LIMIT_PCT;
  }
}

/**
 * 涨跌停距离评分:
 *   - 当 BUY: 看 (limit_up_price - current_price) / limit_up_price
 *   - 当 SELL: 看 (current_price - limit_down_price) / current_price
 *
 * - distance >= 5% → 100
 * - distance ≤ 0 (触及涨/跌停) → 0
 * - 线性插值
 */
export function computeLimitProximityScore(input: {
  side: 'BUY' | 'SELL';
  current_price: number;
  prev_close: number;
  limit_pct: number;
}): number {
  const { side, current_price, prev_close, limit_pct } = input;
  if (!Number.isFinite(current_price) || !Number.isFinite(prev_close) || prev_close <= 0) return 0;

  const limitUp = prev_close * (1 + limit_pct);
  const limitDown = prev_close * (1 - limit_pct);

  let distance: number;
  if (side === 'BUY') {
    distance = (limitUp - current_price) / limitUp;
  } else {
    distance = (current_price - limitDown) / current_price;
  }
  if (distance <= 0) return 0;
  if (distance >= 0.05) return 100;
  return Math.round((distance / 0.05) * 100);
}

/**
 * 成交额覆盖率评分:
 *   - ratio = target_qty / avg_volume_5d
 *   - ratio ≤ 0.001 (千分一) → 100
 *   - 0.001 < ratio ≤ 0.01 (1%) → 80
 *   - 0.01 < ratio ≤ 0.05 (5%) → 50
 *   - 0.05 < ratio ≤ 0.10 (10%) → 20
 *   - ratio > 0.10 → 0
 *
 * **v2 注**：本评分基于 participation rate 经验值。更严谨的方法是
 * computeVolumeCoverageScoreV2 — 用 Almgren-Chriss linear impact model 算
 * expected_impact_bps 再映射 score。caller 传 use_almgren_chriss=true 启用。
 */
export function computeVolumeCoverageScore(input: {
  target_qty: number;
  avg_volume_5d: number | null | undefined;
}): number | null {
  const { target_qty, avg_volume_5d } = input;
  if (avg_volume_5d === null || avg_volume_5d === undefined) return null;
  if (!Number.isFinite(avg_volume_5d) || avg_volume_5d <= 0) return null;
  if (target_qty <= 0) return 100;

  const ratio = target_qty / avg_volume_5d;
  if (ratio <= 0.001) return 100;
  if (ratio <= 0.01) return Math.round(100 - ((ratio - 0.001) / 0.009) * 20);
  if (ratio <= 0.05) return Math.round(80 - ((ratio - 0.01) / 0.04) * 30);
  if (ratio <= 0.10) return Math.round(50 - ((ratio - 0.05) / 0.05) * 30);
  return 0;
}

/**
 * v2: Almgren-Chriss linear impact model 的 volume_coverage_score 替代实现
 *
 * 用 expected_impact_cost(order_qty, ADV, σ, spread) 算 bps cost，再映射到 0-100。
 *
 * 与 v1 区别:
 *   - v1 只看 ratio (qty / ADV)，不考虑 vol / spread
 *   - v2 考虑：相同 ratio 但 high-vol 股 impact 更大；high-spread 股 impact 更大
 *
 * @returns score 0-100 (越高越易成交) + 详细 breakdown
 */
export function computeVolumeCoverageScoreV2(input: {
  target_qty: number;
  avg_volume_5d: number | null | undefined;
  daily_vol: number | null | undefined;
  spread_pct: number | null | undefined;
}): { score: number | null; impact_bps: number | null; participation: number | null } {
  if (input.avg_volume_5d === null || input.avg_volume_5d === undefined || input.avg_volume_5d <= 0) {
    return { score: null, impact_bps: null, participation: null };
  }
  if (input.daily_vol === null || input.daily_vol === undefined || input.daily_vol <= 0) {
    // 退化到 v1
    return { score: computeVolumeCoverageScore(input), impact_bps: null, participation: input.target_qty / input.avg_volume_5d };
  }
  const ac: AlmgrenChrissParams = {
    adv: input.avg_volume_5d,
    daily_vol: input.daily_vol,
    spread_pct: input.spread_pct ?? 0.001,
  };
  const cost = expectedImpactCost(input.target_qty, ac);
  return {
    score: impactCostToScore(cost.total_bps),
    impact_bps: Math.round(cost.total_bps * 100) / 100,
    participation: cost.participation_rate,
  };
}

/**
 * 价差评分.
 *
 * Sprint 34 (短板 #3b): 优先用真盘口 bid1/ask1: spread = (ask - bid) / mid;
 * 缺盘口时 fallback (high - low)/close 代理 (向后兼容).
 *
 * 评分曲线:
 *   - spread ≤ 0.2% (主流标的) → 100
 *   - 0.2% < spread ≤ 1%       → 100→80 线性
 *   - 1% < spread ≤ 3%         → 80→50 线性
 *   - 3% < spread ≤ 5%         → 50→20 线性
 *   - spread > 5%              → 20
 */
export function computeSpreadScore(input: {
  high: number | null | undefined;
  low: number | null | undefined;
  close: number;
  // Sprint 34: 真盘口 (可选)
  bid1?: number | null;
  ask1?: number | null;
}): number | null {
  const { high, low, close, bid1, ask1 } = input;
  // 优先真盘口
  if (
    bid1 !== undefined &&
    bid1 !== null &&
    ask1 !== undefined &&
    ask1 !== null &&
    Number.isFinite(bid1) &&
    Number.isFinite(ask1) &&
    bid1 > 0 &&
    ask1 > 0 &&
    ask1 >= bid1
  ) {
    const mid = (bid1 + ask1) / 2;
    if (mid <= 0) return null;
    const spread = (ask1 - bid1) / mid;
    if (spread <= 0) return 100;
    if (spread <= 0.002) return 100;
    if (spread <= 0.01) return Math.round(100 - ((spread - 0.002) / 0.008) * 20);
    if (spread <= 0.03) return Math.round(80 - ((spread - 0.01) / 0.02) * 30);
    if (spread <= 0.05) return Math.round(50 - ((spread - 0.03) / 0.02) * 30);
    return 20;
  }
  // Fallback: high-low/close 代理
  if (high === null || high === undefined || low === null || low === undefined) return null;
  if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close) || close <= 0) return null;
  const proxy = (high - low) / close;
  if (proxy <= 0) return 100;
  if (proxy <= 0.01) return 100;
  if (proxy <= 0.03) return Math.round(100 - ((proxy - 0.01) / 0.02) * 20);
  if (proxy <= 0.05) return Math.round(80 - ((proxy - 0.03) / 0.02) * 30);
  return 20;
}

/**
 * 状态硬约束检查 → (score, block_reasons[])
 */
export function checkStatusConstraints(input: {
  side: 'BUY' | 'SELL';
  snapshot: MarketSnapshot;
  holding_buy_date?: string | null;
  as_of_date: string;
}): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  const { side, snapshot, holding_buy_date, as_of_date } = input;

  if (snapshot.is_suspended) {
    reasons.push('suspended');
  }
  if (side === 'BUY' && snapshot.is_limit_up) {
    reasons.push('limit_up_blocked_buy');
  }
  if (side === 'SELL' && snapshot.is_limit_down) {
    reasons.push('limit_down_blocked_sell');
  }
  if (side === 'SELL' && holding_buy_date && holding_buy_date === as_of_date) {
    reasons.push('t_plus_1_violation');
  }
  if (snapshot.is_st) {
    reasons.push('st_stock_warning');
  }

  // ST 是 warning 不是硬阻塞；其他是硬阻塞
  const hardBlockers = reasons.filter(r => r !== 'st_stock_warning');
  if (hardBlockers.length > 0) {
    return { score: 0, reasons };
  }
  // ST only: 给 50 分（不阻塞但显著降权）
  if (reasons.includes('st_stock_warning')) {
    return { score: 50, reasons };
  }
  return { score: 100, reasons: [] };
}

/**
 * 综合评分 = 加权和（hard block 时直接 0）。
 *
 * @returns composite ∈ [0, 100]
 */
export function computeCompositeScore(input: {
  limit_proximity: number | null;
  volume_coverage: number | null;
  spread: number | null;
  status: number;
  has_hard_block: boolean;
}): number {
  if (input.has_hard_block) return 0;

  // 各子项 null 时跳过（重新归一化权重）
  const components: Array<{ score: number; weight: number }> = [];
  if (input.limit_proximity !== null) components.push({ score: input.limit_proximity, weight: LIMIT_PROXIMITY_WEIGHT });
  if (input.volume_coverage !== null) components.push({ score: input.volume_coverage, weight: VOLUME_COVERAGE_WEIGHT });
  if (input.spread !== null) components.push({ score: input.spread, weight: SPREAD_WEIGHT });
  components.push({ score: input.status, weight: STATUS_WEIGHT });

  const totalWeight = components.reduce((s, c) => s + c.weight, 0);
  if (totalWeight === 0) return 0;
  const weighted = components.reduce((s, c) => s + c.score * c.weight, 0);
  return Math.round((weighted / totalWeight) * 100) / 100;
}

/**
 * 决策规则
 */
export function deriveDecision(composite: number, hasHardBlock: boolean): 'fillable' | 'risky' | 'blocked' {
  if (hasHardBlock) return 'blocked';
  if (composite >= FILLABLE_THRESHOLD) return 'fillable';
  if (composite < BLOCKED_THRESHOLD) return 'blocked';
  return 'risky';
}

/**
 * 自然语言总结
 */
export function buildFeasibilitySummary(report: {
  decision: 'fillable' | 'risky' | 'blocked';
  composite: number;
  block_reasons: string[];
  side: 'BUY' | 'SELL';
  symbol: string;
}): string {
  const { decision, composite, block_reasons, side, symbol } = report;
  if (decision === 'blocked') {
    const reasons = block_reasons.length > 0 ? block_reasons.join(', ') : '综合分过低';
    return `🔴 ${symbol} ${side} 不可成交 (score=${composite.toFixed(1)}, 原因: ${reasons})`;
  }
  if (decision === 'risky') {
    return `🟠 ${symbol} ${side} 成交存在风险 (score=${composite.toFixed(1)})`;
  }
  return `✅ ${symbol} ${side} 可成交 (score=${composite.toFixed(1)})`;
}

// ============================================================
// DataSource (DI)
// ============================================================

export interface ExecutionFeasibilityDataSource {
  loadMarketSnapshot(symbol: string, as_of_date: string): Promise<MarketSnapshot | null>;
}

export const PRODUCTION_EXECUTION_FEASIBILITY_DATA_SOURCE: ExecutionFeasibilityDataSource = {
  async loadMarketSnapshot(symbol, as_of_date) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { DailyBar } = require('../../models/DailyBar');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Stock } = require('../../models/Stock');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { normalizeSymbol } = require('../../utils/stockSymbol');

      const normalized = normalizeSymbol(symbol);
      const stock = await Stock.findOne({ where: { symbol: normalized } });
      if (!stock) return null;

      // Sprint 36 fix: DailyBar 字段名是 `time` (DateTime), 不是 `trade_date`.
      // 之前用 `trade_date` 查询抛 'column DailyBar.trade_date does not exist',
      // try/catch 吞错返回 null → service 报 no_market_data 拒单.
      // 5 个真有 daily_bar 的 symbol (sh.600101/600236/600449/600350/600018)
      // 在 dashboard 看到的 'no_market' 拦截都是这个 bug 导致的.
      //
      // 近 6 个交易日（含当日；avg_volume_5d 用前 5 个）
      const bars = await DailyBar.findAll({
        where: { stock_id: stock.id, time: { [Op.lte]: as_of_date } },
        order: [['time', 'DESC']],
        limit: 6,
      });
      if (bars.length === 0) return null;

      const today = bars[0];
      const prevBars = bars.slice(1, 6);
      const avgVol =
        prevBars.length > 0
          ? prevBars.reduce((s: number, b: any) => s + Number(b.volume || 0), 0) / prevBars.length
          : null;
      const prevClose = bars.length > 1 ? Number(bars[1].close) : null;

      const isST =
        typeof stock.name === 'string' &&
        (stock.name.includes('ST') || stock.name.includes('*ST') || stock.name.includes('退'));
      const isSuspended = !Number.isFinite(Number(today.volume)) || Number(today.volume) === 0;

      const close = Number(today.close);
      const limitPct = isST ? ST_LIMIT_PCT : getLimitPct(inferMarketSegment(normalized));
      const limitUpPrice = prevClose ? prevClose * (1 + limitPct) : null;
      const limitDownPrice = prevClose ? prevClose * (1 - limitPct) : null;
      const isLimitUp = limitUpPrice ? close >= limitUpPrice * 0.999 : false;
      const isLimitDown = limitDownPrice ? close <= limitDownPrice * 1.001 : false;

      return {
        close,
        open: Number(today.open),
        high: Number(today.high),
        low: Number(today.low),
        prev_close: prevClose,
        volume: Number(today.volume),
        avg_volume_5d: avgVol,
        is_limit_up: isLimitUp,
        is_limit_down: isLimitDown,
        is_suspended: isSuspended,
        is_st: isST,
      };
    } catch (err: any) {
      logger.warn(`[execution-feasibility] loadMarketSnapshot failed: ${err?.message}`);
      return null;
    }
  },
};

// ============================================================
// Service
// ============================================================

export class ExecutionFeasibilityService {
  constructor(
    private dataSource: ExecutionFeasibilityDataSource = PRODUCTION_EXECUTION_FEASIBILITY_DATA_SOURCE
  ) {}

  /**
   * 计算 (symbol, side, target_qty, ...) 的可行性评分
   */
  async computeFeasibility(
    input: ExecutionFeasibilityInput,
    options: ExecutionFeasibilityOptions = {}
  ): Promise<ExecutionFeasibilityReport> {
    const persist = options.persist === true;
    const ds = options.data_source ?? this.dataSource;

    // 取 market snapshot
    const snapshot =
      input.market_snapshot ?? (await ds.loadMarketSnapshot(input.symbol, input.as_of_date));

    if (!snapshot) {
      // 无数据 → 直接 blocked
      const report: ExecutionFeasibilityReport = {
        symbol: input.symbol,
        side: input.side,
        target_qty: input.target_qty,
        target_price: input.target_price ?? null,
        as_of_date: input.as_of_date,
        composite_score: 0,
        limit_proximity_score: null,
        volume_coverage_score: null,
        spread_score: null,
        status_score: null,
        decision: 'blocked',
        block_reasons: ['no_market_data'],
        summary: `🔴 ${input.symbol} 缺少市场数据，无法评估可行性`,
        metadata: { error: 'no_market_data' },
        persisted_id: null,
        generated_at: new Date(),
      };
      if (persist) {
        try {
          const row = await ExecutionFeasibilityRecord.create({
            user_id: input.user_id ?? null,
            symbol: report.symbol,
            side: report.side,
            target_qty: report.target_qty,
            target_price: report.target_price,
            as_of_date: report.as_of_date,
            composite_score: report.composite_score,
            decision: report.decision,
            block_reasons: report.block_reasons,
            summary: report.summary,
            metadata: report.metadata,
          });
          report.persisted_id = row.id;
        } catch (err: any) {
          logger.warn(`[execution-feasibility] persist failed: ${err?.message}`);
        }
      }
      return report;
    }

    // 推导 limit_pct
    const segment =
      input.market_segment ?? (snapshot.is_st ? 'st' : inferMarketSegment(input.symbol));
    const limit_pct = getLimitPct(segment);

    // 1. limit_proximity
    const limit_proximity_score = computeLimitProximityScore({
      side: input.side,
      current_price: input.target_price ?? snapshot.close,
      prev_close: snapshot.prev_close ?? snapshot.close,
      limit_pct,
    });

    // 2. volume_coverage (v1 or v2 by option)
    let volume_coverage_score: number | null;
    let impact_bps_v2: number | null = null;
    if (options.use_almgren_chriss) {
      const sigma = snapshot.prev_close && snapshot.prev_close > 0 && snapshot.high && snapshot.low
        ? (snapshot.high - snapshot.low) / snapshot.prev_close
        : 0.02;
      const spread_pct = snapshot.high && snapshot.low && snapshot.close > 0
        ? (snapshot.high - snapshot.low) / snapshot.close / 2
        : 0.001;
      const v2 = computeVolumeCoverageScoreV2({
        target_qty: input.target_qty,
        avg_volume_5d: snapshot.avg_volume_5d,
        daily_vol: sigma,
        spread_pct,
      });
      volume_coverage_score = v2.score;
      impact_bps_v2 = v2.impact_bps;
    } else {
      volume_coverage_score = computeVolumeCoverageScore({
        target_qty: input.target_qty,
        avg_volume_5d: snapshot.avg_volume_5d,
      });
    }

    // 3. spread — Sprint 34: 优先用真盘口 bid/ask, 缺则 high-low/close 代理
    const spread_score = computeSpreadScore({
      high: snapshot.high,
      low: snapshot.low,
      close: snapshot.close,
      bid1: snapshot.bid1_price,
      ask1: snapshot.ask1_price,
    });

    // 4. status
    const { score: status_score, reasons: block_reasons } = checkStatusConstraints({
      side: input.side,
      snapshot,
      holding_buy_date: input.holding_buy_date,
      as_of_date: input.as_of_date,
    });

    const hardBlockers = block_reasons.filter(r => r !== 'st_stock_warning');
    const has_hard_block = hardBlockers.length > 0;

    const composite_score = computeCompositeScore({
      limit_proximity: limit_proximity_score,
      volume_coverage: volume_coverage_score,
      spread: spread_score,
      status: status_score,
      has_hard_block,
    });

    const decision = deriveDecision(composite_score, has_hard_block);
    const summary = buildFeasibilitySummary({
      decision,
      composite: composite_score,
      block_reasons,
      side: input.side,
      symbol: input.symbol,
    });

    const report: ExecutionFeasibilityReport = {
      symbol: input.symbol,
      side: input.side,
      target_qty: input.target_qty,
      target_price: input.target_price ?? null,
      as_of_date: input.as_of_date,
      composite_score,
      limit_proximity_score,
      volume_coverage_score,
      spread_score,
      status_score,
      decision,
      block_reasons,
      summary,
      metadata: {
        segment,
        limit_pct,
        snapshot_close: snapshot.close,
        snapshot_prev_close: snapshot.prev_close,
        snapshot_avg_volume_5d: snapshot.avg_volume_5d,
        // Sprint 34 (短板 #3b): 真盘口落地, 让 dashboard 能区分 spread 来源
        snapshot_bid1: snapshot.bid1_price ?? null,
        snapshot_ask1: snapshot.ask1_price ?? null,
        spread_source:
          snapshot.bid1_price && snapshot.ask1_price ? 'real_bid_ask' : 'high_low_proxy',
        use_almgren_chriss: options.use_almgren_chriss === true,
        impact_bps_v2,
      },
      persisted_id: null,
      generated_at: new Date(),
    };

    if (persist) {
      try {
        const row = await ExecutionFeasibilityRecord.create({
          user_id: input.user_id ?? null,
          symbol: report.symbol,
          side: report.side,
          target_qty: report.target_qty,
          target_price: report.target_price,
          as_of_date: report.as_of_date,
          composite_score: report.composite_score,
          limit_proximity_score: report.limit_proximity_score,
          volume_coverage_score: report.volume_coverage_score,
          spread_score: report.spread_score,
          status_score: report.status_score,
          decision: report.decision,
          block_reasons: report.block_reasons,
          summary: report.summary,
          metadata: report.metadata,
        });
        report.persisted_id = row.id;
      } catch (err: any) {
        logger.warn(`[execution-feasibility] persist failed: ${err?.message}`);
      }
    }

    return report;
  }

  /** 批量评估多个候选 */
  async computeBatch(
    inputs: ExecutionFeasibilityInput[],
    options: ExecutionFeasibilityOptions = {}
  ): Promise<ExecutionFeasibilityReport[]> {
    const out: ExecutionFeasibilityReport[] = [];
    for (const inp of inputs) {
      out.push(await this.computeFeasibility(inp, options));
    }
    return out;
  }

  async listRecent(limit = 50, filters: { user_id?: number; decision?: string } = {}): Promise<ExecutionFeasibilityRecord[]> {
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 500);
    const where: any = {};
    if (filters.user_id) where.user_id = filters.user_id;
    if (filters.decision) where.decision = filters.decision;
    return ExecutionFeasibilityRecord.findAll({
      where,
      order: [['created_at', 'DESC']],
      limit: safeLimit,
    });
  }

  async cleanupOlderThan(days: number): Promise<{ deleted: number }> {
    const cutoff = new Date(Date.now() - Math.max(1, days) * 24 * 3600 * 1000);
    const deleted = await ExecutionFeasibilityRecord.destroy({
      where: { created_at: { [Op.lt]: cutoff } },
    });
    return { deleted };
  }
}

export const executionFeasibilityService = new ExecutionFeasibilityService();
