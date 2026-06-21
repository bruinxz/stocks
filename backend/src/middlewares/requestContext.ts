/**
 * US-097 [OPS-008] requestContextMiddleware — HTTP 入口 trace_id 注入器.
 *
 * 行为:
 *   1. 读 incoming header `x-request-id` (或 `x-trace-id`), 没有则 generateTraceId() 新建
 *   2. 回写 `x-request-id` response header 让前端 / nginx access log 也能 grep
 *   3. 在 AsyncLocalStorage 子作用域内调 next(), 之后整个 request 链路的 logger.* 都自动
 *      携带 trace_id + module='http'
 *
 * 必须挂在所有 route 之前 — 与 httpMetricsMiddleware 同位置.
 * Express 5+ async-iter aware 不需要手动 try-catch wrap.
 *
 * 替代不去碰 cls-hooked: AsyncLocalStorage 是 Node 内置 + V8 async hooks 原生支持,
 * 跨 Promise / setImmediate / setTimeout 全自动传播, 比 cls-hooked monkey-patch 安全.
 */
import { Request, Response, NextFunction } from 'express';
import { generateTraceId, runWithLoggingContext } from '../utils/loggingContext';

const TRACE_ID_HEADER = 'x-request-id';
const TRACE_ID_HEADER_ALT = 'x-trace-id';
/** 防恶意注入: trace_id 仅允许 hex / dash / 字母数字 + 长度 cap 128. */
const TRACE_ID_REGEX = /^[A-Za-z0-9-]{1,128}$/;

/**
 * pure helper — 从 req.headers 解析合法 trace_id, 不合法返 null (caller 调 generateTraceId 兜底).
 */
export function extractIncomingTraceId(headers: Record<string, unknown>): string | null {
  const raw =
    (headers[TRACE_ID_HEADER] as string | undefined) ||
    (headers[TRACE_ID_HEADER_ALT] as string | undefined);
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!TRACE_ID_REGEX.test(trimmed)) return null;
  return trimmed;
}

export function requestContextMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const incoming = extractIncomingTraceId(req.headers as Record<string, unknown>);
    const traceId = incoming || generateTraceId();

    // 回写 header 让 client / nginx 也能 grep
    try {
      res.setHeader(TRACE_ID_HEADER, traceId);
    } catch {
      // headers 已 sent (理论不会, 此 middleware 在最前) — 忽略
    }

    // 暴露给业务 handler 偶尔需要 (e.g. 写 audit 时显式传)
    (req as any).trace_id = traceId;

    runWithLoggingContext({ trace_id: traceId, module: 'http' }, () => next());
  };
}

export { TRACE_ID_HEADER, TRACE_ID_HEADER_ALT };
