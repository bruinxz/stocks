import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';

const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || 'http://localhost:3000/api';

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 10000,
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

    // 如果是 401 且不是刷新 token 的接口，说明 AccessToken 可能过期了
    if (error.response?.status === 401 && !originalRequest.url?.includes('/auth/refresh-token')) {
      if (!originalRequest._retry) {
        originalRequest._retry = true;
        const refreshToken = localStorage.getItem('refreshToken');

        // 如果没有 refreshToken，说明彻底没登录，直接跳走
        if (!refreshToken) {
          localStorage.removeItem('token');
          window.location.href = '/login';
          return Promise.reject(error);
        }

        if (!isRefreshing) {
          isRefreshing = true;
          try {
            // 调用刷新接口
            const res = await axios.post(`${API_BASE_URL}/auth/refresh-token`, { refreshToken });
            const { accessToken, refreshToken: newRefreshToken } = res.data.data;

            // 存入新的 Token
            localStorage.setItem('token', accessToken);
            if (newRefreshToken) {
              localStorage.setItem('refreshToken', newRefreshToken);
            }

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
            localStorage.removeItem('refreshToken');
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
