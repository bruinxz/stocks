/**
 * analysis-engine/types.test.ts — TypeScript 接口契约编译检查.
 *
 * 仅 import 类型 + 实例化 minimal sample 让 tsc 校验形状不漂移.
 * 跑法: npx ts-node --transpile-only tests/services/analysis-engine/types.test.ts
 */

import type {
  AnalyzerContext,
  AnalyzerOutput,
  RecommendationDecision,
  EvidenceItem,
  DataQualityVerdict,
  AnalyzerKey,
} from '../../../src/services/analysis-engine/AnalyzerTypes';
import { DEFAULT_ANALYZER_WEIGHTS } from '../../../src/services/analysis-engine';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function assert(cond: boolean, msg: string): void {
  if (cond) pass += 1;
  else {
    fail += 1;
    failures.push(msg);
    console.error(`✗ ${msg}`);
  }
}

(() => {
  // Sample ctx
  const ctx: AnalyzerContext = {
    stock: { code: 'sh.600519', name: '贵州茅台', industry: '白酒', market_segment: 'main' },
    as_of: '2026-06-18',
    daily_bars: [],
    factor_snapshot: { value: 1.2, growth: 0.5 },
  };
  assert(ctx.stock.code === 'sh.600519', 'context shape valid');

  // Sample evidence
  const ev: EvidenceItem = { label: 'PE 15', direction: 'bullish', weight: 1 };
  assert(ev.direction === 'bullish', 'evidence direction enum');

  // Sample analyzer output
  const out: AnalyzerOutput = {
    analyzer_key: 'fundamental' as AnalyzerKey,
    score: 50,
    evidence: [ev],
    data_sources: [{ name: 'factor', as_of: '2026-06-18', is_realtime: false }],
    confidence: 0.8,
    data_missing: [],
    error: null,
    elapsed_ms: 12,
  };
  assert(out.analyzer_key === 'fundamental', 'analyzer_key');

  // Sample decision
  const dq: DataQualityVerdict = {
    level: 'good',
    missing_critical: [],
    missing_optional: [],
    notes: [],
    coefficient: 1,
  };
  const decision: RecommendationDecision = {
    action: 'buy',
    suggested_position_pct: 0.07,
    entry_zone: [100, 110],
    stop_loss: 90,
    take_profit: 130,
    key_reasons: ['x'],
    risk_warnings: [],
    overall_confidence: 0.8,
    confidence_tier: 'high',
    per_dimension: [out],
    data_quality: dq,
    engine_variant: 'multi_dim_v1',
    as_of: '2026-06-18',
    stock_code: 'sh.600519',
  };
  assert(decision.engine_variant === 'multi_dim_v1', 'decision engine_variant');

  // 8 keys 都在 DEFAULT_ANALYZER_WEIGHTS
  const keys: AnalyzerKey[] = [
    'fundamental',
    'technical',
    'capital',
    'news',
    'sentiment',
    'industry_regime',
    'risk',
    'event',
  ];
  for (const k of keys) {
    assert(
      DEFAULT_ANALYZER_WEIGHTS[k] !== undefined,
      `DEFAULT_ANALYZER_WEIGHTS.${k} exists`
    );
  }
  // 权重和接近 1
  const sum = Object.values(DEFAULT_ANALYZER_WEIGHTS).reduce((a, b) => a + b, 0);
  assert(Math.abs(sum - 1) < 1e-6, `weights sum ≈ 1 (got ${sum})`);

  console.log(`\n${pass} passed, ${fail} failed.`);
  if (fail > 0) {
    console.error(`FAILURES:\n${failures.map(f => '  - ' + f).join('\n')}`);
    process.exit(1);
  } else {
    process.exit(0);
  }
})();
