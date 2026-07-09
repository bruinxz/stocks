/**
 * httpClient.test.ts — ADR-0010 §4.1 Phase 1 + §4.3 Phase 3 · verify + interceptor + body 单测
 *
 * jest (react-scripts test) 环境 · 不依赖真实 axios instance, 用 mock config +
 * 手写 response 覆盖分支.
 */

import type { AxiosResponse } from 'axios';
import {
  API_VERSION_HEADER,
  ApiVersionMismatchError,
  EXPECTED_API_VERSION_MAJOR,
  EXPECTED_API_VERSION_MAJOR_NUM,
  attachApiVersionInterceptor,
  extractHeaderMajor,
  extractUrlApiMajor,
  verifyApiVersion,
  verifySupportedApiVersions,
} from '../httpClient';

function mkResponse(url: string, headers: Record<string, string> = {}): AxiosResponse {
  return {
    data: {},
    status: 200,
    statusText: 'OK',
    headers,
    config: { url, headers: {} as any } as any,
    request: {},
  };
}

describe('extractUrlApiMajor', () => {
  test('relative /api/v1/foo → "1"', () => {
    expect(extractUrlApiMajor('/api/v1/explain-card/000001')).toBe('1');
  });

  test('absolute https://.../api/v2/bar → "2"', () => {
    expect(extractUrlApiMajor('https://host.example/api/v2/portfolio/rebalance')).toBe('2');
  });

  test('minor rev /api/v1.2/foo → "1" (major only)', () => {
    expect(extractUrlApiMajor('/api/v1.2/screener/list')).toBe('1');
  });

  test('无 /api/vN/ 前缀 → null', () => {
    expect(extractUrlApiMajor('/market/overview')).toBeNull();
    expect(extractUrlApiMajor('/api/health')).toBeNull();
    expect(extractUrlApiMajor('')).toBeNull();
    expect(extractUrlApiMajor(null)).toBeNull();
    expect(extractUrlApiMajor(undefined)).toBeNull();
  });
});

describe('extractHeaderMajor', () => {
  test('"1" → "1"', () => {
    expect(extractHeaderMajor('1')).toBe('1');
  });

  test('"1.2" → "1" (minor stripped)', () => {
    expect(extractHeaderMajor('1.2')).toBe('1');
  });

  test('前后空格 tolerate', () => {
    expect(extractHeaderMajor('  1  ')).toBe('1');
  });

  test('空字符串 / 非数字 → null', () => {
    expect(extractHeaderMajor('')).toBeNull();
    expect(extractHeaderMajor('   ')).toBeNull();
    expect(extractHeaderMajor('vNext')).toBeNull();
    expect(extractHeaderMajor(null)).toBeNull();
    expect(extractHeaderMajor(undefined)).toBeNull();
  });
});

describe('verifyApiVersion', () => {
  test('URL /api/v1/* + header "1" · verify PASS (no throw)', () => {
    const resp = mkResponse('/api/v1/explain-card/000001', { [API_VERSION_HEADER]: '1' });
    expect(() => verifyApiVersion(resp)).not.toThrow();
  });

  test('URL /api/v1/* + header "1.2" · verify PASS (minor rev OK)', () => {
    const resp = mkResponse('/api/v1/screener/list', { [API_VERSION_HEADER]: '1.2' });
    expect(() => verifyApiVersion(resp)).not.toThrow();
  });

  test('URL /api/v1/* + header 大写 X-API-Version case-insensitive', () => {
    const resp = mkResponse('/api/v1/quant/ping', { 'X-API-Version': '1' });
    expect(() => verifyApiVersion(resp)).not.toThrow();
  });

  test('非 BFF endpoint (无 /api/vN/) · verify skip · no throw', () => {
    const resp = mkResponse('/market/overview', {});
    expect(() => verifyApiVersion(resp)).not.toThrow();
  });

  test('URL /api/v1/* + header 缺失 → throw header_missing', () => {
    const resp = mkResponse('/api/v1/explain-card/000001', {});
    let caught: unknown;
    try {
      verifyApiVersion(resp);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiVersionMismatchError);
    const err = caught as ApiVersionMismatchError;
    expect(err.detail.reason).toBe('header_missing');
    expect(err.detail.urlMajor).toBe('1');
    expect(err.detail.headerMajor).toBeNull();
    expect(err.detail.expectedMajor).toBe(EXPECTED_API_VERSION_MAJOR);
  });

  test('URL /api/v1/* + header "2" → throw url_header_major_diverge', () => {
    const resp = mkResponse('/api/v1/portfolio/rebalance', { [API_VERSION_HEADER]: '2' });
    let caught: unknown;
    try {
      verifyApiVersion(resp);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiVersionMismatchError);
    const err = caught as ApiVersionMismatchError;
    expect(err.detail.reason).toBe('url_header_major_diverge');
    expect(err.detail.urlMajor).toBe('1');
    expect(err.detail.headerMajor).toBe('2');
  });

  test('URL /api/v2/* + header "2" (未来主版本) → throw header_major_mismatch', () => {
    const resp = mkResponse('/api/v2/explain-card/000001', { [API_VERSION_HEADER]: '2' });
    let caught: unknown;
    try {
      verifyApiVersion(resp);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiVersionMismatchError);
    const err = caught as ApiVersionMismatchError;
    expect(err.detail.reason).toBe('header_major_mismatch');
    expect(err.detail.urlMajor).toBe('2');
    expect(err.detail.headerMajor).toBe('2');
    expect(err.detail.expectedMajor).toBe('1');
  });

  test('URL /api/v1/* + header 非法 "vNext" → throw header_missing (parse fail)', () => {
    const resp = mkResponse('/api/v1/quant/ping', { [API_VERSION_HEADER]: 'vNext' });
    let caught: unknown;
    try {
      verifyApiVersion(resp);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiVersionMismatchError);
    const err = caught as ApiVersionMismatchError;
    expect(err.detail.reason).toBe('header_missing');
    expect(err.detail.headerVersion).toBe('vNext');
    expect(err.detail.headerMajor).toBeNull();
  });
});

describe('attachApiVersionInterceptor', () => {
  interface FakeInstance {
    interceptors: {
      response: {
        use: (
          onFulfilled: (r: AxiosResponse) => AxiosResponse,
          onRejected: (e: unknown) => Promise<never>
        ) => number;
        eject: (id: number) => void;
      };
    };
    __handlers: {
      fulfilled: ((r: AxiosResponse) => AxiosResponse) | null;
      rejected: ((e: unknown) => Promise<never>) | null;
    };
  }

  function mkInstance(): FakeInstance {
    const inst: FakeInstance = {
      interceptors: {
        response: {
          use: (onFulfilled, onRejected) => {
            inst.__handlers.fulfilled = onFulfilled;
            inst.__handlers.rejected = onRejected;
            return 42;
          },
          eject: () => {
            inst.__handlers.fulfilled = null;
            inst.__handlers.rejected = null;
          },
        },
      },
      __handlers: { fulfilled: null, rejected: null },
    };
    return inst;
  }

  test('挂载后 · verify PASS · response 原样返回', () => {
    const inst = mkInstance();
    const id = attachApiVersionInterceptor(inst as any);
    expect(id).toBe(42);
    const resp = mkResponse('/api/v1/explain-card/000001', { [API_VERSION_HEADER]: '1' });
    const out = inst.__handlers.fulfilled!(resp);
    expect(out).toBe(resp);
  });

  test('挂载后 · verify FAIL · 从 fulfilled handler throw', () => {
    const inst = mkInstance();
    attachApiVersionInterceptor(inst as any);
    const resp = mkResponse('/api/v1/explain-card/000001', {});
    expect(() => inst.__handlers.fulfilled!(resp)).toThrow(ApiVersionMismatchError);
  });

  test('挂载后 · rejected handler 原样透传 error (Promise reject)', async () => {
    const inst = mkInstance();
    attachApiVersionInterceptor(inst as any);
    const upstream = new Error('network down');
    await expect(inst.__handlers.rejected!(upstream)).rejects.toBe(upstream);
  });
});

describe('verifySupportedApiVersions · ADR-0010 §4.3 Phase 3', () => {
  test('EXPECTED_API_VERSION_MAJOR_NUM 常量 sanity = 1 (与 EXPECTED_API_VERSION_MAJOR "1" 对齐)', () => {
    expect(EXPECTED_API_VERSION_MAJOR_NUM).toBe(1);
    expect(String(EXPECTED_API_VERSION_MAJOR_NUM)).toBe(EXPECTED_API_VERSION_MAJOR);
  });

  test('Backend PR #125 landed shape · verify PASS (no throw)', () => {
    const payload = {
      status: 'ok',
      timestamp: '2026-07-10T00:00:00.000Z',
      api_version: '1.0',
      supported_api_versions: [1],
    };
    expect(() => verifySupportedApiVersions(payload)).not.toThrow();
  });

  test('minor-only "1" (无 dot) · verify PASS', () => {
    const payload = { api_version: '1', supported_api_versions: [1] };
    expect(() => verifySupportedApiVersions(payload)).not.toThrow();
  });

  test('dual-mount 前瞻 · supported=[1,2] · verify PASS (前端 EXPECTED=1 仍 ∈)', () => {
    const payload = { api_version: '1.0', supported_api_versions: [1, 2] };
    expect(() => verifySupportedApiVersions(payload)).not.toThrow();
  });

  test('null payload → throw body_not_object', () => {
    let caught: unknown;
    try {
      verifySupportedApiVersions(null);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiVersionMismatchError);
    expect((caught as ApiVersionMismatchError).detail.reason).toBe('body_not_object');
  });

  test('string payload → throw body_not_object', () => {
    let caught: unknown;
    try {
      verifySupportedApiVersions('ok');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiVersionMismatchError);
    expect((caught as ApiVersionMismatchError).detail.reason).toBe('body_not_object');
  });

  test('array payload → throw body_not_object', () => {
    let caught: unknown;
    try {
      verifySupportedApiVersions([1, 2, 3]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiVersionMismatchError);
    expect((caught as ApiVersionMismatchError).detail.reason).toBe('body_not_object');
  });

  test('缺 api_version → throw body_missing_api_version', () => {
    let caught: unknown;
    try {
      verifySupportedApiVersions({ status: 'ok', supported_api_versions: [1] });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiVersionMismatchError);
    expect((caught as ApiVersionMismatchError).detail.reason).toBe('body_missing_api_version');
  });

  test('空字符串 api_version → throw body_missing_api_version', () => {
    let caught: unknown;
    try {
      verifySupportedApiVersions({ api_version: '', supported_api_versions: [1] });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiVersionMismatchError);
    expect((caught as ApiVersionMismatchError).detail.reason).toBe('body_missing_api_version');
  });

  test('api_version "2.0" (前端 EXPECTED "1") → throw body_api_version_major_mismatch', () => {
    let caught: unknown;
    try {
      verifySupportedApiVersions({ api_version: '2.0', supported_api_versions: [2] });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiVersionMismatchError);
    const err = caught as ApiVersionMismatchError;
    expect(err.detail.reason).toBe('body_api_version_major_mismatch');
    expect(err.detail.headerVersion).toBe('2.0');
    expect(err.detail.headerMajor).toBe('2');
    expect(err.detail.expectedMajor).toBe('1');
  });

  test('api_version "vNext" (parse fail) → throw body_api_version_major_mismatch', () => {
    let caught: unknown;
    try {
      verifySupportedApiVersions({ api_version: 'vNext', supported_api_versions: [1] });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiVersionMismatchError);
    const err = caught as ApiVersionMismatchError;
    expect(err.detail.reason).toBe('body_api_version_major_mismatch');
    expect(err.detail.headerMajor).toBeNull();
  });

  test('缺 supported_api_versions → throw body_missing_supported_api_versions', () => {
    let caught: unknown;
    try {
      verifySupportedApiVersions({ api_version: '1.0' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiVersionMismatchError);
    expect((caught as ApiVersionMismatchError).detail.reason).toBe(
      'body_missing_supported_api_versions'
    );
  });

  test('supported_api_versions=[] (空数组) → throw body_missing_supported_api_versions', () => {
    let caught: unknown;
    try {
      verifySupportedApiVersions({ api_version: '1.0', supported_api_versions: [] });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiVersionMismatchError);
    expect((caught as ApiVersionMismatchError).detail.reason).toBe(
      'body_missing_supported_api_versions'
    );
  });

  test('supported_api_versions 非数组 (string) → throw body_missing_supported_api_versions', () => {
    let caught: unknown;
    try {
      verifySupportedApiVersions({ api_version: '1.0', supported_api_versions: '1,2' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiVersionMismatchError);
    expect((caught as ApiVersionMismatchError).detail.reason).toBe(
      'body_missing_supported_api_versions'
    );
  });

  test('supported=[2,3] (前端 EXPECTED=1 不 ∈) → throw body_expected_major_not_supported', () => {
    let caught: unknown;
    try {
      verifySupportedApiVersions({ api_version: '1.0', supported_api_versions: [2, 3] });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiVersionMismatchError);
    const err = caught as ApiVersionMismatchError;
    expect(err.detail.reason).toBe('body_expected_major_not_supported');
    expect(err.detail.expectedMajor).toBe('1');
  });

  test("supported=['1'] (string 元素, 非 number) → throw body_expected_major_not_supported", () => {
    let caught: unknown;
    try {
      verifySupportedApiVersions({ api_version: '1.0', supported_api_versions: ['1'] });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiVersionMismatchError);
    expect((caught as ApiVersionMismatchError).detail.reason).toBe(
      'body_expected_major_not_supported'
    );
  });

  test('custom url 参数 · reflected in detail.url', () => {
    let caught: unknown;
    try {
      verifySupportedApiVersions(null, '/api/v1/health');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiVersionMismatchError);
    expect((caught as ApiVersionMismatchError).detail.url).toBe('/api/v1/health');
  });

  test('默认 url = "/health" · reflected in detail.url', () => {
    let caught: unknown;
    try {
      verifySupportedApiVersions(null);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiVersionMismatchError);
    expect((caught as ApiVersionMismatchError).detail.url).toBe('/health');
  });
});
