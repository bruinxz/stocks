/**
 * BehaviorBiasDetector — Phase 8 行为偏差诊断
 *
 * 用户优先级 #13 — trade-performance-coach 之"行为偏差"维度。从用户的 closed
 * outcomes 序列识别 4 种系统性偏差，给 0-100 严重度分 + 改进建议。
 *
 * 4 种偏差:
 *
 *   1. chasing_high (追涨杀跌)
 *      入场时 entry_price 接近近 5 日最高价 (high 80%+ 分位) + 后续亏损
 *      → 行为模式: FOMO 追高 / 抢筹
 *
 *   2. overtrading (过度交易)
 *      单周交易次数 > 阈值 (默认 5 笔/周) 或 平均持仓天数 < 3 天
 *      → 行为模式: 频繁出入 / 拿不住票
 *
 *   3. anchoring_loss (锚定亏损 / 套牢死扛)
 *      持续 hold loss > 30 天不止损 (最终亏损 outcomes 中 holding_days > 30 占比高)
 *      → 行为模式: 心理锚定成本价、拒绝认输
 *
 *   4. loss_aversion_early_take (落袋为安过早)
 *      盈利 outcomes 中 大量 return_pct < 3% 就 SELL
 *      vs 同期 winners 平均能跑 5-10%
 *      → 行为模式: 怕回吐 / 厌恶损失
 *
 *   5. style_drift (风格漂移 — PM-026)
 *      前半 vs 后半 closed outcomes 的 source_type 分布 TVD ≥ 0.2 / 0.4
 *      → 行为模式: 被某类信号源 (KOL / ANN) 裹挟, 偏离原 mix
 *
 *   6. time_bias (时段偏差 — PM-026)
 *      某 entry day-of-week 胜率比全局落后 ≥ 20 pct (且样本 ≥ 3)
 *      → 行为模式: 系统性在不利时段入场
 *
 * 设计:
 *   - 纯函数 detectors 全 export 单测
 *   - DataSource 注入 (生产 RecommendationTradeOutcome / 测试 fake)
 *   - 单 user / 单 portfolio 维度
 */

import { Op } from 'sequelize';
import { RecommendationTradeOutcome } from '../models/RecommendationTradeOutcome';
import { logger } from '../utils/logger';

// ============================================================
// Types
// ============================================================

export type BiasKey =
  | 'chasing_high'
  | 'overtrading'
  | 'anchoring_loss'
  | 'loss_aversion_early_take'
  | 'style_drift'
  | 'time_bias';

export interface BiasFinding {
  bias_key: BiasKey;
  bias_label: string;
  /** 严重度 0-100 */
  severity: number;
  /** 触发的样本数 / 总样本数 */
  triggered_count: number;
  total_count: number;
  /** 阈值与实测 */
  threshold: any;
  observed: any;
  /** 改进建议 */
  suggestions: string[];
  /** 详细诊断 */
  detail: string;
}

export interface BiasReport {
  generated_at: string;
  user_id: number;
  portfolio_id?: number;
  lookback_days: number;
  total_outcomes: number;
  closed_outcomes: number;
  findings: BiasFinding[];
  /** 综合健康度 0-100 (100 = 无偏差) */
  overall_health_score: number;
  /** 主要 1-2 个 bias 的概括 */
  summary_message: string;
}

/**
 * 增量诊断结果 — PM-008: 只在当日新平仓 outcomes 上跑诊断 (用于 DailyAttributionReport.bias_findings).
 *
 * 与 `BiasReport` 区别:
 *   - getReport: 全 lookback (默认 90 天) 所有 closed outcomes — 用于周度复盘 / 操盘手画像
 *   - detectIncremental: 只筛 exit_date === anchor_date 的 outcomes — 用于"今日新增了什么偏差信号"
 *     ⇒ 同一笔套牢 trade 在 95 天里每天都会触发 anchoring_loss; 增量只在它真正平仓那天报一次
 *     ⇒ DailyAttribution 17:00 cron 拿这个塞进 report.bias_findings, 不重复打扰用户
 */
export interface IncrementalBiasResult {
  anchor_date: string;
  user_id: number;
  /** 当日新平仓 outcomes 数 (exit_date === anchor_date) */
  new_closed_count: number;
  /** 当日新触发的 bias 列表 (仅有 triggered_count > 0 的 finding 才返) */
  findings: BiasFinding[];
}

// 简化 outcome 接口（避免 RecommendationTradeOutcome 庞大字段）
export interface OutcomeRow {
  entry_date?: string;
  exit_date?: string | null;
  entry_price?: number | null;
  exit_price?: number | null;
  high_during_5d_before_entry?: number | null; // 入场前 5 日 high
  total_pnl_pct?: number | null;
  realized_pnl_pct?: number | null;
  holding_days?: number | null;
  trade_status?: string;
  /** 信号来源 (KOL / ANN / AE / PM ...) — PM-026 style_drift 用 */
  source_type?: string | null;
  /** 行业 / sector — PM-026 style_drift 备用维度 */
  industry?: string | null;
}

const BIAS_LABELS: Record<BiasKey, string> = {
  chasing_high: '追涨杀跌',
  overtrading: '过度交易',
  anchoring_loss: '套牢死扛',
  loss_aversion_early_take: '落袋为安过早',
  style_drift: '风格漂移',
  time_bias: '时段偏差',
};

// ============================================================
// 纯函数 detectors
// ============================================================

/**
 * Severity 计算: 触发占比 → 0-100。
 *   - 0% 触发 → 0
 *   - 20% 触发 → 50
 *   - 40%+ 触发 → 100
 */
export function computeSeverity(triggered: number, total: number): number {
  if (total <= 0) return 0;
  const pct = triggered / total;
  return Math.min(100, Math.round(pct * 250));
}

/**
 * 检测 chasing_high — 入场价是否近 5 日高位 + 后续亏损。
 *
 * 用 entry_price / high_during_5d_before_entry 比值：
 *   - >= 0.95 视为"追在 5d 高 95% 分位以上" + 最终 loss → triggered
 */
export function detectChasingHigh(outcomes: OutcomeRow[]): {
  triggered: number;
  total: number;
} {
  let total = 0;
  let triggered = 0;
  for (const o of outcomes) {
    if (o.trade_status !== 'closed') continue;
    const entry = Number(o.entry_price || 0);
    const high5d = Number(o.high_during_5d_before_entry || 0);
    const pnl = Number(o.total_pnl_pct ?? o.realized_pnl_pct ?? NaN);
    if (entry <= 0 || high5d <= 0 || !Number.isFinite(pnl)) continue;
    total++;
    const entryRatio = entry / high5d;
    // 入场价 ≥ 5 日 high 95% 且最终亏损
    if (entryRatio >= 0.95 && pnl < 0) triggered++;
  }
  return { triggered, total };
}

/**
 * 检测 overtrading — 单周交易次数 > 5 或 持仓天数 < 3 天占比高。
 *
 * 简化实现: 用 closed outcomes 的平均 holding_days；< 3 → 高 overtrading。
 */
export function detectOvertrading(outcomes: OutcomeRow[]): {
  triggered: number;
  total: number;
  avg_holding_days: number;
} {
  const closed = outcomes.filter(
    o => o.trade_status === 'closed' && Number.isFinite(Number(o.holding_days))
  );
  const total = closed.length;
  const triggered = closed.filter(o => Number(o.holding_days) < 3).length;
  const avgH = total > 0 ? closed.reduce((s, o) => s + Number(o.holding_days || 0), 0) / total : 0;
  return { triggered, total, avg_holding_days: avgH };
}

/**
 * 检测 anchoring_loss — 亏损 outcomes 中 holding_days > 30 天的占比。
 *
 * 套牢死扛 = "我亏了不卖, 等回本" → 亏损 trade 拖太久。
 */
export function detectAnchoringLoss(outcomes: OutcomeRow[]): {
  triggered: number;
  total_losses: number;
} {
  const losses = outcomes.filter(o => {
    if (o.trade_status !== 'closed') return false;
    const pnl = Number(o.total_pnl_pct ?? o.realized_pnl_pct ?? NaN);
    return Number.isFinite(pnl) && pnl < 0;
  });
  const triggered = losses.filter(o => Number(o.holding_days || 0) > 30).length;
  return { triggered, total_losses: losses.length };
}

/**
 * 检测 loss_aversion_early_take — 盈利 outcomes 中 return < 3% 占比。
 *
 * 落袋为安 = "赚 3% 就跑" → 盈利 trade 普遍小额。
 */
export function detectLossAversionEarlyTake(outcomes: OutcomeRow[]): {
  triggered: number;
  total_wins: number;
  avg_winner_return: number;
} {
  const wins = outcomes.filter(o => {
    if (o.trade_status !== 'closed') return false;
    const pnl = Number(o.total_pnl_pct ?? o.realized_pnl_pct ?? NaN);
    return Number.isFinite(pnl) && pnl > 0;
  });
  const triggered = wins.filter(o => {
    const pnl = Number(o.total_pnl_pct ?? o.realized_pnl_pct ?? 0);
    return pnl < 3;
  }).length;
  const avgWin =
    wins.length > 0
      ? wins.reduce((s, o) => s + Number(o.total_pnl_pct ?? o.realized_pnl_pct ?? 0), 0) /
        wins.length
      : 0;
  return { triggered, total_wins: wins.length, avg_winner_return: avgWin };
}

/**
 * 检测 style_drift — 风格漂移 / 系统性偏离原 strategy mix.
 *
 * PM-026: 把 outcomes 按 entry_date 排序后切两段 (前半 vs 后半),
 * 比较 source_type (KOL/ANN/AE/PM/MM ...) 分布的 Total Variation Distance.
 *
 *   TVD = 0.5 × Σ |p_late(s) - p_early(s)|
 *
 *   - TVD < 0.20 → 风格稳定, 不算偏差 (triggered = 0)
 *   - 0.20 ≤ TVD < 0.40 → 中度漂移 (triggered = 1)
 *   - TVD ≥ 0.40 → 显著漂移 (triggered = 2)
 *   - total 始终 = 2 (设计上让 severity 0/50/100 三档 — 与其他 detector 输出量纲一致)
 *
 * total < 6 笔 closed outcomes 时不诊断 (样本太少).
 */
export function detectStyleDrift(outcomes: OutcomeRow[]): {
  triggered: number;
  total: number;
  tvd: number;
  early_dist: Record<string, number>;
  late_dist: Record<string, number>;
} {
  const closed = outcomes
    .filter(o => o.trade_status === 'closed' && o.source_type && o.entry_date)
    .slice()
    .sort((a, b) => String(a.entry_date || '').localeCompare(String(b.entry_date || '')));
  if (closed.length < 6) {
    return { triggered: 0, total: 0, tvd: 0, early_dist: {}, late_dist: {} };
  }
  const mid = Math.floor(closed.length / 2);
  const early = closed.slice(0, mid);
  const late = closed.slice(mid);
  const distOf = (rows: OutcomeRow[]): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const r of rows) {
      const k = String(r.source_type || 'unknown');
      counts[k] = (counts[k] || 0) + 1;
    }
    const n = rows.length || 1;
    const dist: Record<string, number> = {};
    for (const k of Object.keys(counts)) dist[k] = counts[k] / n;
    return dist;
  };
  const earlyDist = distOf(early);
  const lateDist = distOf(late);
  const keys = new Set<string>([...Object.keys(earlyDist), ...Object.keys(lateDist)]);
  let tvd = 0;
  for (const k of keys) tvd += Math.abs((lateDist[k] || 0) - (earlyDist[k] || 0));
  tvd = tvd / 2;
  const total = 2;
  let triggered = 0;
  if (tvd >= 0.4) triggered = 2;
  else if (tvd >= 0.2) triggered = 1;
  return { triggered, total, tvd, early_dist: earlyDist, late_dist: lateDist };
}

/**
 * 检测 time_bias — 系统性时段偏差 (按入场 day-of-week 分组的胜率差距).
 *
 * PM-026: 按 entry_date 的 dow (0=周日 ... 6=周六) 分组, 找胜率最差的那天.
 * 若某 dow 的样本数 ≥ 3, 且其胜率比全局胜率落后 ≥ 20pct,
 * 则视为"时段偏差" → triggered = 该 dow 的 loss 数, total = 该 dow 的样本数.
 *
 * 没有触发任何 dow → triggered=0, total = closed.length (severity = 0).
 * 用 entry_date 'YYYY-MM-DD' 直接 new Date 取 dow, 避免 timezone 复杂化.
 */
export function detectTimeBias(outcomes: OutcomeRow[]): {
  triggered: number;
  total: number;
  worst_dow: number | null;
  worst_winrate: number;
  global_winrate: number;
  by_dow: Record<number, { count: number; wins: number; winrate: number }>;
} {
  const closed = outcomes.filter(o => {
    if (o.trade_status !== 'closed') return false;
    if (!o.entry_date) return false;
    const pnl = Number(o.total_pnl_pct ?? o.realized_pnl_pct ?? NaN);
    return Number.isFinite(pnl);
  });
  const byDow: Record<number, { count: number; wins: number; winrate: number }> = {};
  let globalWins = 0;
  for (const o of closed) {
    const d = new Date(String(o.entry_date).slice(0, 10) + 'T00:00:00Z');
    if (Number.isNaN(d.getTime())) continue;
    const dow = d.getUTCDay();
    if (!byDow[dow]) byDow[dow] = { count: 0, wins: 0, winrate: 0 };
    byDow[dow].count += 1;
    const pnl = Number(o.total_pnl_pct ?? o.realized_pnl_pct ?? 0);
    if (pnl > 0) {
      byDow[dow].wins += 1;
      globalWins += 1;
    }
  }
  for (const k of Object.keys(byDow)) {
    const dow = Number(k);
    byDow[dow].winrate = byDow[dow].count > 0 ? byDow[dow].wins / byDow[dow].count : 0;
  }
  const globalWR = closed.length > 0 ? globalWins / closed.length : 0;
  let worstDow: number | null = null;
  let worstWR = 1;
  for (const k of Object.keys(byDow)) {
    const dow = Number(k);
    const b = byDow[dow];
    if (b.count >= 3 && b.winrate < worstWR) {
      worstWR = b.winrate;
      worstDow = dow;
    }
  }
  if (worstDow === null || globalWR - worstWR < 0.2) {
    return {
      triggered: 0,
      total: closed.length,
      worst_dow: worstDow,
      worst_winrate: worstDow === null ? 0 : worstWR,
      global_winrate: globalWR,
      by_dow: byDow,
    };
  }
  const losses = byDow[worstDow].count - byDow[worstDow].wins;
  return {
    triggered: losses,
    total: byDow[worstDow].count,
    worst_dow: worstDow,
    worst_winrate: worstWR,
    global_winrate: globalWR,
    by_dow: byDow,
  };
}

/**
 * 综合 health_score = 100 - mean(severity of all biases) — PM-026 起 6 类.
 */
export function computeOverallHealth(findings: BiasFinding[]): number {
  if (findings.length === 0) return 100;
  const avgSeverity = findings.reduce((s, f) => s + f.severity, 0) / findings.length;
  return Math.max(0, Math.round(100 - avgSeverity));
}

/**
 * 生成 summary message (1-2 句话)
 */
export function buildSummary(findings: BiasFinding[], healthScore: number): string {
  // 找最严重的 bias
  const sorted = [...findings].sort((a, b) => b.severity - a.severity);
  const top = sorted[0];
  if (!top || top.severity < 30) {
    return `✅ 健康度 ${healthScore} — 未发现明显行为偏差`;
  }
  if (healthScore < 50) {
    return `🔴 健康度 ${healthScore} — 主要偏差: ${top.bias_label} (severity=${top.severity})`;
  }
  return `🟠 健康度 ${healthScore} — 主要偏差: ${top.bias_label} (severity=${top.severity})`;
}

/**
 * 从 outcomes 数组构 4 维 findings 列表 — 纯函数, getReport / detectIncremental 共享.
 *
 * 与原本 inline 在 getReport 里的逻辑等价: 每个 detector 只在 total > 0 时产出 finding;
 * `triggered === 0` 时 severity = 0, suggestions = []. 调用方可再过滤"仅有 triggered"
 * 的 findings (detectIncremental 走这条路, 避免 0 触发的偏差污染当日 bias_findings).
 */
export function buildBiasFindings(outcomes: OutcomeRow[]): BiasFinding[] {
  const findings: BiasFinding[] = [];

  // 1. chasing_high
  const chasing = detectChasingHigh(outcomes);
  if (chasing.total > 0) {
    const sev = computeSeverity(chasing.triggered, chasing.total);
    findings.push({
      bias_key: 'chasing_high',
      bias_label: BIAS_LABELS.chasing_high,
      severity: sev,
      triggered_count: chasing.triggered,
      total_count: chasing.total,
      threshold: { entry_ratio: 0.95, condition: '入场价 ≥ 5d high × 95% AND 最终 loss' },
      observed: {
        triggered_pct:
          chasing.total > 0 ? Math.round((chasing.triggered / chasing.total) * 100) : 0,
      },
      suggestions:
        sev >= 50
          ? [
              '入场前检查 5 日内是否已大涨（>5%）— 大涨后入场命中追高陷阱',
              '加 limit order 等回调；不要市价单追入',
              '考虑加 catalyst 确认（不要因为价格涨就买，要因为基本面变好买）',
            ]
          : sev > 0
          ? ['观察期 — 偶尔追高在可接受范围']
          : [],
      detail: `${chasing.total} 笔有完整 entry_price 数据的 trade 中, ${chasing.triggered} 笔入场点在 5 日 high 95% 以上且最终亏损`,
    });
  }

  // 2. overtrading
  const overtrading = detectOvertrading(outcomes);
  if (overtrading.total > 0) {
    const sev = computeSeverity(overtrading.triggered, overtrading.total);
    findings.push({
      bias_key: 'overtrading',
      bias_label: BIAS_LABELS.overtrading,
      severity: sev,
      triggered_count: overtrading.triggered,
      total_count: overtrading.total,
      threshold: { holding_days: 3, condition: 'holding_days < 3' },
      observed: {
        avg_holding_days: Math.round(overtrading.avg_holding_days * 10) / 10,
        triggered_pct: Math.round((overtrading.triggered / overtrading.total) * 100),
      },
      suggestions:
        sev >= 50
          ? [
              `平均持仓 ${overtrading.avg_holding_days.toFixed(
                1
              )} 天 — 缩短至 < 3 天的 trade 占比 ${Math.round(
                (overtrading.triggered / overtrading.total) * 100
              )}%, 高换手摩擦成本`,
              '加最小持仓期 (如 5 个交易日) 限制；除非 stop_loss 触发',
              '检查是不是被噪音吓出场, 用 ATR-based stop 而非固定 % stop',
            ]
          : sev > 0
          ? ['平均持仓接近健康区间, 偶有短线无影响']
          : [],
      detail: `${overtrading.total} 笔 closed trade 平均持仓 ${overtrading.avg_holding_days.toFixed(
        1
      )} 天, ${overtrading.triggered} 笔 < 3 天`,
    });
  }

  // 3. anchoring_loss
  const anchoring = detectAnchoringLoss(outcomes);
  if (anchoring.total_losses > 0) {
    const sev = computeSeverity(anchoring.triggered, anchoring.total_losses);
    findings.push({
      bias_key: 'anchoring_loss',
      bias_label: BIAS_LABELS.anchoring_loss,
      severity: sev,
      triggered_count: anchoring.triggered,
      total_count: anchoring.total_losses,
      threshold: { holding_days: 30, condition: 'loss AND holding_days > 30' },
      observed: {
        triggered_pct: Math.round((anchoring.triggered / anchoring.total_losses) * 100),
      },
      suggestions:
        sev >= 50
          ? [
              '套牢死扛是心理偏差最难纠正的一种 — 设硬性 30 天 time stop',
              '亏损 > 15% 时强制平仓, 不要"等回本"',
              '复盘那些套牢 > 30 天的 trade — 多数最终不会回本, 早断更好',
            ]
          : sev > 0
          ? ['偶尔有套牢长持, 但不是主导模式']
          : [],
      detail: `${anchoring.total_losses} 笔亏损中, ${anchoring.triggered} 笔持仓 > 30 天才止损`,
    });
  }

  // 4. loss_aversion_early_take
  const lossAvert = detectLossAversionEarlyTake(outcomes);
  if (lossAvert.total_wins > 0) {
    const sev = computeSeverity(lossAvert.triggered, lossAvert.total_wins);
    findings.push({
      bias_key: 'loss_aversion_early_take',
      bias_label: BIAS_LABELS.loss_aversion_early_take,
      severity: sev,
      triggered_count: lossAvert.triggered,
      total_count: lossAvert.total_wins,
      threshold: { return_pct: 3, condition: 'winner AND return < 3%' },
      observed: {
        avg_winner_return: Math.round(lossAvert.avg_winner_return * 100) / 100,
        triggered_pct: Math.round((lossAvert.triggered / lossAvert.total_wins) * 100),
      },
      suggestions:
        sev >= 50
          ? [
              `平均盈利 ${lossAvert.avg_winner_return.toFixed(2)}% — 太低, 切短了大鱼`,
              '用 trailing-stop 让盈利跑 — 设 trailing 3% / 5% / 10% 阶梯',
              '小幅获利就卖等价于支付摩擦成本; 让赢家变大才能 cover losses',
            ]
          : sev > 0
          ? ['少量小赚, 大部分盈利能跑']
          : [],
      detail: `${lossAvert.total_wins} 笔盈利中, ${
        lossAvert.triggered
      } 笔回报 < 3%; 平均盈利 ${lossAvert.avg_winner_return.toFixed(2)}%`,
    });
  }

  // 5. style_drift (PM-026)
  const styleDrift = detectStyleDrift(outcomes);
  if (styleDrift.total > 0) {
    const sev = computeSeverity(styleDrift.triggered, styleDrift.total);
    const tvdPct = Math.round(styleDrift.tvd * 100);
    findings.push({
      bias_key: 'style_drift',
      bias_label: BIAS_LABELS.style_drift,
      severity: sev,
      triggered_count: styleDrift.triggered,
      total_count: styleDrift.total,
      threshold: { tvd_warn: 0.2, tvd_severe: 0.4, condition: 'TVD(early, late) ≥ 0.2 / 0.4' },
      observed: {
        tvd_pct: tvdPct,
        early_top_source: pickTopKey(styleDrift.early_dist),
        late_top_source: pickTopKey(styleDrift.late_dist),
      },
      suggestions:
        sev >= 50
          ? [
              `近期 source_type 主导从 ${pickTopKey(styleDrift.early_dist)} 漂到 ${pickTopKey(
                styleDrift.late_dist
              )} — TVD=${tvdPct}%`,
              '复盘 strategy mix 是否被某类信号源（如 KOL 热门票）裹挟',
              '若漂移确属主动调整, 把它写进操盘手 playbook; 否则回归原 mix',
            ]
          : sev > 0
          ? ['source_type 分布有轻度偏移, 关注是否会继续放大']
          : [],
      detail: `比较前后两半 closed outcomes 的 source_type 分布, TVD=${tvdPct}%`,
    });
  }

  // 6. time_bias (PM-026)
  const timeBias = detectTimeBias(outcomes);
  if (timeBias.total > 0) {
    const sev = computeSeverity(timeBias.triggered, timeBias.total);
    const dowLabel = timeBias.worst_dow !== null ? DOW_LABELS[timeBias.worst_dow] : '—';
    findings.push({
      bias_key: 'time_bias',
      bias_label: BIAS_LABELS.time_bias,
      severity: sev,
      triggered_count: timeBias.triggered,
      total_count: timeBias.total,
      threshold: {
        winrate_gap: 0.2,
        condition: 'dow_count ≥ 3 AND (global_winrate - dow_winrate) ≥ 0.2',
      },
      observed: {
        worst_dow: dowLabel,
        worst_winrate_pct: Math.round(timeBias.worst_winrate * 100),
        global_winrate_pct: Math.round(timeBias.global_winrate * 100),
      },
      suggestions:
        sev >= 50
          ? [
              `${dowLabel} 入场胜率 ${Math.round(
                timeBias.worst_winrate * 100
              )}%, 全局 ${Math.round(timeBias.global_winrate * 100)}% — 显著落后`,
              `避免在 ${dowLabel} 入场, 或对 ${dowLabel} 信号加更严格的过滤`,
              '复盘该时段的市场环境 (流动性 / 情绪) 是否系统性不利于本策略',
            ]
          : sev > 0
          ? [`${dowLabel} 略低于全局胜率, 观察期`]
          : [],
      detail:
        timeBias.worst_dow === null
          ? '未发现显著时段偏差'
          : `${dowLabel} ${timeBias.total} 笔 / ${
              timeBias.triggered
            } 亏损; 胜率 ${Math.round(
              timeBias.worst_winrate * 100
            )}% vs 全局 ${Math.round(timeBias.global_winrate * 100)}%`,
    });
  }

  return findings;
}

const DOW_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function pickTopKey(dist: Record<string, number>): string {
  let best = '';
  let bestV = -1;
  for (const k of Object.keys(dist)) {
    if (dist[k] > bestV) {
      bestV = dist[k];
      best = k;
    }
  }
  return best || 'unknown';
}

/**
 * 从 OutcomeRow[] 中筛"今日新平仓" — exit_date === anchor_date 的 closed outcomes.
 *
 * anchor_date 'YYYY-MM-DD' 直接 string 比对, 避免 timezone 漂移.
 * exit_date 可能是 'YYYY-MM-DD' (DATEONLY) 或 'YYYY-MM-DDTHH:mm:ss' (string-cast),
 * 取前 10 字符即可统一.
 */
export function filterIncrementalOutcomes(
  outcomes: OutcomeRow[],
  anchor_date: string
): OutcomeRow[] {
  if (!anchor_date || anchor_date.length < 10) return [];
  const anchor = anchor_date.slice(0, 10);
  return outcomes.filter(o => {
    if (o.trade_status !== 'closed') return false;
    const exit = o.exit_date ? String(o.exit_date).slice(0, 10) : '';
    return exit === anchor;
  });
}

// ============================================================
// DataSource
// ============================================================

export interface BehaviorBiasDataSource {
  loadOutcomes(user_id: number, lookback_days: number): Promise<OutcomeRow[]>;
}

export const PRODUCTION_BEHAVIOR_BIAS_DATA_SOURCE: BehaviorBiasDataSource = {
  async loadOutcomes(user_id, lookback_days) {
    const since = new Date();
    since.setDate(since.getDate() - lookback_days);
    const sinceStr = since.toISOString().slice(0, 10);
    try {
      // Batch Y (2026-06-17, fact-4 fix): 先查 user 的 portfolio_id list, query
      // WHERE 直接加 portfolio_id IN (...) 让 DB 层过滤. 之前先 findAll(limit:2000)
      // 拉全市场 outcomes 再 JS filter, 跨用户大量产 outcome 时本用户 outcome
      // 落 2000 之外 → filtered 为空 → BehaviorBias 全部假阴性 "无偏差".
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { PaperTradingPortfolio } = require('../models/PaperTradingPortfolio');
      const userPortfolios = await PaperTradingPortfolio.findAll({
        where: { user_id },
        attributes: ['id'],
        raw: true,
      });
      const pidList = userPortfolios.map((p: any) => p.id);
      if (pidList.length === 0) return [];

      const rows = await RecommendationTradeOutcome.findAll({
        where: {
          entry_date: { [Op.gte]: sinceStr },
          portfolio_id: { [Op.in]: pidList },
        },
        attributes: [
          'entry_date',
          'exit_date',
          'entry_price',
          'exit_price',
          'total_pnl_pct',
          'realized_pnl_pct',
          'holding_days',
          'trade_status',
          'source_type',
          'industry',
          'metadata',
          'portfolio_id',
        ],
        limit: 2000,
      });
      // Batch Y: portfolio_id 已在 WHERE 限定, 不需要 JS filter.
      const filtered = rows;
      return filtered.map(r => {
        const md: any = r.metadata || {};
        return {
          entry_date: r.entry_date,
          exit_date: r.exit_date,
          entry_price: Number(r.entry_price ?? NaN),
          exit_price: Number(r.exit_price ?? NaN),
          high_during_5d_before_entry: Number(
            md.high_during_5d_before_entry ?? md.entry_5d_high ?? NaN
          ),
          total_pnl_pct: Number(r.total_pnl_pct ?? NaN),
          realized_pnl_pct: Number(r.realized_pnl_pct ?? NaN),
          holding_days: Number(r.holding_days ?? NaN),
          trade_status: r.trade_status,
          source_type: r.source_type ?? null,
          industry: (r as any).industry ?? null,
        };
      });
    } catch (err: any) {
      logger.warn(`[BehaviorBias] loadOutcomes failed: ${err?.message || err}`);
      return [];
    }
  },
};

// ============================================================
// Service
// ============================================================

export class BehaviorBiasDetector {
  constructor(private dataSource: BehaviorBiasDataSource = PRODUCTION_BEHAVIOR_BIAS_DATA_SOURCE) {}

  /**
   * 跑全部 4 个 detector + 综合健康度。
   *
   * @param user_id 目标 user
   * @param lookback_days 回看天数 (默认 90)
   */
  async getReport(user_id: number, lookback_days = 90): Promise<BiasReport> {
    const outcomes = await this.dataSource.loadOutcomes(user_id, lookback_days);
    const closed = outcomes.filter(o => o.trade_status === 'closed');

    const findings = buildBiasFindings(outcomes);

    const healthScore = computeOverallHealth(findings);
    const summary = buildSummary(findings, healthScore);

    return {
      generated_at: new Date().toISOString(),
      user_id,
      lookback_days,
      total_outcomes: outcomes.length,
      closed_outcomes: closed.length,
      findings,
      overall_health_score: healthScore,
      summary_message: summary,
    };
  }

  /**
   * 增量诊断 — PM-008 (US-085): 只在当日新平仓 outcomes 上跑.
   *
   * 性能 + 信噪比双重优化:
   *   - 不再每天扫 90 天 lookback 重复触发同一笔老套牢 trade (anchoring_loss 失真)
   *   - DailyAttribution 17:00 cron 拿这个结果填 `report.bias_findings` 字段
   *   - 当日无平仓 → findings = [] (caller 写空数组, 不打扰用户)
   *   - 触发后, 仅返 `triggered_count > 0` 的 findings (severity=0 的偏差不入当日报告)
   *
   * @param user_id 用户 ID
   * @param anchor_date 'YYYY-MM-DD' 锚定日期, 通常 = DailyAttribution 的 date
   * @param lookback_days 加载 outcomes 的回看天数 (默认 7 — 当日 exit 的 outcome 一定在最近 7 天 entry,
   *                      DataSource 仍按 lookback_days 筛 entry_date, 因此小值降低 DB 扫描)
   */
  async detectIncremental(
    user_id: number,
    anchor_date: string,
    lookback_days = 7
  ): Promise<IncrementalBiasResult> {
    const outcomes = await this.dataSource.loadOutcomes(user_id, lookback_days);
    const incrementalClosed = filterIncrementalOutcomes(outcomes, anchor_date);
    // 仅触发的 findings 进当日报告 (severity=0 / triggered=0 的偏差不打扰用户).
    const findings = buildBiasFindings(incrementalClosed).filter(f => f.triggered_count > 0);
    return {
      anchor_date: anchor_date ? anchor_date.slice(0, 10) : '',
      user_id,
      new_closed_count: incrementalClosed.length,
      findings,
    };
  }
}

export const behaviorBiasDetector = new BehaviorBiasDetector();
