#!/usr/bin/env node
/**
 * 轻量架构依赖扫描（零依赖）。
 *
 * 上线 launch-helper：用本地静态分析检测三件事：
 *   1. live-trading/ 内部循环依赖（运行时无问题但维护期会爆雷）
 *   2. live-trading service 与外层 service / api 之间的跨层引用（应单向）
 *   3. 标记可能未被使用的 export（仅 hint，不 fail）
 *
 * 用法：
 *   node scripts/ci/check_architecture.js [--strict]
 *
 * --strict：循环依赖 / 跨层违规即 exit 1（CI 推荐打开）。
 * 默认 dry-run，只汇总报告。
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '../..');
const srcRoot = path.join(repoRoot, 'backend/src');

const STRICT = process.argv.includes('--strict');

if (!fs.existsSync(srcRoot)) {
  console.error('backend/src 不存在');
  process.exit(2);
}

// ----- 收集所有 .ts 文件 -----
function listTs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTs(full));
    else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) && !/\.spec\.ts$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const files = listTs(srcRoot);

// ----- 解析每个文件的 import 边 -----
function parseImports(file) {
  const src = fs.readFileSync(file, 'utf8');
  const imports = [];
  const re = /(?:^|\n)\s*import\s+(?:[^'"]+from\s+)?['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    imports.push(m[1]);
  }
  return imports;
}

function resolveLocal(fromFile, spec) {
  if (!spec.startsWith('.')) return null;  // 第三方
  const abs = path.resolve(path.dirname(fromFile), spec);
  for (const ext of ['.ts', '.tsx', '/index.ts', '/index.tsx']) {
    if (fs.existsSync(abs + ext)) return abs + ext;
  }
  // 已经带后缀
  if (fs.existsSync(abs)) return abs;
  return null;
}

const graph = new Map();  // file -> [file]
for (const f of files) graph.set(f, []);

for (const f of files) {
  for (const spec of parseImports(f)) {
    const resolved = resolveLocal(f, spec);
    if (resolved && graph.has(resolved)) graph.get(f).push(resolved);
  }
}

// ----- 检测循环依赖（Tarjan SCC） -----
function findCycles(g) {
  let index = 0;
  const indices = new Map();
  const lowlinks = new Map();
  const onStack = new Set();
  const stack = [];
  const cycles = [];

  function strongconnect(v) {
    indices.set(v, index);
    lowlinks.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of g.get(v) || []) {
      if (!indices.has(w)) {
        strongconnect(w);
        lowlinks.set(v, Math.min(lowlinks.get(v), lowlinks.get(w)));
      } else if (onStack.has(w)) {
        lowlinks.set(v, Math.min(lowlinks.get(v), indices.get(w)));
      }
    }
    if (lowlinks.get(v) === indices.get(v)) {
      const component = [];
      while (true) {
        const w = stack.pop();
        onStack.delete(w);
        component.push(w);
        if (w === v) break;
      }
      if (component.length > 1) cycles.push(component);
      else if (component.length === 1 && (g.get(component[0]) || []).includes(component[0])) {
        cycles.push(component);  // 自引用
      }
    }
  }

  for (const v of g.keys()) {
    if (!indices.has(v)) strongconnect(v);
  }
  return cycles;
}

// ----- 跨层规则 -----
// live-trading/* 内部允许互引；但 live-trading 不应被它之外的业务层 import
//   例外：api/routes/* 注册 live-trading routes（顶层 wire），index.ts，scripts/*
// live-trading service 应该只引 ../../models / utils / config，不引 api/* / services 之外的业务
function ruleCheckLiveTrading(graph) {
  const violations = [];
  for (const [from, tos] of graph) {
    const fromIsLive = /\/live-trading\//.test(from);
    for (const to of tos) {
      const toIsLive = /\/live-trading\//.test(to);
      // 白名单：live-trading 下被设计为可跨域共享的常量/类型 / 跨域引用允许
      const toIsSharedConstant = /\/live-trading\/auditEvents\.ts$/.test(to);
      if (!fromIsLive && toIsLive && !toIsSharedConstant) {
        // 外面引 live-trading：允许 api/* routes、live-trading 本身、index.ts、scripts/*
        const allow =
          /\/api\/.*\.routes\.ts$/.test(from) ||
          /backend\/src\/index\.ts$/.test(from) ||
          /\/scripts\//.test(from);
        if (!allow) {
          violations.push({ rule: 'outside-imports-live-trading', from, to });
        }
      }
      if (fromIsLive) {
        // live-trading 内 service 不应 import 外层 service / controller（除 models / utils / config）
        const fromIsService = /\/live-trading\/services\//.test(from) || /\/live-trading\/brokers\//.test(from);
        if (fromIsService) {
          const toRel = path.relative(srcRoot, to).replace(/\\/g, '/');
          if (
            !toRel.startsWith('live-trading/') &&
            !toRel.startsWith('models/') &&
            !toRel.startsWith('utils/') &&
            !toRel.startsWith('config/') &&
            !toRel.startsWith('jobs/') &&
            !toRel.startsWith('services/')  // 允许复用通用 service（例如 FeishuBotWebhookService）
          ) {
            violations.push({ rule: 'live-service-imports-out-of-allowed', from, to });
          }
        }
      }
    }
  }
  return violations;
}

// ----- 未被引用的 export（仅 live-trading 范围；范围太大会噪音） -----
function findUnusedExportsLiveTrading() {
  const liveFiles = files.filter(f => /\/live-trading\//.test(f) && !/\.test\.ts$/.test(f));
  const declared = new Map();  // file -> [exportName]
  for (const f of liveFiles) {
    const src = fs.readFileSync(f, 'utf8');
    const names = [];
    const reList = [
      /export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g,
      /export\s+(?:const|let|var)\s+([A-Za-z0-9_]+)/g,
      /export\s+class\s+([A-Za-z0-9_]+)/g,
      /export\s+interface\s+([A-Za-z0-9_]+)/g,
      /export\s+type\s+([A-Za-z0-9_]+)/g,
    ];
    for (const re of reList) {
      let m;
      while ((m = re.exec(src)) !== null) names.push(m[1]);
    }
    declared.set(f, names);
  }
  // 把所有 ts 文件文本拼起来 grep（zhc 不严谨，但 live-trading 范围足够）
  const corpus = files.map(f => fs.readFileSync(f, 'utf8')).join('\n');
  const unused = [];
  for (const [f, names] of declared) {
    for (const n of names) {
      // 至少出现 2 次（一次是声明本身，>=1 次引用）
      const occurrences = (corpus.match(new RegExp(`\\b${n}\\b`, 'g')) || []).length;
      if (occurrences <= 1) unused.push({ file: f, name: n });
    }
  }
  return unused;
}

// ----- 跑 -----
const cycles = findCycles(graph);
const violations = ruleCheckLiveTrading(graph);
const unused = findUnusedExportsLiveTrading();

function rel(f) { return path.relative(srcRoot, f).replace(/\\/g, '/'); }

console.log('=== 架构依赖扫描 ===');
console.log(`- 已分析 .ts 文件：${files.length}`);
console.log(`- 循环依赖 SCC：${cycles.length}`);
console.log(`- 跨层违规：${violations.length}`);
console.log(`- live-trading 未使用 export 候选：${unused.length}`);

if (cycles.length) {
  console.log('\n=== 循环依赖 ===');
  for (const cyc of cycles) {
    console.log('  cycle:');
    for (const f of cyc) console.log('    ' + rel(f));
  }
}

if (violations.length) {
  console.log('\n=== 跨层违规 ===');
  for (const v of violations) {
    console.log(`  [${v.rule}]`);
    console.log(`    from ${rel(v.from)}`);
    console.log(`    →    ${rel(v.to)}`);
  }
}

if (unused.length) {
  console.log('\n=== 未使用 export 候选（仅 hint，可能被反射使用） ===');
  for (const u of unused.slice(0, 30)) {
    console.log(`  ${rel(u.file)} :: ${u.name}`);
  }
  if (unused.length > 30) console.log(`  ... ${unused.length - 30} more`);
}

const hardFail = cycles.length > 0 || violations.length > 0;
if (STRICT && hardFail) {
  console.error('\n❌ --strict 模式：循环依赖 / 跨层违规即失败');
  process.exit(1);
}
if (!STRICT && hardFail) {
  console.log('\n⚠️ 有循环依赖 / 跨层违规但 dry-run 模式不 fail；CI 跑 --strict 强约束');
}
console.log('\n✅ 扫描完成');
