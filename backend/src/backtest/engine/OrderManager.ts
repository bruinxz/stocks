import {
  EventType,
  OrderEvent,
  FillEvent,
  SlippageEvent,
  CommissionEvent,
  BarEvent,
} from './Event';
import { Portfolio } from './Portfolio';

export interface Order {
  id: string;
  symbol: string;
  direction: 'buy' | 'sell';
  orderType: 'market' | 'limit';
  quantity: number;
  price?: number;
  timestamp: Date;
  status: 'pending' | 'filled' | 'cancelled' | 'rejected';
  filledQuantity: number;
  filledPrice?: number;
  commission?: number;
}

export interface SlippageModel {
  calculateSlippage(order: Order, currentPrice: number): number;
}

export interface CommissionModel {
  calculateCommission(order: Order, filledPrice: number): number;
}

export class FixedSlippageModel implements SlippageModel {
  constructor(private slippage: number = 0.001) {}

  calculateSlippage(order: Order, currentPrice: number): number {
    return currentPrice * this.slippage;
  }
}

export class FixedCommissionModel implements CommissionModel {
  constructor(
    private brokerageRate: number = 0.0003, // 佣金费率：0.03%
    private stampDutyRate: number = 0.001, // 印花税率：0.1%（卖出时收取）
    private transferFeeRate: number = 0.00002 // 过户费率：0.002%
  ) {}

  calculateCommission(order: Order, filledPrice: number): number {
    const tradeValue = filledPrice * order.quantity;

    let commission = tradeValue * this.brokerageRate;
    commission = Math.max(commission, 5); // 最低5元

    if (order.direction === 'sell') {
      commission += tradeValue * this.stampDutyRate;
    }

    commission += tradeValue * this.transferFeeRate;

    return commission;
  }
}

export class OrderManager {
  private orders: Map<string, Order> = new Map();
  private orderCounter = 1;
  private slippageModel: SlippageModel;
  private commissionModel: CommissionModel;

  constructor(
    slippageModel: SlippageModel = new FixedSlippageModel(),
    commissionModel: CommissionModel = new FixedCommissionModel()
  ) {
    this.slippageModel = slippageModel;
    this.commissionModel = commissionModel;
  }

  /**
   * 创建订单
   */
  createOrder(
    symbol: string,
    direction: 'buy' | 'sell',
    orderType: 'market' | 'limit',
    quantity: number,
    price?: number
  ): Order {
    const order: Order = {
      id: `order_${this.orderCounter++}`,
      symbol,
      direction,
      orderType,
      quantity,
      price,
      timestamp: new Date(),
      status: 'pending',
      filledQuantity: 0,
    };

    this.orders.set(order.id, order);
    return order;
  }

  /**
   * 处理订单事件
   */
  handleOrderEvent(orderEvent: OrderEvent): Order[] {
    const order = orderEvent.data;
    this.orders.set(order.orderId, {
      ...order,
      id: order.orderId,
      filledQuantity: 0,
      filledPrice: undefined,
      commission: undefined,
    });
    return [this.orders.get(order.orderId)!];
  }

  /**
   * 处理K线事件，执行挂单
   */
  processBarEvent(
    barEvent: BarEvent,
    portfolio: Portfolio
  ): {
    fillEvents: FillEvent[];
    slippageEvents: SlippageEvent[];
    commissionEvents: CommissionEvent[];
  } {
    const fillEvents: FillEvent[] = [];
    const slippageEvents: SlippageEvent[] = [];
    const commissionEvents: CommissionEvent[] = [];
    const { symbol, open, high, low, close, time } = barEvent.data;

    // 获取该股票的所有挂单
    const pendingOrders = Array.from(this.orders.values()).filter(
      order => order.symbol === symbol && order.status === 'pending'
    );

    for (const order of pendingOrders) {
      let filledPrice: number | undefined;
      let canFill = false;

      if (order.orderType === 'market') {
        // 市价单：以当前K线的开盘价成交
        filledPrice = open;
        canFill = true;
      } else if (order.orderType === 'limit' && order.price) {
        // 限价单：检查价格是否达到
        if (order.direction === 'buy' && order.price >= low) {
          filledPrice = Math.min(order.price, open); // 买入限价单：价格低于或等于限价
          canFill = true;
        } else if (order.direction === 'sell' && order.price <= high) {
          filledPrice = Math.max(order.price, open); // 卖出限价单：价格高于或等于限价
          canFill = true;
        }
      }

      if (canFill && filledPrice !== undefined) {
        // 检查资金或仓位是否足够
        if (order.direction === 'buy') {
          const commission = this.commissionModel.calculateCommission(order, filledPrice);
          if (!portfolio.canBuy(symbol, filledPrice, order.quantity, commission)) {
            order.status = 'rejected';
            continue;
          }
        } else if (order.direction === 'sell') {
          if (!portfolio.canSell(symbol, order.quantity)) {
            order.status = 'rejected';
            continue;
          }
        }

        // 计算滑点
        const slippage = this.slippageModel.calculateSlippage(order, filledPrice);
        const actualPrice =
          order.direction === 'buy' ? filledPrice + slippage : filledPrice - slippage;

        // 计算佣金
        const commission = this.commissionModel.calculateCommission(order, actualPrice);

        // 更新订单状态
        order.status = 'filled';
        order.filledQuantity = order.quantity;
        order.filledPrice = actualPrice;
        order.commission = commission;

        // 创建成交事件
        const fillEvent: FillEvent = {
          type: EventType.FILL,
          timestamp: time,
          data: {
            orderId: order.id,
            symbol,
            direction: order.direction,
            filledQuantity: order.quantity,
            filledPrice: actualPrice,
            commission,
            timestamp: time,
          },
        };
        fillEvents.push(fillEvent);

        // 创建滑点事件
        const slippageEvent: SlippageEvent = {
          type: EventType.SLIPPAGE,
          timestamp: time,
          data: {
            orderId: order.id,
            symbol,
            expectedPrice: filledPrice,
            actualPrice,
            slippage,
          },
        };
        slippageEvents.push(slippageEvent);

        // 创建佣金事件
        const commissionEvent: CommissionEvent = {
          type: EventType.COMMISSION,
          timestamp: time,
          data: {
            orderId: order.id,
            symbol,
            commission,
            details: {
              brokerage: commission * 0.7, // 假设70%是佣金
              stampDuty: order.direction === 'sell' ? commission * 0.2 : 0, // 卖出时收取印花税
              transferFee: commission * 0.1,
              otherFees: 0,
            },
          },
        };
        commissionEvents.push(commissionEvent);
      }
    }

    // 移除已成交或拒绝的订单
    for (const order of pendingOrders) {
      if (order.status === 'filled' || order.status === 'rejected') {
        this.orders.delete(order.id);
      }
    }

    return { fillEvents, slippageEvents, commissionEvents };
  }

  /**
   * 取消订单
   */
  cancelOrder(orderId: string): boolean {
    const order = this.orders.get(orderId);
    if (order && order.status === 'pending') {
      order.status = 'cancelled';
      this.orders.delete(orderId);
      return true;
    }
    return false;
  }

  /**
   * 获取所有订单
   */
  getOrders(): Order[] {
    return Array.from(this.orders.values());
  }

  /**
   * 获取订单详情
   */
  getOrder(orderId: string): Order | undefined {
    return this.orders.get(orderId);
  }

  /**
   * 清空所有订单
   */
  clear(): void {
    this.orders.clear();
    this.orderCounter = 1;
  }

  /**
   * 设置滑点模型
   */
  setSlippageModel(model: SlippageModel): void {
    this.slippageModel = model;
  }

  /**
   * 设置佣金模型
   */
  setCommissionModel(model: CommissionModel): void {
    this.commissionModel = model;
  }
}
