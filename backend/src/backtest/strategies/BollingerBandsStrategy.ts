import { BarEvent } from '../engine/Event';
import { Strategy, Signal, StrategyConfig } from './Strategy';
import { BollingerBands } from '../indicators/TechnicalIndicators';

export class BollingerBandsStrategy extends Strategy {
  private position: 'none' | 'long' = 'none';
  private prices: number[] = [];
  private bbIndicator: BollingerBands;

  constructor(config: StrategyConfig, symbol: string) {
    super(config, symbol);
    const period = config.parameters?.period || 20;
    const stdDev = config.parameters?.stdDev || 2;
    this.bbIndicator = new BollingerBands(period, stdDev);
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

    const bbResult = this.bbIndicator.calculate(this.prices);
    
    // Generate signals
    this.clearSignals();
    
    if (bbResult.signal === 'buy' && this.position !== 'long') {
      this.position = 'long';
      this.addSignal({
        symbol: this.symbol,
        direction: 'long',
        strength: 1.0,
        reason: `Price dropped below Lower Band`,
        strategyId: this.config.id,
      });
    } else if (bbResult.signal === 'sell' && this.position === 'long') {
      this.position = 'none';
      this.addSignal({
        symbol: this.symbol,
        direction: 'exit',
        strength: 1.0,
        reason: `Price broke above Upper Band`,
        strategyId: this.config.id,
      });
    }
  }

  generateSignals(): Signal[] {
    return [...this.signals];
  }
}
