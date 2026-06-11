import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { Op } from 'sequelize';
import { LiveBrokerAccount } from '../../models/LiveBrokerAccount';
import { LiveExecutionAuditLog } from '../../models/LiveExecutionAuditLog';
import { LiveBridgeNonce } from '../../models/LiveBridgeNonce';
import { logger } from '../../utils/logger';
import { LIVE_AUDIT_EVENT_TYPES } from '../auditEvents';

/**
 * Bridge 鉴权中间件。路线图 §6.1。
 *
 * 头部：
 *   X-Live-Bridge-Key       桥接密钥 ID（不是 secret 本身）
 *   X-Live-Bridge-Timestamp UTC 毫秒
 *   X-Live-Bridge-Nonce     每请求唯一，5 分钟滑动窗口去重
 *   X-Live-Bridge-Signature HMAC-SHA256（method + path + query + timestamp + nonce + body_hash）
 *
 * 校验流程（review 修订）：
 *  1. Content-Type 必须 application/json（写请求）— 防止 verify 不触发使 rawBody=undefined 拿空 hash 通过
 *  2. timestamp clock skew ≤ LIVE_BRIDGE_MAX_CLOCK_SKEW_SECONDS（默认 60s）
 *  3. 签名校验（包含 query 防止重放篡改）
 *  4. bridge_key 必须存在于 live_broker_accounts 且 is_active
 *  5. 通过后才尝试 INSERT live_bridge_nonces：失败=重放
 *
 * 跨进程/跨重启去重靠 DB 唯一约束（之前内存 Map 在水平扩展或重启时全失效）。
 */

function loadSecrets(): Record<string, string> {
  const explicit = process.env.LIVE_BRIDGE_SECRETS;
  if (explicit) {
    try {
      const parsed = JSON.parse(explicit);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, string>;
    } catch (err: any) {
      logger.error('LIVE_BRIDGE_SECRETS 不是合法 JSON:', err?.message || err);
    }
  }
  const singleKey = process.env.LIVE_BRIDGE_KEY;
  const singleSecret = process.env.LIVE_BRIDGE_SECRET;
  if (singleKey && singleSecret) return { [singleKey]: singleSecret };
  return {};
}

function safeEqual(a: string, b: string): boolean {
  const buf1 = Buffer.from(a, 'utf8');
  const buf2 = Buffer.from(b, 'utf8');
  if (buf1.length !== buf2.length) return false;
  try {
    return crypto.timingSafeEqual(buf1, buf2);
  } catch {
    return false;
  }
}

function computeSignature(secret: string, baseString: string): string {
  return crypto.createHmac('sha256', secret).update(baseString, 'utf8').digest('hex');
}

function hashBody(rawBody: string | undefined): string {
  return crypto.createHash('sha256').update(rawBody || '', 'utf8').digest('hex');
}

/**
 * 规范化 query string，避免两端实现差异 / 中间代理重写导致签名不一致：
 *  - 解析所有 (key, value) 对（支持重复 key 数组）
 *  - 按 key 升序、同 key 内 value 升序
 *  - 用 RFC3986 percent-encode（空格 → %20，而不是 +）
 *  - 用 '&' 拼接，不带前导 '?'
 */
function canonicalizeQuery(rawQuery: string): string {
  if (!rawQuery) return '';
  const pairs: Array<[string, string]> = [];
  for (const part of rawQuery.split('&')) {
    if (!part) continue;
    const eqIdx = part.indexOf('=');
    const k = eqIdx >= 0 ? part.slice(0, eqIdx) : part;
    const v = eqIdx >= 0 ? part.slice(eqIdx + 1) : '';
    // decode 后再用 encodeURIComponent 规范化（空格转 %20，+ 不再特殊）
    let dk: string;
    let dv: string;
    try {
      dk = decodeURIComponent(k.replace(/\+/g, '%20'));
    } catch {
      dk = k;
    }
    try {
      dv = decodeURIComponent(v.replace(/\+/g, '%20'));
    } catch {
      dv = v;
    }
    pairs.push([encodeURIComponent(dk), encodeURIComponent(dv)]);
  }
  pairs.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

export interface BridgeAuthContext {
  bridge_key: string;
  account_id: number;
  user_id: number;
  account: LiveBrokerAccount;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      bridgeAuth?: BridgeAuthContext;
      rawBody?: string;
    }
  }
}

// 启动后定期清理过期 nonce 行（DB 内存都行），避免表无限增长
let cleanupStarted = false;
function startNonceCleanup() {
  if (cleanupStarted) return;
  cleanupStarted = true;
  const interval = Math.max(Number(process.env.LIVE_BRIDGE_NONCE_CLEANUP_INTERVAL_MS || 60_000), 10_000);
  setInterval(async () => {
    try {
      await LiveBridgeNonce.destroy({
        where: { expires_at: { [Op.lt]: new Date() } },
      });
    } catch (err: any) {
      logger.warn('bridge nonce cleanup failed:', err?.message || err);
    }
  }, interval).unref?.();
}

function isBridgeDisabled(): boolean {
  const raw = String(process.env.LIVE_BRIDGE_ENABLED || '').toLowerCase();
  return ['false', '0', 'off', 'no'].includes(raw);
}

export async function bridgeAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<any> {
  startNonceCleanup();

  if (isBridgeDisabled()) {
    return res.status(503).json({ success: false, message: 'bridge 接入已被 LIVE_BRIDGE_ENABLED=false 禁用' });
  }

  // 写请求必须 application/json，且只接受前缀匹配；防止 multipart 等让 verify 不触发拿空 body hash 通过
  if (req.method !== 'GET') {
    const ct = String(req.headers['content-type'] || '').toLowerCase().trim();
    if (!/^application\/json(\s*;|$)/.test(ct)) {
      return res
        .status(415)
        .json({ success: false, message: 'bridge 写请求 Content-Type 必须为 application/json' });
    }
  }

  const bridgeKey = String(req.header('X-Live-Bridge-Key') || '').trim();
  const timestamp = String(req.header('X-Live-Bridge-Timestamp') || '').trim();
  const nonce = String(req.header('X-Live-Bridge-Nonce') || '').trim();
  const signature = String(req.header('X-Live-Bridge-Signature') || '').trim();

  if (!bridgeKey || !timestamp || !nonce || !signature) {
    return res.status(401).json({
      success: false,
      message: '缺少 bridge 鉴权头：X-Live-Bridge-Key / Timestamp / Nonce / Signature',
    });
  }
  if (nonce.length < 8 || nonce.length > 80) {
    return res.status(401).json({ success: false, message: 'X-Live-Bridge-Nonce 长度非法（8-80）' });
  }

  const tsMs = Number(timestamp);
  if (!Number.isFinite(tsMs)) {
    return res.status(401).json({ success: false, message: 'X-Live-Bridge-Timestamp 不是合法毫秒数' });
  }
  const skewLimitSeconds = Number(process.env.LIVE_BRIDGE_MAX_CLOCK_SKEW_SECONDS || 60);
  const skewSeconds = Math.abs(Date.now() - tsMs) / 1000;
  if (skewSeconds > skewLimitSeconds) {
    return res.status(401).json({
      success: false,
      message: `bridge 请求时钟偏差 ${skewSeconds.toFixed(1)}s 超过 ${skewLimitSeconds}s`,
    });
  }

  const secrets = loadSecrets();
  const secret = secrets[bridgeKey];
  if (!secret) {
    return res.status(401).json({ success: false, message: 'bridge_key 未注册或缺少 secret' });
  }

  // 签名串：method + path + canonical_query + timestamp + nonce + body_hash
  // canonical_query 把 query 字段按 key 排序、值用 RFC3986 编码（空格 → %20），
  // 避免两端实现差异 / 中间代理重写 query string 导致签名不一致。
  const url = req.originalUrl || req.url;
  const qIdx = url.indexOf('?');
  const path = qIdx >= 0 ? url.slice(0, qIdx) : url;
  const rawQuery = qIdx >= 0 ? url.slice(qIdx + 1) : '';
  const canonicalQuery = canonicalizeQuery(rawQuery);
  const baseString = [
    req.method.toUpperCase(),
    path,
    canonicalQuery,
    timestamp,
    nonce,
    hashBody(req.rawBody),
  ].join('\n');
  const expected = computeSignature(secret, baseString);
  if (!safeEqual(signature, expected)) {
    return res.status(401).json({ success: false, message: 'bridge 签名校验失败' });
  }

  // bridge_key 必须独占绑定一个活跃账户
  const account = await LiveBrokerAccount.findOne({
    where: { bridge_key: bridgeKey, is_active: true },
  });
  if (!account) {
    return res.status(401).json({
      success: false,
      message: 'bridge_key 没有绑定到任何活跃账户；请运维先绑定 live_broker_accounts.bridge_key',
    });
  }

  // 签名 + 账户都通过后，再 INSERT nonce 行：冲突=重放（DB PK 兜底，跨进程跨重启）
  const nonceWindowMs = Math.max(Number(process.env.LIVE_BRIDGE_NONCE_WINDOW_SECONDS || 300), 60) * 1000;
  try {
    await LiveBridgeNonce.create({
      nonce,
      bridge_key: bridgeKey,
      expires_at: new Date(Date.now() + nonceWindowMs),
    } as any);
  } catch (err: any) {
    const code = (err && (err.original?.code || err.parent?.code)) || '';
    if (String(err?.name || '') === 'SequelizeUniqueConstraintError' || code === '23505') {
      return res.status(401).json({ success: false, message: '重复的 X-Live-Bridge-Nonce（重放被拒绝）' });
    }
    logger.error('bridge nonce 入库失败:', err?.message || err);
    return res.status(500).json({ success: false, message: 'bridge nonce 入库失败' });
  }

  req.bridgeAuth = {
    bridge_key: bridgeKey,
    account_id: Number((account as any).id),
    user_id: Number((account as any).user_id),
    account,
  };

  // 审计：仅记录写类型请求，避免长轮询 GET 把表写爆
  if (req.method !== 'GET') {
    try {
      await LiveExecutionAuditLog.create({
        user_id: Number((account as any).user_id),
        account_id: Number((account as any).id),
        event_type: LIVE_AUDIT_EVENT_TYPES.BRIDGE_REQUEST,
        severity: 'info',
        message: `bridge 请求 ${req.method} ${req.originalUrl}`,
        before_state: {},
        after_state: {},
        metadata: {
          bridge_key: bridgeKey,
          path: req.originalUrl,
          method: req.method,
          timestamp_ms: tsMs,
          clock_skew_seconds: Math.round(skewSeconds),
        },
      } as any);
    } catch (err: any) {
      logger.warn('bridge 鉴权审计写入失败:', err?.message || err);
    }
  }

  next();
}
