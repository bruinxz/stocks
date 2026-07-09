import api from './api';

export interface DocsTreeNode {
  name: string;
  type: 'dir' | 'file';
  path: string;  // relative path within docs/
  size?: number;
  mtime?: string;
  children?: DocsTreeNode[];
  note?: string;
}

export interface DocsFileContent {
  path: string;
  content: string;
  size: number;
  mtime: string;
}

export const docsService = {
  getTree: async (): Promise<{ success: boolean; data: DocsTreeNode }> => {
    const response = await api.get('/docs/tree');
    return response.data;
  },

  // v0.5(q): 支持 AbortSignal，用于 useEffect cleanup 时取消陈旧 fetch —
  // React 18 canonical race-guard, 契合 axios 原生 signal 语义。
  getFile: async (
    path: string,
    config?: { signal?: AbortSignal }
  ): Promise<{ success: boolean; data: DocsFileContent }> => {
    const response = await api.get('/docs/file', {
      params: { path },
      signal: config?.signal,
    });
    return response.data;
  },
};
