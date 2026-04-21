import {
  Event,
  EventType,
  BarEvent,
  SignalEvent,
  OrderEvent,
  StartEvent,
  EndEvent,
  TimerEvent,
} from './Event';
import { Portfolio } from './Portfolio';
import { OrderManager, Order, FixedSlippageModel, FixedCommissionModel } from './OrderManager';
import { Strategy } from '../strategies/Strategy';
import { DataService } from '../../data/services/DataService';
import { logger } from '../../utils/logger';

export interface BacktestConfig {
  start_date: Date;
  end_date: Date;
  initial_capital: number;
  symbols: string[];
  strategy: Strategy;
  dataService: DataService;
  slippage?: number;
  commissionRate?: number;
  frequency?: 'daily' | 'weekly' | 'monthly';
}

export interface BacktestResult {
  metrics: {
    initial_capital: number;
    final_capital: number;
    total_return: number;
    annualized_return: number;
    sharpe_ratio: number;
    sortino_ratio: number;
    max_drawdown: number;
    win_rate: number;
    profit_loss_ratio: number;
    total_trades: number;
    profit_trades: number;
    loss_trades: number;
    averageHoldingDays: number;
    averageProfit: number;
    averageLoss: number;
  };
  equity_curve: { date: Date; value: number }[];
  trades: any[];
  positions: any[];
  daily_returns: number[];
}

export class BacktestEngine {
  private config: BacktestConfig;
  private portfolio: Portfolio;
  private orderManager: OrderManager;
  private strategy: Strategy;
  private dataService: DataService;
  private events: Event[] = [];
  private currentDate: Date;
  private isRunning = false;
  private eventQueue: Event[] = [];
  private eventHandlers: Map<EventType, ((event: Event) => void)[]> = new Map();
  private totalEventsCount: number = 0;

  constructor(config: BacktestConfig) {
    this.config = config;
    this.portfolio = new Portfolio(config.initial_capital);
    this.orderManager = new OrderManager(
      new FixedSlippageModel(config.slippage || 0.001),
      new FixedCommissionModel(config.commissionRate || 0.0003)
    );
    this.strategy = config.strategy;
    this.dataService = config.dataService;
    this.currentDate = new Date(config.start_date);

    this.registerEventHandlers();
  }

  /**
   * 注册事件处理器
   */
  private registerEventHandlers(): void {
    this.on(EventType.BAR, this.handleBarEvent.bind(this));
    this.on(EventType.SIGNAL, this.handleSignalEvent.bind(this));
    this.on(EventType.FILL, this.handleFillEvent.bind(this));
    this.on(EventType.TIMER, this.handleTimerEvent.bind(this));
    this.on(EventType.START, this.handleStartEvent.bind(this));
    this.on(EventType.END, this.handleEndEvent.bind(this));
  }

  /**
   * 注册事件监听器
   */
  on(eventType: EventType, handler: (event: Event) => void): void {
    if (!this.eventHandlers.has(eventType)) {
      this.eventHandlers.set(eventType, []);
    }
    this.eventHandlers.get(eventType)!.push(handler);
  }

  /**
   * 触发事件
   */
  private emit(event: Event): void {
    this.totalEventsCount++;
    this.eventQueue.push(event);

    const handlers = this.eventHandlers.get(event.type) || [];
    for (const handler of handlers) {
      try {
        handler(event);
      } catch (error) {
        logger.error(`Error handling event ${event.type}:`, error);
      }
    }
  }

  /**
   * 处理K线事件
   */
  private handleBarEvent(event: BarEvent): void {
    const { symbol, time } = event.data;

    // 确保time有效，否则使用event.timestamp
    const effectiveTime = time || event.timestamp;

    // 更新投资组合市值
    const prices = new Map<string, number>();
    prices.set(symbol, event.data.close);
    this.portfolio.updatePositions(prices, effectiveTime);

    // 处理订单
    const orderResults = this.orderManager.processBarEvent(event, this.portfolio);

    // 处理成交事件
    for (const fillEvent of orderResults.fillEvents) {
      this.emit(fillEvent);
    }

    // 通知策略
    this.strategy.onBar(event);

    // 检查是否需要生成信号
    const signals = this.strategy.generateSignals();
    for (const signal of signals) {
      const signalEvent: SignalEvent = {
        type: EventType.SIGNAL,
        timestamp: effectiveTime,
        data: signal,
      };
      this.emit(signalEvent);
    }

    // 每日结束时重置
    if (this.isEndOfDay(effectiveTime)) {
      this.portfolio.resetDailyPnl();
      this.emitTimerEvent('daily', effectiveTime);
    }
  }

  /**
   * 处理信号事件
   */
  private handleSignalEvent(event: SignalEvent): void {
    const { symbol, direction, price, strategyId } = event.data;

    // 根据信号创建订单
    let orderType: 'market' | 'limit' = 'market';
    let orderPrice = price;

    // 如果没有指定价格，使用市价单
    if (!orderPrice) {
      orderType = 'market';
      orderPrice = undefined;
    }

    // 计算下单数量（这里简化处理，实际应根据策略和资金管理）
    const position = this.portfolio.getPosition(symbol);
    let quantity = 0;

    if (direction === 'long' || direction === 'short') {
      // 开仓信号
      const maxQuantity = this.portfolio.maxBuyQuantity(symbol, orderPrice || 0);
      quantity = Math.floor(maxQuantity * 0.1); // 使用10%的资金
      if (quantity <= 0) return;
    } else if (direction === 'exit' && position) {
      // 平仓信号
      quantity = position.quantity;
    }

    if (quantity > 0) {
      const orderDirection = direction === 'short' ? 'sell' : 'buy';
      const order = this.orderManager.createOrder(
        symbol,
        orderDirection,
        orderType,
        quantity,
        orderPrice
      );

      const orderEvent: OrderEvent = {
        type: EventType.ORDER,
        timestamp: event.timestamp,
        data: {
          orderId: order.id,
          symbol,
          direction: orderDirection,
          orderType,
          quantity,
          price: orderPrice,
          timestamp: event.timestamp,
          status: 'pending',
        },
      };

      this.emit(orderEvent);
    }
  }

  /**
   * 处理成交事件
   */
  private handleFillEvent(event: Event): void {
    if (event.type === EventType.FILL) {
      this.portfolio.handleFillEvent(event, this.currentDate);
    }
  }

  /**
   * 处理定时器事件
   */
  private handleTimerEvent(event: TimerEvent): void {
    // 每日、每周、每月结束时可以执行一些操作
    logger.info(`Timer event: ${event.data.interval} at ${event.data.currentDate}`);
  }

  /**
   * 处理开始事件
   */
  private handleStartEvent(event: StartEvent): void {
    logger.info('Backtest started', event.data);
  }

  /**
   * 处理结束事件
   */
  private handleEndEvent(event: EndEvent): void {
    logger.info('Backtest ended', event.data);
    this.isRunning = false;
  }

  /**
   * 触发定时器事件
   */
  private emitTimerEvent(interval: 'daily' | 'weekly' | 'monthly' | 'yearly', time: Date): void {
    const timerEvent: TimerEvent = {
      type: EventType.TIMER,
      timestamp: time,
      data: {
        interval,
        currentDate: time,
      },
    };
    this.emit(timerEvent);
  }

  /**
   * 判断是否为交易日结束
   */
  private isEndOfDay(time: Date): boolean {
    if (!time) {
      return false;
    }
    const hours = time.getHours();
    return hours >= 15; // 下午3点后
  }

  /**
   * 运行回测
   */
  async run(): Promise<BacktestResult> {
    if (this.isRunning) {
      throw new Error('Backtest is already running');
    }

    this.isRunning = true;
    this.totalEventsCount = 0;
    this.eventQueue = [];
    this.portfolio.clear();
    this.orderManager.clear();

    // 触发开始事件
    const startEvent: StartEvent = {
      type: EventType.START,
      timestamp: this.currentDate,
      data: {
        start_date: this.config.start_date,
        end_date: this.config.end_date,
        initial_capital: this.config.initial_capital,
      },
    };
    this.emit(startEvent);

    // 加载历史数据
    logger.info('Loading historical data...');
    const historicalData = await this.loadHistoricalData();
    logger.info(`Loaded ${historicalData.length} bars`);

    // 按时间排序
    historicalData.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    // 事件循环
    logger.info('Starting event loop...');
    for (const bar of historicalData) {
      this.currentDate = bar.timestamp;

      // 触发K线事件
      const barEvent: BarEvent = {
        type: EventType.BAR,
        timestamp: bar.timestamp,
        data: bar,
      };
      this.emit(barEvent);

      // 处理事件队列
      while (this.eventQueue.length > 0) {
        const event = this.eventQueue.shift()!;
        // 事件已经在emit时处理了
      }

      // 检查是否到达结束日期
      if (this.currentDate > this.config.end_date) {
        break;
      }
    }

    // 触发结束事件
    const endEvent: EndEvent = {
      type: EventType.END,
      timestamp: this.currentDate,
      data: {
        final_capital: this.portfolio.getMetrics().total_value,
        total_return: this.calculateTotalReturn(),
        total_trades: this.portfolio.getTrades().length,
        start_date: this.config.start_date,
        end_date: this.currentDate,
      },
    };
    this.emit(endEvent);

    // 计算指标
    const result = this.calculateResults();
    logger.info('Backtest completed');

    return result;
  }

  /**
   * 加载历史数据
   */
  private async loadHistoricalData(): Promise<any[]> {
    const data: any[] = [];
    const { start_date, end_date, symbols } = this.config;

    for (const symbol of symbols) {
      const bars = await this.dataService.getDailyBars(symbol, start_date, end_date);
      data.push(
        ...bars.map(bar => ({
          ...bar,
          symbol,
          timestamp: bar.time,
        }))
      );
    }

    return data;
  }

  /**
   * 计算总收益率
   */
  private calculateTotalReturn(): number {
    const metrics = this.portfolio.getMetrics();
    return ((metrics.total_value - this.config.initial_capital) / this.config.initial_capital) * 100;
  }

  /**
   * 计算回测结果
   */
  private calculateResults(): BacktestResult {
    const trades = this.portfolio.getTrades();
    const positions = this.portfolio.getPositions();
    const equity_curve = this.portfolio.getEquityCurve();
    const daily_returns = this.portfolio.getDailyReturns();

    // 计算交易统计
    const profit_trades = trades.filter(t => t.pnl && t.pnl > 0);
    const loss_trades = trades.filter(t => t.pnl && t.pnl <= 0);

    const totalProfit = profit_trades.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const totalLoss = Math.abs(loss_trades.reduce((sum, t) => sum + (t.pnl || 0), 0));

    const averageProfit = profit_trades.length > 0 ? totalProfit / profit_trades.length : 0;
    const averageLoss = loss_trades.length > 0 ? totalLoss / loss_trades.length : 0;

    const win_rate = trades.length > 0 ? (profit_trades.length / trades.length) * 100 : 0;
    const profit_loss_ratio = averageLoss !== 0 ? averageProfit / averageLoss : 0;

    // 计算持有天数
    const holding_days = trades.filter(t => t.holding_days).map(t => t.holding_days || 0);
    const averageHoldingDays =
      holding_days.length > 0
        ? holding_days.reduce((sum, days) => sum + days, 0) / holding_days.length
        : 0;

    // 计算夏普比率（简化版）
    const sharpe_ratio = this.calculateSharpeRatio(daily_returns);
    const sortino_ratio = this.calculateSortinoRatio(daily_returns);

    // 计算最大回撤
    const max_drawdown = this.calculateMaxDrawdown(equity_curve);

    // 计算年化收益率
    const annualized_return = this.calculateAnnualizedReturn(equity_curve);

    const metrics = this.portfolio.getMetrics();

    return {
      metrics: {
        initial_capital: this.config.initial_capital,
        final_capital: metrics.total_value,
        total_return: this.calculateTotalReturn(),
        annualized_return,
        sharpe_ratio,
        sortino_ratio,
        max_drawdown,
        win_rate,
        profit_loss_ratio,
        total_trades: trades.length,
        profit_trades: profit_trades.length,
        loss_trades: loss_trades.length,
        averageHoldingDays,
        averageProfit,
        averageLoss,
      },
      equity_curve,
      trades,
      positions,
      daily_returns,
    };
  }

  /**
   * 计算夏普比率
   */
  private calculateSharpeRatio(daily_returns: number[], riskFreeRate = 0.03): number {
    if (daily_returns.length === 0) return 0;

    const avgReturn = daily_returns.reduce((sum, r) => sum + r, 0) / daily_returns.length;
    const variance =
      daily_returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / daily_returns.length;
    const stdDev = Math.sqrt(variance);

    if (stdDev === 0) return 0;

    // 年化
    const annualized_return = avgReturn * 252;
    const annualizedStdDev = stdDev * Math.sqrt(252);

    return (annualized_return - riskFreeRate) / annualizedStdDev;
  }

  /**
   * 计算索提诺比率
   */
  private calculateSortinoRatio(daily_returns: number[], riskFreeRate = 0.03): number {
    if (daily_returns.length === 0) return 0;

    const avgReturn = daily_returns.reduce((sum, r) => sum + r, 0) / daily_returns.length;
    const downsideReturns = daily_returns.filter(r => r < 0);

    if (downsideReturns.length === 0) return 0;

    const downsideVariance =
      downsideReturns.reduce((sum, r) => sum + Math.pow(r, 2), 0) / downsideReturns.length;
    const downsideStdDev = Math.sqrt(downsideVariance);

    if (downsideStdDev === 0) return 0;

    // 年化
    const annualized_return = avgReturn * 252;
    const annualizedDownsideStdDev = downsideStdDev * Math.sqrt(252);

    return (annualized_return - riskFreeRate) / annualizedDownsideStdDev;
  }

  /**
   * 计算最大回撤
   */
  private calculateMaxDrawdown(equity_curve: { date: Date; value: number }[]): number {
    if (equity_curve.length === 0) return 0;

    let peak = equity_curve[0].value;
    let max_drawdown = 0;

    for (const point of equity_curve) {
      if (point.value > peak) {
        peak = point.value;
      }
      const drawdown = ((peak - point.value) / peak) * 100;
      if (drawdown > max_drawdown) {
        max_drawdown = drawdown;
      }
    }

    return max_drawdown;
  }

  /**
   * 计算年化收益率
   */
  private calculateAnnualizedReturn(equity_curve: { date: Date; value: number }[]): number {
    if (equity_curve.length < 2) return 0;

    const startValue = equity_curve[0].value;
    const endValue = equity_curve[equity_curve.length - 1].value;
    const total_return = (endValue - startValue) / startValue;

    const start_date = equity_curve[0].date;
    const end_date = equity_curve[equity_curve.length - 1].date;
    const years = (end_date.getTime() - start_date.getTime()) / (1000 * 60 * 60 * 24 * 365.25);

    if (years <= 0) return 0;

    return (Math.pow(1 + total_return, 1 / years) - 1) * 100;
  }

  /**
   * 获取事件记录
   */
  getEvents(): Event[] {
    return []; // 已移除 events 存储以节省内存
  }

  /**
   * 获取当前状态
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      currentDate: this.currentDate,
      portfolioMetrics: this.portfolio.getMetrics(),
      totalEvents: this.totalEventsCount,
      pendingOrders: this.orderManager.getOrders().length,
    };
  }
}
