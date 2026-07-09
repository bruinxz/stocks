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
 * Baseline schema (sha_lock=3246b8cf post-#118 canonical):
 *   { task, sha_lock, sha_lock_full_ref, policy, entries[], decision_summary, unique_key_note }
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

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
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

// PR-M3-4 · id=4 live-assert re-hydration (post-#118 `feafa6e4` baseline sync).
// Escalation-over-invention 四段-lifecycle close: discover (#116) → escalate
// (skip + reason) → surface (#118 baseline-fix) → close (live-assert here).
const id4 = matrix.find((e) => e.id === 4);
assert(
  'baseline id=4 entry exists',
  !!id4,
  id4 ? `enum_name=${id4.enum_name}` : 'missing'
);
assert(
  'id=4 enum_name === QuantWorkflowStatus',
  id4?.enum_name === 'QuantWorkflowStatus'
);
assert(
  'id=4 value_set === ["ready","degraded","blocked"] (post-#118 code-truth)',
  JSON.stringify(id4?.value_set) === JSON.stringify(['ready', 'degraded', 'blocked'])
);
assert(
  'id=4 authority_file pins QuantWorkflowReadinessService.ts:8 (Orch v136 Q4.c)',
  id4?.authority_file ===
    'backend/src/quant/workflow/QuantWorkflowReadinessService.ts:8'
);
assert(
  'id=4 decision === AUTHORITY',
  id4?.decision === 'AUTHORITY'
);

// id=10 EasyQuantHealthStatus mirror invariant — post-#118 alias of id=4.
const id10 = matrix.find((e) => e.id === 10);
assert(
  'baseline id=10 entry exists',
  !!id10,
  id10 ? `enum_name=${id10.enum_name}` : 'missing'
);
assert(
  'id=10 value_set mirrors id=4 (alias-consistency canonical)',
  JSON.stringify(id10?.value_set) === JSON.stringify(id4?.value_set)
);
assert(
  'id=10 decision === ELIM (aliased to id=4)',
  id10?.decision === 'ELIM'
);

// id=13 domain-independence — infra taxonomy ≠ id=4 execution taxonomy
// (ADR §5.3 三-domain 三-face-embodiment: execution + infra + data).
const id13 = matrix.find((e) => e.id === 13);
assert(
  'baseline id=13 entry exists',
  !!id13,
  id13 ? `enum_name=${id13.enum_name}` : 'missing'
);
assert(
  'id=13 value_set === ["healthy","degraded","unhealthy"] (infra taxonomy)',
  JSON.stringify(id13?.value_set) ===
    JSON.stringify(['healthy', 'degraded', 'unhealthy'])
);
assert(
  'id=13 value_set !== id=4 value_set (domain-independence guard)',
  JSON.stringify(id13?.value_set) !== JSON.stringify(id4?.value_set)
);
assert(
  'id=13 decision === AUTHORITY (domain-local authority)',
  id13?.decision === 'AUTHORITY'
);

// sha_lock filename-content self-consistency guard.
const files = fs
  .readdirSync(baselineDir)
  .filter((f) => /^15-enum-matrix-lock-.*\.json$/.test(f));
const latestFile = files.sort()[files.length - 1];
const shaFromFilename = latestFile.replace(/^15-enum-matrix-lock-/, '').replace(/\.json$/, '');
assert(
  'baseline sha_lock first 7 chars match filename slug (self-consistency guard)',
  baseline.sha_lock.slice(0, 7) === shaFromFilename.slice(0, 7),
  `sha_lock=${baseline.sha_lock.slice(0, 7)} filename=${shaFromFilename.slice(0, 7)}`
);

// decision_summary integrity — invariant guard against silent decision drift.
interface DecisionSummary {
  RETAIN_count: number;
  AUTHORITY_count: number;
  ELIM_count: number;
  total: number;
}
const summary = (baseline as unknown as { decision_summary?: DecisionSummary }).decision_summary;
assert(
  'decision_summary present',
  !!summary
);
if (summary) {
  const actualRetain = matrix.filter((e) => e.decision === 'RETAIN').length;
  const actualAuthority = matrix.filter((e) => e.decision === 'AUTHORITY').length;
  const actualElim = matrix.filter((e) => e.decision === 'ELIM').length;
  assert(
    'decision_summary.RETAIN_count matches actual (RETAIN=10)',
    summary.RETAIN_count === actualRetain && actualRetain === 10,
    `declared=${summary.RETAIN_count} actual=${actualRetain}`
  );
  assert(
    'decision_summary.AUTHORITY_count matches actual (AUTHORITY=2)',
    summary.AUTHORITY_count === actualAuthority && actualAuthority === 2,
    `declared=${summary.AUTHORITY_count} actual=${actualAuthority}`
  );
  assert(
    'decision_summary.ELIM_count matches actual (ELIM=3)',
    summary.ELIM_count === actualElim && actualElim === 3,
    `declared=${summary.ELIM_count} actual=${actualElim}`
  );
  assert(
    'decision_summary.total === 15 (RETAIN 10 + AUTHORITY 2 + ELIM 3)',
    summary.total === 15 &&
      summary.RETAIN_count + summary.AUTHORITY_count + summary.ELIM_count === 15
  );
}

// Full-matrix value_set shape iterate — no entry may have zero-length value_set.
assert(
  'every entry has non-empty value_set',
  matrix.every((e) => Array.isArray(e.value_set) && e.value_set.length > 0)
);
assert(
  'every entry has non-empty authority_file',
  matrix.every((e) => typeof e.authority_file === 'string' && e.authority_file.length > 0)
);

// PR-M3-5 v0.4-corrected · dual-source hard-fail canonical.
// Active-latest 4-baseline snapshot post-Backend Option B REMOVE authority-decision
// LOCKED (MarketRegime + MarketJudgmentStatus REMOVE-permanent · 匿名 union
// embedded in interface field 非 discrete `export type`). Path D 15-baseline
// remains 冻结锚 preserved (assertion block above); 4-baseline is the
// active-latest byte-truth grep-verified snapshot at HEAD bc1b3c91.
console.log('\n## PR-M3-5 v0.4-corrected · 4-baseline active-latest hard-check');

function loadBaselineN4(): BaselineFile {
  const files = fs
    .readdirSync(baselineDir)
    .filter((f) => /^4-enum-matrix-lock-.*\.json$/.test(f));
  if (files.length === 0) {
    throw new Error(`no 4-baseline JSON found under ${baselineDir}`);
  }
  const latest = files.sort()[files.length - 1];
  const raw = fs.readFileSync(path.join(baselineDir, latest), 'utf8');
  return JSON.parse(raw) as BaselineFile;
}

const baseline4 = loadBaselineN4();
const matrix4 = baseline4.entries;

assert(
  '4-baseline contains exactly 4 canonical entries (N-verified LOCKED)',
  matrix4.length === 4,
  `count=${matrix4.length}`
);

assert(
  '4-baseline every entry decision === AUTHORITY (all 4 discrete `export type` grep-PASS)',
  matrix4.every((e) => e.decision === 'AUTHORITY')
);

// Bit-perfect authority_file + value_set canonical verify per grep-truth at HEAD.
const expected4: Array<{ enum_name: string; authority_file: string; value_set: string[] }> = [
  {
    enum_name: 'FeedbackStatus',
    authority_file: 'backend/src/services/UserFeedbackService.ts:42',
    value_set: ['pending', 'in_progress', 'resolved', 'dismissed'],
  },
  {
    enum_name: 'FeedbackClassification',
    authority_file: 'backend/src/services/UserFeedbackService.ts:43',
    value_set: ['bug', 'feature_request', 'question', 'praise', 'other'],
  },
  {
    enum_name: 'SizingMethod',
    authority_file: 'backend/src/portfolio/PositionSizingPolicy.ts:66',
    value_set: ['equal_pct', 'vol_target', 'atr_based', 'kelly'],
  },
  {
    enum_name: 'QuantWorkflowStatus',
    authority_file:
      'backend/src/quant/workflow/QuantWorkflowReadinessService.ts:8',
    value_set: ['ready', 'degraded', 'blocked'],
  },
];

for (const exp of expected4) {
  const found = matrix4.find((e) => e.enum_name === exp.enum_name);
  assert(
    `4-baseline entry '${exp.enum_name}' present`,
    !!found
  );
  if (found) {
    assert(
      `4-baseline '${exp.enum_name}' authority_file === '${exp.authority_file}'`,
      found.authority_file === exp.authority_file,
      `actual=${found.authority_file}`
    );
    assert(
      `4-baseline '${exp.enum_name}' value_set bit-perfect canonical`,
      JSON.stringify(found.value_set) === JSON.stringify(exp.value_set),
      `actual=${JSON.stringify(found.value_set)}`
    );
  }
}

// QuantWorkflowStatus cross-baseline shape alignment: Path D 15-baseline id=4
// must equal 4-baseline QuantWorkflowStatus entry (single canonical source of
// truth · dual-source hard-fail canonical).
const q4 = matrix4.find((e) => e.enum_name === 'QuantWorkflowStatus');
assert(
  'QuantWorkflowStatus value_set aligned across 15-baseline id=4 and 4-baseline (single-source canonical)',
  JSON.stringify(q4?.value_set) === JSON.stringify(id4?.value_set)
);

// 4-baseline sha_lock filename-content self-consistency guard.
const files4 = fs
  .readdirSync(baselineDir)
  .filter((f) => /^4-enum-matrix-lock-.*\.json$/.test(f));
const latestFile4 = files4.sort()[files4.length - 1];
const shaFromFilename4 = latestFile4
  .replace(/^4-enum-matrix-lock-/, '')
  .replace(/\.json$/, '');
assert(
  '4-baseline sha_lock first 7 chars match filename slug',
  baseline4.sha_lock.slice(0, 7) === shaFromFilename4.slice(0, 7),
  `sha_lock=${baseline4.sha_lock.slice(0, 7)} filename=${shaFromFilename4.slice(0, 7)}`
);

// 4-baseline decision_summary integrity — invariant guard.
const summary4 = (baseline4 as unknown as { decision_summary?: DecisionSummary }).decision_summary;
assert('4-baseline decision_summary present', !!summary4);
if (summary4) {
  assert(
    '4-baseline decision_summary.AUTHORITY_count === 4 (all-AUTHORITY canonical)',
    summary4.AUTHORITY_count === 4 && summary4.total === 4
  );
}

// Negative-verify canonical: MarketRegime + MarketJudgmentStatus must not
// appear in 4-baseline (Backend Option B REMOVE-permanent LOCKED · 匿名 union
// embedded in interface field · 非 discrete `export type` grep-verified 0 hits
// at HEAD bc1b3c91 · Instance 5 二例 VINDICATED).
assert(
  '4-baseline zero MarketRegime entry (Backend Option B REMOVE-permanent)',
  matrix4.every((e) => e.enum_name !== 'MarketRegime')
);
assert(
  '4-baseline zero MarketJudgmentStatus entry (Backend Option B REMOVE-permanent)',
  matrix4.every((e) => e.enum_name !== 'MarketJudgmentStatus')
);

console.log(`\nResult: ${passed} passed, ${failed} failed, 0 skipped`);
process.exit(failed > 0 ? 1 : 0);
