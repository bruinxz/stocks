/**
 * Broker bridge 兼容矩阵 (US-110 [EX-010])
 *
 * 单一事实源（与 docs/broker_bridge_compat_matrix.md 同步, 单测两边都锁）:
 *  - QMT / PTrade 两个 bridge adapter 对 order_type / 事件 / status / 错误码的支持差异
 *  - server 派 LiveBrokerCommand 前应查能力, 不允许"假设支持 → 派到 adapter 才发现 unsupported"
 *  - PTrade 当前是 stub (adapter 文件只有 1 行注释), 所有 trading 维度 supported=false
 *
 * 变更流程: 改本文件 → 同步改 docs/broker_bridge_compat_matrix.md → 跑
 *   `cd backend && npm test -- --filter=broker-compat-matrix`
 * 单测会读 markdown 表格 + 本常量, 任一漂移 fail.
 *
 * 不要在本文件加运行时副作用 / model import / DB 依赖 — 这是纯 lookup 表, 任何 caller import
 * 都应 zero side effect, 让 server-side gate / RiskAlert / preflight 安全 require.
 *
 * 设计参考: docs/trader-system/60_execution_overview.md §C.5 + §D.1 US-EO-3
 */

/** broker_key 枚举. 与 LiveBrokerAccount.broker_key 同字典. */
export type BrokerKey = 'qmt' | 'ptrade';

/** order_type 枚举. server 派单的 LiveBrokerCommand.payload.order_type 字典. */
export type OrderType = 'LIMIT' | 'MARKET' | 'IOC' | 'FOK';

/** 事件类型 — bridge_common/client.py push_* / query_* 的能力点. */
export type BrokerEventKind =
  | 'heartbeat'
  | 'account_snapshot'
  | 'positions'
  | 'today_orders'
  | 'today_trades'
  | 'order_events'
  | 'place_order'
  | 'cancel_order';

/** 单 order_type 的支持级别. */
export interface OrderTypeSupport {
  /** true = adapter 已实现且 server 允许. */
  supported: boolean;
  /**
   * 'sdk_supported_server_disabled' = SDK 支持但 server fail-closed 禁用 (e.g. MARKET 太险)
   * 'not_implemented' = adapter 未实现 (e.g. ptrade 整体 stub)
   * 'algo_layer' = adapter 层不处理, 由 ExecutionAlgoSlicer 拆 LIMIT 子单
   */
  reason?: 'sdk_supported_server_disabled' | 'not_implemented' | 'algo_layer';
  /** 备注 (单测仅 truthy 检查). */
  note?: string;
}

/** 单 event 的支持级别. */
export interface EventSupport {
  /** true = adapter 已实现且 happy path 可用; false = 未实现 / 始终降级. */
  supported: boolean;
  /** 'half' = 半支持 (e.g. order_events 走轮询而非真 push). */
  level?: 'full' | 'half';
  note?: string;
}

export interface BrokerCapability {
  broker_key: BrokerKey;
  broker_name: string;
  /** 适配器文件路径, 单测会验存在性. */
  adapter_path: string;
  /** SDK 名 (xtquant / ptrade). */
  sdk: string;
  /** true = 至少 readonly 链路 (query_*) 已实现. */
  readonly_supported: boolean;
  /** true = place_order + cancel_order 已实现且 server 允许下真单. */
  trading_supported: boolean;
  /** 每个 order_type 的明细 — 即使 supported=false 也必须列, 让 caller getCapability 后取 .supported 短路. */
  order_types: Record<OrderType, OrderTypeSupport>;
  /** 每个 event 的明细. */
  events: Record<BrokerEventKind, EventSupport>;
  /** 整体状态备注. */
  status_note: string;
}

/**
 * QMT 适配 (生产就绪).
 *  - xtquant SDK v2.x
 *  - 全部 query_* + place_order + cancel_order 已实现
 *  - LIMIT 唯一允许的 order_type (xtconstant.FIX_PRICE)
 *  - MARKET / IOC / FOK SDK 支持但 server 暂未派发 (七闸门 + 流动性原因)
 *  - TWAP/VWAP/POV/ICEBERG 由 ExecutionAlgoSlicer 拆 LIMIT 子单后调 place_order
 *  - order_events 走 query_stock_orders 轮询差分, 不依赖 SDK callback
 */
const QMT_CAPABILITY: BrokerCapability = {
  broker_key: 'qmt',
  broker_name: 'QMT (迅投极速策略交易系统)',
  adapter_path: 'integrations/broker-bridge/qmt_bridge/qmt_adapter.py',
  sdk: 'xtquant',
  readonly_supported: true,
  trading_supported: true,
  order_types: {
    LIMIT: { supported: true, note: 'xtconstant.FIX_PRICE 唯一被 server 允许的 order_type' },
    MARKET: {
      supported: false,
      reason: 'sdk_supported_server_disabled',
      note: 'xtconstant.MARKET 可用, 但 server 流动性/成交价不可控 fail-closed 禁用',
    },
    IOC: { supported: false, reason: 'sdk_supported_server_disabled', note: 'server 暂不派发' },
    FOK: { supported: false, reason: 'sdk_supported_server_disabled', note: 'server 暂不派发' },
  },
  events: {
    heartbeat: { supported: true, level: 'full' },
    account_snapshot: { supported: true, level: 'full', note: 'query_stock_asset → XtAsset' },
    positions: { supported: true, level: 'full', note: 'query_stock_positions → [XtPosition]' },
    today_orders: {
      supported: true,
      level: 'full',
      note: 'query_stock_orders(cancelable_only=False)',
    },
    today_trades: { supported: true, level: 'full', note: 'query_stock_trades → [XtTrade]' },
    order_events: {
      supported: true,
      level: 'half',
      note: '轮询 query_orders 做差分模拟 push, 不依赖 SDK callback',
    },
    place_order: {
      supported: true,
      level: 'full',
      note: 'order_stock 同步返 broker_order_id<0 表失败',
    },
    cancel_order: {
      supported: true,
      level: 'full',
      note: 'cancel_order_stock 异步, 返 0 仅"已提交"; 靠轮询验证',
    },
  },
  status_note:
    '生产就绪. xtquant 仅在 Windows + QMT 客户端 + 真账户机器上工作; CI/Linux 走"延迟 import + 缺失即拒服务".',
};

/**
 * PTrade 适配 (stub, 未实现).
 *  - 当前 ptrade_adapter.py 仅 1 行注释 "PTrade 适配 stub. PTrade API 与券商版本相关, 这里不实现."
 *  - readonly + trading 全 false
 *  - 服务器派单前必须检查 trading_supported, 不要假设 ptrade 可下单
 *  - 真接入 PTrade 时按本表更新 supported=true 并落 adapter
 */
const PTRADE_CAPABILITY: BrokerCapability = {
  broker_key: 'ptrade',
  broker_name: 'PTrade (国信 / 各券商版本)',
  adapter_path: 'integrations/broker-bridge/ptrade_bridge/ptrade_adapter.py',
  sdk: 'ptrade (券商版本相关)',
  readonly_supported: false,
  trading_supported: false,
  order_types: {
    LIMIT: {
      supported: false,
      reason: 'not_implemented',
      note: 'adapter stub; 接入时优先实现 LIMIT',
    },
    MARKET: { supported: false, reason: 'not_implemented' },
    IOC: { supported: false, reason: 'not_implemented' },
    FOK: { supported: false, reason: 'not_implemented' },
  },
  events: {
    heartbeat: {
      supported: true,
      level: 'full',
      note: 'bridge_common/client.py 统一发, 适配器无关',
    },
    account_snapshot: { supported: false, level: 'full' },
    positions: { supported: false, level: 'full' },
    today_orders: { supported: false, level: 'full' },
    today_trades: { supported: false, level: 'full' },
    order_events: { supported: false, level: 'full' },
    place_order: {
      supported: false,
      level: 'full',
      note: 'stub, 返 error="PtradeAdapter not implemented"',
    },
    cancel_order: { supported: false, level: 'full' },
  },
  status_note:
    'stub. 实际接入需要在目标券商环境安装 PTrade 客户端 + 拿到其 Python SDK, 当前仅占位.',
};

/** 单一事实源. 按 BrokerKey lookup. */
export const BROKER_COMPAT_MATRIX: Readonly<Record<BrokerKey, BrokerCapability>> = Object.freeze({
  qmt: Object.freeze(QMT_CAPABILITY) as BrokerCapability,
  ptrade: Object.freeze(PTRADE_CAPABILITY) as BrokerCapability,
});

/** 全部 broker_key 列表 (含未实现的). 排序固定, 单测/UI 渲染稳定. */
export const BROKER_KEYS: ReadonlyArray<BrokerKey> = Object.freeze([
  'qmt',
  'ptrade',
] as BrokerKey[]);

/** 全部 order_type 列表. */
export const ORDER_TYPES: ReadonlyArray<OrderType> = Object.freeze([
  'LIMIT',
  'MARKET',
  'IOC',
  'FOK',
] as OrderType[]);

/** 全部 event 列表. */
export const BROKER_EVENT_KINDS: ReadonlyArray<BrokerEventKind> = Object.freeze([
  'heartbeat',
  'account_snapshot',
  'positions',
  'today_orders',
  'today_trades',
  'order_events',
  'place_order',
  'cancel_order',
] as BrokerEventKind[]);

/** 取 broker 完整能力; 未知 broker 返 null (fail-CLOSED 让 caller 不要派单). */
export function getBrokerCapability(
  broker_key: string | null | undefined
): BrokerCapability | null {
  if (!broker_key) return null;
  const key = broker_key as BrokerKey;
  return BROKER_COMPAT_MATRIX[key] || null;
}

/** order_type 支持判定; 任何 unknown broker / unknown order_type 返 false. */
export function isOrderTypeSupported(
  broker_key: string | null | undefined,
  order_type: string | null | undefined
): boolean {
  if (!broker_key || !order_type) return false;
  const cap = getBrokerCapability(broker_key);
  if (!cap) return false;
  const ot = order_type as OrderType;
  const support = cap.order_types[ot];
  return Boolean(support && support.supported);
}

/** event 支持判定. */
export function isEventSupported(
  broker_key: string | null | undefined,
  event: string | null | undefined
): boolean {
  if (!broker_key || !event) return false;
  const cap = getBrokerCapability(broker_key);
  if (!cap) return false;
  const support = cap.events[event as BrokerEventKind];
  return Boolean(support && support.supported);
}

/**
 * QMT bridge_status 单一事实源 (与 qmt_adapter._xt_status_to_str 同步).
 *  - server 端 LiveOrder.bridge_status 字典: pending|submitted|partially_filled|filled|cancelled|failed
 *  - 任何 QMT 状态码改了 → 同步改三处: adapter Python / 本表 / docs §4 表格
 */
export type LiveBridgeStatus =
  | 'pending'
  | 'submitted'
  | 'partially_filled'
  | 'filled'
  | 'cancelled'
  | 'failed';

export const QMT_STATUS_MAP: Readonly<Record<number, LiveBridgeStatus>> = Object.freeze({
  48: 'submitted',
  49: 'submitted',
  50: 'partially_filled',
  51: 'cancelled',
  52: 'cancelled',
  53: 'partially_filled',
  54: 'filled',
  55: 'failed',
  56: 'pending',
  57: 'pending',
  58: 'failed',
});

/** 解析 QMT 状态码; 未知值返 'submitted' (与 adapter 保守降级一致). */
export function mapQmtStatusCode(code: number | null | undefined): LiveBridgeStatus {
  if (code == null) return 'submitted';
  return QMT_STATUS_MAP[code] || 'submitted';
}
