import { QuantBar } from '../types/QuantTypes';

export function toNumber(value: any, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

export function round(value: any, digits = 4): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  const base = 10 ** digits;
  return Math.round(num * base) / base;
}

export function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value));
}

export function average(values: number[]): number {
  const valid = values.filter(Number.isFinite);
  if (!valid.length) return 0;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

export function stddev(values: number[]): number {
  const valid = values.filter(Number.isFinite);
  if (valid.length < 2) return 0;
  const avg = average(valid);
  const variance = valid.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (valid.length - 1);
  return Math.sqrt(variance);
}

export function pct(current: number, previous: number): number {
  if (!previous || !Number.isFinite(current) || !Number.isFinite(previous)) return 0;
  return ((current - previous) / previous) * 100;
}

export function sum(values: number[]): number {
  return values.reduce((acc, value) => acc + (Number.isFinite(value) ? value : 0), 0);
}

export function sma(values: number[], period: number): number[] {
  if (period <= 0 || values.length < period) return [];
  const result: number[] = [];
  for (let i = period - 1; i < values.length; i++) {
    result.push(average(values.slice(i - period + 1, i + 1)));
  }
  return result;
}

export function ema(values: number[], period: number): number[] {
  if (period <= 0 || values.length < period) return [];
  const result: number[] = [];
  const multiplier = 2 / (period + 1);
  let current = average(values.slice(0, period));
  result.push(current);
  for (let i = period; i < values.length; i++) {
    current = (values[i] - current) * multiplier + current;
    result.push(current);
  }
  return result;
}

export function rsi(values: number[], period = 14): number[] {
  if (values.length < period + 1) return [];
  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    gains.push(change > 0 ? change : 0);
    losses.push(change < 0 ? -change : 0);
  }
  let avgGain = average(gains.slice(0, period));
  let avgLoss = average(losses.slice(0, period));
  const result: number[] = [avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)];
  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }
  return result;
}

export function macd(values: number[], fast = 12, slow = 26, signal = 9) {
  const fastEma = ema(values, fast);
  const slowEma = ema(values, slow);
  if (!fastEma.length || !slowEma.length) return { dif: [], dea: [], histogram: [] };
  const offset = fastEma.length - slowEma.length;
  const alignedFast = fastEma.slice(Math.max(0, offset));
  const dif = slowEma.map((slowValue, index) => alignedFast[index] - slowValue);
  const dea = ema(dif, signal);
  const histOffset = dif.length - dea.length;
  const alignedDif = dif.slice(Math.max(0, histOffset));
  const histogram = dea.map((deaValue, index) => alignedDif[index] - deaValue);
  return { dif: alignedDif, dea, histogram };
}

export function bollinger(values: number[], period = 20, multiplier = 2) {
  if (values.length < period) return { middle: [], upper: [], lower: [] };
  const middle: number[] = [];
  const upper: number[] = [];
  const lower: number[] = [];
  for (let i = period - 1; i < values.length; i++) {
    const window = values.slice(i - period + 1, i + 1);
    const avg = average(window);
    const sd = stddev(window);
    middle.push(avg);
    upper.push(avg + multiplier * sd);
    lower.push(avg - multiplier * sd);
  }
  return { middle, upper, lower };
}

export function atr(bars: QuantBar[], period = 14): number[] {
  if (bars.length < period + 1) return [];
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const highLow = bars[i].high - bars[i].low;
    const highClose = Math.abs(bars[i].high - bars[i - 1].close);
    const lowClose = Math.abs(bars[i].low - bars[i - 1].close);
    trs.push(Math.max(highLow, highClose, lowClose));
  }
  return sma(trs, period);
}

export function obv(bars: QuantBar[]): number[] {
  if (!bars.length) return [];
  const result: number[] = [0];
  for (let i = 1; i < bars.length; i++) {
    const volume = Number(bars[i].volume || 0);
    const previous = result[result.length - 1] || 0;
    if (bars[i].close > bars[i - 1].close) {
      result.push(previous + volume);
    } else if (bars[i].close < bars[i - 1].close) {
      result.push(previous - volume);
    } else {
      result.push(previous);
    }
  }
  return result;
}

export function mfi(bars: QuantBar[], period = 14): number[] {
  if (bars.length < period + 1) return [];
  const positiveFlow: number[] = [];
  const negativeFlow: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const typical = (bars[i].high + bars[i].low + bars[i].close) / 3;
    const prevTypical = (bars[i - 1].high + bars[i - 1].low + bars[i - 1].close) / 3;
    const rawFlow = typical * Number(bars[i].volume || 0);
    positiveFlow.push(typical > prevTypical ? rawFlow : 0);
    negativeFlow.push(typical < prevTypical ? rawFlow : 0);
  }
  const result: number[] = [];
  for (let i = period - 1; i < positiveFlow.length; i++) {
    const positive = sum(positiveFlow.slice(i - period + 1, i + 1));
    const negative = sum(negativeFlow.slice(i - period + 1, i + 1));
    if (negative === 0) {
      result.push(100);
    } else {
      const ratio = positive / negative;
      result.push(100 - 100 / (1 + ratio));
    }
  }
  return result;
}

export function cci(bars: QuantBar[], period = 20): number[] {
  if (bars.length < period) return [];
  const typicalPrices = bars.map(bar => (bar.high + bar.low + bar.close) / 3);
  const result: number[] = [];
  for (let i = period - 1; i < typicalPrices.length; i++) {
    const window = typicalPrices.slice(i - period + 1, i + 1);
    const avg = average(window);
    const meanDeviation = average(window.map(value => Math.abs(value - avg)));
    result.push(meanDeviation ? (typicalPrices[i] - avg) / (0.015 * meanDeviation) : 0);
  }
  return result;
}

export function stochasticKdj(bars: QuantBar[], period = 9, kPeriod = 3, dPeriod = 3) {
  if (bars.length < period) return { k: [], d: [], j: [], rsv: [] };
  const rsv: number[] = [];
  for (let i = period - 1; i < bars.length; i++) {
    const window = bars.slice(i - period + 1, i + 1);
    const highest = Math.max(...window.map(bar => bar.high));
    const lowest = Math.min(...window.map(bar => bar.low));
    const close = bars[i].close;
    rsv.push(highest === lowest ? 50 : ((close - lowest) / (highest - lowest)) * 100);
  }
  const k = ema(rsv, kPeriod);
  const d = ema(k, dPeriod);
  const offset = k.length - d.length;
  const alignedK = k.slice(Math.max(0, offset));
  const j = d.map((dValue, index) => 3 * alignedK[index] - 2 * dValue);
  return { k: alignedK, d, j, rsv };
}

export function adx(bars: QuantBar[], period = 14) {
  if (bars.length < period + 2) return { adx: [], plus_di: [], minus_di: [] };
  const plusDm: number[] = [];
  const minusDm: number[] = [];
  const trueRanges: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const upMove = bars[i].high - bars[i - 1].high;
    const downMove = bars[i - 1].low - bars[i].low;
    plusDm.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDm.push(downMove > upMove && downMove > 0 ? downMove : 0);
    trueRanges.push(
      Math.max(
        bars[i].high - bars[i].low,
        Math.abs(bars[i].high - bars[i - 1].close),
        Math.abs(bars[i].low - bars[i - 1].close)
      )
    );
  }
  const plusDi: number[] = [];
  const minusDi: number[] = [];
  const dx: number[] = [];
  for (let i = period - 1; i < trueRanges.length; i++) {
    const tr = sum(trueRanges.slice(i - period + 1, i + 1));
    const plus = sum(plusDm.slice(i - period + 1, i + 1));
    const minus = sum(minusDm.slice(i - period + 1, i + 1));
    const pdi = tr ? (plus / tr) * 100 : 0;
    const mdi = tr ? (minus / tr) * 100 : 0;
    plusDi.push(pdi);
    minusDi.push(mdi);
    dx.push(pdi + mdi ? (Math.abs(pdi - mdi) / (pdi + mdi)) * 100 : 0);
  }
  return { adx: sma(dx, period), plus_di: plusDi, minus_di: minusDi };
}

export function maxDrawdownFromValues(values: number[]): number {
  let peak = values[0] || 0;
  let maxDrawdown = 0;
  for (const value of values) {
    if (value > peak) peak = value;
    if (peak > 0) maxDrawdown = Math.min(maxDrawdown, ((value - peak) / peak) * 100);
  }
  return maxDrawdown;
}

export function last<T>(values: T[]): T | undefined {
  return values.length ? values[values.length - 1] : undefined;
}

export function valueNDaysAgo(values: number[], days: number): number | undefined {
  if (values.length <= days) return undefined;
  return values[values.length - 1 - days];
}
