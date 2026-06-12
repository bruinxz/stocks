/**
 * ResearchIntegrityService 单测 — Sprint 1A
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  ResearchIntegrityService,
  scanFileForLookahead,
  scanDirForLookahead,
  detectSurvivorshipBias,
  computeOOSDecayRatio,
  deriveResearchIntegrityVerdict,
  buildIntegritySummary,
  OOS_DECAY_WARN_THRESHOLD,
  OOS_DECAY_FAIL_THRESHOLD,
  LOOKAHEAD_PATTERNS,
} from '../../src/services/research/ResearchIntegrityService';

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}
function expectClose(name: string, actual: number, expected: number, eps = 1e-3) {
  assert(name, Number.isFinite(actual) && Math.abs(actual - expected) < eps, `expected≈${expected}, got=${actual}`);
}

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'research-integrity-test-'));
}

function testLookaheadPatterns() {
  console.log('\n## LOOKAHEAD_PATTERNS coverage');
  // 检查所有模式都能匹配各自描述的内容
  const cases: Array<[string, string]> = [
    ['Date.now()', 'const t = Date.now(); doStuff(t);'],
    ['new Date() (no args)', 'const d = new Date();'],
    ['getFuture*()', 'const x = getFuturePrice(symbol);'],
    ['getNext*()', 'const y = getNextBar(symbol);'],
    ['forward_return', 'features.push(row.forward_return);'],
    ['future_high', 'const h = data.future_high;'],
    ['next_day_*', 'await loadBar(stock).then(b => b.next_day_close);'],
  ];
  for (const [name, line] of cases) {
    const matched = LOOKAHEAD_PATTERNS.find(p => p.name === name);
    assert(`pattern "${name}" exists`, matched !== undefined);
    if (matched) {
      assert(`pattern "${name}" matches its example`, matched.pattern.test(line), `line=${line}`);
    }
  }
}

function testScanFileForLookahead() {
  console.log('\n## scanFileForLookahead');
  const tmpDir = makeTmpDir();
  try {
    const f1 = path.join(tmpDir, 'good.ts');
    fs.writeFileSync(
      f1,
      `// 这是一个干净的策略\nimport { ctx } from './ctx';\nexport function strat(ctx: any) {\n  return ctx.asOfDate;\n}\n`
    );
    const issues1 = scanFileForLookahead(f1);
    assert('干净文件 → 0 issues', issues1.length === 0);

    const f2 = path.join(tmpDir, 'bad.ts');
    fs.writeFileSync(
      f2,
      `export function strat(ctx: any) {\n  const now = Date.now();\n  const future = getFuturePrice('AAPL');\n  return [now, future];\n}\n`
    );
    const issues2 = scanFileForLookahead(f2);
    assert('Date.now() 被识别', issues2.some(i => i.pattern === 'Date.now()'));
    assert('getFuture*() 被识别', issues2.some(i => i.pattern === 'getFuture*()'));

    // 注释中的 Date.now() 不应误报
    const f3 = path.join(tmpDir, 'comment.ts');
    fs.writeFileSync(
      f3,
      `// 历史曾用 Date.now() 但已删除\n/* TODO: 不要写 getFuturePrice */\nexport function strat() { return 1; }\n`
    );
    const issues3 = scanFileForLookahead(f3);
    assert('注释中模式不误报', issues3.length === 0);

    // 字符串中的 Date.now() 不应误报
    const f4 = path.join(tmpDir, 'string.ts');
    fs.writeFileSync(f4, `const msg = "请勿调用 Date.now()";\n`);
    const issues4 = scanFileForLookahead(f4);
    assert('字符串中模式不误报', issues4.length === 0);

    // test.ts / spec.ts 跳过
    const f5 = path.join(tmpDir, 'something.test.ts');
    fs.writeFileSync(f5, `const x = Date.now();\n`);
    const issues5 = scanFileForLookahead(f5);
    assert('.test.ts 跳过', issues5.length === 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function testScanDirForLookahead() {
  console.log('\n## scanDirForLookahead');
  const tmpDir = makeTmpDir();
  try {
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), `export const x = Date.now();\n`);
    fs.writeFileSync(path.join(tmpDir, 'b.ts'), `export const y = 1;\n`);
    fs.mkdirSync(path.join(tmpDir, 'sub'));
    fs.writeFileSync(path.join(tmpDir, 'sub', 'c.ts'), `export const z = getNextBar();\n`);
    const issues = scanDirForLookahead(tmpDir);
    assert('递归扫描到 ≥ 2 个 issue', issues.length >= 2);
    assert('找到 a.ts 中的 Date.now()', issues.some(i => i.file.endsWith('a.ts')));
    assert('找到 sub/c.ts 中的 getNext*', issues.some(i => i.file.endsWith('c.ts')));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function testDetectSurvivorshipBias() {
  console.log('\n## detectSurvivorshipBias');
  // 当前 universe 在最早 snapshot 全有 → 0 issues
  const noBias = detectSurvivorshipBias({
    universe_snapshots: [
      { period_start: '2020-01-01', symbols: ['A', 'B', 'C'] },
    ],
    current_universe: ['A', 'B', 'C'],
  });
  assert('无偏差 → 0 issues', noBias.length === 0);

  // 当前 universe 中有新上市股 (D) 在最早 snapshot 没有 → unlisted_in_history
  const newly = detectSurvivorshipBias({
    universe_snapshots: [
      { period_start: '2020-01-01', symbols: ['A', 'B'] },
    ],
    current_universe: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'],
  });
  assert('新上市股 issue 出现', newly.some(i => i.kind === 'unlisted_in_history'));

  // 历史有但当前没有 → delisted_in_current_universe
  const delisted = detectSurvivorshipBias({
    universe_snapshots: [
      { period_start: '2020-01-01', symbols: ['A', 'B', 'C', 'D', 'E', 'F', 'G'] },
    ],
    current_universe: ['A'],
  });
  assert('退市股 issue 出现', delisted.some(i => i.kind === 'delisted_in_current_universe'));

  // 空输入 → 0
  assert('空 snapshots → 0', detectSurvivorshipBias({ universe_snapshots: [], current_universe: ['A'] }).length === 0);
  assert('空 current → 0', detectSurvivorshipBias({ universe_snapshots: [{ period_start: '2020', symbols: ['A'] }], current_universe: [] }).length === 0);
}

function testComputeOOSDecayRatio() {
  console.log('\n## computeOOSDecayRatio');
  expectClose('IS=2 OOS=1 → 2', computeOOSDecayRatio(2, 1) as number, 2);
  expectClose('IS=1 OOS=1 → 1', computeOOSDecayRatio(1, 1) as number, 1);
  expectClose('IS=1 OOS=2 → 0.5', computeOOSDecayRatio(1, 2) as number, 0.5);
  assert('OOS=0 → Infinity', computeOOSDecayRatio(1, 0) === Number.POSITIVE_INFINITY);
  assert('OOS<0 → Infinity', computeOOSDecayRatio(1, -0.5) === Number.POSITIVE_INFINITY);
  assert('IS<=0 → null', computeOOSDecayRatio(0, 1) === null);
  assert('null in → null', computeOOSDecayRatio(null, 1) === null);
}

function testDeriveVerdict() {
  console.log('\n## deriveResearchIntegrityVerdict');
  assert(
    'INSUFFICIENT — 全 null',
    deriveResearchIntegrityVerdict({
      dsr: null,
      pbo: null,
      oos_decay_ratio: null,
      lookahead_issues: [],
      survivorship_issues: [],
    }) === 'INSUFFICIENT'
  );
  assert(
    'PASS — DSR 高 / PBO 低 / OOS 健康',
    deriveResearchIntegrityVerdict({
      dsr: 0.99,
      pbo: 0.1,
      oos_decay_ratio: 1.2,
      lookahead_issues: [],
      survivorship_issues: [],
    }) === 'PASS'
  );
  assert(
    'FAIL — DSR 低',
    deriveResearchIntegrityVerdict({
      dsr: 0.5,
      pbo: null,
      oos_decay_ratio: null,
      lookahead_issues: [],
      survivorship_issues: [],
    }) === 'FAIL'
  );
  assert(
    'FAIL — PBO 高',
    deriveResearchIntegrityVerdict({
      dsr: 0.99,
      pbo: 0.6,
      oos_decay_ratio: 1.0,
      lookahead_issues: [],
      survivorship_issues: [],
    }) === 'FAIL'
  );
  assert(
    'FAIL — OOS decay 极高',
    deriveResearchIntegrityVerdict({
      dsr: 0.99,
      pbo: 0.1,
      oos_decay_ratio: OOS_DECAY_FAIL_THRESHOLD + 0.5,
      lookahead_issues: [],
      survivorship_issues: [],
    }) === 'FAIL'
  );
  assert(
    'FAIL — high lookahead',
    deriveResearchIntegrityVerdict({
      dsr: 0.99,
      pbo: 0.1,
      oos_decay_ratio: 1.0,
      lookahead_issues: [{ file: 'a.ts', line: 1, pattern: 'Date.now()', snippet: '', severity: 'high' }],
      survivorship_issues: [],
    }) === 'FAIL'
  );
  assert(
    'WARN — OOS decay 中等',
    deriveResearchIntegrityVerdict({
      dsr: 0.99,
      pbo: 0.1,
      oos_decay_ratio: 2.0,
      lookahead_issues: [],
      survivorship_issues: [],
    }) === 'WARN'
  );
  assert(
    'WARN — medium lookahead',
    deriveResearchIntegrityVerdict({
      dsr: 0.99,
      pbo: 0.1,
      oos_decay_ratio: 1.0,
      lookahead_issues: [{ file: 'a.ts', line: 1, pattern: 'forward_return', snippet: '', severity: 'medium' }],
      survivorship_issues: [],
    }) === 'WARN'
  );
}

function testBuildSummary() {
  console.log('\n## buildIntegritySummary');
  const pass = buildIntegritySummary({
    verdict: 'PASS',
    dsr: 0.98,
    pbo: 0.1,
    oos_decay_ratio: 1.2,
    lookahead_issues: [],
    survivorship_issues: [],
  });
  assert('PASS 含 ✅', pass.includes('✅') || pass.includes('PASS'));

  const fail = buildIntegritySummary({
    verdict: 'FAIL',
    dsr: 0.5,
    pbo: null,
    oos_decay_ratio: null,
    lookahead_issues: [{ file: 'a.ts', line: 1, pattern: 'Date.now()', snippet: '', severity: 'high' }],
    survivorship_issues: [],
  });
  assert('FAIL 含 DSR 提示', fail.includes('DSR'));
}

async function testServiceAudit() {
  console.log('\n## auditBacktest end-to-end');
  const svc = new ResearchIntegrityService({
    async loadBacktestStats() {
      return null;
    },
  });
  const report = await svc.auditBacktest(
    {
      observed_sharpe: 2.0,
      num_trials: 1,
      sample_length: 252,
      source: 'standalone',
    },
    { persist: false }
  );
  assert('DSR 算出', report.dsr !== null && Number.isFinite(report.dsr));
  assert('verdict 不是 INSUFFICIENT', report.verdict !== 'INSUFFICIENT');
  assert('summary 有内容', typeof report.summary_message === 'string' && report.summary_message.length > 0);

  // 多次试验 → DSR 下降
  const report2 = await svc.auditBacktest(
    {
      observed_sharpe: 2.0,
      num_trials: 1000,
      sample_length: 252,
      source: 'standalone',
    },
    { persist: false }
  );
  assert(
    '多试验 DSR < 单试验 DSR',
    report2.dsr !== null && report.dsr !== null && report2.dsr < report.dsr,
    `single=${report.dsr} multi=${report2.dsr}`
  );

  // 加 OOS 退化
  const reportOOS = await svc.auditBacktest(
    {
      observed_sharpe: 2.0,
      oos_sharpe: 0.3,
      num_trials: 1,
      sample_length: 252,
      source: 'standalone',
    },
    { persist: false }
  );
  assert('OOS decay ratio 计算', reportOOS.oos_decay_ratio !== null);
  assert(
    'OOS decay > WARN threshold → WARN/FAIL',
    reportOOS.verdict === 'WARN' || reportOOS.verdict === 'FAIL'
  );
}

async function main() {
  testLookaheadPatterns();
  testScanFileForLookahead();
  testScanDirForLookahead();
  testDetectSurvivorshipBias();
  testComputeOOSDecayRatio();
  testDeriveVerdict();
  testBuildSummary();
  await testServiceAudit();
  console.log(`\n========================================`);
  console.log(`ResearchIntegrityService tests: ${passed} pass / ${failed} fail`);
  console.log(`========================================`);
  process.exit(failed > 0 ? 1 : 0);
}
main();
