/**
 * bridgeFailSafe — broker-bridge fail-safe 统一 helper (US-018 / EX-004)
 *
 * 目的: bridge 失联 / KillSwitch 激活 / 重大风控事件触发时, 把已写入 LiveBrokerCommand
 *       表但仍处于 pending / dispatching / dispatched 的命令"安全停掉", 防止 bridge
 *       重启 / 下次 pull 时继续把熔断窗口内的指令送进券商通道执行真单.
 *
 * 设计契约 (与 BETA-V batch / lt-3+lt-4 fix 对齐):
 *   - pending 命令: 还没被 bridge 取走 → 直接 status='aborted' + metadata.killed=true
 *   - dispatching / dispatched 命令: bridge 可能已在执行 → 不强改 status (避免 bridge
 *     ack 时 conflict), 只在 metadata 标 killed=true 让 bridge 自行识别并拒执行
 *   - 全程 fail-safe: 任一子操作失败 (update / audit) 都不能阻塞主流程; query throw
 *     可以 propagate 给 caller 看到 (KillSwitchService 用 .catch 包了一层 logger.warn)
 *
 * 抽出原因 (US-018 EX-004):
 *   - 原 KillSwitchService.abortPendingCommands 是 private + 直接走 LiveBrokerCommand
 *     model + 模块顶层 import sequelize, 无法用 DB-less 单测覆盖 fail-safe 边界.
 *   - 抽到独立 module + DI seam (BridgeFailSafeDataSource) 后, 测试可以注入 fake 模型
 *     完整模拟 bridge 失联 / KillSwitch 激活 / 部分 throw 三类场景, 覆盖 acceptance
 *     "bridge 失联 / KillSwitch 激活 → 全 pending 转 aborted" 单测.
 *   - KillSwitchService.abortPendingCommands 退化为薄 wrapper 委托给本 helper, 行为
 *     语义不变, 生产链路向后兼容.
 *
 * 引入了一个轻 PORT (sequelizeEscape 函数 + literal 工厂), 让本模块在没有 sequelize
 * 实例的情况下也能跑测试 — 生产路径 KillSwitchService 注入真 sequelize.literal /
 * sequelize.escape, 测试路径注入字符串化 stub.
 */

import { logger } from '../../utils/logger';
import { LIVE_AUDIT_EVENT_TYPES } from '../auditEvents';

/** 与 BridgeService / KillSwitchService 共享: 哪些 bridge_status 算"失败/异常" */
export const FAILED_BRIDGE_STATUSES = new Set(['failed', 'rejected', 'cancel_error', 'expired']);

/** 哪些 command status 在 KillSwitch 触发时需要"软标记" — 不强改 status, 只设 metadata.killed=true */
export const IN_FLIGHT_COMMAND_STATUSES = ['dispatching', 'dispatched'] as const;

/** 哪些 command status 在 KillSwitch 触发时可以"硬转 aborted" — 还没被 bridge 取走 */
export const ABORTABLE_COMMAND_STATUS = 'pending' as const;

/** literal 抽象: 生产路径返回 sequelize.literal(...), 测试路径返回 plain string. */
export type LiteralBuilder = (reasonCode: string, reasonDetail: string) => unknown;

/**
 * DI seam: KillSwitchService 在 production 注入真实 model + sequelize literal helper;
 * 单测注入 fake 实现完整模拟 update 计数 / audit 写入 / 部分 throw.
 */
export interface BridgeFailSafeDataSource {
  /** 更新 pending 命令为 aborted, 返回 affected_rows */
  abortPendingCommands(input: { reason_code: string; reason_detail: string }): Promise<number>;

  /** 标记 dispatching/dispatched 命令 metadata.killed=true, 返回 affected_rows */
  markInflightCommandsKilled(input: {
    reason_code: string;
    reason_detail: string;
  }): Promise<number>;

  /** 写一条 KILL_SWITCH_TRIGGERED audit log; 失败不能 throw */
  writeAbortAudit(input: {
    aborted_count: number;
    marked_count: number;
    reason_code: string;
    reason_detail: string;
  }): Promise<void>;
}

export interface AbortBridgeCommandsResult {
  /** pending → aborted 的条数 */
  aborted: number;
  /** dispatching/dispatched 软标记 killed 的条数 */
  marked: number;
  /** 总变更条数 (aborted + marked) */
  total: number;
  /** 全程是否未抛错 (audit / 单条 update 失败时仍 true; query throw 时 false) */
  ok: boolean;
}

/**
 * 主入口: 把当前所有 pending → aborted, 所有 in-flight (dispatching/dispatched)
 * → 软标记 killed=true. 任一阶段 throw 都让 caller 拿到完整 error (caller 决定
 * 是否 swallow), 但 audit 写入失败被 swallow + log warn.
 *
 * fail-safe 边界:
 *   - pending update throw → 整体 throw, marked=0, aborted=0
 *   - inflight update throw → 整体 throw, aborted=之前的结果 但不被返 (caller 看不到)
 *   - audit throw → 不 throw, ok=true, 仅 log warn
 *   - aborted=0 && marked=0 → 不写 audit (没必要)
 */
export async function abortBridgeCommandsOnKillSwitch(
  source: BridgeFailSafeDataSource,
  params: { reason_code: string; reason_detail: string }
): Promise<AbortBridgeCommandsResult> {
  const reason_code = String(params.reason_code || 'unknown');
  const reason_detail = String(params.reason_detail || '');

  const aborted = await source.abortPendingCommands({ reason_code, reason_detail });
  const marked = await source.markInflightCommandsKilled({ reason_code, reason_detail });
  const total = aborted + marked;

  if (total > 0) {
    logger.warn(
      `[kill-switch] abortBridgeCommandsOnKillSwitch: aborted=${aborted} pending + marked=${marked} in-flight (reason=${reason_code})`
    );
    try {
      await source.writeAbortAudit({
        aborted_count: aborted,
        marked_count: marked,
        reason_code,
        reason_detail,
      });
    } catch (auditErr: any) {
      // fail-safe: audit 写入失败不影响主流程, 仅 log warn
      logger.warn(`[kill-switch] abort audit log failed: ${auditErr?.message || auditErr}`);
    }
  }

  return { aborted, marked, total, ok: true };
}

/**
 * 生产环境 DataSource 工厂. KillSwitchService 调一次拿一个 source 注入主入口.
 *
 * 故意 lazy require 模型 + sequelize 实例 — 与原 KillSwitchService.abortPendingCommands
 * 同款保留循环依赖解法 (KillSwitchService 顶层已 import sequelize, 本模块顶层不 import
 * 避免在测试场景里把数据库连接挂上).
 */
export function createProductionBridgeFailSafeDataSource(): BridgeFailSafeDataSource {
  return {
    async abortPendingCommands({ reason_code, reason_detail }) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { LiveBrokerCommand } = require('../../models/LiveBrokerCommand');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { sequelize } = require('../../config/database');
      const literal = buildKilledMetadataLiteral(
        sequelize,
        LiveBrokerCommand,
        reason_code,
        reason_detail
      );
      const result = await LiveBrokerCommand.update(
        { status: 'aborted', metadata: literal },
        { where: { status: ABORTABLE_COMMAND_STATUS } }
      );
      return Array.isArray(result) ? Number(result[0]) || 0 : 0;
    },
    async markInflightCommandsKilled({ reason_code, reason_detail }) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Op } = require('sequelize');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { LiveBrokerCommand } = require('../../models/LiveBrokerCommand');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { sequelize } = require('../../config/database');
      const literal = buildKilledMetadataLiteral(
        sequelize,
        LiveBrokerCommand,
        reason_code,
        reason_detail
      );
      const result = await LiveBrokerCommand.update(
        { metadata: literal },
        {
          where: {
            status: { [Op.in]: [...IN_FLIGHT_COMMAND_STATUSES] },
          },
        }
      );
      return Array.isArray(result) ? Number(result[0]) || 0 : 0;
    },
    async writeAbortAudit({ aborted_count, marked_count, reason_code, reason_detail }) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { LiveExecutionAuditLog } = require('../../models/LiveExecutionAuditLog');
      await LiveExecutionAuditLog.create({
        event_type: LIVE_AUDIT_EVENT_TYPES.KILL_SWITCH_TRIGGERED,
        severity: 'critical',
        message:
          `Kill switch 触发后批量标记 ${aborted_count} pending command aborted + ` +
          `${marked_count} in-flight command 标记 killed=true (bridge 自行识别拒执行)`,
        before_state: {},
        after_state: { aborted_count, marked_count, reason_code },
        metadata: { reason_code, reason_detail },
      } as any);
    },
  };
}

/**
 * 构造 JSONB metadata patch literal:
 *   COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('killed', true, ...)
 *
 * 抽出 helper 供两个 update 路径复用. 测试可以替换 sequelize 参数为 fake 测路径不抛.
 */
export function buildKilledMetadataLiteral(
  sequelize: { literal: (sql: string) => unknown; escape?: (v: any) => string },
  Model: { sequelize?: { escape: (v: any) => string } },
  reason_code: string,
  reason_detail: string
): unknown {
  const escape =
    Model?.sequelize?.escape?.bind(Model.sequelize) ||
    sequelize?.escape?.bind(sequelize) ||
    ((v: any) => `'${String(v).replace(/'/g, "''")}'`);
  const codeEsc = escape(String(reason_code));
  const detailEsc = escape(String(reason_detail));
  return sequelize.literal(
    `COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('killed', true, 'kill_reason_code', ${codeEsc}, 'kill_reason_detail', ${detailEsc})`
  );
}
