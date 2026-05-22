import {
  BrokerAccountSnapshot,
  BrokerCancelOrderResult,
  BrokerCapabilities,
  BrokerGateway,
  BrokerOrder,
  BrokerOrderQuery,
  BrokerPlaceOrderRequest,
  BrokerPlaceOrderResult,
  BrokerPosition,
  BrokerTrade,
  BrokerTradeQuery,
} from './BrokerGateway';

function toNumber(value: any): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function parseDate(value: any): Date {
  const date = value ? new Date(value) : new Date();
  return Number.isFinite(date.getTime()) ? date : new Date();
}

function safeJson<T>(value: string | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export class EnvReadonlyBrokerGateway implements BrokerGateway {
  getCapabilities(): BrokerCapabilities {
    return {
      broker_key: process.env.LIVE_BROKER_KEY || 'env_readonly',
      broker_name: process.env.LIVE_BROKER_NAME || '环境变量只读券商网关',
      readonly_supported: true,
      trading_supported: false,
      cancel_supported: false,
      sandbox_supported: true,
      order_types: ['LIMIT'],
      markets: ['A_SHARE'],
      notes: [
        '该网关只从环境变量读取账户快照/持仓样例，适合接真实券商前联调对账链路。',
        '不实现真实下单和撤单；placeOrder/cancelOrder 始终抛错。',
      ],
    };
  }

  async getAccountSnapshot(): Promise<BrokerAccountSnapshot> {
    const payload = safeJson<Record<string, any>>(process.env.LIVE_BROKER_ACCOUNT_SNAPSHOT_JSON, {});
    return {
      total_asset: toNumber(payload.total_asset ?? process.env.LIVE_BROKER_TOTAL_ASSET),
      available_cash: toNumber(payload.available_cash ?? process.env.LIVE_BROKER_AVAILABLE_CASH),
      market_value: toNumber(payload.market_value ?? process.env.LIVE_BROKER_MARKET_VALUE),
      frozen_cash: toNumber(payload.frozen_cash ?? process.env.LIVE_BROKER_FROZEN_CASH),
      total_pnl: toNumber(payload.total_pnl ?? process.env.LIVE_BROKER_TOTAL_PNL),
      day_pnl: toNumber(payload.day_pnl ?? process.env.LIVE_BROKER_DAY_PNL),
      snapshot_time: parseDate(payload.snapshot_time ?? process.env.LIVE_BROKER_SNAPSHOT_TIME),
      raw_payload: { source: 'env_readonly', payload },
    };
  }

  async getPositions(): Promise<BrokerPosition[]> {
    const rows = safeJson<any[]>(process.env.LIVE_BROKER_POSITIONS_JSON, []);
    return rows.map(item => ({
      symbol: String(item.symbol || ''),
      name: item.name,
      quantity: Math.floor(toNumber(item.quantity)),
      available_quantity: Math.floor(toNumber(item.available_quantity ?? item.quantity)),
      avg_cost: toNumber(item.avg_cost),
      current_price: toNumber(item.current_price),
      market_value: toNumber(item.market_value),
      unrealized_pnl: toNumber(item.unrealized_pnl),
      unrealized_pnl_pct: toNumber(item.unrealized_pnl_pct),
      quote_time: item.quote_time ? parseDate(item.quote_time) : undefined,
      raw_payload: item,
    }));
  }

  async getOrders(_query: BrokerOrderQuery = {}): Promise<BrokerOrder[]> {
    return safeJson<BrokerOrder[]>(process.env.LIVE_BROKER_ORDERS_JSON, []);
  }

  async getTrades(_query: BrokerTradeQuery = {}): Promise<BrokerTrade[]> {
    return safeJson<BrokerTrade[]>(process.env.LIVE_BROKER_TRADES_JSON, []);
  }

  async placeOrder(_order: BrokerPlaceOrderRequest): Promise<BrokerPlaceOrderResult> {
    throw new Error('EnvReadonlyBrokerGateway 仅支持只读同步，禁止真实下单。');
  }

  async cancelOrder(order_id: string): Promise<BrokerCancelOrderResult> {
    throw new Error(`EnvReadonlyBrokerGateway 仅支持只读同步，禁止撤单 ${order_id}。`);
  }
}
