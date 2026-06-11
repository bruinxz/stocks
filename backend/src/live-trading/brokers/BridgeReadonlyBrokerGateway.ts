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
import { LiveAccountSnapshot } from '../../models/LiveAccountSnapshot';
import { LivePosition } from '../../models/LivePosition';
import { LiveOrder } from '../../models/LiveOrder';
import { LiveTrade } from '../../models/LiveTrade';
import { Op } from 'sequelize';

/**
 * BridgeReadonlyBrokerGateway
 *
 * 真实账户数据来自本地桥 push 到 live_account_snapshots / live_positions / live_orders / live_trades，
 * 这里只做"从 DB 读最新快照"，**不会真的去连券商**。下单/撤单一律拒绝。
 *
 * 多用户隔离（review 修订）：
 *  - 默认所有接口（getAccountSnapshot/Positions/Orders/Trades）返回空数据并 warn；
 *    除非显式 LIVE_BRIDGE_DEFAULT_ACCOUNT_ID 配置，配合 LIVE_BRIDGE_GATEWAY_GLOBAL_ACCOUNT=true 才允许全局读取
 *    （仅限单机开发/演示用）。
 *  - LiveTradingService.syncReadonlyAccount 已绕开 gateway 接口直接按当前 user 的 account_id 查 DB；
 *    所以这里的接口主要是"capability 展示 + 集成测试"用，运行时通常不被业务调用。
 *  - 真正多账户场景建议改用 *_For_Account_Id(account_id) 方法（见下）。
 *
 * 路线图 §6.3：bridge_readonly 永远不能进入真实下单路径。
 */
function envNumber(name: string, fallback?: number): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const num = Number(raw);
  return Number.isFinite(num) ? num : fallback;
}

function envBool(name: string, fallback = false): boolean {
  const raw = String(process.env[name] || '').toLowerCase();
  if (!raw) return fallback;
  return ['true', '1', 'yes', 'y', 'on'].includes(raw);
}

function toNumber(value: any): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

export class BridgeReadonlyBrokerGateway implements BrokerGateway {
  getCapabilities(): BrokerCapabilities {
    return {
      broker_key: 'bridge_readonly',
      broker_name: '本地桥只读券商网关',
      readonly_supported: true,
      trading_supported: false, // 受 §6.3 硬约束保护，禁止真实下单
      cancel_supported: false,
      sandbox_supported: false,
      order_types: ['LIMIT'],
      markets: ['A_SHARE'],
      notes: [
        '该网关只读从 live_account_snapshots / live_positions 等表读取本地桥推送的真实账户数据。',
        '禁止真实下单与撤单；placeOrder/cancelOrder 始终抛错。',
        '多账户场景：业务逻辑应直接调 LiveTradingService.syncReadonlyAccount 按 user_id 查 DB；',
        '本 gateway 的全局接口仅在 LIVE_BRIDGE_DEFAULT_ACCOUNT_ID + LIVE_BRIDGE_GATEWAY_GLOBAL_ACCOUNT=true 时启用。',
      ],
    };
  }

  /**
   * 返回 env 显式注入的全局 account_id。多用户场景必须确保 LIVE_BRIDGE_GATEWAY_GLOBAL_ACCOUNT=true，
   * 否则即便配了 default_account_id 也返回 null（默认行为更安全）。
   */
  private async resolveAccountId(): Promise<number | null> {
    const enabled = envBool('LIVE_BRIDGE_GATEWAY_GLOBAL_ACCOUNT', false);
    if (!enabled) return null;
    const explicit = envNumber('LIVE_BRIDGE_DEFAULT_ACCOUNT_ID');
    if (explicit) return explicit;
    return null;
  }

  // ========== 按 account_id 直接读（供 LiveTradingService 调用，绕开 env 限制） ==========

  async getAccountSnapshotFor(accountId: number): Promise<BrokerAccountSnapshot | null> {
    if (!accountId) return null;
    const snap = await LiveAccountSnapshot.findOne({
      where: { account_id: accountId },
      order: [['snapshot_time', 'DESC']],
    });
    if (!snap) return null;
    const s: any = snap;
    return {
      total_asset: toNumber(s.total_asset),
      available_cash: toNumber(s.available_cash),
      market_value: toNumber(s.market_value),
      frozen_cash: toNumber(s.frozen_cash),
      total_pnl: toNumber(s.total_pnl),
      day_pnl: toNumber(s.day_pnl),
      snapshot_time: s.snapshot_time ? new Date(s.snapshot_time) : new Date(),
      raw_payload: { source: 'bridge_readonly', ...((s.raw_payload as object) || {}) },
    };
  }

  async getPositionsFor(accountId: number): Promise<BrokerPosition[]> {
    if (!accountId) return [];
    const rows = await LivePosition.findAll({
      where: { account_id: accountId, quantity: { [Op.gt]: 0 } },
      order: [['market_value', 'DESC']],
      limit: 500,
    });
    return rows.map((row: any) => ({
      symbol: String(row.symbol),
      name: row.name,
      quantity: toNumber(row.quantity),
      available_quantity: toNumber(row.available_quantity),
      avg_cost: toNumber(row.avg_cost),
      current_price: toNumber(row.current_price),
      market_value: toNumber(row.market_value),
      unrealized_pnl: toNumber(row.unrealized_pnl),
      unrealized_pnl_pct: toNumber(row.unrealized_pnl_pct),
      quote_time: row.quote_time ? new Date(row.quote_time) : undefined,
      raw_payload: row.raw_payload || {},
    }));
  }

  // ========== 全局接口（默认空数据，仅 env 全开启用） ==========

  async getAccountSnapshot(): Promise<BrokerAccountSnapshot> {
    const accountId = await this.resolveAccountId();
    if (!accountId) {
      return {
        total_asset: 0,
        available_cash: 0,
        market_value: 0,
        snapshot_time: new Date(),
        raw_payload: {
          source: 'bridge_readonly',
          note: 'multi-user safe default: gateway global read disabled. Use LiveTradingService.syncReadonlyAccount or set LIVE_BRIDGE_GATEWAY_GLOBAL_ACCOUNT=true.',
        },
      };
    }
    const snap = await this.getAccountSnapshotFor(accountId);
    return snap || {
      total_asset: 0,
      available_cash: 0,
      market_value: 0,
      snapshot_time: new Date(),
      raw_payload: { source: 'bridge_readonly', note: 'no snapshot yet' },
    };
  }

  async getPositions(): Promise<BrokerPosition[]> {
    const accountId = await this.resolveAccountId();
    if (!accountId) return [];
    return this.getPositionsFor(accountId);
  }

  async getOrders(query: BrokerOrderQuery = {}): Promise<BrokerOrder[]> {
    const accountId = await this.resolveAccountId();
    if (!accountId) return [];
    const where: any = { account_id: accountId };
    if (query.status) where.status = query.status;
    const rows = await LiveOrder.findAll({
      where,
      order: [['created_at', 'DESC']],
      limit: Math.min(Math.max(Number(query.limit || 100), 1), 500),
    });
    return rows.map((row: any) => ({
      broker_order_id: String(row.broker_order_id || ''),
      symbol: String(row.symbol),
      side: row.side,
      quantity: toNumber(row.quantity),
      limit_price: toNumber(row.limit_price),
      status: String(row.bridge_status || row.status),
      submitted_at: row.submitted_at ? new Date(row.submitted_at) : undefined,
      raw_payload: row.raw_payload || {},
    }));
  }

  async getTrades(query: BrokerTradeQuery = {}): Promise<BrokerTrade[]> {
    const accountId = await this.resolveAccountId();
    if (!accountId) return [];
    const where: any = { account_id: accountId };
    // symbol 在 BridgeService.ingestTrades 入库时也走原始 symbol，这里不做 normalize 以匹配
    if (query.symbol) where.symbol = query.symbol;
    const rows = await LiveTrade.findAll({
      where,
      order: [['trade_time', 'DESC']],
      limit: Math.min(Math.max(Number(query.limit || 100), 1), 500),
    });
    // review 修订 #42：broker_order_id 必须从对应 LiveOrder 反查；不能用 trade.order_id（那是内部 PK）
    const orderIds = rows.map((r: any) => r.order_id).filter((v: any) => Number.isFinite(Number(v)));
    let orderMap = new Map<number, string>();
    if (orderIds.length) {
      const orders = await LiveOrder.findAll({
        where: { id: { [Op.in]: orderIds } } as any,
        attributes: ['id', 'broker_order_id'],
      });
      orderMap = new Map(
        orders.map((o: any) => [Number(o.id), o.broker_order_id ? String(o.broker_order_id) : ''])
      );
    }
    return rows.map((row: any) => ({
      broker_trade_id: String(row.broker_trade_id || ''),
      broker_order_id: row.order_id ? orderMap.get(Number(row.order_id)) || undefined : undefined,
      symbol: String(row.symbol),
      side: row.side,
      quantity: toNumber(row.quantity),
      trade_price: toNumber(row.trade_price),
      trade_amount: toNumber(row.trade_amount),
      trade_time: row.trade_time ? new Date(row.trade_time) : new Date(),
      raw_payload: row.raw_payload || {},
    }));
  }

  async placeOrder(_order: BrokerPlaceOrderRequest): Promise<BrokerPlaceOrderResult> {
    throw new Error('BridgeReadonlyBrokerGateway 仅做只读读取，禁止真实下单；请切换 LIVE_BROKER_GATEWAY=qmt_bridge。');
  }

  async cancelOrder(order_id: string): Promise<BrokerCancelOrderResult> {
    throw new Error(`BridgeReadonlyBrokerGateway 禁止撤单 ${order_id}；撤单只能通过 qmt_bridge / ptrade_bridge 经命令通道下发。`);
  }
}
