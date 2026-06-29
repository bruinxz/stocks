/**
 * BullishEventDetectorService 单元测试 (PR-B / 2026-06-29)
 *
 * 不依赖 jest; 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/bullish-event-detector-service.test.ts
 *
 * 完全脱 DB / 网络 / 飞书 webhook — 所有 BullishDataSource 方法 + feishu_push 全 stub.
 *
 * 覆盖维度:
 *   - 4 detector 纯函数 happy + 边界 (空入 / null defense / 阈值刚好不命中)
 *   - 关键 helper: scoreNewsTitle (正/负/中性) / buildDedupKey / toBareCode /
 *     appendDedupTag / mean / stdev
 *   - runOnce e2e:
 *     - empty universe → scanned=0 + 不调任何 detector ds
 *     - 4 detector 全命中 → detected/pushed/by_detector 正确
 *     - dedup: recent dedup keys 命中 → deduped+=1, pushed 不增
 *     - dry_run=true → 不写 RiskAlert + 不调 feishu_push
 *     - 单 detector throw → 仅记 errors, 其它 detector 仍跑
 *     - 同次 run 同 stock + detector 重复命中 → 只推 1 次 (seenInThisRun)
 */

import {
  BullishEventDetectorService,
  BullishDataSource,
  BullishDetectorRunResult,
  AnnouncementRow,
  NewsRow,
  SentimentDailyRow,
  KolOpinionRow,
  BULLISH_DETECTOR_TYPES,
  BULLISH_DETECTOR_LABELS,
  detectCriticalAnnouncementHits,
  detectPositiveNewsHits,
  detectAttentionSpikeHits,
  detectKolConsensusHits,
  scoreNewsTitle,
  buildDedupKey,
  appendDedupTag,
  toBareCode,
  mean,
  stdev,
  buildOpsBullishCardBody,
  POSITIVE_NEWS_KEYWORDS,
  NEGATIVE_NEWS_KEYWORDS,
  STRONG_POSITIVE_KEYWORDS,
} from '../../src/services/BullishEventDetectorService';

let ok = 0;
let fail = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) ok++;
  else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function assertEqual(name: string, got: any, want: any): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) ok++;
  else {
    fail++;
    console.log(`  FAIL ${name}\n    got:  ${g}\n    want: ${w}`);
  }
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeDSData {
  positions?: string[];
  favorites?: string[];
  aiRecommended?: string[];
  stockNames?: Record<string, string>;
  announcements?: AnnouncementRow[];
  news?: NewsRow[];
  sentiments?: SentimentDailyRow[];
  kolOpinions?: KolOpinionRow[];
  dedupKeys?: string[];
  activeUserIds?: number[];
  /** 测试 — 让某 method throw */
  throws?: Partial<Record<keyof BullishDataSource, string>>;
}

interface FakeDSCalls {
  writeRiskAlerts: Array<{
    user_ids: number[];
    symbol: string;
    name: string;
    level: string;
    rule_id: string;
    message: string;
  }>;
  feishuPush: Array<{
    dedup_key: string;
    level: string;
    title: string;
    body_markdown: string;
  }>;
  writeIntradaySignal: Array<{
    symbol: string;
    prefixed_symbol: string;
    name: string;
    signal_date: string;
    detector_label: string;
    detector: string;
    reason: string;
    score: number;
  }>;
}

function makeFakeDS(data: FakeDSData = {}): {
  ds: BullishDataSource;
  calls: FakeDSCalls;
} {
  const calls: FakeDSCalls = { writeRiskAlerts: [], feishuPush: [], writeIntradaySignal: [] };
  const maybeThrow = (k: keyof BullishDataSource): void => {
    if (data.throws && data.throws[k]) throw new Error(data.throws[k] as string);
  };
  const ds: BullishDataSource = {
    async listPositionSymbols() {
      maybeThrow('listPositionSymbols');
      return data.positions || [];
    },
    async listFavoriteSymbols() {
      maybeThrow('listFavoriteSymbols');
      return data.favorites || [];
    },
    async listAIRecommendedSymbols() {
      maybeThrow('listAIRecommendedSymbols');
      return data.aiRecommended || [];
    },
    async resolveStockNames(codes: string[]) {
      maybeThrow('resolveStockNames');
      const m = new Map<string, string>();
      for (const c of codes) {
        if (data.stockNames && data.stockNames[c]) m.set(c, data.stockNames[c]);
      }
      return m;
    },
    async listCriticalAnnouncements() {
      maybeThrow('listCriticalAnnouncements');
      return data.announcements || [];
    },
    async listRecentNews() {
      maybeThrow('listRecentNews');
      return data.news || [];
    },
    async listSentimentsByCodes() {
      maybeThrow('listSentimentsByCodes');
      return data.sentiments || [];
    },
    async listRecentKolOpinions() {
      maybeThrow('listRecentKolOpinions');
      return data.kolOpinions || [];
    },
    async loadRecentDedupKeys() {
      maybeThrow('loadRecentDedupKeys');
      return new Set(data.dedupKeys || []);
    },
    async writeRiskAlerts(input) {
      maybeThrow('writeRiskAlerts');
      calls.writeRiskAlerts.push(input);
      return { created_ids: input.user_ids.map((_, i) => i + 1), failed: 0 };
    },
    async listActiveUserIds() {
      maybeThrow('listActiveUserIds');
      return data.activeUserIds || [];
    },
    async writeIntradaySignal(input) {
      maybeThrow('writeIntradaySignal');
      calls.writeIntradaySignal.push(input);
      return { signal_id: calls.writeIntradaySignal.length };
    },
  };
  return { ds, calls };
}

// ---------------------------------------------------------------------------
// [1] Constants
// ---------------------------------------------------------------------------
console.log('\n[1] Constants...');
assert('BULLISH_DETECTOR_TYPES 4 个', BULLISH_DETECTOR_TYPES.length === 4);
assert('BULLISH_DETECTOR_LABELS 4 key', Object.keys(BULLISH_DETECTOR_LABELS).length === 4);
assert('POSITIVE_NEWS_KEYWORDS 非空 frozen', Object.isFrozen(POSITIVE_NEWS_KEYWORDS) && POSITIVE_NEWS_KEYWORDS.length > 0);
assert('NEGATIVE_NEWS_KEYWORDS 非空 frozen', Object.isFrozen(NEGATIVE_NEWS_KEYWORDS) && NEGATIVE_NEWS_KEYWORDS.length > 0);
assert('STRONG_POSITIVE_KEYWORDS 非空 frozen', Object.isFrozen(STRONG_POSITIVE_KEYWORDS) && STRONG_POSITIVE_KEYWORDS.length > 0);

// ---------------------------------------------------------------------------
// [2] Pure helpers
// ---------------------------------------------------------------------------
console.log('\n[2] Pure helpers...');
assertEqual('mean 空', mean([]), 0);
assertEqual('mean 单值', mean([5]), 5);
assertEqual('mean 多值', mean([1, 2, 3, 4, 5]), 3);
assertEqual('stdev 空', stdev([]), 0);
assertEqual('stdev 单值', stdev([5]), 0);
assert('stdev 多值 > 0', stdev([1, 2, 3, 4, 5]) > 1);
assertEqual('toBareCode 纯 6 位', toBareCode('600519'), '600519');
assertEqual('toBareCode sh.', toBareCode('sh.600519'), '600519');
assertEqual('toBareCode sh', toBareCode('sh600519'), '600519');
assertEqual('toBareCode sz.', toBareCode('sz.000001'), '000001');
assertEqual('toBareCode 空', toBareCode(''), '');
assertEqual('toBareCode 非法', toBareCode('abc'), 'abc');

const now1 = new Date(2026, 5, 29); // 月份从 0 起
assertEqual(
  'buildDedupKey 格式',
  buildDedupKey('600519', 'critical_announcement', now1),
  '600519:critical_announcement:2026-06-29'
);

assertEqual(
  'appendDedupTag 末尾',
  appendDedupTag('msg', 'k1'),
  'msg\n\n[dedup_key:k1]'
);

// ---------------------------------------------------------------------------
// [3] scoreNewsTitle
// ---------------------------------------------------------------------------
console.log('\n[3] scoreNewsTitle...');
assertEqual('空 title → 0', scoreNewsTitle(''), 0);
assert('强多 "业绩预增" >= 0.6', scoreNewsTitle('华工科技业绩预增 50%') >= 0.6);
assert('强多 "中标" >= 0.6', scoreNewsTitle('华工科技中标 10 亿订单') >= 0.6);
assert('单弱多关键词 = 0.4', Math.abs(scoreNewsTitle('华工科技获奖') - 0.4) < 0.01);
assert('双弱多关键词 >= 0.5', scoreNewsTitle('华工科技获奖, 创新高') >= 0.5);
assertEqual('全中性 → 0', scoreNewsTitle('华工科技发布日常公告'), 0);
assertEqual('负面词强压 (即使含正面)', scoreNewsTitle('业绩预亏, 同时中标项目'), 0);
assertEqual('纯负面 → 0', scoreNewsTitle('华工科技亏损扩大'), 0);

// ---------------------------------------------------------------------------
// [4] detectCriticalAnnouncementHits
// ---------------------------------------------------------------------------
console.log('\n[4] detectCriticalAnnouncementHits...');

const annNames = new Map<string, string>([
  ['000988', '华工科技'],
  ['600519', '贵州茅台'],
]);

const annCritPositive: AnnouncementRow = {
  announce_date: '2026-06-28',
  stock_code: '000988',
  stock_name: '华工科技',
  original_title: '关于子公司中标 8 亿元订单的公告',
  summary: '公司子公司中标 8 亿元订单, 涉及光通信业务',
  sentiment: '正面',
  priority: 'critical',
  event_type: '业绩',
  url: 'https://example.com/p.pdf',
};
const annCritNegative: AnnouncementRow = { ...annCritPositive, stock_code: '600519', stock_name: '贵州茅台', sentiment: '负面' };
const annCritNeutral: AnnouncementRow = { ...annCritPositive, stock_code: '600600', stock_name: '青岛啤酒', sentiment: '中性' };
const annCritPunish: AnnouncementRow = { ...annCritPositive, stock_code: '300290', stock_name: '荣科科技', sentiment: '正面', event_type: '处罚' };
const annHigh: AnnouncementRow = { ...annCritPositive, stock_code: '600519', priority: 'high' };

const annHits = detectCriticalAnnouncementHits(
  [annCritPositive, annCritNegative, annCritNeutral, annCritPunish, annHigh],
  annNames
);
assertEqual('critical 公告 — STRICT: 只命中 sentiment=正面 + 非利空 event_type', annHits.length, 1);
assertEqual('critical 公告 — stock_code', annHits[0].stock_code, '000988');
assertEqual('critical 公告 — detector', annHits[0].detector, 'critical_announcement');
assertEqual('critical 公告 — score=80', annHits[0].score, 80);

assertEqual('critical 公告 — 空入', detectCriticalAnnouncementHits([], annNames).length, 0);
assertEqual('critical 公告 — null defense', detectCriticalAnnouncementHits(null as any, annNames).length, 0);

// ---------------------------------------------------------------------------
// [5] detectPositiveNewsHits
// ---------------------------------------------------------------------------
console.log('\n[5] detectPositiveNewsHits...');

const newsRows: NewsRow[] = [
  {
    title_hash: 'h1',
    publish_time: new Date('2026-06-28T10:00:00+08:00'),
    title: '华工科技中标 10 亿订单, 业绩预增',
    content: null,
    source: 'cls',
    url: 'https://news/1',
  },
  {
    title_hash: 'h2',
    publish_time: new Date('2026-06-28T11:00:00+08:00'),
    title: '华工科技正常生产, 无新进展',
    content: null,
    source: 'em',
    url: null,
  },
  {
    title_hash: 'h3',
    publish_time: new Date('2026-06-28T12:00:00+08:00'),
    title: '贵州茅台业绩超预期大增',
    content: null,
    source: 'em',
    url: null,
  },
  {
    title_hash: 'h4',
    publish_time: new Date('2026-06-28T13:00:00+08:00'),
    title: '某未知股票获批新业务', // 不在 names map → 不应命中
    content: null,
    source: 'em',
    url: null,
  },
];
const newsHits = detectPositiveNewsHits(newsRows, annNames);
assertEqual('positive_news — 命中 2 条 (h1 + h3)', newsHits.length, 2);
const codes = newsHits.map(h => h.stock_code).sort();
assertEqual('positive_news — stock_code 集合', codes, ['000988', '600519']);
assertEqual('positive_news — detector', newsHits[0].detector, 'positive_news');
assertEqual('positive_news — 空入', detectPositiveNewsHits([], annNames).length, 0);
assertEqual(
  'positive_news — names map 空 → 不命中',
  detectPositiveNewsHits(newsRows, new Map()).length,
  0
);

// ---------------------------------------------------------------------------
// [6] detectAttentionSpikeHits
// ---------------------------------------------------------------------------
console.log('\n[6] detectAttentionSpikeHits...');

function makeSentimentRows(
  stock_code: string,
  countsByDate: Array<{ date: string; count: number | null }>
): SentimentDailyRow[] {
  return countsByDate.map(({ date, count }) => ({
    stock_code,
    trade_date: date,
    post_count: count,
    rank: 100,
    heat_score: null,
  }));
}

// Spike: 近 7 日 [100, 100, 100, 100, 100, 100, 100] → mean=100 std=0
// today=300 > 100 + 3*0 = 100 AND > 100*1.5 = 150 → 命中
const spikeRows = makeSentimentRows('000988', [
  { date: '2026-06-21', count: 100 },
  { date: '2026-06-22', count: 100 },
  { date: '2026-06-23', count: 100 },
  { date: '2026-06-24', count: 100 },
  { date: '2026-06-25', count: 100 },
  { date: '2026-06-26', count: 100 },
  { date: '2026-06-27', count: 100 },
  { date: '2026-06-28', count: 300 }, // today, spike
]);
const spikeHits = detectAttentionSpikeHits(spikeRows, annNames);
assertEqual('attention_spike — 3x spike 命中', spikeHits.length, 1);
assertEqual('attention_spike — stock_code', spikeHits[0].stock_code, '000988');
assertEqual('attention_spike — detector', spikeHits[0].detector, 'attention_spike');

// 不命中: today=120, 1.2x baseline mean (< 1.5x阈值)
const noSpike = makeSentimentRows('000988', [
  { date: '2026-06-21', count: 100 },
  { date: '2026-06-22', count: 100 },
  { date: '2026-06-23', count: 100 },
  { date: '2026-06-28', count: 120 },
]);
const noSpikeHits = detectAttentionSpikeHits(noSpike, annNames);
assertEqual('attention_spike — < 1.5x 不命中', noSpikeHits.length, 0);

// 不命中: 不足 4 个样本
const tooFew = makeSentimentRows('000988', [
  { date: '2026-06-27', count: 100 },
  { date: '2026-06-28', count: 300 },
]);
assertEqual('attention_spike — 样本不足 4 不命中', detectAttentionSpikeHits(tooFew, annNames).length, 0);

// null defense
const nullCounts = makeSentimentRows('000988', [
  { date: '2026-06-21', count: null },
  { date: '2026-06-22', count: null },
  { date: '2026-06-23', count: null },
  { date: '2026-06-28', count: 300 },
]);
assertEqual('attention_spike — baseline 全 null 不命中', detectAttentionSpikeHits(nullCounts, annNames).length, 0);

assertEqual('attention_spike — 空入', detectAttentionSpikeHits([], annNames).length, 0);

// ---------------------------------------------------------------------------
// [7] detectKolConsensusHits
// ---------------------------------------------------------------------------
console.log('\n[7] detectKolConsensusHits...');

function makeKolOpinion(
  stock_code: string,
  kol_name: string,
  sentiment_score: number | null,
  kol_source = 'research_report'
): KolOpinionRow {
  return {
    stock_code,
    kol_name,
    opinion_date: '2026-06-28',
    kol_source,
    opinion_summary: `${kol_name} 看多 ${stock_code}`,
    sentiment_score,
  };
}

// 3 distinct KOL avg = 0.7 → 命中
const kolBull: KolOpinionRow[] = [
  makeKolOpinion('000988', '中信证券', 0.6),
  makeKolOpinion('000988', '诚通证券', 0.8, 'east_money_news'),
  makeKolOpinion('000988', '财联社', 0.7, 'east_money_news'),
];
const kolBullHits = detectKolConsensusHits(kolBull, annNames);
assertEqual('kol_consensus — 3 KOL + avg=0.7 命中', kolBullHits.length, 1);
assertEqual('kol_consensus — stock_code', kolBullHits[0].stock_code, '000988');
assertEqual('kol_consensus — detector', kolBullHits[0].detector, 'kol_consensus');

// 2 KOL → 不命中 (< 3)
const tooFewKol: KolOpinionRow[] = [
  makeKolOpinion('000988', 'KOL_A', 0.8),
  makeKolOpinion('000988', 'KOL_B', 0.7),
];
assertEqual('kol_consensus — < 3 KOL 不命中', detectKolConsensusHits(tooFewKol, annNames).length, 0);

// 3 KOL avg=0.2 → 不命中 (< 0.3)
const lowSenti: KolOpinionRow[] = [
  makeKolOpinion('000988', 'A', 0.1),
  makeKolOpinion('000988', 'B', 0.2),
  makeKolOpinion('000988', 'C', 0.3),
];
assertEqual('kol_consensus — avg < 0.3 不命中', detectKolConsensusHits(lowSenti, annNames).length, 0);

// 同 KOL 3 次 → 不命中 (distinct < 3)
const sameKol: KolOpinionRow[] = [
  makeKolOpinion('000988', 'A', 0.8),
  makeKolOpinion('000988', 'A', 0.7),
  makeKolOpinion('000988', 'A', 0.9),
];
assertEqual('kol_consensus — 同 KOL distinct=1 不命中', detectKolConsensusHits(sameKol, annNames).length, 0);

assertEqual('kol_consensus — 空入', detectKolConsensusHits([], annNames).length, 0);

// ---------------------------------------------------------------------------
// [8] runOnce e2e: empty universe
// ---------------------------------------------------------------------------
async function testEmptyUniverse(): Promise<void> {
  console.log('\n[8] runOnce e2e — empty universe...');
  const { ds, calls } = makeFakeDS({});
  const svc = new BullishEventDetectorService({ dataSource: ds });
  const r = await svc.runOnce();
  assertEqual('empty universe — scanned=0', r.scanned, 0);
  assertEqual('empty universe — detected=0', r.detected, 0);
  assertEqual('empty universe — pushed=0', r.pushed, 0);
  assertEqual('empty universe — ok', r.ok, true);
  assertEqual('empty universe — writeRiskAlerts 0 calls', calls.writeRiskAlerts.length, 0);
}

// ---------------------------------------------------------------------------
// [9] runOnce e2e: all 4 detectors hit + push
// ---------------------------------------------------------------------------
async function testAllDetectorHit(): Promise<void> {
  console.log('\n[9] runOnce e2e — 4 detector 全命中 + push...');
  const fakePushes: any[] = [];
  const { ds, calls } = makeFakeDS({
    positions: ['sh.600519'],
    favorites: ['sz.000988'],
    aiRecommended: [],
    stockNames: { '600519': '贵州茅台', '000988': '华工科技' },
    announcements: [
      { ...annCritPositive, stock_code: '000988' },
    ],
    news: newsRows,
    sentiments: spikeRows,
    kolOpinions: kolBull,
    activeUserIds: [1, 2],
  });
  const svc = new BullishEventDetectorService({
    dataSource: ds,
    feishu_push: async (input) => {
      fakePushes.push(input);
      return { pushed: true };
    },
  });
  const r = await svc.runOnce();
  assert('全命中 — scanned >= 2', r.scanned >= 2);
  assert('全命中 — detected >= 4', r.detected >= 4);
  assert('全命中 — pushed >= 4', r.pushed >= 4);
  assertEqual('全命中 — critical_announcement 计数 1', r.by_detector.critical_announcement, 1);
  assert('全命中 — positive_news 计数 >= 2', r.by_detector.positive_news >= 2);
  assertEqual('全命中 — attention_spike 计数 1', r.by_detector.attention_spike, 1);
  assertEqual('全命中 — kol_consensus 计数 1', r.by_detector.kol_consensus, 1);
  assert('全命中 — writeRiskAlerts >= 4', calls.writeRiskAlerts.length >= 4);
  assert('全命中 — feishu push >= 4', fakePushes.length >= 4);
  assertEqual('全命中 — errors 空', r.errors.length, 0);
  // RiskAlert 写入正确 level + rule_id + dedup_tag
  for (const c of calls.writeRiskAlerts) {
    assertEqual('write — level=MEDIUM', c.level, 'MEDIUM');
    assertEqual('write — rule_id=stock_bullish_event', c.rule_id, 'stock_bullish_event');
    assert('write — message 含 dedup_key tag', /\[dedup_key:[^\]]+\]/.test(c.message));
    assertEqual('write — user_ids = active users', c.user_ids, [1, 2]);
  }
  // PR-H — writeIntradaySignal 每命中也调一次 (与 RiskAlert 1:1, 让前端推荐流能识别 ⚡ 盘中异动)
  assert(
    'PR-H — writeIntradaySignal 调用次数 == pushed 数',
    calls.writeIntradaySignal.length === r.pushed
  );
  for (const c of calls.writeIntradaySignal) {
    assert('PR-H — writeIntradaySignal symbol 是 6 位', /^\d{6}$/.test(c.symbol));
    assert('PR-H — writeIntradaySignal prefixed_symbol 是 sh\\./sz\\. 前缀', /^(sh|sz)\.\d{6}$/.test(c.prefixed_symbol));
    assert('PR-H — writeIntradaySignal score 在 [0,100]', c.score >= 0 && c.score <= 100);
    assert('PR-H — writeIntradaySignal signal_date YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(c.signal_date));
    assert('PR-H — writeIntradaySignal detector 非空', typeof c.detector === 'string' && c.detector.length > 0);
  }
}

// ---------------------------------------------------------------------------
// [10] runOnce e2e: dedup
// ---------------------------------------------------------------------------
async function testDedup(): Promise<void> {
  console.log('\n[10] runOnce e2e — dedup...');
  const fakePushes: any[] = [];
  const now2 = new Date(2026, 5, 28);
  const dedup1 = buildDedupKey('000988', 'critical_announcement', now2);
  const { ds, calls } = makeFakeDS({
    positions: ['sz.000988'],
    stockNames: { '000988': '华工科技' },
    announcements: [{ ...annCritPositive, stock_code: '000988' }],
    activeUserIds: [1],
    dedupKeys: [dedup1], // 已被推过
  });
  const svc = new BullishEventDetectorService({
    dataSource: ds,
    feishu_push: async (input) => {
      fakePushes.push(input);
      return { pushed: true };
    },
  });
  const r = await svc.runOnce({ now: now2 });
  assertEqual('dedup — detected=1', r.detected, 1);
  assertEqual('dedup — pushed=0 (被 dedup)', r.pushed, 0);
  assertEqual('dedup — deduped=1', r.deduped, 1);
  assertEqual('dedup — 0 writeRiskAlerts', calls.writeRiskAlerts.length, 0);
  assertEqual('dedup — 0 feishu push', fakePushes.length, 0);
}

// ---------------------------------------------------------------------------
// [11] runOnce e2e: dry_run
// ---------------------------------------------------------------------------
async function testDryRun(): Promise<void> {
  console.log('\n[11] runOnce e2e — dry_run...');
  const fakePushes: any[] = [];
  const { ds, calls } = makeFakeDS({
    positions: ['sz.000988'],
    stockNames: { '000988': '华工科技' },
    announcements: [{ ...annCritPositive, stock_code: '000988' }],
    activeUserIds: [1, 2],
  });
  const svc = new BullishEventDetectorService({
    dataSource: ds,
    feishu_push: async (input) => {
      fakePushes.push(input);
      return { pushed: true };
    },
  });
  const r = await svc.runOnce({ dry_run: true });
  assertEqual('dry_run — detected=1', r.detected, 1);
  assertEqual('dry_run — pushed=1 (计数但不真写)', r.pushed, 1);
  assertEqual('dry_run — dry_run flag', r.dry_run, true);
  assertEqual('dry_run — 0 writeRiskAlerts (dry_run)', calls.writeRiskAlerts.length, 0);
  assertEqual('dry_run — 0 feishu push (dry_run)', fakePushes.length, 0);
}

// ---------------------------------------------------------------------------
// [12] runOnce e2e: 单 detector throw → 其它仍跑
// ---------------------------------------------------------------------------
async function testSingleDetectorThrow(): Promise<void> {
  console.log('\n[12] runOnce e2e — 单 detector throw, 其它仍跑...');
  const { ds, calls } = makeFakeDS({
    positions: ['sz.000988'],
    stockNames: { '000988': '华工科技' },
    announcements: [{ ...annCritPositive, stock_code: '000988' }],
    activeUserIds: [1],
    throws: { listRecentNews: 'news db down' },
  });
  const fakePushes: any[] = [];
  const svc = new BullishEventDetectorService({
    dataSource: ds,
    feishu_push: async (input) => {
      fakePushes.push(input);
      return { pushed: true };
    },
  });
  const r = await svc.runOnce();
  assertEqual('detector throw — by_detector.critical_announcement=1', r.by_detector.critical_announcement, 1);
  assertEqual('detector throw — by_detector.positive_news=0', r.by_detector.positive_news, 0);
  assertEqual('detector throw — pushed=1 (critical 仍推)', r.pushed, 1);
  assert('detector throw — errors 含 positive_news', r.errors.some(e => e.where === 'positive_news'));
}

// ---------------------------------------------------------------------------
// [13] runOnce e2e: 同 stock 同 detector 同次 run dedup
// ---------------------------------------------------------------------------
async function testIntraRunDedup(): Promise<void> {
  console.log('\n[13] runOnce e2e — 同次 run 内同 stock+detector dedup...');
  // 同股 2 条 critical 公告
  const { ds, calls } = makeFakeDS({
    positions: ['sz.000988'],
    stockNames: { '000988': '华工科技' },
    announcements: [
      { ...annCritPositive, stock_code: '000988', original_title: '第一条' },
      { ...annCritPositive, stock_code: '000988', original_title: '第二条' },
    ],
    activeUserIds: [1],
  });
  const fakePushes: any[] = [];
  const svc = new BullishEventDetectorService({
    dataSource: ds,
    feishu_push: async (input) => {
      fakePushes.push(input);
      return { pushed: true };
    },
  });
  const r = await svc.runOnce();
  assertEqual('intra-run dedup — detected=2', r.detected, 2);
  assertEqual('intra-run dedup — pushed=1 (第二条 dedup)', r.pushed, 1);
  assertEqual('intra-run dedup — deduped=1', r.deduped, 1);
  assertEqual('intra-run dedup — writeRiskAlerts 1 call', calls.writeRiskAlerts.length, 1);
}

// ---------------------------------------------------------------------------
// [14] buildOpsBullishCardBody
// ---------------------------------------------------------------------------
console.log('\n[14] buildOpsBullishCardBody...');
const cardBody = buildOpsBullishCardBody({
  stock_code: '000988',
  stock_name: '华工科技',
  detector: 'critical_announcement',
  detector_label: BULLISH_DETECTOR_LABELS.critical_announcement,
  reason: 'test reason',
  score: 80,
  source_payload: { url: 'https://example.com' },
});
assert('card body 含 stock_code', cardBody.includes('000988'));
assert('card body 含 stock_name', cardBody.includes('华工科技'));
assert('card body 含 detector_label', cardBody.includes('critical 利好公告'));
assert('card body 含 score', cardBody.includes('80'));
assert('card body 含 reason', cardBody.includes('test reason'));
assert('card body 含 url', cardBody.includes('https://example.com'));

// ---------------------------------------------------------------------------
// Run async tests
// ---------------------------------------------------------------------------
(async () => {
  await testEmptyUniverse();
  await testAllDetectorHit();
  await testDedup();
  await testDryRun();
  await testSingleDetectorThrow();
  await testIntraRunDedup();

  console.log(`\n[bullish-event-detector-service] ${ok} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
  process.exit(0);
})();
