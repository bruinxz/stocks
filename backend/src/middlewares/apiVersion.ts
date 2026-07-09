/**
 * apiVersion.ts — ADR-0010 §4.1 · X-API-Version response header middleware (Phase 1).
 *
 * Reads `api_version` from `backend/package.json` (a field distinct from
 * `version` — build/pkg version and API-contract version are orthogonal per
 * Orch v131 §二(6)). Injects `X-API-Version` on every response so both the
 * legacy `/api/*` mounts and the new `/api/v1/*` mounts emit the header.
 */
import type { Request, Response, NextFunction } from 'express';
import pkg from '../../package.json';

const API_VERSION: string = (pkg as { api_version?: string }).api_version ?? '1.0';

export function apiVersionMiddleware() {
  return (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-API-Version', API_VERSION);
    next();
  };
}

export const CURRENT_API_VERSION = API_VERSION;
