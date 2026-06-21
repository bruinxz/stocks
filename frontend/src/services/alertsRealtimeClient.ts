/**
 * alertsRealtimeClient — US-073 [FE-034] /ws/alerts 前端客户端 + 30s polling fallback.
 *
 * 设计目标:
 *   - 把 "实时推送 + 兜底轮询" 统一暴露成 React-friendly hook (useAlertsRealtime);
 *   - WebSocket 连不上 / 服务端不支持 / 网络中断 → 自动退回 polling 模式
 *     (与 [[AlertsBell]] 之前的 60s polling 一致, 但加快到 30s 让用户感知差距小);
 *   - WebSocket 成功收到 'connected' 消息 → 停止 polling, 仅在 WS 断开时再启;
 *   - 重连用指数 backoff: 1s, 2s, 4s, 8s, 16s, 32s (上限) — 与 browser
 *     EventSource / Sentry 同款思想, 避免服务端 restart 时雪崩.
 *
 * 与 [[AlertsBell]] 协作:
 *   - AlertsBell 之前用 listRiskAlerts({limit:1}) 60s 轮询取 unread_count;
 *   - 新增 hook 返 { unreadCount, mode: 'ws'|'polling'|'error', refresh }
 *     直接替换 useEffect 里的 setInterval;
 *   - WS 收到 'alert.new' payload 时, 也调一次 listRiskAlerts({limit:1})
 *     拿真实 unread_count (避免本地维护增量 drift). 这是 hook 内部行为,
 *     不暴露到 caller.
 *
 * 与后端契约:
 *   - URL: ws(s)://<host>:3000/ws/alerts?token=<JWT>
 *   - server 在 connect 后立即发 {type:'connected', user_id, ts};
 *   - 之后告警时发 {type:'alert.new', alert_id, user_id, level, ...}.
 *   - 任何 close / error / 异常 message 都视为 ws 不可用 → 退 polling.
 *
 * 单测策略:
 *   - 本文件纯函数 (URL builder / backoff / 状态机) 全 export 单测;
 *   - useAlertsRealtime hook 不直接单测 (需 jsdom React testing-library 太重,
 *     与 [[shadowRunHelpers]] 跨 monorepo "复刻形态" 同款思想);
 *   - alertsBroadcaster (backend) 已完整覆盖 fan-out.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { listRiskAlerts } from './riskAlertService';
import { API_DOMAIN_URL } from './api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AlertsRealtimeMode = 'ws' | 'polling' | 'idle' | 'error';

export interface UseAlertsRealtimeOptions {
  /** 启用 WS (默认 true). 关闭后强制 polling — 用于回归测试 / 故障演练. */
  enableWebSocket?: boolean;
  /** 轮询间隔 ms (兜底). 默认 ALERTS_POLLING_INTERVAL_MS = 30s. */
  pollingIntervalMs?: number;
  /** WS 重连最大 backoff ms. 默认 ALERTS_RECONNECT_MAX_MS = 32s. */
  reconnectMaxMs?: number;
  /** 注入 token (单测用); 缺省读 localStorage('token'). */
  tokenOverride?: string | null;
  /** 注入 wsUrlBase (单测用); 缺省 wsUrlFromHttpBase(API_DOMAIN_URL). */
  wsUrlBaseOverride?: string | null;
  /**
   * US-074 [FE-035] 钩子 — 收到任何 alert.new (含 connected 时跳过) 时, 把 raw
   * 消息回调给 caller. CriticalAlertModal 用这个钩子触发强制弹窗, 避免再开第二条
   * WebSocket. **不要在 callback 内做阻塞 I/O** — 它在 ws.onmessage 同步触发.
   * caller 应自行做幂等 / dedup (见 [[criticalAlertModalHelpers]]).
   *
   * 仅 alert.new 触发, connected/未知 type 不触发. 与 shouldFetchOnMessage 同语义.
   */
  onAlert?: (msg: AlertsRealtimeMessage) => void;
}

export interface UseAlertsRealtimeResult {
  /** 当前未读告警数 (来源: WS 触发后 fetch /api/risk-alerts/list?limit=1, 或 polling 周期 fetch). */
  unreadCount: number;
  /** 当前数据来源 — UI Tooltip 可用. */
  mode: AlertsRealtimeMode;
  /** 强制刷新一次 (用户点击 "重试"). */
  refresh: () => void;
}

export interface AlertsRealtimeMessage {
  type: 'alert.new' | 'connected' | string;
  alert_id?: number;
  user_id?: number;
  level?: string;
  symbol?: string;
  message?: string;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 轮询兜底间隔 — 30s 让用户最坏延迟 30s 看到新告警 (WS 失败时). */
export const ALERTS_POLLING_INTERVAL_MS = 30_000;

/** 重连初始 backoff — 1s. */
export const ALERTS_RECONNECT_INITIAL_MS = 1_000;

/** 重连最大 backoff — 32s. 与 Sentry / EventSource 默认同款. */
export const ALERTS_RECONNECT_MAX_MS = 32_000;

/** 重连失败计数到此切到永久 polling — 防"服务端永久挂掉" 持续重试浪费. */
export const ALERTS_RECONNECT_GIVE_UP_AFTER = 6;

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * 把 http(s) 域名换成 ws(s) — 兼容 http://host:3000 / https://host / 含 path 末尾 /.
 * 缺 protocol 时返 null. 单测用.
 */
export function wsUrlFromHttpBase(httpBase: string | null | undefined): string | null {
  if (!httpBase || typeof httpBase !== 'string') return null;
  const trimmed = httpBase.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  if (trimmed.startsWith('https://')) return 'wss://' + trimmed.slice('https://'.length);
  if (trimmed.startsWith('http://')) return 'ws://' + trimmed.slice('http://'.length);
  return null;
}

/**
 * 构造完整 ws URL — base + '/ws/alerts?token=<jwt>'. token 缺失返 null
 * (调用方不会真去连未鉴权 endpoint, fail-CLOSED).
 */
export function buildAlertsWsUrl(
  wsBase: string | null | undefined,
  token: string | null | undefined
): string | null {
  if (!wsBase || !token) return null;
  return `${wsBase}/ws/alerts?token=${encodeURIComponent(token)}`;
}

/**
 * 指数 backoff: attempt=0 → INITIAL, 翻倍, clamp MAX. attempt 非法 → INITIAL.
 */
export function computeReconnectBackoff(
  attempt: number,
  initial: number = ALERTS_RECONNECT_INITIAL_MS,
  max: number = ALERTS_RECONNECT_MAX_MS
): number {
  if (!Number.isFinite(attempt) || attempt < 0) return initial;
  const v = initial * Math.pow(2, Math.floor(attempt));
  return Math.min(max, v);
}

/**
 * 判定是否应退到永久 polling — 连续失败 N 次 (服务端 down / 端口被拦).
 */
export function shouldGiveUpReconnect(
  attempt: number,
  giveUpAfter: number = ALERTS_RECONNECT_GIVE_UP_AFTER
): boolean {
  return Number.isFinite(attempt) && Number.isFinite(giveUpAfter) && attempt >= giveUpAfter;
}

/**
 * 解析 ws onmessage 的 raw data — 容错 non-JSON / null / 非对象.
 * 返 null 时 caller 静默忽略 (典型: 服务端心跳 ping/pong 自动处理).
 */
export function parseRealtimeMessage(raw: unknown): AlertsRealtimeMessage | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return null;
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return null;
    if (typeof obj.type !== 'string' || !obj.type) return null;
    return obj as AlertsRealtimeMessage;
  } catch {
    return null;
  }
}

/**
 * 从 message 判定是否需要 fetch 一次 unread_count — alert.new 是, connected/其他 否.
 * 单测用; 真 hook 直接调用 fetchUnreadCount 不依赖此判定.
 */
export function shouldFetchOnMessage(msg: AlertsRealtimeMessage | null): boolean {
  if (!msg) return false;
  return msg.type === 'alert.new';
}

// ---------------------------------------------------------------------------
// Side-effect helpers (impure but isolated)
// ---------------------------------------------------------------------------

/**
 * fetch 一次 listRiskAlerts({limit:1}) 拿 unread_count. 失败返 null,
 * caller 视情况保留上一次值 (fail-OPEN 与 AlertsBell 同款思想).
 */
export async function fetchUnreadCount(): Promise<number | null> {
  try {
    const res = await listRiskAlerts({ limit: 1, page: 1 });
    if (res && typeof res.unread_count === 'number' && Number.isFinite(res.unread_count)) {
      return Math.max(0, Math.floor(res.unread_count));
    }
    return null;
  } catch {
    return null;
  }
}

function readTokenFromLocalStorage(): string | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    const t = window.localStorage.getItem('token');
    return t && t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

/**
 * useAlertsRealtime — 主入口. AlertsBell.tsx 用法:
 *
 *   const { unreadCount, mode, refresh } = useAlertsRealtime();
 *   ...render Badge(unreadCount) + Tooltip(mode==='polling' ? '轮询模式' : '实时')...
 *
 * 内部状态机:
 *   1) mount → enableWebSocket && tokenAvailable → 尝试 ws
 *      失败 / 关 → backoff 重连, 同时 polling 兜底
 *      ws 'connected' → polling 关 (节省请求)
 *      ws 收到 'alert.new' → 立刻 fetchUnreadCount
 *      ws onclose/error → 重连 + 重启 polling
 *      attempt ≥ GIVE_UP → 永久 polling (mode='polling')
 *   2) enableWebSocket=false → 直接 polling
 *   3) 无 token → mode='idle' 不连不轮询 (caller 通常会 unmount)
 *
 * unmount 清理: clearInterval + ws.close + cancel reconnect timer.
 */
export function useAlertsRealtime(options: UseAlertsRealtimeOptions = {}): UseAlertsRealtimeResult {
  const {
    enableWebSocket = true,
    pollingIntervalMs = ALERTS_POLLING_INTERVAL_MS,
    reconnectMaxMs = ALERTS_RECONNECT_MAX_MS,
    tokenOverride,
    wsUrlBaseOverride,
    onAlert,
  } = options;

  const [unreadCount, setUnreadCount] = useState<number>(0);
  const [mode, setMode] = useState<AlertsRealtimeMode>('idle');

  // refs 让重连/清理逻辑跨 effect 闭包共享
  const wsRef = useRef<WebSocket | null>(null);
  const pollTimerRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef<number>(0);
  const givenUpRef = useRef<boolean>(false);
  const mountedRef = useRef<boolean>(true);
  // US-074 onAlert 钩子 — 用 ref 跟踪最新 callback, 不让 callback 变化引起 ws 重连.
  const onAlertRef = useRef<typeof onAlert>(onAlert);
  useEffect(() => {
    onAlertRef.current = onAlert;
  }, [onAlert]);

  // helper: 拉一次 unread + 更新 state (mounted 守)
  const pullUnread = useCallback(async () => {
    const n = await fetchUnreadCount();
    if (!mountedRef.current) return;
    if (n !== null) setUnreadCount(n);
  }, []);

  // helper: 启动 polling timer (幂等)
  const startPolling = useCallback(() => {
    if (pollTimerRef.current !== null) return;
    if (typeof window === 'undefined') return;
    pollTimerRef.current = window.setInterval(() => {
      void pullUnread();
    }, pollingIntervalMs);
  }, [pollingIntervalMs, pullUnread]);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current !== null && typeof window !== 'undefined') {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  // helper: close 当前 ws (不触发 reconnect — caller 自己控)
  const closeWs = useCallback(() => {
    if (wsRef.current) {
      try {
        wsRef.current.onclose = null;
        wsRef.current.onerror = null;
        wsRef.current.onmessage = null;
        wsRef.current.onopen = null;
        wsRef.current.close();
      } catch {
        /* ignore */
      }
      wsRef.current = null;
    }
  }, []);

  // helper: 安排一次 reconnect (backoff). 给 GIVE_UP 后退到永久 polling.
  const scheduleReconnect = useCallback(
    (connectFn: () => void) => {
      if (typeof window === 'undefined') return;
      const attempt = reconnectAttemptRef.current;
      if (shouldGiveUpReconnect(attempt)) {
        givenUpRef.current = true;
        setMode('polling');
        startPolling();
        return;
      }
      const delay = computeReconnectBackoff(attempt, ALERTS_RECONNECT_INITIAL_MS, reconnectMaxMs);
      reconnectAttemptRef.current = attempt + 1;
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
      }
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        if (mountedRef.current) connectFn();
      }, delay);
    },
    [reconnectMaxMs, startPolling]
  );

  // helper: 真正 open 一个 WebSocket
  const connect = useCallback(() => {
    if (typeof window === 'undefined' || typeof WebSocket === 'undefined') {
      // 环境不支持 — 走 polling
      setMode('polling');
      startPolling();
      return;
    }
    const token = tokenOverride !== undefined ? tokenOverride : readTokenFromLocalStorage();
    const wsBase =
      wsUrlBaseOverride !== undefined ? wsUrlBaseOverride : wsUrlFromHttpBase(API_DOMAIN_URL);
    const url = buildAlertsWsUrl(wsBase, token);
    if (!url) {
      // 无 token / 无 baseURL → 不连 ws, 仅 polling
      setMode('polling');
      startPolling();
      return;
    }
    closeWs();
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      scheduleReconnect(connect);
      return;
    }
    wsRef.current = ws;

    ws.onopen = () => {
      // 不在此处 setMode('ws') — 等 'connected' 消息确认服务端真的发了一条
      // 才视为可用 (HTTP 401 关闭可能在 open 后才发生).
    };

    ws.onmessage = ev => {
      const parsed = parseRealtimeMessage(ev.data);
      if (!parsed) return;
      if (parsed.type === 'connected') {
        // 真双向连通: 切 ws 模式 + 停 polling + 重置重连计数
        reconnectAttemptRef.current = 0;
        givenUpRef.current = false;
        setMode('ws');
        stopPolling();
        void pullUnread();
        return;
      }
      if (shouldFetchOnMessage(parsed)) {
        void pullUnread();
        // US-074: 把 raw alert.new 消息透传给 caller (CriticalAlertModal).
        // try/catch 让 callback 抛错不影响 ws 消费循环.
        if (onAlertRef.current) {
          try {
            onAlertRef.current(parsed);
          } catch {
            /* swallow — modal 失败不该 propagate 让 ws 断 */
          }
        }
      }
    };

    ws.onerror = () => {
      // 失败: 退 polling + 安排重连. 关闭 ws 让 onclose 兜底 cleanup.
      setMode('polling');
      startPolling();
    };

    ws.onclose = () => {
      wsRef.current = null;
      if (!mountedRef.current) return;
      if (givenUpRef.current) return;
      startPolling(); // 重连期间 polling 兜底
      scheduleReconnect(connect);
    };
  }, [
    closeWs,
    pullUnread,
    scheduleReconnect,
    startPolling,
    stopPolling,
    tokenOverride,
    wsUrlBaseOverride,
  ]);

  // refresh — 用户点击 retry / 手动刷新
  const refresh = useCallback(() => {
    reconnectAttemptRef.current = 0;
    givenUpRef.current = false;
    void pullUnread();
    if (enableWebSocket) {
      closeWs();
      connect();
    }
  }, [closeWs, connect, enableWebSocket, pullUnread]);

  useEffect(() => {
    mountedRef.current = true;
    // 首次 fetch — 不管 ws 是否能开都先拿一次
    void pullUnread();
    if (enableWebSocket) {
      connect();
    } else {
      setMode('polling');
      startPolling();
    }
    return () => {
      mountedRef.current = false;
      stopPolling();
      if (reconnectTimerRef.current !== null && typeof window !== 'undefined') {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      closeWs();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { unreadCount, mode, refresh };
}
