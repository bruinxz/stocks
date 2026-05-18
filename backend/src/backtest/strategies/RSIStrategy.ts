import { BarEvent } from '../engine/Event';
import { Strategy, Signal, StrategyConfig } from './Strategy';
import { RSI } from '../indicators/TechnicalIndicators';

export class RSIStrategy extends Strategy {
  private position: 'none' | 'long' = 'none';
  private prices: number[] = [];
  private rsiIndicator: RSI;

  constructor(config: StrategyConfig, symbol: string) {
    super(config, symbol);
    const period = config.parameters?.period || 14;
    const overbought = config.parameters?.overbought || 70;
    const oversold = config.parameters?.oversold || 30;
    this.rsiIndicator = new RSI(period, overbought, oversold);
  }

  async initialize(): Promise<void> {
    this.position = 'none';
    this.prices = [];
    this.clearSignals();
  }

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

    const rsiResult = this.rsiIndicator.calculate(this.prices);
    
    // Generate signals
    this.clearSignals();
    
    if (rsiResult.signal === 'buy' && this.position !== 'long') {
      this.position = 'long';
      this.addSignal({
        symbol: this.symbol,
        direction: 'long',
        strength: 1.0,
        reason: `RSI oversold (${rsiResult.value[rsiResult.value.length - 1].toFixed(2)} <= ${this.config.parameters?.oversold})`,
        strategyId: this.config.id,
      });
    } else if (rsiResult.signal === 'sell' && this.position === 'long') {
      this.position = 'none';
      this.addSignal({
        symbol: this.symbol,
        direction: 'exit',
        strength: 1.0,
        reason: `RSI overbought (${rsiResult.value[rsiResult.value.length - 1].toFixed(2)} >= ${this.config.parameters?.overbought})`,
        strategyId: this.config.id,
      });
    }
  }

  generateSignals(): Signal[] {
    return [...this.signals];
  }
}
