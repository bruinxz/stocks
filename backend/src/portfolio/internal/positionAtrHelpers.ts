/**
 * US-058 [FE-019] — 持仓 ATR% 列后端计算 helper.
 *
 * 抽到独立模块的两个理由:
 *   (1) PaperTradingFacade.ts 顶部 import 大量 sequelize models + services, ts-node
 *       单测无法 DB-less 加载; 本 helper 是纯函数, 抽出来可与 frontend pure helpers
 *       一起被 backend tests/services/position-metrics-helpers.test.ts 同一文件 import.
 *   (2) 与 frontend/src/pages/workspace/positionMetricsHelpers.ts 的 ATR/DD/days 三档
 *       classify 是同一组业务概念 — backend 算原始 atr_pct 值, frontend 把它落档配色.
 *       两边阈值常量都自带 sanity 单测, 改阈值一处生效不会漂.
 *
 * 与 backend/src/backtest/indicators/TechnicalIndicators.ts ATR class 计算公式一致
 * (Wilder smoothing), 但不带 class state, 直接接 daily bars 数组返 atr / close * 100.
 * 缺数据 / close ≤ 0 → null (UI 渲 "—" 而非误算).
 */

const toNum = (v: any): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

export interface AtrBar {
  high: any;
  low: any;
  close: any;
}

/**
 * 计算 ATR(period) 给定一组日 bar (按时间升序).  返回 % 化的 ATR 相对于最后一根
 * close 的比例 (e.g. 6.5 = 6.5%); 数据不足 / close ≤ 0 → null.
 *
 * 默认 period=14 与 TurtleBreakoutStrategy / DonchianTrendStrategy 同; 调用方
 * 也可显式传 21 / 30 之类适配长期持仓.
 */
export function computeAtrPctFromBars(
  bars: AtrBar[] | null | undefined,
  period = 14
): number | null {
  if (!Array.isArray(bars) || bars.length < period + 1) return null;
  const trueRanges: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const high = toNum(bars[i].high);
    const low = toNum(bars[i].low);
    const prevClose = toNum(bars[i - 1].close);
    if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(prevClose)) continue;
    const tr1 = high - low;
    const tr2 = Math.abs(high - prevClose);
    const tr3 = Math.abs(low - prevClose);
    trueRanges.push(Math.max(tr1, tr2, tr3));
  }
  if (trueRanges.length < period) return null;
  // Wilder smoothing — 与 TechnicalIndicators.ATR 同公式
  let atr = trueRanges.slice(0, period).reduce((acc, v) => acc + v, 0) / period;
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
  }
  const lastClose = toNum(bars[bars.length - 1].close);
  if (!Number.isFinite(lastClose) || lastClose <= 0) return null;
  const pct = (atr / lastClose) * 100;
  if (!Number.isFinite(pct) || pct < 0) return null;
  // 保留 2 位小数 — 与 strategies/*Strategy.ts:160 round(atrPct, 2) 对齐
  return Math.round(pct * 100) / 100;
}
