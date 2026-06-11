import { Request, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../middlewares/auth';
import { logger } from '../../utils/logger';

/**
 * 实盘接口 rate limiter（进程内、按 user_id + 接口 key 维度）。
 *
 * 上线 launch-helper：防止偶发脚本 / 被窃 token 短时间灌爆下单/撤单/熔断接口。
 *
 * 设计：
 *   - 不引入新 npm 依赖（express-rate-limit）；进程内 Map 滑动窗口已足够灰度阶段。
 *   - 多副本部署时不共享；如果走 nginx upstream，需要把 ip_hash 开开避免穿透
 *     （或后续切到 redis backend；本文件留扩展点）。
 *   - 命中限流返回 429 + Retry-After，并写一条 audit 落地，方便事后追查。
 *   - 限流的 key 是 `userId|name`，未登录用 ip 兜底，但实盘路由都过 authenticate，
 *     所以正常路径一定有 userId。
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
const SWEEP_INTERVAL_MS = 60_000;

let sweepStarted = false;
function startSweep() {
  if (sweepStarted) return;
  sweepStarted = true;
  const t = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of buckets) {
      if (v.resetAt <= now) buckets.delete(k);
    }
  }, SWEEP_INTERVAL_MS);
  t.unref?.();
}

export interface RateLimitOptions {
  /** 限流逻辑名（同一个 user 跨接口隔离） */
  name: string;
  /** 窗口长度（毫秒） */
  windowMs: number;
  /** 窗口内最大次数 */
  max: number;
}

function keyFor(req: AuthenticatedRequest, name: string): string {
  const userId = req.user?.id;
  if (userId) return `u:${userId}|${name}`;
  // 实盘路由理论上都过 authenticate；走到这里说明 authenticate 漏挂
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  return `ip:${String(ip)}|${name}`;
}

export function liveTradingRateLimit(options: RateLimitOptions) {
  startSweep();
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = keyFor(req, options.name);
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + options.windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    const remaining = Math.max(0, options.max - bucket.count);
    res.setHeader('X-RateLimit-Limit', String(options.max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));
    if (bucket.count > options.max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      logger.warn(
        `[rateLimit] ${options.name} blocked key=${key} count=${bucket.count}/${options.max} retry=${retryAfter}s`
      );
      return res.status(429).json({
        success: false,
        message: `请求过于频繁；请 ${retryAfter}s 后重试`,
        code: 'rate_limited',
        retry_after_seconds: retryAfter,
      });
    }
    next();
  };
}

/**
 * 实盘场景预设。可以直接挂到 route 上，含义见各注释。
 * 数值是灰度阶段建议；后续放量再调。
 *
 * 改之前先翻 docs/live_trading_launch_checklist.md §1.2 风控段，
 * 让 LIVE_RISK_MAX_DAILY_ORDER_COUNT 与这里的 max 不冲突。
 */
export const LIVE_TRADING_RATE_LIMITS = {
  // 真实下单确认：每分钟 ≤5；每小时 ≤20。配合 LIVE_RISK_MAX_DAILY_ORDER_COUNT 形成多层防御
  approveDraft1m: liveTradingRateLimit({ name: 'approveDraft.1m', windowMs: 60_000, max: 5 }),
  approveDraft1h: liveTradingRateLimit({ name: 'approveDraft.1h', windowMs: 60 * 60_000, max: 20 }),

  // 撤单：每分钟 ≤10（用户可能针对多笔同时点）
  cancelOrder1m: liveTradingRateLimit({ name: 'cancelOrder.1m', windowMs: 60_000, max: 10 }),

  // 创建草稿：每分钟 ≤15
  createDraft1m: liveTradingRateLimit({ name: 'createDraft.1m', windowMs: 60_000, max: 15 }),

  // shadow autopilot：本身就是批量操作，每分钟 ≤3 次调用
  runShadowAutopilot1m: liveTradingRateLimit({
    name: 'runShadowAutopilot.1m',
    windowMs: 60_000,
    max: 3,
  }),

  // kill switch trigger/resolve：仅 admin 能调；额外限速防止 admin token 被窃
  killSwitchTrigger1m: liveTradingRateLimit({
    name: 'killSwitch.trigger.1m',
    windowMs: 60_000,
    max: 5,
  }),
  killSwitchResolve1m: liveTradingRateLimit({
    name: 'killSwitch.resolve.1m',
    windowMs: 60_000,
    max: 5,
  }),

  // 只读同步：相对宽松
  syncReadonly1m: liveTradingRateLimit({
    name: 'syncReadonly.1m',
    windowMs: 60_000,
    max: 20,
  }),
};

/** 测试用：清空状态 */
export function __resetRateLimiterForTests() {
  buckets.clear();
}
