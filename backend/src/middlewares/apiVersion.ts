/**
 * apiVersion.ts — ADR-0010 §4.1 · X-API-Version response header middleware (Phase 1).
 *
 * Reads `api_version` from `backend/package.json` (a field distinct from
 * `version` — build/pkg version and API-contract version are orthogonal per
 * Orch v131 §二(6)). Injects `X-API-Version` on every response so both the
 * legacy `/api/*` mounts and the new `/api/v1/*` mounts emit the header.
 *
 * ADR-0010 §4.3 (Phase 3 partial · surfaced ahead so /health can advertise
 * `supported_api_versions` without a second landing): SUPPORTED_API_VERSIONS
 * is the canonical list of major versions this backend currently accepts.
 * Derived from CURRENT_API_VERSION (e.g. '1.0' → [1]). When v2 dual-mount
 * lands per §2.5 (≥1 sprint window), extend to [1, 2] here — /health picks
 * it up automatically.
 */
import type { Request, Response, NextFunction } from 'express';
import pkg from '../../package.json';

const API_VERSION: string = (pkg as { api_version?: string }).api_version ?? '1.0';

function deriveSupportedMajors(version: string): readonly number[] {
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  return Number.isFinite(major) && major > 0 ? [major] : [1];
}

export function apiVersionMiddleware() {
  return (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-API-Version', API_VERSION);
    next();
  };
}

export const CURRENT_API_VERSION = API_VERSION;
export const SUPPORTED_API_VERSIONS: readonly number[] = Object.freeze(
  deriveSupportedMajors(API_VERSION)
);
