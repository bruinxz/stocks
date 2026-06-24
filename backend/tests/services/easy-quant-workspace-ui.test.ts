/**
 * easy-quant-workspace-ui.test.ts
 *
 * Static frontend contract guard for the simplified quant workspace.
 * Local checkouts may not have frontend node_modules installed, so this
 * verifies route wiring, mock-only data, standalone shell isolation, and the
 * Claude-like warm editorial UI tokens.
 */

import * as fs from 'fs';
import * as path from 'path';

let failed = 0;
let passed = 0;
const REPO_ROOT = findRepoRoot();

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

function read(relativePath: string): string {
  const full = path.join(REPO_ROOT, relativePath);
  if (!fs.existsSync(full)) {
    failed += 1;
    console.error(`  FAIL file exists: ${relativePath}`);
    return '';
  }
  return fs.readFileSync(full, 'utf8');
}

function findRepoRoot(start = process.cwd()): string {
  let current = path.resolve(start);
  while (true) {
    if (
      fs.existsSync(path.join(current, 'frontend')) &&
      fs.existsSync(path.join(current, 'backend'))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Cannot find repo root from ${start}`);
    }
    current = parent;
  }
}

console.log('\n## EasyQuant simplified workspace UI contract');

const app = read('frontend/src/App.tsx');
const page = read('frontend/src/pages/workspace/EasyQuantWorkspace.tsx');
const css = read('frontend/src/pages/workspace/EasyQuantWorkspace.css');

assert(
  'App lazy loads EasyQuantWorkspace',
  /const EasyQuantWorkspace = lazy\(\(\) => import\('\.\/pages\/workspace\/EasyQuantWorkspace'\)\)/.test(
    app
  )
);
assert(
  'sidebar contains simplified workspace route',
  /menuLink\('\/workspace\/easy'[\s\S]{0,140}?简易版/.test(app)
);
assert(
  'router mounts /workspace/easy behind ProtectedRoute',
  /path="\/workspace\/easy"[\s\S]{0,220}?<ProtectedRoute>[\s\S]{0,120}?<EasyQuantWorkspace \/>/.test(
    app
  )
);
assert(
  'easy workspace has standalone route before modern layout shell',
  /location\.pathname\.startsWith\(['"]\/workspace\/easy['"]\)[\s\S]{0,360}?<EasyQuantWorkspace \/>[\s\S]{0,360}?<Layout className="modern-layout">/.test(
    app
  )
);
assert('page exposes stable test id', /data-testid=["']easy-quant-workspace["']/.test(page));
assert(
  'page keeps professional mode available',
  /to=["']\/workspace\/lab["'][\s\S]{0,80}?专业版/.test(page)
);
assert(
  'page covers the beginner flow',
  ['选择策略模板', '检查数据', '回测报告', '模拟观察'].every(label => page.includes(label))
);
assert(
  'page uses local mock constants instead of backend requests',
  /const dataChecks/.test(page) &&
    /const reportMetrics/.test(page) &&
    !/api\.(get|post|put|delete)/.test(page)
);
assert(
  'Claude-like warm editorial tokens are defined',
  css.includes('#f7f2e8') && css.includes('#171512') && css.includes('#c96338')
);
assert(
  'logo and restrained hand-drawn concepts are implemented in code',
  /EasyQuantMark/.test(page) && /JourneySketch/.test(page) && /eq-logo-mark/.test(css)
);
assert(
  'style avoids rejected blue dashboard palette',
  !/#2764b8|#1f3a5f|geekblue|蓝色后台/.test(page + css)
);
assert(
  'visible source avoids em dash and en dash',
  !/[\u2014\u2013]/.test(page) && !/[\u2014\u2013]/.test(css)
);

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
