export enum EventType {
  BAR = 'bar', // K线数据事件
  SIGNAL = 'signal', // 信号事件
  ORDER = 'order', // 订单事件
  FILL = 'fill', // 成交事件
  SLIPPAGE = 'slippage', // 滑点事件
  COMMISSION = 'commission', // 佣金事件
  TIMER = 'timer', // 定时器事件
  START = 'start', // 回测开始事件
  END = 'end', // 回测结束事件
}

export interface BaseEvent {
  type: EventType;
  timestamp: Date;
  data?: any;
}

export interface BarEvent extends BaseEvent {
  type: EventType.BAR;
  data: {
    symbol: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    turnover?: number;
    time: Date;
    is_trading_day: boolean;
    is_suspended: boolean;
  };
}

export interface SignalEvent extends BaseEvent {
  type: EventType.SIGNAL;
  data: {
    symbol: string;
    direction: 'long' | 'short' | 'exit';
    strength?: number;
    price?: number;
    reason?: string;
    strategyId: string;
  };
}

export interface OrderEvent extends BaseEvent {
  type: EventType.ORDER;
  data: {
    orderId: string;
    symbol: string;
    direction: 'buy' | 'sell';
    orderType: 'market' | 'limit';
    quantity: number;
    price?: number;
    timestamp: Date;
    status: 'pending' | 'filled' | 'cancelled';
  };
}

export interface FillEvent extends BaseEvent {
  type: EventType.FILL;
  data: {
    orderId: string;
    symbol: string;
    direction: 'buy' | 'sell';
    filledQuantity: number;
    filledPrice: number;
    commission: number;
    timestamp: Date;
  };
}

export interface SlippageEvent extends BaseEvent {
  type: EventType.SLIPPAGE;
  data: {
    orderId: string;
    symbol: string;
    expectedPrice: number;
    actualPrice: number;
    slippage: number;
  };
}

export interface CommissionEvent extends BaseEvent {
  type: EventType.COMMISSION;
  data: {
    orderId: string;
    symbol: string;
    commission: number;
    details: {
      brokerage: number;
      stamp_duty: number;
      transfer_fee: number;
      otherFees: number;
    };
  };
}

export interface TimerEvent extends BaseEvent {
  type: EventType.TIMER;
  data: {
    interval: 'daily' | 'weekly' | 'monthly' | 'yearly';
    currentDate: Date;
  };
}

export interface StartEvent extends BaseEvent {
  type: EventType.START;
  data: {
    start_date: Date;
    end_date: Date;
    initial_capital: number;
  };
}

export interface EndEvent extends BaseEvent {
  type: EventType.END;
  data: {
    final_capital: number;
    total_return: number;
    total_trades: number;
    start_date: Date;
    end_date: Date;
  };
}

export type Event =
  | BarEvent
  | SignalEvent
  | OrderEvent
  | FillEvent
  | SlippageEvent
  | CommissionEvent
  | TimerEvent
  | StartEvent
  | EndEvent;
