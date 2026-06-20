#!/usr/bin/env ts-node
/**
 * check-openapi-drift.ts — US-098 OPS-009 OpenAPI 自动生成 CI guard
 *
 * 作用：在 CI 跑一次 `buildOpenApiSpec()`，把结果与已提交的 `docs/openapi.json`
 *   做规范化比对，若有漂移（routes 添加/修改 @openapi 注释但忘了重新生成）则
 *   exit=1 + 输出第一处差异定位 + 提示开发者本地跑 `npm run docs:openapi`。
 *
 * 设计：
 *   - 不写文件（read-only check）；CI 不应自动 commit 生成产物。
 *   - 比对前对 JSON 做 normalize（JSON.stringify(spec, null, 2) + "\n" 收尾），与
 *     generate-openapi.ts 落盘格式一致；避免 trailing newline / key 顺序差异误报。
 *   - 第一处差异输出 line-level diff（仅前后 5 行）方便快速定位是哪个 endpoint
 *     的 @openapi 块改了。
 *
 * 用法:
 *   npm run docs:openapi:check                # 默认对比 docs/openapi.json
 *   npm run docs:openapi:check -- --in=x.json # 自定义对比路径
 *
 * 退出码：
 *   0 — 无漂移（spec 与磁盘一致）
 *   1 — 漂移（开发者需要本地跑 `npm run docs:openapi` 并 commit）
 *   2 — 磁盘路径不存在（说明从未生成过）
 */

import fs from 'fs';
import path from 'path';
import { buildOpenApiSpec } from '../config/swagger';

export interface CheckOpenApiDriftInput {
  /** 磁盘上 OpenAPI 文件路径；默认 `docs/openapi.json` (相对 repo root) */
  in?: string;
  /** 已构建的 spec；缺省时调 buildOpenApiSpec()。测试注入 */
  spec?: object;
  /** 注入式 fs reader（测试用） */
  readFile?: (p: string) => string;
  /** 注入式 fs exists（测试用） */
  existsSync?: (p: string) => boolean;
}

export interface CheckOpenApiDriftResult {
  ok: boolean;
  reason: 'in_sync' | 'drift' | 'missing_file';
  inPath: string;
  expectedBytes?: number;
  actualBytes?: number;
  /** 第一处不同的字符 index（仅 drift 时有） */
  firstDiffOffset?: number;
  /** 漂移时第一处 line-level diff（前后 ±5 行） */
  diffSnippet?: string;
}

/**
 * 将 spec 序列化为与 generate-openapi.ts 落盘完全一致的字符串。
 * generate-openapi.ts: `fs.writeFileSync(out, JSON.stringify(spec, null, 2), 'utf-8')`
 * 注意：fs.writeFileSync 不会自动追加 trailing newline，所以这里也不追加，
 *   两边保持完全 byte-for-byte 一致。
 */
export function serializeSpecForCompare(spec: object): string {
  return JSON.stringify(spec, null, 2);
}

/**
 * 给出第一处差异的 line-level snippet（±5 行）。
 * 用于在 CI 输出第一眼能看到 "改了哪个 endpoint 注释"。
 */
export function buildDriftDiffSnippet(
  expected: string,
  actual: string
): {
  offset: number;
  snippet: string;
} {
  const len = Math.min(expected.length, actual.length);
  let offset = -1;
  for (let i = 0; i < len; i++) {
    if (expected[i] !== actual[i]) {
      offset = i;
      break;
    }
  }
  if (offset === -1) {
    // 长度不同（一边是另一边前缀）
    offset = len;
  }

  // 转 line 号
  const expectedLines = expected.split('\n');
  const actualLines = actual.split('\n');
  let charsSeen = 0;
  let diffLine = 0;
  for (let i = 0; i < expectedLines.length; i++) {
    const lineLen = expectedLines[i].length + 1; // +1 for \n
    if (charsSeen + lineLen > offset) {
      diffLine = i;
      break;
    }
    charsSeen += lineLen;
  }

  const start = Math.max(0, diffLine - 5);
  const end = Math.min(Math.max(expectedLines.length, actualLines.length), diffLine + 6);
  const out: string[] = [];
  out.push(`  --- expected (docs/openapi.json), line ${diffLine + 1}`);
  for (let i = start; i < end; i++) {
    out.push(`  ${i + 1}: ${expectedLines[i] ?? '<EOF>'}`);
  }
  out.push(`  +++ actual (regenerated)`);
  for (let i = start; i < end; i++) {
    out.push(`  ${i + 1}: ${actualLines[i] ?? '<EOF>'}`);
  }
  return { offset, snippet: out.join('\n') };
}

/**
 * 主入口：构建当前 spec, 与磁盘对比, 返结构化结果。fail-OPEN（除磁盘缺失外永不抛）。
 */
export function checkOpenApiDrift(input: CheckOpenApiDriftInput = {}): CheckOpenApiDriftResult {
  const inPath = input.in || path.resolve(__dirname, '../../../docs/openapi.json');
  const existsSync = input.existsSync || fs.existsSync;
  const readFile = input.readFile || ((p: string) => fs.readFileSync(p, 'utf-8'));

  if (!existsSync(inPath)) {
    return { ok: false, reason: 'missing_file', inPath };
  }

  const spec = input.spec || buildOpenApiSpec();
  const actual = serializeSpecForCompare(spec);
  const expected = readFile(inPath);

  if (expected === actual) {
    return {
      ok: true,
      reason: 'in_sync',
      inPath,
      expectedBytes: expected.length,
      actualBytes: actual.length,
    };
  }

  const { offset, snippet } = buildDriftDiffSnippet(expected, actual);
  return {
    ok: false,
    reason: 'drift',
    inPath,
    expectedBytes: expected.length,
    actualBytes: actual.length,
    firstDiffOffset: offset,
    diffSnippet: snippet,
  };
}

function parseArgs(argv: string[]): { in?: string } {
  const inArg = argv.find(a => a.startsWith('--in='))?.split('=')[1];
  return { in: inArg };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[docs:openapi:check] Comparing buildOpenApiSpec() to disk...`);
  const result = checkOpenApiDrift({ in: args.in });

  if (result.reason === 'missing_file') {
    console.error(`[docs:openapi:check] ❌ Missing file: ${result.inPath}`);
    console.error(`[docs:openapi:check]    Run 'npm run docs:openapi' to generate it.`);
    process.exit(2);
  }

  if (result.ok) {
    console.log(
      `[docs:openapi:check] ✅ In sync (${result.expectedBytes} bytes) — ${result.inPath}`
    );
    process.exit(0);
  }

  console.error(
    `[docs:openapi:check] ❌ Drift detected — ${result.inPath} (${result.expectedBytes} bytes) ≠ regenerated (${result.actualBytes} bytes)`
  );
  console.error(`[docs:openapi:check]    First diff at char offset ${result.firstDiffOffset}:`);
  console.error(result.diffSnippet || '');
  console.error('');
  console.error(
    `[docs:openapi:check]    Fix: cd backend && npm run docs:openapi && git add ../docs/openapi.json`
  );
  process.exit(1);
}

// 仅当作为 entry point 跑时才调 main，被 require/import 时只暴露 export
if (require.main === module) {
  main();
}
