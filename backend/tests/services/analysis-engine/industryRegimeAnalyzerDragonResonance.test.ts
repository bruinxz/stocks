/**
 * IndustryRegimeAnalyzer dragon resonance 专项测试 (US-113 [AE-007]).
 *
 * 覆盖:
 *  - toSixDigitStockCode pure 函数 (前后缀归一).
 *  - computeTargetTodayChangePct pure 函数 (bars 不足 / 异常价格 / 正常计算).
 *  - computeDragonResonance pure 函数 6 种 kind 全覆盖:
 *      self_leader / strong_alignment / alignment / divergence / leader_only / neutral.
 *  - IndustryRegimeAnalyzer 端到端:
 *      - 龙头共振 evidence 显式入 evidence[] (label/detail/direction/weight=0.15).
 *      - data_sources 列出 industry_flows.leader.
 *      - industry==null → loader 不查 + data_missing 含 industry_leader, 其它 partial 不阻塞.
 *      - loader throw → 内部 try/catch 兜底 + data_missing 含 industry_leader.
 *      - "self leader" 时 score 显著高于 "leader_only" (验证共振 polarity).
 *      - META-GUARD: fs+regex 守 analyzer 源码中 dragon resonance 关键 import / 调用没被未来 refactor 删掉.
 *
 * 零 DB 零网络 — 注入 fake IndustryLeaderSource.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  IndustryRegimeAnalyzer,
  computeDragonResonance,
  computeTargetTodayChangePct,
  toSixDigitStockCode,
  type DragonResonanceKind,
  type IndustryLeaderSnapshot,
  type IndustryLeaderSource,
} from '../../../src/services/analysis-engine/analyzers/IndustryRegimeAnalyzer';
import type { AnalyzerContext } from '../../../src/services/analysis-engine/AnalyzerTypes';

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

function ctxOf(opts: { stockCode?: string; lastCloses?: [number, number] } = {}): AnalyzerContext {
  const [prev, last] = opts.lastCloses || [100, 103]; // 默认 +3%
  return {
    stock: {
      code: opts.stockCode || 'sz.300750',
      name: '宁德时代',
      industry: '电池',
      market_segment: 'chinext',
    },
    as_of: '2026-06-18',
    daily_bars: [
      {
        time: '2026-06-17T15:00:00.000Z',
        open: prev,
        high: prev * 1.01,
        low: prev * 0.99,
        close: prev,
        volume: 1_000_000,
        turnover: 100_000_000,
      },
      {
        time: '2026-06-18T15:00:00.000Z',
        open: last,
        high: last * 1.01,
        low: last * 0.99,
        close: last,
        volume: 1_200_000,
        turnover: 120_000_000,
      },
    ],
    market_env: {
      market_regime: 'bull',
      market_regime_label: '牛市',
      industry: { regime: 'hot', label: '电池 · 行业强势', relative_return_20d_pct: 8 },
    },
    factor_snapshot: { industry_momentum: 1.6 },
  };
}

function fakeLeaderSource(snapshot: IndustryLeaderSnapshot | null, throws = false): IndustryLeaderSource {
  return {
    async loadIndustryLeader() {
      if (throws) throw new Error('boom');
      return snapshot;
    },
  };
}

(async () => {
  // ─── 1. toSixDigitStockCode pure ───
  assert(toSixDigitStockCode('sz.300750') === '300750', 'strip sz. prefix');
  assert(toSixDigitStockCode('600519.SH') === '600519', 'strip .SH suffix');
  assert(toSixDigitStockCode('sh.600519') === '600519', 'strip sh. prefix');
  assert(toSixDigitStockCode('bj.920003') === '920003', 'strip bj. prefix');
  assert(toSixDigitStockCode('300750') === '300750', 'pure 6-digit pass-through');
  assert(toSixDigitStockCode('') === '', 'empty in → empty out');
  assert(toSixDigitStockCode(null) === '', 'null in → empty out');
  assert(toSixDigitStockCode(undefined) === '', 'undefined in → empty out');

  // ─── 2. computeTargetTodayChangePct pure ───
  assert(computeTargetTodayChangePct([]) === null, 'empty bars → null');
  assert(
    computeTargetTodayChangePct([
      {
        time: 't',
        open: 1,
        high: 1,
        low: 1,
        close: 100,
        volume: 1,
      },
    ]) === null,
    'single bar → null'
  );
  const bars2 = [
    { time: 't1', open: 100, high: 100, low: 100, close: 100, volume: 1 },
    { time: 't2', open: 100, high: 100, low: 100, close: 103, volume: 1 },
  ];
  const ch = computeTargetTodayChangePct(bars2);
  assert(ch !== null && Math.abs(ch - 3) < 0.001, `+3% computed (${ch})`);
  // 异常 close=0 → null
  const bars0 = [
    { time: 't1', open: 100, high: 100, low: 100, close: 0, volume: 1 },
    { time: 't2', open: 100, high: 100, low: 100, close: 103, volume: 1 },
  ];
  assert(computeTargetTodayChangePct(bars0) === null, 'prev close=0 → null');
  // 负向
  const barsDown = [
    { time: 't1', open: 100, high: 100, low: 100, close: 100, volume: 1 },
    { time: 't2', open: 100, high: 100, low: 100, close: 95, volume: 1 },
  ];
  const chDown = computeTargetTodayChangePct(barsDown);
  assert(chDown !== null && Math.abs(chDown + 5) < 0.001, `-5% computed (${chDown})`);

  // ─── 3. computeDragonResonance 6 种 kind ───
  const lead = (code: string, change: number, name = 'LEADER'): IndustryLeaderSnapshot => ({
    industry: '电池',
    trade_date: '2026-06-18',
    leader_stock_code: code,
    leader_stock_name: name,
    leader_change_pct: change,
  });

  // self_leader: code 一致, 顶格 +30.
  const r1 = computeDragonResonance('300750', lead('300750', 6.0, '宁德时代'), 6.0);
  assert(r1.kind === 'self_leader', `self_leader kind (${r1.kind})`);
  assert(r1.score === 30, `self_leader score=30 (${r1.score})`);
  assert(r1.detail.includes('本股即行业龙头'), 'self_leader detail mentions 本股即行业龙头');

  // strong_alignment +25 (龙头 ≥5% + 同向 + target ≥3%)
  const r2 = computeDragonResonance('300751', lead('600519', 6.2), 4.0);
  assert(r2.kind === 'strong_alignment', `strong_alignment kind (${r2.kind})`);
  assert(r2.score === 25, `strong_alignment +25 (${r2.score})`);

  // strong_alignment +20 (龙头 ≥5% + 同向 + target <3%)
  const r2b = computeDragonResonance('300751', lead('600519', 6.2), 1.5);
  assert(r2b.kind === 'strong_alignment', `strong_alignment kind 1.5% (${r2b.kind})`);
  assert(r2b.score === 20, `strong_alignment +20 (${r2b.score})`);

  // strong_alignment 双方负 (龙头 -6% 本股 -3%) → -25
  const r2c = computeDragonResonance('300751', lead('600519', -6.0), -3.5);
  assert(r2c.kind === 'strong_alignment', `strong_alignment down kind (${r2c.kind})`);
  assert(r2c.score === -25, `strong_alignment down -25 (${r2c.score})`);

  // alignment (同向 + 龙头 [3%, 5%) + 本股同向 弱) → ±8
  const r3 = computeDragonResonance('300751', lead('600519', 3.5), 1.2);
  assert(r3.kind === 'alignment', `alignment kind (${r3.kind})`);
  assert(r3.score === 8, `alignment +8 (${r3.score})`);

  // divergence (龙头 ≥5% 本股反向 ≥1%) → -18.
  const r4 = computeDragonResonance('300751', lead('600519', 6.5), -2.0);
  assert(r4.kind === 'divergence', `divergence kind (${r4.kind})`);
  assert(r4.score === -18, `divergence -18 (${r4.score})`);

  // leader_only (龙头 ≥3% 涨, 本股 |Δ|<1%) → -8.
  const r5 = computeDragonResonance('300751', lead('600519', 3.5), 0.5);
  assert(r5.kind === 'leader_only', `leader_only kind (${r5.kind})`);
  assert(r5.score === -8, `leader_only -8 (${r5.score})`);

  // neutral (无 target) → 0.
  const r6 = computeDragonResonance('300751', lead('600519', 2.0), null);
  assert(r6.kind === 'neutral', `neutral kind null target (${r6.kind})`);
  assert(r6.score === 0, `neutral 0 (${r6.score})`);

  // neutral (龙头变动 <3%) → 0.
  const r6b = computeDragonResonance('300751', lead('600519', 0.5), 0.2);
  assert(r6b.kind === 'neutral', `neutral kind small move (${r6b.kind})`);
  assert(r6b.score === 0, `neutral small 0 (${r6b.score})`);

  // edge: divergence 要求 |target|≥1% — target 0.5 → 不 divergence 而是 leader_only (leader ≥5%).
  const r7 = computeDragonResonance('300751', lead('600519', 6.0), 0.5);
  // 龙头大涨 but 本股 |Δ|<1 → 落入 leader_only (≥3% 涨, target<1)
  assert(r7.kind === 'leader_only', `leader strong + target flat → leader_only (${r7.kind})`);

  // ─── 4. 端到端: self leader > leader_only (验 score polarity) ───
  const selfLeader = await new IndustryRegimeAnalyzer(
    fakeLeaderSource({
      industry: '电池',
      trade_date: '2026-06-18',
      leader_stock_code: '300750',
      leader_stock_name: '宁德时代',
      leader_change_pct: 6.0,
    })
  ).analyze(ctxOf({ stockCode: 'sz.300750' }));
  assert(selfLeader.error === null, 'self leader: no error');
  const leaderEv = selfLeader.evidence.find(e => e.label.includes('龙头共振'));
  assert(!!leaderEv, 'self leader: evidence contains 龙头共振');
  assert(leaderEv?.weight === 0.15, `evidence weight=0.15 (${leaderEv?.weight})`);
  assert(leaderEv?.metric_value === 30, `self leader evidence metric=30 (${leaderEv?.metric_value})`);
  assert(leaderEv?.direction === 'bullish', `self leader evidence direction=bullish`);

  const leaderOnly = await new IndustryRegimeAnalyzer(
    fakeLeaderSource({
      industry: '电池',
      trade_date: '2026-06-18',
      leader_stock_code: '600519',
      leader_stock_name: '茅台',
      leader_change_pct: 4.0,
    })
  ).analyze(ctxOf({ stockCode: 'sz.300750', lastCloses: [100, 100.3] })); // +0.3% flat
  assert(leaderOnly.error === null, 'leader_only: no error');
  const leaderOnlyEv = leaderOnly.evidence.find(e => e.label.includes('龙头共振'));
  assert(leaderOnlyEv?.metric_value === -8, `leader_only metric=-8 (${leaderOnlyEv?.metric_value})`);
  assert(leaderOnlyEv?.direction === 'bearish', `leader_only direction=bearish`);

  // 共振方向显著拉开 self leader 与 leader_only 总分
  assert(
    selfLeader.score > leaderOnly.score,
    `selfLeader score (${selfLeader.score}) > leaderOnly (${leaderOnly.score})`
  );

  // ─── 5. industry==null → loader 不查 + data_missing 含 industry_leader ───
  let loaderCalls = 0;
  const trackingSrc: IndustryLeaderSource = {
    async loadIndustryLeader(industry, as_of) {
      loaderCalls += 1;
      assert(industry === null, `loader received null industry (got ${industry})`);
      assert(as_of === '2026-06-18', `loader received correct as_of (${as_of})`);
      return null;
    },
  };
  const ctxNoInd = ctxOf();
  ctxNoInd.stock = { ...ctxNoInd.stock, industry: null };
  const outNoInd = await new IndustryRegimeAnalyzer(trackingSrc).analyze(ctxNoInd);
  assert(loaderCalls === 1, `loader still invoked with null industry once (${loaderCalls})`);
  assert(
    outNoInd.data_missing.includes('industry_leader'),
    `data_missing has industry_leader (${outNoInd.data_missing.join(',')})`
  );
  // 其它 partial (market + industry_regime + momentum) 仍正常 → score > 0
  assert(outNoInd.score > 0, `industry=null still produces score from env (${outNoInd.score})`);

  // ─── 6. loader throw → 内部 catch 兜底 + data_missing ───
  const throwingOut = await new IndustryRegimeAnalyzer(
    fakeLeaderSource(null, true)
  ).analyze(ctxOf());
  assert(throwingOut.error === null, 'loader throw still no analyzer error');
  assert(
    throwingOut.data_missing.includes('industry_leader'),
    `loader throw → data_missing industry_leader (${throwingOut.data_missing.join(',')})`
  );

  // ─── 7. data_sources 含 industry_flows.leader ───
  const dsOut = await new IndustryRegimeAnalyzer(
    fakeLeaderSource({
      industry: '电池',
      trade_date: '2026-06-18',
      leader_stock_code: '300750',
      leader_change_pct: 6,
    })
  ).analyze(ctxOf());
  const dsNames = dsOut.data_sources.map(d => d.name);
  assert(
    dsNames.includes('industry_flows.leader'),
    `data_sources lists industry_flows.leader (${dsNames.join(',')})`
  );

  // ─── 8. confidence 反映 partials 覆盖 (4 ratio) ───
  // 全 4 partials → confidence = 1.0
  assert(
    Math.abs(dsOut.confidence - 1.0) < 0.001,
    `4/4 partials → confidence=1.0 (${dsOut.confidence})`
  );
  // 缺 leader → 3/4 = 0.75
  const ctxNoLeader = ctxOf();
  const noLeaderOut = await new IndustryRegimeAnalyzer(fakeLeaderSource(null)).analyze(ctxNoLeader);
  assert(
    Math.abs(noLeaderOut.confidence - 0.75) < 0.001,
    `3/4 partials → confidence=0.75 (${noLeaderOut.confidence})`
  );

  // ─── 9. META-GUARD: fs+regex 守源码关键路径不被 refactor 删 ───
  const sourcePath = path.join(
    __dirname,
    '../../../src/services/analysis-engine/analyzers/IndustryRegimeAnalyzer.ts'
  );
  const source = fs.readFileSync(sourcePath, 'utf8');
  assert(
    /leaderSource\.loadIndustryLeader/.test(source),
    'META-GUARD: analyzer calls leaderSource.loadIndustryLeader (not bypassed)'
  );
  assert(
    /computeDragonResonance\s*\(/.test(source),
    'META-GUARD: analyzer invokes computeDragonResonance helper'
  );
  assert(
    /industry_leader/.test(source) && /data_missing.*industry_leader|industry_leader.*data_missing|dataMissing\.push\(['"]industry_leader/.test(source),
    'META-GUARD: industry_leader recorded in data_missing path'
  );
  assert(
    /龙头共振/.test(source),
    'META-GUARD: evidence label "龙头共振" present in source'
  );
  assert(
    /PRODUCTION_INDUSTRY_LEADER_SOURCE/.test(source),
    'META-GUARD: PRODUCTION_INDUSTRY_LEADER_SOURCE exported (DI lazy require)'
  );
  // 反向: 不应再有"只用 env+momentum"的老结构 (3 个 partials)
  assert(
    /industry_flows\.leader/.test(source),
    'META-GUARD: data_sources lists industry_flows.leader (forward-only)'
  );

  // ─── done ───
  console.log(`\n[IndustryRegimeAnalyzer dragon resonance] ${pass} ok, ${fail} fail`);
  if (fail > 0) {
    console.error('FAILURES:\n' + failures.map(f => '  - ' + f).join('\n'));
    process.exit(1);
  }
})().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
