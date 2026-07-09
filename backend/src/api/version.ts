/**
 * ADR-0010 §4.3 Phase 3 canonical · `/api/v1/version` — build/pkg + API contract 双-字段.
 *
 * Orch v131 §二(6) canonical: build version 与 API contract version 正交
 * (build patch bump ≠ API bump). 端点必显式两字段, 让 caller 不误解.
 */
import type { Request, Response } from 'express';
import { CURRENT_API_VERSION } from '../middlewares/apiVersion';
import pkg from '../../package.json';

const BUILD_VERSION: string = (pkg as { version?: string }).version ?? 'unknown';

export function versionHandler(_req: Request, res: Response): void {
  res.json({
    build_version: BUILD_VERSION,
    api_version: CURRENT_API_VERSION,
  });
}
