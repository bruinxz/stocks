/**
 * AIAdvisorService.analyzeSingleStock 单元测试 (US-055)
 *
 * 不依赖 jest；node 直接跑：
 *   cd backend && npx ts-node --transpile-only tests/services/ai-advisor-service.test.ts
 *
 * 完全脱离 DB / 网络：注入 fake AIStockAnalysisDataSource。
 *
 * 覆盖维度：
 *   - 常量校验：ANALYSIS_DIMENSIONS / ANALYSIS_DIMENSION_LABELS
 *   - 纯函数：normalizeAnalysisDimensions / normalizeRecommendation /
 *     buildKeyPoints / buildAnalysisSummary / buildReportId /
 *     buildResultFromPayload / normalizeTradingAgentsError
 *   - service.analyzeSingleStock() end-to-end：
 *     - happy path: 5 dimensions all filled → status='completed'；
 *     - partial: 仅部分 dimensions 有 key_points → status='partial'；
 *     - failed payload: data 缺失 → status='failed' + error 字段；
 *     - is_async=true: 立即返回 status='pending' + task_id；
 *     - dry_run=true: 不写表 + persisted=false；
 *     - dimensions 子集（仅 ['fundamental','technical']）只在该 2 维度返回 key_points；
 *     - stock_name option 优先于 DataSource.resolveStockName；
 *     - saveReport throw → fail-OPEN 仍返回 result + metadata.save_error；
 *     - callRemoteAnalyze throw（DataSource 自己未 catch）→ 双重防御转 failed payload；
 *     - normalizeRecommendation 中英文混排映射规则；
 *     - normalizeAnalysisDimensions 静默丢弃 + 去重 + 大小写不敏感；
 *     - buildKeyPoints 多种 detail 形态（key_points / subfield map / string fallback）；
 *     - buildAnalysisSummary 在 stock_name 缺失时的兜底；
 *     - buildReportId 多次调用 ID 唯一性（rand 后缀防冲突）。
 */

import {
  AIAdvisorService,
  AIStockAnalysisDataSource,
  ANALYSIS_DIMENSIONS,
  ANALYSIS_DIMENSION_LABELS,
  AnalysisDimension,
  AnalyzeSingleStockResult,
  RemoteAnalyzePayload,
  buildAnalysisSummary,
  buildKeyPoints,
  buildReportId,
  buildResultFromPayload,
  normalizeAnalysisDimensions,
  normalizeRecommendation,
  normalizeTradingAgentsError,
} from '../../src/services/AIAdvisorService';

let failed = 0;
let passed = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`❌ ${name}${detail ? '  detail=' + detail : ''}`);
  }
}

function assertEqual<T>(name: string, actual: T, expected: T): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(name, ok, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

// ---------------------------------------------------------------------------
//  Fake DataSource
// ---------------------------------------------------------------------------

interface FakeState {
  /** Map ticker -> raw payload to return; if missing, returns happy COMPLETED. */
  payloadByTicker: Record<string, RemoteAnalyzePayload>;
  /** Map ticker -> stock_name to resolve; if missing, returns null. */
  nameByTicker: Record<string, string | null>;
  /** Captured saveReport calls (used for assertions). */
  saves: AnalyzeSingleStockResult[];
  /** When true, saveReport throws (used to test fail-OPEN). */
  saveShouldThrow?: boolean;
  /** When true, callRemoteAnalyze throws (used to test double-defense). */
  remoteShouldThrow?: boolean;
}

function makeFakeSource(state: FakeState): AIStockAnalysisDataSource {
  return {
    async callRemoteAnalyze(ticker, _targetDate, _isAsync) {
      if (state.remoteShouldThrow) {
        throw new Error('fake remote outage');
      }
      const stored = state.payloadByTicker[ticker];
      if (stored) return stored;
      // Default happy-path payload with all 5 dimensions filled
      return {
        status: 'COMPLETED',
        data: {
          decision: '买入',
          confidence_score: 85,
          risk_level: '中',
          detail: {
            fundamental_summary: '营收稳定增长，ROE 持续超过 25%',
            technical_summary: '突破 20 日均线，MACD 金叉',
            capital_summary: '北向连续 5 日净买入',
            news_summary: '即将发布 Q3 业绩预告',
            sentiment_summary: '雪球热度上升，市场情绪偏积极',
          },
        },
      };
    },
    async saveReport(record) {
      if (state.saveShouldThrow) {
        throw new Error('fake DB outage');
      }
      state.saves.push({ ...record });
    },
    async resolveStockName(stockCode) {
      return state.nameByTicker[stockCode] ?? null;
    },
  };
}

function emptyState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    payloadByTicker: {},
    nameByTicker: {},
    saves: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
//  Constants tests
// ---------------------------------------------------------------------------

async function testConstants() {
  assertEqual(
    'ANALYSIS_DIMENSIONS exact list',
    [...ANALYSIS_DIMENSIONS],
    ['fundamental', 'technical', 'capital', 'news', 'sentiment']
  );

  // Object.freeze guard
  let frozen = Object.isFrozen(ANALYSIS_DIMENSIONS);
  let labelFrozen = Object.isFrozen(ANALYSIS_DIMENSION_LABELS);
  assert('ANALYSIS_DIMENSIONS is frozen', frozen);
  assert('ANALYSIS_DIMENSION_LABELS is frozen', labelFrozen);

  assertEqual(
    'ANALYSIS_DIMENSION_LABELS exact mapping',
    { ...ANALYSIS_DIMENSION_LABELS },
    {
      fundamental: '基本面',
      technical: '技术面',
      capital: '资金面',
      news: '新闻面',
      sentiment: '情绪面',
    }
  );
}

// ---------------------------------------------------------------------------
//  Pure function tests
// ---------------------------------------------------------------------------

async function testNormalizeAnalysisDimensions() {
  assertEqual('normalize empty → defaults all 5', normalizeAnalysisDimensions(undefined), [
    'fundamental',
    'technical',
    'capital',
    'news',
    'sentiment',
  ]);
  assertEqual('normalize empty array → defaults all 5', normalizeAnalysisDimensions([]), [
    'fundamental',
    'technical',
    'capital',
    'news',
    'sentiment',
  ]);
  assertEqual(
    'normalize lowercase subset',
    normalizeAnalysisDimensions(['fundamental', 'technical']),
    ['fundamental', 'technical']
  );
  assertEqual(
    'normalize case-insensitive (UPPERCASE)',
    normalizeAnalysisDimensions(['FUNDAMENTAL', 'Technical']),
    ['fundamental', 'technical']
  );
  assertEqual(
    'normalize dedup preserves order',
    normalizeAnalysisDimensions(['news', 'technical', 'news', 'technical']),
    ['news', 'technical']
  );
  assertEqual(
    'normalize silently discards invalid items',
    normalizeAnalysisDimensions(['fundamental', 'INVALID', 'technical', null, 42]),
    ['fundamental', 'technical']
  );
  assertEqual(
    'normalize all invalid → defaults all 5',
    normalizeAnalysisDimensions(['xyz', 'abc', null]),
    ['fundamental', 'technical', 'capital', 'news', 'sentiment']
  );
  assertEqual(
    'normalize non-array → defaults all 5',
    normalizeAnalysisDimensions('fundamental' as any),
    ['fundamental', 'technical', 'capital', 'news', 'sentiment']
  );
  assertEqual(
    'normalize whitespace trim',
    normalizeAnalysisDimensions(['  fundamental  ', ' TECHNICAL ']),
    ['fundamental', 'technical']
  );
}

async function testNormalizeRecommendation() {
  assertEqual('recommendation empty → unknown', normalizeRecommendation(''), 'unknown');
  assertEqual('recommendation null → unknown', normalizeRecommendation(null), 'unknown');
  assertEqual('recommendation undefined → unknown', normalizeRecommendation(undefined), 'unknown');
  assertEqual(
    'recommendation 强烈买入 → strong_buy',
    normalizeRecommendation('强烈买入'),
    'strong_buy'
  );
  assertEqual(
    'recommendation 重点推荐 → strong_buy',
    normalizeRecommendation('重点推荐'),
    'strong_buy'
  );
  assertEqual(
    'recommendation STRONG_BUY → strong_buy',
    normalizeRecommendation('STRONG_BUY'),
    'strong_buy'
  );
  assertEqual(
    'recommendation strong-buy → strong_buy',
    normalizeRecommendation('strong-buy'),
    'strong_buy'
  );
  assertEqual(
    'recommendation 强烈卖出 → strong_sell',
    normalizeRecommendation('强烈卖出'),
    'strong_sell'
  );
  assertEqual(
    'recommendation 强烈减持 → strong_sell',
    normalizeRecommendation('强烈减持'),
    'strong_sell'
  );
  assertEqual('recommendation 买入 → buy', normalizeRecommendation('买入'), 'buy');
  assertEqual('recommendation BUY → buy', normalizeRecommendation('BUY'), 'buy');
  assertEqual('recommendation 加仓 → buy', normalizeRecommendation('加仓'), 'buy');
  assertEqual('recommendation 增持 → buy', normalizeRecommendation('增持'), 'buy');
  assertEqual('recommendation 推荐 → buy', normalizeRecommendation('推荐'), 'buy');
  assertEqual('recommendation 卖出 → sell', normalizeRecommendation('卖出'), 'sell');
  assertEqual('recommendation SELL → sell', normalizeRecommendation('sell'), 'sell');
  assertEqual('recommendation 减仓 → sell', normalizeRecommendation('减仓'), 'sell');
  assertEqual('recommendation 清仓 → sell', normalizeRecommendation('清仓'), 'sell');
  assertEqual('recommendation 持有 → hold', normalizeRecommendation('持有'), 'hold');
  assertEqual('recommendation 观望 → hold', normalizeRecommendation('观望'), 'hold');
  assertEqual('recommendation HOLD → hold', normalizeRecommendation('HOLD'), 'hold');
  assertEqual('recommendation 中性 → hold', normalizeRecommendation('中性'), 'hold');
  assertEqual('recommendation neutral → hold', normalizeRecommendation('neutral'), 'hold');
  assertEqual('recommendation 不认识 → unknown', normalizeRecommendation('不认识'), 'unknown');
  // 优先级：strong > non-strong（"强烈买入" 不能误识别为 "买入"）
  assertEqual(
    'recommendation 强烈推荐 → strong_buy (not buy)',
    normalizeRecommendation('强烈推荐'),
    'strong_buy'
  );
}

async function testBuildKeyPoints() {
  // 1) detail.key_points 直接是结构化 dict → 直接采用
  const dims: AnalysisDimension[] = ['fundamental', 'technical', 'capital'];
  const kp1 = buildKeyPoints(
    {
      key_points: {
        fundamental: ['ROE 25%', '营收 +15%'],
        technical: ['MACD 金叉'],
        capital: '北向连续买入',
      },
    },
    dims
  );
  assertEqual('buildKeyPoints accepts structured key_points dict', kp1, {
    fundamental: ['ROE 25%', '营收 +15%'],
    technical: ['MACD 金叉'],
    capital: ['北向连续买入'],
  });

  // 2) detail subfield map (no key_points) → 智能映射
  const kp2 = buildKeyPoints(
    {
      fundamental_summary: '基本面：营收稳定',
      technical_summary: '技术面：MACD 金叉',
      capital_summary: '资金面：主力净流入',
    },
    dims
  );
  assertEqual('buildKeyPoints maps subfields', kp2, {
    fundamental: ['基本面：营收稳定'],
    technical: ['技术面：MACD 金叉'],
    capital: ['资金面：主力净流入'],
  });

  // 3) detail 是 string → 当 fundamental（dim 中含 fundamental）
  const kp3 = buildKeyPoints('A whole-text rationale', ['fundamental', 'technical']);
  assertEqual('buildKeyPoints fallback string → fundamental only', kp3, {
    fundamental: ['A whole-text rationale'],
    technical: [],
  });

  // 4) detail null → 全空 keys
  const kp4 = buildKeyPoints(null, ['fundamental', 'technical']);
  assertEqual('buildKeyPoints null → empty maps', kp4, { fundamental: [], technical: [] });

  // 5) detail.key_points 的 dimension 不在 dims 中 → 忽略
  const kp5 = buildKeyPoints(
    {
      key_points: {
        fundamental: ['F1'],
        news: ['N1'], // not in dims
      },
    },
    ['fundamental', 'technical']
  );
  assertEqual('buildKeyPoints filters out dimensions not in dims', kp5, {
    fundamental: ['F1'],
    technical: [],
  });

  // 6) detail.key_points 中字符串 trim 空白
  const kp6 = buildKeyPoints(
    {
      key_points: {
        fundamental: ['  ', '有效要点', ''],
      },
    },
    ['fundamental']
  );
  assertEqual('buildKeyPoints filters empty/whitespace strings', kp6, {
    fundamental: ['有效要点'],
  });

  // 7) detail 是 string 但 dims 不含 fundamental → 全空
  const kp7 = buildKeyPoints('text', ['technical', 'news']);
  assertEqual('buildKeyPoints string fallback respects dims (no fundamental → empty)', kp7, {
    technical: [],
    news: [],
  });

  // 8) sentiment maps to multiple subfields (sentiment / mood / kol_summary)
  const kp8 = buildKeyPoints(
    {
      kol_summary: '雪球热度上升',
    },
    ['sentiment']
  );
  assertEqual('buildKeyPoints sentiment maps to kol_summary', kp8, { sentiment: ['雪球热度上升'] });

  // 9) news 字段也接受 announcements
  const kp9 = buildKeyPoints(
    {
      announcements: ['Q3 业绩预告', '股权激励'],
    },
    ['news']
  );
  assertEqual('buildKeyPoints news maps to announcements', kp9, {
    news: ['Q3 业绩预告', '股权激励'],
  });

  // 10) 生产 TradingAgents 形态：detail={}，完整论证只在 rationale。
  const productionRationale = [
    '#### （1）中期技术转空信号明确，趋势性风险不可忽视',
    '50日均线向下拐头、MACD下穿零轴且负值持续扩大，结合高ATR波动率，空头主导格局清晰。',
    '#### （2）资金面无修复动力，短期反弹缺乏核心支撑',
    '股价放量跌停且龙虎榜仅见资金出逃，无机构接盘痕迹，情绪驱动下无序波动风险较高。',
    '#### （3）AI赛道逻辑缺乏基本面验证，确定性不足',
    'AI手机备案利好虽为行业趋势，但公司未披露AI订单占比、中报业绩预告等硬数据。',
  ].join('\n');
  const kp10 = buildKeyPoints({ detail: {}, rationale: productionRationale }, [
    'fundamental',
    'technical',
    'capital',
    'news',
    'sentiment',
  ]);
  assert(
    'buildKeyPoints extracts all requested dimensions from rationale when detail is empty',
    Object.values(kp10).every(points => points.length > 0),
    JSON.stringify(kp10)
  );
  assert(
    'rationale technical point preserves source evidence',
    kp10.technical.some(point => point.includes('MACD')),
    JSON.stringify(kp10.technical)
  );
  assert(
    'rationale news point preserves disclosure evidence',
    kp10.news.some(point => point.includes('披露')),
    JSON.stringify(kp10.news)
  );
}

async function testBuildAnalysisSummary() {
  const dims: AnalysisDimension[] = ['fundamental', 'technical'];

  // 1) full case：含 stock_name + recommendation + confidence + risk
  const sum1 = buildAnalysisSummary('sh.600519', '贵州茅台', 'buy', 85, '中', dims, {
    fundamental: ['核心要点 F'],
    technical: ['核心要点 T'],
  });
  assert(
    'summary contains stock header',
    sum1.includes('sh.600519') && sum1.includes('贵州茅台'),
    sum1
  );
  assert('summary contains 买入', sum1.includes('买入'), sum1);
  assert('summary contains 置信 85', sum1.includes('置信 85'), sum1);
  assert('summary contains 风险 中', sum1.includes('风险 中'), sum1);
  assert('summary contains 基本面', sum1.includes('基本面'), sum1);
  assert('summary contains 技术面', sum1.includes('技术面'), sum1);

  // 2) stock_name 缺失 → 只显示 stock_code
  const sum2 = buildAnalysisSummary('sh.600519', null, 'hold', null, null, dims, {
    fundamental: ['F'],
    technical: ['T'],
  });
  assert(
    'summary handles null stock_name',
    sum2.includes('sh.600519') && !sum2.includes('null'),
    sum2
  );

  // 3) dim 有 multiple key_points → 多行
  const sum3 = buildAnalysisSummary('sh.000001', '平安银行', 'sell', 70, null, dims, {
    fundamental: ['F1', 'F2'],
    technical: ['T1'],
  });
  assert('summary multi-point uses sub-list', sum3.includes('  - F1'), sum3);
  assert('summary multi-point sub-list F2', sum3.includes('  - F2'), sum3);

  // 4) 缺失 key_points 的 dim 行被省略
  const sum4 = buildAnalysisSummary('sh.000001', '平安银行', 'hold', null, null, dims, {
    fundamental: ['F'],
    technical: [],
  });
  assert('summary skips empty dim', sum4.includes('基本面：F') && !sum4.includes('技术面'), sum4);

  // 5) unknown recommendation 显示中文 label
  const sum5 = buildAnalysisSummary('sh.600519', null, 'unknown', null, null, [], {});
  assert('summary unknown recommendation label', sum5.includes('暂无明确建议'), sum5);

  // 6) confidence 0.5 → 不显示（must be finite number, but rounded down to 1 displayed as 1）
  const sum6 = buildAnalysisSummary('sh.000001', null, 'buy', 92.3, null, [], {});
  assert('summary rounds confidence', sum6.includes('置信 92'), sum6);

  // 7) strong_buy label
  const sum7 = buildAnalysisSummary('sh.600519', null, 'strong_buy', null, null, [], {});
  assert('summary strong_buy label', sum7.includes('强烈买入'), sum7);
}

async function testBuildReportId() {
  const fixed = new Date('2026-06-08T10:15:30Z');
  const id1 = buildReportId('sh.600519', fixed);
  assert(
    'reportId format matches AI-{short}-{ts}-{rand}',
    /^AI-600519-20260608101530-[0-9a-f]{4}$/.test(id1),
    id1
  );

  // Strip sz prefix
  const id2 = buildReportId('sz.000001', fixed);
  assert('reportId strips sz. prefix', id2.startsWith('AI-000001-'), id2);

  // bj prefix
  const id3 = buildReportId('bj.430139', fixed);
  assert('reportId strips bj. prefix', id3.startsWith('AI-430139-'), id3);

  // 同秒生成两个 ID 应不同（rand suffix）
  const a = buildReportId('sh.600519', fixed);
  const b = buildReportId('sh.600519', fixed);
  // 在极端运气情况下 rand 可能相同；多调用几次降低误判概率
  let allSame = true;
  for (let i = 0; i < 30; i++) {
    const c = buildReportId('sh.600519', fixed);
    if (c !== a) {
      allSame = false;
      break;
    }
  }
  assert('reportId rand suffix ensures uniqueness', !allSame, `a=${a} b=${b}`);

  // No prefix case
  const id4 = buildReportId('600519', fixed);
  assert('reportId handles bare code', id4.startsWith('AI-600519-'), id4);
}

async function testBuildResultFromPayload() {
  const baseCtx = {
    report_id: 'AI-600519-20260608101530-abcd',
    stock_code: 'sh.600519',
    stock_name: '贵州茅台',
    dimensions: ['fundamental', 'technical', 'capital', 'news', 'sentiment'] as AnalysisDimension[],
    target_date: '2026-06-08',
    metadata: { user_id: 1, requested_at: '2026-06-08T10:15:30Z' },
    is_async: false,
    now: new Date('2026-06-08T10:15:30Z'),
  };

  // 1) Happy path COMPLETED → status='completed'
  const r1 = buildResultFromPayload(
    {
      status: 'COMPLETED',
      data: {
        decision: '买入',
        confidence_score: 85,
        risk_level: '中',
        detail: {
          fundamental_summary: '基本面 OK',
          technical_summary: '技术面 OK',
          capital_summary: '资金面 OK',
          news_summary: '新闻面 OK',
          sentiment_summary: '情绪面 OK',
        },
      },
    },
    baseCtx
  );
  assertEqual('happy COMPLETED → status', r1.status, 'completed');
  assertEqual('happy COMPLETED → recommendation', r1.recommendation, 'buy');
  assertEqual('happy COMPLETED → confidence', r1.confidence_score, 85);
  assertEqual('happy COMPLETED → risk_level', r1.risk_level, '中');
  assertEqual('happy COMPLETED → persisted=false initially', r1.persisted, false);
  assert(
    'happy COMPLETED → summary populated',
    r1.summary.includes('贵州茅台') && r1.summary.includes('买入'),
    r1.summary
  );

  // 2) Partial: 3/5 dimensions has key_points → status='partial' + error 字段
  const r2 = buildResultFromPayload(
    {
      status: 'COMPLETED',
      data: {
        decision: '持有',
        detail: {
          fundamental_summary: '基本面',
          technical_summary: '技术面',
          capital_summary: '资金面',
          // news / sentiment 缺失
        },
      },
    },
    baseCtx
  );
  assertEqual('partial → status', r2.status, 'partial');
  assert(
    'partial → error 字段提示',
    r2.error !== null && r2.error.includes('部分维度'),
    r2.error || 'null'
  );

  // 3) Failed payload (status=FAILED) → status='failed' + error 字段 + 空 key_points
  const r3 = buildResultFromPayload(
    {
      status: 'FAILED',
      data: { error: 'TradingAgents 行情缓存日期字段异常' },
    },
    baseCtx
  );
  assertEqual('FAILED → status', r3.status, 'failed');
  assertEqual('FAILED → recommendation unknown', r3.recommendation, 'unknown');
  assert('FAILED → error 文案落库', (r3.error || '').includes('TradingAgents'), r3.error || '');

  // 4) data 完全缺失 (没有 data 字段) → 也走 FAILED 分支
  const r4 = buildResultFromPayload({ status: 'COMPLETED' } as any, baseCtx);
  assertEqual('missing data → status=failed', r4.status, 'failed');

  // 5) is_async=true → status='pending' + task_id
  const r5 = buildResultFromPayload(
    { status: 'PENDING', task_id: 'task-xyz' },
    { ...baseCtx, is_async: true }
  );
  assertEqual('async → status=pending', r5.status, 'pending');
  assertEqual('async → task_id', r5.task_id, 'task-xyz');
  assertEqual('async → summary empty', r5.summary, '');

  // 异步请求的远端失败必须保留真实错误，不能伪装成无 task_id 的 pending。
  const r5Failed = buildResultFromPayload(
    { status: 'FAILED', data: { error: 'connect ECONNREFUSED 127.0.0.1:8000' } },
    { ...baseCtx, is_async: true }
  );
  assertEqual('async FAILED → status=failed', r5Failed.status, 'failed');
  assert(
    'async FAILED → preserves remote error',
    (r5Failed.error || '').includes('ECONNREFUSED'),
    r5Failed.error || ''
  );

  const r5MissingTask = buildResultFromPayload(
    { status: 'PENDING' },
    { ...baseCtx, is_async: true }
  );
  assertEqual('async PENDING missing task_id → failed', r5MissingTask.status, 'failed');
  assert(
    'async PENDING missing task_id → actionable error',
    (r5MissingTask.error || '').includes('task_id'),
    r5MissingTask.error || ''
  );

  // 6) status=RUNNING（异步 in flight）→ pending
  const r6 = buildResultFromPayload({ status: 'RUNNING', task_id: 'task-r' }, baseCtx);
  assertEqual('RUNNING → status=pending', r6.status, 'pending');
  assertEqual('RUNNING → task_id', r6.task_id, 'task-r');

  const r6Processing = buildResultFromPayload({ status: 'PROCESSING', task_id: 'task-p' }, baseCtx);
  assertEqual('PROCESSING → status=pending', r6Processing.status, 'pending');

  const r6RejectedNews = buildResultFromPayload(
    {
      status: 'COMPLETED',
      data: {
        decision: 'HOLD',
        key_points: {
          fundamental: ['基本面有数据'],
          technical: ['技术面有数据'],
          capital: ['资金面有数据'],
          news: ['错误关联的公司事件'],
          sentiment: ['情绪面有数据'],
        },
        detail: {
          evidence_audit: {
            company_news: {
              status: 'rejected',
              reason: 'explicit_company_attribution_mismatch',
            },
          },
        },
      },
    },
    baseCtx
  );
  assertEqual('rejected company news → partial', r6RejectedNews.status, 'partial');
  assert(
    'rejected company news → explicit isolation error',
    (r6RejectedNews.error || '').includes('归属冲突'),
    r6RejectedNews.error || ''
  );
  assertEqual(
    'rejected company news → evidence audit archived',
    (r6RejectedNews.metadata.tradingagents_evidence_audit as any)?.company_news?.status,
    'rejected'
  );

  // 7) data.confidence 兜底 (data.confidence_score 缺失但 data.confidence 在)
  const r7 = buildResultFromPayload(
    {
      status: 'COMPLETED',
      data: {
        decision: '买入',
        confidence: 70,
        detail: {
          fundamental_summary: 'F',
          technical_summary: 'T',
          capital_summary: 'C',
          news_summary: 'N',
          sentiment_summary: 'S',
        },
      },
    },
    baseCtx
  );
  assertEqual('confidence fallback (no confidence_score)', r7.confidence_score, 70);

  // 8) 无 confidence 字段 → null
  const r8 = buildResultFromPayload(
    {
      status: 'COMPLETED',
      data: {
        decision: '买入',
        detail: {
          fundamental_summary: 'F',
          technical_summary: 'T',
          capital_summary: 'C',
          news_summary: 'N',
          sentiment_summary: 'S',
        },
      },
    },
    baseCtx
  );
  assertEqual('no confidence → null', r8.confidence_score, null);

  // 9) 生产异步结果会返回 detail={} + rationale；不能因空对象 truthy 丢掉全文。
  const rationale = [
    '技术面显示MACD下穿零轴、50日均线转弱。',
    '资金面出现主力净流出，龙虎榜未见机构接盘。',
    '基本面仍需财报业绩和订单数据验证。',
    '公告披露与中报预告是后续新闻催化。',
    '跌停与游资炒作导致短期市场情绪偏弱。',
  ].join('\n');
  const r9 = buildResultFromPayload(
    {
      status: 'COMPLETED',
      data: { decision: 'SELL', detail: {}, rationale },
    },
    baseCtx
  );
  assertEqual('empty detail + rationale → completed', r9.status, 'completed');
  assert(
    'empty detail + rationale → all dimensions populated',
    Object.values(r9.key_points).every(points => points.length > 0),
    JSON.stringify(r9.key_points)
  );
  assertEqual(
    'source rationale retained for archived report audit',
    r9.metadata.tradingagents_rationale,
    rationale
  );
}

async function testNormalizeTradingAgentsError() {
  assertEqual(
    'normalize error empty → 默认文案',
    normalizeTradingAgentsError(''),
    'TradingAgents 远端任务失败，未返回具体原因'
  );
  assertEqual(
    'normalize error string',
    normalizeTradingAgentsError('something went wrong'),
    'something went wrong'
  );
  assertEqual(
    'normalize error from object message',
    normalizeTradingAgentsError({ message: 'oops' }),
    'oops'
  );
  const refusedMsg = normalizeTradingAgentsError('connect ECONNREFUSED 127.0.0.1:8000');
  assert(
    'normalize local TradingAgents connection refusal → actionable message',
    refusedMsg.includes('服务暂不可用') && refusedMsg.includes('ECONNREFUSED'),
    refusedMsg
  );
  // KeyError: '日期' 特殊文案
  const dateMsg = normalizeTradingAgentsError("KeyError: '日期'");
  assert(
    'normalize 日期 KeyError → 友好中文',
    dateMsg.includes('日期字段异常') && dateMsg.includes('请重启 TradingAgents'),
    dateMsg
  );

  // 'Cannot calculate requested indicators' 特殊文案
  const indMsg = normalizeTradingAgentsError('Cannot calculate requested indicators');
  assert('normalize indicator failure → 友好中文', indMsg.includes('技术指标计算失败'), indMsg);
}

// ---------------------------------------------------------------------------
//  end-to-end analyzeSingleStock tests
// ---------------------------------------------------------------------------

async function testAnalyzeSingleStock_HappyPath() {
  const state = emptyState({
    nameByTicker: { 'sh.600519': '贵州茅台' },
  });
  const service = new AIAdvisorService(makeFakeSource(state));
  const result = await service.analyzeSingleStock('sh.600519', { user_id: 7 });
  assertEqual('happy: status=completed', result.status, 'completed');
  assertEqual('happy: recommendation=buy', result.recommendation, 'buy');
  assertEqual('happy: 5 dimensions', result.dimensions, [
    'fundamental',
    'technical',
    'capital',
    'news',
    'sentiment',
  ]);
  assertEqual('happy: stock_name resolved', result.stock_name, '贵州茅台');
  assertEqual('happy: persisted=true', result.persisted, true);
  assertEqual('happy: 1 save captured', state.saves.length, 1);
  assertEqual('happy: persisted report_id matches', state.saves[0].report_id, result.report_id);
  assertEqual('happy: user_id in metadata', state.saves[0].metadata.user_id, 7);
  assert(
    'happy: summary 包含建议 + 维度',
    result.summary.includes('买入') && result.summary.includes('基本面'),
    result.summary
  );
}

async function testAnalyzeSingleStock_Partial() {
  const state = emptyState({
    payloadByTicker: {
      'sh.000001': {
        status: 'COMPLETED',
        data: {
          decision: '持有',
          confidence_score: 50,
          detail: {
            fundamental_summary: 'F',
            technical_summary: 'T',
            // capital/news/sentiment missing
          },
        },
      },
    },
    nameByTicker: { 'sh.000001': '平安银行' },
  });
  const service = new AIAdvisorService(makeFakeSource(state));
  const result = await service.analyzeSingleStock('sh.000001');
  assertEqual('partial: status=partial', result.status, 'partial');
  assertEqual('partial: recommendation=hold', result.recommendation, 'hold');
  assert('partial: error 字段提示', (result.error || '').includes('部分维度'), result.error || '');
  assertEqual('partial: persisted=true', result.persisted, true);
  // capital/news/sentiment 的 key_points 应为 []
  assertEqual('partial: capital empty', result.key_points.capital, []);
  assertEqual('partial: news empty', result.key_points.news, []);
  assertEqual('partial: sentiment empty', result.key_points.sentiment, []);
}

async function testAnalyzeSingleStock_Failed() {
  const state = emptyState({
    payloadByTicker: {
      'sh.600519': {
        status: 'FAILED',
        data: { error: '后端服务异常' },
      },
    },
  });
  const service = new AIAdvisorService(makeFakeSource(state));
  const result = await service.analyzeSingleStock('sh.600519');
  assertEqual('failed: status=failed', result.status, 'failed');
  assertEqual('failed: recommendation=unknown', result.recommendation, 'unknown');
  assert(
    'failed: error 文案落库',
    (result.error || '').includes('后端服务异常'),
    result.error || ''
  );
  // 仍 persisted（让用户能看到"曾尝试过"）
  assertEqual('failed: persisted=true', result.persisted, true);
}

async function testAnalyzeSingleStock_Async() {
  const state = emptyState({
    payloadByTicker: {
      'sh.600519': {
        status: 'PENDING',
        task_id: 'task-async-001',
      },
    },
  });
  const service = new AIAdvisorService(makeFakeSource(state));
  const result = await service.analyzeSingleStock('sh.600519', { is_async: true });
  assertEqual('async: status=pending', result.status, 'pending');
  assertEqual('async: task_id', result.task_id, 'task-async-001');
  assertEqual('async: summary empty', result.summary, '');
  assertEqual('async: 1 row still persisted (placeholder)', state.saves.length, 1);
}

async function testAnalyzeSingleStock_DryRun() {
  const state = emptyState();
  const service = new AIAdvisorService(makeFakeSource(state));
  const result = await service.analyzeSingleStock('sh.600519', { dry_run: true });
  assertEqual('dry_run: status=completed', result.status, 'completed');
  assertEqual('dry_run: persisted=false', result.persisted, false);
  assertEqual('dry_run: 0 saves captured', state.saves.length, 0);
}

async function testAnalyzeSingleStock_DimensionsSubset() {
  const state = emptyState();
  const service = new AIAdvisorService(makeFakeSource(state));
  const result = await service.analyzeSingleStock('sh.600519', {
    dimensions: ['fundamental', 'technical'],
  });
  assertEqual('subset: 2 dimensions', result.dimensions, ['fundamental', 'technical']);
  // key_points 应只含这 2 维度
  assertEqual('subset: 2 keys in key_points', Object.keys(result.key_points).sort(), [
    'fundamental',
    'technical',
  ]);
  // 既然 default happy payload 包含所有 5 维度 subfield，2 维度应都 filled → status=completed
  assertEqual('subset: status=completed (since both filled)', result.status, 'completed');
}

async function testAnalyzeSingleStock_StockNameOverride() {
  const state = emptyState({
    nameByTicker: { 'sh.600519': 'DB 反查名称' },
  });
  const service = new AIAdvisorService(makeFakeSource(state));
  // option 中传 stock_name 应优先于 DataSource.resolveStockName
  const result = await service.analyzeSingleStock('sh.600519', {
    stock_name: 'Option 优先名',
  });
  assertEqual('option stock_name 优先于 DB 反查', result.stock_name, 'Option 优先名');
}

async function testAnalyzeSingleStock_StockNameFallback() {
  const state = emptyState({
    nameByTicker: {}, // resolveStockName 返回 null
  });
  const service = new AIAdvisorService(makeFakeSource(state));
  const result = await service.analyzeSingleStock('sh.999999');
  assertEqual('no stock_name → null', result.stock_name, null);
  // summary 仍正确生成（只含 stock_code）
  assert(
    'summary still ok without stock_name',
    result.summary.includes('sh.999999') && !result.summary.includes('null'),
    result.summary
  );
}

async function testAnalyzeSingleStock_SaveFailFailOPEN() {
  const state = emptyState({ saveShouldThrow: true });
  const service = new AIAdvisorService(makeFakeSource(state));
  const result = await service.analyzeSingleStock('sh.600519');
  // fail-OPEN：DB 故障不阻塞 UI 拿到结果
  assertEqual('save fail-OPEN: status=completed', result.status, 'completed');
  assertEqual('save fail-OPEN: persisted=false', result.persisted, false);
  assert(
    'save fail-OPEN: save_error in metadata',
    (result.metadata as any).save_error !== undefined,
    JSON.stringify(result.metadata)
  );
  assertEqual('save fail-OPEN: 0 saves captured', state.saves.length, 0);
}

async function testAnalyzeSingleStock_RemoteThrowDoubleDefense() {
  const state = emptyState({ remoteShouldThrow: true });
  const service = new AIAdvisorService(makeFakeSource(state));
  const result = await service.analyzeSingleStock('sh.600519');
  // 双重防御：DataSource throw 时也走 failed 分支不抛
  assertEqual('remote throw → status=failed', result.status, 'failed');
  assert('remote throw → error 描述', (result.error || '').length > 0, result.error || '');
}

async function testAnalyzeSingleStock_TaskLabelMetadata() {
  const state = emptyState();
  const service = new AIAdvisorService(makeFakeSource(state));
  const result = await service.analyzeSingleStock('sh.600519', {
    task_label: 'PortfolioWorkspace',
    user_id: 42,
  });
  assertEqual('task_label in metadata', result.metadata.task_label, 'PortfolioWorkspace');
  assertEqual('user_id in metadata', result.metadata.user_id, 42);
}

async function testAnalyzeSingleStock_TargetDate() {
  const state = emptyState();
  const service = new AIAdvisorService(makeFakeSource(state));
  const result = await service.analyzeSingleStock('sh.600519', {
    target_date: '2026-05-15',
  });
  assertEqual('target_date saved', result.target_date, '2026-05-15');
}

async function testAnalyzeSingleStock_StockCodeNormalization() {
  const state = emptyState({
    nameByTicker: { 'sh.600519': '贵州茅台' },
  });
  const service = new AIAdvisorService(makeFakeSource(state));
  // 传 '600519'（无前缀）应被 normalizeSymbol 规范化为 'sh.600519'
  const result = await service.analyzeSingleStock('600519');
  // normalizeSymbol 行为我们不强制 assert（可能输出 'sh.600519' or '600519' 取决于实现），
  // 但 stock_code 必须是 string 且包含 '600519'
  assert(
    'analyze: stock_code 包含原 6 位',
    result.stock_code.includes('600519'),
    result.stock_code
  );
  assert('analyze: report_id 含 600519', result.report_id.includes('600519'), result.report_id);
}

// ---------------------------------------------------------------------------
//  Main runner
// ---------------------------------------------------------------------------

async function main() {
  // Constants
  await testConstants();

  // Pure helpers
  await testNormalizeAnalysisDimensions();
  await testNormalizeRecommendation();
  await testBuildKeyPoints();
  await testBuildAnalysisSummary();
  await testBuildReportId();
  await testBuildResultFromPayload();
  await testNormalizeTradingAgentsError();

  // End-to-end analyzeSingleStock
  await testAnalyzeSingleStock_HappyPath();
  await testAnalyzeSingleStock_Partial();
  await testAnalyzeSingleStock_Failed();
  await testAnalyzeSingleStock_Async();
  await testAnalyzeSingleStock_DryRun();
  await testAnalyzeSingleStock_DimensionsSubset();
  await testAnalyzeSingleStock_StockNameOverride();
  await testAnalyzeSingleStock_StockNameFallback();
  await testAnalyzeSingleStock_SaveFailFailOPEN();
  await testAnalyzeSingleStock_RemoteThrowDoubleDefense();
  await testAnalyzeSingleStock_TaskLabelMetadata();
  await testAnalyzeSingleStock_TargetDate();
  await testAnalyzeSingleStock_StockCodeNormalization();

  console.log(
    `\n✅ ${passed} passed  ${failed > 0 ? '❌ ' + failed + ' failed' : '0 failed'}  ` +
      `total=${passed + failed}`
  );
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
