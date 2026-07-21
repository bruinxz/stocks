import axios, { type AxiosRequestConfig } from 'axios';
import { clearUserScopedStorage } from '../utils/sessionCleanup';

// 如果没有环境变量，则根据当前页面的 hostname 动态推断后端地址（解决局域网访问时 localhost 连接失败的问题）
const defaultApiUrl =
  typeof window !== 'undefined'
    ? `http://${window.location.hostname}:3000/api`
    : 'http://localhost:3000/api';

export const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || defaultApiUrl;
// 提取后端的域名部分，用于静态资源（如头像）的拼接
export const API_DOMAIN_URL = API_BASE_URL.replace(/\/api\/?$/, '');

export const AUTH_REFRESH_TIMEOUT_MS = 10_000;

interface RefreshFlight {
  promise: Promise<string>;
}

let refreshFlight: RefreshFlight | null = null;

function isAuthBootstrapRequest(url: unknown): boolean {
  const value = String(url || '');
  return /\/auth\/(?:login|register|refresh)(?:\?|$)/.test(value);
}

function redirectToLogin(): void {
  clearUserScopedStorage();
  if (typeof window === 'undefined' || window.location.pathname === '/login') return;
  window.history.replaceState({}, '', '/login');
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function abortError(): Error {
  const error = new Error('Access token refresh was aborted');
  error.name = 'AbortError';
  return error;
}

function refreshCredentialWasRejected(error: unknown): boolean {
  const status = (error as { response?: { status?: unknown } })?.response?.status;
  return status === 400 || status === 401;
}

async function withCrossTabRefreshLock(
  staleAccessToken: string | null,
  signal: AbortSignal,
  refresh: () => Promise<string>
): Promise<string> {
  const locks =
    typeof navigator !== 'undefined'
      ? (navigator as Navigator & {
          locks?: {
            request: (
              name: string,
              options: { mode: 'exclusive'; signal: AbortSignal },
              callback: () => Promise<string>
            ) => Promise<string>;
          };
        }).locks
      : undefined;
  const run = async (): Promise<string> => {
    const sharedToken = localStorage.getItem('token');
    if (staleAccessToken && sharedToken && sharedToken !== staleAccessToken) {
      return sharedToken;
    }
    return refresh();
  };
  if (!locks?.request) return run();
  return locks.request('stocks-access-token-refresh', { mode: 'exclusive', signal }, run);
}

function waitForRefresh(flight: Promise<string>, signal?: AbortSignal): Promise<string> {
  if (!signal) return flight;
  if (signal.aborted) return Promise.reject(abortError());

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(abortError()));
    signal.addEventListener('abort', onAbort, { once: true });
    flight.then(
      token => finish(() => resolve(token)),
      error => finish(() => reject(error))
    );
  });
}

function startRefreshFlight(staleAccessToken: string | null): RefreshFlight {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error('Access token refresh timed out'));
    }, AUTH_REFRESH_TIMEOUT_MS);
  });
  const request = withCrossTabRefreshLock(staleAccessToken, controller.signal, async () => {
    const response = await axios.post(
      `${API_BASE_URL}/auth/refresh`,
      {},
      {
        withCredentials: true,
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        timeout: AUTH_REFRESH_TIMEOUT_MS,
      }
    );
    const token = response.data?.data?.accessToken;
    if (typeof token !== 'string' || token.length === 0) {
      throw new Error('Refresh response did not include an access token');
    }
    localStorage.setItem('token', token);
    return token;
  });
  const flightPromise = Promise.race([request, timedOut])
    .catch(error => {
      if (refreshCredentialWasRejected(error)) clearUserScopedStorage();
      throw error;
    })
    .finally(() => {
      if (timeout !== undefined) clearTimeout(timeout);
      if (refreshFlight?.promise === flightPromise) refreshFlight = null;
    });
  return { promise: flightPromise };
}

export function refreshAccessToken(
  signal?: AbortSignal,
  staleAccessToken: string | null = localStorage.getItem('token')
): Promise<string> {
  if (signal?.aborted) return Promise.reject(abortError());
  if (!refreshFlight) refreshFlight = startRefreshFlight(staleAccessToken);
  return waitForRefresh(refreshFlight.promise, signal);
}

/**
 * Fetch transport for contract-first clients that still need a native
 * Response. It shares the canonical API base, Bearer token and cookie policy
 * with the Axios client below and refuses to forward credentials off-origin.
 */
export async function authenticatedFetch(
  input: RequestInfo | URL,
  init: RequestInit = {}
): Promise<Response> {
  const path = String(input);
  if (!path.startsWith('/api/')) {
    throw new Error('Authenticated API fetch requires a canonical /api/ path');
  }
  const headers = new Headers(init.headers);
  const token = typeof localStorage !== 'undefined' ? localStorage.getItem('token') : null;
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  const request = (authorizationHeaders: Headers) =>
    fetch(`${API_DOMAIN_URL}${path}`, {
      ...init,
      headers: authorizationHeaders,
      credentials: init.credentials ?? 'include',
    });
  const response = await request(headers);
  if (response.status !== 401 || isAuthBootstrapRequest(path)) return response;
  try {
    const refreshed = await refreshAccessToken(init.signal ?? undefined, token);
    headers.set('Authorization', `Bearer ${refreshed}`);
    return await request(headers);
  } catch (error) {
    if (init.signal?.aborted) throw error;
    redirectToLogin();
    if (refreshCredentialWasRejected(error)) {
      return response;
    }
    throw error;
  }
}

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
  async error => {
    const status = error?.response?.status;
    const original = error?.config as
      | (AxiosRequestConfig & { _auth_refresh_retry?: boolean })
      | undefined;
    if (
      status !== 401 ||
      !original ||
      original._auth_refresh_retry ||
      isAuthBootstrapRequest(original.url)
    ) {
      return Promise.reject(error);
    }
    original._auth_refresh_retry = true;
    try {
      const requestSignal = original.signal as AbortSignal | undefined;
      const authorization = String(
        (original.headers as Record<string, unknown> | undefined)?.Authorization || ''
      );
      const staleToken = /^Bearer\s+(.+)$/i.exec(authorization)?.[1] || null;
      const token = await refreshAccessToken(requestSignal, staleToken);
      original.headers = original.headers || {};
      original.headers.Authorization = `Bearer ${token}`;
      return api(original);
    } catch (refreshError) {
      if ((original.signal as AbortSignal | undefined)?.aborted) {
        return Promise.reject(refreshError);
      }
      redirectToLogin();
      return Promise.reject(error);
    }
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
export const getPaperTradingSnapshots = (portfolio_id: number) =>
  api.get('/paper-trading/snapshots', { params: { portfolio_id } });
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
