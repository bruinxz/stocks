import { BarEvent } from '../engine/Event';
import { MovingAverageStrategy, Signal, StrategyConfig } from './Strategy';

export class MovingAverageCrossoverStrategy extends MovingAverageStrategy {
  private position: 'none' | 'long' | 'short' = 'none';
  private prices: number[] = [];

  constructor(config: StrategyConfig, symbol: string) {
    const parameters = config.parameters || {};
    const shortWindow = parameters.shortWindow || 10;
    const longWindow = parameters.longWindow || 30;
    super(config, symbol, shortWindow, longWindow);
  }

  /**
   * 初始化策略
   */
  async initialize(): Promise<void> {
    this.position = 'none';
    this.prices = [];
    this.shortMA = [];
    this.longMA = [];
    this.clearSignals();
  }

  /**
   * 处理K线数据
   */
  onBar(bar: BarEvent): void {
    if (bar.data.symbol !== this.symbol) return;

    const price = bar.data.close;
    this.prices.push(price);
    this.addDataPoint({
      time: bar.timestamp,
      price,
      open: bar.data.open,
      high: bar.data.high,
      low: bar.data.low,
      volume: bar.data.volume,
    });

    // 计算移动平均线
    if (this.prices.length >= this.longWindow) {
      this.shortMA = this.calculateMA(this.prices, this.shortWindow);
      this.longMA = this.calculateMA(this.prices, this.longWindow);

      // 生成信号
      this.generateSignals();
    }
  }

  /**
   * 生成交易信号
   */
  generateSignals(): Signal[] {
    this.clearSignals();

    if (this.shortMA.length < 2 || this.longMA.length < 2) {
      return [];
    }

    // 检查金叉
    if (this.checkGoldenCross() && this.position !== 'long') {
      this.position = 'long';
      this.addSignal({
        symbol: this.symbol,
        direction: 'long',
        strength: 1.0,
        reason: `Golden cross: SMA${this.shortWindow} crossed above SMA${this.longWindow}`,
        strategyId: this.config.id,
      });
    }

    // 检查死叉
    if (this.checkDeathCross() && this.position === 'long') {
      this.position = 'none';
      this.addSignal({
        symbol: this.symbol,
        direction: 'exit',
        strength: 1.0,
        reason: `Death cross: SMA${this.shortWindow} crossed below SMA${this.longWindow}`,
        strategyId: this.config.id,
      });
    }

    return [...this.signals];
  }

  /**
   * 获取策略状态
   */
  getStatus() {
    const baseStatus = super.getStatus();
    return {
      ...baseStatus,
      position: this.position,
      pricesLength: this.prices.length,
      shortMALength: this.shortMA.length,
      longMALength: this.longMA.length,
      current_price: this.prices.length > 0 ? this.prices[this.prices.length - 1] : null,
      currentShortMA: this.shortMA.length > 0 ? this.shortMA[this.shortMA.length - 1] : null,
      currentLongMA: this.longMA.length > 0 ? this.longMA[this.longMA.length - 1] : null,
    };
  }
}

/**
 * 移动平均线交叉策略工厂
 */
export class MovingAverageCrossoverStrategyFactory {
  createStrategy(config: StrategyConfig, symbol: string): MovingAverageCrossoverStrategy {
    return new MovingAverageCrossoverStrategy(config, symbol);
  }
}
