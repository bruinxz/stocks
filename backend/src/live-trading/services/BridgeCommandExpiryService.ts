import { Op } from 'sequelize';
import { LiveOrder } from '../../models/LiveOrder';
import { LiveBrokerCommand } from '../../models/LiveBrokerCommand';
import { LiveExecutionAuditLog } from '../../models/LiveExecutionAuditLog';
import { LiveBridgeNonce } from '../../models/LiveBridgeNonce';
import { logger } from '../../utils/logger';
import { LIVE_AUDIT_EVENT_TYPES } from '../auditEvents';

/**
 * Bridge 命令 / 实盘订单 TTL 巡检任务。
 *
 * 路线图 §7.4：命令默认 TTL 60 秒未 ack 即标 expired；绝不自动重试。
 *
 * 现在两侧都已落地，scanCommandsExpired 处理 live_broker_commands 主表，
 * scanOrdersExpired 仅作为兜底防御历史脏数据（例如 LiveOrder 写入但 LiveBrokerCommand 未来得及写）。
 * command expired 时联动把对应 LiveOrder.bridge_status 一起改成 expired，避免两侧状态对不齐。
 */
export class BridgeCommandExpiryService {
  private ttlMs(): number {
    const secs = Number(process.env.LIVE_BRIDGE_COMMAND_TTL_SECONDS || 60);
    const ms = (Number.isFinite(secs) ? secs : 60) * 1000;
    return Math.max(ms, 5_000); // 至少 5 秒避免误判
  }

  async runOnce(): Promise<{ orders_expired: number; commands_expired: number; nonces_cleaned: number }> {
    const commandsExpired = await this.scanCommandsExpired();
    const ordersExpired = await this.scanOrdersExpired();
    const noncesCleaned = await this.cleanupNonces();
    return {
      orders_expired: ordersExpired,
      commands_expired: commandsExpired,
      nonces_cleaned: noncesCleaned,
    };
  }

  /**
   * live_orders 兜底：bridge_status 仍 pending/dispatched 且 created_at 已超 TTL × 5（5 倍宽限），
   * 且找不到对应的活跃 LiveBrokerCommand 时才标 expired。避免与 scanCommandsExpired 重复处理。
   */
  private async scanOrdersExpired(): Promise<number> {
    const grace = this.ttlMs() * 5;
    const before = new Date(Date.now() - grace);
    const rows = await LiveOrder.findAll({
      where: {
        bridge_status: { [Op.in]: ['pending', 'dispatched', 'dispatching'] },
        created_at: { [Op.lt]: before },
      },
      limit: 200,
    });
    if (rows.length === 0) return 0;
    let updated = 0;
    for (const row of rows) {
      const r: any = row;
      const previous = String(r.bridge_status);
      // 如果有活跃命令，不动 — 让 scanCommandsExpired 处理
      const hasActiveCommand = await LiveBrokerCommand.count({
        where: {
          order_id: Number(r.id),
          status: { [Op.in]: ['pending', 'dispatching', 'dispatched', 'submitted', 'partially_filled'] },
        },
      });
      if (hasActiveCommand > 0) continue;
      try {
        await row.update({ bridge_status: 'expired' });
        updated += 1;
        try {
          await LiveExecutionAuditLog.create({
            user_id: r.user_id,
            account_id: r.account_id || null,
            draft_id: r.draft_id || null,
            order_id: Number(r.id),
            event_type: LIVE_AUDIT_EVENT_TYPES.ORDER_BRIDGE_EXPIRED,
            severity: 'warning',
            message: `LiveOrder 兜底过期：超 ${grace / 1000}s 未进入终态且无活跃命令，标 expired（前态：${previous}）。`,
            before_state: { bridge_status: previous },
            after_state: { bridge_status: 'expired' },
            metadata: {
              grace_ms: grace,
              client_order_id: r.client_order_id || null,
              broker_order_id: r.broker_order_id || null,
            },
          } as any);
        } catch (err: any) {
          logger.warn(`TTL expire audit log failed for order ${r.id}: ${err?.message || err}`);
        }
      } catch (err: any) {
        logger.warn(`TTL expire update failed for order ${r.id}: ${err?.message || err}`);
      }
    }
    return updated;
  }

  /** live_broker_commands 中 pending/dispatching/dispatched 但已超 expires_at 的，标 expired，并同步 LiveOrder */
  private async scanCommandsExpired(): Promise<number> {
    const now = new Date();
    const rows = await LiveBrokerCommand.findAll({
      where: {
        status: { [Op.in]: ['pending', 'dispatching', 'dispatched'] },
        expires_at: { [Op.lt]: now },
      },
      limit: 200,
    });
    if (rows.length === 0) return 0;
    let updated = 0;
    for (const row of rows) {
      const r: any = row;
      const previous = String(r.status);
      const expireTime = new Date();
      try {
        // P1 review：findAll → row.update 中间可能有 bridge 事件把命令推到 submitted/filled，
        // 直接 row.update 会盖回 expired。改成带 WHERE 原状态条件的 UPDATE，
        // count=0 即说明已被推走，跳过审计避免噪音。
        const [count] = await LiveBrokerCommand.update(
          { status: 'expired', finalized_at: expireTime } as any,
          {
            where: {
              id: Number(r.id),
              status: { [Op.in]: ['pending', 'dispatching', 'dispatched'] },
              expires_at: { [Op.lt]: now },
            } as any,
          }
        );
        if (count === 0) continue;
        updated += 1;
        // 联动 LiveOrder.bridge_status = expired（review §7.1）—— 同样用 NOT IN terminal 防覆盖
        const linkedOrderId = r.order_id ? Number(r.order_id) : null;
        if (linkedOrderId) {
          try {
            await LiveOrder.update(
              { bridge_status: 'expired' } as any,
              {
                where: {
                  id: linkedOrderId,
                  bridge_status: {
                    [Op.notIn]: ['filled', 'cancelled', 'failed', 'expired'],
                  },
                } as any,
              }
            );
          } catch (err: any) {
            logger.warn(`failed to expire linked order ${linkedOrderId}: ${err?.message || err}`);
          }
        }
        try {
          await LiveExecutionAuditLog.create({
            user_id: r.user_id,
            account_id: r.account_id || null,
            order_id: linkedOrderId,
            event_type: LIVE_AUDIT_EVENT_TYPES.BROKER_COMMAND_EXPIRED,
            severity: 'warning',
            message: `Bridge 命令 ${r.client_order_id} 超 TTL 未进入终态（前态：${previous}），自动 expired，不会自动重派。`,
            before_state: { status: previous },
            after_state: { status: 'expired' },
            metadata: {
              command_id: Number(r.id),
              command_type: r.command_type,
              client_order_id: r.client_order_id,
              expires_at: r.expires_at,
            },
          } as any);
        } catch (err: any) {
          logger.warn(`Command TTL audit log failed for command ${r.id}: ${err?.message || err}`);
        }
      } catch (err: any) {
        logger.warn(`Command TTL update failed for command ${r.id}: ${err?.message || err}`);
      }
    }
    return updated;
  }

  /** bridge nonce 过期清理：避免表无限增长 */
  private async cleanupNonces(): Promise<number> {
    try {
      const count = await LiveBridgeNonce.destroy({
        where: { expires_at: { [Op.lt]: new Date() } },
      });
      return count;
    } catch (err: any) {
      logger.warn(`nonce cleanup failed: ${err?.message || err}`);
      return 0;
    }
  }
}

export const bridgeCommandExpiryService = new BridgeCommandExpiryService();
