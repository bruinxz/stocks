import { Request, Response } from 'express';
import { DocumentComment } from '../../models/DocumentComment';
import { User } from '../../models/User';

/**
 * DocumentCommentsController — 文档评论 API (飞书式)
 *
 * 权限模型:
 *   - 所有 endpoints 都需 auth
 *   - list / create: 任何 authenticated 用户
 *   - update / delete: 只能操作自己的评论 (作者本人), 或 admin
 *   - resolve: 任何 authenticated 用户 (对根评论标记 resolved)
 *
 * Thread 语义:
 *   - 根评论 parent_id=null, thread_root_id=self.id
 *   - 回复评论 parent_id=某评论.id, thread_root_id=该评论所在 thread 的 root
 *   - resolve 状态只在**根评论**上有意义, 回复的 status 字段可忽略
 */
export class DocumentCommentsController {
  /**
   * GET /api/docs/comments?path=xxx.md&include_resolved=false
   * 返回该文档所有评论 (按 thread 组织)
   */
  list = async (req: Request, res: Response): Promise<void> => {
    try {
      const docPath = (req.query.path as string) || '';
      const includeResolved = req.query.include_resolved === 'true';

      if (!docPath) {
        res.status(400).json({ success: false, message: 'path 参数必填' });
        return;
      }

      const where: any = { doc_path: docPath };
      if (!includeResolved) {
        // 不含 resolved thread 时, 只查 status='open' 或非根评论 (thread 里的回复)
        // 但简单起见, 先都返回, 前端按 status 分层显示
      }

      const rows = await DocumentComment.findAll({
        where,
        include: [
          {
            model: User,
            as: 'user',
            attributes: ['id', 'username', 'nickname', 'role'],
          },
        ],
        order: [['created_at', 'ASC']],
      });

      // 组织成 thread 结构: 按 thread_root_id 分组
      const threadMap = new Map<number, any>();
      rows.forEach((r: any) => {
        const rootId = r.thread_root_id;
        if (!threadMap.has(rootId)) {
          threadMap.set(rootId, { root: null, replies: [] });
        }
        const bucket = threadMap.get(rootId)!;
        if (r.id === rootId) {
          bucket.root = r;
        } else {
          bucket.replies.push(r);
        }
      });

      // 输出: 数组, 每个元素 = { root, replies[] }
      // 过滤: 若 !includeResolved, 去掉 root.status='resolved' 的 thread
      let threads = Array.from(threadMap.values()).filter((t: any) => t.root !== null);
      if (!includeResolved) {
        threads = threads.filter((t: any) => t.root.status !== 'resolved');
      }
      // 按根 created_at DESC 排 (新评论在上)
      threads.sort((a: any, b: any) => {
        return new Date(b.root.created_at).getTime() - new Date(a.root.created_at).getTime();
      });

      res.json({ success: true, data: { threads, total: threads.length } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, message: `查询评论失败: ${msg}` });
    }
  };

  /**
   * POST /api/docs/comments
   * body: { doc_path, anchor_type, anchor_key, anchor_snippet?, content, parent_id? }
   */
  create = async (req: Request, res: Response): Promise<void> => {
    try {
      const user = (req as any).user;
      if (!user) {
        res.status(401).json({ success: false, message: '未认证' });
        return;
      }
      const userId = user.id;

      const {
        doc_path,
        anchor_type,
        anchor_key,
        anchor_snippet,
        content,
        parent_id,
      } = req.body || {};

      if (!doc_path || !anchor_type || !anchor_key || !content) {
        res.status(400).json({
          success: false,
          message: '缺失必填字段: doc_path / anchor_type / anchor_key / content',
        });
        return;
      }

      if (!['heading', 'line', 'paragraph', 'doc'].includes(anchor_type)) {
        res.status(400).json({ success: false, message: 'anchor_type 非法' });
        return;
      }

      if (typeof content !== 'string' || content.trim().length === 0) {
        res.status(400).json({ success: false, message: 'content 不能为空' });
        return;
      }

      if (content.length > 10000) {
        res.status(400).json({ success: false, message: 'content 过长 (max 10000)' });
        return;
      }

      // 处理 thread_root_id
      let threadRootId: number;
      if (parent_id) {
        const parent = await DocumentComment.findByPk(parent_id);
        if (!parent) {
          res.status(400).json({ success: false, message: '父评论不存在' });
          return;
        }
        threadRootId = parent.thread_root_id;
      } else {
        threadRootId = 0; // 占位, 创建后立即更新为自己 id
      }

      // 判断 author_kind: 依据 user 表 role 是否 = 'ai', 或者 header 显式声明
      const explicitAuthorKind = req.body?.author_kind;
      let authorKind: 'human' | 'ai' = 'human';
      if (explicitAuthorKind === 'ai') {
        authorKind = 'ai';
      }

      const comment = await DocumentComment.create({
        doc_path,
        anchor_type,
        anchor_key,
        anchor_snippet: anchor_snippet || null,
        parent_id: parent_id || null,
        thread_root_id: threadRootId,
        user_id: userId,
        content: content.trim(),
        status: 'open',
        author_kind: authorKind,
      });

      // 如果是根评论, 更新 thread_root_id = 自己 id
      if (!parent_id) {
        await comment.update({ thread_root_id: comment.id });
      }

      // 返回时 include user
      const withUser = await DocumentComment.findByPk(comment.id, {
        include: [{ model: User, as: 'user', attributes: ['id', 'username', 'nickname', 'role'] }],
      });

      res.json({ success: true, data: withUser });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, message: `创建评论失败: ${msg}` });
    }
  };

  /**
   * PATCH /api/docs/comments/:id
   * body: { content?, status? }
   *   - content: 编辑评论内容 (只允许作者本人)
   *   - status: 'open' | 'resolved' (只对根评论有效, 任何 authenticated 用户可 resolve)
   */
  update = async (req: Request, res: Response): Promise<void> => {
    try {
      const user = (req as any).user;
      if (!user) {
        res.status(401).json({ success: false, message: '未认证' });
        return;
      }
      const userId = user.id;
      const userRole = user.role;
      const id = parseInt(req.params.id, 10);
      const { content, status } = req.body || {};

      const comment = await DocumentComment.findByPk(id);
      if (!comment) {
        res.status(404).json({ success: false, message: '评论不存在' });
        return;
      }

      const isAuthor = comment.user_id === userId;
      const isAdmin = userRole === 'admin';

      const updates: any = {};

      if (content !== undefined) {
        if (!isAuthor && !isAdmin) {
          res.status(403).json({ success: false, message: '只有作者本人或 admin 才能编辑内容' });
          return;
        }
        if (typeof content !== 'string' || content.trim().length === 0) {
          res.status(400).json({ success: false, message: 'content 不能为空' });
          return;
        }
        updates.content = content.trim();
      }

      if (status !== undefined) {
        if (!['open', 'resolved'].includes(status)) {
          res.status(400).json({ success: false, message: 'status 非法' });
          return;
        }
        // status 只对根评论有意义
        if (comment.parent_id !== null) {
          res.status(400).json({ success: false, message: 'status 只能对根评论修改' });
          return;
        }
        updates.status = status;
        if (status === 'resolved') {
          updates.resolved_by = userId;
          updates.resolved_at = new Date();
        } else {
          updates.resolved_by = null;
          updates.resolved_at = null;
        }
      }

      await comment.update(updates);

      const withUser = await DocumentComment.findByPk(comment.id, {
        include: [{ model: User, as: 'user', attributes: ['id', 'username', 'nickname', 'role'] }],
      });

      res.json({ success: true, data: withUser });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, message: `更新评论失败: ${msg}` });
    }
  };

  /**
   * DELETE /api/docs/comments/:id
   * 软删除 (paranoid). 只允许作者本人或 admin.
   * 若删除的是根评论, 整个 thread (含 replies) 一起软删.
   */
  destroy = async (req: Request, res: Response): Promise<void> => {
    try {
      const user = (req as any).user;
      if (!user) {
        res.status(401).json({ success: false, message: '未认证' });
        return;
      }
      const userId = user.id;
      const userRole = user.role;
      const id = parseInt(req.params.id, 10);

      const comment = await DocumentComment.findByPk(id);
      if (!comment) {
        res.status(404).json({ success: false, message: '评论不存在' });
        return;
      }

      const isAuthor = comment.user_id === userId;
      const isAdmin = userRole === 'admin';
      if (!isAuthor && !isAdmin) {
        res.status(403).json({ success: false, message: '只有作者本人或 admin 才能删除' });
        return;
      }

      // 若是根评论, 删整个 thread
      if (comment.parent_id === null) {
        await DocumentComment.destroy({ where: { thread_root_id: comment.thread_root_id } });
      } else {
        await comment.destroy();
      }

      res.json({ success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, message: `删除评论失败: ${msg}` });
    }
  };

  /**
   * GET /api/docs/comments/stats
   * 返回所有文档评论数量汇总, 用于左侧 tree 显示"该文档有 N 条评论"标记
   */
  stats = async (_req: Request, res: Response): Promise<void> => {
    try {
      const rows = await DocumentComment.findAll({
        attributes: [
          'doc_path',
          'status',
          [DocumentComment.sequelize!.fn('COUNT', DocumentComment.sequelize!.col('id')), 'count'],
        ],
        where: { parent_id: null },  // 只统计根评论 (thread 数)
        group: ['doc_path', 'status'],
        raw: true,
      });

      // 归并: { doc_path: { open: N, resolved: M } }
      const stats: Record<string, { open: number; resolved: number }> = {};
      for (const r of rows as any[]) {
        const path = r.doc_path;
        const status = r.status;
        const count = parseInt(r.count, 10);
        if (!stats[path]) stats[path] = { open: 0, resolved: 0 };
        stats[path][status as 'open' | 'resolved'] = count;
      }

      res.json({ success: true, data: stats });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, message: `查询评论统计失败: ${msg}` });
    }
  };
}
