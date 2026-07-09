import api from './api';

export type CommentAuthorKind = 'human' | 'ai';
export type CommentStatus = 'open' | 'resolved';
export type AnchorType = 'heading' | 'line' | 'paragraph' | 'doc';

export interface CommentUser {
  id: number;
  username: string;
  nickname?: string | null;
  role: string;
}

export interface DocComment {
  id: number;
  doc_path: string;
  anchor_type: AnchorType;
  anchor_key: string;
  anchor_snippet: string | null;
  parent_id: number | null;
  thread_root_id: number;
  user_id: number;
  content: string;
  status: CommentStatus;
  resolved_by: number | null;
  resolved_at: string | null;
  author_kind: CommentAuthorKind;
  created_at: string;
  updated_at: string;
  user?: CommentUser;
}

export interface CommentThread {
  root: DocComment;
  replies: DocComment[];
}

export interface CreateCommentInput {
  doc_path: string;
  anchor_type: AnchorType;
  anchor_key: string;
  anchor_snippet?: string;
  content: string;
  parent_id?: number | null;
  author_kind?: CommentAuthorKind;
}

export const docsCommentsService = {
  // v0.5(q): 支持 AbortSignal，用于 useEffect cleanup 时取消陈旧 fetch —
  // React 18 canonical race-guard, 契合 axios 原生 signal 语义。
  list: async (
    docPath: string,
    includeResolved = false,
    config?: { signal?: AbortSignal }
  ): Promise<{ success: boolean; data: { threads: CommentThread[]; total: number } }> => {
    const res = await api.get('/docs/comments', {
      params: { path: docPath, include_resolved: includeResolved },
      signal: config?.signal,
    });
    return res.data;
  },

  stats: async (): Promise<{
    success: boolean;
    data: Record<string, { open: number; resolved: number }>;
  }> => {
    const res = await api.get('/docs/comments/stats');
    return res.data;
  },

  create: async (
    input: CreateCommentInput
  ): Promise<{ success: boolean; data: DocComment }> => {
    const res = await api.post('/docs/comments', input);
    return res.data;
  },

  update: async (
    id: number,
    updates: { content?: string; status?: CommentStatus }
  ): Promise<{ success: boolean; data: DocComment }> => {
    const res = await api.patch(`/docs/comments/${id}`, updates);
    return res.data;
  },

  destroy: async (id: number): Promise<{ success: boolean }> => {
    const res = await api.delete(`/docs/comments/${id}`);
    return res.data;
  },
};
