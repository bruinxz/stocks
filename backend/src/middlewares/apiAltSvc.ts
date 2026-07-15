/**
 * apiAltSvc.ts — ADR-0010 §4.12 · RFC 7838 HTTP Alternative Services
 * (Apr 2016 · Mark Nottingham + Patrick McManus + Julian Reschke · IETF ·
 * https://www.rfc-editor.org/rfc/rfc7838) alternate-transport advertisement
 * advisory header.
 *
 * Reads optional `api_alt_svc` block from `backend/package.json`:
 *   {
 *     "api_alt_svc": {
 *       "services": [
 *         { "protocol_id": "h3", "authority": ":443", "ma": 86400 },
 *         { "protocol_id": "h2", "authority": ":443", "ma": 86400 }
 *       ],
 *       "persist": false
 *     }
 *   }
 *
 * Or the special `clear` mode per RFC 7838 §3:
 *   { "api_alt_svc": { "clear": true } }
 *
 * 无 config → middleware zero-emit (default OFF). Empty / all-invalid
 * services → also zero-emit. Advisory-only (§4.12 does NOT enforce
 * navigation or short-circuit; pure header pass-through per RFC 7838 §3
 * comma-list emission).
 *
 * Header shape (RFC 7838 §3):
 *   Alt-Svc = clear
 *           / alt-value *( OWS "," OWS alt-value )
 *   alt-value  = alternative *( OWS ";" OWS parameter )
 *   alternative = protocol-id "=" alt-authority
 *   protocol-id = token         ; ALPN protocol identifier
 *   alt-authority = quoted-string  ; containing [ uri-host ] ":" port
 *   parameters  = ma / persist (extensible)
 *
 *   Example: Alt-Svc: h3=":443"; ma=86400, h2=":443"; ma=86400
 *
 * Implementation: patches res.writeHead in-place (§4.7 + §4.8 + §4.9 +
 * §4.10 + §4.11 pattern mirror · header emit at header-flush time so
 * cross-cutting middleware ordering doesn't matter · APPEND-safe when the
 * route handler pre-sets Alt-Svc · RFC 7838 §3 comma-list canonical
 * composable).
 *
 * Route-authority-wins-APPEND: if the route pre-sets Alt-Svc, our advisory
 * value is APPENDED as an additional comma-list entry per RFC 7838 §3
 * list semantics · route-set alternatives appear first · our advisory
 * alternatives append after.
 *
 * Orch v257 §零 STEP 4 dispatch: §4.12 Alt-Svc RFC 7838 explicit
 * CREATE-AUTHORIZE (msg=4073af1d) · post PR #159 §4.11 SELF-MERGE LAND
 * `ca4ccc6a` 45-段 QUADRAGESIMA-QUINTA baseline.
 *
 * Attribution: RFC 7838 HTTP Alternative Services (Apr 2016 · Mark
 * Nottingham + Patrick McManus + Julian Reschke · IETF) canonical
 * spec-only cite · pattern-mirror §4.11 Reporting-Endpoints
 * writeHead-monkeypatch structure per msg=ad6585cf 借鉴 独立性 铁律 ·
 * structural template ≠ code-copy · zero external npm dependency
 * (no `alt-svc-*` runtime lib).
 */
import type { Request, Response, NextFunction } from 'express';
import pkg from '../../package.json';

export interface AltSvcEntry {
  /** ALPN protocol identifier: "h3", "h2", "h2c", "http/1.1", etc. */
  protocol_id: string;
  /** "host:port" or ":port" (empty host means same authority per RFC 7838 §3). */
  authority: string;
  /** max-age seconds (default 86400 per RFC 7838 §3.1 default). */
  ma?: number;
  /** "persist=1" flag per RFC 7838 §3.1. */
  persist?: boolean;
}

export interface AltSvcConfig {
  services?: AltSvcEntry[];
  /** emit "Alt-Svc: clear" per RFC 7838 §3 clear pseudo-alternative. */
  clear?: boolean;
}

const PKG_ALT_SVC_CONFIG: AltSvcConfig | null =
  (pkg as { api_alt_svc?: AltSvcConfig }).api_alt_svc ?? null;

// RFC 7230 §3.2.6 token grammar. ALPN protocol-id per RFC 7838 §3 MUST be
// a token; the ALPN identifier registry (IANA) uses token-shaped strings
// like "h3", "h2", "h2c", "http/1.1" — the slash in "http/1.1" is a
// token-visible character per RFC 7230 §3.2.6, and we permit it here.
const TOKEN_RE = /^[!#$%&'*+\-./^_`|~0-9A-Za-z]+$/;

// Authority filter: rejects DQUOTE (would break RFC 7838 §3 quoted-string
// alt-authority param), control chars, and characters that would break
// quoted-string / comma-list parsing. Full RFC 3986 host validation
// deferred to downstream consumers.
const AUTHORITY_INVALID_RE = /[\x00-\x1f\x7f"\\,]/;

// Max-Age default (RFC 7838 §3.1 default 24h) and hard-cap upper bound
// (30 days) to prevent config accidents.
const DEFAULT_MA = 86400;
const MA_CAP = 30 * 86400;

export function isValidAltSvcEntry(entry: unknown): entry is AltSvcEntry {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as Record<string, unknown>;
  if (typeof e.protocol_id !== 'string' || e.protocol_id.length === 0) return false;
  if (!TOKEN_RE.test(e.protocol_id)) return false;
  if (typeof e.authority !== 'string' || e.authority.length === 0) return false;
  if (AUTHORITY_INVALID_RE.test(e.authority)) return false;
  return true;
}

export function clampMa(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return DEFAULT_MA;
  if (v > MA_CAP) return MA_CAP;
  return Math.floor(v);
}

// RFC 7838 §3 alt-authority quoted-string canonical.
function quoteAuthority(s: string): string {
  return `"${s}"`;
}

export function formatAltSvcEntry(entry: AltSvcEntry): string {
  const parts = [`${entry.protocol_id}=${quoteAuthority(entry.authority)}`];
  if (typeof entry.ma === 'number') {
    parts.push(`ma=${clampMa(entry.ma)}`);
  }
  if (entry.persist === true) {
    parts.push('persist=1');
  }
  return parts.join('; ');
}

export function formatAltSvcServices(services: AltSvcEntry[]): string {
  return services.map(formatAltSvcEntry).join(', ');
}

function appendHeader(res: Response, name: string, value: string): void {
  const existing = res.getHeader(name);
  if (existing === undefined || existing === null || existing === '') {
    res.setHeader(name, value);
  } else if (typeof existing === 'string') {
    res.setHeader(name, `${existing}, ${value}`);
  } else if (Array.isArray(existing)) {
    res.setHeader(name, [...existing.map(String), value]);
  } else {
    res.setHeader(name, `${String(existing)}, ${value}`);
  }
}

export function buildApiAltSvcMiddleware(config: AltSvcConfig | null) {
  const isClear = config?.clear === true;
  const services = (config?.services ?? []).filter(isValidAltSvcEntry);
  const emitValue: string | null = isClear
    ? 'clear'
    : services.length > 0
    ? formatAltSvcServices(services)
    : null;
  return (_req: Request, res: Response, next: NextFunction) => {
    if (emitValue === null) {
      return next();
    }
    const origWriteHead = res.writeHead.bind(res);
    (res as unknown as { writeHead: (...args: unknown[]) => Response }).writeHead =
      function patchedWriteHead(this: Response, ...args: unknown[]): Response {
        if (isClear) {
          // RFC 7838 §3: "clear" pseudo-alternative overrides all prior
          // Alt-Svc state at the UA. Emit as canonical value; if a route
          // pre-set Alt-Svc, append after (UA sees `preset, clear` and
          // clear semantics apply).
          appendHeader(res, 'Alt-Svc', 'clear');
        } else {
          appendHeader(res, 'Alt-Svc', emitValue);
        }
        return (origWriteHead as (...a: unknown[]) => Response)(...args);
      };
    next();
  };
}

export const apiAltSvcMiddleware = () => buildApiAltSvcMiddleware(PKG_ALT_SVC_CONFIG);

export const CURRENT_ALT_SVC_CONFIG = PKG_ALT_SVC_CONFIG;
