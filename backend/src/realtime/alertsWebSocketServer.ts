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
 *   - verifyAlertsToken(token, secret) 复用 HTTP access-token 的严格
 *     type/aud/iss/algorithm/expiry 契约；旧 token shape 不再兼容;
 *   - secret 来源同 middlewares/auth.ts: process.env.JWT_SECRET，且 access /
 *     refresh secret 必须均存在并相互独立；配置无效返 null
 *     (拒所有连接, 关闭 code 1008 'policy violation').
 *
 * 生命周期:
 *   - 连接成功: broadcaster.register(user_id, client); client.send 一条 'connected' 不算告警
 *   - 客户端 close / 服务端检测到 stale (ping/pong) → broadcaster.unregister
 *   - 单 user 超 MAX_CLIENTS_PER_USER → 直接 close 1013 (try again later)
 *
 * 错误兜底 (fail-CLOSED):
 *   - JWT_SECRET 缺失 → 整个 WS server 拒所有连接, 但不 throw 不阻塞 HTTP server
 *   - access-token strict verify 失败 / 无 token → close 1008 关闭
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

import { logger } from '../utils/logger';
import { randHex4 } from '../utils/randomHex';
import { User } from '../models/User';
import {
  authJwtSecretsAreUsable,
  resolveRefreshTokenSecret,
  verifyAccessToken,
} from '../middlewares/auth';
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
 * 从 ?token=... 提取 JWT. 缺失 / 空串 → null. 不做格式校验, 由严格 access verifier 处理.
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
 * 解析严格 access JWT → user_id. 任何签名、算法、type、aud、iss、expiry
 * 或 identity claim 不符合 HTTP auth 契约时均返回 null。
 */
export function verifyAlertsToken(
  token: string | null,
  secret: string | null | undefined
): { user_id: number; username?: string; expires_at_ms: number } | null {
  if (!token || !secret) return null;
  const decoded = verifyAccessToken(token, secret);
  if (!decoded) return null;
  return {
    user_id: decoded.user_id,
    username: decoded.username,
    expires_at_ms: Number(decoded.exp) * 1_000,
  };
}

/** Resolve current account state at the connection boundary; failures deny access. */
export async function resolveActiveAlertsUser(user_id: number): Promise<boolean> {
  try {
    const user = await User.findByPk(user_id, { attributes: ['id', 'is_active'] });
    return Boolean(user?.is_active);
  } catch {
    logger.error('[alertsWebSocketServer] active-user lookup failed');
    return false;
  }
}

/**
 * 取当前进程 JWT secret. 单一事实源, 与 middlewares/auth.ts 行为一致。
 * access/refresh 任一缺失或二者相同都 fail-closed；access secret 不再使用
 * 独立的 WebSocket-only fallback。
 */
export function loadJwtSecretFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const primary = env.JWT_SECRET;
  if (typeof primary !== 'string') return null;
  const refresh = resolveRefreshTokenSecret(env);
  return authJwtSecretsAreUsable(primary, refresh) ? primary : null;
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
  /** override current-account lookup; defaults to fail-closed Sequelize lookup */
  resolveActiveUser?: (user_id: number) => Promise<boolean>;
  /** deterministic clock seam for expiry tests */
  now?: () => number;
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
  const resolveActiveUser = options.resolveActiveUser || resolveActiveAlertsUser;
  const now = options.now || Date.now;

  // noServer 模式 — 自己处理 upgrade 事件, 让其它 WS endpoint (未来扩展) 不冲突
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', async (req: IncomingMessage, socket: any, head: Buffer) => {
    try {
      const url = req.url || '';
      if (new URL(url, 'http://_/').pathname !== path) {
        return; // 让其他 listener 处理 / 默认 404
      }
      const token = extractTokenFromQuery(url);
      const secret = loadSecret();
      const verified = verifyAlertsToken(token, secret);
      if (
        !verified ||
        verified.expires_at_ms <= now() ||
        !(await resolveActiveUser(verified.user_id))
      ) {
        if (socket.destroyed) return;
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

  wss.on(
    'connection',
    (ws: any, _req: IncomingMessage, verified: { user_id: number; expires_at_ms: number }) => {
      let alive = true;
      const clientId = `ws-${verified.user_id}-${now()}-${randHex4()}`;
      const expiryDelay = Math.max(0, Math.min(verified.expires_at_ms - now(), 2_147_483_647));
      const expiryTimer = setTimeout(() => {
        alive = false;
        try {
          ws.close(ALERTS_WS_CLOSE.POLICY_VIOLATION, 'access token expired');
        } catch {
          try {
            ws.terminate();
          } catch {
            // ignore an already-closed socket
          }
        }
      }, expiryDelay);
      expiryTimer.unref?.();

      const client: AlertsBroadcastClient = {
        client_id: clientId,
        isOpen: () => ws.readyState === 1 /* OPEN */ && alive,
        send: (payload: AlertsBroadcastPayload) => {
          ws.send(JSON.stringify(payload));
        },
        close: (reason: string) => {
          alive = false;
          ws.close(ALERTS_WS_CLOSE.POLICY_VIOLATION, reason);
        },
      };

      const ok = broadcaster.register(verified.user_id, client);
      if (!ok) {
        clearTimeout(expiryTimer);
        try {
          ws.close(ALERTS_WS_CLOSE.TRY_AGAIN_LATER, 'too many clients');
        } catch {
          /* ignore */
        }
        return;
      }

      // 立刻发一条 'connected' 让前端确认 ws 双向可用 — 不是告警, 不消费 unread_count
      try {
        ws.send(JSON.stringify({ type: 'connected', user_id: verified.user_id, ts: now() }));
      } catch {
        /* ignore */
      }

      ws.on('pong', () => {
        alive = true;
      });

      ws.on('close', () => {
        alive = false;
        clearTimeout(expiryTimer);
        broadcaster.unregister(verified.user_id, client);
      });

      ws.on('error', (err: any) => {
        logger.warn(
          `[alertsWebSocketServer] client error user=${verified.user_id}: ${err?.message || err}`
        );
        alive = false;
        clearTimeout(expiryTimer);
        broadcaster.unregister(verified.user_id, client);
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
      });
    }
  );

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
