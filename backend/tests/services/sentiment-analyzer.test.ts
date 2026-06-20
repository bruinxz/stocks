/**
 * sentiment-analyzer.test.ts — US-122 QA-005 SentimentAnalyzer 接 QA 新维度白盒测试.
 *
 * 覆盖:
 *   1. questionsGrowthToScore 边界 (null / +Inf / -Inf / 上下限截断)
 *   2. answerRateToScore 边界 (null / NaN / 0 / 0.3 中性 / 0.6 满阳 / 1.0 clip)
 *   3. computeQuestionsGrowth 复刻 detector 同款语义 (prev=0 curr>0 → +Inf)
 *   4. SentimentAnalyzer.analyze:
 *      a. happy + 大样本 → evidence 含 questions_growth + answer_rate
 *      b. 小样本守门 (curr=3 < MIN=5) → data_missing 含 qa_questions_growth + qa_answer_rate
 *      c. qaSource 异常 (null) → data_missing 含 qa_stat_snapshot
 *      d. 上周无 baseline (prev=null) → growth 维度 missing 但 answer_rate 仍计
 *      e. 上周=0 当周>0 → growth=+Inf → 上限分 +30
 *   5. 常量冻结 META-GUARD
 *   6. 源文件 jsdoc 显式声明 "US-122 QA-005"
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  SentimentAnalyzer,
  QA_DIMENSION_THRESHOLDS,
  QA_DIMENSION_WEIGHTS,
  questionsGrowthToScore,
  answerRateToScore,
  computeQuestionsGrowth,
  PRODUCTION_SENTIMENT_QA_SOURCE,
  SentimentQASource,
} from '../../src/services/analysis-engine/analyzers/SentimentAnalyzer';
import type { AnalyzerContext } from '../../src/services/analysis-engine/AnalyzerTypes';

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

function approx(a: number, b: number, tol = 1e-6): boolean {
  return Math.abs(a - b) <= tol;
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
    factor_snapshot: {
      east_money_qa: 0.7,
      concept_heat: 1.2,
      shareholder_concentration: 0.4,
    },
  };
}

(async () => {
  // ------------------- [1] questionsGrowthToScore 边界 -------------------
  assert(questionsGrowthToScore(null) === null, 'growthToScore: null → null');
  assert(questionsGrowthToScore(undefined as any) === null, 'growthToScore: undefined → null');
  const sInf = questionsGrowthToScore(Number.POSITIVE_INFINITY);
  assert(sInf === 30, `growthToScore: +Inf → 30 (got ${sInf})`);
  const sNegInf = questionsGrowthToScore(Number.NEGATIVE_INFINITY);
  assert(sNegInf === -30, `growthToScore: -Inf → -30 (got ${sNegInf})`);
  // 0% growth → 0 分
  const s0 = questionsGrowthToScore(0);
  assert(approx(s0!, 0), `growthToScore: 0 → 0 (got ${s0})`);
  // +200% → 上限 30 分
  const sCap = questionsGrowthToScore(2.0);
  assert(approx(sCap!, 30), `growthToScore: +200% → 30 (got ${sCap})`);
  // +300% 超 cap → 仍 30 分 (cap)
  const sOver = questionsGrowthToScore(3.0);
  assert(approx(sOver!, 30), `growthToScore: +300% → cap 30 (got ${sOver})`);
  // -100% → 下限 -15 分 (FLOOR=-1.0; -1/2.0×30 = -15)
  const sFloor = questionsGrowthToScore(-1.0);
  assert(approx(sFloor!, -15), `growthToScore: -100% → -15 (got ${sFloor})`);
  // -200% 超 floor → 仍 -15 分
  const sUnder = questionsGrowthToScore(-2.0);
  assert(approx(sUnder!, -15), `growthToScore: -200% → floor -15 (got ${sUnder})`);

  // ------------------- [2] answerRateToScore 边界 -------------------
  assert(answerRateToScore(null) === null, 'arToScore: null → null');
  assert(answerRateToScore(undefined as any) === null, 'arToScore: undefined → null');
  assert(answerRateToScore(NaN) === null, 'arToScore: NaN → null');
  // ar=0 → -30 (REF=0.3, (0-0.3)*100 = -30)
  const ar0 = answerRateToScore(0);
  assert(approx(ar0!, -30), `arToScore: 0 → -30 (got ${ar0})`);
  // ar=0.3 → 0 中性
  const arRef = answerRateToScore(0.3);
  assert(approx(arRef!, 0), `arToScore: 0.3 → 0 neutral (got ${arRef})`);
  // ar=0.6 → +30 (cap)
  const ar06 = answerRateToScore(0.6);
  assert(approx(ar06!, 30), `arToScore: 0.6 → 30 cap (got ${ar06})`);
  // ar=1.0 → 30 cap
  const ar1 = answerRateToScore(1.0);
  assert(approx(ar1!, 30), `arToScore: 1.0 → 30 cap (got ${ar1})`);
  // ar=-0.5 (clip 到 0) → -30
  const arNeg = answerRateToScore(-0.5);
  assert(approx(arNeg!, -30), `arToScore: -0.5 → -30 (got ${arNeg})`);

  // ------------------- [3] computeQuestionsGrowth 边界 -------------------
  assert(computeQuestionsGrowth(0, 0) === null, 'growth: 0/0 → null');
  assert(computeQuestionsGrowth(10, null) === null, 'growth: prev=null → null');
  assert(computeQuestionsGrowth(10, undefined) === null, 'growth: prev=undefined → null');
  assert(computeQuestionsGrowth(NaN, 5) === null, 'growth: NaN → null');
  assert(computeQuestionsGrowth(-1, 5) === null, 'growth: negative → null');
  assert(
    computeQuestionsGrowth(10, 0) === Number.POSITIVE_INFINITY,
    'growth: prev=0 curr>0 → +Inf'
  );
  assert(approx(computeQuestionsGrowth(20, 10)!, 1.0), 'growth: 20 vs 10 → +1.0');
  assert(approx(computeQuestionsGrowth(5, 10)!, -0.5), 'growth: 5 vs 10 → -0.5');

  // ------------------- [4a] happy path: 大样本 → 两维度 evidence 都出 ------
  const saHappy = new SentimentAnalyzer(
    { async getMarketSentimentPercentile() { return 50; } },
    {
      async getQAStatSnapshot() {
        return {
          stock_code: '300750',
          week_start: '2026-06-15',
          questions_count_curr: 30,
          questions_count_prev: 10,
          answer_rate: 0.6,
        };
      },
    }
  );
  const out = await saHappy.analyze(baseCtx());
  assert(out.error === null, '[4a] happy: no error');
  const labelText = out.evidence.map(e => e.label).join(' | ');
  assert(/本周提问环比/.test(labelText), `[4a] happy: questions_growth evidence (${labelText})`);
  assert(/公司答复率/.test(labelText), `[4a] happy: answer_rate evidence (${labelText})`);
  // growth +200% → bullish; answer_rate 0.6 → bullish (+30) → 整体 score 正
  assert(out.score > 0, `[4a] happy: score > 0 (${out.score})`);

  // ------------------- [4b] 小样本守门: curr=3 < MIN=5 -----------------
  const saSmall = new SentimentAnalyzer(
    { async getMarketSentimentPercentile() { return 50; } },
    {
      async getQAStatSnapshot() {
        return {
          stock_code: '300750',
          week_start: '2026-06-15',
          questions_count_curr: 3,
          questions_count_prev: 1,
          answer_rate: 0.9,
        };
      },
    }
  );
  const outSmall = await saSmall.analyze(baseCtx());
  assert(
    outSmall.data_missing.includes('qa_questions_growth'),
    `[4b] small: qa_questions_growth missing listed (${outSmall.data_missing.join(',')})`
  );
  assert(
    outSmall.data_missing.includes('qa_answer_rate'),
    `[4b] small: qa_answer_rate missing listed (${outSmall.data_missing.join(',')})`
  );
  const labelSmall = outSmall.evidence.map(e => e.label).join(' | ');
  assert(
    !/本周提问环比/.test(labelSmall),
    `[4b] small: no growth evidence emitted (${labelSmall})`
  );
  assert(
    !/公司答复率/.test(labelSmall),
    `[4b] small: no answer_rate evidence emitted (${labelSmall})`
  );

  // ------------------- [4c] qaSource null → data_missing qa_stat_snapshot ----
  const saNull = new SentimentAnalyzer(
    { async getMarketSentimentPercentile() { return 50; } },
    { async getQAStatSnapshot() { return null; } }
  );
  const outNull = await saNull.analyze(baseCtx());
  assert(
    outNull.data_missing.includes('qa_stat_snapshot'),
    `[4c] null: qa_stat_snapshot missing (${outNull.data_missing.join(',')})`
  );

  // ------------------- [4d] 上周无 baseline (prev=null) -------------------
  const saNoPrev = new SentimentAnalyzer(
    { async getMarketSentimentPercentile() { return 50; } },
    {
      async getQAStatSnapshot() {
        return {
          stock_code: '300750',
          week_start: '2026-06-15',
          questions_count_curr: 20,
          questions_count_prev: null,
          answer_rate: 0.5,
        };
      },
    }
  );
  const outNoPrev = await saNoPrev.analyze(baseCtx());
  assert(
    outNoPrev.data_missing.includes('qa_questions_growth'),
    `[4d] no prev: growth missing (${outNoPrev.data_missing.join(',')})`
  );
  // 但 answer_rate 仍计 evidence
  const labelNoPrev = outNoPrev.evidence.map(e => e.label).join(' | ');
  assert(
    /公司答复率/.test(labelNoPrev),
    `[4d] no prev: answer_rate evidence still emitted (${labelNoPrev})`
  );

  // ------------------- [4e] prev=0 curr>0 → +Inf → 30 cap -----------------
  const saInf = new SentimentAnalyzer(
    { async getMarketSentimentPercentile() { return 50; } },
    {
      async getQAStatSnapshot() {
        return {
          stock_code: '300750',
          week_start: '2026-06-15',
          questions_count_curr: 50,
          questions_count_prev: 0,
          answer_rate: 0.5,
        };
      },
    }
  );
  const outInf = await saInf.analyze(baseCtx());
  const growthEv = outInf.evidence.find(e => /本周提问环比/.test(e.label));
  assert(growthEv !== undefined, '[4e] +Inf: growth evidence emitted');
  assert(
    growthEv?.label.includes('Inf'),
    `[4e] +Inf: label contains "Inf" (${growthEv?.label})`
  );
  assert(
    growthEv?.metric_value === 30,
    `[4e] +Inf: metric_value=30 (got ${growthEv?.metric_value})`
  );
  assert(growthEv?.direction === 'bullish', '[4e] +Inf: bullish direction');

  // ------------------- [5] 常量冻结 META-GUARD -----------------
  assert(Object.isFrozen(QA_DIMENSION_THRESHOLDS), '[5] QA_DIMENSION_THRESHOLDS frozen');
  assert(Object.isFrozen(QA_DIMENSION_WEIGHTS), '[5] QA_DIMENSION_WEIGHTS frozen');
  assert(
    QA_DIMENSION_THRESHOLDS.MIN_QUESTIONS_COUNT === 5,
    'MIN_QUESTIONS_COUNT=5 与 QALeadingSignalDetector 对齐'
  );
  assert(
    QA_DIMENSION_THRESHOLDS.GROWTH_PCT_CAP === 2.0,
    'GROWTH_PCT_CAP=2.0 (+200%) 与 detector 一致'
  );
  assert(QA_DIMENSION_THRESHOLDS.ANSWER_RATE_REF === 0.3, 'ANSWER_RATE_REF=0.3 中性基准');
  assert(QA_DIMENSION_WEIGHTS.QUESTIONS_GROWTH === 0.1, 'QUESTIONS_GROWTH weight=0.1');
  assert(QA_DIMENSION_WEIGHTS.ANSWER_RATE === 0.1, 'ANSWER_RATE weight=0.1');

  // ------------------- [6] 源文件 jsdoc 含 "US-122 QA-005" wire-in 注释 -----
  const srcPath = path.resolve(
    __dirname,
    '../../src/services/analysis-engine/analyzers/SentimentAnalyzer.ts'
  );
  const src = fs.readFileSync(srcPath, 'utf-8');
  assert(/US-122/.test(src), '[6] source jsdoc 含 "US-122" 标记');
  assert(/QA-005/.test(src), '[6] source jsdoc 含 "QA-005" 标记');
  assert(/questions_growth/.test(src), '[6] source mentions questions_growth');
  assert(/answer_rate/.test(src), '[6] source mentions answer_rate');
  // META-GUARD: 真接入 QAStatAggregator (US-038)
  assert(
    /qaStatAggregator/.test(src),
    '[6] source 必须 require qaStatAggregator (生产 wire-in)'
  );
  assert(
    /MIN_QUESTIONS_COUNT/.test(src),
    '[6] source 含 MIN_QUESTIONS_COUNT 小样本守门'
  );

  // PRODUCTION_SENTIMENT_QA_SOURCE 存在且是 object with getQAStatSnapshot
  assert(
    typeof PRODUCTION_SENTIMENT_QA_SOURCE.getQAStatSnapshot === 'function',
    '[6] PRODUCTION_SENTIMENT_QA_SOURCE.getQAStatSnapshot exposed'
  );
  // 接口签名: SentimentQASource 必须可被 typescript 实例化
  const fake: SentimentQASource = { async getQAStatSnapshot() { return null; } };
  assert(typeof fake.getQAStatSnapshot === 'function', 'SentimentQASource interface OK');

  console.log(`\n${pass} passed, ${fail} failed.`);
  if (fail > 0) {
    console.error(`FAILURES:\n${failures.map(f => '  - ' + f).join('\n')}`);
    process.exit(1);
  } else {
    process.exit(0);
  }
})();
