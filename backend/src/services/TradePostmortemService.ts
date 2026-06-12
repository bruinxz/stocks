/**
 * TradePostmortemService — Phase 5+ 闭环 trade 自动事后复盘
 *
 * 当一笔 outcome 关闭且 root_cause 属于 "可学习" 类别（亏损 / 错入场 / 环境逆转），
 * 自动生成一份 5-bullet 结构化复盘，写入 metadata.postmortem。
 *
 * 不需要 LLM —— 全部基于规则 + 字段聚合：
 *   1. 入场判断: 用了哪个 strategy_key + signal_score
 *   2. 持仓表现: 持仓天数 / 期间最大回撤 / 实际 pnl
 *   3. 环境差异: entry vs exit market_regime / industry_regime
 *   4. 同期同 strategy 的 baseline: 平均 pnl / 胜率
 *   5. 改进建议: 基于 root_cause 给出 1-2 个文字建议
 *
 * 集成方式: RecommendationTradeOutcomeService 在 Phase 5 classify 之后调用本服务，
 * 把 postmortem 内嵌到 outcome.metadata.postmortem 写库。
 *
 * UI 在 RecommendationTradeOutcomes 行展开里渲染。
 */

import { Op } from 'sequelize';
import { RecommendationTradeOutcome } from '../models/RecommendationTradeOutcome';
import type { TradeRootCause } from './TradeRootCauseClassifier';

export interface PostmortemBullet {
  title: string;
  detail: string;
  data?: Record<string, any>;
}

export interface TradePostmortem {
  generated_at: string;
  strategy_key?: string;
  root_cause: string;
  root_cause_label: string;
  total_pnl_pct: number;
  holding_days: number;
  bullets: PostmortemBullet[];
  suggestions: string[];
  similar_baseline?: {
    strategy_key: string;
    sample_size: number;
    avg_pnl_pct: number;
    win_rate: number;
    note: string;
  };
}

export interface PostmortemInput {
  strategy_key?: string;
  root_cause: TradeRootCause | string;
  root_cause_label: string;
  symbol: string;
  total_pnl_pct: number;
  holding_days: number;
  entry_price?: number;
  exit_price?: number;
  max_drawdown_during_hold_pct?: number;
  market_regime_at_entry?: string | null;
  market_regime_at_exit?: string | null;
  signal_catalyst?: string | null;
  exit_reason?: string | null;
  signal_score?: number | null;
  fetch_baseline?: boolean; // 默认 true; false 用于纯函数单测
}

/**
 * "可学习" root cause —— 不是简单 profit_take，需要事后复盘
 */
const LEARNING_ROOT_CAUSES = new Set<string>([
  'stop_loss',
  'wrong_entry',
  'wrong_regime',
  'catalyst_failed',
  'risk_kill_switch',
  'time_stop',
  'backtest_drift',
  'data_quality',
]);

const SUGGESTIONS_BY_ROOT_CAUSE: Record<string, string[]> = {
  stop_loss: [
    '复查止损距离 (atr_risk_pct / trailing_stop) — 是否过松导致单笔损失放大？',
    '检查 entry 时的 signal_score 是否处于策略低分位 (false positive)',
  ],
  wrong_entry: [
    '入场前没有等待 catalyst 确认 — 加严 signal_score 阈值或加确认指标',
    '检查 entry_price 是否在当日高点附近 (FOMO 追高)',
  ],
  wrong_regime: [
    '该策略的 environment_policy 应该限定不在熊市/震荡市运行',
    '考虑加 market_regime 过滤器到策略 generateSignals',
  ],
  catalyst_failed: [
    '降低对单一催化剂的依赖；要求多源确认 (业绩+北向+龙虎榜)',
    '复查催化剂检测的延迟 (是否在事件发生后已扩散)',
  ],
  risk_kill_switch: [
    '本笔被组合级风控熔断；评估是否需要调整 sizing 或 drawdown_breaker 阈值',
  ],
  time_stop: [
    '持仓超期未达预期 — 考虑缩短 hold_days 阈值或加 trailing-stop 加速出场',
  ],
  backtest_drift: [
    '实盘表现显著低于回测；触发 walk-forward 重测或参数 grid-search 再校准',
  ],
  data_quality: [
    '数据异常（缺/错）导致信号失真 — 增加 data freshness 校验',
  ],
};

export class TradePostmortemService {
  /**
   * 主入口 — 输入 outcome 关键字段 + root_cause 后生成 postmortem。
   *
   * @returns null 如果 root_cause 不在 LEARNING_ROOT_CAUSES 集合（profit_take / unknown）
   */
  async generate(input: PostmortemInput): Promise<TradePostmortem | null> {
    if (!LEARNING_ROOT_CAUSES.has(String(input.root_cause))) return null;

    const bullets: PostmortemBullet[] = [];

    // 1. 入场判断
    bullets.push({
      title: '入场判断',
      detail:
        `策略 ${input.strategy_key || '(未知)'} ` +
        (input.signal_score !== null && input.signal_score !== undefined
          ? `signal_score=${input.signal_score.toFixed(2)} `
          : '') +
        (input.signal_catalyst ? `catalyst=${input.signal_catalyst}` : ''),
      data: {
        strategy_key: input.strategy_key,
        signal_score: input.signal_score,
        catalyst: input.signal_catalyst,
      },
    });

    // 2. 持仓表现
    const holdingPnl = `${input.total_pnl_pct.toFixed(2)}%`;
    const dd = input.max_drawdown_during_hold_pct;
    bullets.push({
      title: '持仓表现',
      detail:
        `持仓 ${input.holding_days} 天，最终回报 ${holdingPnl}` +
        (dd && Number.isFinite(dd) ? `，期间最大回撤 ${dd.toFixed(2)}%` : ''),
      data: {
        holding_days: input.holding_days,
        total_pnl_pct: input.total_pnl_pct,
        max_drawdown_during_hold_pct: dd,
        entry_price: input.entry_price,
        exit_price: input.exit_price,
      },
    });

    // 3. 环境差异
    const entryReg = input.market_regime_at_entry || '未知';
    const exitReg = input.market_regime_at_exit || '未知';
    const regimeChanged = entryReg !== exitReg && entryReg !== '未知' && exitReg !== '未知';
    bullets.push({
      title: '市场环境',
      detail:
        `进场: ${entryReg} → 出场: ${exitReg}` +
        (regimeChanged ? ' (期间环境变化，可能影响策略适用性)' : ' (环境稳定)'),
      data: {
        regime_entry: entryReg,
        regime_exit: exitReg,
        regime_changed: regimeChanged,
      },
    });

    // 4. 同期 baseline (从 DB 聚合)
    let baseline = undefined;
    if (input.fetch_baseline !== false && input.strategy_key) {
      baseline = await this.fetchStrategyBaseline(input.strategy_key).catch(() => undefined);
      if (baseline) {
        bullets.push({
          title: '策略基线对比',
          detail:
            `同策略最近 ${baseline.sample_size} 笔平均 pnl=${baseline.avg_pnl_pct.toFixed(2)}%，` +
            `胜率 ${(baseline.win_rate * 100).toFixed(1)}%；本笔 ` +
            (input.total_pnl_pct < baseline.avg_pnl_pct ? '低于' : '高于') +
            `平均`,
          data: baseline,
        });
      }
    }

    // 5. 退出原因 / suggestion
    bullets.push({
      title: '触发出场',
      detail: input.exit_reason || `按 root_cause=${input.root_cause_label}`,
      data: { exit_reason: input.exit_reason, root_cause: input.root_cause },
    });

    const suggestions =
      SUGGESTIONS_BY_ROOT_CAUSE[String(input.root_cause)] ||
      ['复查策略 thesis 与本笔实际表现差异，识别可调参数'];

    return {
      generated_at: new Date().toISOString(),
      strategy_key: input.strategy_key,
      root_cause: String(input.root_cause),
      root_cause_label: input.root_cause_label,
      total_pnl_pct: input.total_pnl_pct,
      holding_days: input.holding_days,
      bullets,
      suggestions,
      similar_baseline: baseline,
    };
  }

  /**
   * 拉取某策略最近 60 天 closed outcomes 算 baseline pnl / win_rate。
   */
  async fetchStrategyBaseline(
    strategy_key: string
  ): Promise<TradePostmortem['similar_baseline']> {
    const since = new Date();
    since.setDate(since.getDate() - 60);
    const sinceStr = since.toISOString().slice(0, 10);

    const rows = await RecommendationTradeOutcome.findAll({
      where: {
        trade_status: 'closed',
        entry_date: { [Op.gte]: sinceStr },
      },
      attributes: ['total_pnl_pct', 'realized_pnl_pct', 'metadata'],
      limit: 5000,
    });
    const matching = rows.filter(r => {
      const md: any = r.metadata || {};
      const sm: any = md.signal_metadata || {};
      const key =
        md.strategy_key ||
        sm.strategy_key ||
        (Array.isArray(md.strategy_keys) ? md.strategy_keys[0] : null);
      return key === strategy_key;
    });

    if (matching.length < 3) return undefined;

    const pnls = matching
      .map(r => Number(r.total_pnl_pct ?? r.realized_pnl_pct ?? NaN))
      .filter(v => Number.isFinite(v));

    if (pnls.length === 0) return undefined;

    const avg = pnls.reduce((s, v) => s + v, 0) / pnls.length;
    const wins = pnls.filter(v => v > 0).length;
    return {
      strategy_key,
      sample_size: pnls.length,
      avg_pnl_pct: this.round(avg, 3),
      win_rate: this.round(wins / pnls.length, 3),
      note: `基于过去 60 天的 ${pnls.length} 笔 closed outcomes 聚合`,
    };
  }

  private round(n: number, decimals: number): number {
    const f = Math.pow(10, decimals);
    return Math.round(n * f) / f;
  }
}

export const tradePostmortemService = new TradePostmortemService();
