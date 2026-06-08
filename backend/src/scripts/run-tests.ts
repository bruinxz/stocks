#!/usr/bin/env node
/**
 * 后端测试 runner (US-069 CI 流水线)
 *
 * 项目所有 backend 测试遵循"IIFE + process.exit"约定（不依赖 jest，避免 babel-jest
 * 对 ts-node 语法的复杂集成）—— 单个测试文件通过：
 *   npx ts-node --transpile-only tests/<dir>/<name>.test.ts
 * 退出码 0/1 即代表全部 ok / 任一失败。
 *
 * 本 runner 顺序扫 tests/ 下所有 *.test.ts，逐个 spawn 子进程跑（独立 process 隔离全
 * 局状态 / fake DataSource 注入互不污染），收集 summary 后整体 exit。
 *
 * 用法：
 *   cd backend && npm test                      # 全跑
 *   cd backend && npm test -- --filter=risk     # 仅含 "risk" 路径的 test 文件
 *   cd backend && npm test -- --bail            # 首次失败立即退出
 *   cd backend && npm test -- --quiet           # 隐藏子进程 stdout（仅打印失败 + summary）
 *
 * CI 中典型用法（.github/workflows/ci.yml）：
 *   - name: Backend tests
 *     run: cd backend && npm test
 *
 * 关键约束：
 *   - 不依赖 jest 全局 API（describe/it/expect）。所有 test 文件自带 assert 框架
 *     并在末尾 process.exit。runner 仅收集 spawn exit code。
 *   - 子进程串行而非并发：避免 fake DataSource singleton 互相覆盖 + log 交错
 *     难读 + DB-less 单测本身极快（54 个文件全跑 ~30s 在本机）。
 *   - 失败仍继续跑剩余文件（除非 --bail），summary 一次列清。
 *   - --quiet 模式下，失败子进程仍打印 stdout/stderr（追溯失败上下文必备）。
 */

import { spawnSync } from 'child_process';
import { existsSync, readdirSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';

interface CliOptions {
  filter?: string;
  bail: boolean;
  quiet: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { bail: false, quiet: false };
  for (const arg of argv) {
    if (arg === '--bail') opts.bail = true;
    else if (arg === '--quiet') opts.quiet = true;
    else if (arg.startsWith('--filter=')) opts.filter = arg.slice('--filter='.length);
  }
  return opts;
}

function findTestFiles(rootDir: string): string[] {
  const results: string[] = [];
  if (!existsSync(rootDir)) return results;

  function walk(dir: string): void {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (entry === 'node_modules' || entry === 'dist') continue;
        walk(full);
      } else if (st.isFile() && full.endsWith('.test.ts')) {
        results.push(full);
      }
    }
  }

  walk(rootDir);
  results.sort();
  return results;
}

interface FileResult {
  file: string;
  ok: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function runOne(file: string, opts: CliOptions): FileResult {
  const start = Date.now();
  const proc = spawnSync('npx', ['ts-node', '--transpile-only', file], {
    cwd: resolve(__dirname, '../..'),
    encoding: 'utf-8',
    env: { ...process.env, NODE_ENV: 'test' },
    stdio: opts.quiet ? 'pipe' : ['ignore', 'inherit', 'inherit'],
  });
  const duration = Date.now() - start;
  const ok = proc.status === 0;
  return {
    file,
    ok,
    durationMs: duration,
    stdout: proc.stdout || '',
    stderr: proc.stderr || '',
    exitCode: proc.status,
  };
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const testsDir = resolve(__dirname, '../../tests');
  const allFiles = findTestFiles(testsDir);
  const files = opts.filter ? allFiles.filter(f => f.includes(opts.filter as string)) : allFiles;

  if (files.length === 0) {
    console.error(
      `No test files found under ${testsDir}${
        opts.filter ? ` matching --filter=${opts.filter}` : ''
      }`
    );
    process.exit(1);
  }

  console.log(
    `Running ${files.length} test file(s)${opts.filter ? ` (filter: ${opts.filter})` : ''}...`
  );
  console.log('');

  const cwd = resolve(__dirname, '../..');
  const results: FileResult[] = [];
  let failedCount = 0;

  for (const [idx, file] of files.entries()) {
    const rel = relative(cwd, file);
    process.stdout.write(`[${idx + 1}/${files.length}] ${rel} ... `);
    const result = runOne(file, opts);
    results.push(result);

    if (result.ok) {
      console.log(`OK (${fmtMs(result.durationMs)})`);
    } else {
      failedCount += 1;
      console.log(`FAIL (exit=${result.exitCode}, ${fmtMs(result.durationMs)})`);
      if (opts.quiet) {
        // 在 --quiet 模式下，失败必须打 stdout/stderr 否则无从查 cause
        if (result.stdout) console.log('--- stdout ---\n' + result.stdout);
        if (result.stderr) console.log('--- stderr ---\n' + result.stderr);
      }
      if (opts.bail) {
        console.error(`\nBail: first failure at ${rel}`);
        break;
      }
    }
  }

  const totalMs = results.reduce((acc, r) => acc + r.durationMs, 0);
  console.log('');
  console.log('================================================');
  console.log(
    `Total: ${results.length} files, ${
      results.length - failedCount
    } passed, ${failedCount} failed, ${fmtMs(totalMs)} elapsed`
  );
  console.log('================================================');

  if (failedCount > 0) {
    console.log('\nFailed test files:');
    for (const r of results) {
      if (!r.ok) {
        console.log(`  - ${relative(cwd, r.file)} (exit=${r.exitCode})`);
      }
    }
    process.exit(1);
  }

  process.exit(0);
}

main().catch(err => {
  console.error('run-tests crashed:', err);
  process.exit(2);
});
