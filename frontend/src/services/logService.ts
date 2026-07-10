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
   * 获取分页系统日志。
   *
   * `config.signal` 支持 AbortController — 组件在 useEffect cleanup / setInterval 下一 tick 时可取消未完成的请求，
   * 避免快速切换 filter (page/level/keyword/type) 或 autoRefresh 高频轮询时旧请求 late-arriver 覆盖新状态。
   * axios `config.signal` 原生支持自 v0.22.0（2021-10）。
   */
  getLogs: async (
    params: LogQueryParams,
    config?: { signal?: AbortSignal }
  ): Promise<GetLogsResponse> => {
    const response = await api.get('/logs', { params, signal: config?.signal });
    return response.data;
  },

  /**
   * 获取系统日志统计数据。
   *
   * `config.signal` 支持 AbortController — 与 getLogs 同批取消，保证 filter/refresh 期间状态一致。
   */
  getLogStats: async (config?: {
    signal?: AbortSignal;
  }): Promise<GetLogStatsResponse> => {
    const response = await api.get('/logs/stats', { signal: config?.signal });
    return response.data;
  },
};
