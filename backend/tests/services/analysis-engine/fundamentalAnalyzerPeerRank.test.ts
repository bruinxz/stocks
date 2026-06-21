/**
 * FundamentalAnalyzer peer-rank percentile 专项测试 (US-111 [AE-005]).
 *
 * 覆盖:
 *  - computePeerRank pure 函数 (边界 / 排序 / 同分稳定 / 自己不在行业 / peer<2);
 *  - FundamentalAnalyzer 把 value/growth/quality 三因子 peer rank 全注入 evidence;
 *  - evidence 显式含百分位 (label "排名 X/N" + detail "百分位 P");
 *  - 部分因子 peer 拿不到 → data_missing 标 peer_rank.<factor> 不阻塞其它因子.
 *
 * 零 DB 零网络 — 注入 fake FundamentalPeerSource.
 */

import {
  FundamentalAnalyzer,
  computePeerRank,
  PEER_FACTOR_LABELS,
  type FundamentalPeerSource,
} from '../../../src/services/analysis-engine/analyzers/FundamentalAnalyzer';
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

function ctxOf(): AnalyzerContext {
  return {
    stock: {
      code: 'sz.300750',
      name: '宁德时代',
      industry: '电池',
      market_segment: 'chinext',
    },
    as_of: '2026-06-18',
    daily_bars: [],
    factor_snapshot: {
      value: 0.8,
      growth: 1.5,
      quality: 1.2,
      quality_high: 0.6,
      analyst_consensus: 1.0,
      earnings_surprise: 0.5,
    },
  };
}

(async () => {
  // [1] computePeerRank — 目标股第 1 名 → percentile=100, peerScore=+100
  {
    const r = computePeerRank(
      [
        { stock_code: '300750', z: 1.5 },
        { stock_code: '300751', z: 0.3 },
        { stock_code: '300752', z: -0.5 },
      ],
      '300750',
      'value'
    );
    assert(r !== null, 'peer rank top: not null');
    assert(r!.rank === 1, `peer rank top: rank=1 (${r!.rank})`);
    assert(r!.total === 3, `peer rank top: total=3 (${r!.total})`);
    assert(r!.percentile === 100, `peer rank top: percentile=100 (${r!.percentile})`);
    assert(r!.peerScore === 100, `peer rank top: peerScore=100 (${r!.peerScore})`);
  }

  // [2] computePeerRank — 目标股垫底 → percentile=0, peerScore=-100
  {
    const r = computePeerRank(
      [
        { stock_code: '300750', z: -1.5 },
        { stock_code: '300751', z: 0.3 },
        { stock_code: '300752', z: 0.5 },
      ],
      '300750',
      'value'
    );
    assert(r !== null, 'peer rank bottom: not null');
    assert(r!.rank === 3, `peer rank bottom: rank=3 (${r!.rank})`);
    assert(r!.percentile === 0, `peer rank bottom: percentile=0 (${r!.percentile})`);
    assert(r!.peerScore === -100, `peer rank bottom: peerScore=-100 (${r!.peerScore})`);
  }

  // [3] computePeerRank — 中位 (5 个 peer 中第 3) → percentile=50, peerScore=0
  {
    const r = computePeerRank(
      [
        { stock_code: 'A', z: 2.0 },
        { stock_code: 'B', z: 1.0 },
        { stock_code: 'TARGET', z: 0.0 },
        { stock_code: 'C', z: -1.0 },
        { stock_code: 'D', z: -2.0 },
      ],
      'TARGET',
      'growth'
    );
    assert(r !== null, 'peer rank mid: not null');
    assert(r!.rank === 3, `peer rank mid: rank=3 (${r!.rank})`);
    assert(r!.percentile === 50, `peer rank mid: percentile=50 (${r!.percentile})`);
    assert(r!.peerScore === 0, `peer rank mid: peerScore=0 (${r!.peerScore})`);
  }

  // [4] computePeerRank — peer 列表含 null z 自动过滤
  {
    const r = computePeerRank(
      [
        { stock_code: 'A', z: 2.0 },
        { stock_code: 'B', z: null },
        { stock_code: 'C', z: null },
        { stock_code: 'TARGET', z: 0.5 },
      ],
      'TARGET',
      'quality'
    );
    assert(r !== null, 'peer rank null filter: not null');
    assert(r!.total === 2, `peer rank null filter: total=2 (${r!.total})`);
    assert(r!.rank === 2, `peer rank null filter: rank=2 (${r!.rank})`);
    assert(r!.percentile === 0, `peer rank null filter: percentile=0 last of 2 (${r!.percentile})`);
  }

  // [5] computePeerRank — 自己不在 peer 列表 → null
  {
    const r = computePeerRank(
      [
        { stock_code: 'A', z: 1.0 },
        { stock_code: 'B', z: 0.5 },
      ],
      'NOTFOUND',
      'value'
    );
    assert(r === null, 'peer rank self not in industry: null');
  }

  // [6] computePeerRank — 只 1 个 peer → null (无对照组无法 rank)
  {
    const r = computePeerRank(
      [{ stock_code: 'A', z: 1.0 }],
      'A',
      'value'
    );
    assert(r === null, 'peer rank single: null');
  }

  // [7] computePeerRank — 有效成员 < 2 → null
  {
    const r = computePeerRank(
      [
        { stock_code: 'A', z: 1.0 },
        { stock_code: 'B', z: null },
      ],
      'A',
      'value'
    );
    assert(r === null, 'peer rank <2 valid: null');
  }

  // [8] computePeerRank — peer 列表空 / undefined → null
  {
    const r = computePeerRank([], 'A', 'value');
    assert(r === null, 'peer rank empty: null');
  }

  // [9] FundamentalAnalyzer — 三因子 peer 都返数据 → evidence 含三条 peer rank
  {
    const fake: FundamentalPeerSource = {
      async loadIndustryPeerScores(_industry, _as_of, factor) {
        if (factor === 'value') {
          return [
            { stock_code: '300750', z: 1.5 },
            { stock_code: '300751', z: 0.3 },
            { stock_code: '300752', z: -0.5 },
            { stock_code: '300753', z: -1.0 },
          ];
        }
        if (factor === 'growth') {
          return [
            { stock_code: '300750', z: 0.8 },
            { stock_code: '300751', z: 1.5 },
            { stock_code: '300752', z: 0.2 },
          ];
        }
        // quality
        return [
          { stock_code: '300750', z: 0.0 },
          { stock_code: '300751', z: 0.5 },
          { stock_code: '300752', z: -0.5 },
        ];
      },
    };
    const fa = new FundamentalAnalyzer(fake);
    const out = await fa.analyze(ctxOf());
    assert(out.error === null, 'three-factor peer: no error');
    // evidence 必含三条 peer rank, 每条都带百分位
    const peerEvidences = out.evidence.filter(e => /排名/.test(e.label));
    assert(
      peerEvidences.length === 3,
      `three-factor peer: peer evidence count=3 (${peerEvidences.length})`
    );
    for (const ev of peerEvidences) {
      assert(/百分位/.test(ev.detail || ''), `peer evidence detail 含百分位: ${ev.label} → ${ev.detail}`);
      assert(
        typeof ev.metric_value === 'number' && ev.metric_value >= 0 && ev.metric_value <= 100,
        `peer evidence metric_value 是 [0,100] 百分位: ${ev.metric_value}`
      );
    }
    // 显式断 value=第 1/4 → percentile=100 + label 含 PE/PB
    const valueEv = peerEvidences.find(e => e.label.includes(PEER_FACTOR_LABELS.value));
    assert(!!valueEv, 'value peer evidence exists');
    assert(
      valueEv!.label.includes('1/4'),
      `value peer evidence label 含 1/4: ${valueEv!.label}`
    );
    assert(valueEv!.metric_value === 100, `value peer percentile=100 (${valueEv!.metric_value})`);
    assert(valueEv!.direction === 'bullish', 'value peer top → bullish');

    // growth=第 2/3 → percentile=50
    const growthEv = peerEvidences.find(e => e.label.includes(PEER_FACTOR_LABELS.growth));
    assert(!!growthEv, 'growth peer evidence exists');
    assert(growthEv!.metric_value === 50, `growth peer percentile=50 (${growthEv!.metric_value})`);
    assert(growthEv!.direction === 'neutral', 'growth peer mid → neutral');

    // quality=第 2/3 → percentile=50
    const qualityEv = peerEvidences.find(e => e.label.includes(PEER_FACTOR_LABELS.quality));
    assert(!!qualityEv, 'quality peer evidence exists');
    assert(qualityEv!.metric_value === 50, `quality peer percentile=50 (${qualityEv!.metric_value})`);
  }

  // [10] FundamentalAnalyzer — 部分因子 peer 拿不到 → data_missing 标 peer_rank.<factor>
  {
    const fake: FundamentalPeerSource = {
      async loadIndustryPeerScores(_industry, _as_of, factor) {
        if (factor === 'value') {
          return [
            { stock_code: '300750', z: 1.5 },
            { stock_code: '300751', z: 0.3 },
          ];
        }
        // growth / quality 都返空, 模拟该因子未跑出 peer 数据
        return [];
      },
    };
    const fa = new FundamentalAnalyzer(fake);
    const out = await fa.analyze(ctxOf());
    assert(out.error === null, 'partial peer: no error');
    assert(
      out.data_missing.includes('peer_rank.growth'),
      `partial peer: data_missing 含 peer_rank.growth (${out.data_missing.join(',')})`
    );
    assert(
      out.data_missing.includes('peer_rank.quality'),
      `partial peer: data_missing 含 peer_rank.quality (${out.data_missing.join(',')})`
    );
    assert(
      !out.data_missing.includes('peer_rank.value'),
      `partial peer: data_missing 不含 peer_rank.value (${out.data_missing.join(',')})`
    );
    // value peer evidence 仍存在
    const valueEv = out.evidence.find(
      e => /排名/.test(e.label) && e.label.includes(PEER_FACTOR_LABELS.value)
    );
    assert(!!valueEv, 'partial peer: value evidence exists');
  }

  // [11] FundamentalAnalyzer — peerSource throw → data_missing fail-OPEN 不阻塞
  {
    const fake: FundamentalPeerSource = {
      async loadIndustryPeerScores() {
        throw new Error('fake peer source down');
      },
    };
    const fa = new FundamentalAnalyzer(fake);
    const out = await fa.analyze(ctxOf());
    assert(out.error === null, 'peer throw: analyzer 不挂 (fail-OPEN)');
    assert(
      out.data_missing.includes('peer_rank.value'),
      'peer throw: data_missing 含 peer_rank.value'
    );
    assert(
      out.data_missing.includes('peer_rank.growth'),
      'peer throw: data_missing 含 peer_rank.growth'
    );
    assert(
      out.data_missing.includes('peer_rank.quality'),
      'peer throw: data_missing 含 peer_rank.quality'
    );
    // 因子 evidence 仍然在 (peer 拿不到不阻塞因子展示)
    assert(out.evidence.length >= 6, `peer throw: evidence 仍有因子条目 (${out.evidence.length})`);
  }

  // [12] FundamentalAnalyzer — industry=null → peer 自动跳过 (peerSource 内 industry=null 返 [])
  {
    const fake: FundamentalPeerSource = {
      async loadIndustryPeerScores(industry) {
        if (!industry) return [];
        return [
          { stock_code: '300750', z: 1.0 },
          { stock_code: '300751', z: 0.0 },
        ];
      },
    };
    const fa = new FundamentalAnalyzer(fake);
    const ctx = ctxOf();
    ctx.stock.industry = null;
    const out = await fa.analyze(ctx);
    assert(out.error === null, 'industry null: no error');
    assert(
      out.data_missing.includes('peer_rank.value'),
      'industry null: peer_rank.value missing'
    );
  }

  console.log(`\n${pass} passed, ${fail} failed.`);
  if (fail > 0) {
    console.error(`FAILURES:\n${failures.map(f => '  - ' + f).join('\n')}`);
    process.exit(1);
  } else {
    process.exit(0);
  }
})();
