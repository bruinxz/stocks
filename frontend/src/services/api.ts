import axios from 'axios';

// 如果没有环境变量，则根据当前页面的 hostname 动态推断后端地址（解决局域网访问时 localhost 连接失败的问题）
const defaultApiUrl =
  typeof window !== 'undefined'
    ? `http://${window.location.hostname}:3000/api`
    : 'http://localhost:3000/api';

export const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || defaultApiUrl;
// 提取后端的域名部分，用于静态资源（如头像）的拼接
export const API_DOMAIN_URL = API_BASE_URL.replace(/\/api\/?$/, '');

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
  withCredentials: true, // 允许携带 Cookie
  headers: {
    'Content-Type': 'application/json',
  },
});

// 请求拦截器
api.interceptors.request.use(
  config => {
    const token = localStorage.getItem('token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  error => {
    return Promise.reject(error);
  }
);

// 响应拦截器
api.interceptors.response.use(
  response => response,
  error => Promise.reject(error)
);

export default api;

// Market
export const getMarketOverview = () => api.get('/market/overview');
export const searchStocks = (query = '', limit = 100) =>
  api.get('/market/search', { params: { q: query, limit } });

// Favorites
export const getFavorites = () => api.get('/market/favorites');
export const addFavorite = (symbol: string, data: any) =>
  api.post(`/market/favorites/${symbol}`, data);
export const removeFavorite = (symbol: string) => api.delete(`/market/favorites/${symbol}`);
export const checkFavorite = (symbol: string) => api.get(`/market/favorites/${symbol}`);
// Batch L (2026-06-17, CRITICAL): 资金曲线串盘根因 — 之前无参数, 后端 facade
// fallback 到 user.active id ASC 第一个盘. user 4 有 9 个盘 → 顶部 KPI 是
// portfolio A 但资金曲线显示 portfolio B 的历史.
export const getPaperTradingSnapshots = (portfolio_id?: number) =>
  api.get('/paper-trading/snapshots', { params: portfolio_id ? { portfolio_id } : undefined });
export const updateFavorite = (symbol: string, data: any) =>
  api.patch(`/market/favorites/${symbol}`, data);

// Autonomous paper trading loop
export const getAutonomousTradingDashboard = (params?: any) =>
  api.get('/paper-trading/autonomous-dashboard', { params });
export const getOrderIntentFamilyHindsight = (params?: any) =>
  api.get('/paper-trading/order-intents/family-hindsight', { params });
export const getRecommendationTracking = (params?: any) =>
  api.get('/paper-trading/recommendation-tracking', { params });
export const getAutonomousOptimization = (params?: any) =>
  api.get('/paper-trading/autonomous-optimization', { params });
export const runPaperTradingRiskCheck = (data?: any) => api.post('/paper-trading/risk-check', data);
export const runAutonomousAutoSync = (data?: any) =>
  api.post('/paper-trading/autonomous-auto-sync', data);
export const runAutonomousRiskCheck = (data?: any) =>
  api.post('/paper-trading/autonomous-risk-check', data);
