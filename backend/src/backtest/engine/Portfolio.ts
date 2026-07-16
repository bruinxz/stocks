import { EventType, FillEvent } from './Event';

export interface Position {
  symbol: string;
  quantity: number;
  entry_price: number;
  current_price: number;
  entry_date: Date;
  entry_value: number;
  currentValue: number;
  unrealized_pnl: number;
  unrealizedPnlPercent: number;
  direction: 'long' | 'short';
}

export interface Trade {
  id: string;
  symbol: string;
  entry_date: Date;
  exit_date?: Date;
  entry_price: number;
  exit_price?: number;
  quantity: number;
  direction: 'long' | 'short';
  pnl?: number;
  pnl_percent?: number;
  holding_days?: number;
  status: 'open' | 'closed';
  commission?: number;
}

export interface PortfolioMetrics {
  total_value: number;
  cash: number;
  positionsValue: number;
  unrealized_pnl: number;
  realized_pnl: number;
  totalPnl: number;
  dailyPnl: number;
  dailyReturn: number;
}

export class Portfolio {
  private cash: number;
  private positions: Map<string, Position> = new Map();
  private trades: Trade[] = [];
  private tradeCounter = 1;
  private realized_pnl = 0;
  private dailyPnl = 0;
  private daily_returns: number[] = [];
  private equity_curve: { date: Date; value: number }[] = [];

  constructor(initial_capital: number) {
    this.cash = initial_capital;
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
        const totalCost = existingPosition.entry_value + tradeValue;
        const averagePrice = totalCost / totalQuantity;

        existingPosition.quantity = totalQuantity;
        existingPosition.entry_price = averagePrice;
        existingPosition.entry_value = totalCost;
      } else {
        // 新开仓
        this.positions.set(symbol, {
          symbol,
          quantity: filledQuantity,
          entry_price: filledPrice,
          current_price: filledPrice,
          entry_date: effectiveTime,
          entry_value: tradeValue,
          currentValue: tradeValue,
          unrealized_pnl: 0,
          unrealizedPnlPercent: 0,
          direction: 'long',
        });
      }

      // 记录交易
      this.trades.push({
        id: `trade_${this.tradeCounter++}`,
        symbol,
        entry_date: effectiveTime,
        entry_price: filledPrice,
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
      const realized_pnl = (filledPrice - existingPosition.entry_price) * filledQuantity;
      this.realized_pnl += realized_pnl;
      this.dailyPnl += realized_pnl;

      // 如果仓位为0，移除
      if (existingPosition.quantity === 0) {
        this.positions.delete(symbol);
      }

      // 更新交易记录
      const openTrade = this.trades.find(
        t => t.symbol === symbol && t.status === 'open' && t.direction === 'long'
      );
      if (openTrade) {
        openTrade.exit_date = effectiveTime;
        openTrade.exit_price = filledPrice;
        openTrade.pnl = realized_pnl;
        openTrade.pnl_percent = (realized_pnl / (openTrade.entry_price * openTrade.quantity)) * 100;
        openTrade.holding_days = Math.floor(
          (openTrade.exit_date.getTime() - openTrade.entry_date.getTime()) / (1000 * 60 * 60 * 24)
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
      const current_price = prices.get(symbol) || position.current_price;
      position.current_price = current_price;
      position.currentValue = position.quantity * current_price;
      position.unrealized_pnl = position.currentValue - position.entry_value;
      position.unrealizedPnlPercent = (position.unrealized_pnl / position.entry_value) * 100;

      totalPositionsValue += position.currentValue;
    }

    // 更新资金曲线
    const total_value = this.cash + totalPositionsValue;
    this.equity_curve.push({
      date: date,
      value: total_value,
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
      totalUnrealizedPnl += position.unrealized_pnl;
    }

    const total_value = this.cash + totalPositionsValue;
    const totalPnl = this.realized_pnl + totalUnrealizedPnl;

    // 计算当日收益率
    const dailyReturn =
      this.equity_curve.length >= 2
        ? this.equity_curve[this.equity_curve.length - 1].value /
            this.equity_curve[this.equity_curve.length - 2].value -
          1
        : 0;

    return {
      total_value,
      cash: this.cash,
      positionsValue: totalPositionsValue,
      unrealized_pnl: totalUnrealizedPnl,
      realized_pnl: this.realized_pnl,
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
      this.daily_returns.push(metrics.dailyReturn);
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
    return [...this.equity_curve];
  }

  /**
   * 获取每日收益率序列
   */
  getDailyReturns(): number[] {
    return [...this.daily_returns];
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
    this.realized_pnl = 0;
    this.dailyPnl = 0;
    this.daily_returns = [];
    this.equity_curve = [];
  }
}
