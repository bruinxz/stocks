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
  | 'loss_aversion_early_take';

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
}

const BIAS_LABELS: Record<BiasKey, string> = {
  chasing_high: '追涨杀跌',
  overtrading: '过度交易',
  anchoring_loss: '套牢死扛',
  loss_aversion_early_take: '落袋为安过早',
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
  const closed = outcomes.filter(o => o.trade_status === 'closed' && Number.isFinite(Number(o.holding_days)));
  const total = closed.length;
  const triggered = closed.filter(o => Number(o.holding_days) < 3).length;
  const avgH =
    total > 0
      ? closed.reduce((s, o) => s + Number(o.holding_days || 0), 0) / total
      : 0;
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
  const triggered = losses.filter(
    o => Number(o.holding_days || 0) > 30
  ).length;
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
      ? wins.reduce((s, o) => s + Number(o.total_pnl_pct ?? o.realized_pnl_pct ?? 0), 0) / wins.length
      : 0;
  return { triggered, total_wins: wins.length, avg_winner_return: avgWin };
}

/**
 * 综合 health_score = 100 - mean(severity of all 4 biases)
 */
export function computeOverallHealth(findings: BiasFinding[]): number {
  if (findings.length === 0) return 100;
  const avgSeverity =
    findings.reduce((s, f) => s + f.severity, 0) / findings.length;
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
      // 通过 portfolio_id 找该 user 的所有 outcomes
      const rows = await RecommendationTradeOutcome.findAll({
        where: {
          entry_date: { [Op.gte]: sinceStr },
          // portfolio_id IN (user 的 portfolios)
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
          'metadata',
          'portfolio_id',
        ],
        limit: 2000,
      });
      // 过滤为 user 拥有的 portfolio 的 outcomes
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { PaperTradingPortfolio } = require('../models/PaperTradingPortfolio');
      const userPortfolios = await PaperTradingPortfolio.findAll({
        where: { user_id },
        attributes: ['id'],
      });
      const pidSet = new Set(userPortfolios.map((p: any) => p.id));
      const filtered = rows.filter(r => pidSet.has(r.portfolio_id));
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
  constructor(
    private dataSource: BehaviorBiasDataSource = PRODUCTION_BEHAVIOR_BIAS_DATA_SOURCE
  ) {}

  /**
   * 跑全部 4 个 detector + 综合健康度。
   *
   * @param user_id 目标 user
   * @param lookback_days 回看天数 (默认 90)
   */
  async getReport(user_id: number, lookback_days = 90): Promise<BiasReport> {
    const outcomes = await this.dataSource.loadOutcomes(user_id, lookback_days);
    const closed = outcomes.filter(o => o.trade_status === 'closed');

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
          triggered_pct: chasing.total > 0 ? Math.round((chasing.triggered / chasing.total) * 100) : 0,
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
                `平均持仓 ${overtrading.avg_holding_days.toFixed(1)} 天 — 缩短至 < 3 天的 trade 占比 ${Math.round((overtrading.triggered / overtrading.total) * 100)}%, 高换手摩擦成本`,
                '加最小持仓期 (如 5 个交易日) 限制；除非 stop_loss 触发',
                '检查是不是被噪音吓出场, 用 ATR-based stop 而非固定 % stop',
              ]
            : sev > 0
              ? ['平均持仓接近健康区间, 偶有短线无影响']
              : [],
        detail: `${overtrading.total} 笔 closed trade 平均持仓 ${overtrading.avg_holding_days.toFixed(1)} 天, ${overtrading.triggered} 笔 < 3 天`,
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
        detail: `${lossAvert.total_wins} 笔盈利中, ${lossAvert.triggered} 笔回报 < 3%; 平均盈利 ${lossAvert.avg_winner_return.toFixed(2)}%`,
      });
    }

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
}

export const behaviorBiasDetector = new BehaviorBiasDetector();
