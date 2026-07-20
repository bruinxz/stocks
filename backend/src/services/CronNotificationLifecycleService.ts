import { Transaction } from 'sequelize';
import sequelize from '../config/database';
import { NotificationIncidentState } from '../models/NotificationIncidentState';
import { logger } from '../utils/logger';
import { formatEast8Readable } from '../utils/timezone';
import { FeishuNotificationService, feishuNotificationService } from './FeishuNotificationService';

export interface CronNotificationEventInput {
  task_id: number;
  task_type: string;
  task_name: string;
  failure_count: number;
  error_message?: string;
  execution_log_id?: number;
  killed?: boolean;
  occurred_at?: Date;
}

export interface CronIncidentSnapshot {
  source_key: string;
  status: 'open' | 'resolved';
  generation: number;
  occurrence_count: number;
  severity: string;
  summary: string;
  last_error: string | null;
  opened_at: Date | null;
  last_seen_at: Date | null;
  resolved_at: Date | null;
  escalated: boolean;
  opened_notification_generation: number;
  recovered_notification_generation: number;
  metadata: Record<string, unknown>;
}

export interface CronIncidentRepository {
  recordFailure(input: CronNotificationEventInput): Promise<CronIncidentSnapshot>;
  loadOpen(task_id: number): Promise<CronIncidentSnapshot | null>;
  markOpenedNotified(source_key: string, generation: number, escalated: boolean): Promise<void>;
  markEscalated(source_key: string, generation: number): Promise<void>;
  markResolved(source_key: string, generation: number, resolved_at: Date): Promise<void>;
}

export class SequelizeCronIncidentRepository implements CronIncidentRepository {
  async recordFailure(input: CronNotificationEventInput): Promise<CronIncidentSnapshot> {
    return sequelize.transaction(async transaction => {
      const sourceKey = `cron:${input.task_id}`;
      await NotificationIncidentState.findOrCreate({
        where: { source_key: sourceKey },
        defaults: {
          source_key: sourceKey,
          source_type: 'cron',
          source_id: String(input.task_id),
          status: 'resolved',
          generation: 0,
          occurrence_count: 0,
          severity: 'WARN',
          summary: input.task_name,
          metadata: {},
        },
        transaction,
      });
      const row = await NotificationIncidentState.findOne({
        where: { source_key: sourceKey },
        transaction,
        lock: Transaction.LOCK.UPDATE,
      });
      if (!row) throw new Error(`incident state missing after findOrCreate: ${sourceKey}`);

      const occurredAt = input.occurred_at || new Date();
      const opening = row.status !== 'open';
      const generation = opening ? Number(row.generation || 0) + 1 : Number(row.generation || 1);
      const occurrenceCount = opening ? 1 : Number(row.occurrence_count || 0) + 1;
      await row.update(
        {
          status: 'open',
          generation,
          occurrence_count: occurrenceCount,
          severity: input.killed ? 'HIGH' : row.severity || 'WARN',
          summary: `${input.task_name} (${input.task_type})`,
          last_error: input.error_message || '未知错误',
          opened_at: opening ? occurredAt : row.opened_at,
          last_seen_at: occurredAt,
          resolved_at: null,
          escalated: opening ? false : row.escalated,
          metadata: {
            task_id: input.task_id,
            task_type: input.task_type,
            task_name: input.task_name,
            failure_count: input.failure_count,
            execution_log_id: input.execution_log_id || null,
            killed: input.killed === true,
          },
        },
        { transaction }
      );
      return toSnapshot(row);
    });
  }

  async loadOpen(task_id: number): Promise<CronIncidentSnapshot | null> {
    const row = await NotificationIncidentState.findOne({
      where: { source_key: `cron:${task_id}`, status: 'open' },
    });
    return row ? toSnapshot(row) : null;
  }

  async markOpenedNotified(
    source_key: string,
    generation: number,
    escalated: boolean
  ): Promise<void> {
    await NotificationIncidentState.update(
      {
        opened_notification_generation: generation,
        ...(escalated ? { escalated: true, severity: 'HIGH' } : {}),
      },
      { where: { source_key, generation, status: 'open' } }
    );
  }

  async markEscalated(source_key: string, generation: number): Promise<void> {
    await NotificationIncidentState.update(
      { escalated: true, severity: 'HIGH' },
      { where: { source_key, generation, status: 'open' } }
    );
  }

  async markResolved(source_key: string, generation: number, resolved_at: Date): Promise<void> {
    await NotificationIncidentState.update(
      {
        status: 'resolved',
        resolved_at,
        recovered_notification_generation: generation,
      },
      { where: { source_key, generation, status: 'open' } }
    );
  }
}

export class CronNotificationLifecycleService {
  constructor(
    private readonly repository: CronIncidentRepository = new SequelizeCronIncidentRepository(),
    private readonly notifications: FeishuNotificationService = feishuNotificationService
  ) {}

  async recordFailure(input: CronNotificationEventInput): Promise<void> {
    try {
      const incident = await this.repository.recordFailure(input);
      const needsOpened = incident.opened_notification_generation < incident.generation;
      if (needsOpened) {
        const openedAt = incident.opened_at || input.occurred_at || new Date();
        const openedAsHigh = input.killed === true;
        await this.notifications.enqueueAndDeliver({
          idempotency_key: `${incident.source_key}:g${incident.generation}:opened`,
          topic_key: incident.source_key,
          audience: 'ops',
          kind: openedAsHigh ? 'cron_incident_opened_and_killed' : 'cron_incident_opened',
          severity: openedAsHigh ? 'HIGH' : 'WARN',
          title: openedAsHigh
            ? `🔴 定时任务故障并自动停用 · ${input.task_name}`
            : `🟠 定时任务故障 · ${input.task_name}`,
          payload: buildCronIncidentCard({
            input,
            incident,
            phase: openedAsHigh ? 'escalated' : 'opened',
            at: openedAt,
          }),
          correlation_id: input.execution_log_id
            ? `task_execution_log_id=${input.execution_log_id}`
            : null,
          metadata: { source_key: incident.source_key, generation: incident.generation },
        });
        await this.repository.markOpenedNotified(
          incident.source_key,
          incident.generation,
          openedAsHigh
        );
      }

      if (input.killed && !incident.escalated && !needsOpened) {
        await this.notifications.enqueueAndDeliver({
          idempotency_key: `${incident.source_key}:g${incident.generation}:escalated`,
          topic_key: incident.source_key,
          audience: 'ops',
          kind: 'cron_incident_escalated',
          severity: 'HIGH',
          title: `🔴 定时任务持续失败，已自动停用 · ${input.task_name}`,
          payload: buildCronIncidentCard({
            input,
            incident,
            phase: 'escalated',
            at: input.occurred_at || new Date(),
          }),
          correlation_id: input.execution_log_id
            ? `task_execution_log_id=${input.execution_log_id}`
            : null,
          metadata: { source_key: incident.source_key, generation: incident.generation },
        });
        await this.repository.markEscalated(incident.source_key, incident.generation);
      }
    } catch (error: any) {
      logger.warn(
        `[CronNotificationLifecycle] recordFailure task=${input.task_type} failed: ${
          error?.message || error
        }`
      );
    }
  }

  async recordRecovery(
    input: Omit<CronNotificationEventInput, 'failure_count' | 'killed'>
  ): Promise<void> {
    try {
      const incident = await this.repository.loadOpen(input.task_id);
      if (!incident) return;
      const resolvedAt = input.occurred_at || new Date();
      await this.notifications.enqueueAndDeliver({
        idempotency_key: `${incident.source_key}:g${incident.generation}:recovered`,
        topic_key: incident.source_key,
        audience: 'ops',
        kind: 'cron_incident_recovered',
        severity: 'SUCCESS',
        title: `🟢 定时任务已恢复 · ${input.task_name}`,
        payload: buildCronRecoveryCard(input, incident, resolvedAt),
        correlation_id: input.execution_log_id
          ? `task_execution_log_id=${input.execution_log_id}`
          : null,
        metadata: { source_key: incident.source_key, generation: incident.generation },
      });
      await this.repository.markResolved(incident.source_key, incident.generation, resolvedAt);
    } catch (error: any) {
      logger.warn(
        `[CronNotificationLifecycle] recordRecovery task=${input.task_type} failed: ${
          error?.message || error
        }`
      );
    }
  }
}

function buildCronIncidentCard(options: {
  input: CronNotificationEventInput;
  incident: CronIncidentSnapshot;
  phase: 'opened' | 'escalated';
  at: Date;
}): Record<string, unknown> {
  const { input, incident, phase, at } = options;
  const template = phase === 'escalated' ? 'red' : 'orange';
  const action =
    phase === 'escalated' ? '任务已达到熔断阈值并自动停用' : '系统已建立故障事件并开始跟踪';
  return {
    msg_type: 'interactive',
    card: {
      header: {
        template,
        title: {
          tag: 'plain_text',
          content:
            phase === 'escalated'
              ? `🔴 定时任务故障并自动停用 · ${input.task_name}`
              : `🟠 定时任务故障 · ${input.task_name}`,
        },
      },
      elements: [
        {
          tag: 'div',
          fields: [
            {
              is_short: true,
              text: { tag: 'lark_md', content: `**任务类型**\n${input.task_type}` },
            },
            { is_short: true, text: { tag: 'lark_md', content: `**任务 ID**\n${input.task_id}` } },
            {
              is_short: true,
              text: { tag: 'lark_md', content: `**连续失败**\n${input.failure_count} 次` },
            },
            {
              is_short: true,
              text: { tag: 'lark_md', content: `**事件代次**\n#${incident.generation}` },
            },
          ],
        },
        { tag: 'div', text: { tag: 'lark_md', content: `**状态**\n${action}` } },
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**最近错误**\n\`\`\`\n${escapeCardText(
              input.error_message || '未知错误',
              1200
            )}\n\`\`\``,
          },
        },
        {
          tag: 'note',
          elements: [
            {
              tag: 'plain_text',
              content: `${formatEast8Readable(at)}${
                input.execution_log_id ? ` · execution_log=${input.execution_log_id}` : ''
              }`,
            },
          ],
        },
      ],
    },
  };
}

function buildCronRecoveryCard(
  input: Omit<CronNotificationEventInput, 'failure_count' | 'killed'>,
  incident: CronIncidentSnapshot,
  resolvedAt: Date
): Record<string, unknown> {
  const openedAt = incident.opened_at || resolvedAt;
  const durationMinutes = Math.max(
    0,
    Math.round((resolvedAt.getTime() - openedAt.getTime()) / 60_000)
  );
  const metadata = incident.metadata || {};
  return {
    msg_type: 'interactive',
    card: {
      header: {
        template: 'green',
        title: { tag: 'plain_text', content: `🟢 定时任务已恢复 · ${input.task_name}` },
      },
      elements: [
        {
          tag: 'div',
          fields: [
            {
              is_short: true,
              text: { tag: 'lark_md', content: `**任务类型**\n${input.task_type}` },
            },
            {
              is_short: true,
              text: { tag: 'lark_md', content: `**故障持续**\n约 ${durationMinutes} 分钟` },
            },
            {
              is_short: true,
              text: {
                tag: 'lark_md',
                content: `**故障期间失败**\n${incident.occurrence_count} 次`,
              },
            },
            {
              is_short: true,
              text: { tag: 'lark_md', content: `**事件代次**\n#${incident.generation}` },
            },
          ],
        },
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**最后故障**\n${escapeCardText(incident.last_error || '未知错误', 800)}`,
          },
        },
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**当前状态**\n本次执行成功，连续失败计数已清零。${
              metadata.killed ? '任务此前已自动停用；请确认已按运维流程重新启用。' : ''
            }`,
          },
        },
        {
          tag: 'note',
          elements: [
            {
              tag: 'plain_text',
              content: `${formatEast8Readable(resolvedAt)}${
                input.execution_log_id ? ` · execution_log=${input.execution_log_id}` : ''
              }`,
            },
          ],
        },
      ],
    },
  };
}

function escapeCardText(value: string, max: number): string {
  return String(value || '')
    .replace(/```/g, "'''")
    .slice(0, max);
}

function toSnapshot(row: NotificationIncidentState): CronIncidentSnapshot {
  return {
    source_key: row.source_key,
    status: row.status,
    generation: Number(row.generation) || 0,
    occurrence_count: Number(row.occurrence_count) || 0,
    severity: row.severity,
    summary: row.summary,
    last_error: row.last_error || null,
    opened_at: row.opened_at ? new Date(row.opened_at) : null,
    last_seen_at: row.last_seen_at ? new Date(row.last_seen_at) : null,
    resolved_at: row.resolved_at ? new Date(row.resolved_at) : null,
    escalated: row.escalated === true,
    opened_notification_generation: Number(row.opened_notification_generation) || 0,
    recovered_notification_generation: Number(row.recovered_notification_generation) || 0,
    metadata: row.metadata || {},
  };
}

export const cronNotificationLifecycleService = new CronNotificationLifecycleService();
