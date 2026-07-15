/**
 * ETFRankingService (ETF 排名 → BUY/SELL/HOLD + 仓位分配) — 批5-b, §4.1
 *
 * 纯函数式: 输入 ETFFactorScore[] + 当前持仓, 输出换仓决策 + 目标权重.
 * 无 DB / 无副作用, 便于单测与回测复用.
 *
 * §4.1 排名规则 (top4 买 / top6 卖 缓冲带, 稳态持有 4-6 只):
 *   top_5 = ORDER BY total_score DESC LIMIT 5   (参考带)
 *   top_6 = ORDER BY total_score DESC LIMIT 6
 *   current_holdings SETDIFF top_6  → SELL  (掉出 top6 卖掉)
 *   top_4 SETDIFF current_holdings  → BUY   (严格用 top4 避免边界抖动)
 *   其余                            → HOLD
 *
 * §4.1 仓位分配 (核心总仓位硬顶 70% + 按分数比例缩放 + 单只封顶 15%):
 *   raw_w_i    = score_i / Σ(选中 score)
 *   scaled_w_i = raw_w_i × 70%
 *   final_w_i  = min(scaled_w_i, 15%)
 *   封顶溢出按分数再分配给未封顶 ETF (一轮再归一)
 *
 * 注: total_score 可能为负 (z-score 合成), 分配前做 shift 使 min≥0 保证权重非负.
 */

import { ETFFactorScore } from './ETFFactorService';

export const CORE_TOTAL_CAP_PCT = 0.7; // 核心总仓位硬顶 70%
export const SINGLE_ETF_CAP_PCT = 0.15; // 单只 ETF 硬顶 15%
export const BUY_BAND = 4; // 进入 top4 才买
export const SELL_BAND = 6; // 掉出 top6 才卖

export type ETFAction = 'buy' | 'sell' | 'hold';

export interface ETFRebalanceDecision {
  etf_code: string;
  action: ETFAction;
  total_score: number;
  rank: number; // 1-based, data_incomplete 的排在最后
  /** 目标组合权重 (0..0.15), SELL / 非持仓非选中 = 0 */
  target_weight: number;
  reasons: string[];
}

export interface ETFRankingResult {
  decisions: ETFRebalanceDecision[];
  /** 换仓后应持有的 ETF (target_weight > 0) */
  targetHoldings: string[];
  /** 核心桶总目标仓位 (Σ target_weight, ≤ 0.70) */
  coreTotalWeight: number;
}

export class ETFRankingService {
  /**
   * @param scores 全 universe 的因子分 (含 data_incomplete)
   * @param currentHoldings 当前持有的 ETF 6 位代码
   */
  rank(scores: ETFFactorScore[], currentHoldings: string[] = []): ETFRankingResult {
    const held = new Set(currentHoldings);

    // 只有 data_complete 的参与排名; incomplete 的 total_score = -Infinity 自然垫底
    const ranked = scores.slice().sort((a, b) => b.total_score - a.total_score);
    const eligible = ranked.filter(s => !s.data_incomplete && Number.isFinite(s.total_score));

    const top4 = new Set(eligible.slice(0, BUY_BAND).map(s => s.etf_code));
    const top6 = new Set(eligible.slice(0, SELL_BAND).map(s => s.etf_code));

    // 选中集合 = (当前持仓 ∩ top6) ∪ top4  → 稳态 4-6 只
    const selected = new Set<string>();
    for (const code of top4) selected.add(code);
    for (const code of currentHoldings) if (top6.has(code)) selected.add(code);

    // 仓位分配 (仅对 selected)
    const selectedScores = eligible.filter(s => selected.has(s.etf_code));
    const targetWeight = this.allocate(selectedScores);

    const rankByCode = new Map<string, number>();
    ranked.forEach((s, i) => rankByCode.set(s.etf_code, i + 1));

    const decisions: ETFRebalanceDecision[] = ranked.map(s => {
      const code = s.etf_code;
      const inSelected = selected.has(code);
      const wasHeld = held.has(code);
      let action: ETFAction;
      const reasons: string[] = [];
      if (inSelected && !wasHeld) {
        action = 'buy';
        reasons.push(`进入 top${BUY_BAND} (rank ${rankByCode.get(code)}) → 买入`);
      } else if (inSelected && wasHeld) {
        action = 'hold';
        reasons.push(`仍在 top${SELL_BAND} (rank ${rankByCode.get(code)}) → 持有`);
      } else if (!inSelected && wasHeld) {
        action = 'sell';
        reasons.push(
          s.data_incomplete
            ? '数据不完整 → 卖出'
            : `掉出 top${SELL_BAND} (rank ${rankByCode.get(code)}) → 卖出`
        );
      } else {
        action = 'hold'; // 非持仓且未选中 → 不动 (无仓位)
        reasons.push('未持有且未进入缓冲带 → 不操作');
      }
      if (s.data_incomplete) reasons.push(...s.reasons);
      return {
        etf_code: code,
        action,
        total_score: s.total_score,
        rank: rankByCode.get(code) ?? ranked.length,
        target_weight: action === 'sell' ? 0 : targetWeight.get(code) ?? 0,
        reasons,
      };
    });

    const targetHoldings = decisions.filter(d => d.target_weight > 0).map(d => d.etf_code);
    const coreTotalWeight = decisions.reduce((s, d) => s + d.target_weight, 0);
    return { decisions, targetHoldings, coreTotalWeight };
  }

  /**
   * §4.1 仓位分配: 按分数比例 → 缩放到 70% → 单只封顶 15% → 溢出再分配.
   * score 可能为负, 先 shift 到非负 (min-shift) 再按比例分配.
   */
  private allocate(selected: ETFFactorScore[]): Map<string, number> {
    const out = new Map<string, number>();
    if (!selected.length) return out;

    const minScore = Math.min(...selected.map(s => s.total_score));
    // shift: 若有负分, 整体上移使最低为一个小正数 epsilon (保证有区分度且非负)
    const shift = minScore <= 0 ? -minScore + 1e-6 : 0;
    const weighted = selected.map(s => ({ code: s.etf_code, w: s.total_score + shift }));
    const sum = weighted.reduce((s, x) => s + x.w, 0);
    if (sum <= 0) {
      // 全相等兜底: 均分到 70%, 单只不超 15%
      const eq = Math.min(CORE_TOTAL_CAP_PCT / selected.length, SINGLE_ETF_CAP_PCT);
      for (const s of selected) out.set(s.etf_code, eq);
      return out;
    }

    // raw_w → scaled to 70%
    let scaled = weighted.map(x => ({ code: x.code, w: (x.w / sum) * CORE_TOTAL_CAP_PCT }));

    // 迭代封顶 + 溢出再分配
    const capped = new Set<string>();
    for (let iter = 0; iter < 10; iter += 1) {
      let overflow = 0;
      const uncapped: Array<{ code: string; w: number }> = [];
      for (const x of scaled) {
        if (x.w > SINGLE_ETF_CAP_PCT + 1e-12) {
          overflow += x.w - SINGLE_ETF_CAP_PCT;
          capped.add(x.code);
        } else if (!capped.has(x.code)) {
          uncapped.push(x);
        }
      }
      if (overflow <= 1e-12 || !uncapped.length) break;
      const uncappedSum = uncapped.reduce((s, x) => s + x.w, 0);
      // 溢出按未封顶现权重比例再分配
      const next = scaled.map(x => {
        if (capped.has(x.code)) return { code: x.code, w: SINGLE_ETF_CAP_PCT };
        const add = uncappedSum > 0 ? (x.w / uncappedSum) * overflow : overflow / uncapped.length;
        return { code: x.code, w: x.w + add };
      });
      scaled = next;
    }

    for (const x of scaled) out.set(x.code, Math.min(x.w, SINGLE_ETF_CAP_PCT));
    return out;
  }
}

export const etfRankingService = new ETFRankingService();
