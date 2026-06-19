/**
 * US-044 / FE-005 「今日卖出建议」纯函数 helper —— 把当前持仓 (PositionRow[]) +
 * 今日 3 策略 SELL 信号合并 → 去重 → 按"止损 > 止盈 > 减持"优先级排序成一条
 * "今日可减仓清单"。
 *
 * 设计原则 (与 todayPlanHelpers.ts US-042 + backend US-026/028/029 同款 pure helper)：
 *   - 输入 positions (PositionRow[]) + todaySignals (TodaySignalsData | null), 输出
 *     SellSuggestionRow[];
 *   - 持仓里"硬触发"止损/止盈 (current_price 与 stop_loss_price / take_profit_price
 *     比较) — 实时数据驱动; 没设置阈值时按默认 (-7% / +20%) 兜底;
 *   - 同股出现在多 source (e.g. 触发止损 + dragon_head sell) 时合并到一行,
 *     reason 取最严重 (stop_loss > take_profit > reduce), sources 保留所有命中;
 *   - 完全 pure: 不调网络 / 不读 state / 同输入永远同输出 — 便于 future 单测 +
 *     useMemo 安全.
 *
 * reason 决策表 (severity 高 → 低):
 *   - stop_loss (止损, 红): current_price ≤ stop_loss_price (用户显式设了止损价
 *                            且已触发); OR unrealized_pnl_pct ≤ DEFAULT_STOP_LOSS_PCT
 *                            (-7%, 与 backend PerStockStopLossGuard 默认对齐)
 *   - take_profit (止盈, 绿): current_price ≥ take_profit_price (用户显式设了止盈价
 *                              且已触发); OR unrealized_pnl_pct ≥ DEFAULT_TAKE_PROFIT_PCT
 *                              (+20%, 高级操盘手书常用 "20% 止盈思维");
 *   - reduce (减持, 橙): 3 策略 SELL 信号 (multi_factor signal='sell' / dragon_head
 *                        signal='sell' or 'sell_half' / earnings_surprise signal='sell')
 *                        且持仓里能匹配到 symbol — alpha 衰减不一定立即触发硬止损
 *                        但需要降低敞口.
 *
 * 与 backend guard 的边界:
 *   - 本 helper 是 **UI 提示** (帮用户看到哪些仓位"今天应该考虑卖") — 不直接下单;
 *   - backend PerStockStopLossGuard (US-051) / TrailingStopGuard (US-048) /
 *     RebalanceEngine (US-009) 才是真触发 SELL 的执行路径; UI 卡片仅展示, 不
 *     duplicate execution 逻辑 (与 TradingPlanCard 同思想 — "买入清单 vs 真撮合"
 *     分层);
 *   - 默认阈值与 backend 默认对齐 (-7% stop / +20% profit) 让 UI 看到的"应卖"基本
 *     与 backend 即将触发的 SELL 同步, 避免用户疑惑"为什么 UI 不提示但后台已卖".
 *
 * 与 TradingPlanCard (US-042) 的对偶:
 *   - 买入计划: 拍平 BUY 信号 → 优先级 high (强烈) / medium (建议) / low (可选);
 *   - 卖出建议: 拍平 SELL 触发 → 优先级 high (止损必卖) / medium (止盈考虑) /
 *               low (减持渐进); 配色 high=红 / medium=绿 / low=橙 (止盈用绿色让
 *               用户看到"庆祝"感, 与一般"卖=红" 直觉相反但更符合"止盈是好事"语境).
 */

import {
  TodaySignalsData,
  MultiFactorAlphaSignal,
  DragonHeadSignal,
  EarningsSurpriseSignal,
} from '../../services/todayWorkspaceService';
import { PositionRow } from '../../services/portfolioWorkspaceService';

// ---------- 公开类型 ----------

export type SellSuggestionReason = 'stop_loss' | 'take_profit' | 'reduce';

/**
 * source 标识"为什么进入卖出建议"。stop_loss_hit / take_profit_hit = 用户显式
 * 阈值被触发; stop_loss_default / take_profit_default = 默认阈值兜底; 3 个策略
 * SELL = alpha 衰减.
 */
export type SellSuggestionSource =
  | 'stop_loss_hit'
  | 'stop_loss_default'
  | 'take_profit_hit'
  | 'take_profit_default'
  | 'multi_factor_sell'
  | 'dragon_head_sell'
  | 'dragon_head_sell_half'
  | 'earnings_surprise_sell';

export type SellSuggestionPriority = 'high' | 'medium' | 'low';

export interface SellSuggestionRow {
  /** 唯一 key — symbol */
  stock_code: string;
  name: string | null;
  /** 持仓数量 */
  quantity: number;
  /** 平均成本 */
  avg_cost: number;
  /** 最新价 */
  current_price: number;
  /** 浮动盈亏 */
  unrealized_pnl: number;
  /** 浮动盈亏比例 (current_price - avg_cost) / avg_cost; avg_cost ≤ 0 时为 null */
  unrealized_pnl_pct: number | null;
  /** 用户显式设的止损价 (null = 未设) */
  stop_loss_price: number | null;
  /** 用户显式设的止盈价 (null = 未设) */
  take_profit_price: number | null;
  /** 最严重的卖出原因 — stop_loss > take_profit > reduce */
  reason: SellSuggestionReason;
  /** 优先级 — high (止损) > medium (止盈) > low (减持) */
  priority: SellSuggestionPriority;
  /** 命中本仓位的所有 source (排序后) */
  sources: SellSuggestionSource[];
  /**
   * 建议卖出比例 (0..1) — 止损 / 显式止盈触发: 1.0 (全清);
   * 默认止盈兜底: 0.5 (减半保利润); dragon_head sell_half: 0.5; 其它 reduce: 0.5.
   */
  suggested_sell_ratio: number;
  /** 一句话理由 — 拼合 source + 关键数字 */
  reason_text: string;
}

// ---------- 常量 (export 便于单测 / 调参单一来源) ----------

/**
 * 默认止损阈值 (浮动亏损 ≤ -7% 触发兜底止损). 与 backend
 * PerStockStopLossGuard.DEFAULT_PER_STOCK_STOP_LOSS.pct=0.07 对齐 — 改一处
 * 必须同步另一处, 否则 UI 与后台不一致, 用户疑惑.
 */
export const DEFAULT_STOP_LOSS_PCT = -0.07;

/**
 * 默认止盈阈值 (浮动盈利 ≥ +20% 触发兜底止盈). 高级操盘手书 "20% 止盈" 习惯
 * 阈值; 与 backend take-profit guard (如有) 对齐.
 */
export const DEFAULT_TAKE_PROFIT_PCT = 0.2;

/** 默认止盈兜底建议减半 (保留利润 + 让一部分继续涨) */
export const DEFAULT_TAKE_PROFIT_SELL_RATIO = 0.5;

/** 默认减持建议比例 (alpha 衰减 → 减半敞口) */
export const DEFAULT_REDUCE_SELL_RATIO = 0.5;

/** 显式止损/止盈触发 / dragon_head sell (非 sell_half) → 全清 */
export const FULL_SELL_RATIO = 1.0;

/**
 * source 排序权重 (严重 → 渐进) — 同股多 source 命中时, sources[0] 为主因.
 * 与 reason 决策一致: stop_loss_* > take_profit_* > 3 策略 sell.
 */
export const SOURCE_PRIORITY_ORDER: SellSuggestionSource[] = [
  'stop_loss_hit',
  'stop_loss_default',
  'take_profit_hit',
  'take_profit_default',
  'dragon_head_sell',
  'dragon_head_sell_half',
  'multi_factor_sell',
  'earnings_surprise_sell',
];

// ---------- 纯函数 ----------

/**
 * 计算浮动盈亏比例. avg_cost ≤ 0 (脏数据 / 赠送股 / 拆股未复权) → null
 * (与 backend PerStockStopLossGuard "除零保护" 思想一致).
 */
export function computeUnrealizedPnlPct(position: {
  avg_cost: number;
  current_price: number;
}): number | null {
  const cost = Number(position.avg_cost);
  const price = Number(position.current_price);
  if (!Number.isFinite(cost) || !Number.isFinite(price) || cost <= 0) return null;
  return (price - cost) / cost;
}

/**
 * 决定一个仓位的卖出原因 (stop_loss > take_profit > 无). 不命中任何硬触发
 * 返 null — 调用方再看 3 策略 SELL 信号决定是否为 reduce.
 */
export function computeHardSellReason(input: {
  current_price: number;
  stop_loss_price: number | null;
  take_profit_price: number | null;
  unrealized_pnl_pct: number | null;
}): { reason: SellSuggestionReason; source: SellSuggestionSource } | null {
  const { current_price, stop_loss_price, take_profit_price, unrealized_pnl_pct } = input;
  // ---- stop_loss 优先 (止损硬触发, 必卖) ----
  if (
    stop_loss_price != null &&
    Number.isFinite(stop_loss_price) &&
    stop_loss_price > 0 &&
    Number.isFinite(current_price) &&
    current_price > 0 &&
    current_price <= stop_loss_price
  ) {
    return { reason: 'stop_loss', source: 'stop_loss_hit' };
  }
  if (unrealized_pnl_pct != null && unrealized_pnl_pct <= DEFAULT_STOP_LOSS_PCT) {
    return { reason: 'stop_loss', source: 'stop_loss_default' };
  }
  // ---- take_profit 次之 (止盈考虑, 可减仓) ----
  if (
    take_profit_price != null &&
    Number.isFinite(take_profit_price) &&
    take_profit_price > 0 &&
    Number.isFinite(current_price) &&
    current_price > 0 &&
    current_price >= take_profit_price
  ) {
    return { reason: 'take_profit', source: 'take_profit_hit' };
  }
  if (unrealized_pnl_pct != null && unrealized_pnl_pct >= DEFAULT_TAKE_PROFIT_PCT) {
    return { reason: 'take_profit', source: 'take_profit_default' };
  }
  return null;
}

/**
 * sources 按 SOURCE_PRIORITY_ORDER 排序去重.
 */
export function sortSellSources(sources: SellSuggestionSource[]): SellSuggestionSource[] {
  const set = new Set(sources);
  return SOURCE_PRIORITY_ORDER.filter(s => set.has(s));
}

/**
 * reason → priority 映射:
 *   stop_loss → high (必卖, 红)
 *   take_profit → medium (考虑卖, 绿 — 庆祝盈利)
 *   reduce → low (渐进减仓, 橙)
 */
export function reasonToPriority(reason: SellSuggestionReason): SellSuggestionPriority {
  if (reason === 'stop_loss') return 'high';
  if (reason === 'take_profit') return 'medium';
  return 'low';
}

/**
 * reason → tag 颜色. 高=红 (必卖), 中=绿 (止盈庆祝), 低=橙 (渐进减仓).
 * 不用"低=灰"是因为 reduce 仍然是"今天要动手", 需视觉区分.
 */
export function reasonTagColor(reason: SellSuggestionReason): string {
  if (reason === 'stop_loss') return 'red';
  if (reason === 'take_profit') return 'green';
  return 'orange';
}

/** reason 中文 label */
export function reasonLabel(reason: SellSuggestionReason): string {
  if (reason === 'stop_loss') return '止损';
  if (reason === 'take_profit') return '止盈';
  return '减持';
}

/** source 中文 label — UI tag 用 */
export function sellSourceLabel(source: SellSuggestionSource): string {
  if (source === 'stop_loss_hit') return '止损线触发';
  if (source === 'stop_loss_default') return '亏损 7%+';
  if (source === 'take_profit_hit') return '止盈线触发';
  if (source === 'take_profit_default') return '盈利 20%+';
  if (source === 'multi_factor_sell') return '多因子';
  if (source === 'dragon_head_sell') return '龙头';
  if (source === 'dragon_head_sell_half') return '龙头减半';
  if (source === 'earnings_surprise_sell') return '业绩超预期';
  return source;
}

/** priority tag 颜色 — 与 reasonTagColor 同色谱 */
export function sellPriorityTagColor(p: SellSuggestionPriority): string {
  if (p === 'high') return 'red';
  if (p === 'medium') return 'green';
  return 'orange';
}

/** priority 中文 label */
export function sellPriorityLabel(p: SellSuggestionPriority): string {
  if (p === 'high') return '必卖';
  if (p === 'medium') return '考虑';
  return '减持';
}

/**
 * 一个 source 决定推荐卖出比例.
 * 显式止损 / 显式止盈 / dragon_head 'sell' 全 1.0;
 * 默认止损兜底也 1.0 (达到 -7% 即硬保本);
 * 默认止盈 / dragon_head 'sell_half' / 其它 reduce 0.5.
 */
export function pickSellRatio(source: SellSuggestionSource): number {
  if (source === 'stop_loss_hit' || source === 'stop_loss_default') return FULL_SELL_RATIO;
  if (source === 'take_profit_hit') return FULL_SELL_RATIO;
  if (source === 'dragon_head_sell') return FULL_SELL_RATIO;
  if (source === 'take_profit_default') return DEFAULT_TAKE_PROFIT_SELL_RATIO;
  if (source === 'dragon_head_sell_half') return DEFAULT_TAKE_PROFIT_SELL_RATIO;
  return DEFAULT_REDUCE_SELL_RATIO;
}

/**
 * 拼一句话理由. 同股多 source 用 ｜ 分隔, 每个 source 含关键数字 (浮动 / 阈值).
 */
export function buildSellReasonText(
  parts: Array<{
    source: SellSuggestionSource;
    pnlPct: number | null;
    stopLossPrice: number | null;
    takeProfitPrice: number | null;
  }>
): string {
  if (parts.length === 0) return '';
  const sorted = [...parts].sort(
    (a, b) => SOURCE_PRIORITY_ORDER.indexOf(a.source) - SOURCE_PRIORITY_ORDER.indexOf(b.source)
  );
  return sorted
    .map(p => {
      const lbl = sellSourceLabel(p.source);
      if (p.source === 'stop_loss_hit') {
        return `${lbl} (¥${(p.stopLossPrice ?? 0).toFixed(2)})`;
      }
      if (p.source === 'take_profit_hit') {
        return `${lbl} (¥${(p.takeProfitPrice ?? 0).toFixed(2)})`;
      }
      if (p.source === 'stop_loss_default' || p.source === 'take_profit_default') {
        if (p.pnlPct != null && Number.isFinite(p.pnlPct)) {
          const pct = (p.pnlPct * 100).toFixed(1);
          return `${lbl} (浮动 ${pct}%)`;
        }
      }
      return lbl;
    })
    .join(' ｜ ');
}

/**
 * 主入口 —— 把 positions + todaySignals 合并成统一卖出建议清单.
 *
 * 行为契约:
 *   - 只考虑当前持仓 (quantity > 0); 非持仓股的 3 策略 SELL 信号忽略
 *     (你都没仓位没法卖);
 *   - 同 stock_code 多 source 命中 → 合并到一行, sources / reason_text 累加,
 *     reason / priority 取最严重;
 *   - suggested_sell_ratio 取所有命中 source 中 max — 多 source 命中时按
 *     "最严重 source 决定要不要清仓"; e.g. 同时触发止损 + dragon_head sell_half
 *     最终 ratio = 1.0 (止损全清);
 *   - 输出按 priority (high → medium → low) 再按 |pnl_pct| 降序排; 同
 *     priority 同 pnl 按 stock_code 字母序稳定排 (React key 稳定);
 *   - 输入异常 (positions=null/[] / signals=null / 单 block error) 全部容错返 [].
 */
export function buildSellSuggestions(
  positions: PositionRow[] | null | undefined,
  todaySignals: TodaySignalsData | null | undefined
): SellSuggestionRow[] {
  if (!positions || positions.length === 0) return [];

  // ---- 收集 3 策略 SELL 信号 → Map<symbol, source[]> ----
  // 只看 signal === 'sell' / 'sell_half' (其它为 buy/hold, 不进卖出建议).
  const sellSignals = new Map<string, SellSuggestionSource[]>();
  const collectSellSignal = (code: string, source: SellSuggestionSource) => {
    const existing = sellSignals.get(code) ?? [];
    if (!existing.includes(source)) existing.push(source);
    sellSignals.set(code, existing);
  };
  const mfa: MultiFactorAlphaSignal[] = todaySignals?.multi_factor?.signals ?? [];
  for (const s of mfa) {
    if (s.signal === 'sell') collectSellSignal(s.stock_code, 'multi_factor_sell');
  }
  const dh: DragonHeadSignal[] = todaySignals?.dragon_head?.candidates ?? [];
  for (const s of dh) {
    if (s.signal === 'sell') collectSellSignal(s.stock_code, 'dragon_head_sell');
    else if (s.signal === 'sell_half') collectSellSignal(s.stock_code, 'dragon_head_sell_half');
  }
  const es: EarningsSurpriseSignal[] = todaySignals?.earnings_surprise?.candidates ?? [];
  for (const s of es) {
    if (s.signal === 'sell') collectSellSignal(s.stock_code, 'earnings_surprise_sell');
  }

  // ---- per-position: 检查硬触发 + 3 策略 sell 信号, 至少一个命中才入清单 ----
  const out: SellSuggestionRow[] = [];
  for (const p of positions) {
    if (!p || p.quantity == null || Number(p.quantity) <= 0) continue;
    const code = p.symbol;
    const pnlPct = computeUnrealizedPnlPct({
      avg_cost: Number(p.avg_cost),
      current_price: Number(p.current_price),
    });
    const stopLossPrice =
      p.stop_loss_price != null && Number.isFinite(Number(p.stop_loss_price))
        ? Number(p.stop_loss_price)
        : null;
    const takeProfitPrice =
      p.take_profit_price != null && Number.isFinite(Number(p.take_profit_price))
        ? Number(p.take_profit_price)
        : null;

    const hard = computeHardSellReason({
      current_price: Number(p.current_price),
      stop_loss_price: stopLossPrice,
      take_profit_price: takeProfitPrice,
      unrealized_pnl_pct: pnlPct,
    });
    const strategySources = sellSignals.get(code) ?? [];
    // 至少一个命中才纳入清单
    if (!hard && strategySources.length === 0) continue;

    const sources: SellSuggestionSource[] = [];
    if (hard) sources.push(hard.source);
    for (const s of strategySources) sources.push(s);

    const reason: SellSuggestionReason = hard ? hard.reason : 'reduce';
    const priority = reasonToPriority(reason);

    // suggested_sell_ratio 取所有 source 的 max
    let ratio = 0;
    for (const s of sources) {
      const r = pickSellRatio(s);
      if (r > ratio) ratio = r;
    }

    const reasonText = buildSellReasonText(
      sources.map(s => ({
        source: s,
        pnlPct,
        stopLossPrice,
        takeProfitPrice,
      }))
    );

    out.push({
      stock_code: code,
      name: p.name ?? null,
      quantity: Number(p.quantity),
      avg_cost: Number(p.avg_cost),
      current_price: Number(p.current_price),
      unrealized_pnl: Number(p.unrealized_pnl ?? 0),
      unrealized_pnl_pct: pnlPct,
      stop_loss_price: stopLossPrice,
      take_profit_price: takeProfitPrice,
      reason,
      priority,
      sources: sortSellSources(sources),
      suggested_sell_ratio: ratio,
      reason_text: reasonText,
    });
  }

  // ---- 排序: priority high→medium→low; 同 priority |pnl_pct| 降序; 同按 code 字母序 ----
  const priorityRank: Record<SellSuggestionPriority, number> = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => {
    const dp = priorityRank[a.priority] - priorityRank[b.priority];
    if (dp !== 0) return dp;
    const ap = a.unrealized_pnl_pct == null ? -Infinity : Math.abs(a.unrealized_pnl_pct);
    const bp = b.unrealized_pnl_pct == null ? -Infinity : Math.abs(b.unrealized_pnl_pct);
    if (ap !== bp) return bp - ap;
    return a.stock_code.localeCompare(b.stock_code);
  });
}
