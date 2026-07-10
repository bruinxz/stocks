/**
 * apiReportingEndpoints.ts — ADR-0010 §4.11 · W3C Reporting API L1
 * (Working Draft · https://www.w3.org/TR/reporting-1/ · Ilya Grigorik +
 * Douglas Creager) browser error-reporting endpoint declaration advisory
 * header.
 *
 * Reads optional `api_reporting_endpoints` block from `backend/package.json`:
 *   {
 *     "api_reporting_endpoints": {
 *       "endpoints": [
 *         { "name": "default",      "url": "/api/v1/reports/default" },
 *         { "name": "csp-endpoint", "url": "/api/v1/reports/csp" }
 *       ],
 *       "legacy_report_to": true,
 *       "max_age": 86400
 *     }
 *   }
 *
 * 无 config → middleware zero-emit (default OFF). Empty / all-invalid
 * endpoints → also zero-emit. Advisory-only (§4.11 does NOT enforce
 * navigation or short-circuit; pure header pass-through per Reporting
 * API L1 §3.1 structured-field dictionary emission).
 *
 * Header shape (W3C Reporting API L1 · §3.1):
 *   Reporting-Endpoints = <name>="<url>", <name2>="<url2>"
 *     (structured-field dictionary per RFC 8941 §3.2)
 *   Report-To          = <JSON group object>[, <group2>]
 *     (legacy · Reporting API Editor's Draft older syntax;
 *      Chromium ≤95 relied on Report-To before Reporting-Endpoints
 *      landed in Chromium 96 · Nov 2021)
 *
 * Implementation: patches res.writeHead in-place (§4.7 + §4.8 + §4.9 +
 * §4.10 pattern mirror · header emit at header-flush time so cross-cutting
 * middleware ordering doesn't matter · APPEND-safe when the route handler
 * pre-sets either header · RFC 8941 §3.2 dictionary canonical composable).
 *
 * Route-authority-wins-APPEND: if the route pre-sets Reporting-Endpoints
 * / Report-To, our advisory value is APPENDED as an additional list entry
 * per RFC 8941 §3.2 dictionary + §3.3 list list-value semantics · both
 * headers remain single-value logical composites where later entries do
 * not override earlier ones (dictionary keys collide → route's key wins
 * because it appears first; our advisory-only appends new keys).
 *
 * Orch v253 §四 A-3 dispatch matrix Option (A): §4.11 Reporting-Endpoints
 * + Report-To explicit CREATE-AUTHORIZE (msg=83949598).
 *
 * Attribution: W3C Reporting API L1 (Working Draft · Ilya Grigorik +
 * Douglas Creager · https://www.w3.org/TR/reporting-1/) · RFC 8941
 * Structured Fields (Feb 2021 · Mark Nottingham + Poul-Henning Kamp ·
 * IETF) §3.2 dictionary + §3.3 list canonical · RFC 7230 §3.2.6 token
 * grammar (June 2014 · IETF · Roy Fielding + Julian Reschke) · pattern-
 * mirror §4.10 Web Linking writeHead-monkeypatch structure per
 * msg=ad6585cf 借鉴 独立性 铁律 · structural template ≠ code-copy ·
 * zero external npm dependency (no `reporting-api-*` runtime lib).
 */
import type { Request, Response, NextFunction } from 'express';
import pkg from '../../package.json';

export interface ReportingEndpoint {
  name: string;
  url: string;
}

export interface ReportingEndpointsConfig {
  endpoints?: ReportingEndpoint[];
  legacy_report_to?: boolean;
  max_age?: number;
}

const PKG_REPORTING_ENDPOINTS_CONFIG: ReportingEndpointsConfig | null =
  (pkg as { api_reporting_endpoints?: ReportingEndpointsConfig })
    .api_reporting_endpoints ?? null;

// RFC 7230 §3.2.6 token grammar. Reporting-Endpoints dictionary keys per
// RFC 8941 §3.2 use the same token character set (lcalpha / DIGIT / "_"
// / "-" / "." / "*"). We accept the broader HTTP token set; validation
// primarily rejects SP / DQUOTE / control chars / separators.
const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

// Simple non-empty URL filter — same as §4.10 URI_REF_INVALID_RE: rejects
// control chars / DQUOTE / less-than / greater-than (which would break
// RFC 8941 §3.2 dictionary quoted-string param values). Full RFC 3986
// validation deferred to downstream consumers.
const URL_INVALID_RE = /[\x00-\x1f\x7f<>"]/;

// Max-Age default (Reporting API L1 §3.2 · 24h) and hard-cap upper bound
// (30 days) to prevent config accidents.
const DEFAULT_MAX_AGE = 86400;
const MAX_AGE_CAP = 30 * 86400;

export function isValidReportingEndpoint(ep: unknown): ep is ReportingEndpoint {
  if (!ep || typeof ep !== 'object') return false;
  const e = ep as Record<string, unknown>;
  if (typeof e.name !== 'string' || e.name.length === 0) return false;
  if (!TOKEN_RE.test(e.name)) return false;
  if (typeof e.url !== 'string' || e.url.length === 0) return false;
  if (URL_INVALID_RE.test(e.url)) return false;
  return true;
}

// RFC 8941 §3.2 dictionary quoted-string canonical.
function quoteString(s: string): string {
  return `"${s}"`;
}

export function formatReportingEndpoints(endpoints: ReportingEndpoint[]): string {
  return endpoints.map((e) => `${e.name}=${quoteString(e.url)}`).join(', ');
}

export function formatReportTo(
  endpoints: ReportingEndpoint[],
  maxAge: number,
): string {
  // Report-To legacy is a JSON structured-field-list-of-groups per the
  // older Reporting API Editor's Draft (Chromium ≤95 canonical). One
  // logical group named "default" with all endpoints; downstream UAs
  // that support Reporting-Endpoints will ignore Report-To.
  const group = {
    group: 'default',
    max_age: maxAge,
    endpoints: endpoints.map((e) => ({ url: e.url })),
  };
  return JSON.stringify(group);
}

function clampMaxAge(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return DEFAULT_MAX_AGE;
  if (v > MAX_AGE_CAP) return MAX_AGE_CAP;
  return Math.floor(v);
}

function appendHeader(
  res: Response,
  name: string,
  value: string,
): void {
  const existing = res.getHeader(name);
  if (existing === undefined || existing === null || existing === '') {
    res.setHeader(name, value);
  } else if (typeof existing === 'string') {
    res.setHeader(name, `${existing}, ${value}`);
  } else if (Array.isArray(existing)) {
    res.setHeader(name, [...existing.map(String), value]);
  } else {
    // number or other: coerce to string
    res.setHeader(name, `${String(existing)}, ${value}`);
  }
}

export function buildApiReportingEndpointsMiddleware(
  config: ReportingEndpointsConfig | null,
) {
  const endpoints = (config?.endpoints ?? []).filter(isValidReportingEndpoint);
  const legacyReportTo = config?.legacy_report_to === true;
  const maxAge = clampMaxAge(config?.max_age);
  return (_req: Request, res: Response, next: NextFunction) => {
    if (endpoints.length === 0) {
      return next();
    }
    const origWriteHead = res.writeHead.bind(res);
    (res as unknown as { writeHead: (...args: unknown[]) => Response }).writeHead =
      function patchedWriteHead(this: Response, ...args: unknown[]): Response {
        appendHeader(res, 'Reporting-Endpoints', formatReportingEndpoints(endpoints));
        if (legacyReportTo) {
          appendHeader(res, 'Report-To', formatReportTo(endpoints, maxAge));
        }
        return (origWriteHead as (...a: unknown[]) => Response)(...args);
      };
    next();
  };
}

export const apiReportingEndpointsMiddleware = () =>
  buildApiReportingEndpointsMiddleware(PKG_REPORTING_ENDPOINTS_CONFIG);

export const CURRENT_REPORTING_ENDPOINTS_CONFIG = PKG_REPORTING_ENDPOINTS_CONFIG;
