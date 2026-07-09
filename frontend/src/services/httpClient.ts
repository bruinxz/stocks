/**
 * httpClient.ts — ADR-0010 §4.1 Phase 1 · X-API-Version response header verify
 *
 * 采纳 ADR-0010 §2.2 + §2.3 双源版本范式:
 *   URL 路径版本主源 (`/api/v1/*`) + `X-API-Version` header 辅源
 *   两者 major 不匹配 → `ApiVersionMismatchError` throw
 *
 * 教训 #12 反向应用: Frontend 不 aware contract draft, 只信 URL immutable + header
 * runtime 双源交叉 (code truth 唯一权威 · 前端不 aware 权威锁).
 *
 * 挂点:
 *   Phase 1 (landed) — axios response interceptor 只 verify + throw · zero UI 侧改
 *   Phase 2 (T+1w)   — Zod schema `.versioned()` marker · Playwright header 断言
 *   Phase 3 (本 patch) — `/health` body `api_version` + `supported_api_versions`
 *     消费方: `verifySupportedApiVersions(payload)` — 与 header `X-API-Version`
 *     dual-source 天然一致 cross-attest. Backend PR #125 (mergeCommit `44027896`
 *     ADR-0010 §4.3 partial) 已 landed body surface (backend/src/index.ts:179-186).
 *
 * Baseline: `docs/refactor/baseline/api/api-version-header-baseline-d6a0c1e.json`
 *   R2_header_name = "X-API-Version"
 *   R2_header_value = "1"  (major · 允许 minor rev 附加, 例 "1.2")
 *   R1_prefix = "/api/v1/"
 *
 * 与 `services/api.ts` 关系: 独立 helper 层, 不改 `api.ts` 现有 request/401
 * refresh 拦截链; `api.ts` 可在 D-Day 由 Backend Phase 2 log middleware 附源后
 * 挂本 helper. 当前 export `attachApiVersionInterceptor(instance)` + 独立单测.
 */

import type { AxiosError, AxiosInstance, AxiosResponse } from 'axios';

export const EXPECTED_API_VERSION_MAJOR = '1';
export const EXPECTED_API_VERSION_MAJOR_NUM = 1;
export const EXPECTED_URL_VERSION_PREFIX = '/api/v1/';
export const API_VERSION_HEADER = 'x-api-version';

export type ApiVersionMismatchReason =
  | 'header_missing'
  | 'header_major_mismatch'
  | 'url_prefix_mismatch'
  | 'url_header_major_diverge'
  | 'body_not_object'
  | 'body_missing_api_version'
  | 'body_missing_supported_api_versions'
  | 'body_api_version_major_mismatch'
  | 'body_expected_major_not_supported';

export interface ApiVersionMismatchDetail {
  url: string;
  headerVersion: string | null;
  headerMajor: string | null;
  urlMajor: string | null;
  expectedMajor: string;
  reason: ApiVersionMismatchReason;
}

export class ApiVersionMismatchError extends Error {
  public readonly detail: ApiVersionMismatchDetail;

  constructor(detail: ApiVersionMismatchDetail) {
    super(
      `[ADR-0010] API version mismatch (${detail.reason}): url=${detail.url} ` +
        `url_major=${detail.urlMajor ?? 'null'} header=${detail.headerVersion ?? 'null'} ` +
        `expected_major=${detail.expectedMajor}`
    );
    this.name = 'ApiVersionMismatchError';
    this.detail = detail;
    Object.setPrototypeOf(this, ApiVersionMismatchError.prototype);
  }
}

/**
 * 提取 URL 路径的 API 主版本号.
 *
 * 支持 absolute (`https://host/api/v1/foo`) 与 relative (`/api/v1/foo`) 两种.
 * 未匹配 → null.
 */
export function extractUrlApiMajor(url: string | undefined | null): string | null {
  if (!url) return null;
  const m = url.match(/\/api\/v(\d+)(?:\.\d+)?\//);
  return m ? m[1] : null;
}

/**
 * 提取 header 版本主版本号 (`"1"` 或 `"1.2"` → `"1"`).
 * 空/非法 → null.
 */
export function extractHeaderMajor(headerValue: string | undefined | null): string | null {
  if (typeof headerValue !== 'string') return null;
  const trimmed = headerValue.trim();
  if (!trimmed) return null;
  const m = trimmed.match(/^(\d+)(?:\.\d+)?$/);
  return m ? m[1] : null;
}

function readHeader(headers: unknown, name: string): string | null {
  if (!headers || typeof headers !== 'object') return null;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (k.toLowerCase() === lower) {
      if (typeof v === 'string') return v;
      if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
      if (v != null && typeof (v as { toString?: () => string }).toString === 'function') {
        return String(v);
      }
      return null;
    }
  }
  return null;
}

/**
 * 校验 response · URL 路径主版本 与 `X-API-Version` header 主版本 必须一致
 * 且 header 主版本必须等于 `EXPECTED_API_VERSION_MAJOR`.
 *
 * URL 无 `/api/v[0-9]+/` 前缀 → verify skip (非 BFF endpoint · Phase 1 warn-only).
 * URL 有前缀 + header 缺失 → throw (`header_missing`).
 * URL 有前缀 + header major 与 URL 分歧 → throw (`url_header_major_diverge`).
 * URL 有前缀 + header major 与 expected 分歧 → throw (`header_major_mismatch`).
 */
export function verifyApiVersion(response: AxiosResponse): void {
  const url = response.config?.url ?? '';
  const urlMajor = extractUrlApiMajor(url);

  if (urlMajor === null) return;

  const headerVal = readHeader(response.headers, API_VERSION_HEADER);
  const headerMajor = extractHeaderMajor(headerVal);

  if (headerMajor === null) {
    throw new ApiVersionMismatchError({
      url,
      headerVersion: headerVal,
      headerMajor: null,
      urlMajor,
      expectedMajor: EXPECTED_API_VERSION_MAJOR,
      reason: 'header_missing',
    });
  }

  if (headerMajor !== urlMajor) {
    throw new ApiVersionMismatchError({
      url,
      headerVersion: headerVal,
      headerMajor,
      urlMajor,
      expectedMajor: EXPECTED_API_VERSION_MAJOR,
      reason: 'url_header_major_diverge',
    });
  }

  if (headerMajor !== EXPECTED_API_VERSION_MAJOR) {
    throw new ApiVersionMismatchError({
      url,
      headerVersion: headerVal,
      headerMajor,
      urlMajor,
      expectedMajor: EXPECTED_API_VERSION_MAJOR,
      reason: 'header_major_mismatch',
    });
  }
}

/**
 * 挂载到已有 axios instance 的 response 拦截链.
 * 成功: 通过 verify 后原样返回 response.
 * 失败: verify throw `ApiVersionMismatchError` · Promise reject.
 *
 * `api.ts` 现有 401 refresh 拦截独立, 不受本函数影响.
 * 返回 interceptor id, 可用 `instance.interceptors.response.eject(id)` 卸载.
 */
export function attachApiVersionInterceptor(instance: AxiosInstance): number {
  return instance.interceptors.response.use(
    (response: AxiosResponse) => {
      verifyApiVersion(response);
      return response;
    },
    (error: AxiosError) => Promise.reject(error)
  );
}

/**
 * ADR-0010 §4.3 Phase 3 · `/health` 响应体版本校验
 *
 * Backend PR #125 (mergeCommit `44027896`) landed `/health` body:
 *   { status, timestamp, api_version: "1.0", supported_api_versions: [1] }
 * (see backend/src/index.ts:179-186 + backend/src/middlewares/apiVersion.ts)
 *
 * 与 `verifyApiVersion` (header 主源) 构成 dual-source cross-attest:
 *   - header `X-API-Version: 1.0` (major "1")
 *   - body   `api_version: "1.0"` + `supported_api_versions: [1]`
 * 两者天然一致 (同 `CURRENT_API_VERSION` package.json 源) · 分歧即 canonical violation.
 *
 * 语义:
 *   `body.api_version` 必存 · major 与 `EXPECTED_API_VERSION_MAJOR` 一致.
 *   `body.supported_api_versions` 必存 · 数组 · `EXPECTED_API_VERSION_MAJOR_NUM` ∈ 数组.
 *
 * v2 dual-mount 前瞻: Backend 升级 pkg.api_version → "2.0" 时数组会自动
 * `[1, 2]` (deriveSupportedMajors + `SUPPORTED_API_VERSIONS = Object.freeze`),
 * 消费方仍 pass · 前端切换 EXPECTED_* 常量后 header 侧同步.
 *
 * `payload` 通常来自 `/health` GET · 但函数纯 · 不依赖 axios · 可 unit test.
 */
export interface HealthPayloadShape {
  api_version?: unknown;
  supported_api_versions?: unknown;
  [k: string]: unknown;
}

export function verifySupportedApiVersions(
  payload: unknown,
  url: string = '/health'
): void {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ApiVersionMismatchError({
      url,
      headerVersion: null,
      headerMajor: null,
      urlMajor: null,
      expectedMajor: EXPECTED_API_VERSION_MAJOR,
      reason: 'body_not_object',
    });
  }

  const body = payload as HealthPayloadShape;
  const apiVersion = body.api_version;

  if (typeof apiVersion !== 'string' || apiVersion.length === 0) {
    throw new ApiVersionMismatchError({
      url,
      headerVersion: null,
      headerMajor: null,
      urlMajor: null,
      expectedMajor: EXPECTED_API_VERSION_MAJOR,
      reason: 'body_missing_api_version',
    });
  }

  const bodyMajor = extractHeaderMajor(apiVersion);
  if (bodyMajor !== EXPECTED_API_VERSION_MAJOR) {
    throw new ApiVersionMismatchError({
      url,
      headerVersion: apiVersion,
      headerMajor: bodyMajor,
      urlMajor: null,
      expectedMajor: EXPECTED_API_VERSION_MAJOR,
      reason: 'body_api_version_major_mismatch',
    });
  }

  const supported = body.supported_api_versions;
  if (!Array.isArray(supported) || supported.length === 0) {
    throw new ApiVersionMismatchError({
      url,
      headerVersion: apiVersion,
      headerMajor: bodyMajor,
      urlMajor: null,
      expectedMajor: EXPECTED_API_VERSION_MAJOR,
      reason: 'body_missing_supported_api_versions',
    });
  }

  const hasExpected = supported.some(
    (v) => typeof v === 'number' && Number.isFinite(v) && v === EXPECTED_API_VERSION_MAJOR_NUM
  );
  if (!hasExpected) {
    throw new ApiVersionMismatchError({
      url,
      headerVersion: apiVersion,
      headerMajor: bodyMajor,
      urlMajor: null,
      expectedMajor: EXPECTED_API_VERSION_MAJOR,
      reason: 'body_expected_major_not_supported',
    });
  }
}
