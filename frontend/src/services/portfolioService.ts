import api from './api';

export interface PortfolioSimulationRequest {
  symbols: string[];
  buyDate: string;
  days: number;
  initial_capital: number;
  allocationStrategy: 'equal' | 'weighted';
  includeDividends?: boolean;
  reinvest?: boolean;
  name?: string;
  description?: string;
}

export interface StockReturnData {
  symbol: string;
  name: string;
  buyPrice: number;
  allocationAmount: number;
  shares: number;
  finalValue: number;
  total_return: number;
}

export interface DailyReturnData {
  date: string;
  total_value: number;
  dailyReturn: number;
  cumulativeReturn: number;
}

export interface PerformanceMetrics {
  sharpe_ratio: number;
  max_drawdown: number;
  volatility: number;
  winDays: number;
  lossDays: number;
  avgDailyReturn: number;
  bestDay: { date: string; return: number };
  worstDay: { date: string; return: number };
}

export interface PortfolioSimulationResult {
  config: {
    symbols: string[];
    buyDate: string;
    days: number;
    initial_capital: number;
    allocationStrategy: string;
  };
  summary: {
    initial_capital: number;
    final_capital: number;
    total_return: number;
    annualized_return: number;
    totalDays: number;
    start_date: string;
    end_date: string;
  };
  performanceMetrics: PerformanceMetrics;
  daily_returns: DailyReturnData[];
  stockReturns: StockReturnData[];
}

export interface PortfolioSimulationResponse {
  success: boolean;
  message: string;
  data: {
    simulation: PortfolioSimulationResult;
  };
}

export interface StockValidationRequest {
  symbols: string[];
}

export interface StockValidationResult {
  symbol: string;
  exists: boolean;
  name: string;
  market: string;
}

export interface StockValidationResponse {
  success: boolean;
  data: {
    stocks: StockValidationResult[];
    validCount: number;
    invalidCount: number;
  };
}

export interface RecommendedConfigResponse {
  success: boolean;
  data: {
    recommendedConfig: {
      symbols: string[];
      buyDate: string;
      days: number;
      initial_capital: number;
      allocationStrategy: string;
      maxStocks: number;
      minDays: number;
      maxDays: number;
      minCapital: number;
      maxCapital: number;
    };
    popularCombinations: Array<{
      name: string;
      symbols: string[];
      description: string;
    }>;
  };
}

/**
 * 运行投资组合收益模拟
 */
export const simulatePortfolio = async (
  request: PortfolioSimulationRequest
): Promise<PortfolioSimulationResponse> => {
  const response = await api.post('/portfolio/simulate', request);
  return response.data;
};

/**
 * 批量验证股票
 */
export const validateStocks = async (symbols: string[]): Promise<StockValidationResponse> => {
  const response = await api.post('/portfolio/validate-stocks', { symbols });
  return response.data;
};

/**
 * 获取推荐配置
 */
export const getRecommendedConfig = async (): Promise<RecommendedConfigResponse> => {
  const response = await api.get('/portfolio/recommended-config');
  return response.data;
};

/**
 * 获取模拟历史记录
 */
export const getSimulationHistory = async (params?: {
  page?: number;
  limit?: number;
  start_date?: string;
  end_date?: string;
}) => {
  const response = await api.get('/portfolio/history', { params });
  return response.data;
};

/**
 * 获取模拟详情
 */
export const getSimulationDetail = async (id: string) => {
  const response = await api.get(`/portfolio/${id}`);
  return response.data;
};

// 导出所有API方法
export const portfolioApi = {
  simulate: simulatePortfolio,
  validateStocks,
  getRecommendedConfig,
  getSimulationHistory,
  getSimulationDetail,
};
