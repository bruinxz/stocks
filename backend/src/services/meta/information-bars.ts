/**
 * Information-Driven Bars (AFML Ch.2)
 *
 * 论文 reference:
 *   López de Prado, M. (2018). *Advances in Financial Machine Learning*. Wiley.
 *   Chapter 2: "Financial Data Structures"
 *   Section 2.3 — Volume bars, Dollar bars
 *   Section 2.4 — Imbalance bars (Tick / Volume / Dollar Imbalance Bars)
 *   Section 2.5 — Runs bars
 *
 * **核心思想**:
 *
 *   传统 OHLCV bar 按时间等分（每 1 day 一个 bar），但市场信息流速不均匀:
 *
 *     - 高波动 / 大量成交时段: 1 day 包含极多信息
 *     - 低波动 / 清淡时段: 1 day 几乎没信息
 *
 *   按时间采样 → 信息时段欠采样 + 清淡时段过采样 → IID 假设破坏 + sharpe 虚高。
 *
 * **解法**: 按"信息量"采样:
 *
 *   - **Tick bars**:  每 N 笔 trade 形成 1 bar
 *   - **Volume bars**: 每 N 股成交 形成 1 bar
 *   - **Dollar bars**: 每 N 元成交 形成 1 bar  (Best for stock splits)
 *   - **Imbalance bars**: 当 |runningImbalance| 累计到阈值, 形成 1 bar
 *   - **Runs bars**: 类似 imbalance 但用 max(buy_runs, sell_runs) 阈值
 *
 *   优点:
 *     - 每个 bar 信息量近似相同 → 更接近 IID
 *     - 高波动段产生更多 bars → 模型有更细粒度
 *     - 实证 (Easley, Lopez de Prado, O'Hara 2013): dollar bars 接近 normality
 *
 * **A 股适配**:
 *   - 缺 tick-level data → 退化用 daily bar 的 volume / dollar 累积
 *   - 推荐 dollar bars (避免 split / 增发干扰)
 *   - threshold 选取: 让平均 1 day 产生 1-3 bars (启动期)
 *
 * **简化 implementation**:
 *   输入 daily OHLCV → 累积 volume/dollar 直到 threshold → 形成 1 新 bar
 *   (高 volume 日可能拆成 N 个，低 volume 日 N 天合 1 个)
 */

export interface RawBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface InformationBar {
  /** Bar 编号 (顺序) */
  index: number;
  /** Bar 起始日期 (从哪个 raw bar 开始累积) */
  start_date: string;
  /** Bar 结束日期 (累积到这个 raw bar 触发 threshold) */
  end_date: string;
  /** 累积 raw bars 数 (>=1) */
  num_raw_bars: number;
  /** OHLC */
  open: number;
  high: number;
  low: number;
  close: number;
  /** 总 volume (累积) */
  volume: number;
  /** 总 dollar volume (累积) */
  dollar_volume: number;
}

export type BarType = 'volume' | 'dollar' | 'tick';

/**
 * Generate information-driven bars from raw daily OHLCV.
 *
 * 算法:
 *   accum = 0
 *   start_idx = 0
 *   for each raw_bar:
 *     accum += (volume or dollar or 1)
 *     if accum >= threshold:
 *       emit bar (start_idx..current_idx with cumulative OHLC)
 *       accum = 0
 *       start_idx = next
 *
 * 末尾未达 threshold 的 raw bars 不发 (避免不完整 bar 污染样本)。
 *
 * @param bars raw bars sorted by date ASC
 * @param threshold accumulator cutoff (e.g. 1M shares for volume bar)
 * @param bar_type which accumulator to use
 */
export function buildInformationBars(
  bars: RawBar[],
  threshold: number,
  bar_type: BarType = 'dollar'
): InformationBar[] {
  if (threshold <= 0) throw new Error(`buildInformationBars: threshold=${threshold} must be > 0`);
  if (bars.length === 0) return [];

  const out: InformationBar[] = [];
  let accumulator = 0;
  let startIdx = 0;
  let bucketOpen = bars[0].open;
  let bucketHigh = bars[0].high;
  let bucketLow = bars[0].low;
  let bucketClose = bars[0].close;
  let bucketVolume = 0;
  let bucketDollar = 0;

  for (let i = 0; i < bars.length; i += 1) {
    const b = bars[i];
    if (i === startIdx) {
      bucketOpen = b.open;
      bucketHigh = b.high;
      bucketLow = b.low;
    } else {
      bucketHigh = Math.max(bucketHigh, b.high);
      bucketLow = Math.min(bucketLow, b.low);
    }
    bucketClose = b.close;
    bucketVolume += b.volume;
    bucketDollar += b.volume * b.close; // approximation

    const incr = bar_type === 'volume' ? b.volume : bar_type === 'dollar' ? b.volume * b.close : 1;
    accumulator += incr;

    if (accumulator >= threshold) {
      out.push({
        index: out.length,
        start_date: bars[startIdx].date,
        end_date: b.date,
        num_raw_bars: i - startIdx + 1,
        open: bucketOpen,
        high: bucketHigh,
        low: bucketLow,
        close: bucketClose,
        volume: bucketVolume,
        dollar_volume: bucketDollar,
      });
      // reset
      accumulator = 0;
      startIdx = i + 1;
      bucketVolume = 0;
      bucketDollar = 0;
    }
  }

  return out;
}

/**
 * Imbalance bars (Section 2.4)
 *
 * 当 |Σ b_t · v_t| 超过 expected threshold 时形成 1 bar.
 *
 * b_t ∈ {+1, -1}: tick rule (price up → +1, price down → -1)
 * v_t: volume per tick (or daily volume * sign(close - prev_close))
 *
 * 这里用 daily bar 简化:
 *   sign = sign(close - prev_close)
 *   imbalance += sign × volume
 *   if |imbalance| >= threshold → emit bar
 *
 * @param bars sorted daily OHLCV
 * @param threshold |imbalance| cutoff
 */
export function buildImbalanceBars(bars: RawBar[], threshold: number): InformationBar[] {
  if (threshold <= 0) throw new Error(`buildImbalanceBars: threshold=${threshold} must be > 0`);
  if (bars.length < 2) return [];

  const out: InformationBar[] = [];
  let imbalance = 0;
  let startIdx = 0;
  let bucketOpen = bars[0].open;
  let bucketHigh = bars[0].high;
  let bucketLow = bars[0].low;
  let bucketClose = bars[0].close;
  let bucketVolume = 0;
  let bucketDollar = 0;

  for (let i = 0; i < bars.length; i += 1) {
    const b = bars[i];
    if (i === startIdx) {
      bucketOpen = b.open;
      bucketHigh = b.high;
      bucketLow = b.low;
    } else {
      bucketHigh = Math.max(bucketHigh, b.high);
      bucketLow = Math.min(bucketLow, b.low);
    }
    bucketClose = b.close;
    bucketVolume += b.volume;
    bucketDollar += b.volume * b.close;

    // tick rule (vs prev close)
    let sign = 0;
    if (i > 0) {
      sign = Math.sign(b.close - bars[i - 1].close);
    }
    imbalance += sign * b.volume;

    if (Math.abs(imbalance) >= threshold) {
      out.push({
        index: out.length,
        start_date: bars[startIdx].date,
        end_date: b.date,
        num_raw_bars: i - startIdx + 1,
        open: bucketOpen,
        high: bucketHigh,
        low: bucketLow,
        close: bucketClose,
        volume: bucketVolume,
        dollar_volume: bucketDollar,
      });
      imbalance = 0;
      startIdx = i + 1;
      bucketVolume = 0;
      bucketDollar = 0;
    }
  }

  return out;
}

/**
 * Auto-calibrate threshold so that average bar count per day ≈ target_per_day
 *
 * 给定历史 raw bars，二分搜索 threshold:
 *   - 总信息量 (sum of volume / dollar) / target_total_bars = threshold candidate
 *   - 真跑 buildInformationBars 看实际 bar 数
 *   - 调整 threshold 让 bars_per_day ≈ target
 */
export function autoCalibrateThreshold(
  bars: RawBar[],
  bar_type: BarType,
  target_bars_per_day: number
): number {
  if (bars.length === 0) return 1;
  // 简化: total / (target × n_days)
  let total = 0;
  for (const b of bars) {
    total += bar_type === 'volume' ? b.volume : bar_type === 'dollar' ? b.volume * b.close : 1;
  }
  const targetTotalBars = target_bars_per_day * bars.length;
  return Math.max(1, total / targetTotalBars);
}
