/**
 * feasibilityGate 单元测试 (US-015 / EX-001)
 *
 *   cd backend && npx ts-node --transpile-only tests/portfolio/feasibility-gate.test.ts
 *
 * 覆盖:
 *   [1] FEASIBILITY_BLOCK_THRESHOLD === 60 (AC 主条款守卫)
 *   [2] deriveFeasibilityGateOutcome 决策矩阵 (fillable / risky+score≥60 / score<60 / blocked)
 *       含边界 (score=60.0 严格放行 / score=59.99 拒)
 *   [3] buildFeasibilityGateMessage 四个 variant 文案含 score + reasons
 *   [4] evaluateFeasibilityGate 注入 fake service:
 *       happy fillable / blocked decision / score=55 / score=65 risky / score=70 fillable /
 *       service throw 时 fail-OPEN 返 ok=true
 *   [5] emitFeasibilityGateAlert 注入 fake riskAlertService:
 *       MEDIUM 调一次 + tag='feasibility_blocked' + rule_id 正确 / LOW 调一次 + tag 不同 /
 *       write throw 不 re-throw
 *   [6] META-GUARD fs+regex 扫:
 *       - feasibilityGate.ts export FEASIBILITY_BLOCK_THRESHOLD = 60
 *       - PaperTradingFacade.ts import evaluateFeasibilityGate + call + throw EXECUTION_FEASIBILITY_BLOCKED
 *       - LiveTradingService.ts import + call + audit ORDER_BLOCKED_BY_FEASIBILITY
 *       - auditEvents.ts 含 ORDER_BLOCKED_BY_FEASIBILITY + ORDER_FEASIBILITY_WARN
 *
 * 不依赖 jest, 与项目其它 backend tests 同款 IIFE + process.exit 模板.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  FEASIBILITY_BLOCK_THRESHOLD,
  FEASIBILITY_GATE_RULE_ID,
  FEASIBILITY_GATE_LABEL,
  evaluateFeasibilityGate,
  emitFeasibilityGateAlert,
  deriveFeasibilityGateOutcome,
  buildFeasibilityGateMessage,
} from '../../src/portfolio/internal/feasibilityGate';
import { ExecutionFeasibilityReport } from '../../src/services/execution/ExecutionFeasibilityService';

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`❌ ${name}${detail ? ' ' + detail : ''}`);
  }
}

function buildReport(overrides: Partial<ExecutionFeasibilityReport> = {}): ExecutionFeasibilityReport {
  return {
    symbol: '600519',
    side: 'BUY',
    target_qty: 100,
    target_price: 1700,
    as_of_date: '2026-06-19',
    composite_score: 85,
    limit_proximity_score: 90,
    volume_coverage_score: 80,
    spread_score: 85,
    status_score: 100,
    decision: 'fillable',
    block_reasons: [],
    summary: '✅ 600519 BUY 可成交 (score=85.0)',
    metadata: {},
    persisted_id: 1234,
    generated_at: new Date('2026-06-19T09:30:00Z'),
    ...overrides,
  };
}

// =====================================================================
// [1] AC 常量守卫
// =====================================================================

function test_threshold_constant() {
  assert('FEASIBILITY_BLOCK_THRESHOLD === 60 (AC)', FEASIBILITY_BLOCK_THRESHOLD === 60);
  assert('FEASIBILITY_GATE_RULE_ID stable', FEASIBILITY_GATE_RULE_ID === 'execution_feasibility');
  assert('FEASIBILITY_GATE_LABEL human', FEASIBILITY_GATE_LABEL === '可行性 gate');
}

// =====================================================================
// [2] deriveFeasibilityGateOutcome 决策矩阵
// =====================================================================

function test_derive_fillable() {
  const r = deriveFeasibilityGateOutcome(buildReport({ decision: 'fillable', composite_score: 85 }));
  assert('fillable: ok=true', r.ok === true);
  assert('fillable: alert_level undefined', r.alert_level === undefined);
  assert('fillable: reason 含 可行性通过', r.reason.includes('可行性通过'));
}

function test_derive_risky_above_60() {
  const r = deriveFeasibilityGateOutcome(buildReport({ decision: 'risky', composite_score: 65 }));
  assert('risky≥60: ok=true', r.ok === true);
  assert('risky≥60: alert_level=LOW', r.alert_level === 'LOW');
  assert('risky≥60: reason 含 可行性偏低', r.reason.includes('可行性偏低'));
}

function test_derive_risky_below_60() {
  const r = deriveFeasibilityGateOutcome(buildReport({ decision: 'risky', composite_score: 55 }));
  assert('risky<60: ok=false', r.ok === false);
  assert('risky<60: alert_level=MEDIUM', r.alert_level === 'MEDIUM');
  assert('risky<60: reason 含 < 60', r.reason.includes('< 60'));
}

function test_derive_score_exactly_60() {
  // 60.0 严格放行 (PRD 文本 "< 60" = strict less than)
  const r = deriveFeasibilityGateOutcome(buildReport({ decision: 'risky', composite_score: 60 }));
  assert('score=60.0: ok=true (boundary 严格 <)', r.ok === true);
  assert('score=60.0: alert_level=LOW', r.alert_level === 'LOW');
}

function test_derive_score_59_99() {
  const r = deriveFeasibilityGateOutcome(buildReport({ decision: 'risky', composite_score: 59.99 }));
  assert('score=59.99: ok=false', r.ok === false);
  assert('score=59.99: alert_level=MEDIUM', r.alert_level === 'MEDIUM');
}

function test_derive_blocked_decision() {
  const r = deriveFeasibilityGateOutcome(
    buildReport({ decision: 'blocked', composite_score: 0, block_reasons: ['suspended', 'limit_up_buy'] })
  );
  assert('blocked: ok=false', r.ok === false);
  assert('blocked: alert_level=MEDIUM', r.alert_level === 'MEDIUM');
  assert('blocked: reason 含 硬约束', r.reason.includes('硬约束'));
  assert('blocked: reason 含 suspended', r.reason.includes('suspended'));
}

function test_derive_blocked_decision_high_score_safety() {
  // 即便 score 高, decision='blocked' 也必须拒 (例如 status_score=0 触发硬约束但被
  // weight 拉平到 70 这种 edge case — service 内 compositeWithHardBlock=0 但本测确保
  // deriveFeasibilityGateOutcome 优先 decision 不被 score 误导)
  const r = deriveFeasibilityGateOutcome(
    buildReport({ decision: 'blocked', composite_score: 75, block_reasons: ['suspended'] })
  );
  assert('blocked+score75: 仍 ok=false', r.ok === false);
}

// =====================================================================
// [3] buildFeasibilityGateMessage 文案
// =====================================================================

function test_message_variants() {
  const r = buildReport({ composite_score: 75.5 });
  const msg1 = buildFeasibilityGateMessage(r, 'fillable');
  assert('message fillable 含 score', msg1.includes('75.5') && msg1.includes('可行性通过'));
  const msg2 = buildFeasibilityGateMessage(
    buildReport({ composite_score: 50, block_reasons: ['suspended'] }),
    'score_below_threshold'
  );
  assert('message score_below 含 阈值', msg2.includes('60') && msg2.includes('阈值'));
  assert('message score_below 含 reasons', msg2.includes('suspended'));
  const msg3 = buildFeasibilityGateMessage(buildReport({ composite_score: 65 }), 'risky_passed');
  assert('message risky_passed 含 留痕', msg3.includes('留痕'));
  const msg4 = buildFeasibilityGateMessage(
    buildReport({ decision: 'blocked', composite_score: 0, block_reasons: ['suspended'] }),
    'blocked_by_decision'
  );
  assert('message blocked 含 硬约束 + reasons', msg4.includes('硬约束') && msg4.includes('suspended'));
}

// =====================================================================
// [4] evaluateFeasibilityGate 注入 fake service
// =====================================================================

function makeFakeCompute(reportOrError: ExecutionFeasibilityReport | Error) {
  const calls: any[] = [];
  const fn = async (_input: any, _options: any) => {
    calls.push({ input: _input, options: _options });
    if (reportOrError instanceof Error) throw reportOrError;
    return reportOrError;
  };
  return { fn, calls };
}

async function test_evaluate_fillable() {
  const { fn, calls } = makeFakeCompute(buildReport({ composite_score: 85, decision: 'fillable' }));
  const r = await evaluateFeasibilityGate(
    { user_id: 7, symbol: '600519', side: 'BUY', target_qty: 100, target_price: 1700 },
    { computeFeasibility: fn as any }
  );
  assert('eval fillable: ok=true', r.ok === true);
  assert('eval fillable: alert_level undefined', r.alert_level === undefined);
  assert('eval fillable: decision passthrough', r.decision === 'fillable');
  assert('eval fillable: composite_score=85', r.composite_score === 85);
  assert('eval fillable: 调一次 compute', calls.length === 1);
  assert(
    'eval fillable: as_of_date 默认填了',
    typeof calls[0].input.as_of_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(calls[0].input.as_of_date)
  );
  assert('eval fillable: persist 默认 true', calls[0].options.persist === true);
}

async function test_evaluate_blocked() {
  const { fn } = makeFakeCompute(
    buildReport({ decision: 'blocked', composite_score: 0, block_reasons: ['suspended'] })
  );
  const r = await evaluateFeasibilityGate(
    { user_id: 7, symbol: '600519', side: 'BUY', target_qty: 100, target_price: 1700 },
    { computeFeasibility: fn as any }
  );
  assert('eval blocked: ok=false', r.ok === false);
  assert('eval blocked: alert_level=MEDIUM', r.alert_level === 'MEDIUM');
  assert('eval blocked: block_reasons 透传', r.block_reasons.includes('suspended'));
}

async function test_evaluate_score_55() {
  const { fn } = makeFakeCompute(buildReport({ decision: 'risky', composite_score: 55 }));
  const r = await evaluateFeasibilityGate(
    { user_id: 7, symbol: '600519', side: 'BUY', target_qty: 100, target_price: 1700 },
    { computeFeasibility: fn as any }
  );
  assert('eval score=55: ok=false', r.ok === false);
  assert('eval score=55: alert_level=MEDIUM', r.alert_level === 'MEDIUM');
  assert('eval score=55: reason 含 < 60', r.reason.includes('< 60'));
}

async function test_evaluate_score_65_risky() {
  const { fn } = makeFakeCompute(buildReport({ decision: 'risky', composite_score: 65 }));
  const r = await evaluateFeasibilityGate(
    { user_id: 7, symbol: '600519', side: 'BUY', target_qty: 100, target_price: 1700 },
    { computeFeasibility: fn as any }
  );
  assert('eval score=65 risky: ok=true', r.ok === true);
  assert('eval score=65 risky: alert_level=LOW', r.alert_level === 'LOW');
}

async function test_evaluate_service_throws_fail_open() {
  const { fn } = makeFakeCompute(new Error('DB unavailable'));
  const r = await evaluateFeasibilityGate(
    { user_id: 7, symbol: '600519', side: 'BUY', target_qty: 100, target_price: 1700 },
    { computeFeasibility: fn as any }
  );
  assert('eval throw: fail-OPEN ok=true', r.ok === true);
  assert('eval throw: alert_level undefined', r.alert_level === undefined);
  assert('eval throw: decision=fillable synthetic', r.decision === 'fillable');
  assert('eval throw: reason 含 fail-OPEN', r.reason.includes('fail-OPEN'));
  assert('eval throw: report.metadata.error 含 原因', String(r.report.metadata.error).includes('DB unavailable'));
}

async function test_evaluate_service_throws_fail_close_opt_in() {
  const { fn } = makeFakeCompute(new Error('boom'));
  let caught = false;
  try {
    await evaluateFeasibilityGate(
      { user_id: 7, symbol: '600519', side: 'BUY', target_qty: 100, target_price: 1700 },
      { computeFeasibility: fn as any, fail_open_on_error: false }
    );
  } catch (err: any) {
    caught = true;
    assert('eval fail_open=false: throw msg', err.message === 'boom');
  }
  assert('eval fail_open=false: did throw', caught === true);
}

async function test_evaluate_persist_false() {
  const { fn, calls } = makeFakeCompute(buildReport());
  await evaluateFeasibilityGate(
    {
      user_id: 7,
      symbol: '600519',
      side: 'BUY',
      target_qty: 100,
      target_price: 1700,
      persist: false,
    },
    { computeFeasibility: fn as any }
  );
  assert('eval persist=false 透传', calls[0].options.persist === false);
}

async function test_evaluate_snapshot_passthrough() {
  const { fn, calls } = makeFakeCompute(buildReport());
  const snap = {
    close: 100,
    open: 99,
    high: 101,
    low: 98,
    prev_close: 99,
    volume: 1_000_000,
    bid1_price: 99.99,
    ask1_price: 100.01,
    bid1_volume: 10_000,
    ask1_volume: 12_000,
  };
  await evaluateFeasibilityGate(
    {
      user_id: 7,
      symbol: '600519',
      side: 'BUY',
      target_qty: 100,
      target_price: 100,
      market_snapshot: snap,
    },
    { computeFeasibility: fn as any }
  );
  assert('eval snapshot 透传', calls[0].input.market_snapshot === snap);
  assert('eval snapshot bid1 透传', calls[0].input.market_snapshot.bid1_price === 99.99);
}

// =====================================================================
// [5] emitFeasibilityGateAlert 注入 fake riskAlertService
// =====================================================================

function makeFakeWrite(throwIt = false) {
  const calls: any[] = [];
  const fn = async (input: any, options?: any) => {
    calls.push({ input, options });
    if (throwIt) throw new Error('alert sink down');
    return {
      severity: input.severity,
      planned_channels: ['inbox' as const],
      channels: [],
      alert_id: 999,
    } as any;
  };
  return { fn, calls };
}

async function test_emit_medium_blocked() {
  const { fn, calls } = makeFakeWrite();
  const result = {
    ok: false,
    decision: 'blocked' as const,
    composite_score: 0,
    block_reasons: ['suspended'],
    reason: '600519 BUY 可行性硬约束触发 (score=0.0), 原因: suspended',
    alert_level: 'MEDIUM' as const,
    report: buildReport({ decision: 'blocked', composite_score: 0, block_reasons: ['suspended'] }),
  };
  await emitFeasibilityGateAlert(
    { user_id: 7, symbol: '600519', side: 'BUY', result, callerLabel: 'facade.placeOrder' },
    { writeRiskAlert: fn as any }
  );
  assert('emit MEDIUM: 调一次 write', calls.length === 1);
  assert('emit MEDIUM: severity=medium', calls[0].input.severity === 'medium');
  assert('emit MEDIUM: rule_id=execution_feasibility', calls[0].input.rule_id === 'execution_feasibility');
  assert(
    'emit MEDIUM: metadata.tag=feasibility_blocked',
    calls[0].input.metadata?.tag === 'feasibility_blocked'
  );
  assert('emit MEDIUM: metadata.caller', calls[0].input.metadata?.caller === 'facade.placeOrder');
  assert('emit MEDIUM: metadata.side', calls[0].input.metadata?.side === 'BUY');
  assert('emit MEDIUM: name 含 可行性 gate', String(calls[0].input.name).includes('可行性 gate'));
  assert('emit MEDIUM: message 含 ⚠️', String(calls[0].input.message).includes('⚠️'));
}

async function test_emit_low_warning() {
  const { fn, calls } = makeFakeWrite();
  const result = {
    ok: true,
    decision: 'risky' as const,
    composite_score: 65,
    block_reasons: [],
    reason: '600519 BUY 可行性偏低 (score=65.0), 放行但留痕',
    alert_level: 'LOW' as const,
    report: buildReport({ decision: 'risky', composite_score: 65 }),
  };
  await emitFeasibilityGateAlert(
    {
      user_id: 7,
      symbol: '600519',
      side: 'BUY',
      result,
      callerLabel: 'LiveTradingService.approveDraft',
    },
    { writeRiskAlert: fn as any }
  );
  assert('emit LOW: 调一次', calls.length === 1);
  assert('emit LOW: severity=medium (RiskAlertService 仅三级)', calls[0].input.severity === 'medium');
  assert(
    'emit LOW: tag=feasibility_passed_with_warning',
    calls[0].input.metadata?.tag === 'feasibility_passed_with_warning'
  );
}

async function test_emit_write_throws_swallowed() {
  const { fn } = makeFakeWrite(true);
  const result = {
    ok: false,
    decision: 'blocked' as const,
    composite_score: 0,
    block_reasons: ['x'],
    reason: 'r',
    alert_level: 'MEDIUM' as const,
    report: buildReport({ decision: 'blocked' }),
  };
  let threw = false;
  try {
    await emitFeasibilityGateAlert(
      { user_id: 1, symbol: 'X', side: 'BUY', result, callerLabel: 'test' },
      { writeRiskAlert: fn as any }
    );
  } catch {
    threw = true;
  }
  assert('emit write throw: 不 re-throw', threw === false);
}

// =====================================================================
// [6] META-GUARD fs+regex
// =====================================================================

function read(file: string): string {
  return fs.readFileSync(file, 'utf-8');
}

function test_meta_guard_gate_constant() {
  const file = path.resolve(__dirname, '../../src/portfolio/internal/feasibilityGate.ts');
  const src = read(file);
  assert(
    'meta: feasibilityGate.ts 必须 export FEASIBILITY_BLOCK_THRESHOLD = 60',
    /export\s+const\s+FEASIBILITY_BLOCK_THRESHOLD\s*=\s*60\b/.test(src)
  );
  assert(
    'meta: feasibilityGate.ts 必须 export evaluateFeasibilityGate',
    /export\s+async\s+function\s+evaluateFeasibilityGate\s*\(/.test(src)
  );
  assert(
    'meta: feasibilityGate.ts 必须 export emitFeasibilityGateAlert',
    /export\s+async\s+function\s+emitFeasibilityGateAlert\s*\(/.test(src)
  );
}

function test_meta_guard_facade_wired() {
  const file = path.resolve(__dirname, '../../src/portfolio/PaperTradingFacade.ts');
  const src = read(file);
  assert(
    'meta: PaperTradingFacade.ts 必须 import evaluateFeasibilityGate',
    /import\s*\{[^}]*evaluateFeasibilityGate[^}]*\}\s*from\s*['"]\.\/internal\/feasibilityGate['"]/.test(
      src
    )
  );
  assert(
    'meta: PaperTradingFacade.ts 必须 import emitFeasibilityGateAlert',
    /emitFeasibilityGateAlert/.test(src)
  );
  assert(
    'meta: PaperTradingFacade.ts 必须 call evaluateFeasibilityGate(',
    /evaluateFeasibilityGate\s*\(/.test(src)
  );
  assert(
    'meta: PaperTradingFacade.ts 必须 throw EXECUTION_FEASIBILITY_BLOCKED code',
    /code\s*=\s*['"]EXECUTION_FEASIBILITY_BLOCKED['"]/.test(src)
  );
  assert(
    'meta: PaperTradingFacade.ts 必须 PlaceOrderOptions 含 bypass_feasibility',
    /bypass_feasibility\??:\s*boolean/.test(src)
  );
  // 不能 inline 写 ExecutionFeasibilityService.computeFeasibility 调用 (强制走 gate helper)
  assert(
    'meta: PaperTradingFacade.ts 不再 inline 调 computeFeasibility',
    !/executionFeasibilityService\.computeFeasibility/.test(src)
  );
}

function test_meta_guard_live_trading_wired() {
  const file = path.resolve(
    __dirname,
    '../../src/live-trading/services/LiveTradingService.ts'
  );
  const src = read(file);
  assert(
    'meta: LiveTradingService.ts 必须 import evaluateFeasibilityGate',
    /import\s*\{[^}]*evaluateFeasibilityGate[^}]*\}\s*from\s*['"]\.\.\/\.\.\/portfolio\/internal\/feasibilityGate['"]/.test(
      src
    )
  );
  assert(
    'meta: LiveTradingService.ts 必须 call evaluateFeasibilityGate(',
    /evaluateFeasibilityGate\s*\(/.test(src)
  );
  assert(
    'meta: LiveTradingService.ts 必须 audit ORDER_BLOCKED_BY_FEASIBILITY',
    /LIVE_AUDIT_EVENT_TYPES\.ORDER_BLOCKED_BY_FEASIBILITY/.test(src)
  );
  assert(
    'meta: LiveTradingService.ts 必须 audit ORDER_FEASIBILITY_WARN',
    /LIVE_AUDIT_EVENT_TYPES\.ORDER_FEASIBILITY_WARN/.test(src)
  );
  assert(
    'meta: LiveTradingService.ts 必须 throw ExecutionFeasibility 拒单 msg',
    /throw\s+new\s+Error\(\s*`ExecutionFeasibility 拒单:/.test(src)
  );
}

function test_meta_guard_audit_events_extended() {
  const file = path.resolve(__dirname, '../../src/live-trading/auditEvents.ts');
  const src = read(file);
  assert(
    'meta: auditEvents.ts ORDER_BLOCKED_BY_FEASIBILITY',
    /ORDER_BLOCKED_BY_FEASIBILITY:\s*'live_order_blocked_by_feasibility'/.test(src)
  );
  assert(
    'meta: auditEvents.ts ORDER_FEASIBILITY_WARN',
    /ORDER_FEASIBILITY_WARN:\s*'live_order_feasibility_warn'/.test(src)
  );
}

// =====================================================================
// Runner
// =====================================================================

(async () => {
  console.log('## [1] AC threshold constant');
  test_threshold_constant();

  console.log('## [2] deriveFeasibilityGateOutcome 决策矩阵');
  test_derive_fillable();
  test_derive_risky_above_60();
  test_derive_risky_below_60();
  test_derive_score_exactly_60();
  test_derive_score_59_99();
  test_derive_blocked_decision();
  test_derive_blocked_decision_high_score_safety();

  console.log('## [3] buildFeasibilityGateMessage 文案');
  test_message_variants();

  console.log('## [4] evaluateFeasibilityGate (注入 fake service)');
  await test_evaluate_fillable();
  await test_evaluate_blocked();
  await test_evaluate_score_55();
  await test_evaluate_score_65_risky();
  await test_evaluate_service_throws_fail_open();
  await test_evaluate_service_throws_fail_close_opt_in();
  await test_evaluate_persist_false();
  await test_evaluate_snapshot_passthrough();

  console.log('## [5] emitFeasibilityGateAlert (注入 fake riskAlertService)');
  await test_emit_medium_blocked();
  await test_emit_low_warning();
  await test_emit_write_throws_swallowed();

  console.log('## [6] META-GUARD fs+regex');
  test_meta_guard_gate_constant();
  test_meta_guard_facade_wired();
  test_meta_guard_live_trading_wired();
  test_meta_guard_audit_events_extended();

  console.log(`\n# summary: ${passed} ok, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
