/**
 * UserFeedbackController — Batch AL (2026-06-21) — SystemWorkspace 用户反馈闭环 routes.
 *
 * 路由 (前端):
 *   - GET  /api/me/feedbacks?status=&limit=          列出当前 user 自己的反馈
 *   - POST /api/me/feedbacks                          创建反馈 (multipart/form-data 含图片)
 *
 * 路由 (管理):
 *   - POST /api/admin/feedbacks/:id/resolve           admin 标记 status='resolved' + 写解决说明
 *
 * 错误码:
 *   - 400: 参数非法 (无 title / 无 description / id 非整数 / 无 resolution_note)
 *   - 401: 未鉴权 (AuthController.authenticate 守)
 *   - 403: 非 admin 调 resolve
 *   - 404: id 不存在
 *   - 409: 已 resolved / dismissed 二次 resolve
 *   - 500: 兜底
 */

import { Request, Response, NextFunction } from 'express';
import path from 'path';
import { userFeedbackService } from '../../services/UserFeedbackService';
import { logger } from '../../utils/logger';

function parseId(raw: unknown): number | null {
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

/**
 * 把 multer 落盘后的 file 列表转成对外可访问的相对 URL.
 * 形如 `/uploads/feedback/<userId>/<filename>`.
 *
 * Express index.ts 已 `app.use('/uploads', express.static(getUploadsRoot()))`,
 * 我们 destination 用 `<uploadsRoot>/feedback/<userId>/`, 因此 URL = `/uploads/feedback/<uid>/<fn>`.
 */
export function buildFeedbackImageUrls(
  files: Express.Multer.File[] | undefined,
  userId: number
): string[] {
  if (!Array.isArray(files) || files.length === 0) return [];
  return files.map(f => {
    // multer disk storage 的 file.filename 是落盘后的名字
    const fn = path.basename(f.filename || f.originalname || 'unknown');
    return `/uploads/feedback/${userId}/${fn}`;
  });
}

export class UserFeedbackController {
  listMyFeedbacks = async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const user = (req as any).user;
      if (!user || !user.id) return res.status(401).json({ success: false, message: '未登录' });
      const status = (req.query.status as string) || undefined;
      const limit = parseInt(String(req.query.limit || '50'), 10);
      const data = await userFeedbackService.listForUser(user.id, {
        status: (status as any) || undefined,
        limit: Number.isFinite(limit) ? limit : 50,
      });
      return res.json({ success: true, data: { total: data.length, items: data } });
    } catch (err: any) {
      logger.error('listMyFeedbacks failed', err);
      return res.status(500).json({ success: false, message: err?.message || 'internal_error' });
    }
  };

  createMyFeedback = async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const user = (req as any).user;
      if (!user || !user.id) return res.status(401).json({ success: false, message: '未登录' });

      // multer 已把 files 挂到 req.files (array). req.body.title / description 也已解析
      const title = String(req.body.title || '').trim();
      const description = String(req.body.description || '').trim();
      if (!title) return res.status(400).json({ success: false, message: '标题不能为空' });
      if (title.length > 200)
        return res.status(400).json({ success: false, message: '标题不能超过 200 字' });
      if (!description) return res.status(400).json({ success: false, message: '描述不能为空' });

      const files = (req as any).files as Express.Multer.File[] | undefined;
      const image_urls = buildFeedbackImageUrls(files, user.id);

      const row = await userFeedbackService.createForUser(user.id, {
        title,
        description,
        image_urls,
        metadata: {
          user_agent: req.headers['user-agent'] || null,
          ip: req.ip || null,
        },
      });
      return res.json({ success: true, data: row });
    } catch (err: any) {
      logger.error('createMyFeedback failed', err);
      return res.status(500).json({ success: false, message: err?.message || 'internal_error' });
    }
  };

  resolveFeedback = async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const user = (req as any).user;
      if (!user || !user.id) return res.status(401).json({ success: false, message: '未登录' });
      const isAdmin = String(user.role || '') === 'admin';
      if (!isAdmin) return res.status(403).json({ success: false, message: '仅管理员可操作' });

      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ success: false, message: 'id 必须是正整数' });

      const note = String(req.body?.resolution_note || '').trim();
      if (!note)
        return res.status(400).json({ success: false, message: 'resolution_note 不能为空' });
      const commitHash =
        typeof req.body?.resolution_commit_hash === 'string' &&
        req.body.resolution_commit_hash.trim().length > 0
          ? req.body.resolution_commit_hash.trim()
          : null;
      const prNumber = Number(req.body?.resolution_pr_number);
      const status = req.body?.status === 'dismissed' ? 'dismissed' : 'resolved';

      const row = await userFeedbackService.resolveById(
        id,
        user.id,
        {
          resolution_note: note,
          resolution_commit_hash: commitHash,
          resolution_pr_number: Number.isFinite(prNumber) && prNumber > 0 ? prNumber : null,
          status,
        },
        { isAdmin: true }
      );
      return res.json({ success: true, data: row });
    } catch (err: any) {
      const code = err?.code;
      if (code === 'FORBIDDEN')
        return res.status(403).json({ success: false, message: err.message });
      if (code === 'NOT_FOUND')
        return res.status(404).json({ success: false, message: err.message });
      if (code === 'BAD_REQUEST')
        return res.status(400).json({ success: false, message: err.message });
      if (code === 'CONFLICT')
        return res.status(409).json({ success: false, message: err.message });
      logger.error('resolveFeedback failed', err);
      return res.status(500).json({ success: false, message: err?.message || 'internal_error' });
    }
  };
}

export const userFeedbackController = new UserFeedbackController();
