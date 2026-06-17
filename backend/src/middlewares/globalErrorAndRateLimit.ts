/**
 * Batch R (2026-06-17, P1-2): 全局错误处理 + 基础 rate limiter.
 *
 * 设计:
 *  - errorHandler: 在所有 route 之后挂的最后一层 middleware, 把任何 controller
 *    内 throw / next(err) 序列化成统一 JSON { success: false, code, message }.
 *    生产模式不带 stack, 开发模式带; HTTP status 用 err.statusCode (默认 500).
 *
 *  - ipRateLimit: 进程内 IP 维度滑动窗口 (复用 liveTradingRateLimit 同款模式).
 *    用于 /api/auth/login + /api/auth/refresh 防暴破. 多副本部署不共享; 但配合
 *    nginx ip_hash 已经够灰度阶段; 中长期可切 Redis backend.
 */

import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

// ---------- error handler ----------

export interface AppError extends Error {
  statusCode?: number;
  code?: string;
  detail?: any;
}

export function globalErrorHandler(
  err: AppError,
  req: Request,
  res: Response,
  _next: NextFunction
) {
  const status = err.statusCode || 500;
  const isProd = process.env.NODE_ENV === 'production';
  const code = err.code || (status === 404 ? 'NOT_FOUND' : 'INTERNAL_ERROR');
  // 5xx 写 error 日志, 4xx 仅 info (避免日志噪音)
  if (status >= 500) {
    logger.error(
      `[errorHandler] ${req.method} ${req.originalUrl} → ${status} ${code}: ${err.message}`,
      err
    );
  } else {
    logger.info(
      `[errorHandler] ${req.method} ${req.originalUrl} → ${status} ${code}: ${err.message}`
    );
  }
  if (res.headersSent) {
    // 已经开始返回 (如 SSE / streaming) 时只能让 express 默认 handler 关掉连接
    return;
  }
  res.status(status).json({
    success: false,
    code,
    message: err.message || '服务器内部错误',
    ...(err.detail ? { detail: err.detail } : {}),
    ...(isProd ? {} : { stack: err.stack }),
  });
}

// ---------- ip rate limit ----------

interface Bucket {
  count: number;
  resetAt: number;
}

const ipBuckets = new Map<string, Bucket>();
const SWEEP_MS = 60_000;
let sweepStarted = false;
function startSweep() {
  if (sweepStarted) return;
  sweepStarted = true;
  const t = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of ipBuckets) {
      if (v.resetAt <= now) ipBuckets.delete(k);
    }
  }, SWEEP_MS);
  (t as any).unref?.();
}

export interface IpRateLimitOptions {
  name: string;
  windowMs: number;
  max: number;
}

export function ipRateLimit(options: IpRateLimitOptions) {
  startSweep();
  return (req: Request, res: Response, next: NextFunction) => {
    const ip =
      (req.ip as string) ||
      (Array.isArray(req.headers['x-forwarded-for'])
        ? req.headers['x-forwarded-for'][0]
        : req.headers['x-forwarded-for']) ||
      'unknown';
    const key = `${String(ip)}|${options.name}`;
    const now = Date.now();
    const bucket = ipBuckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      ipBuckets.set(key, { count: 1, resetAt: now + options.windowMs });
      return next();
    }
    bucket.count += 1;
    if (bucket.count > options.max) {
      const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      logger.warn(
        `[ipRateLimit] ${options.name} hit limit: ip=${ip} count=${bucket.count}/${options.max} retryAfter=${retryAfterSec}s`
      );
      return res.status(429).json({
        success: false,
        code: 'RATE_LIMITED',
        message: `请求过频, 请 ${retryAfterSec} 秒后重试`,
      });
    }
    return next();
  };
}
