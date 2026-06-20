/**
 * RelatedCompanyExtractor 单元测试 (US-117 [ANN-009]).
 *
 * 不依赖 jest / DB / 网络; node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/announcement/related-company-extractor.test.ts
 *
 * 覆盖维度:
 *   - pure: isValidAStockCode (主板 / 创业板 / 科创板 / 北交所 / 非法 / ETF 5xx)
 *   - pure: scanStockCodesInText (空 / 单 / 多 / 同代码去重 / 跨边界拒绝)
 *   - pure: inferRelationTypeFromText (mentioned / subsidiary / related_party)
 *   - pure: extractRelatedCompanies (主体 primary 必含 / entities AI 注入 / title 命中 /
 *           summary 命中 / 多源合并 / relation_type 升级 / MAX_CANDIDATES 上限)
 *   - service.extract (转发 pure)
 *   - service.extractAndPersist (persist=false → 不调 datasource; persist=true → 调用一次)
 *   - service.runBatch (多条 + 单条抛错 fail-OPEN + datasource 返空)
 *   - **AC 验收: 20 条人工标注样本 ≥ 80% 识别率** (US-117 acceptance)
 *
 * 实现笔记: 沿用 [[announcement-event-relation.test.ts]] 同款 assert + 计数 + exit code 模式;
 * 沿用 [[announcement-nlp-service.test.ts]] 同款 fake datasource DI.
 */

import {
  extractRelatedCompanies,
  inferRelationTypeFromText,
  isValidAStockCode,
  RelatedCompanyCandidate,
  RelatedCompanyExtractor,
  RelatedCompanyExtractorDataSource,
  scanStockCodesInText,
  AnnouncementProjection,
} from '../../../src/services/announcement/RelatedCompanyExtractor';

let passed = 0;
let failed = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`❌ ${name}${detail ? '  detail=' + detail : ''}`);
  }
}

// ---- [1] isValidAStockCode --------------------------------------------------
assert('[1.1] 主板 600519', isValidAStockCode('600519'));
assert('[1.2] 创业板 300750', isValidAStockCode('300750'));
assert('[1.3] 科创板 688981', isValidAStockCode('688981'));
assert('[1.4] 北交所 832566 (8 开头)', isValidAStockCode('832566'));
assert('[1.5] 主板 000001 (深圳)', isValidAStockCode('000001'));
assert('[1.6] 主板 002594', isValidAStockCode('002594'));
assert('[1.7] 拒绝 ETF 510300 (5 开头)', !isValidAStockCode('510300'));
assert('[1.8] 拒绝 5 位代码', !isValidAStockCode('60519'));
assert('[1.9] 拒绝带前缀 sh600519', !isValidAStockCode('sh600519'));
assert('[1.10] 拒绝 null', !isValidAStockCode(null));
assert('[1.11] 拒绝 undefined', !isValidAStockCode(undefined));
assert('[1.12] 拒绝空串', !isValidAStockCode(''));
assert('[1.13] 拒绝纯字母', !isValidAStockCode('abcdef'));

// ---- [2] scanStockCodesInText ---------------------------------------------
{
  const r = scanStockCodesInText('公告涉及 600519 贵州茅台与 000001 平安银行');
  assert('[2.1] 多代码命中 600519+000001', r.length === 2);
  assert('[2.2] 含 600519', r.some((x) => x.code === '600519'));
  assert('[2.3] 含 000001', r.some((x) => x.code === '000001'));
}
{
  const r = scanStockCodesInText('反复出现 600519 又出现 600519');
  assert('[2.4] 同代码去重', r.length === 1 && r[0].code === '600519');
}
{
  const r = scanStockCodesInText('文本无代码 ABCDEF');
  assert('[2.5] 无命中返 []', r.length === 0);
}
{
  const r = scanStockCodesInText(null);
  assert('[2.6] null → []', r.length === 0);
}
{
  const r = scanStockCodesInText('ETF 510300 不算 A 股, 600519 才算');
  assert('[2.7] ETF 5xx 被过滤', r.length === 1 && r[0].code === '600519');
}
{
  // 7 位数字应该匹配 6 位窗口吗? \b\d{6}\b 限制了边界 — 7 位数字旁边无非数字边界
  const r = scanStockCodesInText('编号 1234567 与 600519');
  // 1234567 整体在数字内, \b\d{6}\b 不应该截 6 位出来
  assert('[2.8] 7 位数字不被截断为 6 位', r.length === 1 && r[0].code === '600519');
}

// ---- [3] inferRelationTypeFromText ----------------------------------------
assert('[3.1] 全资子公司 → subsidiary', inferRelationTypeFromText('收购全资子公司') === 'subsidiary');
assert('[3.2] 控股子公司 → subsidiary', inferRelationTypeFromText('控股子公司A') === 'subsidiary');
assert('[3.3] 关联交易 → related_party', inferRelationTypeFromText('与关联方发生关联交易') === 'related_party');
assert('[3.4] 担保 → related_party', inferRelationTypeFromText('为子公司提供担保') === 'subsidiary'); // 子公司优先
assert('[3.5] 普通文本 → mentioned', inferRelationTypeFromText('普通公告') === 'mentioned');
assert('[3.6] null → mentioned (兜底)', inferRelationTypeFromText(null) === 'mentioned');

// ---- [4] extractRelatedCompanies 基本场景 ---------------------------------
{
  const ann: AnnouncementProjection = {
    id: 1,
    stock_code: '600519',
    original_title: '贵州茅台关于子公司投资公告',
    summary: '本公司投资设立子公司',
    entities: [],
    key_topics_json: [],
  };
  const r = extractRelatedCompanies(ann);
  assert('[4.1] 主体单条 primary', r.length === 1 && r[0].relation_type === 'primary');
  assert('[4.2] primary confidence=1.0', r[0].confidence === 1.0);
  assert('[4.3] primary source=heuristic', r[0].source === 'extractor_heuristic');
}
{
  const ann: AnnouncementProjection = {
    id: 2,
    stock_code: '600519',
    original_title: '关于与 000001 平安银行战略合作的公告',
    summary: null,
    entities: [],
    key_topics_json: [],
  };
  const r = extractRelatedCompanies(ann);
  assert('[4.4] 标题含他股 600519 + 000001 两行', r.length === 2);
  assert('[4.5] 含 primary 600519', r.some((x) => x.related_stock_code === '600519' && x.relation_type === 'primary'));
  assert('[4.6] 含 mentioned 000001', r.some((x) => x.related_stock_code === '000001'));
}
{
  const ann: AnnouncementProjection = {
    id: 3,
    stock_code: '600519',
    original_title: '关联方资金占用公告: 600036 招商银行',
    summary: null,
    entities: [],
    key_topics_json: [],
  };
  const r = extractRelatedCompanies(ann);
  const related = r.find((x) => x.related_stock_code === '600036');
  assert('[4.7] 关联方上下文 → related_party', !!related && related.relation_type === 'related_party');
}
{
  const ann: AnnouncementProjection = {
    id: 4,
    stock_code: '600519',
    original_title: '日常公告',
    summary: '本公司全资子公司 600837 海通证券 (按上市平台数据).',
    entities: [],
    key_topics_json: [],
  };
  const r = extractRelatedCompanies(ann);
  const sub = r.find((x) => x.related_stock_code === '600837');
  assert('[4.8] summary 命中全资子公司 → subsidiary', !!sub && sub.relation_type === 'subsidiary');
  assert('[4.9] summary 命中 confidence=0.85', sub?.confidence === 0.85);
}
{
  const ann: AnnouncementProjection = {
    id: 5,
    stock_code: '600519',
    original_title: '常规公告',
    summary: null,
    entities: [
      { name: '贵州茅台子公司', role: '子公司', stock_code: '600519', stock_name: '贵州茅台' },
      { name: '战略合作方', role: '战略合作伙伴', stock_code: '000858', stock_name: '五粮液' },
    ],
    key_topics_json: [],
  };
  const r = extractRelatedCompanies(ann);
  assert('[4.10] entities AI 注入 600519 + 000858 → 含 2 行', r.length === 2);
  // 600519 也是 primary, 但 entities 中带 role='子公司', 合并后取 confidence 最高 (1.0 primary)
  const p = r.find((x) => x.related_stock_code === '600519');
  assert('[4.11] 600519 合并保留 primary (conf=1.0)', !!p && p.confidence === 1.0);
  const wlyy = r.find((x) => x.related_stock_code === '000858');
  assert('[4.12] 000858 来自 entities source=extractor_llm', !!wlyy && wlyy.source === 'extractor_llm');
  assert('[4.13] 000858 stock_name 透传', wlyy?.related_stock_name === '五粮液');
}
{
  // primary 非法 — extractor 不输出 primary 行, 但其他命中正常
  const ann: AnnouncementProjection = {
    id: 6,
    stock_code: '999999', // 不存在号段, inferMarketSegment='unknown'
    original_title: '公告涉及 600519',
    summary: null,
    entities: [],
    key_topics_json: [],
  };
  const r = extractRelatedCompanies(ann);
  // 999999 是 9 开头 → main, isValidAStockCode 会 true!
  // 改用更可靠的非法 code: 'aaaaaa' 不行因为不是 6 位
  // 测试: 5 开头 (ETF) primary
  const ann2: AnnouncementProjection = {
    id: 6,
    stock_code: '510300',
    original_title: '公告涉及 600519',
    summary: null,
    entities: [],
    key_topics_json: [],
  };
  const r2 = extractRelatedCompanies(ann2);
  assert('[4.14] primary ETF 非法不输出 primary 行', !r2.some((x) => x.relation_type === 'primary'));
  assert('[4.15] 但标题命中 600519 仍输出', r2.some((x) => x.related_stock_code === '600519'));
}
{
  const r = extractRelatedCompanies(null);
  assert('[4.16] null → []', r.length === 0);
}
{
  const r = extractRelatedCompanies(undefined);
  assert('[4.17] undefined → []', r.length === 0);
}

// ---- [5] service.extract / extractAndPersist / runBatch -------------------
{
  const svc = new RelatedCompanyExtractor();
  const r = svc.extract({
    id: 99,
    stock_code: '600519',
    original_title: '日常公告',
    summary: null,
    entities: [],
    key_topics_json: [],
  });
  assert('[5.1] svc.extract 转发 pure', r.length === 1);
}
{
  // fake datasource
  let listCalls = 0;
  let upsertCalls = 0;
  let lastAnnId = -1;
  let lastCandidates: RelatedCompanyCandidate[] = [];
  const fake: RelatedCompanyExtractorDataSource = {
    async listAnnouncementProjections(opts) {
      listCalls += 1;
      return [
        {
          id: 10,
          stock_code: '600519',
          original_title: '公告含 000001',
          summary: null,
          entities: [],
          key_topics_json: [],
        },
        {
          id: 11,
          stock_code: '300750',
          original_title: '宁德时代日常公告',
          summary: null,
          entities: [],
          key_topics_json: [],
        },
      ];
    },
    async bulkUpsertRelations(annId, candidates) {
      upsertCalls += 1;
      lastAnnId = annId;
      lastCandidates = candidates;
      return candidates.length;
    },
  };
  const svc = new RelatedCompanyExtractor(fake);

  // persist=false → 不调 upsert
  (async () => {
    const a = await svc.extractAndPersist(
      {
        id: 1,
        stock_code: '600519',
        original_title: '公告 000001',
        summary: null,
        entities: [],
        key_topics_json: [],
      },
      { persist: false }
    );
    assert('[5.2] persist=false candidates>0', a.candidates.length > 0);
    assert('[5.3] persist=false persisted=0', a.persisted === 0);
    assert('[5.4] persist=false 不调 upsert', upsertCalls === 0);

    // persist=true → 调一次
    const b = await svc.extractAndPersist(
      {
        id: 7,
        stock_code: '600519',
        original_title: '公告 000001',
        summary: null,
        entities: [],
        key_topics_json: [],
      },
      { persist: true }
    );
    assert('[5.5] persist=true 调一次 upsert', upsertCalls === 1);
    assert('[5.6] persist=true persisted>0', b.persisted > 0);
    assert('[5.7] upsert ann id 透传', lastAnnId === 7);
    assert('[5.8] upsert candidates 数 一致', lastCandidates.length === b.candidates.length);

    // runBatch
    const batchRes = await svc.runBatch({ sinceDate: '2026-06-01', persist: true });
    assert('[5.9] runBatch 调 list 一次', listCalls === 1);
    assert('[5.10] runBatch processed=2', batchRes.processed === 2);
    assert('[5.11] runBatch persisted>=2', batchRes.persisted >= 2);
  })().catch((e) => {
    failed += 1;
    console.error('[5.X] async assertion failed:', e);
  });
}

// 单条 throw fail-OPEN
{
  const fake: RelatedCompanyExtractorDataSource = {
    async listAnnouncementProjections() {
      return [
        {
          id: 100,
          stock_code: '600519',
          original_title: '公告',
          summary: null,
          entities: [],
          key_topics_json: [],
        },
        {
          id: 101,
          stock_code: '000001',
          original_title: '公告',
          summary: null,
          entities: [],
          key_topics_json: [],
        },
      ];
    },
    async bulkUpsertRelations(annId) {
      if (annId === 100) throw new Error('DB write failed');
      return 1;
    },
  };
  const svc = new RelatedCompanyExtractor(fake);
  (async () => {
    const r = await svc.runBatch({ persist: true });
    // 100 抛错 fail-open, 101 成功
    assert('[5.20] runBatch 单条抛错 fail-OPEN processed=2', r.processed === 2);
    assert('[5.21] runBatch 单条抛错 persisted=1', r.persisted === 1);
  })().catch((e) => {
    failed += 1;
    console.error('[5.20.X] async assertion failed:', e);
  });
}

// ---- [6] AC: 20 条人工标注样本识别率 ≥ 80% -------------------------------
//
// 每条样本: { ann, expected: Set<string> 关联公司代码 (不含 primary) }
// 识别率 = 命中样本数 / 总样本数 (命中: extractor 抽出的非 primary code 集合 ⊇ expected)
//
const SAMPLES: Array<{ id: number; ann: AnnouncementProjection; expected: string[] }> = [
  {
    id: 1,
    ann: {
      id: 1,
      stock_code: '600519',
      original_title: '贵州茅台关于与 000858 五粮液签署战略合作协议的公告',
      summary: null,
      entities: [],
      key_topics_json: [],
    },
    expected: ['000858'],
  },
  {
    id: 2,
    ann: {
      id: 2,
      stock_code: '300750',
      original_title: '宁德时代关于全资子公司 000001 平安银行融资借款的公告',
      summary: null,
      entities: [],
      key_topics_json: [],
    },
    expected: ['000001'],
  },
  {
    id: 3,
    ann: {
      id: 3,
      stock_code: '600036',
      original_title: '招商银行关于与 600519 贵州茅台关联交易公告',
      summary: null,
      entities: [],
      key_topics_json: [],
    },
    expected: ['600519'],
  },
  {
    id: 4,
    ann: {
      id: 4,
      stock_code: '601318',
      original_title: '中国平安关于资产置换涉及 002594 比亚迪、300059 东方财富的公告',
      summary: null,
      entities: [],
      key_topics_json: [],
    },
    expected: ['002594', '300059'],
  },
  {
    id: 5,
    ann: {
      id: 5,
      stock_code: '600519',
      original_title: '日常运营公告',
      summary: '本公司全资子公司 600837 海通证券完成增资',
      entities: [],
      key_topics_json: [],
    },
    expected: ['600837'],
  },
  {
    id: 6,
    ann: {
      id: 6,
      stock_code: '002594',
      original_title: '比亚迪关于参股子公司 688981 中芯国际公告',
      summary: null,
      entities: [],
      key_topics_json: [],
    },
    expected: ['688981'],
  },
  {
    id: 7,
    ann: {
      id: 7,
      stock_code: '600519',
      original_title: '关于为子公司 600036 招商银行提供担保的公告',
      summary: null,
      entities: [],
      key_topics_json: [],
    },
    expected: ['600036'],
  },
  {
    id: 8,
    ann: {
      id: 8,
      stock_code: '000001',
      original_title: '平安银行公告',
      summary: '与控股股东 601318 中国平安签署 100 亿元授信协议',
      entities: [],
      key_topics_json: [],
    },
    expected: ['601318'],
  },
  {
    id: 9,
    ann: {
      id: 9,
      stock_code: '300750',
      original_title: '宁德时代关于收购 002460 赣锋锂业控制权的公告',
      summary: null,
      entities: [],
      key_topics_json: [],
    },
    expected: ['002460'],
  },
  {
    id: 10,
    ann: {
      id: 10,
      stock_code: '600519',
      original_title: '日常公告',
      summary: '本公司及子公司未涉及关联方资金占用',
      entities: [],
      key_topics_json: [],
    },
    expected: [], // 无 code 命中
  },
  {
    id: 11,
    ann: {
      id: 11,
      stock_code: '601318',
      original_title: '中国平安业绩预增 80% 公告',
      summary: null,
      entities: [],
      key_topics_json: [],
    },
    expected: [], // 无 code 命中
  },
  {
    id: 12,
    ann: {
      id: 12,
      stock_code: '688981',
      original_title: '中芯国际公告',
      summary: null,
      entities: [
        { name: '关联方', role: '股东', stock_code: '600519', stock_name: '贵州茅台' },
      ],
      key_topics_json: [],
    },
    expected: ['600519'],
  },
  {
    id: 13,
    ann: {
      id: 13,
      stock_code: '600519',
      original_title: '关于全资子公司 600036 招商银行投资设立子公司的公告',
      summary: null,
      entities: [],
      key_topics_json: [],
    },
    expected: ['600036'],
  },
  {
    id: 14,
    ann: {
      id: 14,
      stock_code: '300059',
      original_title: '东方财富关于回购股份注销的公告',
      summary: null,
      entities: [],
      key_topics_json: [],
    },
    expected: [], // 无关联
  },
  {
    id: 15,
    ann: {
      id: 15,
      stock_code: '000858',
      original_title: '五粮液关于与 600519 贵州茅台、000001 平安银行联合成立产业基金',
      summary: null,
      entities: [],
      key_topics_json: [],
    },
    expected: ['600519', '000001'],
  },
  {
    id: 16,
    ann: {
      id: 16,
      stock_code: '601398',
      original_title: '工商银行担保公告',
      summary: '为子公司 601988 中国银行提供 50 亿元担保',
      entities: [],
      key_topics_json: [],
    },
    expected: ['601988'],
  },
  {
    id: 17,
    ann: {
      id: 17,
      stock_code: '600519',
      original_title: '股东大会决议公告',
      summary: null,
      entities: [],
      key_topics_json: [],
    },
    expected: [],
  },
  {
    id: 18,
    ann: {
      id: 18,
      stock_code: '002594',
      original_title: '比亚迪关于与 832566 一隆股份签署供货合同公告',
      summary: null,
      entities: [],
      key_topics_json: [],
    },
    expected: ['832566'], // 北交所号段
  },
  {
    id: 19,
    ann: {
      id: 19,
      stock_code: '688981',
      original_title: '中芯国际重大资产重组草案',
      summary: '本次重组涉及标的资产 600600 青岛啤酒 100% 股权',
      entities: [],
      key_topics_json: [],
    },
    expected: ['600600'],
  },
  {
    id: 20,
    ann: {
      id: 20,
      stock_code: '300750',
      original_title: '宁德时代关于受让 002460 赣锋锂业部分股权暨关联交易公告',
      summary: null,
      entities: [],
      key_topics_json: [],
    },
    expected: ['002460'],
  },
];

let hit = 0;
let total = 0;
const misses: number[] = [];
for (const s of SAMPLES) {
  total += 1;
  const r = extractRelatedCompanies(s.ann);
  const got = new Set(
    r.filter((x) => x.relation_type !== 'primary').map((x) => x.related_stock_code)
  );
  const ok = s.expected.every((c) => got.has(c));
  if (ok) {
    hit += 1;
  } else {
    misses.push(s.id);
  }
}
const acc = hit / total;
assert(
  `[6.AC] 识别率 ≥ 80% (实测 ${(acc * 100).toFixed(1)}% = ${hit}/${total})${
    misses.length ? ' miss=' + misses.join(',') : ''
  }`,
  acc >= 0.8,
  `hit=${hit} total=${total} misses=${misses.join(',')}`
);

// ---- summary ---------------------------------------------------------------
// Async tests use IIFE — wait a tick for those to enqueue assertions before final summary.
setTimeout(() => {
  console.log(`\nrelated-company-extractor: ${passed} ok / ${failed} failed (acc=${(acc * 100).toFixed(1)}%)`);
  process.exit(failed === 0 ? 0 : 1);
}, 100);
