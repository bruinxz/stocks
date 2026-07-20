import axios from 'axios';
import { col, fn, Op } from 'sequelize';
import { logger } from '../utils/logger';
import { assertWebhookUrlAllowed } from '../utils/webhookUrlGuard';
import { FeishuNotificationOutbox } from '../models/FeishuNotificationOutbox';
import { User } from '../models/User';

export type FeishuAudience = 'ops' | 'business' | 'live' | 'user';
export type FeishuOutboxStatus = 'pending' | 'sending' | 'retry' | 'sent' | 'dead' | 'suppressed';

export interface FeishuOutboxRow {
  id: number;
  idempotency_key: string;
  topic_key: string;
  audience: FeishuAudience;
  recipient_user_id: number | null;
  kind: string;
  severity: string;
  title: string;
  payload: Record<string, unknown>;
  status: FeishuOutboxStatus;
  attempts: number;
  max_attempts: number;
  next_attempt_at: Date;
  locked_at: Date | null;
  sent_at: Date | null;
  dead_at: Date | null;
  last_error: string | null;
  last_status_code: number | null;
  response: Record<string, unknown>;
  correlation_id: string | null;
  metadata: Record<string, unknown>;
}

export interface EnqueueFeishuNotificationInput {
  idempotency_key: string;
  topic_key: string;
  audience: FeishuAudience;
  recipient_user_id?: number | null;
  kind: string;
  severity: string;
  title: string;
  payload: Record<string, unknown>;
  max_attempts?: number;
  correlation_id?: string | null;
  metadata?: Record<string, unknown>;
}

export interface FeishuDeliveryResult {
  success: boolean;
  skipped?: boolean;
  deduped?: boolean;
  status: FeishuOutboxStatus;
  outbox_id: number;
  attempts: number;
  message?: string;
  data?: Record<string, unknown>;
}

export interface FeishuNotificationDispatchSummary {
  scanned: number;
  sent: number;
  retry: number;
  dead: number;
  suppressed: number;
  skipped: number;
}

export interface FeishuNotificationListFilters {
  statuses?: FeishuOutboxStatus[];
  audiences?: FeishuAudience[];
  kind?: string;
  topic_key?: string;
  limit?: number;
}

export interface FeishuNotificationHealth {
  status: 'healthy' | 'degraded' | 'critical';
  counts: Record<FeishuOutboxStatus, number>;
  backlog: number;
  due: number;
  dead: number;
  oldest_due_at: string | null;
  latest: FeishuOutboxRow | null;
}

export interface FeishuNotificationRepository {
  findOrCreate(
    input: EnqueueFeishuNotificationInput,
    now: Date
  ): Promise<{ row: FeishuOutboxRow; created: boolean }>;
  findById(id: number): Promise<FeishuOutboxRow | null>;
  claim(id: number, now: Date, stale_before: Date): Promise<boolean>;
  update(id: number, patch: Partial<FeishuOutboxRow>): Promise<void>;
  loadDue(now: Date, stale_before: Date, limit: number): Promise<FeishuOutboxRow[]>;
  list(filters: FeishuNotificationListFilters): Promise<FeishuOutboxRow[]>;
  getHealth(now: Date, stale_before: Date): Promise<FeishuNotificationHealth>;
  requeueTerminal(id: number, now: Date): Promise<boolean>;
}

export type FeishuTargetResolver = (
  row: FeishuOutboxRow
) => Promise<{ url?: string; suppressed?: boolean; reason?: string }>;

export type FeishuWebhookSender = (
  url: string,
  payload: Record<string, unknown>
) => Promise<{ success: boolean; status_code?: number; message?: string; data?: any }>;

const LOCK_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 6;
const OUTBOX_STATUSES: FeishuOutboxStatus[] = [
  'pending',
  'sending',
  'retry',
  'sent',
  'dead',
  'suppressed',
];

export function computeFeishuRetryDelayMs(attempts: number): number {
  const schedule = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 4 * 60 * 60_000];
  const index = Math.max(0, Math.min(schedule.length - 1, Math.floor(attempts) - 1));
  return schedule[index];
}

/**
 * 兼容“同主题 N 分钟最多一条”的调用方，同时让去重跨进程、跨发布稳定。
 * 精确业务事件（日报日期、incident generation、trade id）应直接传自己的稳定键。
 */
export function buildWindowedFeishuIdempotencyKey(
  topic_key: string,
  now_ms: number,
  window_ms: number
): string {
  const safeWindow = Number.isFinite(window_ms) && window_ms > 0 ? window_ms : 60 * 60 * 1000;
  return `${topic_key}:window:${Math.floor(now_ms / safeWindow)}`;
}

export function extractFeishuResponseCode(body: any): number {
  const raw = body?.code ?? body?.StatusCode ?? body?.status_code ?? 0;
  const code = Number(raw);
  return Number.isFinite(code) ? code : 0;
}

export class SequelizeFeishuNotificationRepository implements FeishuNotificationRepository {
  async findOrCreate(input: EnqueueFeishuNotificationInput, now: Date) {
    const [model, created] = await FeishuNotificationOutbox.findOrCreate({
      where: { idempotency_key: input.idempotency_key },
      defaults: {
        idempotency_key: input.idempotency_key,
        topic_key: input.topic_key,
        audience: input.audience,
        recipient_user_id: input.recipient_user_id ?? null,
        kind: input.kind,
        severity: input.severity,
        title: input.title,
        payload: input.payload,
        status: 'pending',
        attempts: 0,
        max_attempts: Math.max(1, input.max_attempts || DEFAULT_MAX_ATTEMPTS),
        next_attempt_at: now,
        correlation_id: input.correlation_id || null,
        metadata: input.metadata || {},
        response: {},
      },
    });
    return { row: toOutboxRow(model), created };
  }

  async findById(id: number): Promise<FeishuOutboxRow | null> {
    const model = await FeishuNotificationOutbox.findByPk(id);
    return model ? toOutboxRow(model) : null;
  }

  async claim(id: number, now: Date, stale_before: Date): Promise<boolean> {
    const [updated] = await FeishuNotificationOutbox.update(
      { status: 'sending', locked_at: now },
      {
        where: {
          id,
          [Op.or]: [
            { status: { [Op.in]: ['pending', 'retry'] }, next_attempt_at: { [Op.lte]: now } },
            { status: 'sending', locked_at: { [Op.lte]: stale_before } },
          ],
        },
      }
    );
    return updated === 1;
  }

  async update(id: number, patch: Partial<FeishuOutboxRow>): Promise<void> {
    await FeishuNotificationOutbox.update(patch, { where: { id } });
  }

  async loadDue(now: Date, stale_before: Date, limit: number): Promise<FeishuOutboxRow[]> {
    const models = await FeishuNotificationOutbox.findAll({
      where: {
        [Op.or]: [
          { status: { [Op.in]: ['pending', 'retry'] }, next_attempt_at: { [Op.lte]: now } },
          { status: 'sending', locked_at: { [Op.lte]: stale_before } },
        ],
      },
      order: [
        ['next_attempt_at', 'ASC'],
        ['id', 'ASC'],
      ],
      limit: Math.max(1, Math.min(200, limit)),
    });
    return models.map(toOutboxRow);
  }

  async list(filters: FeishuNotificationListFilters): Promise<FeishuOutboxRow[]> {
    const where: Record<string | symbol, unknown> = {};
    if (filters.statuses?.length) where.status = { [Op.in]: filters.statuses };
    if (filters.audiences?.length) where.audience = { [Op.in]: filters.audiences };
    if (filters.kind) where.kind = filters.kind;
    if (filters.topic_key) where.topic_key = filters.topic_key;
    const models = await FeishuNotificationOutbox.findAll({
      where,
      order: [['id', 'DESC']],
      limit: Math.max(1, Math.min(200, Number(filters.limit) || 50)),
    });
    return models.map(toOutboxRow);
  }

  async getHealth(now: Date, stale_before: Date): Promise<FeishuNotificationHealth> {
    const [grouped, due, latest, oldestDue] = await Promise.all([
      FeishuNotificationOutbox.findAll({
        attributes: ['status', [fn('COUNT', col('id')), 'count']],
        group: ['status'],
        raw: true,
      }) as unknown as Promise<Array<{ status: FeishuOutboxStatus; count: string | number }>>,
      FeishuNotificationOutbox.count({
        where: {
          [Op.or]: [
            { status: { [Op.in]: ['pending', 'retry'] }, next_attempt_at: { [Op.lte]: now } },
            { status: 'sending', locked_at: { [Op.lte]: stale_before } },
          ],
        },
      }),
      FeishuNotificationOutbox.findOne({ order: [['id', 'DESC']] }),
      FeishuNotificationOutbox.findOne({
        where: { status: { [Op.in]: ['pending', 'retry', 'sending'] } },
        order: [['next_attempt_at', 'ASC']],
      }),
    ]);
    const counts = emptyStatusCounts();
    for (const row of grouped) {
      if (OUTBOX_STATUSES.includes(row.status)) counts[row.status] = Number(row.count) || 0;
    }
    const backlog = counts.pending + counts.retry + counts.sending;
    const dead = counts.dead;
    return {
      status: dead > 0 ? 'critical' : backlog > 0 ? 'degraded' : 'healthy',
      counts,
      backlog,
      due: Number(due) || 0,
      dead,
      oldest_due_at: oldestDue?.next_attempt_at
        ? new Date(oldestDue.next_attempt_at).toISOString()
        : null,
      latest: latest ? toOutboxRow(latest) : null,
    };
  }

  async requeueTerminal(id: number, now: Date): Promise<boolean> {
    const [updated] = await FeishuNotificationOutbox.update(
      {
        status: 'retry',
        attempts: 0,
        next_attempt_at: now,
        locked_at: null,
        dead_at: null,
      },
      { where: { id, status: { [Op.in]: ['dead', 'suppressed'] } } }
    );
    return updated === 1;
  }
}

export async function resolveProductionFeishuTarget(
  row: FeishuOutboxRow
): Promise<{ url?: string; suppressed?: boolean; reason?: string }> {
  if (String(process.env.DISABLE_FEISHU_BOT_WEBHOOK || '').toLowerCase() === 'true') {
    return { suppressed: true, reason: 'DISABLE_FEISHU_BOT_WEBHOOK=true' };
  }

  if (row.audience === 'ops') {
    const url = String(process.env.OPS_ALERT_FEISHU_WEBHOOK || '').trim();
    return url ? { url } : { reason: 'OPS_ALERT_FEISHU_WEBHOOK 未配置' };
  }
  if (row.audience === 'live') {
    const url = String(process.env.LIVE_ALERT_FEISHU_WEBHOOK || '').trim();
    return url ? { url } : { reason: 'LIVE_ALERT_FEISHU_WEBHOOK 未配置' };
  }
  if (row.audience === 'business') {
    const url = String(
      process.env.FEISHU_RECOMMENDATION_BOT_WEBHOOK || process.env.FEISHU_BOT_WEBHOOK || ''
    ).trim();
    return url ? { url } : { reason: '业务飞书 webhook 未配置' };
  }

  if (!row.recipient_user_id) return { reason: 'user audience 缺少 recipient_user_id' };
  const user = await User.findByPk(row.recipient_user_id, {
    attributes: ['risk_config'],
    raw: true,
  });
  if (!user) return { suppressed: true, reason: '目标用户不存在' };
  const feishu = (user as any)?.risk_config?.notification_channels?.feishu || {};
  if (feishu.enabled === false) return { suppressed: true, reason: '用户已关闭飞书通道' };
  const userUrl = String(feishu.webhook_url || '').trim();
  if (userUrl) return { url: userUrl };
  const fallback = String(
    process.env.FEISHU_RECOMMENDATION_BOT_WEBHOOK || process.env.FEISHU_BOT_WEBHOOK || ''
  ).trim();
  return fallback ? { url: fallback } : { reason: '用户与业务飞书 webhook 均未配置' };
}

export async function sendProductionFeishuWebhook(
  url: string,
  payload: Record<string, unknown>
): Promise<{ success: boolean; status_code?: number; message?: string; data?: any }> {
  try {
    assertWebhookUrlAllowed(url, 'feishu notification outbox');
    const response = await axios.post(url, payload, {
      timeout: Number(process.env.FEISHU_BOT_WEBHOOK_TIMEOUT_MS || 10_000),
      maxRedirects: 0,
      validateStatus: status => status >= 200 && status < 300,
    });
    const body = response.data || {};
    const code = extractFeishuResponseCode(body);
    if (code !== 0) {
      return {
        success: false,
        status_code: response.status,
        message: body.msg || body.message || body.StatusMessage || `飞书返回 code=${code}`,
        data: body,
      };
    }
    return { success: true, status_code: response.status, data: body };
  } catch (error: any) {
    return {
      success: false,
      status_code: Number.isFinite(error?.response?.status)
        ? Number(error.response.status)
        : undefined,
      message: error?.response?.data?.msg || error?.message || String(error),
      data: error?.response?.data,
    };
  }
}

export class FeishuNotificationService {
  constructor(
    private readonly repository: FeishuNotificationRepository = new SequelizeFeishuNotificationRepository(),
    private readonly resolveTarget: FeishuTargetResolver = resolveProductionFeishuTarget,
    private readonly sendWebhook: FeishuWebhookSender = sendProductionFeishuWebhook,
    private readonly now: () => Date = () => new Date()
  ) {}

  async enqueueAndDeliver(input: EnqueueFeishuNotificationInput): Promise<FeishuDeliveryResult> {
    const now = this.now();
    const { row, created } = await this.repository.findOrCreate(input, now);
    if (!created) {
      if (row.status === 'sent' || row.status === 'suppressed' || row.status === 'dead') {
        return {
          success: row.status === 'sent',
          skipped: row.status !== 'sent',
          deduped: true,
          status: row.status,
          outbox_id: row.id,
          attempts: row.attempts,
          message: `幂等命中已有 ${row.status} 通知`,
          data: row.response,
        };
      }
      return {
        success: false,
        skipped: true,
        deduped: true,
        status: row.status,
        outbox_id: row.id,
        attempts: row.attempts,
        message: '幂等命中已有待投递通知，由 outbox worker 继续处理',
      };
    }
    return this.deliver(row.id);
  }

  async deliver(id: number): Promise<FeishuDeliveryResult> {
    const now = this.now();
    const staleBefore = new Date(now.getTime() - LOCK_TIMEOUT_MS);
    const claimed = await this.repository.claim(id, now, staleBefore);
    if (!claimed) {
      const current = await this.repository.findById(id);
      return {
        success: current?.status === 'sent',
        skipped: true,
        status: current?.status || 'retry',
        outbox_id: id,
        attempts: current?.attempts || 0,
        message: '通知未到重试时间、已被其他 worker 领取或已经完成',
      };
    }

    const row = await this.repository.findById(id);
    if (!row) {
      return {
        success: false,
        status: 'dead',
        outbox_id: id,
        attempts: 0,
        message: 'outbox 行不存在',
      };
    }

    let target: Awaited<ReturnType<FeishuTargetResolver>>;
    try {
      target = await this.resolveTarget(row);
    } catch (error: any) {
      return this.recordFailure(row, `解析飞书目标失败: ${error?.message || error}`);
    }

    if (target.suppressed) {
      await this.repository.update(row.id, {
        status: 'suppressed',
        locked_at: null,
        last_error: target.reason || '通知被配置抑制',
      });
      return {
        success: false,
        skipped: true,
        status: 'suppressed',
        outbox_id: row.id,
        attempts: row.attempts,
        message: target.reason,
      };
    }
    if (!target.url) return this.recordFailure(row, target.reason || '飞书 webhook 未配置');

    const result = await this.sendWebhook(target.url, row.payload);
    if (result.success) {
      await this.repository.update(row.id, {
        status: 'sent',
        attempts: row.attempts + 1,
        locked_at: null,
        sent_at: now,
        last_error: null,
        last_status_code: result.status_code ?? null,
        response: sanitizeResponse(result.data),
      });
      return {
        success: true,
        status: 'sent',
        outbox_id: row.id,
        attempts: row.attempts + 1,
        data: sanitizeResponse(result.data),
      };
    }
    return this.recordFailure(row, result.message || '飞书投递失败', result.status_code);
  }

  async dispatchPending(limit = 50): Promise<FeishuNotificationDispatchSummary> {
    const now = this.now();
    const rows = await this.repository.loadDue(
      now,
      new Date(now.getTime() - LOCK_TIMEOUT_MS),
      limit
    );
    const summary: FeishuNotificationDispatchSummary = {
      scanned: rows.length,
      sent: 0,
      retry: 0,
      dead: 0,
      suppressed: 0,
      skipped: 0,
    };
    for (const row of rows) {
      const result = await this.deliver(row.id);
      if (result.status === 'sent') summary.sent += 1;
      else if (result.status === 'retry') summary.retry += 1;
      else if (result.status === 'dead') summary.dead += 1;
      else if (result.status === 'suppressed') summary.suppressed += 1;
      else summary.skipped += 1;
    }
    return summary;
  }

  async listDeliveries(filters: FeishuNotificationListFilters = {}): Promise<FeishuOutboxRow[]> {
    return this.repository.list(filters);
  }

  async getHealth(): Promise<FeishuNotificationHealth> {
    const now = this.now();
    return this.repository.getHealth(now, new Date(now.getTime() - LOCK_TIMEOUT_MS));
  }

  /**
   * 管理员修复配置后手动重投 dead/suppressed 行。状态重置与领取均为条件更新，
   * 多个管理员同时点击也只会由一个 worker 真正发送。
   */
  async retryTerminal(id: number): Promise<FeishuDeliveryResult> {
    if (!Number.isInteger(id) || id <= 0) throw new Error('无效的通知 outbox_id');
    const requeued = await this.repository.requeueTerminal(id, this.now());
    if (!requeued) {
      const current = await this.repository.findById(id);
      if (!current) throw new Error(`通知 outbox_id=${id} 不存在`);
      return {
        success: current.status === 'sent',
        skipped: true,
        status: current.status,
        outbox_id: current.id,
        attempts: current.attempts,
        message: `仅 dead/suppressed 通知可手动重投，当前状态为 ${current.status}`,
      };
    }
    return this.deliver(id);
  }

  private async recordFailure(
    row: FeishuOutboxRow,
    message: string,
    statusCode?: number
  ): Promise<FeishuDeliveryResult> {
    const now = this.now();
    const attempts = row.attempts + 1;
    const dead = attempts >= row.max_attempts;
    const status: FeishuOutboxStatus = dead ? 'dead' : 'retry';
    await this.repository.update(row.id, {
      status,
      attempts,
      locked_at: null,
      next_attempt_at: dead
        ? row.next_attempt_at
        : new Date(now.getTime() + computeFeishuRetryDelayMs(attempts)),
      dead_at: dead ? now : null,
      last_error: message.slice(0, 4000),
      last_status_code: statusCode ?? null,
    });
    logger.warn(
      `[FeishuOutbox] delivery ${status} id=${row.id} kind=${row.kind} attempts=${attempts}/${row.max_attempts}: ${message}`
    );
    return {
      success: false,
      status,
      outbox_id: row.id,
      attempts,
      message,
    };
  }
}

function sanitizeResponse(value: any): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {};
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return {};
  }
}

function emptyStatusCounts(): Record<FeishuOutboxStatus, number> {
  return {
    pending: 0,
    sending: 0,
    retry: 0,
    sent: 0,
    dead: 0,
    suppressed: 0,
  };
}

function toOutboxRow(model: FeishuNotificationOutbox): FeishuOutboxRow {
  return {
    id: Number(model.id),
    idempotency_key: model.idempotency_key,
    topic_key: model.topic_key,
    audience: model.audience as FeishuAudience,
    recipient_user_id: model.recipient_user_id == null ? null : Number(model.recipient_user_id),
    kind: model.kind,
    severity: model.severity,
    title: model.title,
    payload: model.payload || {},
    status: model.status,
    attempts: Number(model.attempts) || 0,
    max_attempts: Number(model.max_attempts) || DEFAULT_MAX_ATTEMPTS,
    next_attempt_at: new Date(model.next_attempt_at),
    locked_at: model.locked_at ? new Date(model.locked_at) : null,
    sent_at: model.sent_at ? new Date(model.sent_at) : null,
    dead_at: model.dead_at ? new Date(model.dead_at) : null,
    last_error: model.last_error || null,
    last_status_code: model.last_status_code == null ? null : Number(model.last_status_code),
    response: model.response || {},
    correlation_id: model.correlation_id || null,
    metadata: model.metadata || {},
  };
}

export const feishuNotificationService = new FeishuNotificationService();
