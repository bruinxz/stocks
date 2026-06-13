/**
 * Triple Barrier Method (De Prado AFML Ch.3)
 *
 * 论文 reference:
 *   López de Prado, M. (2018). *Advances in Financial Machine Learning*. Wiley.
 *   Chapter 3: "Labeling"
 *
 * 实现 reference:
 *   hudson-and-thames/mlfinlab labeling.py (Apache 2.0 licensed)
 *
 * **方法**：
 *   给定 entry timestamp t₀ 和持仓方向 side ∈ {-1, +1, 0}：
 *
 *   - **Upper barrier** = entry_price × (1 + pt × σ_t)
 *     - pt: profit-take multiplier (e.g. 2.0)
 *     - σ_t: daily volatility estimate at t₀
 *
 *   - **Lower barrier** = entry_price × (1 - sl × σ_t)
 *     - sl: stop-loss multiplier (e.g. 1.0)
 *
 *   - **Vertical barrier** = t₀ + max_holding_period (e.g. 5 days)
 *
 * **算法**：
 *   从 t₀ 往前走，找第一个被触及的 barrier：
 *
 *     - 上 barrier 先触 → label = +1 (止盈)
 *     - 下 barrier 先触 → label = -1 (止损)
 *     - 时间 barrier 先到 → label = 0 (时间出场)
 *
 * **Meta-labeling 模式 (Ch.3.5)**：
 *   当 side 给定（primary model 已经判方向），label 变为：
 *
 *     - pnl > 0 → label = 1 (该下注)
 *     - pnl ≤ 0 → label = 0 (该跳过)
 *
 *   secondary model 只学"是否下注 + 下多大"，不学方向。
 *
 * **关键 design 判定**：
 *   1. pt/sl 是 σ-scaled 不是 fixed-%。让 barrier 自适应市场 vol。
 *   2. side=+1 (long) 时 upper barrier 是 profit-take；side=-1 (short) 时
 *      lower barrier 是 profit-take（symmetry）。
 *   3. label=0 表示 "时间出场"，对 meta-labeling 重要：是 "没赚没亏" 不是 "市场没动"。
 *   4. vertical barrier 必须存在（避免 trade 无限持仓污染样本）。
 */

export interface TripleBarrierConfig {
  /** profit-take multiplier (× σ_t)；0 表示禁用上 barrier */
  pt: number;
  /** stop-loss multiplier (× σ_t)；0 表示禁用下 barrier */
  sl: number;
  /** 持仓最大天数 → 时间 barrier */
  max_holding_days: number;
}

export const DEFAULT_TRIPLE_BARRIER: TripleBarrierConfig = {
  pt: 2.0,
  sl: 1.0,
  max_holding_days: 5,
};

export interface BarPoint {
  date: string;
  close: number;
}

export interface TripleBarrierEvent {
  entry_date: string;
  entry_price: number;
  /** -1 (short), +1 (long), 0 (no side, learn direction) */
  side?: number;
  /** σ_t (daily vol) at entry */
  target_vol: number;
}

export type BarrierLabel = -1 | 0 | 1;

export interface TripleBarrierOutcome {
  entry_date: string;
  exit_date: string;
  entry_price: number;
  exit_price: number;
  return_pct: number;
  /** -1 = sl hit first; +1 = pt hit first; 0 = time barrier hit first */
  label: BarrierLabel;
  /** for meta-labeling (when side given): 1 if pnl > 0 else 0 */
  meta_label?: 0 | 1;
}

/**
 * 计算 daily volatility (rolling exponential weighted)
 *
 * 公式 (Ch.3.1)：
 *   σ_t = std(daily_returns[-span:])
 *
 * 这里用 simple rolling std 替代 EWMA 简化；prod 推荐用 EWMA span=100。
 */
export function dailyVolatility(closes: number[], span = 100): number[] {
  const N = closes.length;
  const sigma: number[] = new Array(N).fill(0);
  if (N < 2) return sigma;
  // 计算 1-day log returns
  const rets: number[] = [];
  for (let i = 1; i < N; i += 1) {
    if (closes[i - 1] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
    else rets.push(0);
  }
  for (let i = 1; i < N; i += 1) {
    const start = Math.max(0, i - span);
    const window = rets.slice(start, i);
    if (window.length < 2) {
      sigma[i] = 0;
      continue;
    }
    const m = window.reduce((s, v) => s + v, 0) / window.length;
    const v = window.reduce((s, x) => s + (x - m) * (x - m), 0) / (window.length - 1);
    sigma[i] = Math.sqrt(Math.max(0, v));
  }
  return sigma;
}

/**
 * 单 event 跑 triple barrier；返回 outcome。
 *
 * @param bars 按时间升序排序的 bar 数据 (must include entry_date)
 * @param event 入场事件
 * @param cfg barrier 配置
 */
export function evaluateTripleBarrier(
  bars: BarPoint[],
  event: TripleBarrierEvent,
  cfg: TripleBarrierConfig = DEFAULT_TRIPLE_BARRIER
): TripleBarrierOutcome | null {
  // 找 entry index
  const entryIdx = bars.findIndex(b => b.date === event.entry_date);
  if (entryIdx < 0) return null;
  const side = event.side ?? 1; // 默认 long
  if (side === 0) return null;

  const entryPx = event.entry_price > 0 ? event.entry_price : bars[entryIdx].close;
  const sigma = event.target_vol;

  // pt/sl multipliers; 0 = disabled barrier
  const ptBar = cfg.pt > 0 ? entryPx * (1 + side * cfg.pt * sigma) : null;
  const slBar = cfg.sl > 0 ? entryPx * (1 - side * cfg.sl * sigma) : null;
  const verticalIdx = Math.min(entryIdx + cfg.max_holding_days, bars.length - 1);

  // 扫从 entryIdx + 1 到 verticalIdx
  let label: BarrierLabel = 0;
  let exitIdx = verticalIdx;
  for (let i = entryIdx + 1; i <= verticalIdx; i += 1) {
    const c = bars[i].close;
    // upper barrier (profit-take for long; stop-loss for short)
    if (ptBar !== null && side === 1 && c >= ptBar) {
      label = 1;
      exitIdx = i;
      break;
    }
    if (ptBar !== null && side === -1 && c <= ptBar) {
      label = 1;
      exitIdx = i;
      break;
    }
    // lower barrier (stop-loss for long; profit-take for short)
    if (slBar !== null && side === 1 && c <= slBar) {
      label = -1;
      exitIdx = i;
      break;
    }
    if (slBar !== null && side === -1 && c >= slBar) {
      label = -1;
      exitIdx = i;
      break;
    }
  }

  const exitPx = bars[exitIdx].close;
  const ret = side === 1 ? (exitPx - entryPx) / entryPx : (entryPx - exitPx) / entryPx;

  const out: TripleBarrierOutcome = {
    entry_date: bars[entryIdx].date,
    exit_date: bars[exitIdx].date,
    entry_price: entryPx,
    exit_price: exitPx,
    return_pct: ret,
    label,
  };
  // Meta-labeling: 当 caller 给 side 时，加 meta_label
  if (event.side !== undefined && event.side !== 0) {
    out.meta_label = ret > 0 ? 1 : 0;
  }
  return out;
}

/**
 * 批量跑 triple barrier on multiple events
 */
export function evaluateTripleBarriersBatch(
  bars: BarPoint[],
  events: TripleBarrierEvent[],
  cfg: TripleBarrierConfig = DEFAULT_TRIPLE_BARRIER
): TripleBarrierOutcome[] {
  return events
    .map(e => evaluateTripleBarrier(bars, e, cfg))
    .filter((o): o is TripleBarrierOutcome => o !== null);
}
