/**
 * AlertsBroadcaster — US-073 [FE-034] WebSocket /ws/alerts 后端入口.
 *
 * 这是一个轻量的进程内 pub-sub: WebSocket connection 在 attach 时把自己
 * 注册到 user_id → Set<client>; RiskAlert.afterCreate 通过本 broadcaster
 * fanout 当前 user_id 已连的所有 client. 设计目标:
 *
 *   - 单进程内 fire-and-forget (与 RealtimeAlertDispatcher 同款 fail-OPEN);
 *   - 不依赖 Redis / Kafka — 单实例部署已够 (前端 60s polling 是兜底);
 *   - WebSocket 不可达 / client 数 0 → 静默 noop, 不抛错;
 *   - 关闭/异常 client 自动 drop (libwsserver send 抛错时);
 *   - per-user Set 复用既有 Map<number, Set<Client>>, 不引入新数据结构.
 *
 * 与其他 service 关系:
 *   - 调用方: RiskAlert.afterCreate (lazy require 本模块, fail-OPEN 顶层 try/catch);
 *   - 也可由 RealtimeAlertDispatcher.dispatch 末尾追加调用 (本 sprint 不动 dispatcher,
 *     避免 regress 既有 187 单测);
 *   - 注册: createAlertsWebSocketServer (alertsWebSocketServer.ts) 在 client 鉴权后
 *     调 broadcaster.register(user_id, client) + 在 close hook 调 unregister.
 *
 * 单测策略:
 *   - 本模块全部用纯函数 / 单 class + DI seam (clientSender 是 (payload) => void),
 *     测试时注入 fake clientSender 跑过 register/broadcast/unregister/error-on-send.
 *   - 与 [[RealtimeAlertDispatcher]] DataSource DI 同款.
 */

import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/**
 * broadcaster 发给 WebSocket client 的标准 envelope. 字段子集与
 * RiskAlertItem 对齐, 前端 alertsRealtimeClient 直接消费, 不依赖额外 fetch.
 */
export interface AlertsBroadcastPayload {
  /** 'alert.new' = 新告警 / 'alert.read' = 已读状态变更 (本 sprint 仅 alert.new) */
  type: 'alert.new';
  alert_id: number;
  user_id: number;
  symbol: string;
  name: string;
  level: string;
  message: string;
  rule_id?: string | null;
  created_at: string;
  /** 当前用户未读告警增量提示 — caller 不一定能给, optional. */
  unread_delta?: number;
}

/**
 * 单个 WebSocket connection 的抽象 — broadcaster 只需要能 send + 知道 closed
 * 状态; 真实 client 是 ws.WebSocket, 单测用 fake 实现.
 */
export interface AlertsBroadcastClient {
  /** 唯一 id (用于去重 / 日志), broadcaster 不要求, 但 register 时建议带上. */
  client_id: string;
  /** 当前是否仍 open. close 后 broadcaster 应该 unregister, 但 send 守一层. */
  isOpen(): boolean;
  /** 发送 payload — 序列化为 JSON 由 sender 自己负责. throw 时 broadcaster 自动 unregister. */
  send(payload: AlertsBroadcastPayload): void;
  /** Auth/session revocation requests a policy close for this connection. */
  close?(reason: string): void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 单 user 最多保持几条 WebSocket 连接 — 防"前端 reload 瞬间累积百条" 资源泄漏. */
export const MAX_CLIENTS_PER_USER = 8;

/** broadcast 单次最多发到几个 client — 防极端情况下 fan-out 阻塞主线程. */
export const MAX_BROADCAST_FANOUT = 32;

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * 把 RiskAlert 实例 (或 plain object) 归一化成 AlertsBroadcastPayload.
 * caller (RiskAlert.afterCreate) 可能传 sequelize instance 或纯 JSON, 这里
 * 兜底字段缺失 + 时间格式不统一.
 */
export function buildBroadcastPayload(input: {
  alert_id: number;
  user_id: number;
  symbol: string;
  name?: string;
  level: string;
  message: string;
  rule_id?: string | null;
  created_at?: Date | string;
  unread_delta?: number;
}): AlertsBroadcastPayload {
  const created_at =
    input.created_at instanceof Date
      ? input.created_at.toISOString()
      : typeof input.created_at === 'string' && input.created_at
      ? input.created_at
      : new Date().toISOString();
  return {
    type: 'alert.new',
    alert_id: Number(input.alert_id) || 0,
    user_id: Number(input.user_id) || 0,
    symbol: String(input.symbol || ''),
    name: String(input.name || ''),
    level: String(input.level || '').toUpperCase(),
    message: String(input.message || ''),
    rule_id: input.rule_id || null,
    created_at,
    unread_delta:
      typeof input.unread_delta === 'number' && Number.isFinite(input.unread_delta)
        ? input.unread_delta
        : undefined,
  };
}

/**
 * 校验 user_id 合法 — 0 / 负 / NaN / undefined 都返 false, broadcaster 拒绝注册.
 */
export function isValidUserId(user_id: unknown): boolean {
  return typeof user_id === 'number' && Number.isFinite(user_id) && user_id > 0;
}

// ---------------------------------------------------------------------------
// Broadcaster
// ---------------------------------------------------------------------------

/**
 * 进程内 user_id → Set<AlertsBroadcastClient> 注册表. singleton 用法,
 * 同时也 export class 让单测能各自 new 互不污染.
 */
export class AlertsBroadcaster {
  private readonly userClients: Map<number, Set<AlertsBroadcastClient>> = new Map();

  /**
   * 注册 client. user_id 非法 / 已达上限 → 拒绝且返 false; 成功返 true.
   * caller 拒绝时应主动 close client 并返 1011 'too many connections'.
   */
  register(user_id: number, client: AlertsBroadcastClient): boolean {
    if (!isValidUserId(user_id)) {
      logger.warn(`[AlertsBroadcaster] register 拒绝: 非法 user_id=${user_id}`);
      return false;
    }
    let set = this.userClients.get(user_id);
    if (!set) {
      set = new Set();
      this.userClients.set(user_id, set);
    }
    if (set.size >= MAX_CLIENTS_PER_USER) {
      logger.warn(
        `[AlertsBroadcaster] register 拒绝: user=${user_id} 已达 MAX_CLIENTS_PER_USER=${MAX_CLIENTS_PER_USER}`
      );
      return false;
    }
    set.add(client);
    return true;
  }

  /**
   * 注销 client — 通常由 WebSocket close handler 调用. 不存在的 client 静默 noop.
   */
  unregister(user_id: number, client: AlertsBroadcastClient): void {
    const set = this.userClients.get(user_id);
    if (!set) return;
    set.delete(client);
    if (set.size === 0) {
      this.userClients.delete(user_id);
    }
  }

  /**
   * 当前 user 在线 client 数 — 用于日志 / metric / 单测断言.
   */
  countClients(user_id: number): number {
    return this.userClients.get(user_id)?.size ?? 0;
  }

  /**
   * 当前进程总在线 client 数 — 用于 /health/detail 与 Prometheus gauge.
   */
  countTotalClients(): number {
    let n = 0;
    this.userClients.forEach(set => {
      n += set.size;
    });
    return n;
  }

  /** Close and forget every live connection for a revoked or disabled user. */
  disconnectUser(user_id: number, reason = 'authorization revoked'): number {
    const set = this.userClients.get(user_id);
    if (!set) return 0;
    this.userClients.delete(user_id);
    let closed = 0;
    for (const client of set) {
      try {
        client.close?.(reason);
      } catch {
        // The registry is already cleared; a broken socket cannot stay authorized.
      }
      closed += 1;
    }
    return closed;
  }

  /**
   * Fan-out to current user's clients. 任何一个 client.send throw 时
   * 自动 unregister 该 client (不让坏连接污染后续 broadcast). 整体 fail-OPEN
   * 返 {sent, dropped} 让 caller 写 metric / log; 绝不 throw.
   */
  broadcast(payload: AlertsBroadcastPayload): { sent: number; dropped: number } {
    const user_id = payload.user_id;
    if (!isValidUserId(user_id)) {
      return { sent: 0, dropped: 0 };
    }
    const set = this.userClients.get(user_id);
    if (!set || set.size === 0) {
      return { sent: 0, dropped: 0 };
    }
    let sent = 0;
    let dropped = 0;
    // snapshot copy: send 内异步 unregister 不影响 for-of 顺序
    const snapshot = Array.from(set).slice(0, MAX_BROADCAST_FANOUT);
    for (const client of snapshot) {
      // close 状态优先 unregister 不发送
      let isOpen = true;
      try {
        isOpen = client.isOpen();
      } catch {
        isOpen = false;
      }
      if (!isOpen) {
        set.delete(client);
        dropped += 1;
        continue;
      }
      try {
        client.send(payload);
        sent += 1;
      } catch (err: any) {
        // send throw → 视为坏连接, 自动 drop
        set.delete(client);
        dropped += 1;
        logger.warn(
          `[AlertsBroadcaster] client.send 异常 client=${client.client_id} user=${user_id}: ${
            err?.message || err
          }`
        );
      }
    }
    if (set.size === 0) {
      this.userClients.delete(user_id);
    }
    return { sent, dropped };
  }

  /**
   * 清空所有注册 (单测 reset / 测试隔离用).
   */
  resetForTests(): void {
    this.userClients.clear();
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const alertsBroadcaster = new AlertsBroadcaster();
