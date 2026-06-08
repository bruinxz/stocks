import { BarEvent } from '../engine/Event';
import { Strategy, Signal, StrategyConfig } from './Strategy';
import { MACD } from '../indicators/TechnicalIndicators';

export class MACDStrategy extends Strategy {
  private position: 'none' | 'long' = 'none';
  private prices: number[] = [];
  private macdIndicator: MACD;

  constructor(config: StrategyConfig, symbol: string) {
    super(config, symbol);
    const fastPeriod = config.parameters?.fastPeriod || 12;
    const slowPeriod = config.parameters?.slowPeriod || 26;
    const signalPeriod = config.parameters?.signalPeriod || 9;
    this.macdIndicator = new MACD(fastPeriod, slowPeriod, signalPeriod);
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

    const macdResult = this.macdIndicator.calculate(this.prices);

    // Generate signals
    this.clearSignals();

    if (macdResult.signal === 'buy' && this.position !== 'long') {
      this.position = 'long';
      this.addSignal({
        symbol: this.symbol,
        direction: 'long',
        strength: 1.0,
        reason: `MACD Golden Cross`,
        strategyId: this.config.id,
      });
    } else if (macdResult.signal === 'sell' && this.position === 'long') {
      this.position = 'none';
      this.addSignal({
        symbol: this.symbol,
        direction: 'exit',
        strength: 1.0,
        reason: `MACD Death Cross`,
        strategyId: this.config.id,
      });
    }
  }

  generateSignals(): Signal[] {
    return [...this.signals];
  }
}
