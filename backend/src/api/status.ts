/**
 * ADR-0010 §4.3 Phase 3 canonical · `/api/v1/status` — API 契约级状态 probe.
 *
 * 与 `/health` 差异: 后者 = k8s liveness/readiness 基础存活 (无 API 契约深化),
 * 本端点 = API 契约级 (前端 version negotiation / monitor scrape).
 *
 * response shape:
 *   { api_version: '1.0', supported_api_versions: [1],
 *     build_version: '1.4.2', uptime_seconds: 123.4,
 *     timestamp: '2026-07-10T02:20:30.123Z' }
 *
 * 无鉴权 · 版本信息公开无 secret (与 /health 语义对称).
 */
import type { Request, Response } from 'express';
import { CURRENT_API_VERSION, SUPPORTED_API_VERSIONS } from '../middlewares/apiVersion';
import pkg from '../../package.json';

const BUILD_VERSION: string = (pkg as { version?: string }).version ?? 'unknown';

export function statusHandler(_req: Request, res: Response): void {
  res.json({
    api_version: CURRENT_API_VERSION,
    supported_api_versions: SUPPORTED_API_VERSIONS,
    build_version: BUILD_VERSION,
    uptime_seconds: process.uptime(),
    timestamp: new Date().toISOString(),
  });
}
