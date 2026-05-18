import api from './api';

export interface Stock {
  id: number;
  symbol: string;
  name: string;
  market: string;
  industry: string | null;
}

export interface SearchStocksResponse {
  success: boolean;
  data: {
    stocks: Stock[];
    pagination: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
    };
  };
}

export const marketService = {
  searchStocks: async (query = '', limit = 100): Promise<SearchStocksResponse> => {
    const response = await api.get('/market/search', {
      params: { q: query, limit },
    });
    return response.data;
  },
};
