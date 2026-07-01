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

  getFile: async (path: string): Promise<{ success: boolean; data: DocsFileContent }> => {
    const response = await api.get('/docs/file', { params: { path } });
    return response.data;
  },
};
