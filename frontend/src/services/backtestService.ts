import api from './api';

export interface BacktestRequest {
  name: string;
  symbol: string;
  start_date: string;
  end_date: string;
  strategyType: string;
  strategyParams: Record<string, any>;
  initial_capital: number;
}

export interface BacktestResponse {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  symbol: string;
  start_date: string;
  end_date: string;
  strategyType: string;
  initial_capital: number;
  total_return?: number;
  sharpe_ratio?: number;
  max_drawdown?: number;
  created_at: string;
}

export interface BacktestListResponse {
  success: boolean;
  data: {
    backtests: BacktestResponse[];
    pagination: {
      total: number;
      page: number;
      limit: number;
      totalPages: number;
    };
  };
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
      const strategy_config = backendBacktest.strategy_config || {};
      const symbols = strategy_config.symbols || [];
      const symbol = symbols.length > 0 ? symbols[0] : backtestData.symbol;
      const strategyType = strategy_config.strategyType || backtestData.strategyType;

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
        start_date: formatDate(backendBacktest.start_date) || backtestData.start_date,
        end_date: formatDate(backendBacktest.end_date) || backtestData.end_date,
        strategyType,
        initial_capital:
          parseFloat(backendBacktest.initial_capital) || backtestData.initial_capital,
        total_return:
          backendBacktest.total_return !== undefined
            ? parseFloat(backendBacktest.total_return)
            : undefined,
        sharpe_ratio:
          backendBacktest.sharpe_ratio !== undefined
            ? parseFloat(backendBacktest.sharpe_ratio)
            : undefined,
        max_drawdown:
          backendBacktest.max_drawdown !== undefined
            ? parseFloat(backendBacktest.max_drawdown)
            : undefined,
        created_at: backendBacktest.created_at
          ? typeof backendBacktest.created_at === 'string'
            ? backendBacktest.created_at
            : backendBacktest.created_at.toISOString()
          : new Date().toISOString(),
      };
    } catch (error) {
      console.error('创建回测失败:', error);
      const error_message = error instanceof Error ? error.message : String(error);
      throw new Error(`创建回测失败: ${error_message || '未知错误'}`);
    }
  },

  async getBacktestList(page = 1, pageSize = 10): Promise<BacktestListResponse> {
    try {
      const response = await api.get<any>('/backtests', {
        params: { page, limit: pageSize },
      });

      // 后端响应结构: { success: true, data: { backtests: [], pagination: { total, page, limit, totalPages } } }
      const backendData = response.data.data;
      const backendBacktests = backendData.backtests || [];
      const pagination = backendData.pagination || { total: 0, page: page, limit: pageSize };

      // 映射后端BacktestResult到前端BacktestResponse
      const mappedBacktests: BacktestResponse[] = backendBacktests.map((backendItem: any) => {
        const strategy_config = backendItem.strategy_config || {};
        const symbols = strategy_config.symbols || [];
        const symbol = symbols.length > 0 ? symbols[0] : '未知';
        const strategyType = strategy_config.strategyType || 'moving_average_crossover';

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
          start_date: formatDate(backendItem.start_date),
          end_date: formatDate(backendItem.end_date),
          strategyType,
          initial_capital: parseFloat(backendItem.initial_capital) || 100000,
          total_return:
            backendItem.total_return !== undefined
              ? parseFloat(backendItem.total_return)
              : undefined,
          sharpe_ratio:
            backendItem.sharpe_ratio !== undefined
              ? parseFloat(backendItem.sharpe_ratio)
              : undefined,
          max_drawdown:
            backendItem.max_drawdown !== undefined
              ? parseFloat(backendItem.max_drawdown)
              : undefined,
          created_at: backendItem.created_at
            ? typeof backendItem.created_at === 'string'
              ? backendItem.created_at
              : backendItem.created_at.toISOString()
            : new Date().toISOString(),
        };
      });

      return {
        success: true,
        data: {
          backtests: mappedBacktests,
          pagination: {
            total: pagination.total || mappedBacktests.length,
            page: pagination.page || page,
            limit: pagination.limit || pageSize,
            totalPages: pagination.totalPages || 1,
          },
        },
      };
    } catch (error) {
      console.error('获取回测列表失败:', error);
      const error_message = error instanceof Error ? error.message : String(error);
      throw new Error(`获取回测列表失败: ${error_message || '未知错误'}`);
    }
  },

  async getBacktestById(id: string): Promise<BacktestResponse> {
    try {
      const response = await api.get<any>(`/backtests/${id}`);
      // 后端响应结构: { success: true, data: { backtest: ... } }
      const backendBacktest = response.data.data.backtest;

      // 映射后端BacktestResult到前端BacktestResponse
      const strategy_config = backendBacktest.strategy_config || {};
      const symbols = strategy_config.symbols || [];
      const symbol = symbols.length > 0 ? symbols[0] : '未知';
      const strategyType = strategy_config.strategyType || 'moving_average_crossover';

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
        start_date: formatDate(backendBacktest.start_date),
        end_date: formatDate(backendBacktest.end_date),
        strategyType,
        initial_capital: parseFloat(backendBacktest.initial_capital) || 100000,
        total_return:
          backendBacktest.total_return !== undefined
            ? parseFloat(backendBacktest.total_return)
            : undefined,
        sharpe_ratio:
          backendBacktest.sharpe_ratio !== undefined
            ? parseFloat(backendBacktest.sharpe_ratio)
            : undefined,
        max_drawdown:
          backendBacktest.max_drawdown !== undefined
            ? parseFloat(backendBacktest.max_drawdown)
            : undefined,
        created_at: backendBacktest.created_at
          ? typeof backendBacktest.created_at === 'string'
            ? backendBacktest.created_at
            : backendBacktest.created_at.toISOString()
          : new Date().toISOString(),
      };
    } catch (error) {
      console.error('获取回测详情失败:', error);
      const error_message = error instanceof Error ? error.message : String(error);
      throw new Error(`获取回测详情失败: ${error_message || '未知错误'}`);
    }
  },

  async deleteBacktest(id: string): Promise<void> {
    try {
      await api.delete(`/backtests/${id}`);
    } catch (error) {
      console.error('删除回测失败:', error);
      const error_message = error instanceof Error ? error.message : String(error);
      throw new Error(`删除回测失败: ${error_message || '未知错误'}`);
    }
  },

  async getBacktestResults(id: string): Promise<any> {
    try {
      const response = await api.get(`/backtests/${id}/results`);
      return response.data;
    } catch (error) {
      console.error('获取回测结果失败:', error);
      const error_message = error instanceof Error ? error.message : String(error);
      throw new Error(`获取回测结果失败: ${error_message || '未知错误'}`);
    }
  },

  async getBacktestTrades(id: string): Promise<any> {
    try {
      const response = await api.get(`/backtests/${id}/trades`);
      return response.data;
    } catch (error) {
      console.error('获取回测交易数据失败:', error);
      const error_message = error instanceof Error ? error.message : String(error);
      throw new Error(`获取回测交易数据失败: ${error_message || '未知错误'}`);
    }
  },

  async getBacktestStats(): Promise<any> {
    try {
      const response = await api.get('/backtests/stats');
      return response.data;
    } catch (error) {
      console.error('获取回测统计失败:', error);
      const error_message = error instanceof Error ? error.message : String(error);
      throw new Error(`获取回测统计失败: ${error_message || '未知错误'}`);
    }
  },
};
