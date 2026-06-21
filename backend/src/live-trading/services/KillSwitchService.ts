import { EventEmitter } from 'events';
import { Op } from 'sequelize';
import { LiveKillSwitchState } from '../../models/LiveKillSwitchState';
import { LiveExecutionAuditLog } from '../../models/LiveExecutionAuditLog';
import { LiveOrder } from '../../models/LiveOrder';
import { LiveBrokerBridgeHeartbeat } from '../../models/LiveBrokerBridgeHeartbeat';
import { LiveBrokerAccount } from '../../models/LiveBrokerAccount';
import { LiveAccountSnapshot } from '../../models/LiveAccountSnapshot';
import { sequelize } from '../../config/database';
import { logger } from '../../utils/logger';
import { sendLiveAuditAlert } from './LiveAuditAlertService';
import { LIVE_AUDIT_EVENT_TYPES } from '../auditEvents';
import {
  abortBridgeCommandsOnKillSwitch,
  createProductionBridgeFailSafeDataSource,
} from './bridgeFailSafe';

export type KillSwitchReasonCode =
  | 'bridge_heartbeat_lost'
  | 'order_failure_streak'
  | 'order_failure_rate'
  | 'daily_loss_breach'
  | 'order_count_breach'
  | 'account_anomaly'
  | 'manual'
  | 'external_compliance'
  | 'smoke_test';

interface ActiveKillSwitch {
  id: number;
  reason_code: KillSwitchReasonCode | string;
  reason_detail: string;
  source: string;
  triggered_at: string;
  triggered_by?: string | null;
  metadata: Record<string, any>;
}

interface KillSwitchCheckResult {
  active: boolean;
  active_state: ActiveKillSwitch | null;
  source: 'env' | 'db' | 'none';
}

function numberEnv(name: string, fallback: number): number {
  const num = Number(process.env[name]);
  return Number.isFinite(num) ? num : fallback;
}

// 与 BridgeService.advanceCommandStatus 共享：哪些 bridge_status 算"失败/异常"
const FAILED_BRIDGE_STATUSES = new Set(['failed', 'rejected', 'cancel_error', 'expired']);

/**
 * 服务端 kill switch：与环境变量 LIVE_TRADING_KILL_SWITCH 是 OR 关系。
 * 任意一处熔断都不能下单。
 *
 * 设计要点（review 修订）：
 *  - 触发后必须人工 resolve；不会自动恢复。
 *  - 同时只允许一条活跃记录；重复触发追加 metadata 同时仍写 audit log（不再静默吞）。
 *  - 自动巡检覆盖：连败 / 失败率 / 订单数 / **心跳丢失** / **当日浮亏** / **账户异常**。
 *  - 触发后 emit 'kill_switch_triggered' 事件，bridge controller 监听并主动断开活跃长轮询/SSE。
 */
export class KillSwitchService extends EventEmitter {
  /** 当前是否处于熔断（仅查 DB；env 由 LiveTradingSafetyService 合并判断） */
  async isTriggered(): Promise<KillSwitchCheckResult> {
    const active = await LiveKillSwitchState.findOne({
      where: { active: true },
      order: [['triggered_at', 'DESC']],
    });
    if (!active) return { active: false, active_state: null, source: 'none' };
    return {
      active: true,
      active_state: this.toActive(active),
      source: 'db',
    };
  }

  async getActiveState(): Promise<ActiveKillSwitch | null> {
    const row = await LiveKillSwitchState.findOne({
      where: { active: true },
      order: [['triggered_at', 'DESC']],
    });
    return row ? this.toActive(row) : null;
  }

  /**
   * 触发熔断。幂等：当前已有活跃记录则追加 metadata + 写 audit；首次触发返回 created=true。
   *
   * 并发安全：用事务 + (active=true) partial unique 兜底；同时还做"先查再写"防多个事务都插入失败。
   * 兜底逻辑：如果 partial unique 冲突（两个事务并发都插入 active=true），catch 23505 后退回 existing 分支。
   */
  async trigger(params: {
    reason_code: KillSwitchReasonCode | string;
    reason_detail: string;
    source?: 'auto' | 'manual' | 'external';
    triggered_by?: string;
    metadata?: Record<string, any>;
  }): Promise<{ created: boolean; state: ActiveKillSwitch }> {
    const triggerEntry = {
      reason_code: params.reason_code,
      reason_detail: params.reason_detail,
      source: params.source || 'auto',
      triggered_by: params.triggered_by || null,
      metadata: params.metadata || {},
      at: new Date().toISOString(),
    };

    // 先查 existing；如果有，直接走追加分支
    const existing = await LiveKillSwitchState.findOne({
      where: { active: true },
      order: [['triggered_at', 'DESC']],
    });
    if (existing) {
      await this.appendTrigger(existing, triggerEntry);
      const state = this.toActive(existing);
      // 不再为已 active 状态重复 emit；scan 多命中只会让 SSE 反复断重连。
      // 真正需要前端再次感知"接连触发"靠 LiveTrading.tsx 定期 fetchKillSwitch 拉 detail。
      return { created: false, state };
    }

    // 无 existing，尝试 create；并发场景靠 partial unique 兜底
    try {
      const created = await sequelize.transaction(async t => {
        const row = await LiveKillSwitchState.create(
          {
            active: true,
            reason_code: String(params.reason_code),
            reason_detail: params.reason_detail,
            source: params.source || 'auto',
            triggered_at: new Date(),
            triggered_by: params.triggered_by || null,
            metadata: params.metadata || {},
          } as any,
          { transaction: t }
        );
        return row;
      });
      try {
        await LiveExecutionAuditLog.create({
          event_type: LIVE_AUDIT_EVENT_TYPES.KILL_SWITCH_TRIGGERED,
          severity: 'critical',
          message: `Kill switch 已触发（${params.reason_code}）：${params.reason_detail}`,
          before_state: {},
          after_state: this.toActive(created) as any,
          metadata: { source: params.source || 'auto', triggered_by: params.triggered_by || null },
        } as any);
      } catch (error: any) {
        logger.error('写入 kill switch 触发审计日志失败:', error?.message || error);
      }
      const state = this.toActive(created);
      this.emit('kill_switch_triggered', state);
      // Batch V (2026-06-17, lt-3+lt-4 fix): trigger 后立即扫 pending/dispatching
      // LiveBrokerCommand 标 abort. 之前 trigger 只断 SSE / pull tick 不再派发,
      // 但 **已派发到 wire 的 + 队列里 pending 的命令仍会被 bridge 执行真单**,
      // kill switch 名义熔断实际无效. 现在显式 abort 让 bridge 下次 pull 看到
      // status=aborted 不执行, 同时 reject 已 dispatched 但未 ack 的命令.
      this.abortPendingCommands(params.reason_code, params.reason_detail).catch(err =>
        logger.warn(`[kill-switch] abortPendingCommands failed: ${err?.message || err}`)
      );
      sendLiveAuditAlert({
        event_type: LIVE_AUDIT_EVENT_TYPES.KILL_SWITCH_TRIGGERED,
        severity: 'critical',
        message: `Kill switch 已触发 (${params.reason_code}): ${params.reason_detail}`,
        metadata: {
          ...(params.metadata || {}),
          reason_code: params.reason_code,
          source: params.source,
        },
      });
      return { created: true, state };
    } catch (err: any) {
      const code = (err && (err.original?.code || err.parent?.code)) || '';
      const isDup =
        String(err?.name || '') === 'SequelizeUniqueConstraintError' ||
        code === '23505' ||
        code === 'SQLITE_CONSTRAINT_UNIQUE' ||
        code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
      if (!isDup) throw err;
      // 并发：其它事务先写了 active=true → 重读，走追加分支
      const winner = await LiveKillSwitchState.findOne({
        where: { active: true },
        order: [['triggered_at', 'DESC']],
      });
      if (winner) {
        await this.appendTrigger(winner, triggerEntry);
        const state = this.toActive(winner);
        // 同 existing 路径：不再为已 active 状态重复 emit
        return { created: false, state };
      }
      // 极端：partial unique 报冲突但又找不到 active 行（dev/sqlite 没建出 unique），转抛
      throw err;
    }
  }

  private async appendTrigger(existing: LiveKillSwitchState, triggerEntry: Record<string, any>) {
    const meta = (existing as any).metadata || {};
    const repeats: any[] = Array.isArray(meta.repeat_triggers) ? meta.repeat_triggers : [];
    repeats.push(triggerEntry);
    const newMeta = { ...meta, repeat_triggers: repeats.slice(-50) };
    await existing.update({ metadata: newMeta });
    try {
      await LiveExecutionAuditLog.create({
        event_type: LIVE_AUDIT_EVENT_TYPES.KILL_SWITCH_REPEAT_TRIGGERED,
        severity: 'warning',
        message: `Kill switch 已处于熔断，本次为追加触发（${triggerEntry.reason_code}）：${triggerEntry.reason_detail}`,
        before_state: { existing_reason_code: (existing as any).reason_code },
        after_state: triggerEntry as any,
        metadata: { source: triggerEntry.source, triggered_by: triggerEntry.triggered_by },
      } as any);
    } catch (error: any) {
      logger.error('写入 kill switch 重复触发审计日志失败:', error?.message || error);
    }
  }

  /**
   * Batch V (2026-06-17, lt-3+lt-4 fix): kill switch trigger 后扫 pending /
   * dispatching LiveBrokerCommand 标 aborted, 防止已在 wire 上的命令仍被 bridge
   * 真执行. 旧实现 trigger 只断 SSE / pull tick, 已 dispatched 但未 ack 的命令
   * 在数据库里没有任何 abort 路径, bridge 重启或下次 pull 时仍会执行.
   *
   * fail-safe: 单条 command update 失败不阻塞其他; 已 dispatched 的不能强 reject
   * (bridge 可能已经在执行), 只能标记 metadata.killed=true 让 bridge 接到 event
   * 时识别. pending 的可以直接标 aborted.
   *
   * US-018 (EX-004): 真实 abort 逻辑抽到 ./bridgeFailSafe.ts 便于 DB-less 单测,
   * 本方法退化为薄 wrapper 调用 helper, 行为语义不变.
   */
  private async abortPendingCommands(
    reason_code: KillSwitchReasonCode | string,
    reason_detail: string
  ): Promise<void> {
    try {
      await abortBridgeCommandsOnKillSwitch(createProductionBridgeFailSafeDataSource(), {
        reason_code: String(reason_code),
        reason_detail,
      });
    } catch (error: any) {
      logger.error(`[kill-switch] abortPendingCommands query failed: ${error?.message || error}`);
      throw error;
    }
  }

  /** 人工解除熔断 */
  async resolve(params: { resolved_by: string; note?: string }): Promise<ActiveKillSwitch | null> {
    const active = await LiveKillSwitchState.findOne({
      where: { active: true },
      order: [['triggered_at', 'DESC']],
    });
    if (!active) return null;
    const before = this.toActive(active);
    await active.update({
      active: false,
      resolved_at: new Date(),
      resolved_by: params.resolved_by,
      resolved_note: params.note || null,
    });
    try {
      await LiveExecutionAuditLog.create({
        event_type: LIVE_AUDIT_EVENT_TYPES.KILL_SWITCH_RESOLVED,
        severity: 'warning',
        message: `Kill switch 已解除（resolved_by=${params.resolved_by}）${
          params.note ? ': ' + params.note : ''
        }`,
        before_state: before as any,
        after_state: this.toActive(active) as any,
        metadata: {},
      } as any);
    } catch (error: any) {
      logger.error('写入 kill switch 解除审计日志失败:', error?.message || error);
    }
    const state = this.toActive(active);
    this.emit('kill_switch_resolved', state);
    sendLiveAuditAlert({
      event_type: LIVE_AUDIT_EVENT_TYPES.KILL_SWITCH_RESOLVED,
      severity: 'critical',
      message: `Kill switch 已解除 by ${params.resolved_by}${
        params.note ? ': ' + params.note : ''
      }`,
      metadata: { resolved_by: params.resolved_by, note: params.note || null },
    });
    return state;
  }

  /**
   * 自动巡检：覆盖六项触发条件。
   * 所有触发统一走 trigger（幂等）。
   */
  async runAutoTriggerScan(): Promise<{ checked: number; triggered: boolean; reasons: string[] }> {
    const reasons: string[] = [];
    const failStreakLimit = numberEnv('LIVE_RISK_FAIL_STREAK_KILL', 3);
    const orderCountKill = numberEnv('LIVE_RISK_MAX_DAILY_ORDER_COUNT', 5) * 1.5;
    const failRateLimit = 0.5;
    const failRateMinSample = 4;
    const heartbeatTimeoutMinutes = numberEnv('LIVE_RISK_HEARTBEAT_TIMEOUT_MINUTES', 5);
    const dailyLossKillPct = numberEnv('LIVE_RISK_DAILY_LOSS_KILL_PCT', 2);

    let triggered = false;
    let checked = 0;

    // 1) 失败率 / 连败 / 订单数：per-account 维度（避免一个用户拖累全网）
    const accounts = await LiveBrokerAccount.findAll({
      where: { is_active: true },
    });
    for (const account of accounts) {
      const accountId = Number((account as any).id);
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const recent = await LiveOrder.findAll({
        where: { account_id: accountId, created_at: { [Op.gte]: since } },
        order: [['created_at', 'DESC']],
        limit: 500,
      });
      checked += recent.length;

      if (recent.length >= failRateMinSample) {
        const failed = recent.filter((row: any) => {
          const s = String(row.bridge_status || row.status).toLowerCase();
          return FAILED_BRIDGE_STATUSES.has(s);
        });
        const rate = failed.length / recent.length;
        if (rate >= failRateLimit) {
          reasons.push(`account=${accountId} order_failure_rate ${(rate * 100).toFixed(1)}%`);
          await this.trigger({
            reason_code: 'order_failure_rate',
            reason_detail: `账户 ${accountId} 近 24 小时订单失败率 ${(rate * 100).toFixed(1)}% (${
              failed.length
            }/${recent.length})`,
            source: 'auto',
            triggered_by: 'kill_switch_auto_scan',
            metadata: {
              account_id: accountId,
              failed: failed.length,
              total: recent.length,
              window: '24h',
            },
          });
          triggered = true;
        }
      }
      if (recent.length >= failStreakLimit) {
        let streak = 0;
        for (const row of recent) {
          const s = String((row as any).bridge_status || (row as any).status).toLowerCase();
          if (FAILED_BRIDGE_STATUSES.has(s)) streak++;
          else break;
        }
        if (streak >= failStreakLimit) {
          reasons.push(`account=${accountId} order_failure_streak ${streak}`);
          await this.trigger({
            reason_code: 'order_failure_streak',
            reason_detail: `账户 ${accountId} 最近连续失败 ${streak} 笔订单 (阈值 ${failStreakLimit})`,
            source: 'auto',
            triggered_by: 'kill_switch_auto_scan',
            metadata: { account_id: accountId, streak, threshold: failStreakLimit },
          });
          triggered = true;
        }
      }
      if (recent.length >= orderCountKill) {
        reasons.push(`account=${accountId} order_count_breach ${recent.length}`);
        await this.trigger({
          reason_code: 'order_count_breach',
          reason_detail: `账户 ${accountId} 近 24 小时订单数 ${recent.length} ≥ ${orderCountKill}`,
          source: 'auto',
          triggered_by: 'kill_switch_auto_scan',
          metadata: {
            account_id: accountId,
            recent_count: recent.length,
            threshold: orderCountKill,
          },
        });
        triggered = true;
      }
    }

    // 2) 心跳丢失：bridge 注册过 bridge_key 的账户必须有近期心跳
    const heartbeatCutoff = new Date(Date.now() - heartbeatTimeoutMinutes * 60 * 1000);
    const bridgeAccounts = await LiveBrokerAccount.findAll({
      where: { is_active: true, bridge_key: { [Op.ne]: null as any } },
    });
    for (const account of bridgeAccounts) {
      const accountId = Number((account as any).id);
      const bridgeKey = (account as any).bridge_key;
      if (!bridgeKey) continue;
      const lastHb: any = await LiveBrokerBridgeHeartbeat.findOne({
        where: { bridge_key: bridgeKey },
        order: [['received_at', 'DESC']],
      });
      if (!lastHb || new Date(lastHb.received_at).getTime() < heartbeatCutoff.getTime()) {
        const detail = lastHb
          ? `bridge ${bridgeKey} 上次心跳在 ${new Date(
              lastHb.received_at
            ).toISOString()}，超过 ${heartbeatTimeoutMinutes} 分钟阈值`
          : `bridge ${bridgeKey} 从未推送过心跳`;
        reasons.push(`bridge_heartbeat_lost bridge=${bridgeKey}`);
        await this.trigger({
          reason_code: 'bridge_heartbeat_lost',
          reason_detail: detail,
          source: 'auto',
          triggered_by: 'kill_switch_auto_scan',
          metadata: {
            account_id: accountId,
            bridge_key: bridgeKey,
            threshold_minutes: heartbeatTimeoutMinutes,
          },
        });
        triggered = true;
      }
    }

    // 3) 当日累计浮亏 ≥ 阈值（路线图 §7.3）
    for (const account of accounts) {
      const accountId = Number((account as any).id);
      const latestSnap: any = await LiveAccountSnapshot.findOne({
        where: { account_id: accountId },
        order: [['snapshot_time', 'DESC']],
      });
      if (!latestSnap) continue;
      const total = Number(latestSnap.total_asset || 0);
      const dayPnl = Number(latestSnap.day_pnl || 0);
      if (total > 0 && dayPnl < 0) {
        const lossPct = (-dayPnl / total) * 100;
        if (lossPct >= dailyLossKillPct) {
          reasons.push(`account=${accountId} daily_loss_breach ${lossPct.toFixed(2)}%`);
          await this.trigger({
            reason_code: 'daily_loss_breach',
            reason_detail: `账户 ${accountId} 当日浮亏 ${lossPct.toFixed(
              2
            )}% ≥ 阈值 ${dailyLossKillPct}%`,
            source: 'auto',
            triggered_by: 'kill_switch_auto_scan',
            metadata: {
              account_id: accountId,
              day_pnl: dayPnl,
              total_asset: total,
              threshold_pct: dailyLossKillPct,
            },
          });
          triggered = true;
        }
      }
    }

    // 4) 账户异常事件：connection_status='error' 或 last_sync_at 超过 24h 仍 active
    const staleSyncCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    for (const account of accounts) {
      const status = String((account as any).connection_status || '').toLowerCase();
      const lastSync = (account as any).last_sync_at
        ? new Date((account as any).last_sync_at)
        : null;
      const staleSync = lastSync && lastSync.getTime() < staleSyncCutoff.getTime();
      if (status === 'error' || status === 'disconnected') {
        reasons.push(`account=${(account as any).id} account_anomaly status=${status}`);
        await this.trigger({
          reason_code: 'account_anomaly',
          reason_detail: `账户 ${(account as any).id} connection_status=${status}`,
          source: 'auto',
          triggered_by: 'kill_switch_auto_scan',
          metadata: { account_id: Number((account as any).id), connection_status: status },
        });
        triggered = true;
      } else if (staleSync && lastSync) {
        // P2 review：注释承诺的"last_sync_at 超 24h 仍 active"路径之前未实现
        const hoursStale = Math.round((Date.now() - lastSync.getTime()) / 3600 / 1000);
        reasons.push(`account=${(account as any).id} account_anomaly stale_sync ${hoursStale}h`);
        await this.trigger({
          reason_code: 'account_anomaly',
          reason_detail: `账户 ${
            (account as any).id
          } last_sync_at 已 ${hoursStale}h 未更新仍处 active`,
          source: 'auto',
          triggered_by: 'kill_switch_auto_scan',
          metadata: {
            account_id: Number((account as any).id),
            last_sync_at: lastSync.toISOString(),
            stale_hours: hoursStale,
          },
        });
        triggered = true;
      }
    }

    return { checked, triggered, reasons };
  }

  private toActive(row: LiveKillSwitchState): ActiveKillSwitch {
    const r: any = row;
    return {
      id: Number(r.id),
      reason_code: String(r.reason_code),
      reason_detail: String(r.reason_detail || ''),
      source: String(r.source || 'auto'),
      triggered_at: new Date(r.triggered_at).toISOString(),
      triggered_by: r.triggered_by || null,
      metadata: r.metadata || {},
    };
  }
}

export const killSwitchService = new KillSwitchService();
// allow many bridge controllers / long-poll handlers to listen
killSwitchService.setMaxListeners(1000);
