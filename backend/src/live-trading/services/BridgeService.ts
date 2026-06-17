import { Op } from 'sequelize';
import { LiveAccountSnapshot } from '../../models/LiveAccountSnapshot';
import { LivePosition } from '../../models/LivePosition';
import { LiveOrder } from '../../models/LiveOrder';
import { LiveTrade } from '../../models/LiveTrade';
import { LiveBrokerCommand } from '../../models/LiveBrokerCommand';
import { LiveBrokerCommandDispatch } from '../../models/LiveBrokerCommandDispatch';
import { LiveBrokerEvent } from '../../models/LiveBrokerEvent';
import { LiveBrokerBridgeHeartbeat } from '../../models/LiveBrokerBridgeHeartbeat';
import { LiveExecutionAuditLog } from '../../models/LiveExecutionAuditLog';
import { sequelize } from '../../config/database';
import { logger } from '../../utils/logger';
import { BridgeAuthContext } from '../middlewares/bridgeAuth';
import { killSwitchService } from './KillSwitchService';
import { LIVE_AUDIT_EVENT_TYPES } from '../auditEvents';

const FAILED_BRIDGE_STATUSES = new Set(['failed', 'cancel_error', 'rejected', 'expired']);
export { FAILED_BRIDGE_STATUSES };

/** 行锁仅在 postgres 上有意义；sqlite 不支持 LOCK.UPDATE，返回 undefined 让 sequelize 跳过 */
function rowLock(t: any): any {
  try {
    if (sequelize.getDialect() === 'postgres') return t.LOCK.UPDATE;
  } catch {}
  return undefined;
}

interface HeartbeatInput {
  bridge_version?: string;
  broker_client_status?: string;
  bridge_local_time?: string;
  metadata?: Record<string, any>;
}

interface AccountSnapshotInput {
  total_asset?: number;
  available_cash?: number;
  market_value?: number;
  frozen_cash?: number;
  total_pnl?: number;
  day_pnl?: number;
  snapshot_time?: string;
  raw_payload?: Record<string, any>;
}

interface PositionInput {
  symbol: string;
  name?: string;
  quantity: number;
  available_quantity: number;
  avg_cost: number;
  current_price?: number;
  market_value?: number;
  unrealized_pnl?: number;
  unrealized_pnl_pct?: number;
  quote_time?: string;
  raw_payload?: Record<string, any>;
}

interface OrderInput {
  broker_order_id: string;
  client_order_id?: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  limit_price: number;
  status: string;
  bridge_status?: string;
  submitted_at?: string;
  raw_payload?: Record<string, any>;
}

interface TradeInput {
  broker_trade_id: string;
  broker_order_id?: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  trade_price: number;
  trade_amount?: number;
  trade_time?: string;
  raw_payload?: Record<string, any>;
}

interface OrderEventInput {
  command_id: number;
  event_type: 'submitted' | 'trade' | 'cancelled' | 'failed' | 'order_error' | 'cancel_error';
  event_seq: string | number;
  event_time: string;
  broker_order_id?: string;
  broker_trade_id?: string;
  fill_quantity?: number;
  fill_price?: number;
  payload?: Record<string, any>;
}

function toDate(value: any): Date {
  if (!value) return new Date();
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : new Date();
}

function toNumber(value: any): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

/**
 * Bridge HTTP API 业务实现。
 *
 * 核心职责：
 *  - 心跳入库；
 *  - account_snapshot/positions/orders/trades 入库（按 bridge_key 绑定的 account 写）；
 *  - 长轮询拉取待派发命令（pending 状态）；
 *  - ack 把命令推进到 dispatched；
 *  - 事件入库 + 状态机推进（严格遵守 §6.2.1 / §7.4）。
 */
export class BridgeService {
  // ---------------------------------------------- 推送类（bridge → server）

  async ingestHeartbeat(
    ctx: BridgeAuthContext,
    input: HeartbeatInput
  ): Promise<{ id: number; clock_skew_seconds: number }> {
    const now = new Date();
    const localTime = input.bridge_local_time ? toDate(input.bridge_local_time) : undefined;
    // Batch V (2026-06-17, lt-5 fix): 字段值校验防恶意 fake heartbeat 绕过 stale guard.
    // 1) bridge_local_time 必须在 [-1h, +5min] 范围内 (允许时钟漂移, 拒绝未来 N 小时)
    // 2) broker_client_status 必须在枚举内, 其他值视为 unknown 不能给 'online'
    // 3) clock_skew 异常时降级 status='degraded' 让 kill switch heartbeat 检查能感知
    const MAX_SKEW_SEC = 3600; // 1h backward
    const MAX_FUTURE_SKEW_SEC = -300; // 5min future
    const clockSkew = localTime ? Math.round((now.getTime() - localTime.getTime()) / 1000) : 0;
    const skewSuspect = clockSkew > MAX_SKEW_SEC || clockSkew < MAX_FUTURE_SKEW_SEC;
    const ALLOWED_BROKER_STATUS = new Set(['logged_in', 'logged_out', 'connecting', 'error', 'unknown']);
    const rawBrokerStatus = String(input.broker_client_status || '').toLowerCase();
    const validatedBrokerStatus = ALLOWED_BROKER_STATUS.has(rawBrokerStatus)
      ? rawBrokerStatus
      : 'unknown';
    // Batch V (lt-5): 严格 status 派生 — 必须 broker logged_in **且** 时钟未异常才算 online.
    // 旧实现只看 broker_client_status === 'logged_in', bridge 可任意 fake.
    const status =
      validatedBrokerStatus === 'logged_in' && !skewSuspect ? 'online' : 'degraded';
    // metadata 大小上限防 DoS (lt-related, M9/H10)
    let safeMetadata: Record<string, any> = {};
    try {
      const meta = input.metadata || {};
      const serialized = JSON.stringify(meta);
      if (serialized.length > 8192) {
        safeMetadata = { truncated: true, original_size_bytes: serialized.length };
      } else {
        safeMetadata = meta;
      }
    } catch {
      safeMetadata = { invalid: true };
    }
    const row = await LiveBrokerBridgeHeartbeat.create({
      bridge_key: ctx.bridge_key,
      account_id: ctx.account_id,
      status,
      bridge_version: input.bridge_version || null,
      broker_client_status: validatedBrokerStatus,
      received_at: now,
      bridge_local_time: localTime,
      clock_skew_seconds: clockSkew,
      metadata: safeMetadata,
    } as any);
    return { id: Number((row as any).id), clock_skew_seconds: clockSkew };
  }

  async ingestAccountSnapshot(ctx: BridgeAuthContext, input: AccountSnapshotInput): Promise<{ id: number }> {
    const row = await LiveAccountSnapshot.create({
      user_id: ctx.user_id,
      account_id: ctx.account_id,
      total_asset: toNumber(input.total_asset),
      available_cash: toNumber(input.available_cash),
      market_value: toNumber(input.market_value),
      frozen_cash: toNumber(input.frozen_cash),
      total_pnl: toNumber(input.total_pnl),
      day_pnl: toNumber(input.day_pnl),
      snapshot_time: toDate(input.snapshot_time),
      source: 'bridge_readonly',
      raw_payload: input.raw_payload || {},
    } as any);
    // 只在首次切换时写 readonly_enabled=true，避免覆盖运维手动设置的 false
    const accountPatch: Record<string, any> = { last_sync_at: new Date() };
    if (!(ctx.account as any).readonly_enabled) {
      accountPatch.readonly_enabled = true;
    }
    await ctx.account.update(accountPatch);
    return { id: Number((row as any).id) };
  }

  async ingestPositions(ctx: BridgeAuthContext, positions: PositionInput[]): Promise<{ written: number }> {
    if (!Array.isArray(positions)) throw new Error('positions 必须是数组');
    if (positions.length === 0) return { written: 0 };
    // 整批包事务：避免半成品（部分行写入 + 中途失败）；单行内 findOne+update/create 仍可能与并发竞态，
    // 由 (account_id, symbol) unique 索引兜底（model 已声明）。
    const written = await sequelize.transaction(async t => {
      let n = 0;
      for (const p of positions) {
        if (!p || !p.symbol) continue;
        try {
          const payload: Record<string, any> = {
            user_id: ctx.user_id,
            account_id: ctx.account_id,
            symbol: String(p.symbol),
            name: p.name,
            quantity: Math.floor(toNumber(p.quantity)),
            available_quantity: Math.floor(toNumber(p.available_quantity)),
            avg_cost: toNumber(p.avg_cost),
            current_price: toNumber(p.current_price),
            market_value: toNumber(p.market_value),
            unrealized_pnl: toNumber(p.unrealized_pnl),
            unrealized_pnl_pct: toNumber(p.unrealized_pnl_pct),
            quote_time: p.quote_time ? toDate(p.quote_time) : undefined,
            source: 'bridge_readonly',
            raw_payload: p.raw_payload || {},
          };
          const existing = await LivePosition.findOne({
            where: { account_id: ctx.account_id, symbol: String(p.symbol) },
            transaction: t,
            lock: rowLock(t),
          });
          if (existing) {
            await existing.update(payload, { transaction: t });
          } else {
            await LivePosition.create({ ...payload, position_pct: 0 } as any, { transaction: t });
          }
          n += 1;
        } catch (err: any) {
          // 并发已被另一事务先 create：unique 冲突 → reload 走 update
          const code = (err && (err.original?.code || err.parent?.code)) || '';
          const isDup = String(err?.name || '') === 'SequelizeUniqueConstraintError'
            || code === '23505'
            || code === 'SQLITE_CONSTRAINT_UNIQUE'
            || code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
          if (!isDup) throw err;
          const existing = await LivePosition.findOne({
            where: { account_id: ctx.account_id, symbol: String(p.symbol) },
            transaction: t,
          });
          if (existing) {
            const payload: Record<string, any> = {
              user_id: ctx.user_id,
              account_id: ctx.account_id,
              symbol: String(p.symbol),
              name: p.name,
              quantity: Math.floor(toNumber(p.quantity)),
              available_quantity: Math.floor(toNumber(p.available_quantity)),
              avg_cost: toNumber(p.avg_cost),
              current_price: toNumber(p.current_price),
              market_value: toNumber(p.market_value),
              unrealized_pnl: toNumber(p.unrealized_pnl),
              unrealized_pnl_pct: toNumber(p.unrealized_pnl_pct),
              quote_time: p.quote_time ? toDate(p.quote_time) : undefined,
              source: 'bridge_readonly',
              raw_payload: p.raw_payload || {},
            };
            await existing.update(payload, { transaction: t });
            n += 1;
          }
        }
      }
      return n;
    });
    return { written };
  }

  /**
   * 替换式同步：以本次 payload 为该账户当前持仓的完整集合。
   * 不在 payload 里的 symbol → quantity 置零，避免出现"幽灵持仓"。
   *
   * 空集合保护：positions=[] 时不清零，避免 broker 临时空响应清掉真实持仓。
   * 整段包事务：upsert + 幽灵清零原子。
   */
  async replacePositions(ctx: BridgeAuthContext, positions: PositionInput[]): Promise<{ written: number; zeroed: number; skipped_empty?: boolean }> {
    if (!Array.isArray(positions) || positions.length === 0) {
      logger.warn(`replacePositions: empty positions payload for account ${ctx.account_id}, skipping to avoid wiping real holdings`);
      return { written: 0, zeroed: 0, skipped_empty: true };
    }
    const incomingSymbols = new Set(
      positions.filter(p => p && p.symbol).map(p => String(p.symbol))
    );
    if (incomingSymbols.size === 0) {
      return { written: 0, zeroed: 0, skipped_empty: true };
    }
    const result = await sequelize.transaction(async t => {
      // 复用 ingestPositions 的事务逻辑：包一个 inner txn，重用 LOCK；这里直接写一份单层 SQL 简洁版本
      let written = 0;
      for (const p of positions) {
        if (!p || !p.symbol) continue;
        const payload: Record<string, any> = {
          user_id: ctx.user_id,
          account_id: ctx.account_id,
          symbol: String(p.symbol),
          name: p.name,
          quantity: Math.floor(toNumber(p.quantity)),
          available_quantity: Math.floor(toNumber(p.available_quantity)),
          avg_cost: toNumber(p.avg_cost),
          current_price: toNumber(p.current_price),
          market_value: toNumber(p.market_value),
          unrealized_pnl: toNumber(p.unrealized_pnl),
          unrealized_pnl_pct: toNumber(p.unrealized_pnl_pct),
          quote_time: p.quote_time ? toDate(p.quote_time) : undefined,
          source: 'bridge_readonly',
          raw_payload: p.raw_payload || {},
        };
        const existing = await LivePosition.findOne({
          where: { account_id: ctx.account_id, symbol: String(p.symbol) },
          transaction: t,
          lock: rowLock(t),
        });
        if (existing) {
          await existing.update(payload, { transaction: t });
        } else {
          await LivePosition.create({ ...payload, position_pct: 0 } as any, { transaction: t });
        }
        written += 1;
      }
      const stale = await LivePosition.findAll({
        where: {
          account_id: ctx.account_id,
          quantity: { [Op.gt]: 0 },
          symbol: { [Op.notIn]: Array.from(incomingSymbols) },
        },
        transaction: t,
      });
      let zeroed = 0;
      for (const row of stale) {
        await row.update(
          {
            quantity: 0,
            available_quantity: 0,
            market_value: 0,
            source: 'bridge_readonly',
            raw_payload: { ...(row as any).raw_payload, zeroed_by_replace_at: new Date().toISOString() },
          },
          { transaction: t }
        );
        zeroed += 1;
      }
      return { written, zeroed };
    });
    return result;
  }

  async ingestOrders(ctx: BridgeAuthContext, orders: OrderInput[]): Promise<{ written: number; skipped: number }> {
    if (!Array.isArray(orders)) throw new Error('orders 必须是数组');
    if (orders.length === 0) return { written: 0, skipped: 0 };
    // 逐条独立事务：单条 unique 冲突不会让整批回滚
    let written = 0;
    let skipped = 0;
    for (const o of orders) {
      if (!o || !o.broker_order_id) {
        skipped += 1;
        continue;
      }
      try {
        await sequelize.transaction(async t => {
          const existing = await LiveOrder.findOne({
            where: { account_id: ctx.account_id, broker_order_id: o.broker_order_id },
            transaction: t,
            lock: rowLock(t),
          });
          if (existing) {
            await existing.update(
              {
                status: o.status,
                bridge_status: o.bridge_status || o.status,
                raw_payload: { ...(existing as any).raw_payload, last_sync: o.raw_payload || {} },
              },
              { transaction: t }
            );
            return;
          }
          await LiveOrder.create(
            {
              user_id: ctx.user_id,
              account_id: ctx.account_id,
              client_order_id: o.client_order_id || null,
              broker_order_id: o.broker_order_id,
              symbol: o.symbol,
              side: o.side,
              quantity: toNumber(o.quantity),
              limit_price: toNumber(o.limit_price),
              status: o.status,
              bridge_status: o.bridge_status || o.status,
              submitted_at: o.submitted_at ? toDate(o.submitted_at) : undefined,
              raw_payload: o.raw_payload || {},
            } as any,
            { transaction: t }
          );
        });
        written += 1;
      } catch (err: any) {
        const code = (err && (err.original?.code || err.parent?.code)) || '';
        const name = String(err?.name || '');
        const isDup = name === 'SequelizeUniqueConstraintError'
          || code === '23505'
          || code === 'SQLITE_CONSTRAINT_UNIQUE'
          || code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
        if (isDup) {
          skipped += 1;
          continue;
        }
        logger.warn('ingestOrders row failed:', err?.message || err);
        skipped += 1;
      }
    }
    return { written, skipped };
  }

  async ingestTrades(ctx: BridgeAuthContext, trades: TradeInput[]): Promise<{ written: number; skipped: number }> {
    if (!Array.isArray(trades)) throw new Error('trades 必须是数组');
    if (trades.length === 0) return { written: 0, skipped: 0 };
    let written = 0;
    let skipped = 0;
    for (const t of trades) {
      if (!t || !t.broker_trade_id) {
        skipped += 1;
        continue;
      }
      try {
        await sequelize.transaction(async tx => {
          // 反查 LiveOrder.id 以便填 order_id（方便后续按 order 维度对账）
          let orderId: number | null = null;
          if (t.broker_order_id) {
            const order = await LiveOrder.findOne({
              where: { account_id: ctx.account_id, broker_order_id: t.broker_order_id },
              transaction: tx,
            });
            if (order) orderId = Number((order as any).id);
          }
          await LiveTrade.create(
            {
              user_id: ctx.user_id,
              account_id: ctx.account_id,
              order_id: orderId,
              broker_trade_id: t.broker_trade_id,
              symbol: t.symbol,
              side: t.side,
              quantity: toNumber(t.quantity),
              trade_price: toNumber(t.trade_price),
              trade_amount: toNumber(t.trade_amount || toNumber(t.quantity) * toNumber(t.trade_price)),
              trade_time: t.trade_time ? toDate(t.trade_time) : new Date(),
              raw_payload: t.raw_payload || {},
            } as any,
            { transaction: tx }
          );
        });
        written += 1;
      } catch (err: any) {
        const code = (err && (err.original?.code || err.parent?.code)) || '';
        const name = String(err?.name || '');
        const isDup = name === 'SequelizeUniqueConstraintError'
          || code === '23505'
          || code === 'SQLITE_CONSTRAINT_UNIQUE'
          || code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
        if (isDup) {
          skipped += 1;
          continue;
        }
        logger.warn('ingestTrades row failed:', err?.message || err);
        skipped += 1;
      }
    }
    return { written, skipped };
  }

  // ---------------------------------------------- 命令派发

  async pullPendingCommands(
    ctx: BridgeAuthContext,
    options: { wait_seconds?: number; limit?: number; channel?: 'long_poll' | 'sse'; abort?: () => boolean } = {}
  ): Promise<{ commands: any[] }> {
    const wait = Math.min(Math.max(Number(options.wait_seconds || 0), 0), 60);
    const limit = Math.min(Math.max(Number(options.limit || 10), 1), 50);
    const channel = options.channel || 'long_poll';
    const abort = options.abort || (() => false);
    const deadline = Date.now() + wait * 1000;
    // 循环 tick 间隔；可通过 LIVE_BRIDGE_PULL_TICK_MS 调整；默认 2 秒减少空查 DB
    const tickMs = Math.max(Number(process.env.LIVE_BRIDGE_PULL_TICK_MS || 2000), 500);

    // 心跳健康度检查：bridge 心跳丢失超过 LIVE_BRIDGE_HEARTBEAT_TIMEOUT_SECONDS（默认 300s）则禁止派单
    const heartbeatTimeoutMs = Math.max(
      Number(process.env.LIVE_BRIDGE_HEARTBEAT_TIMEOUT_SECONDS || 300),
      30
    ) * 1000;
    const lastHeartbeat: any = await LiveBrokerBridgeHeartbeat.findOne({
      where: { bridge_key: ctx.bridge_key },
      order: [['received_at', 'DESC']],
    });
    if (lastHeartbeat && lastHeartbeat.received_at && Date.now() - new Date(lastHeartbeat.received_at).getTime() > heartbeatTimeoutMs) {
      logger.warn(
        `bridge ${ctx.bridge_key} heartbeat is stale (${Math.round((Date.now() - new Date(lastHeartbeat.received_at).getTime()) / 1000)}s), refuse dispatch`
      );
      return { commands: [] };
    }

    while (true) {
      // 每次 tick 都重新判 kill switch 与 abort，确保立即响应
      if (abort()) return { commands: [] };
      const ks = await killSwitchService.isTriggered();
      if (ks.active) {
        return { commands: [] };
      }

      // 原子派发：UPDATE ... WHERE status='pending' RETURNING id
      // 用 raw SQL 避免 read-modify-write 竞态导致同一命令被多次派给不同 pull 请求
      const dialect = sequelize.getDialect();
      let claimedRows: any[] = [];
      if (dialect === 'postgres') {
        const [results] = await sequelize.query(
          `UPDATE "live_broker_commands"
             SET "status" = 'dispatching',
                 "bridge_key" = :bridge_key,
                 "dispatched_at" = NOW(),
                 "updated_at" = NOW()
           WHERE "id" IN (
             SELECT "id" FROM "live_broker_commands"
              WHERE "account_id" = :account_id
                AND "status" = 'pending'
                AND "expires_at" > NOW()
              ORDER BY "created_at" ASC
              LIMIT :limit
              FOR UPDATE SKIP LOCKED
           )
           RETURNING *`,
          {
            replacements: { bridge_key: ctx.bridge_key, account_id: ctx.account_id, limit },
          }
        );
        claimedRows = Array.isArray(results) ? (results as any[]) : [];
      } else {
        // 非 postgres 用乐观锁：findAll 后逐行 UPDATE WHERE status='pending' 兜底
        const rows = await LiveBrokerCommand.findAll({
          where: {
            account_id: ctx.account_id,
            status: 'pending',
            expires_at: { [Op.gt]: new Date() },
          },
          order: [['created_at', 'ASC']],
          limit,
        });
        for (const r of rows) {
          const [count] = await LiveBrokerCommand.update(
            {
              status: 'dispatching',
              bridge_key: ctx.bridge_key,
              dispatched_at: new Date(),
            } as any,
            { where: { id: Number((r as any).id), status: 'pending' } as any }
          );
          if (count > 0) {
            await r.reload();
            claimedRows.push((r as any).toJSON ? (r as any).toJSON() : r);
          }
        }
      }

      if (claimedRows.length) {
        for (const row of claimedRows) {
          try {
            await LiveBrokerCommandDispatch.create({
              command_id: Number(row.id),
              bridge_key: ctx.bridge_key,
              channel,
              dispatched_at: new Date(),
              metadata: {},
            } as any);
          } catch (err: any) {
            logger.warn('dispatch row create failed:', err?.message || err);
          }
        }
        return { commands: claimedRows.map(r => this.toCommandPayload(r)) };
      }
      if (Date.now() >= deadline) return { commands: [] };
      // 用 Promise.race 让 abort 信号能立即中断 tick
      await new Promise<void>(resolve => {
        const tid = setTimeout(resolve, tickMs);
        // ts ignore: setInterval/setTimeout 在 node 上都有 unref
        (tid as any).unref?.();
      });
    }
  }

  async ackCommand(ctx: BridgeAuthContext, commandId: number): Promise<{ status: string }> {
    const cmd = await LiveBrokerCommand.findByPk(commandId);
    if (!cmd) throw new Error(`未找到 command ${commandId}`);
    if (Number((cmd as any).account_id) !== ctx.account_id) {
      throw new Error(`command ${commandId} 不属于当前 bridge 绑定的账户`);
    }
    const current = String((cmd as any).status);
    // 严格化（review #46）：只接受 'dispatching' 的 ack。
    // 'pending' 表示 bridge 没经过 pull 直接 ack —— 攻击者拿到 bridge_key 后可绕过派发去重，拒绝。
    // 'dispatched' 表示已被另一个进程 ack，幂等返回当前态。
    if (current === 'dispatching') {
      await cmd.update({
        status: 'dispatched',
        bridge_key: ctx.bridge_key,
        dispatched_at: (cmd as any).dispatched_at || new Date(),
      });
      const latestDispatch = await LiveBrokerCommandDispatch.findOne({
        where: { command_id: Number((cmd as any).id), bridge_key: ctx.bridge_key, acked_at: null as any },
        order: [['dispatched_at', 'DESC']],
      });
      if (latestDispatch) await latestDispatch.update({ acked_at: new Date() });
      return { status: 'dispatched' };
    }
    if (current === 'pending') {
      throw new Error('command 当前 pending：必须先经 pull 派发后才能 ack；绕过派发直接 ack 已被拒绝');
    }
    return { status: current };
  }

  // ---------------------------------------------- 事件回传 + 状态推进

  async ingestOrderEvent(
    ctx: BridgeAuthContext,
    input: OrderEventInput
  ): Promise<{ accepted: boolean; reason?: string }> {
    if (!input || !input.command_id || !input.event_type || input.event_seq == null || !input.event_time) {
      throw new Error('event 必须包含 command_id, event_type, event_seq, event_time');
    }
    // event_seq 强制转 string，避免 number 大数精度丢失
    const eventSeqStr = String(input.event_seq);
    if (!/^\d+$/.test(eventSeqStr)) {
      throw new Error('event_seq 必须是非负整数字符串');
    }
    const cmd = await LiveBrokerCommand.findByPk(input.command_id);
    if (!cmd) throw new Error(`未找到 command ${input.command_id}`);
    if (Number((cmd as any).account_id) !== ctx.account_id) {
      throw new Error(`command ${input.command_id} 不属于当前 bridge 绑定的账户`);
    }
    try {
      await LiveBrokerEvent.create({
        command_id: Number((cmd as any).id),
        event_type: String(input.event_type),
        event_seq: eventSeqStr,
        event_time: toDate(input.event_time),
        received_at: new Date(),
        source: 'bridge',
        broker_order_id: input.broker_order_id || null,
        broker_trade_id: input.broker_trade_id || null,
        fill_quantity: input.fill_quantity != null ? Number(input.fill_quantity) : null,
        fill_price: input.fill_price != null ? Number(input.fill_price) : null,
        payload: input.payload || {},
      } as any);
    } catch (err: any) {
      // Sequelize UniqueConstraintError / postgres 23505 / sqlite SQLITE_CONSTRAINT_UNIQUE
      const code = (err && (err.original?.code || err.parent?.code)) || '';
      const name = String(err?.name || '');
      const isDup = name === 'SequelizeUniqueConstraintError' || code === '23505' || code === 'SQLITE_CONSTRAINT_UNIQUE';
      if (isDup) {
        return { accepted: false, reason: 'duplicate_event_seq' };
      }
      throw err;
    }

    const maxRow: any = await LiveBrokerEvent.findOne({
      where: { command_id: Number((cmd as any).id) },
      order: [['event_seq', 'DESC']],
    });
    const currentMaxSeq = maxRow ? String(maxRow.event_seq) : '0';
    let isLatest = false;
    try {
      isLatest = BigInt(currentMaxSeq) === BigInt(eventSeqStr);
    } catch {
      isLatest = false;
    }
    if (!isLatest) {
      return { accepted: true, reason: 'event_kept_for_audit' };
    }
    await this.advanceCommandStatus(cmd, input, eventSeqStr);
    return { accepted: true };
  }

  private async advanceCommandStatus(cmd: any, ev: OrderEventInput, eventSeqStr: string): Promise<void> {
    const current = String(cmd.status);
    const terminal = new Set(['filled', 'cancelled', 'failed', 'expired']);
    if (terminal.has(current)) return;

    // dry-run 探测：bridge readonly_only 模式发回的 broker_order_id 形如 'dryrun-*'，
    // 不允许污染 LiveOrder.broker_order_id（否则用户撤单会拿假 ID 给券商）
    const dryRunBrokerOrderId =
      typeof ev.broker_order_id === 'string' && ev.broker_order_id.startsWith('dryrun-');

    let appliedStatus: string | null = null;
    let appliedBrokerOrderId: string | null = null;

    await sequelize.transaction(async t => {
      // 重新读取以获得最新 filled_quantity 与 status（防 read-modify-write）
      const fresh: any = await LiveBrokerCommand.findByPk(Number(cmd.id), { transaction: t, lock: rowLock(t) });
      if (!fresh) return;
      const freshStatus = String(fresh.status);
      if (terminal.has(freshStatus)) return;

      const now = new Date();
      const patch: Record<string, any> = {};

      if (ev.event_type === 'submitted') {
        if (!ev.broker_order_id) {
          patch.status = 'failed';
          patch.finalized_at = now;
        } else if (dryRunBrokerOrderId) {
          patch.status = 'failed';
          patch.finalized_at = now;
          patch.metadata = { ...(fresh.metadata || {}), dry_run_acknowledged: ev.broker_order_id };
        } else {
          patch.status = 'submitted';
          patch.broker_order_id = ev.broker_order_id;
          patch.submitted_at = now;
          appliedBrokerOrderId = ev.broker_order_id;
        }
      } else if (ev.event_type === 'trade') {
        const fillQty = Number(ev.fill_quantity || 0);
        // 在同一事务内增量 + 终态判定，避免 read-modify-write 覆盖
        if (fillQty > 0) {
          await LiveBrokerCommand.increment('filled_quantity', {
            by: fillQty,
            where: { id: Number(fresh.id) } as any,
            transaction: t,
          });
          await fresh.reload({ transaction: t });
        }
        const accumulated = Number(fresh.filled_quantity || 0);
        const target = Number(fresh.quantity || 0);
        if (target > 0 && accumulated >= target) {
          patch.status = 'filled';
          patch.finalized_at = now;
        } else {
          patch.status = 'partially_filled';
        }
      } else if (ev.event_type === 'cancelled') {
        patch.status = 'cancelled';
        patch.remaining_quantity = Math.max(
          Number(fresh.quantity || 0) - Number(fresh.filled_quantity || 0),
          0
        );
        patch.finalized_at = now;
      } else if (ev.event_type === 'failed' || ev.event_type === 'order_error') {
        patch.status = 'failed';
        patch.finalized_at = now;
      }
      // cancel_error：原命令状态不变，仅入审计

      if (Object.keys(patch).length === 0) return;

      // 关键：UPDATE WHERE status NOT IN terminal 防止"被终态覆盖回中间态"
      const [updateCount] = await LiveBrokerCommand.update(patch as any, {
        where: {
          id: Number(fresh.id),
          status: { [Op.notIn]: ['filled', 'cancelled', 'failed', 'expired'] },
        } as any,
        transaction: t,
      });
      if (updateCount === 0) {
        // 已被其它事务推到终态，不再写
        return;
      }
      appliedStatus = String(patch.status);
    });

    if (!appliedStatus) return;

    // 同步 live_orders.bridge_status（事务外即可，order 也可能被并发改）
    let liveOrderId: number | null = cmd.order_id ? Number(cmd.order_id) : null;
    if (!liveOrderId && cmd.parent_command_id) {
      try {
        const parent = await LiveBrokerCommand.findByPk(Number(cmd.parent_command_id));
        if (parent && (parent as any).order_id) {
          liveOrderId = Number((parent as any).order_id);
        }
      } catch (err: any) {
        logger.warn('resolve parent command order_id failed:', err?.message || err);
      }
    }
    if (liveOrderId) {
      try {
        // 同样用 NOT IN terminal 防覆盖
        const orderPatch: Record<string, any> = { bridge_status: appliedStatus };
        if (appliedBrokerOrderId && !dryRunBrokerOrderId) {
          orderPatch.broker_order_id = appliedBrokerOrderId;
        }
        await LiveOrder.update(orderPatch as any, {
          where: {
            id: liveOrderId,
            bridge_status: { [Op.notIn]: ['filled', 'cancelled', 'failed', 'expired'] },
          } as any,
        });
      } catch (err: any) {
        logger.warn('sync live_orders.bridge_status failed:', err?.message || err);
      }
    }

    try {
      await LiveExecutionAuditLog.create({
        user_id: cmd.user_id,
        account_id: cmd.account_id,
        order_id: liveOrderId || null,
        event_type: `${LIVE_AUDIT_EVENT_TYPES.BRIDGE_STATUS_PREFIX}${appliedStatus}`,
        severity: appliedStatus === 'failed' ? 'error' : 'info',
        message: `Bridge 命令 ${cmd.client_order_id} 状态推进 ${current} → ${appliedStatus}`,
        before_state: { status: current },
        after_state: { status: appliedStatus, dry_run: dryRunBrokerOrderId },
        metadata: { event_type: ev.event_type, event_seq: eventSeqStr },
      } as any);
    } catch (err: any) {
      logger.warn('status advance audit log failed:', err?.message || err);
    }
  }

  private toCommandPayload(row: any) {
    return {
      command_id: Number(row.id),
      client_order_id: row.client_order_id,
      command_type: row.command_type,
      parent_command_id: row.parent_command_id || null,
      symbol: row.symbol,
      side: row.side,
      quantity: row.quantity,
      limit_price: row.limit_price,
      order_type: row.order_type,
      broker_order_id: row.broker_order_id || null,
      server_reference_price: row.server_reference_price || null,
      expires_at: row.expires_at,
      request_payload: row.request_payload || {},
      metadata: row.metadata || {},
    };
  }
}

export const bridgeService = new BridgeService();
