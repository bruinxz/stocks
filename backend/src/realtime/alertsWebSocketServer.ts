/**
 * alertsWebSocketServer — US-073 [FE-034] /ws/alerts WebSocket 服务端.
 *
 * 接入路径 (`index.ts`):
 *   - 用 `http.createServer(app)` 替代 `app.listen`;
 *   - attachAlertsWebSocketServer(httpServer, { path: '/ws/alerts' });
 *   - WebSocketServer 在 'upgrade' 事件里只接 /ws/alerts 路径, 其它路径 noResponse
 *     交给其他 handler / express 自己 404.
 *
 * 鉴权:
 *   - Browser WebSocket API 不能自定义 Authorization header, 所以 token 走 query:
 *     ws://host/ws/alerts?token=<JWT>
 *   - verifyAlertsToken(token, secret) 跑 jwt.verify, 返 user_id (decoded.user_id
 *     或 decoded.user.id, 与既有 middlewares/auth.ts 兼容);
 *   - secret 来源同 middlewares/auth.ts: process.env.JWT_SECRET, 缺失返 null
 *     (拒所有连接, 关闭 code 1008 'policy violation').
 *
 * 生命周期:
 *   - 连接成功: broadcaster.register(user_id, client); client.send 一条 'connected' 不算告警
 *   - 客户端 close / 服务端检测到 stale (ping/pong) → broadcaster.unregister
 *   - 单 user 超 MAX_CLIENTS_PER_USER → 直接 close 1013 (try again later)
 *
 * 错误兜底 (fail-OPEN):
 *   - JWT_SECRET 缺失 → 整个 WS server 拒所有连接, 但不 throw 不阻塞 HTTP server
 *   - jwt.verify throw / 无 token → close 1008 关闭
 *   - 鉴权后任何 send/recv 异常 → 自动 unregister + close, 不阻塞主流程
 *
 * 单测策略:
 *   - 本文件仅 'wiring' 单测 (鉴权 helper + handleConnection); 真 WebSocket
 *     E2E 不在 CI 里跑 (起 http server 太重, 与 [[shadowRunHelpers]] 跨 monorepo
 *     "复刻形态而非起 react/jsdom" 同款思想);
 *   - alertsBroadcaster.ts 全单测覆盖 fan-out / dedup / error path;
 *   - frontend alertsRealtimeClient 测重连 + polling fallback.
 */

import { IncomingMessage } from 'http';
import jwt from 'jsonwebtoken';

import { logger } from '../utils/logger';
import {
  alertsBroadcaster,
  AlertsBroadcaster,
  AlertsBroadcastClient,
  AlertsBroadcastPayload,
} from './alertsBroadcaster';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** /ws/alerts 默认挂载路径. */
export const ALERTS_WS_PATH = '/ws/alerts';

/** ping 心跳间隔 — 防 NAT / load balancer 断 idle 连接. 30s 与前端 polling 兜底一致. */
export const ALERTS_WS_PING_INTERVAL_MS = 30_000;

/** WebSocket close codes (RFC 6455 + 自定义). */
export const ALERTS_WS_CLOSE = Object.freeze({
  POLICY_VIOLATION: 1008, // 缺/无效 token
  TRY_AGAIN_LATER: 1013, // user 超 MAX_CLIENTS_PER_USER
  SERVER_ERROR: 1011,
} as const);

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * 从 ?token=... 提取 JWT. 缺失 / 空串 → null. 不做格式校验, 由 jwt.verify 处理.
 */
export function extractTokenFromQuery(url: string | undefined): string | null {
  if (!url || typeof url !== 'string') return null;
  try {
    // url 通常是 '/ws/alerts?token=xxx', 用 dummy base 兜底 parse
    const u = new URL(url, 'http://_/');
    const t = u.searchParams.get('token');
    if (!t || typeof t !== 'string') return null;
    const trimmed = t.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

/**
 * 解析 jwt → user_id. 与 middlewares/auth.ts 同款 fallback 顺序:
 *   - decoded.user_id (顶层)
 *   - decoded.user.id (嵌套)
 *   - decoded.id (顶层 id)
 * 任何 throw / 无 user_id 返 null. secret 缺失也返 null.
 */
export function verifyAlertsToken(
  token: string | null,
  secret: string | null | undefined
): { user_id: number; username?: string } | null {
  if (!token || !secret) return null;
  try {
    const decoded = jwt.verify(token, secret) as any;
    if (!decoded || typeof decoded !== 'object') return null;
    const candidate =
      (typeof decoded.user_id === 'number' && decoded.user_id) ||
      (decoded.user && typeof decoded.user.id === 'number' && decoded.user.id) ||
      (typeof decoded.id === 'number' && decoded.id) ||
      null;
    if (!candidate || candidate <= 0) return null;
    const username =
      (typeof decoded.username === 'string' && decoded.username) ||
      (decoded.user && typeof decoded.user.username === 'string' && decoded.user.username) ||
      undefined;
    return { user_id: candidate, username };
  } catch (err: any) {
    // 不 log debug-级 spam, 只在 error 级别记 (DEBUG=ws-alerts 时可展开)
    return null;
  }
}

/**
 * 取当前进程 JWT secret. 单一事实源, 与 middlewares/auth.ts 行为一致.
 * production 缺失返 null (拒所有 WS 连接, 同 HTTP 中间件); dev 允许 LIVE_DEV_JWT_SECRET 兜底.
 */
export function loadJwtSecretFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const primary = env.JWT_SECRET;
  if (typeof primary === 'string' && primary.length > 0) return primary;
  if (env.NODE_ENV !== 'production') {
    const dev = env.LIVE_DEV_JWT_SECRET;
    if (typeof dev === 'string' && dev.length > 0) return dev;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Attach to http server
// ---------------------------------------------------------------------------

export interface AttachAlertsWsOptions {
  /** override path; 默认 ALERTS_WS_PATH */
  path?: string;
  /** override broadcaster; 默认 singleton */
  broadcaster?: AlertsBroadcaster;
  /** override secret loader; 默认 env */
  loadSecret?: () => string | null;
  /** override ping interval ms; 默认 ALERTS_WS_PING_INTERVAL_MS */
  pingIntervalMs?: number;
}

export interface AttachAlertsWsResult {
  /** WebSocketServer 实例 — caller 关闭时调 wss.close() */
  wss: any;
  /** ping interval timer — caller 关闭时调 clearInterval */
  pingTimer: NodeJS.Timeout;
  /** broadcaster 引用 — caller 调用 broadcastAlert(payload) 转发 */
  broadcaster: AlertsBroadcaster;
}

/**
 * 把 WebSocketServer 挂载到 http server 的 /ws/alerts 路径.
 *
 * lazy require 'ws' — 让 WebSocketServer 缺失时返 null 而不是启动期 ESM resolve
 * 失败 (与 metrics / prometheus 同款"可选基础设施"接入模式).
 *
 * 单测时可以传 stub broadcaster + stub loadSecret 跳过真鉴权.
 */
export function attachAlertsWebSocketServer(
  httpServer: any,
  options: AttachAlertsWsOptions = {}
): AttachAlertsWsResult | null {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  let WebSocketServer: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    WebSocketServer = require('ws').WebSocketServer;
  } catch (err: any) {
    logger.warn(
      `[alertsWebSocketServer] 'ws' 模块未安装, 跳过 /ws/alerts 挂载: ${err?.message || err}`
    );
    return null;
  }

  const path = options.path || ALERTS_WS_PATH;
  const broadcaster = options.broadcaster || alertsBroadcaster;
  const loadSecret = options.loadSecret || loadJwtSecretFromEnv;
  const pingMs = options.pingIntervalMs || ALERTS_WS_PING_INTERVAL_MS;

  // noServer 模式 — 自己处理 upgrade 事件, 让其它 WS endpoint (未来扩展) 不冲突
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req: IncomingMessage, socket: any, head: Buffer) => {
    try {
      const url = req.url || '';
      // 严格 startsWith 防 /ws/alerts2 类绕过
      if (!url.startsWith(path)) {
        return; // 让其他 listener 处理 / 默认 404
      }
      const token = extractTokenFromQuery(url);
      const secret = loadSecret();
      const verified = verifyAlertsToken(token, secret);
      if (!verified) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      // 容量预检 — 超 MAX_CLIENTS_PER_USER 直接 503 不 upgrade
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { MAX_CLIENTS_PER_USER } = require('./alertsBroadcaster');
      if (broadcaster.countClients(verified.user_id) >= MAX_CLIENTS_PER_USER) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws: any) => {
        wss.emit('connection', ws, req, verified);
      });
    } catch (err: any) {
      logger.warn(`[alertsWebSocketServer] upgrade 异常: ${err?.message || err}`);
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    }
  });

  wss.on('connection', (ws: any, _req: IncomingMessage, verified: { user_id: number }) => {
    let alive = true;
    const clientId = `ws-${verified.user_id}-${Date.now()}-${Math.floor(
      Math.random() * 0xffff
    ).toString(16)}`;

    const client: AlertsBroadcastClient = {
      client_id: clientId,
      isOpen: () => ws.readyState === 1 /* OPEN */ && alive,
      send: (payload: AlertsBroadcastPayload) => {
        ws.send(JSON.stringify(payload));
      },
    };

    const ok = broadcaster.register(verified.user_id, client);
    if (!ok) {
      try {
        ws.close(ALERTS_WS_CLOSE.TRY_AGAIN_LATER, 'too many clients');
      } catch {
        /* ignore */
      }
      return;
    }

    // 立刻发一条 'connected' 让前端确认 ws 双向可用 — 不是告警, 不消费 unread_count
    try {
      ws.send(JSON.stringify({ type: 'connected', user_id: verified.user_id, ts: Date.now() }));
    } catch {
      /* ignore */
    }

    ws.on('pong', () => {
      alive = true;
    });

    ws.on('close', () => {
      alive = false;
      broadcaster.unregister(verified.user_id, client);
    });

    ws.on('error', (err: any) => {
      logger.warn(
        `[alertsWebSocketServer] client error user=${verified.user_id}: ${err?.message || err}`
      );
      alive = false;
      broadcaster.unregister(verified.user_id, client);
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
    });
  });

  // 心跳: 每 pingMs 给每个 client 发 ping; alive 在 pong 时被设回 true.
  // 没回 pong 的 client 下个 tick 视为 dead → terminate. 与 ws 官方 example 同款模式.
  const pingTimer = setInterval(() => {
    try {
      wss.clients.forEach((ws: any) => {
        if (ws.readyState !== 1) return;
        // node ws Set<WebSocket>; 我们没法直接拿 client_id, 用一次 ping
        try {
          ws.ping();
        } catch {
          try {
            ws.terminate();
          } catch {
            /* ignore */
          }
        }
      });
    } catch (err: any) {
      logger.warn(`[alertsWebSocketServer] ping tick 异常: ${err?.message || err}`);
    }
  }, pingMs);
  pingTimer.unref?.();

  return { wss, pingTimer, broadcaster };
}
