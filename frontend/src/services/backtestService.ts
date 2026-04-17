import api from './api';

export interface BacktestRequest {
  name: string;
  symbol: string;
  startDate: string;
  endDate: string;
  strategyType: string;
  strategyParams: Record<string, any>;
  initialCapital: number;
}

export interface BacktestResponse {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  symbol: string;
  startDate: string;
  endDate: string;
  strategyType: string;
  initialCapital: number;
  totalReturn?: number;
  sharpeRatio?: number;
  maxDrawdown?: number;
  createdAt: string;
}

export interface BacktestListResponse {
  success: boolean;
  data: BacktestResponse[];
  total: number;
  page: number;
  pageSize: number;
}

export interface BacktestDetailResponse {
  success: boolean;
  data: BacktestResponse;
}

export const backtestService = {
  async createBacktest(backtestData: BacktestRequest): Promise<BacktestResponse> {
    // 尝试使用真实API，失败时返回模拟数据
    try {
      const response = await api.post<any>('/backtests', backtestData);
      // 后端响应结构: { success: true, data: { backtest: ... } }
      const backendBacktest = response.data.data.backtest;

      // 映射后端BacktestResult到前端BacktestResponse
      const strategyConfig = backendBacktest.strategyConfig || {};
      const symbols = strategyConfig.symbols || [];
      const symbol = symbols.length > 0 ? symbols[0] : backtestData.symbol;
      const strategyType = strategyConfig.strategyType || backtestData.strategyType;

      const formatDate = (date: any) => {
        if (!date) return '';
        if (typeof date === 'string') return date;
        if (date instanceof Date) return date.toISOString().split('T')[0];
        return '';
      };

      return {
        id: backendBacktest.id || '',
        name: backendBacktest.name || backtestData.name,
        status: backendBacktest.status || 'pending',
        symbol,
        startDate: formatDate(backendBacktest.startDate) || backtestData.startDate,
        endDate: formatDate(backendBacktest.endDate) || backtestData.endDate,
        strategyType,
        initialCapital: parseFloat(backendBacktest.initialCapital) || backtestData.initialCapital,
        totalReturn:
          backendBacktest.totalReturn !== undefined
            ? parseFloat(backendBacktest.totalReturn)
            : undefined,
        sharpeRatio:
          backendBacktest.sharpeRatio !== undefined
            ? parseFloat(backendBacktest.sharpeRatio)
            : undefined,
        maxDrawdown:
          backendBacktest.maxDrawdown !== undefined
            ? parseFloat(backendBacktest.maxDrawdown)
            : undefined,
        createdAt: backendBacktest.createdAt
          ? typeof backendBacktest.createdAt === 'string'
            ? backendBacktest.createdAt
            : backendBacktest.createdAt.toISOString()
          : new Date().toISOString(),
      };
    } catch (error) {
      console.error('创建回测失败:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`创建回测失败: ${errorMessage || '未知错误'}`);
    }
  },

  async getBacktests(page = 1, pageSize = 10): Promise<BacktestListResponse> {
    try {
      const response = await api.get<any>('/backtests', {
        params: { page, pageSize },
      });

      // 后端响应结构: { success: true, data: { backtests: [], pagination: { total, page, limit, totalPages } } }
      const backendData = response.data.data;
      const backendBacktests = backendData.backtests || [];
      const pagination = backendData.pagination || { total: 0, page: page, limit: pageSize };

      // 映射后端BacktestResult到前端BacktestResponse
      const mappedBacktests: BacktestResponse[] = backendBacktests.map((backendItem: any) => {
        const strategyConfig = backendItem.strategyConfig || {};
        const symbols = strategyConfig.symbols || [];
        const symbol = symbols.length > 0 ? symbols[0] : '未知';
        const strategyType = strategyConfig.strategyType || 'moving_average_crossover';

        // 格式化日期
        const formatDate = (date: any) => {
          if (!date) return '';
          if (typeof date === 'string') return date;
          if (date instanceof Date) return date.toISOString().split('T')[0];
          return '';
        };

        return {
          id: backendItem.id || '',
          name: backendItem.name || '未命名回测',
          status: backendItem.status || 'pending',
          symbol,
          startDate: formatDate(backendItem.startDate),
          endDate: formatDate(backendItem.endDate),
          strategyType,
          initialCapital: parseFloat(backendItem.initialCapital) || 100000,
          totalReturn:
            backendItem.totalReturn !== undefined ? parseFloat(backendItem.totalReturn) : undefined,
          sharpeRatio:
            backendItem.sharpeRatio !== undefined ? parseFloat(backendItem.sharpeRatio) : undefined,
          maxDrawdown:
            backendItem.maxDrawdown !== undefined ? parseFloat(backendItem.maxDrawdown) : undefined,
          createdAt: backendItem.createdAt
            ? typeof backendItem.createdAt === 'string'
              ? backendItem.createdAt
              : backendItem.createdAt.toISOString()
            : new Date().toISOString(),
        };
      });

      return {
        success: true,
        data: mappedBacktests,
        total: pagination.total || 0,
        page: pagination.page || page,
        pageSize: pagination.limit || pageSize,
      };
    } catch (error) {
      console.error('获取回测列表失败:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`获取回测列表失败: ${errorMessage || '未知错误'}`);
    }
  },

  async getBacktestById(id: string): Promise<BacktestResponse> {
    try {
      const response = await api.get<any>(`/backtests/${id}`);
      // 后端响应结构: { success: true, data: { backtest: ... } }
      const backendBacktest = response.data.data.backtest;

      // 映射后端BacktestResult到前端BacktestResponse
      const strategyConfig = backendBacktest.strategyConfig || {};
      const symbols = strategyConfig.symbols || [];
      const symbol = symbols.length > 0 ? symbols[0] : '未知';
      const strategyType = strategyConfig.strategyType || 'moving_average_crossover';

      const formatDate = (date: any) => {
        if (!date) return '';
        if (typeof date === 'string') return date;
        if (date instanceof Date) return date.toISOString().split('T')[0];
        return '';
      };

      return {
        id: backendBacktest.id || '',
        name: backendBacktest.name || '未命名回测',
        status: backendBacktest.status || 'pending',
        symbol,
        startDate: formatDate(backendBacktest.startDate),
        endDate: formatDate(backendBacktest.endDate),
        strategyType,
        initialCapital: parseFloat(backendBacktest.initialCapital) || 100000,
        totalReturn:
          backendBacktest.totalReturn !== undefined
            ? parseFloat(backendBacktest.totalReturn)
            : undefined,
        sharpeRatio:
          backendBacktest.sharpeRatio !== undefined
            ? parseFloat(backendBacktest.sharpeRatio)
            : undefined,
        maxDrawdown:
          backendBacktest.maxDrawdown !== undefined
            ? parseFloat(backendBacktest.maxDrawdown)
            : undefined,
        createdAt: backendBacktest.createdAt
          ? typeof backendBacktest.createdAt === 'string'
            ? backendBacktest.createdAt
            : backendBacktest.createdAt.toISOString()
          : new Date().toISOString(),
      };
    } catch (error) {
      console.error('获取回测详情失败:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`获取回测详情失败: ${errorMessage || '未知错误'}`);
    }
  },

  async deleteBacktest(id: string): Promise<void> {
    try {
      await api.delete(`/backtests/${id}`);
    } catch (error) {
      console.error('删除回测失败:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`删除回测失败: ${errorMessage || '未知错误'}`);
    }
  },

  async getBacktestResults(id: string): Promise<any> {
    try {
      const response = await api.get(`/backtests/${id}/results`);
      return response.data;
    } catch (error) {
      console.error('获取回测结果失败:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`获取回测结果失败: ${errorMessage || '未知错误'}`);
    }
  },

  async getBacktestTrades(id: string): Promise<any> {
    try {
      const response = await api.get(`/backtests/${id}/trades`);
      return response.data;
    } catch (error) {
      console.error('获取回测交易数据失败:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`获取回测交易数据失败: ${errorMessage || '未知错误'}`);
    }
  },
};
