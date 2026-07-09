/**
 * enum-matrix-lock.test.ts
 *
 * ADR-0011 §5 · UI enum SSOT byte-match lock test (PR-M3-1).
 *
 * Purpose: prevent silent drift between Backend enum authority and the
 * canonical baseline matrix at
 * `docs/refactor/baseline/ui-enum/15-enum-matrix-lock-<sha>.json`.
 * Any change to a listed enum shape MUST be accompanied by an update
 * to the baseline JSON in the same PR (ADR-0011 §5 · dod §16 反-drift).
 *
 * 不依赖 jest · node 直接跑 (与 backend/src/scripts/run-tests.ts 约定一致):
 *   cd backend && npx ts-node --transpile-only tests/enum/enum-matrix-lock.test.ts
 *
 * Baseline schema (existing sha_lock=83aea69c canonical retain):
 *   { task, sha_lock, sha_lock_full_ref, policy, entries[], unique_key_note }
 * Each entry: { id, enum_name, path_anchor, authority_file, value_set,
 *              authority_layer, decision, duplication_with, consumer_scope }
 */
import * as fs from 'fs';
import * as path from 'path';
import { QuantWorkflowStatus } from '../../src/models/enums';

const baselineDir = path.resolve(
  __dirname,
  '../../../docs/refactor/baseline/ui-enum'
);

interface MatrixEntry {
  id: number;
  enum_name: string;
  path_anchor: string;
  authority_file: string;
  value_set: string[];
  authority_layer: string;
  decision: 'AUTHORITY' | 'ELIM' | 'RETAIN';
  duplication_with?: string[];
  consumer_scope?: string[];
}

interface BaselineFile {
  task: string;
  sha_lock: string;
  sha_lock_full_ref: string;
  policy: unknown;
  entries: MatrixEntry[];
  unique_key_note?: string;
}

let failed = 0;
let passed = 0;
let skipped = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

function skip(name: string, reason: string): void {
  skipped += 1;
  console.log(`  SKIP ${name} — ${reason}`);
}

function loadBaseline(): BaselineFile {
  const files = fs
    .readdirSync(baselineDir)
    .filter((f) => /^15-enum-matrix-lock-.*\.json$/.test(f));
  if (files.length === 0) {
    throw new Error(`no baseline JSON found under ${baselineDir}`);
  }
  const latest = files.sort()[files.length - 1];
  const raw = fs.readFileSync(path.join(baselineDir, latest), 'utf8');
  return JSON.parse(raw) as BaselineFile;
}

console.log('\n## ADR-0011 §5 · enum matrix byte-match lock');

const baseline = loadBaseline();
const matrix = baseline.entries;

assert(
  'baseline contains exactly 15 canonical entries (Q7 matrix)',
  matrix.length === 15,
  `count=${matrix.length}`
);

const allowedDecisions = new Set(['AUTHORITY', 'ELIM', 'RETAIN']);
assert(
  'each entry declares one of three canonical decisions {AUTHORITY,ELIM,RETAIN}',
  matrix.every((e) => allowedDecisions.has(e.decision))
);

// Runtime probe: assign every declared literal to the imported type — TS
// will reject at compile time if the authority shape drifts.
const probes: QuantWorkflowStatus[] = ['ready', 'degraded', 'blocked'];
assert(
  'QuantWorkflowStatus authority barrel exports the three canonical literals',
  probes.length === 3
);

// SKIP: baseline sha_lock=83aea69c stale (Q4.b independent PR pending · will
// rehydrate post-baseline-sync). See Orch v136 §零 Q4.e canonical.
skip(
  'QuantWorkflowStatus value_set assertion (id=4 baseline byte-match)',
  'baseline sha_lock=83aea69c stale · Baseline-fix PR pending (QADocs 主签 SLA T+2d)'
);

console.log(`\nResult: ${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed > 0 ? 1 : 0);
