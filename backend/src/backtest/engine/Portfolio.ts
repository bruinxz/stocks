import { EventType, FillEvent } from './Event';

export interface Position {
  symbol: string;
  quantity: number;
  entryPrice: number;
  currentPrice: number;
  entryDate: Date;
  entryValue: number;
  currentValue: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  direction: 'long' | 'short';
}

export interface Trade {
  id: string;
  symbol: string;
  entryDate: Date;
  exitDate?: Date;
  entryPrice: number;
  exitPrice?: number;
  quantity: number;
  direction: 'long' | 'short';
  pnl?: number;
  pnlPercent?: number;
  holdingDays?: number;
  status: 'open' | 'closed';
  commission?: number;
}

export interface PortfolioMetrics {
  totalValue: number;
  cash: number;
  positionsValue: number;
  unrealizedPnl: number;
  realizedPnl: number;
  totalPnl: number;
  dailyPnl: number;
  dailyReturn: number;
}

export class Portfolio {
  private cash: number;
  private positions: Map<string, Position> = new Map();
  private trades: Trade[] = [];
  private tradeCounter = 1;
  private realizedPnl = 0;
  private dailyPnl = 0;
  private dailyReturns: number[] = [];
  private equityCurve: { date: Date; value: number }[] = [];

  constructor(initialCapital: number) {
    this.cash = initialCapital;
  }

  /**
   * 处理成交事件
   */
  handleFillEvent(event: FillEvent, effectiveTime: Date): void {
    const { symbol, direction, filledQuantity, filledPrice, commission } = event.data;
    const tradeValue = filledQuantity * filledPrice;

    if (direction === 'buy') {
      // 买入
      this.cash -= tradeValue;
      this.cash -= commission;

      const existingPosition = this.positions.get(symbol);
      if (existingPosition) {
        // 加仓
        const totalQuantity = existingPosition.quantity + filledQuantity;
        const totalCost = existingPosition.entryValue + tradeValue;
        const averagePrice = totalCost / totalQuantity;

        existingPosition.quantity = totalQuantity;
        existingPosition.entryPrice = averagePrice;
        existingPosition.entryValue = totalCost;
      } else {
        // 新开仓
        this.positions.set(symbol, {
          symbol,
          quantity: filledQuantity,
          entryPrice: filledPrice,
          currentPrice: filledPrice,
          entryDate: effectiveTime,
          entryValue: tradeValue,
          currentValue: tradeValue,
          unrealizedPnl: 0,
          unrealizedPnlPercent: 0,
          direction: 'long',
        });
      }

      // 记录交易
      this.trades.push({
        id: `trade_${this.tradeCounter++}`,
        symbol,
        entryDate: effectiveTime,
        entryPrice: filledPrice,
        quantity: filledQuantity,
        direction: 'long',
        status: 'open',
        commission,
      });
    } else if (direction === 'sell') {
      // 卖出
      const existingPosition = this.positions.get(symbol);
      if (!existingPosition) {
        throw new Error(`No position found for ${symbol}`);
      }

      if (filledQuantity > existingPosition.quantity) {
        throw new Error(`Insufficient position for ${symbol}`);
      }

      // 更新仓位
      existingPosition.quantity -= filledQuantity;
      const soldValue = filledQuantity * filledPrice;
      this.cash += soldValue;
      this.cash -= commission;

      // 计算已实现盈亏
      const realizedPnl = (filledPrice - existingPosition.entryPrice) * filledQuantity;
      this.realizedPnl += realizedPnl;
      this.dailyPnl += realizedPnl;

      // 如果仓位为0，移除
      if (existingPosition.quantity === 0) {
        this.positions.delete(symbol);
      }

      // 更新交易记录
      const openTrade = this.trades.find(
        t => t.symbol === symbol && t.status === 'open' && t.direction === 'long'
      );
      if (openTrade) {
        openTrade.exitDate = effectiveTime;
        openTrade.exitPrice = filledPrice;
        openTrade.pnl = realizedPnl;
        openTrade.pnlPercent = (realizedPnl / (openTrade.entryPrice * openTrade.quantity)) * 100;
        openTrade.holdingDays = Math.floor(
          (openTrade.exitDate.getTime() - openTrade.entryDate.getTime()) / (1000 * 60 * 60 * 24)
        );
        openTrade.status = 'closed';
        openTrade.commission = commission;
      }
    }
  }

  /**
   * 更新仓位市值
   */
  updatePositions(prices: Map<string, number>, date: Date): void {
    let totalPositionsValue = 0;

    for (const [symbol, position] of this.positions.entries()) {
      const currentPrice = prices.get(symbol) || position.currentPrice;
      position.currentPrice = currentPrice;
      position.currentValue = position.quantity * currentPrice;
      position.unrealizedPnl = position.currentValue - position.entryValue;
      position.unrealizedPnlPercent = (position.unrealizedPnl / position.entryValue) * 100;

      totalPositionsValue += position.currentValue;
    }

    // 更新资金曲线
    const totalValue = this.cash + totalPositionsValue;
    this.equityCurve.push({
      date: date,
      value: totalValue,
    });
  }

  /**
   * 获取投资组合指标
   */
  getMetrics(): PortfolioMetrics {
    let totalPositionsValue = 0;
    let totalUnrealizedPnl = 0;

    for (const position of this.positions.values()) {
      totalPositionsValue += position.currentValue;
      totalUnrealizedPnl += position.unrealizedPnl;
    }

    const totalValue = this.cash + totalPositionsValue;
    const totalPnl = this.realizedPnl + totalUnrealizedPnl;

    // 计算当日收益率
    const dailyReturn =
      this.equityCurve.length >= 2
        ? (this.equityCurve[this.equityCurve.length - 1].value /
            this.equityCurve[this.equityCurve.length - 2].value -
            1) *
          100
        : 0;

    return {
      totalValue,
      cash: this.cash,
      positionsValue: totalPositionsValue,
      unrealizedPnl: totalUnrealizedPnl,
      realizedPnl: this.realizedPnl,
      totalPnl,
      dailyPnl: this.dailyPnl,
      dailyReturn,
    };
  }

  /**
   * 重置每日盈亏
   */
  resetDailyPnl(): void {
    const metrics = this.getMetrics();
    if (metrics.dailyReturn !== 0) {
      this.dailyReturns.push(metrics.dailyReturn);
    }
    this.dailyPnl = 0;
  }

  /**
   * 获取所有仓位
   */
  getPositions(): Position[] {
    return Array.from(this.positions.values());
  }

  /**
   * 获取所有交易
   */
  getTrades(): Trade[] {
    return [...this.trades];
  }

  /**
   * 获取资金曲线
   */
  getEquityCurve(): { date: Date; value: number }[] {
    return [...this.equityCurve];
  }

  /**
   * 获取每日收益率序列
   */
  getDailyReturns(): number[] {
    return [...this.dailyReturns];
  }

  /**
   * 获取现金余额
   */
  getCash(): number {
    return this.cash;
  }

  /**
   * 检查是否可以买入
   */
  canBuy(symbol: string, price: number, quantity: number, commission = 0): boolean {
    const cost = price * quantity + commission;
    return this.cash >= cost;
  }

  /**
   * 检查是否可以卖出
   */
  canSell(symbol: string, quantity: number): boolean {
    const position = this.positions.get(symbol);
    return position ? position.quantity >= quantity : false;
  }

  /**
   * 计算最大可买数量
   */
  maxBuyQuantity(symbol: string, price: number, commissionRate = 0.0003): number {
    const maxCost = this.cash;
    const commissionPerShare = price * commissionRate;
    const effectivePrice = price + commissionPerShare;
    return Math.floor(maxCost / effectivePrice);
  }

  /**
   * 获取仓位信息
   */
  getPosition(symbol: string): Position | undefined {
    return this.positions.get(symbol);
  }

  /**
   * 清空投资组合（用于回测重置）
   */
  clear(): void {
    this.positions.clear();
    this.trades = [];
    this.tradeCounter = 1;
    this.realizedPnl = 0;
    this.dailyPnl = 0;
    this.dailyReturns = [];
    this.equityCurve = [];
  }
}
