/**
 * @fileoverview Task #29 · §No-Math-Random-US-038 · Math.random 静态扫描反蔓延门禁 (Path C · baseline whitelist)
 *
 * 权威锚:
 *   docs/refactor/adr/0002-us-038-lint.md §2.1 (禁 Math.random / 允 SeededRandom)
 *   docs/refactor/adr/0002-us-038-lint.md §2.2.1 v1.2 (baseline whitelist + 反蔓延门禁 · Orchestrator 独占起草 · Path C 采纳位)
 *   docs/refactor/40-quality-gates.md §Gate-Negative-Coverage-v0.3 (联动位)
 *
 * baseline JSON 权威锚:
 *   docs/refactor/baseline/security/us-038-baseline-b04c236.json (SHA-locked @ b04c236 · 0 entries · Task #29 Phase 3 PR-D grand-close · US-038 收官 · SHA-lock rename 40a9c42.json → b04c236.json · middlewares/upload.ts + realtime/alertsWebSocketServer 尾批下线 · 反蔓延门禁转纯守 · 教训 #9 4/4 co-守闭合终例 · grand-close rename 落地首例)
 *
 * 承接位: QADocs Task #29 · v1.1 追增队列第 3 位 · §No-Math-Random-US-038 · Orchestrator msg=0a347004 Path C 裁决
 * 语义: 全 backend/src 递归 .ts (非 .d.ts) 静态扫描 Math.random() 调用 · 剔除注释与字符串字面量内引用
 *       命中 ∈ baseline → warn (允许 burndown · 不阻塞)
 *       命中 ∉ baseline → fail (反蔓延门禁 · 阻塞)
 *       白名单目录 __tests__ / node_modules / dist
 * 独立性: 纯静态 fs 扫描 · 无 production module 依赖 · 无 fixture 依赖 · 借鉴思想档 (类似 eslint --report-unused-disable-directives baseline)
 *
 * Path C 4+1 断言矩阵 (Orchestrator msg=0a347004 §一 追加约束 A/B/C):
 *   A · backend/src 目录存在且非空
 *   B · 反蔓延门禁 · 全 backend/src 命中 ∈ baseline 或 fail (新增命中即阻塞)
 *   C · 注释行 / 字符串字面量假阳性守护
 *   D · 正例反证 grep 灵敏度
 *   F · baseline JSON schema 完整性 (Orchestrator §一 C · 缺 file/line/sha256/category 任一字段 → fail)
 *
 * 版本历史:
 *   v0 (workspace draft · @jest/globals) - 弃用 · 属 land 未跑测反例
 *   v1 (本文件 · IIFE + 4 断言 A/B/C/D + hardcoded baseline check) - Orchestrator msg=0a347004 Path C 采纳
 *
 * 跑法 (项目 IIFE + node:assert 约定 · 参照 backend/src/scripts/run-tests.ts):
 *   cd backend && npx ts-node --transpile-only tests/quality/test_no_math_random_us_038_rule.test.ts
 *   cd backend && npm test -- --filter=test_no_math_random
 */

import assert from 'node:assert/strict';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let failed = 0;
let passed = 0;

function it(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed += 1;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  FAIL ${name}\n       ${msg.split('\n').join('\n       ')}`);
  }
}

interface BaselineEntry {
  file: string;
  line: number;
  sha256_of_line: string;
  category: string;
  note?: string;
}

interface BaselineDoc {
  entries: BaselineEntry[];
  [key: string]: unknown;
}

function collectBackendTsFiles(rootDir: string): string[] {
  const results: string[] = [];
  function walk(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === 'dist') {
          continue;
        }
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        results.push(fullPath);
      }
    }
  }
  walk(rootDir);
  return results;
}

interface Hit {
  line: number;
  rawLine: string;
}

function scanMathRandomHits(filePath: string): Hit[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const hits: Hit[] = [];
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i++) {
    const originalLine = lines[i];
    let line = originalLine;
    if (inBlockComment) {
      const endIdx = line.indexOf('*/');
      if (endIdx === -1) continue;
      line = line.slice(endIdx + 2);
      inBlockComment = false;
    }
    while (true) {
      const startIdx = line.indexOf('/*');
      const endIdx = line.indexOf('*/');
      if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
        line = line.slice(0, startIdx) + line.slice(endIdx + 2);
        continue;
      }
      if (startIdx !== -1) {
        line = line.slice(0, startIdx);
        inBlockComment = true;
        break;
      }
      break;
    }
    const singleLineCommentIdx = line.indexOf('//');
    if (singleLineCommentIdx !== -1) {
      line = line.slice(0, singleLineCommentIdx);
    }
    const stringStripped = stripStringLiteralsAwareOfTemplateExpr(line);
    if (/Math\.random\b/.test(stringStripped)) {
      hits.push({ line: i + 1, rawLine: originalLine });
    }
  }
  return hits;
}

function stripStringLiteralsAwareOfTemplateExpr(line: string): string {
  let out = '';
  let i = 0;
  const n = line.length;
  while (i < n) {
    const ch = line[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      out += '""';
      i += 1;
      while (i < n) {
        const c = line[i];
        if (c === '\\') { i += 2; continue; }
        if (c === quote) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (ch === '`') {
      out += '``';
      i += 1;
      while (i < n) {
        const c = line[i];
        if (c === '\\') { i += 2; continue; }
        if (c === '`') { i += 1; break; }
        if (c === '$' && line[i + 1] === '{') {
          i += 2;
          let depth = 1;
          while (i < n && depth > 0) {
            const cc = line[i];
            if (cc === '{') depth += 1;
            else if (cc === '}') depth -= 1;
            if (depth === 0) { i += 1; break; }
            out += cc;
            i += 1;
          }
          continue;
        }
        i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

const REPO_BACKEND_DIR = path.resolve(__dirname, '..', '..');
const BACKEND_SRC_DIR = path.join(REPO_BACKEND_DIR, 'src');
const REPO_ROOT_DIR = path.resolve(REPO_BACKEND_DIR, '..');
const BASELINE_JSON_PATH = path.join(
  REPO_ROOT_DIR,
  'docs',
  'refactor',
  'baseline',
  'security',
  'us-038-baseline-b04c236.json'
);
const WHITELIST_PATH_FRAGMENTS = ['__tests__', 'node_modules', 'dist'];
const REQUIRED_BASELINE_FIELDS: Array<keyof BaselineEntry> = [
  'file',
  'line',
  'sha256_of_line',
  'category',
];
const CATEGORY_ENUM_V1_2 = new Set<string>([
  'ID_GENERATION',
  'NONCE',
  'JITTER_BACKOFF',
  'UPLOAD_FILENAME',
  'WEBSOCKET_CLIENTID',
]);

function loadBaseline(): BaselineDoc {
  assert.equal(
    fs.existsSync(BASELINE_JSON_PATH),
    true,
    `baseline JSON 未找到: ${BASELINE_JSON_PATH} · 见 ADR-0002 §2.2`
  );
  const raw = fs.readFileSync(BASELINE_JSON_PATH, 'utf-8');
  const doc = JSON.parse(raw) as BaselineDoc;
  assert.ok(Array.isArray(doc.entries), 'baseline JSON entries 字段非数组');
  return doc;
}

console.log('\n## §No-Math-Random-US-038 · Math.random 反蔓延门禁 · ADR-0002 §2.2 · Path C');

it('断言 A · backend/src 目录存在且非空', () => {
  assert.equal(fs.existsSync(BACKEND_SRC_DIR), true, `${BACKEND_SRC_DIR} not found`);
  const files = collectBackendTsFiles(BACKEND_SRC_DIR);
  assert.ok(files.length > 0, 'backend/src 扫描 0 个 .ts 文件');
});

it('断言 B · 反蔓延门禁 · 全 backend/src 命中 ∈ baseline 或 fail', () => {
  const baseline = loadBaseline();
  const baselineIndex = new Map<string, BaselineEntry>();
  for (const entry of baseline.entries) {
    baselineIndex.set(`${entry.file}:${entry.line}`, entry);
  }

  const files = collectBackendTsFiles(BACKEND_SRC_DIR);
  const newViolations: Array<{ file: string; line: number; note: string }> = [];
  const baselineHits: Array<{ file: string; line: number; note: string }> = [];
  const shaDrift: Array<{ file: string; line: number; expected: string; actual: string }> = [];

  for (const absFile of files) {
    const relPathFromRepo = path.relative(REPO_ROOT_DIR, absFile).replace(/\\/g, '/');
    const relPathFromSrc = path.relative(BACKEND_SRC_DIR, absFile);
    const segments = relPathFromSrc.split(path.sep);
    if (WHITELIST_PATH_FRAGMENTS.some(fragment => segments.includes(fragment))) {
      continue;
    }
    const hits = scanMathRandomHits(absFile);
    for (const hit of hits) {
      const key = `${relPathFromRepo}:${hit.line}`;
      const entry = baselineIndex.get(key);
      if (!entry) {
        newViolations.push({ file: relPathFromRepo, line: hit.line, note: hit.rawLine.trim() });
      } else {
        const actualSha = sha256Hex(hit.rawLine);
        if (actualSha !== entry.sha256_of_line) {
          shaDrift.push({
            file: relPathFromRepo,
            line: hit.line,
            expected: entry.sha256_of_line,
            actual: actualSha,
          });
        } else {
          baselineHits.push({ file: relPathFromRepo, line: hit.line, note: hit.rawLine.trim() });
        }
      }
    }
  }

  if (baselineHits.length > 0) {
    console.warn(
      `       [warn] baseline 内 ${baselineHits.length} 处 Math.random() 已知违反 · 允 burndown · 不阻塞 · 见 baseline JSON`
    );
  }

  if (shaDrift.length > 0) {
    const report = shaDrift
      .map(d => `  ${d.file}:${d.line} · expected sha256=${d.expected.slice(0, 12)}… · actual=${d.actual.slice(0, 12)}…`)
      .join('\n');
    throw new Error(
      `US-038 baseline SHA 漂移 · 已知位内容变更但未 refresh baseline JSON · ${shaDrift.length} 处:\n${report}\n` +
        `修复: 若该行仍有 Math.random() · 请刷新 sha256_of_line；若已改为 SeededRandom · 请从 baseline 移除该 entry`
    );
  }

  if (newViolations.length > 0) {
    const report = newViolations.map(v => `  ${v.file}:${v.line}  ${v.note}`).join('\n');
    throw new Error(
      `US-038 反蔓延门禁 · 检出 ${newViolations.length} 处新增 Math.random() 命中 (不在 baseline):\n${report}\n` +
        `修复: 使用 SeededRandom(seed) 显式播种 · 见 ADR-0002 §2.1 · 禁止扩大 baseline`
    );
  }
});

it('断言 C · 注释行 / 字符串字面量内的 Math.random 引用不计违反 (grep 精度守护)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-038-test-'));
  try {
    const commentedFile = path.join(tmpDir, 'commented.ts');
    fs.writeFileSync(
      commentedFile,
      [
        '// 本文件禁 Math.random() 直接调用',
        '/* block comment: Math.random() 也不算 */',
        'const msg = "avoid Math.random() call";',
        "const other = 'Math.random() 字面量';",
        'const seed = 42;',
      ].join('\n'),
      'utf-8'
    );
    const hits = scanMathRandomHits(commentedFile);
    assert.deepEqual(
      hits.map(h => h.line),
      [],
      `注释/字面量 假阳性命中: ${JSON.stringify(hits.map(h => h.line))}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

it('断言 D · 真实 Math.random() 调用命中 (正例反证 grep 灵敏度)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-038-test-'));
  try {
    const violatingFile = path.join(tmpDir, 'violating.ts');
    fs.writeFileSync(
      violatingFile,
      [
        'export function pickRandom(): number {',
        '  return Math.random();',
        '}',
        'export const arr = [Math.random(), Math.random()];',
        'export const rng: () => number = Math.random;',
        'export const groupId = `qgrid_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;',
      ].join('\n'),
      'utf-8'
    );
    const hits = scanMathRandomHits(violatingFile);
    assert.deepEqual(
      hits.map(h => h.line),
      [2, 4, 5, 6],
      `期望 [2,4,5,6] 实际 ${JSON.stringify(hits.map(h => h.line))}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

it('断言 F · baseline JSON schema 完整性 · 缺 file/line/sha256/category 任一字段即 fail', () => {
  const baseline = loadBaseline();
  // Phase 3 grand-close 后 · entries=0 (US-038 收官 · 反蔓延门禁转纯守) · 允空 · schema 完整性仅校验非空 entries 字段
  const brokenEntries: Array<{ index: number; missing: string[] }> = [];
  for (let i = 0; i < baseline.entries.length; i++) {
    const entry = baseline.entries[i] as Partial<BaselineEntry>;
    const missing: string[] = [];
    for (const field of REQUIRED_BASELINE_FIELDS) {
      const value = entry[field];
      if (value === undefined || value === null) {
        missing.push(field);
        continue;
      }
      if (field === 'line') {
        if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
          missing.push(`${field}(type)`);
        }
      } else if (typeof value !== 'string' || value.length === 0) {
        missing.push(`${field}(type)`);
      }
    }
    if (entry.sha256_of_line && typeof entry.sha256_of_line === 'string' && !/^[0-9a-f]{64}$/.test(entry.sha256_of_line)) {
      missing.push('sha256(format)');
    }
    if (
      entry.category !== undefined &&
      typeof entry.category === 'string' &&
      !CATEGORY_ENUM_V1_2.has(entry.category)
    ) {
      missing.push(`category(enum:${entry.category})`);
    }
    if (missing.length > 0) {
      brokenEntries.push({ index: i, missing });
    }
  }
  if (brokenEntries.length > 0) {
    const report = brokenEntries
      .map(b => `  entry[${b.index}] missing/invalid: ${b.missing.join(',')}`)
      .join('\n');
    throw new Error(
      `US-038 baseline JSON schema 不完整 · ${brokenEntries.length} 处:\n${report}\n` +
        `修复: 每 entry 必须含 4 字段 {file:string, line:int>0, sha256_of_line:64-hex, category:string}`
    );
  }
});

console.log(`\n## Summary: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
