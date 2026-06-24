/**
 * lab-workflow-readiness-ui.test.ts
 *
 * Frontend contract guard for the phase 1-3 quant workflow readiness UI.
 * This is a static test because the local checkout may not have frontend
 * node_modules installed, while CI can still run the normal frontend build.
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

console.log('\n## LabWorkspace workflow readiness UI contract');

const labService = read('frontend/src/services/labService.ts');
const labWorkspace = read('frontend/src/pages/workspace/LabWorkspace.tsx');
const tab = read('frontend/src/pages/workspace/LabWorkspace.WorkflowReadinessTab.tsx');

assert(
  'labService calls workflow-presets endpoint',
  /api\.get\(['"]\/quant\/workflow-presets['"]\)/.test(labService)
);
assert(
  'labService calls workflow-readiness evaluate endpoint',
  /api\.post\(['"]\/quant\/workflow-readiness\/evaluate['"]/.test(labService)
);
assert(
  'LabWorkspace imports WorkflowReadinessTab',
  /LabWorkspace\.WorkflowReadinessTab/.test(labWorkspace) && /WorkflowReadinessTab/.test(labWorkspace)
);
assert(
  'LabWorkspace registers 工作流体检 tab before 我的策略',
  /key:\s*['"]workflow_readiness['"][\s\S]{0,120}?label:\s*['"]工作流体检['"]/.test(
    labWorkspace
  )
);
assert(
  'LabWorkspace renders WorkflowReadinessTab for workflow_readiness active key',
  /activeKey\s*===\s*['"]workflow_readiness['"][\s\S]{0,240}?<WorkflowReadinessTab/.test(
    labWorkspace
  )
);
assert(
  'WorkflowReadinessTab has stable test id',
  /data-testid=["']workflow-readiness-tab["']/.test(tab)
);
assert(
  'WorkflowReadinessTab shows stage 1-3 labels',
  /阶段 1/.test(tab) && /阶段 2/.test(tab) && /阶段 3/.test(tab)
);
assert(
  'WorkflowReadinessTab clarifies self-assessment semantics',
  /自评表单/.test(tab) && /不会自动拉取数据库/.test(tab) && /解锁真实 canary/.test(tab)
);
assert(
  'WorkflowReadinessTab renders preset selector and next actions',
  /workflow-readiness-preset-select/.test(tab) && /下一步/.test(tab)
);
assert(
  'WorkflowReadinessTab exposes manual refresh',
  /workflow-readiness-refresh/.test(tab) && /ReloadOutlined/.test(tab)
);

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
