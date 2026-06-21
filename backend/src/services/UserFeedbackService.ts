/**
 * UserFeedbackService — Batch AL (2026-06-21) — SystemWorkspace 用户反馈闭环.
 *
 * 接口:
 *   - listForUser(userId, {status?, limit?})  — 列出当前 user 自己的反馈, status 可选过滤,
 *                                                limit 1..200 (默认 50), 按 created_at DESC
 *   - createForUser(userId, payload)          — 提交一条反馈 (title / description / image_urls /
 *                                                metadata); image_urls 必须是相对路径数组
 *   - resolveById(id, resolverUserId, {note, commitHash?, prNumber?}, opts) — admin 解决:
 *                                                status='resolved' + resolution_note + 关联
 *                                                commit/PR. resolverUserId 必须 role='admin'
 *                                                (透传 isAdmin flag 即可, 也支持显式 throw 405)
 *   - runReviewSweep({nowMs?, limit?, ageHours?, classifyFn?, dataSource?}) — cron 入口:
 *                                                拉 status='pending' AND (reviewed_at IS NULL OR
 *                                                reviewed_at < now-ageHours), 跑分类器, upsert
 *                                                ai_classification / ai_priority / ai_summary /
 *                                                reviewed_at; 永不抛, 返 summary
 *
 * 启发式分类器 (default classifier, pure 函数 + 单测):
 *   - 命中 "bug / 报错 / 闪退 / 崩溃 / 404 / 500 / error / fail / 失败 / 不能" → bug, priority 4
 *   - 命中 "希望 / 建议 / 能不能 / 增加 / 期待 / 想要 / 如果" → feature_request, priority 3
 *   - 命中 "怎么 / 如何 / 是什么 / 在哪 / 为什么" + 末尾问号 → question, priority 2
 *   - 命中 "好评 / 赞 / 满意 / 喜欢 / 太棒 / 不错 / 感谢 / nice" → praise, priority 1
 *   - 其它 → other, priority 2
 *   - ai_summary = title 截断 80 + " · " + description 首句截断 120 (合计 ≤ 200)
 *
 * 设计原则 (与 ImprovementSuggestionService 一致):
 *   - service 全 fail-OPEN: list / create / resolve 失败抛错 (controller 转 4xx/5xx),
 *     runReviewSweep 单条失败 continue 不抛
 *   - resolve 只允许 admin: 调用方传 isAdmin: false → 抛 'forbidden' 错 (controller 转 403)
 *   - 真自动解决留给人 — runReviewSweep 永不写 status='resolved' / 'dismissed'
 *
 * 与 model UserFeedback 的边界:
 *   - service 内不做 ORM 联表 (user 名查询走 controller / route)
 *   - service 内不做参数 trimming / xss escape — 留给 controller 验证层
 */

import { Op } from 'sequelize';
import { UserFeedback } from '../models/UserFeedback';
import { logger } from '../utils/logger';

export type FeedbackStatus = 'pending' | 'in_progress' | 'resolved' | 'dismissed';
export type FeedbackClassification = 'bug' | 'feature_request' | 'question' | 'praise' | 'other';

export const FEEDBACK_STATUS = Object.freeze({
  PENDING: 'pending' as const,
  IN_PROGRESS: 'in_progress' as const,
  RESOLVED: 'resolved' as const,
  DISMISSED: 'dismissed' as const,
});

export const FEEDBACK_CLASSIFICATION = Object.freeze({
  BUG: 'bug' as const,
  FEATURE_REQUEST: 'feature_request' as const,
  QUESTION: 'question' as const,
  PRAISE: 'praise' as const,
  OTHER: 'other' as const,
});

export interface CreateFeedbackPayload {
  title: string;
  description: string;
  image_urls?: string[];
  metadata?: Record<string, unknown>;
}

export interface ResolveFeedbackPayload {
  resolution_note: string;
  resolution_commit_hash?: string | null;
  resolution_pr_number?: number | null;
  status?: 'resolved' | 'dismissed';
}

export interface ResolveFeedbackOpts {
  /** caller 必须显式传 true 才能 resolve; false / undefined → forbidden 错 */
  isAdmin: boolean;
}

export interface ClassifyResult {
  ai_classification: FeedbackClassification;
  ai_priority: number;
  ai_summary: string;
}

/**
 * 纯函数: 启发式分类器. 单独 export 给单测.
 *
 * 规则按优先级 (匹配第一个命中):
 *   bug > question > feature_request > praise > other
 *
 * priority 给整数 1..5 (5 最高).
 */
export function classifyFeedbackHeuristic(input: {
  title: string;
  description: string;
}): ClassifyResult {
  const text = `${input.title || ''}\n${input.description || ''}`.toLowerCase();

  const has = (kws: string[]) => kws.some(k => text.includes(k));

  // bug 关键词 (含中英文)
  if (
    has([
      'bug',
      '报错',
      '闪退',
      '崩溃',
      'crash',
      'error',
      'fail',
      '失败',
      '不能',
      '无法',
      '打不开',
      '404',
      '500',
      'exception',
      '异常',
      '卡死',
    ])
  ) {
    return {
      ai_classification: FEEDBACK_CLASSIFICATION.BUG,
      ai_priority: 4,
      ai_summary: buildSummary(input),
    };
  }

  // praise 关键词 (放在 question 之前, 因 "感谢" 可能含问号 "感谢?" 不算 question)
  if (
    has([
      '好评',
      '点赞',
      '满意',
      '喜欢',
      '太棒',
      '不错',
      '感谢',
      '谢谢',
      'thanks',
      'thank you',
      'nice',
      'great',
      '牛',
      '厉害',
      '666',
    ])
  ) {
    return {
      ai_classification: FEEDBACK_CLASSIFICATION.PRAISE,
      ai_priority: 1,
      ai_summary: buildSummary(input),
    };
  }

  // feature_request 关键词
  if (
    has([
      '希望',
      '建议',
      '能不能',
      '可不可以',
      '增加',
      '期待',
      '想要',
      '如果',
      '请加',
      '请增加',
      'feature',
      'request',
      'add',
    ])
  ) {
    return {
      ai_classification: FEEDBACK_CLASSIFICATION.FEATURE_REQUEST,
      ai_priority: 3,
      ai_summary: buildSummary(input),
    };
  }

  // question — 含疑问词或末尾问号
  const isQuestion =
    has(['怎么', '如何', '是什么', '在哪', '为什么', '怎样', 'why', 'how', 'what']) ||
    /[?？]\s*$/.test(input.title || '') ||
    /[?？]\s*$/.test(input.description || '');
  if (isQuestion) {
    return {
      ai_classification: FEEDBACK_CLASSIFICATION.QUESTION,
      ai_priority: 2,
      ai_summary: buildSummary(input),
    };
  }

  return {
    ai_classification: FEEDBACK_CLASSIFICATION.OTHER,
    ai_priority: 2,
    ai_summary: buildSummary(input),
  };
}

/** 纯函数: 摘要 = title 截 80 + " · " + 描述首句截 120 (合计 ≤ 200) */
export function buildSummary(input: { title: string; description: string }): string {
  const t = String(input.title || '')
    .trim()
    .slice(0, 80);
  const d = String(input.description || '')
    .trim()
    .split(/[。．\.!?！？\n]/)[0]
    .slice(0, 120);
  const joined = `${t}${t && d ? ' · ' : ''}${d}`;
  return joined.slice(0, 200);
}

export interface ListFeedbacksOpts {
  status?: FeedbackStatus | 'all' | null;
  limit?: number;
}

export class UserFeedbackService {
  async listForUser(userId: number, opts: ListFeedbacksOpts = {}) {
    if (!Number.isInteger(userId) || userId <= 0) {
      throw new Error('invalid_user_id');
    }
    const limit = Math.max(1, Math.min(200, Number(opts.limit) || 50));
    const where: Record<string, unknown> = { user_id: userId };
    if (opts.status && opts.status !== 'all') {
      where.status = opts.status;
    }
    const rows = await UserFeedback.findAll({
      where,
      order: [['created_at', 'DESC']],
      limit,
    });
    return rows.map(r => r.toJSON());
  }

  async createForUser(userId: number, payload: CreateFeedbackPayload) {
    if (!Number.isInteger(userId) || userId <= 0) {
      throw new Error('invalid_user_id');
    }
    const title = String(payload.title || '').trim();
    const description = String(payload.description || '').trim();
    if (!title || title.length > 200) {
      throw new Error('invalid_title');
    }
    if (!description) {
      throw new Error('invalid_description');
    }
    const image_urls = Array.isArray(payload.image_urls)
      ? payload.image_urls.filter(u => typeof u === 'string' && u.length > 0).slice(0, 20)
      : [];
    const metadata =
      payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
        ? payload.metadata
        : {};
    const row = await UserFeedback.create({
      user_id: userId,
      title,
      description,
      image_urls,
      metadata,
      status: FEEDBACK_STATUS.PENDING,
    });
    return row.toJSON();
  }

  async resolveById(
    id: number,
    _resolverUserId: number,
    payload: ResolveFeedbackPayload,
    opts: ResolveFeedbackOpts
  ) {
    if (!opts || opts.isAdmin !== true) {
      const err = new Error('forbidden_admin_only');
      (err as any).code = 'FORBIDDEN';
      throw err;
    }
    if (!Number.isInteger(id) || id <= 0) {
      const err = new Error('invalid_id');
      (err as any).code = 'BAD_REQUEST';
      throw err;
    }
    const note = String(payload.resolution_note || '').trim();
    if (!note) {
      const err = new Error('resolution_note_required');
      (err as any).code = 'BAD_REQUEST';
      throw err;
    }
    const targetStatus: FeedbackStatus =
      payload.status === 'dismissed' ? FEEDBACK_STATUS.DISMISSED : FEEDBACK_STATUS.RESOLVED;
    const row = await UserFeedback.findByPk(id);
    if (!row) {
      const err = new Error('not_found');
      (err as any).code = 'NOT_FOUND';
      throw err;
    }
    if (row.status === FEEDBACK_STATUS.RESOLVED || row.status === FEEDBACK_STATUS.DISMISSED) {
      const err = new Error('already_resolved');
      (err as any).code = 'CONFLICT';
      throw err;
    }
    row.status = targetStatus;
    row.resolution_note = note.slice(0, 4000);
    row.resolution_commit_hash =
      payload.resolution_commit_hash &&
      typeof payload.resolution_commit_hash === 'string' &&
      payload.resolution_commit_hash.length > 0
        ? payload.resolution_commit_hash.slice(0, 40)
        : null;
    row.resolution_pr_number =
      Number.isFinite(Number(payload.resolution_pr_number)) &&
      Number(payload.resolution_pr_number) > 0
        ? Math.trunc(Number(payload.resolution_pr_number))
        : null;
    row.resolved_at = new Date();
    await row.save();
    return row.toJSON();
  }

  /**
   * FEEDBACK_REVIEW_SWEEP cron 入口.
   *
   * fail-OPEN 两层:
   *   - 整体 try/catch — 任何 DB 异常返 {error}
   *   - 单条 row try/catch — 单 row 失败 continue 不抛
   */
  async runReviewSweep(
    opts: {
      nowMs?: number;
      limit?: number;
      ageHours?: number;
      classifyFn?: (input: { title: string; description: string }) => ClassifyResult;
    } = {}
  ): Promise<{
    scanned: number;
    updated: number;
    failed: number;
    error?: string;
    per_classification: Record<string, number>;
  }> {
    const summary = {
      scanned: 0,
      updated: 0,
      failed: 0,
      per_classification: {} as Record<string, number>,
    };
    const now = opts.nowMs ? new Date(opts.nowMs) : new Date();
    const ageHours = Number.isFinite(opts.ageHours) ? Math.max(0, Number(opts.ageHours)) : 6;
    const limit = Math.max(1, Math.min(1000, Number(opts.limit) || 200));
    const classifyFn = opts.classifyFn || classifyFeedbackHeuristic;
    const cutoff = new Date(now.getTime() - ageHours * 3600 * 1000);

    let rows: UserFeedback[];
    try {
      rows = await UserFeedback.findAll({
        where: {
          status: FEEDBACK_STATUS.PENDING,
          [Op.or]: [{ reviewed_at: null }, { reviewed_at: { [Op.lt]: cutoff } }],
        },
        order: [['created_at', 'ASC']],
        limit,
      });
    } catch (err: any) {
      return { ...summary, error: `find_failed: ${err?.message || String(err)}` };
    }
    summary.scanned = rows.length;
    for (const row of rows) {
      try {
        const r = classifyFn({ title: row.title, description: row.description });
        row.ai_classification = r.ai_classification;
        row.ai_priority = Math.max(1, Math.min(5, Math.trunc(r.ai_priority)));
        row.ai_summary = (r.ai_summary || '').slice(0, 200);
        row.reviewed_at = now;
        await row.save();
        summary.updated += 1;
        summary.per_classification[r.ai_classification] =
          (summary.per_classification[r.ai_classification] || 0) + 1;
      } catch (err: any) {
        summary.failed += 1;
        logger.warn(`[FEEDBACK_REVIEW_SWEEP] row=${row.id} failed: ${err?.message || String(err)}`);
      }
    }
    return summary;
  }
}

export const userFeedbackService = new UserFeedbackService();

// 给 SchedulerService cron dispatcher 使用 — 单 fn 入口, 不暴露 DataSource 给 cron
export const PRODUCTION_USER_FEEDBACK_REVIEW_SWEEP = async (opts: {
  nowMs?: number;
  limit?: number;
  ageHours?: number;
}) => {
  return userFeedbackService.runReviewSweep(opts);
};
