export interface IndicatorResult {
  value: any;
  signal?: 'buy' | 'sell' | 'neutral';
  metadata?: any;
}

export abstract class TechnicalIndicator {
  protected name: string;
  protected parameters: Record<string, any>;

  constructor(name: string, parameters: Record<string, any> = {}) {
    this.name = name;
    this.parameters = parameters;
  }

  /**
   * 计算指标
   */
  abstract calculate(data: any): IndicatorResult;

  /**
   * 获取指标名称
   */
  getName(): string {
    return this.name;
  }

  /**
   * 获取参数
   */
  getParameters(): Record<string, any> {
    return { ...this.parameters };
  }

  /**
   * 更新参数
   */
  updateParameters(parameters: Record<string, any>): void {
    this.parameters = { ...this.parameters, ...parameters };
  }
}

/**
 * 简单移动平均线 (SMA)
 */
export class SMA extends TechnicalIndicator {
  constructor(period = 20) {
    super('SMA', { period });
  }

  calculate(data: number[]): IndicatorResult {
    const period = this.parameters.period;
    if (data.length < period) {
      return { value: [], signal: 'neutral' };
    }

    const smaValues: number[] = [];
    for (let i = period - 1; i < data.length; i++) {
      const sum = data.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
      smaValues.push(sum / period);
    }

    return {
      value: smaValues,
      signal: 'neutral',
      metadata: { period },
    };
  }
}

/**
 * 指数移动平均线 (EMA)
 */
export class EMA extends TechnicalIndicator {
  constructor(period = 20) {
    super('EMA', { period });
  }

  calculate(data: number[]): IndicatorResult {
    const period = this.parameters.period;
    if (data.length < period) {
      return { value: [], signal: 'neutral' };
    }

    const emaValues: number[] = [];
    const multiplier = 2 / (period + 1);

    // 计算第一个SMA作为EMA的起点
    let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
    emaValues.push(ema);

    // 计算后续EMA
    for (let i = period; i < data.length; i++) {
      ema = (data[i] - ema) * multiplier + ema;
      emaValues.push(ema);
    }

    return {
      value: emaValues,
      signal: 'neutral',
      metadata: { period, multiplier },
    };
  }
}

/**
 * 相对强弱指数 (RSI)
 */
export class RSI extends TechnicalIndicator {
  constructor(period = 14, overbought = 70, oversold = 30) {
    super('RSI', { period, overbought, oversold });
  }

  calculate(data: number[]): IndicatorResult {
    const { period, overbought, oversold } = this.parameters;
    if (data.length < period + 1) {
      return { value: [], signal: 'neutral' };
    }

    const rsiValues: number[] = [];
    const gains: number[] = [];
    const losses: number[] = [];

    // 计算价格变化
    for (let i = 1; i < data.length; i++) {
      const change = data[i] - data[i - 1];
      gains.push(change > 0 ? change : 0);
      losses.push(change < 0 ? -change : 0);
    }

    // 计算初始平均值
    let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
    let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

    // 计算第一个RSI
    if (avgLoss === 0) {
      rsiValues.push(100);
    } else {
      const rs = avgGain / avgLoss;
      rsiValues.push(100 - 100 / (1 + rs));
    }

    // 计算后续RSI
    for (let i = period; i < gains.length; i++) {
      avgGain = (avgGain * (period - 1) + gains[i]) / period;
      avgLoss = (avgLoss * (period - 1) + losses[i]) / period;

      if (avgLoss === 0) {
        rsiValues.push(100);
      } else {
        const rs = avgGain / avgLoss;
        rsiValues.push(100 - 100 / (1 + rs));
      }
    }

    // 生成信号
    let signal: 'buy' | 'sell' | 'neutral' = 'neutral';
    if (rsiValues.length > 0) {
      const lastRSI = rsiValues[rsiValues.length - 1];
      if (lastRSI <= oversold) {
        signal = 'buy';
      } else if (lastRSI >= overbought) {
        signal = 'sell';
      }
    }

    return {
      value: rsiValues,
      signal,
      metadata: { period, overbought, oversold },
    };
  }
}

/**
 * 移动平均收敛发散 (MACD)
 */
export class MACD extends TechnicalIndicator {
  constructor(fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
    super('MACD', { fastPeriod, slowPeriod, signalPeriod });
  }

  calculate(data: number[]): IndicatorResult {
    const { fastPeriod, slowPeriod, signalPeriod } = this.parameters;
    if (data.length < slowPeriod) {
      return { value: { macd: [], signal: [], histogram: [] }, signal: 'neutral' };
    }

    // 计算快慢EMA
    const fastEMA = new EMA(fastPeriod).calculate(data);
    const slowEMA = new EMA(slowPeriod).calculate(data);

    if (!Array.isArray(fastEMA.value) || !Array.isArray(slowEMA.value)) {
      return { value: { macd: [], signal: [], histogram: [] }, signal: 'neutral' };
    }

    // 对齐EMA数组（慢EMA较短）
    const offset = fastEMA.value.length - slowEMA.value.length;
    const alignedFastEMA = fastEMA.value.slice(offset);

    // 计算MACD线
    const macdLine: number[] = [];
    for (let i = 0; i < alignedFastEMA.length; i++) {
      macdLine.push(alignedFastEMA[i] - slowEMA.value[i]);
    }

    // 计算信号线（MACD的EMA）
    const signalLine = new EMA(signalPeriod).calculate(macdLine);
    if (!Array.isArray(signalLine.value)) {
      return { value: { macd: macdLine, signal: [], histogram: [] }, signal: 'neutral' };
    }

    // 计算柱状图
    const histogram: number[] = [];
    const signalOffset = macdLine.length - signalLine.value.length;
    const alignedMACD = macdLine.slice(signalOffset);

    for (let i = 0; i < signalLine.value.length; i++) {
      histogram.push(alignedMACD[i] - signalLine.value[i]);
    }

    // 生成信号
    let signal: 'buy' | 'sell' | 'neutral' = 'neutral';
    if (histogram.length >= 2) {
      const lastHist = histogram[histogram.length - 1];
      const prevHist = histogram[histogram.length - 2];

      if (prevHist < 0 && lastHist > 0) {
        signal = 'buy'; // 柱状图由负转正
      } else if (prevHist > 0 && lastHist < 0) {
        signal = 'sell'; // 柱状图由正转负
      }
    }

    return {
      value: {
        macd: alignedMACD,
        signal: signalLine.value,
        histogram,
      },
      signal,
      metadata: { fastPeriod, slowPeriod, signalPeriod },
    };
  }
}

/**
 * 布林带 (Bollinger Bands)
 */
export class BollingerBands extends TechnicalIndicator {
  constructor(period = 20, stdDev = 2) {
    super('BollingerBands', { period, stdDev });
  }

  calculate(data: number[]): IndicatorResult {
    const { period, stdDev } = this.parameters;
    if (data.length < period) {
      return { value: { upper: [], middle: [], lower: [] }, signal: 'neutral' };
    }

    const upperBand: number[] = [];
    const middleBand: number[] = [];
    const lowerBand: number[] = [];

    for (let i = period - 1; i < data.length; i++) {
      const slice = data.slice(i - period + 1, i + 1);
      const mean = slice.reduce((a, b) => a + b, 0) / period;
      const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
      const standardDeviation = Math.sqrt(variance);

      middleBand.push(mean);
      upperBand.push(mean + standardDeviation * stdDev);
      lowerBand.push(mean - standardDeviation * stdDev);
    }

    // 生成信号（价格触及布林带边界）
    let signal: 'buy' | 'sell' | 'neutral' = 'neutral';
    if (data.length > period && middleBand.length > 0) {
      const currentPrice = data[data.length - 1];
      const currentUpper = upperBand[upperBand.length - 1];
      const currentLower = lowerBand[lowerBand.length - 1];

      if (currentPrice <= currentLower) {
        signal = 'buy';
      } else if (currentPrice >= currentUpper) {
        signal = 'sell';
      }
    }

    return {
      value: { upper: upperBand, middle: middleBand, lower: lowerBand },
      signal,
      metadata: { period, stdDev },
    };
  }
}

/**
 * 平均真实范围 (ATR)
 */
export class ATR extends TechnicalIndicator {
  constructor(period = 14) {
    super('ATR', { period });
  }

  calculate(data: { high: number; low: number; close: number }[]): IndicatorResult {
    const period = this.parameters.period;
    if (data.length < period + 1) {
      return { value: [], signal: 'neutral' };
    }

    const trueRanges: number[] = [];

    for (let i = 1; i < data.length; i++) {
      const high = data[i].high;
      const low = data[i].low;
      const prevClose = data[i - 1].close;

      const tr1 = high - low;
      const tr2 = Math.abs(high - prevClose);
      const tr3 = Math.abs(low - prevClose);

      trueRanges.push(Math.max(tr1, tr2, tr3));
    }

    // 计算ATR
    const atrValues: number[] = [];
    let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
    atrValues.push(atr);

    for (let i = period; i < trueRanges.length; i++) {
      atr = (atr * (period - 1) + trueRanges[i]) / period;
      atrValues.push(atr);
    }

    return {
      value: atrValues,
      signal: 'neutral',
      metadata: { period },
    };
  }
}

/**
 * 指标管理器
 */
export class IndicatorManager {
  private indicators: Map<string, TechnicalIndicator> = new Map();

  /**
   * 添加指标
   */
  addIndicator(name: string, indicator: TechnicalIndicator): void {
    this.indicators.set(name, indicator);
  }

  /**
   * 获取指标
   */
  getIndicator(name: string): TechnicalIndicator | undefined {
    return this.indicators.get(name);
  }

  /**
   * 移除指标
   */
  removeIndicator(name: string): boolean {
    return this.indicators.delete(name);
  }

  /**
   * 计算所有指标
   */
  calculateAll(data: number[]): Record<string, IndicatorResult> {
    const results: Record<string, IndicatorResult> = {};

    for (const [name, indicator] of this.indicators.entries()) {
      results[name] = indicator.calculate(data);
    }

    return results;
  }

  /**
   * 获取所有指标名称
   */
  getIndicatorNames(): string[] {
    return Array.from(this.indicators.keys());
  }

  /**
   * 清空所有指标
   */
  clear(): void {
    this.indicators.clear();
  }
}
