/**
 * userFeedbackService — Batch AL (2026-06-21) — SystemWorkspace 用户反馈闭环.
 *
 * 包装 /api/me/feedbacks (用户自服务) + /api/admin/feedbacks/:id/resolve (admin).
 *
 * 接口:
 *   - listMyFeedbacks({status?, limit?}) → 反馈列表
 *   - createMyFeedback({title, description, images: File[]}) → 新创建的反馈
 *   - resolveFeedback(id, {note, commitHash?, prNumber?}) → 解决后的反馈 (admin only)
 */

import api from './api';

export type FeedbackStatus = 'pending' | 'in_progress' | 'resolved' | 'dismissed';
export type FeedbackClassification = 'bug' | 'feature_request' | 'question' | 'praise' | 'other';

export interface UserFeedbackRow {
  id: number;
  user_id: number;
  title: string;
  description: string;
  image_urls: string[];
  status: FeedbackStatus;
  resolution_note: string | null;
  resolution_commit_hash: string | null;
  resolution_pr_number: number | null;
  resolved_at: string | null;
  reviewed_at: string | null;
  ai_classification: FeedbackClassification | null;
  ai_priority: number | null;
  ai_summary: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateFeedbackInput {
  title: string;
  description: string;
  images?: File[];
}

export async function listMyFeedbacks(opts: {
  status?: FeedbackStatus | 'all';
  limit?: number;
}): Promise<UserFeedbackRow[]> {
  const res = await api.get('/me/feedbacks', {
    params: {
      status: opts.status,
      limit: opts.limit ?? 50,
    },
  });
  const items = res.data?.data?.items;
  return Array.isArray(items) ? items : [];
}

export async function createMyFeedback(input: CreateFeedbackInput): Promise<UserFeedbackRow> {
  const fd = new FormData();
  fd.append('title', input.title);
  fd.append('description', input.description);
  for (const f of input.images || []) {
    fd.append('images', f);
  }
  const res = await api.post('/me/feedbacks', fd, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return res.data?.data;
}

export async function resolveFeedback(
  id: number,
  input: {
    resolution_note: string;
    resolution_commit_hash?: string;
    resolution_pr_number?: number;
    status?: 'resolved' | 'dismissed';
  }
): Promise<UserFeedbackRow> {
  const res = await api.post(`/admin/feedbacks/${id}/resolve`, input);
  return res.data?.data;
}
