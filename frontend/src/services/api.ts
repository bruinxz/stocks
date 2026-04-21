import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';

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
  timeout: 10000,
  withCredentials: true, // 允许携带 Cookie
  headers: {
    'Content-Type': 'application/json',
  },
});

// 是否正在刷新的标记
let isRefreshing = false;
// 重试队列，每一项将是一个待执行的函数(存有config, resolve, reject)
let requests: ((token: string) => void)[] = [];

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
  async (error: AxiosError) => {
    const originalRequest = error.config as InternalAxiosRequestConfig & { _retry?: boolean };

    // 如果是 401 且不是刷新 token 和 登录的接口，说明 AccessToken 可能过期了
    if (
      error.response?.status === 401 &&
      !originalRequest.url?.includes('/auth/refresh') &&
      !originalRequest.url?.includes('/auth/login')
    ) {
      if (!originalRequest._retry) {
        originalRequest._retry = true;

        if (!isRefreshing) {
          isRefreshing = true;
          try {
            // 调用刷新接口 (原代码写的 /auth/refresh-token，但路由定义是 /auth/refresh)
            // 请求中会自动带上包含 refreshToken 的 Cookie
            const res = await axios.post(
              `${API_BASE_URL}/auth/refresh`,
              {},
              { withCredentials: true }
            );
            const { accessToken } = res.data.data;

            // 存入新的 Token
            localStorage.setItem('token', accessToken);

            // 刷新成功，更新原请求的 token
            originalRequest.headers.Authorization = `Bearer ${accessToken}`;

            // 重新发送队列里的所有请求
            requests.forEach(cb => cb(accessToken));
            requests = [];

            return api(originalRequest);
          } catch (refreshError) {
            // 刷新 Token 也失败了（说明 RefreshToken 彻底过期），只能清空并跳转
            requests = [];
            localStorage.removeItem('token');
            // 后端登出会清除cookie，或者如果刷新失败，需要重新登录获取新的cookie
            window.location.href = '/login';
            return Promise.reject(refreshError);
          } finally {
            isRefreshing = false;
          }
        } else {
          // 正在刷新中，把当前的请求存入队列等待
          return new Promise(resolve => {
            requests.push((token: string) => {
              originalRequest.headers.Authorization = `Bearer ${token}`;
              resolve(api(originalRequest));
            });
          });
        }
      }
    }

    // 其他错误直接抛出
    return Promise.reject(error);
  }
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
export const getPaperTradingSnapshots = () => api.get('/paper-trading/snapshots');
export const updateFavorite = (symbol: string, data: any) =>
  api.patch(`/market/favorites/${symbol}`, data);
