import { BarEvent, SignalEvent } from '../engine/Event';

export interface Signal {
  symbol: string;
  direction: 'long' | 'short' | 'exit';
  strength?: number;
  price?: number;
  reason?: string;
  strategyId: string;
}

export interface StrategyConfig {
  id: string;
  name: string;
  description?: string;
  parameters?: Record<string, any>;
}

export abstract class Strategy {
  protected config: StrategyConfig;
  protected symbol: string;
  protected data: any[] = [];
  protected signals: Signal[] = [];

  constructor(config: StrategyConfig, symbol: string) {
    this.config = config;
    this.symbol = symbol;
  }

  /**
   * 初始化策略
   */
  abstract initialize(): Promise<void>;

  /**
   * 处理K线数据
   */
  abstract onBar(bar: BarEvent): void;

  /**
   * 生成交易信号
   */
  abstract generateSignals(): Signal[];

  /**
   * 获取策略配置
   */
  getConfig(): StrategyConfig {
    return { ...this.config };
  }

  /**
   * 更新策略参数
   */
  updateParameters(parameters: Record<string, any>): void {
    this.config.parameters = {
      ...this.config.parameters,
      ...parameters,
    };
  }

  /**
   * 获取策略状态
   */
  getStatus(): any {
    return {
      config: this.config,
      symbol: this.symbol,
      dataLength: this.data.length,
      signalCount: this.signals.length,
    };
  }

  /**
   * 重置策略状态
   */
  reset(): void {
    this.data = [];
    this.signals = [];
  }

  /**
   * 添加数据点
   */
  protected addDataPoint(data: any): void {
    this.data.push(data);
    // 保持数据长度，避免内存溢出
    const maxDataPoints = this.config.parameters?.maxDataPoints || 1000;
    if (this.data.length > maxDataPoints) {
      this.data = this.data.slice(-maxDataPoints);
    }
  }

  /**
   * 添加信号
   */
  protected addSignal(signal: Signal): void {
    signal.strategyId = this.config.id;
    this.signals.push(signal);
  }

  /**
   * 清空信号
   */
  protected clearSignals(): void {
    this.signals = [];
  }
}

/**
 * 基础移动平均线策略
 */
export abstract class MovingAverageStrategy extends Strategy {
  protected shortWindow: number;
  protected longWindow: number;
  protected shortMA: number[] = [];
  protected longMA: number[] = [];

  constructor(config: StrategyConfig, symbol: string, shortWindow: number, longWindow: number) {
    super(config, symbol);
    this.shortWindow = shortWindow;
    this.longWindow = longWindow;
  }

  /**
   * 计算移动平均线
   */
  protected calculateMA(prices: number[], window: number): number[] {
    const ma: number[] = [];
    for (let i = window - 1; i < prices.length; i++) {
      const sum = prices.slice(i - window + 1, i + 1).reduce((a, b) => a + b, 0);
      ma.push(sum / window);
    }
    return ma;
  }

  /**
   * 检查金叉（短期均线上穿长期均线）
   */
  protected checkGoldenCross(): boolean {
    if (this.shortMA.length < 2 || this.longMA.length < 2) return false;

    const currentShort = this.shortMA[this.shortMA.length - 1];
    const currentLong = this.longMA[this.longMA.length - 1];
    const prevShort = this.shortMA[this.shortMA.length - 2];
    const prevLong = this.longMA[this.longMA.length - 2];

    return prevShort <= prevLong && currentShort > currentLong;
  }

  /**
   * 检查死叉（短期均线下穿长期均线）
   */
  protected checkDeathCross(): boolean {
    if (this.shortMA.length < 2 || this.longMA.length < 2) return false;

    const currentShort = this.shortMA[this.shortMA.length - 1];
    const currentLong = this.longMA[this.longMA.length - 1];
    const prevShort = this.shortMA[this.shortMA.length - 2];
    const prevLong = this.longMA[this.longMA.length - 2];

    return prevShort >= prevLong && currentShort < currentLong;
  }
}

/**
 * 策略工厂接口
 */
export interface StrategyFactory {
  createStrategy(config: StrategyConfig, symbol: string): Strategy;
}

/**
 * 策略注册表
 */
export class StrategyRegistry {
  private strategies: Map<string, StrategyFactory> = new Map();

  /**
   * 注册策略
   */
  registerStrategy(type: string, factory: StrategyFactory): void {
    this.strategies.set(type, factory);
  }

  /**
   * 创建策略实例
   */
  createStrategy(type: string, config: StrategyConfig, symbol: string): Strategy | null {
    const factory = this.strategies.get(type);
    if (!factory) {
      throw new Error(`Strategy type '${type}' not registered`);
    }
    return factory.createStrategy(config, symbol);
  }

  /**
   * 获取所有已注册的策略类型
   */
  getRegisteredStrategies(): string[] {
    return Array.from(this.strategies.keys());
  }

  /**
   * 检查策略类型是否已注册
   */
  hasStrategy(type: string): boolean {
    return this.strategies.has(type);
  }
}
