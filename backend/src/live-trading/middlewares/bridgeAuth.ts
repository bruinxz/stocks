import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { Op } from 'sequelize';
import { LiveBrokerAccount } from '../../models/LiveBrokerAccount';
import { LiveExecutionAuditLog } from '../../models/LiveExecutionAuditLog';
import { LiveBridgeNonce } from '../../models/LiveBridgeNonce';
import { logger } from '../../utils/logger';
import { LIVE_AUDIT_EVENT_TYPES } from '../auditEvents';

/**
 * Bridge 鉴权中间件。路线图 §6.1 + US-109 [EX-009] ed25519 升级。
 *
 * 头部：
 *   X-Live-Bridge-Key        桥接密钥 ID（不是 secret 本身）
 *   X-Live-Bridge-Timestamp  UTC 毫秒
 *   X-Live-Bridge-Nonce      每请求唯一，5 分钟滑动窗口去重
 *   X-Live-Bridge-Signature  签名 hex
 *   X-Live-Bridge-Sig-Method 可选: "hmac"（默认，兼容老 bridge）或 "ed25519"（US-109 新路径）
 *
 * 校验流程（review 修订）：
 *  1. Content-Type 必须 application/json（写请求）— 防止 verify 不触发使 rawBody=undefined 拿空 hash 通过
 *  2. timestamp clock skew ≤ LIVE_BRIDGE_MAX_CLOCK_SKEW_SECONDS（默认 60s）
 *  3. 签名校验（包含 query 防止重放篡改）
 *      - hmac: HMAC-SHA256（method + path + query + timestamp + nonce + body_hash）
 *      - ed25519: Ed25519 detached signature (同一 base string)，需要 LIVE_BRIDGE_ED25519_PUBKEYS
 *  4. bridge_key 必须存在于 live_broker_accounts 且 is_active
 *  5. 通过后才尝试 INSERT live_bridge_nonces：失败=重放
 *
 * ed25519 设计理由（C.4）: HMAC 对称密钥泄露后任何持有者都能伪造命令；ed25519 让 bridge
 * 持有 private key 签名、server 仅持 public key 验证 → 即使 server 端 env / DB 泄露
 * 也不能伪造命令。新老 bridge 同表共存（按 sig method 路由），灰度切换 0 风险。
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

/**
 * US-109 [EX-009] ed25519 升级: 加载 `{bridge_key: pubkey}` 映射. pubkey 接受三种格式
 * (按 try 顺序):
 *   1. PEM (BEGIN PUBLIC KEY...) — node createPublicKey 直吃
 *   2. base64 / hex 编码的 SPKI DER — 解码后 type:"spki"
 *   3. 32 字节裸 Ed25519 公钥 (hex 64 字符 或 base64 44 字符) — 自动拼上 SPKI 前缀
 * 解析失败的 key 直接跳过 (不阻塞其他 key), 解析结果缓存进内存避免每请求重算.
 *
 * 注: 不与 LIVE_BRIDGE_SECRETS 互斥. 一个 bridge_key 可能同时配 hmac secret + ed25519 pub
 * (灰度切换期). 真正决定走哪条 path 的是请求头 X-Live-Bridge-Sig-Method.
 */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ed25519PubkeyCache = new Map<string, crypto.KeyObject>();
let ed25519CacheRawJson: string | null = null;

export function __resetEd25519CacheForTests(): void {
  ed25519PubkeyCache.clear();
  ed25519CacheRawJson = null;
}

function parseEd25519Pubkey(raw: string): crypto.KeyObject | null {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  // PEM
  if (/-----BEGIN/.test(trimmed)) {
    try {
      return crypto.createPublicKey({ key: trimmed, format: 'pem' });
    } catch {
      // fall through
    }
  }
  // hex 64 = 32 bytes raw key
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    try {
      const buf = Buffer.from(trimmed, 'hex');
      const spki = Buffer.concat([ED25519_SPKI_PREFIX, buf]);
      return crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
    } catch {
      /* fall through */
    }
  }
  // hex DER (88 chars = 44 bytes SPKI)
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
    try {
      const buf = Buffer.from(trimmed, 'hex');
      return crypto.createPublicKey({ key: buf, format: 'der', type: 'spki' });
    } catch {
      /* fall through */
    }
  }
  // base64 (44 chars for 32-byte raw key, longer for SPKI)
  try {
    const buf = Buffer.from(trimmed, 'base64');
    if (buf.length === 32) {
      const spki = Buffer.concat([ED25519_SPKI_PREFIX, buf]);
      return crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
    }
    return crypto.createPublicKey({ key: buf, format: 'der', type: 'spki' });
  } catch {
    return null;
  }
}

function loadEd25519Pubkeys(): Record<string, crypto.KeyObject> {
  const raw = process.env.LIVE_BRIDGE_ED25519_PUBKEYS;
  if (!raw) {
    if (ed25519CacheRawJson !== null) {
      ed25519PubkeyCache.clear();
      ed25519CacheRawJson = null;
    }
    return {};
  }
  if (raw === ed25519CacheRawJson) {
    return Object.fromEntries(ed25519PubkeyCache.entries());
  }
  ed25519PubkeyCache.clear();
  ed25519CacheRawJson = raw;
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    logger.error('LIVE_BRIDGE_ED25519_PUBKEYS 不是合法 JSON:', err?.message || err);
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    logger.error('LIVE_BRIDGE_ED25519_PUBKEYS 必须是 {bridge_key: pubkey} 对象');
    return {};
  }
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v !== 'string') continue;
    const keyObj = parseEd25519Pubkey(v);
    if (keyObj) {
      ed25519PubkeyCache.set(k, keyObj);
    } else {
      logger.warn(`LIVE_BRIDGE_ED25519_PUBKEYS[${k}] 公钥解析失败, 已跳过`);
    }
  }
  return Object.fromEntries(ed25519PubkeyCache.entries());
}

export type BridgeSignatureMethod = 'hmac' | 'ed25519';

export function normalizeSigMethod(raw: string | undefined | null): BridgeSignatureMethod {
  const v = String(raw || '').toLowerCase().trim();
  if (v === 'ed25519') return 'ed25519';
  // 缺省 / hmac / 其他全部按 hmac 处理 (兼容老 bridge, 老 bridge 不发该 header)
  return 'hmac';
}

/**
 * 验证签名. 返回 {ok: true} 或 {ok: false, reason}. reason 仅用于服务端 log,
 * 不返客户端 (Batch V lt-7 fix: 401 文案统一以防 oracle 枚举).
 */
export function verifyBridgeSignature(args: {
  method: BridgeSignatureMethod;
  bridgeKey: string;
  baseString: string;
  signature: string;
  hmacSecret?: string;
  ed25519Pubkey?: crypto.KeyObject;
}): { ok: boolean; reason: string } {
  if (args.method === 'ed25519') {
    if (!args.ed25519Pubkey) {
      return { ok: false, reason: `ed25519 pubkey 未注册 bridge_key=${args.bridgeKey}` };
    }
    let sigBuf: Buffer;
    try {
      sigBuf = Buffer.from(args.signature, 'hex');
    } catch {
      return { ok: false, reason: 'ed25519 signature 非 hex' };
    }
    // Ed25519 detached signature 固定 64 字节
    if (sigBuf.length !== 64) {
      return { ok: false, reason: `ed25519 signature 长度非 64 (got ${sigBuf.length})` };
    }
    let ok = false;
    try {
      ok = crypto.verify(null, Buffer.from(args.baseString, 'utf8'), args.ed25519Pubkey, sigBuf);
    } catch (err: any) {
      return { ok: false, reason: `ed25519 verify throw: ${err?.message || err}` };
    }
    return ok
      ? { ok: true, reason: '' }
      : { ok: false, reason: `ed25519 签名校验失败 bridge_key=${args.bridgeKey}` };
  }
  // hmac
  if (!args.hmacSecret) {
    return { ok: false, reason: `bridge_key 未注册: ${args.bridgeKey}` };
  }
  const expected = computeSignature(args.hmacSecret, args.baseString);
  if (safeEqual(args.signature, expected)) return { ok: true, reason: '' };
  return { ok: false, reason: `签名校验失败 bridge_key=${args.bridgeKey}` };
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
  return crypto
    .createHash('sha256')
    .update(rawBody || '', 'utf8')
    .digest('hex');
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
  const interval = Math.max(
    Number(process.env.LIVE_BRIDGE_NONCE_CLEANUP_INTERVAL_MS || 60_000),
    10_000
  );
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
    return res
      .status(503)
      .json({ success: false, message: 'bridge 接入已被 LIVE_BRIDGE_ENABLED=false 禁用' });
  }

  // 写请求必须 application/json，且只接受前缀匹配；防止 multipart 等让 verify 不触发拿空 body hash 通过
  if (req.method !== 'GET') {
    const ct = String(req.headers['content-type'] || '')
      .toLowerCase()
      .trim();
    if (!/^application\/json(\s*;|$)/.test(ct)) {
      return res
        .status(415)
        .json({ success: false, message: 'bridge 写请求 Content-Type 必须为 application/json' });
    }
  }

  // Batch V (2026-06-17, lt-7 fix): 所有 401 改成同一文案 + 详细原因只 log 不返客户端,
  // 避免攻击者按 "bridge_key 未注册" / "签名校验失败" / "nonce 重复" / "账户未绑定"
  // 文案差异化做 oracle 枚举 bridge_key / secret / nonce state.
  // server-side log 仍保留 detail 让运维排障.
  const GENERIC_401_MSG = 'bridge 鉴权失败';
  const reject401 = (logReason: string) => {
    logger.warn(`[bridge-auth] 401: ${logReason} ip=${req.ip} ua=${req.headers['user-agent']}`);
    return res.status(401).json({ success: false, message: GENERIC_401_MSG });
  };

  const bridgeKey = String(req.header('X-Live-Bridge-Key') || '').trim();
  const timestamp = String(req.header('X-Live-Bridge-Timestamp') || '').trim();
  const nonce = String(req.header('X-Live-Bridge-Nonce') || '').trim();
  const signature = String(req.header('X-Live-Bridge-Signature') || '').trim();
  const sigMethod = normalizeSigMethod(req.header('X-Live-Bridge-Sig-Method'));

  if (!bridgeKey || !timestamp || !nonce || !signature) {
    return reject401('缺少 bridge 鉴权头');
  }
  if (nonce.length < 8 || nonce.length > 80) {
    return reject401('nonce 长度非法');
  }

  const tsMs = Number(timestamp);
  if (!Number.isFinite(tsMs)) {
    return reject401('timestamp 非法');
  }
  const skewLimitSeconds = Number(process.env.LIVE_BRIDGE_MAX_CLOCK_SKEW_SECONDS || 60);
  const skewSeconds = Math.abs(Date.now() - tsMs) / 1000;
  if (skewSeconds > skewLimitSeconds) {
    return reject401(`时钟偏差 ${skewSeconds.toFixed(1)}s 超过 ${skewLimitSeconds}s`);
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

  // sig method 路由: ed25519 走非对称, 缺省/hmac 走老的 HMAC-SHA256
  // 两条 path 共享同一 base string + nonce 表, 灰度切换零迁移成本
  const verifyResult =
    sigMethod === 'ed25519'
      ? verifyBridgeSignature({
          method: 'ed25519',
          bridgeKey,
          baseString,
          signature,
          ed25519Pubkey: loadEd25519Pubkeys()[bridgeKey],
        })
      : verifyBridgeSignature({
          method: 'hmac',
          bridgeKey,
          baseString,
          signature,
          hmacSecret: loadSecrets()[bridgeKey],
        });
  if (!verifyResult.ok) {
    return reject401(verifyResult.reason);
  }

  // bridge_key 必须独占绑定一个活跃账户
  const account = await LiveBrokerAccount.findOne({
    where: { bridge_key: bridgeKey, is_active: true },
  });
  if (!account) {
    return reject401(`bridge_key 未绑定 active account: ${bridgeKey}`);
  }

  // 签名 + 账户都通过后，再 INSERT nonce 行：冲突=重放（DB PK 兜底，跨进程跨重启）
  const nonceWindowMs =
    Math.max(Number(process.env.LIVE_BRIDGE_NONCE_WINDOW_SECONDS || 300), 60) * 1000;
  try {
    await LiveBridgeNonce.create({
      nonce,
      bridge_key: bridgeKey,
      expires_at: new Date(Date.now() + nonceWindowMs),
    } as any);
  } catch (err: any) {
    const code = (err && (err.original?.code || err.parent?.code)) || '';
    if (String(err?.name || '') === 'SequelizeUniqueConstraintError' || code === '23505') {
      return reject401(`nonce 重放: ${nonce}`);
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
          sig_method: sigMethod,
        },
      } as any);
    } catch (err: any) {
      logger.warn('bridge 鉴权审计写入失败:', err?.message || err);
    }
  }

  next();
}
