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

export class MockBrokerGateway implements BrokerGateway {
  constructor(private readonly configuredGateway = 'mock_guarded') {}

  getCapabilities(): BrokerCapabilities {
    return {
      broker_key: 'mock_guarded',
      broker_name: '安全占位券商网关',
      readonly_supported: true,
      trading_supported: false,
      cancel_supported: false,
      sandbox_supported: true,
      order_types: ['LIMIT'],
      markets: ['A_SHARE'],
      notes: [
        '当前网关只用于研发和页面联调，不连接真实券商。',
        '真实下单能力默认关闭，即使调用 placeOrder 也会被拒绝。',
        ...(this.configuredGateway !== 'mock_guarded'
          ? [`请求的券商网关 ${this.configuredGateway} 尚未实现，已安全降级为 mock_guarded。`]
          : []),
      ],
    };
  }

  async getAccountSnapshot(): Promise<BrokerAccountSnapshot> {
    return {
      total_asset: 0,
      available_cash: 0,
      market_value: 0,
      frozen_cash: 0,
      total_pnl: 0,
      day_pnl: 0,
      snapshot_time: new Date(),
      raw_payload: { mock: true, mode: 'safe_readonly' },
    };
  }

  async getPositions(): Promise<BrokerPosition[]> {
    return [];
  }

  async getOrders(_query: BrokerOrderQuery = {}): Promise<BrokerOrder[]> {
    return [];
  }

  async getTrades(_query: BrokerTradeQuery = {}): Promise<BrokerTrade[]> {
    return [];
  }

  async placeOrder(_order: BrokerPlaceOrderRequest): Promise<BrokerPlaceOrderResult> {
    throw new Error('真实下单网关未启用：当前 MockBrokerGateway 禁止提交委托。');
  }

  async cancelOrder(order_id: string): Promise<BrokerCancelOrderResult> {
    throw new Error(`真实撤单网关未启用：当前 MockBrokerGateway 禁止撤单 ${order_id}。`);
  }
}
