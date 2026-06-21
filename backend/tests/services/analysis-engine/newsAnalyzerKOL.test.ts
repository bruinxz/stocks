/**
 * newsAnalyzerKOL.test.ts — US-036 [KOL-004] NewsAnalyzer 接 KOLAggregator 真输出.
 *
 * 覆盖:
 *   [1] 常量冻结 — KOL_SOURCE_LABEL 不可被运行时改写, 五枚 enum 全覆盖.
 *   [2] toSixDigitStockCode pure — 'sz.300750' / 'SH600000' / 'bj.430718' / '300750' / 非法.
 *   [3] formatKOLSourceLabel — 五枚 enum + null + 未识别 fallback 'KOL'.
 *   [4] weightedAvgKOLSentiment — 权威源 (研报 / 政策) 占主导, 中性 0/null/非数字 不入分母.
 *   [5] buildKOLEvidenceDetail — 按 |sentiment| × authority desc 排, 显式 [tag] name:±score 形态,
 *       topN 截断, 不污染上游数组顺序.
 *   [6] AC 主验收 — NewsAnalyzer 端到端: 5 来源 mock 输入 → KOL evidence label 含 "KOL 聚合"
 *       与按源分桶计数 + detail 含三条 top 来源 + 加权 avg 与裸算术 avg 差异显著 (权威源拉偏).
 *   [7] PRODUCTION 路径 stock_code 前缀 strip — 直接 mock require('../../KOLAggregatorService')
 *       验 aggregateForStock 入参恒为 6 位; 同时验 dryRun:true 透传不触发 saveOpinions.
 *   [8] META-GUARD — 正向: NewsAnalyzer.ts import + 调 weightedAvgKOLSentiment + 调
 *       buildKOLEvidenceDetail + PRODUCTION 路径 dryRun:true; 反向: 不再含旧路径
 *       `scored.reduce((a, b) => a + b, 0) / scored.length` 在 KOL 段 (news 段独立保留).
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  KOL_SOURCE_LABEL,
  NewsAnalyzer,
  buildKOLEvidenceDetail,
  formatKOLSourceLabel,
  toSixDigitStockCode,
  weightedAvgKOLSentiment,
  type NewsAnalyzerDataSource,
  type NewsAnalyzerKOLRecord,
} from '../../../src/services/analysis-engine/analyzers/NewsAnalyzer';
import type { AnalyzerContext } from '../../../src/services/analysis-engine/AnalyzerTypes';
import {
  KOL_SOURCES,
  SOURCE_AUTHORITY,
  authorityWeightedSentiment,
  type KOLOpinionRecord,
} from '../../../src/services/KOLAggregatorService';

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

function approx(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps;
}

function baseCtx(): AnalyzerContext {
  return {
    stock: {
      code: 'sz.300750',
      name: '宁德时代',
      industry: '电池',
      market_segment: 'chinext',
    },
    as_of: '2026-06-18',
    daily_bars: [],
    factor_snapshot: {},
  };
}

/** 把一行 NewsAnalyzerKOLRecord 升格成完整 KOLOpinionRecord (拿 authorityWeightedSentiment 对算用) */
function expand(rec: NewsAnalyzerKOLRecord): KOLOpinionRecord {
  return {
    stock_code: '',
    kol_name: rec.kol_name,
    opinion_date: rec.opinion_date || '',
    kol_source: rec.kol_source,
    opinion_summary: rec.opinion_summary || '',
    sentiment_score: rec.sentiment_score,
    url: null,
    raw_payload: {},
  };
}

(async () => {
  // -------------------------------------------------------------------------
  // [1] 常量冻结 — KOL_SOURCE_LABEL 五枚全覆盖且不可改写
  // -------------------------------------------------------------------------
  assert(Object.isFrozen(KOL_SOURCE_LABEL), '[1] KOL_SOURCE_LABEL frozen');
  assert(KOL_SOURCE_LABEL.research_report === '研报', '[1] label research_report=研报');
  assert(KOL_SOURCE_LABEL.east_money_news === '财经新闻', '[1] label east_money_news=财经新闻');
  assert(KOL_SOURCE_LABEL.xq_hot_concept === '热门概念', '[1] label xq_hot_concept=热门概念');
  assert(KOL_SOURCE_LABEL.etf_flow === 'ETF 资金', '[1] label etf_flow=ETF 资金');
  assert(KOL_SOURCE_LABEL.policy_doc === '政策', '[1] label policy_doc=政策');
  // 与 KOL_SOURCES 双向一致 — 任何新增 enum 必须在 LABEL 里加, 漏一立挂
  for (const v of Object.values(KOL_SOURCES)) {
    assert(
      typeof (KOL_SOURCE_LABEL as Record<string, string>)[v] === 'string',
      `[1] KOL_SOURCES.${v} has label in KOL_SOURCE_LABEL`
    );
  }

  // -------------------------------------------------------------------------
  // [2] toSixDigitStockCode pure
  // -------------------------------------------------------------------------
  assert(toSixDigitStockCode('sz.300750') === '300750', '[2] sz.300750 -> 300750');
  assert(toSixDigitStockCode('SH600000') === '600000', '[2] SH600000 -> 600000');
  assert(toSixDigitStockCode('bj.430718') === '430718', '[2] bj.430718 -> 430718');
  assert(toSixDigitStockCode('300750') === '300750', '[2] pass-through 300750');
  assert(toSixDigitStockCode('  sh.600000  ') === '600000', '[2] trim + strip');
  assert(toSixDigitStockCode('123') === null, '[2] short numeric -> null');
  assert(toSixDigitStockCode('') === null, '[2] empty -> null');
  assert(toSixDigitStockCode('abc') === null, '[2] non-numeric -> null');
  assert(toSixDigitStockCode('sz.30075') === null, '[2] 5-digit -> null');
  assert(toSixDigitStockCode('sz.3007501') === null, '[2] 7-digit -> null');
  // null/undefined 兜底走 String(...) 不抛
  assert(toSixDigitStockCode(null as unknown as string) === null, '[2] null safe');
  assert(toSixDigitStockCode(undefined as unknown as string) === null, '[2] undefined safe');

  // -------------------------------------------------------------------------
  // [3] formatKOLSourceLabel
  // -------------------------------------------------------------------------
  assert(formatKOLSourceLabel('research_report') === '研报', '[3] research_report -> 研报');
  assert(formatKOLSourceLabel('policy_doc') === '政策', '[3] policy_doc -> 政策');
  assert(formatKOLSourceLabel(null) === 'KOL', '[3] null -> KOL');
  assert(formatKOLSourceLabel(undefined) === 'KOL', '[3] undefined -> KOL');
  assert(formatKOLSourceLabel('unknown_source') === 'KOL', '[3] unknown -> KOL');
  assert(formatKOLSourceLabel('') === 'KOL', '[3] empty -> KOL');

  // -------------------------------------------------------------------------
  // [4] weightedAvgKOLSentiment — 权威源 (研报 / 政策) 占主导
  // -------------------------------------------------------------------------
  // 单条用例: 直接等于 sentiment_score
  const r1: NewsAnalyzerKOLRecord = {
    kol_name: 'A',
    kol_source: 'research_report',
    sentiment_score: 0.5,
  };
  const avg1 = weightedAvgKOLSentiment([r1]);
  assert(avg1 !== null && approx(avg1, 0.5), `[4] single record avg = sentiment (${avg1})`);

  // 全 null / 全 0 → null
  assert(weightedAvgKOLSentiment([]) === null, '[4] empty -> null');
  assert(
    weightedAvgKOLSentiment([
      { kol_name: 'A', kol_source: 'research_report', sentiment_score: null },
      { kol_name: 'B', kol_source: 'east_money_news', sentiment_score: null },
    ]) === null,
    '[4] all null -> null'
  );
  assert(
    weightedAvgKOLSentiment([
      { kol_name: 'A', kol_source: 'research_report', sentiment_score: 0 },
      { kol_name: 'B', kol_source: 'east_money_news', sentiment_score: 0 },
    ]) === null,
    '[4] all 0 (|s|*authority=0) -> null'
  );
  // 非数字 (NaN/Infinity) 跳过
  assert(
    weightedAvgKOLSentiment([
      { kol_name: 'A', kol_source: 'research_report', sentiment_score: NaN },
      { kol_name: 'B', kol_source: 'policy_doc', sentiment_score: 0.4 },
    ]) === 0.4,
    '[4] NaN skipped, only policy_doc -> 0.4'
  );

  // **权威拉偏验证** — 政策 0.5 (authority=0.8) vs 新闻 -0.5 (authority=0.3)
  //   裸算术 avg = (0.5 + -0.5) / 2 = 0
  //   加权 avg = (0.5×0.5×0.8 + -0.5×0.5×0.3) / (0.5×0.8 + 0.5×0.3) = (0.2 - 0.075) / 0.55 ≈ 0.227
  const tilt = weightedAvgKOLSentiment([
    { kol_name: '国务院', kol_source: 'policy_doc', sentiment_score: 0.5 },
    { kol_name: '财联社', kol_source: 'east_money_news', sentiment_score: -0.5 },
  ]);
  assert(tilt !== null && tilt > 0.2, `[4] 政策 > 新闻 拉偏正向 (${tilt})`);
  // 与 authorityWeightedSentiment 同源
  const wPolicy = authorityWeightedSentiment(
    expand({ kol_name: '国务院', kol_source: 'policy_doc', sentiment_score: 0.5 })
  );
  const wNews = authorityWeightedSentiment(
    expand({ kol_name: '财联社', kol_source: 'east_money_news', sentiment_score: -0.5 })
  );
  const expected = (0.5 * wPolicy + -0.5 * wNews) / (wPolicy + wNews);
  assert(tilt !== null && approx(tilt!, expected, 1e-9), `[4] 加权 avg = upstream 公式 (${tilt} ~ ${expected})`);

  // **权威序对齐** — SOURCE_AUTHORITY 政策 > 研报 > ETF > 概念 > 新闻
  assert(SOURCE_AUTHORITY.policy_doc > SOURCE_AUTHORITY.research_report, '[4] authority: 政策>研报');
  assert(SOURCE_AUTHORITY.research_report > SOURCE_AUTHORITY.etf_flow, '[4] authority: 研报>ETF');
  assert(SOURCE_AUTHORITY.etf_flow > SOURCE_AUTHORITY.xq_hot_concept, '[4] authority: ETF>概念');
  assert(SOURCE_AUTHORITY.xq_hot_concept > SOURCE_AUTHORITY.east_money_news, '[4] authority: 概念>新闻');

  // -------------------------------------------------------------------------
  // [5] buildKOLEvidenceDetail — top N + 形态 + 不污染上游
  // -------------------------------------------------------------------------
  const records: NewsAnalyzerKOLRecord[] = [
    { kol_name: '财联社', kol_source: 'east_money_news', sentiment_score: -0.4 },
    { kol_name: '国务院', kol_source: 'policy_doc', sentiment_score: 0.7 },
    { kol_name: '中信证券', kol_source: 'research_report', sentiment_score: 0.8 },
    { kol_name: '热点榜', kol_source: 'xq_hot_concept', sentiment_score: 0.3 },
  ];
  const before = records.map(r => r.kol_name).join(',');
  const detail = buildKOLEvidenceDetail(records, 3);
  const after = records.map(r => r.kol_name).join(',');
  assert(before === after, '[5] 上游数组顺序未被污染');
  // 期望顺序: 研报 0.8×0.6=0.48, 政策 0.7×0.8=0.56 (政策最高), 财联社 0.4×0.3=0.12, 热点 0.3×0.4=0.12
  // 即政策 > 研报 > (财联社/热点 tied)
  assert(detail.includes('[政策] 国务院:+0.70'), `[5] detail contains 政策 国务院 (${detail})`);
  assert(detail.includes('[研报] 中信证券:+0.80'), `[5] detail contains 研报 中信证券`);
  // 政策放第一 (|0.7| × 0.8 = 0.56 > |0.8| × 0.6 = 0.48)
  assert(detail.indexOf('[政策]') < detail.indexOf('[研报]'), '[5] 政策 排在 研报 前');
  // 截断 topN=3 — 最弱的一条 (xq_hot_concept 或 east_money_news 之一) 被裁掉
  const parts = detail.split(' | ');
  assert(parts.length === 3, `[5] topN=3 截断 (got ${parts.length})`);
  // 负号格式
  const detailWithNeg = buildKOLEvidenceDetail(
    [{ kol_name: '空仓派', kol_source: 'east_money_news', sentiment_score: -0.6 }],
    1
  );
  assert(detailWithNeg === '[财经新闻] 空仓派:-0.60', `[5] 负号 ${detailWithNeg}`);
  // kol_name 截断 24 字
  const long = 'a'.repeat(30);
  const detailLong = buildKOLEvidenceDetail(
    [{ kol_name: long, kol_source: 'research_report', sentiment_score: 0.5 }],
    1
  );
  assert(detailLong.includes('a'.repeat(24) + ':+0.50'), `[5] kol_name 截 24 (${detailLong})`);
  assert(!detailLong.includes('a'.repeat(25)), '[5] kol_name 不超 24');
  // null sentiment_score 走 0.00
  const detailNull = buildKOLEvidenceDetail(
    [{ kol_name: '空观点', kol_source: 'research_report', sentiment_score: null }],
    1
  );
  assert(detailNull === '[研报] 空观点:+0.00', `[5] null -> 0.00 (${detailNull})`);
  // kol_name 缺省 -> '匿名'
  const detailAnon = buildKOLEvidenceDetail(
    [{ kol_name: '', kol_source: 'research_report', sentiment_score: 0.3 }],
    1
  );
  assert(detailAnon === '[研报] 匿名:+0.30', `[5] 空 name -> 匿名 (${detailAnon})`);

  // -------------------------------------------------------------------------
  // [6] AC 主验收 — NewsAnalyzer 端到端 evidence 真实
  // -------------------------------------------------------------------------
  const ctx = baseCtx();
  const kolSamples: NewsAnalyzerKOLRecord[] = [
    {
      kol_name: '中信证券',
      kol_source: 'research_report',
      sentiment_score: 0.8,
      opinion_summary: '买入评级',
    },
    {
      kol_name: '国务院',
      kol_source: 'policy_doc',
      sentiment_score: 0.7,
      opinion_summary: '行业利好政策',
    },
    {
      kol_name: '财联社',
      kol_source: 'east_money_news',
      sentiment_score: -0.3,
      opinion_summary: '短线波动',
    },
    {
      kol_name: '热点榜',
      kol_source: 'xq_hot_concept',
      sentiment_score: 0.2,
    },
  ];
  const source: NewsAnalyzerDataSource = {
    async listAnnouncementsByStock() {
      return [];
    },
    async listRecentNewsByStock() {
      return [];
    },
    async aggregateKOLForStock() {
      return kolSamples;
    },
  };
  const analyzer = new NewsAnalyzer(source);
  const out = await analyzer.analyze(ctx);
  assert(out.error === null, '[6] analyzer no error');
  const kolEv = out.evidence.find(e => e.label.startsWith('KOL 聚合'));
  assert(!!kolEv, '[6] evidence 含 KOL 聚合 entry');
  // 标签含分桶 ("研报 1 / 政策 1 / 财经新闻 1 / 热门概念 1")
  assert(kolEv!.label.includes('研报 1'), `[6] label 含 研报 1 (${kolEv!.label})`);
  assert(kolEv!.label.includes('政策 1'), '[6] label 含 政策 1');
  assert(kolEv!.label.includes('财经新闻 1'), '[6] label 含 财经新闻 1');
  assert(kolEv!.label.includes('热门概念 1'), '[6] label 含 热门概念 1');
  assert(kolEv!.label.includes('加权情绪'), '[6] label 含 加权情绪');
  // detail 含 top3 (政策 / 研报 优先)
  assert(typeof kolEv!.detail === 'string' && kolEv!.detail!.length > 0, '[6] detail 非空');
  assert(kolEv!.detail!.includes('[政策]'), `[6] detail 含 [政策] (${kolEv!.detail})`);
  assert(kolEv!.detail!.includes('[研报]'), `[6] detail 含 [研报]`);
  // 加权 avg 正向, direction=bullish
  assert(kolEv!.direction === 'bullish', `[6] direction bullish (${kolEv!.direction})`);
  assert(typeof kolEv!.metric_value === 'number' && kolEv!.metric_value! > 0.1, '[6] metric_value > 0.1');

  // 6b. KOL 全 null sentiment_score → data_missing.includes('kol_sentiment_score')
  const sourceAllNull: NewsAnalyzerDataSource = {
    async listAnnouncementsByStock() {
      return [];
    },
    async listRecentNewsByStock() {
      return [];
    },
    async aggregateKOLForStock() {
      return [
        { kol_name: 'A', kol_source: 'research_report' as const, sentiment_score: null },
        { kol_name: 'B', kol_source: 'policy_doc' as const, sentiment_score: null },
      ];
    },
  };
  const outAllNull = await new NewsAnalyzer(sourceAllNull).analyze(baseCtx());
  assert(
    outAllNull.data_missing.includes('kol_sentiment_score'),
    '[6b] 全 null sentiment_score 入 data_missing'
  );
  // 但 'kol' 不入 — 与 "无 KOL 数据" 区分
  assert(!outAllNull.data_missing.includes('kol'), '[6b] kol 不入 data_missing (有数据)');

  // 6c. 空 KOL 数组 → data_missing.includes('kol')
  const sourceEmptyKOL: NewsAnalyzerDataSource = {
    async listAnnouncementsByStock() {
      return [];
    },
    async listRecentNewsByStock() {
      return [];
    },
    async aggregateKOLForStock() {
      return [];
    },
  };
  const outEmpty = await new NewsAnalyzer(sourceEmptyKOL).analyze(baseCtx());
  assert(outEmpty.data_missing.includes('kol'), '[6c] 空 KOL -> kol in data_missing');

  // -------------------------------------------------------------------------
  // [7] PRODUCTION 路径 stock_code 前缀 strip + dryRun:true 透传
  // -------------------------------------------------------------------------
  // 把 KOLAggregatorService 的 require cache 替成 fake, 验真生产 adapter 行为
  const kolModulePath = require.resolve('../../../src/services/KOLAggregatorService');
  const realModule = require(kolModulePath);
  const calls: Array<{ stockCode: string; options: any }> = [];
  const fakeAggregator = {
    async aggregateForStock(stockCode: string, options: any) {
      calls.push({ stockCode, options });
      return {
        stock_code: stockCode,
        total_collected: 1,
        by_source: {},
        opinions: [
          {
            stock_code: stockCode,
            kol_name: 'X',
            kol_source: 'research_report',
            opinion_date: '2026-06-15',
            opinion_summary: 'buy',
            sentiment_score: 0.4,
            url: null,
            raw_payload: {},
          },
        ],
        persisted: false,
      };
    },
  };
  // 替换 module exports (with try/finally restore)
  const originalAggregator = realModule.kolAggregatorService;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (realModule as any).kolAggregatorService = fakeAggregator;
    const {
      PRODUCTION_NEWS_ANALYZER_SOURCE,
    } = require('../../../src/services/analysis-engine/analyzers/NewsAnalyzer');
    const out1 = await PRODUCTION_NEWS_ANALYZER_SOURCE.aggregateKOLForStock('sz.300750');
    assert(calls.length === 1, '[7] aggregateForStock 调一次');
    assert(calls[0].stockCode === '300750', `[7] stock_code 前缀 strip (${calls[0].stockCode})`);
    assert(calls[0].options?.dryRun === true, '[7] dryRun:true 透传');
    assert(out1.length === 1, '[7] 返 1 条');
    assert(out1[0].kol_name === 'X', '[7] kol_name 透传');
    assert(out1[0].kol_source === 'research_report', '[7] kol_source 透传');
    assert(out1[0].sentiment_score === 0.4, '[7] sentiment_score Number 化');

    // 非法 stock_code → 空数组, 不调 aggregateForStock
    calls.length = 0;
    const outBad = await PRODUCTION_NEWS_ANALYZER_SOURCE.aggregateKOLForStock('not-a-code');
    assert(outBad.length === 0, '[7] 非法 stock_code 返 []');
    assert(calls.length === 0, '[7] 非法 stock_code 不调 aggregateForStock');

    // aggregateForStock throw → 不传播, 返 []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (realModule as any).kolAggregatorService = {
      async aggregateForStock() {
        throw new Error('boom');
      },
    };
    const outErr = await PRODUCTION_NEWS_ANALYZER_SOURCE.aggregateKOLForStock('sz.300750');
    assert(outErr.length === 0, '[7] throw -> 返 [] (fail-OPEN)');
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (realModule as any).kolAggregatorService = originalAggregator;
  }

  // -------------------------------------------------------------------------
  // [8] META-GUARD — NewsAnalyzer.ts 正反向源文件守
  // -------------------------------------------------------------------------
  const srcPath = path.resolve(
    __dirname,
    '../../../src/services/analysis-engine/analyzers/NewsAnalyzer.ts'
  );
  const src = fs.readFileSync(srcPath, 'utf-8');
  // 正向
  assert(
    /from '\.\.\/\.\.\/KOLAggregatorService'/.test(src),
    '[8+] import KOLAggregatorService'
  );
  assert(/authorityWeightedSentiment/.test(src), '[8+] uses authorityWeightedSentiment');
  assert(/weightedAvgKOLSentiment\(/.test(src), '[8+] calls weightedAvgKOLSentiment');
  assert(/buildKOLEvidenceDetail\(/.test(src), '[8+] calls buildKOLEvidenceDetail');
  assert(/toSixDigitStockCode\(/.test(src), '[8+] calls toSixDigitStockCode');
  assert(/dryRun:\s*true/.test(src), '[8+] PRODUCTION path uses dryRun:true');
  // 反向 — 旧"裸 reduce / scored sentiment_score" 路径必须从 KOL 段彻底移除.
  // 用代码块切割: 找 '3) KOL' 注释起到 'const score = weightedMean' 之间的片段
  const kolBlockMatch = src.match(/\/\/ 3\) KOL[\s\S]*?const score = weightedMean/);
  assert(!!kolBlockMatch, '[8-] KOL 段块定位成功');
  if (kolBlockMatch) {
    const kolBlock = kolBlockMatch[0];
    assert(
      !/scored\.reduce\(/.test(kolBlock),
      '[8-] KOL 段不再含 scored.reduce (裸算术 avg)'
    );
    assert(
      !/k\.sentiment_score/.test(kolBlock),
      '[8-] KOL 段不再用 k.sentiment_score 简化 map (走 weighted helper)'
    );
    // 旧 label 残留
    assert(
      !/`KOL\s+\${kol\.length}\s+条\s+\(avg sentiment/.test(kolBlock),
      '[8-] KOL 段不再含旧 "avg sentiment" label'
    );
  }
  // persist:false 替成 dryRun:true 必须切干净
  assert(!/persist:\s*false/.test(src), '[8-] 不再含旧 persist:false 错误 option');
  // 旧 NewsAnalyzer KOLOpinionRecord 局部 interface 不应同时存在 (导入了 KOLAggregator 的类型)
  assert(
    !/^interface KOLOpinionRecord\s*\{/m.test(src),
    '[8-] 不再 inline 定义 KOLOpinionRecord (走 import)'
  );

  // -------------------------------------------------------------------------
  console.log(`\n${pass} passed, ${fail} failed.`);
  if (fail > 0) {
    console.error('\nFailures:');
    failures.forEach(f => console.error(`  - ${f}`));
    process.exit(1);
  }
})();
