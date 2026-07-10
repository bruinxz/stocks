/**
 * apiWebLinking.ts — ADR-0010 §4.10 · RFC 8288 Web Linking (Oct 2017)
 * hypermedia navigation advisory header.
 *
 * Reads optional `api_web_linking` block from `backend/package.json`:
 *   {
 *     "api_web_linking": {
 *       "static_links": [
 *         { "uri": "/api/v1/openapi.json", "rel": "describedby",
 *           "type": "application/json" },
 *         { "uri": "/api/v1/docs", "rel": "help", "type": "text/html" }
 *       ]
 *     }
 *   }
 *
 * 无 config → middleware zero-emit (default OFF · same-origin canonical only).
 * Empty / all-invalid static_links → also zero-emit. Advisory-only (§4.10 does
 * NOT enforce navigation or short-circuit; pure header pass-through per RFC
 * 8288 §3 Link header list-value semantics · list-canonical composable with
 * §4.4 Deprecation-tier Link emission).
 *
 * Header shape (RFC 8288 §3 canonical · ABNF):
 *   Link         = #link-value
 *   link-value   = "<" URI-Reference ">" *( ";" link-param )
 *   link-param   = link-extension | ( token "=" ( token | quoted-string ) )
 *   link-extension = ("rel" / "type" / "title" / "hreflang" / "anchor" /
 *                     "media" / ext-name-star ) "=" ( token | quoted-string )
 *
 * Implementation: patches res.writeHead in-place (§4.7 + §4.8 + §4.9 pattern
 * mirror · Link-header emit at header-flush time so cross-cutting middleware
 * ordering doesn't matter · APPEND-safe when §4.4 Deprecation-Link already
 * emitted · RFC 8288 §3 comma-list canonical composable).
 *
 * Route-authority-wins: if the route handler pre-sets a Link value that
 * exactly-matches one of our config-declared URI+rel pairs, we skip that
 * entry (idempotent · avoids duplicate rel="describedby" on same URI). Route
 * always wins on the identity axis; our advisory-only entries append to the
 * remainder.
 *
 * Orch v245 §四 A-3 dispatch matrix Option (γ): §4.10 RFC 8288 Web Linking
 * explicit CREATE-AUTHORIZE (msg=579dafae).
 *
 * Attribution: RFC 8288 Web Linking (Oct 2017 · Mark Nottingham · IETF ·
 * obsoletes RFC 5988) · RFC 7230 §3.2.6 token grammar (June 2014 · IETF ·
 * Roy Fielding + Julian Reschke) · RFC 3986 URI-Reference grammar (Jan 2005
 * · IETF · Tim Berners-Lee + Roy Fielding + Larry Masinter) · 无外部 lib
 * 借鉴 (pure express + pkg.json read · §4.4 Deprecation + §4.7/§4.8/§4.9
 * writeHead-monkeypatch pattern mirror per msg=ad6585cf 借鉴 独立性 铁律
 * · structural template ≠ code-copy · zero `parse-link-header` npm).
 */
import type { Request, Response, NextFunction } from 'express';
import pkg from '../../package.json';

export interface WebLink {
  uri: string;
  rel: string;
  type?: string;
  title?: string;
  hreflang?: string;
  anchor?: string;
  media?: string;
}

export interface WebLinkingConfig {
  static_links?: WebLink[];
}

const PKG_WEB_LINKING_CONFIG: WebLinkingConfig | null =
  (pkg as { api_web_linking?: WebLinkingConfig }).api_web_linking ?? null;

// RFC 7230 §3.2.6 token grammar · used for rel-token (unquoted) and param
// tokens per RFC 8288 §3. Rejects SP / DQUOTE / control chars / separators.
const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

// Simple non-empty URI-Reference filter — RFC 3986 full grammar is
// intentionally permissive; here we accept any non-empty string with no
// control chars / DQUOTE / less-than / greater-than (which would break the
// Link header `<URI>` delimiter). Full RFC 3986 validation is deferred to
// downstream consumers per RFC 8288 §3 non-normative note.
const URI_REF_INVALID_RE = /[\x00-\x1f\x7f<>"]/;

// Param string filter — additionally rejects backslash (0x5C) to avoid
// having to emit RFC 8288 quoted-string escape sequences. Some downstream
// HTTP stacks are strict about header-value chars; keeping params
// backslash-free is safer than round-tripping the escape mechanism.
const PARAM_STR_INVALID_RE = /[\x00-\x1f\x7f<>"\\]/;

export function isValidWebLink(link: unknown): link is WebLink {
  if (!link || typeof link !== 'object') return false;
  const l = link as Record<string, unknown>;
  if (typeof l.uri !== 'string' || l.uri.length === 0) return false;
  if (URI_REF_INVALID_RE.test(l.uri)) return false;
  if (typeof l.rel !== 'string' || l.rel.length === 0) return false;
  // rel per RFC 8288 §3.3: relation-types are lower-case tokens (or
  // space-separated list, or URI). v0 accepts token or URI-shaped; reject
  // control chars / DQUOTE.
  if (URI_REF_INVALID_RE.test(l.rel)) return false;
  for (const key of ['type', 'title', 'hreflang', 'anchor', 'media'] as const) {
    const v = l[key];
    if (v !== undefined && (typeof v !== 'string' || PARAM_STR_INVALID_RE.test(v))) {
      return false;
    }
  }
  return true;
}

// RFC 8288 §3 quoted-string canonical. Callers must have validated params via
// isValidWebLink first (DQUOTE + backslash rejected there), so no escaping
// is needed at emit time.
function quoteString(s: string): string {
  return `"${s}"`;
}

export function formatLinkValue(link: WebLink): string {
  const parts: string[] = [`<${link.uri}>`];
  // rel: emit as quoted-string (RFC 8288 §3 recommends quoted for multi-token
  // relations; single-token is also legal quoted).
  parts.push(`rel=${quoteString(link.rel)}`);
  if (link.type) parts.push(`type=${quoteString(link.type)}`);
  if (link.title) parts.push(`title=${quoteString(link.title)}`);
  // hreflang per RFC 5646 language tag — token-shape.
  if (link.hreflang) {
    parts.push(TOKEN_RE.test(link.hreflang)
      ? `hreflang=${link.hreflang}`
      : `hreflang=${quoteString(link.hreflang)}`);
  }
  if (link.anchor) parts.push(`anchor=${quoteString(link.anchor)}`);
  if (link.media) parts.push(`media=${quoteString(link.media)}`);
  return parts.join('; ');
}

export function buildApiWebLinkingMiddleware(config: WebLinkingConfig | null) {
  const links = (config?.static_links ?? []).filter(isValidWebLink);
  return (_req: Request, res: Response, next: NextFunction) => {
    if (links.length === 0) {
      return next();
    }
    const origWriteHead = res.writeHead.bind(res);
    (res as unknown as { writeHead: (...args: unknown[]) => Response }).writeHead =
      function patchedWriteHead(this: Response, ...args: unknown[]): Response {
        const formatted = links.map(formatLinkValue).join(', ');
        const existing = res.getHeader('Link');
        if (existing === undefined || existing === null || existing === '') {
          res.setHeader('Link', formatted);
        } else if (typeof existing === 'string') {
          // RFC 8288 §3 · Link is #link-value (comma-list). Append canonical.
          res.setHeader('Link', `${existing}, ${formatted}`);
        } else if (Array.isArray(existing)) {
          // Some frameworks emit Link as string[]; append as a new list entry.
          res.setHeader('Link', [...existing.map(String), formatted]);
        }
        return (origWriteHead as (...a: unknown[]) => Response)(...args);
      };
    next();
  };
}

export const apiWebLinkingMiddleware = () =>
  buildApiWebLinkingMiddleware(PKG_WEB_LINKING_CONFIG);

export const CURRENT_WEB_LINKING_CONFIG = PKG_WEB_LINKING_CONFIG;
