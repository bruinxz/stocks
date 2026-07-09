/**
 * apiDeprecation.ts — ADR-0010 §4.4 · RFC 9745 Deprecation + RFC 8594 Sunset headers.
 *
 * Reads optional `api_deprecation` block from `backend/package.json`:
 *   {
 *     "api_deprecation": {
 *       "deprecation_ts": 1723334400,
 *       "sunset_date": "Wed, 11 Nov 2026 00:00:00 GMT",
 *       "migration_link": "https://.../v2-migration"
 *     }
 *   }
 *
 * 无 config → middleware zero-emit (default OFF). v2 dual-mount 之后 sprint 加 config
 * 触发 v1 deprecation window · consumer UI 自动 count-down.
 *
 * Orch v131 §二(6): build_version 与 API deprecation config 正交, 同 pkg.json 独立字段.
 *
 * Attribution: RFC 9745 (2024) · RFC 8594 (2019) · RFC 8288 (2017) · Google Cloud + Stripe
 * industry canonical pattern. 无外部 lib 借鉴.
 */
import type { Request, Response, NextFunction } from 'express';
import pkg from '../../package.json';

export interface DeprecationConfig {
  deprecation_ts?: number;
  sunset_date?: string;
  migration_link?: string;
}

const PKG_DEPRECATION_CONFIG: DeprecationConfig | null =
  (pkg as { api_deprecation?: DeprecationConfig }).api_deprecation ?? null;

export function buildApiDeprecationMiddleware(config: DeprecationConfig | null) {
  return (_req: Request, res: Response, next: NextFunction) => {
    if (!config) {
      return next();
    }
    const { deprecation_ts, sunset_date, migration_link } = config;
    if (typeof deprecation_ts === 'number' && Number.isFinite(deprecation_ts)) {
      res.setHeader('Deprecation', `@${deprecation_ts}`);
    }
    if (typeof sunset_date === 'string' && sunset_date.length > 0) {
      res.setHeader('Sunset', sunset_date);
    }
    if (typeof migration_link === 'string' && migration_link.length > 0) {
      const rels = ['deprecation', 'sunset']
        .map((rel) => `<${migration_link}>; rel="${rel}"`)
        .join(', ');
      res.setHeader('Link', rels);
    }
    next();
  };
}

export const apiDeprecationMiddleware = () =>
  buildApiDeprecationMiddleware(PKG_DEPRECATION_CONFIG);

export const CURRENT_DEPRECATION_CONFIG = PKG_DEPRECATION_CONFIG;
