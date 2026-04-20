import api from './api';

export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  raw: string;
}

export interface LogPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface GetLogsResponse {
  success: boolean;
  data: {
    logs: LogEntry[];
    pagination: LogPagination;
  };
  message?: string;
}

export interface GetLogStatsResponse {
  success: boolean;
  data: Record<string, number>;
  message?: string;
}

export interface LogQueryParams {
  page?: number;
  limit?: number;
  level?: string;
  keyword?: string;
  type?: 'combined' | 'error';
}

export const logService = {
  /**
   * 获取分页系统日志
   */
  getLogs: async (params: LogQueryParams): Promise<GetLogsResponse> => {
    const response = await api.get('/logs', { params });
    return response.data;
  },

  /**
   * 获取系统日志统计数据
   */
  getLogStats: async (): Promise<GetLogStatsResponse> => {
    const response = await api.get('/logs/stats');
    return response.data;
  },
};
