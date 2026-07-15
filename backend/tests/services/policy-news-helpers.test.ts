/**
 * US-048 FactorWorkspace ETF + 政策 tab (FE-009) — policyNewsHelpers 单元测试.
 *
 * 不依赖 jest; 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/policy-news-helpers.test.ts
 *
 * 同 [[factor-ai-weight.test.ts]] / [[factor-combo-template.test.ts]] 模板:
 *   - 跨 monorepo import frontend helper (pure, 无 antd/react), ts-node 直吃
 *   - 内置 assert 框架 + process.exit
 *   - META-GUARD fs+regex 守 FactorWorkspace.tsx + 两个新 tab + helper export
 *
 * 覆盖维度:
 *   [1] 字典 sanity (POLICY_KEYWORDS frozen, POLICY_TOPIC_ORDER 与字典对齐)
 *   [2] isPolicyNews — null/undefined/空 + 命中各 topic + 干扰条 (生意快讯)
 *   [3] classifyPolicyTopic — 优先级 (同含 monetary + macro_signal → monetary 抢先) + matched_keywords
 *   [4] filterPolicyNews — 顺序保留 / null 防御 / 单行抛错被吞
 *   [5] countPolicyByTopic — 全 zero / 多 topic / 非法 row 吞
 *   [6] aggregateETFFlow — 累加 net_inflow / 取最新 AUM/NAV / 空行返 [] / 缺 etf_code 跳过
 *   [7] META-GUARD fs+regex
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  POLICY_KEYWORDS,
  POLICY_TOPIC_LABELS,
  POLICY_TOPIC_ORDER,
  PolicyTopic,
  PolicyNewsRow,
  MarketNewsRow,
  isPolicyNews,
  classifyPolicyTopic,
  filterPolicyNews,
  countPolicyByTopic,
} from '../../../frontend/src/pages/workspace/policyNewsHelpers';
import { aggregateETFFlow } from '../../../frontend/src/pages/workspace/etfFlowHelpers';

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

function mkNews(over: Partial<MarketNewsRow>): MarketNewsRow {
  return {
    title: over.title ?? '',
    content: over.content ?? null,
    publish_time: over.publish_time ?? '2026-06-19 10:00:00',
    source: over.source ?? 'cls',
    category: over.category ?? null,
    url: over.url ?? null,
  };
}

// ---- [1] 字典 sanity --------------------------------------------------------
assert('[1.1] POLICY_TOPIC_ORDER 长度 = 6', POLICY_TOPIC_ORDER.length === 6);
assert(
  '[1.2] POLICY_TOPIC_ORDER 6 个 topic 全在 POLICY_KEYWORDS',
  POLICY_TOPIC_ORDER.every(t => Array.isArray((POLICY_KEYWORDS as any)[t]))
);
assert(
  '[1.3] POLICY_TOPIC_LABELS 覆盖所有 topic',
  POLICY_TOPIC_ORDER.every(t => typeof POLICY_TOPIC_LABELS[t] === 'string' && POLICY_TOPIC_LABELS[t].length > 0)
);
assert('[1.4] POLICY_KEYWORDS 顶层 frozen', Object.isFrozen(POLICY_KEYWORDS));
assert(
  '[1.5] POLICY_KEYWORDS 各 topic 数组也 frozen (子层 Object.freeze)',
  POLICY_TOPIC_ORDER.every(t => Object.isFrozen(POLICY_KEYWORDS[t]))
);
assert(
  '[1.6] POLICY_TOPIC_LABELS frozen',
  Object.isFrozen(POLICY_TOPIC_LABELS)
);
// 优先级 sanity: monetary 必须在 macro_signal 之前 (避免 '人民银行降准' 误归 macro_signal)
assert(
  '[1.7] monetary 优先级 > macro_signal',
  POLICY_TOPIC_ORDER.indexOf('monetary') < POLICY_TOPIC_ORDER.indexOf('macro_signal')
);
assert(
  '[1.8] regulatory 优先级 > industry (证监会/银保监 vs 发改委/工信部)',
  POLICY_TOPIC_ORDER.indexOf('regulatory') < POLICY_TOPIC_ORDER.indexOf('industry')
);

// ---- [2] isPolicyNews -------------------------------------------------------
assert('[2.1] null → false', isPolicyNews(null) === false);
assert('[2.2] undefined → false', isPolicyNews(undefined) === false);
assert('[2.3] 空 title + 空 content → false', isPolicyNews(mkNews({ title: '', content: '' })) === false);
assert(
  '[2.4] 仅空白 → false',
  isPolicyNews(mkNews({ title: '   ', content: '   ' })) === false
);
assert(
  '[2.5] 命中 monetary (央行)',
  isPolicyNews(mkNews({ title: '央行决定下调存款准备金率 0.5 个百分点' })) === true
);
assert(
  '[2.6] 命中 fiscal (财政部)',
  isPolicyNews(mkNews({ title: '财政部安排专项债 3.8 万亿支持稳增长' })) === true
);
assert(
  '[2.7] 命中 regulatory (证监会)',
  isPolicyNews(mkNews({ title: '证监会就上市公司退市新规答记者问' })) === true
);
assert(
  '[2.8] 命中 capital_market (IPO 退市)',
  isPolicyNews(mkNews({ title: '北交所发布新一轮 IPO 改革方案' })) === true
);
assert(
  '[2.9] 命中 industry (发改委)',
  isPolicyNews(mkNews({ title: '发改委印发新型储能产业高质量发展行动方案' })) === true
);
assert(
  '[2.10] 命中 macro_signal (国常会)',
  isPolicyNews(mkNews({ title: '国常会研究部署四季度经济工作' })) === true
);
assert(
  '[2.11] 生意快讯不命中 (个股财报 / 业绩快报 / 重大合同)',
  isPolicyNews(
    mkNews({
      title: '宁德时代发布 Q3 财报 净利润同比增长 30%',
      content: '公司表示新能源汽车需求强劲, 海外订单饱满',
    })
  ) === false
);
assert(
  '[2.12] content 命中也算 (title 空, content 含央行)',
  isPolicyNews(mkNews({ title: '简讯', content: '中国人民银行公开市场操作' })) === true
);

// ---- [3] classifyPolicyTopic -----------------------------------------------
const c1 = classifyPolicyTopic(mkNews({ title: '央行降准 0.5 个百分点' }));
assert('[3.1] monetary 主命中', c1?.topic === 'monetary');
assert(
  '[3.2] matched_keywords 包含 "降准" 和 "央行"',
  c1 != null && c1.matched_keywords.includes('降准') && c1.matched_keywords.includes('央行')
);
assert(
  '[3.3] matched_keywords ≤ 5',
  c1 != null && c1.matched_keywords.length <= 5
);

const c2 = classifyPolicyTopic(
  mkNews({ title: '人民日报评论员: 央行降准释放稳增长信号' })
);
// 同含 monetary (央行/降准) + macro_signal (人民日报) → monetary 优先
assert('[3.4] 优先级: monetary 抢先 macro_signal', c2?.topic === 'monetary');

const c3 = classifyPolicyTopic(mkNews({ title: '证监会对某券商立案调查' }));
assert('[3.5] regulatory 命中', c3?.topic === 'regulatory');

const c4 = classifyPolicyTopic(null);
assert('[3.6] null → null', c4 === null);

const c5 = classifyPolicyTopic(mkNews({ title: '某公司股价异动' }));
assert('[3.7] 无政策关键字 → null', c5 === null);

// ---- [4] filterPolicyNews ---------------------------------------------------
const stream: MarketNewsRow[] = [
  mkNews({ title: '央行降准 0.5%', publish_time: '2026-06-19 09:00:00' }),
  mkNews({ title: '宁德时代 Q3 净利 +30%', publish_time: '2026-06-19 08:50:00' }),
  mkNews({ title: '证监会发布 IPO 新规', publish_time: '2026-06-19 08:30:00' }),
  mkNews({ title: '茅台开盘涨 2%', publish_time: '2026-06-19 08:20:00' }),
];
const filt = filterPolicyNews(stream);
assert('[4.1] 4 条流过滤出 2 条政策', filt.length === 2);
assert(
  '[4.2] 保留输入顺序 (DESC)',
  filt[0].title === '央行降准 0.5%' && filt[1].title === '证监会发布 IPO 新规'
);
assert(
  '[4.3] topic 各正确',
  filt[0].topic === 'monetary' && filt[1].topic === 'regulatory'
);
assert(
  '[4.4] matched_keywords 已附',
  filt[0].matched_keywords.length > 0 && filt[1].matched_keywords.length > 0
);
assert('[4.5] null 输入 → []', filterPolicyNews(null).length === 0);
assert('[4.6] undefined 输入 → []', filterPolicyNews(undefined).length === 0);
assert('[4.7] 非数组 → []', filterPolicyNews('not array' as any).length === 0);
assert(
  '[4.8] 含 null row 跳过不报错',
  filterPolicyNews([null as any, mkNews({ title: '央行新闻' })]).length === 1
);

// ---- [5] countPolicyByTopic -------------------------------------------------
const cnt0 = countPolicyByTopic([]);
assert(
  '[5.1] 空数组返 6 个 zero',
  POLICY_TOPIC_ORDER.every(t => cnt0[t] === 0)
);
assert('[5.2] null 输入 也返 6 个 zero (不报错)', countPolicyByTopic(null)['monetary'] === 0);
const cnt1 = countPolicyByTopic([
  { ...mkNews({ title: '央行' }), topic: 'monetary', matched_keywords: ['央行'] },
  { ...mkNews({ title: '财政部' }), topic: 'fiscal', matched_keywords: ['财政部'] },
  { ...mkNews({ title: '人行' }), topic: 'monetary', matched_keywords: ['央行'] },
] as PolicyNewsRow[]);
assert('[5.3] monetary=2', cnt1.monetary === 2);
assert('[5.4] fiscal=1', cnt1.fiscal === 1);
assert('[5.5] regulatory=0 不会跳掉', cnt1.regulatory === 0);
const cnt2 = countPolicyByTopic([
  { ...mkNews({ title: 'x' }), topic: 'unknown' as any, matched_keywords: [] } as PolicyNewsRow,
]);
assert('[5.6] 非法 topic 不污染', cnt2.monetary === 0);

// ---- [6] aggregateETFFlow ---------------------------------------------------
const flowRows = [
  // 半导体 ETF 2 日
  {
    trade_date: '2026-06-19',
    etf_code: '159995',
    etf_name: '半导体 ETF',
    underlying_industry: '半导体',
    net_inflow: 1e8, // +1 亿
    aum: 5e9,
    nav: 1.234,
    share_count: 4e9,
    secondary_turnover: 3e8,
    close_price: 1.23,
  },
  {
    trade_date: '2026-06-18',
    etf_code: '159995',
    etf_name: '半导体 ETF',
    underlying_industry: '半导体',
    net_inflow: -5e7,
    aum: 4.9e9,
    nav: 1.22,
    share_count: 4.01e9,
    secondary_turnover: 2.8e8,
    close_price: 1.22,
  },
  // 医药 ETF 1 日
  {
    trade_date: '2026-06-19',
    etf_code: '512170',
    etf_name: '医药 ETF',
    underlying_industry: '医药',
    net_inflow: 2e8,
    aum: 8e9,
    nav: 0.987,
    share_count: 8.1e9,
    secondary_turnover: 1.5e8,
    close_price: 0.98,
  },
  // 缺 etf_code 应跳
  {
    trade_date: '2026-06-19',
    etf_code: '',
    etf_name: '',
    underlying_industry: '',
    net_inflow: 1e10,
    aum: null,
    nav: null,
    share_count: null,
    secondary_turnover: null,
    close_price: null,
  },
];

const agg = aggregateETFFlow(flowRows);
assert('[6.1] 2 只 ETF (缺 code 行跳过)', agg.length === 2);
const semi = agg.find(a => a.etf_code === '159995');
const med = agg.find(a => a.etf_code === '512170');
assert(
  '[6.2] 半导体累计净流入 = +5000 万',
  semi != null && Math.abs(semi.cumulative_inflow - 5e7) < 1
);
assert('[6.3] 半导体 days=2', semi != null && semi.days === 2);
assert(
  '[6.4] 半导体最新 AUM 取第一条 (DESC 输入, 50 亿)',
  semi != null && semi.latest_aum === 5e9
);
assert(
  '[6.5] 半导体最新 NAV 取第一条 (1.234)',
  semi != null && Math.abs((semi.latest_nav ?? 0) - 1.234) < 1e-9
);
assert(
  '[6.6] 医药累计 = +2 亿, days=1',
  med != null && Math.abs(med.cumulative_inflow - 2e8) < 1 && med.days === 1
);
assert('[6.7] 空输入返 []', aggregateETFFlow([]).length === 0);
const aggNullNet = aggregateETFFlow([
  {
    trade_date: '2026-06-19',
    etf_code: 'X',
    etf_name: 'X',
    underlying_industry: 'X',
    net_inflow: null,
    aum: null,
    nav: null,
    share_count: null,
    secondary_turnover: null,
    close_price: null,
  },
]);
assert(
  '[6.8] net_inflow=null 不报错, cumulative=0',
  aggNullNet.length === 1 && aggNullNet[0].cumulative_inflow === 0
);

// ---- [7] META-GUARD fs+regex ------------------------------------------------
const repoRoot = join(__dirname, '../../../');

const helpersSrc = readFileSync(
  join(repoRoot, 'frontend/src/pages/workspace/policyNewsHelpers.ts'),
  'utf8'
);
assert(
  '[7.1] policyNewsHelpers.ts 5 个主 export 全在',
  /export\s+function\s+isPolicyNews/.test(helpersSrc) &&
    /export\s+function\s+classifyPolicyTopic/.test(helpersSrc) &&
    /export\s+function\s+filterPolicyNews/.test(helpersSrc) &&
    /export\s+function\s+countPolicyByTopic/.test(helpersSrc) &&
    /export\s+const\s+POLICY_KEYWORDS/.test(helpersSrc)
);
assert(
  '[7.2] POLICY_KEYWORDS 含 6 个 topic key',
  /monetary:\s*Object\.freeze/.test(helpersSrc) &&
    /fiscal:\s*Object\.freeze/.test(helpersSrc) &&
    /regulatory:\s*Object\.freeze/.test(helpersSrc) &&
    /capital_market:\s*Object\.freeze/.test(helpersSrc) &&
    /industry:\s*Object\.freeze/.test(helpersSrc) &&
    /macro_signal:\s*Object\.freeze/.test(helpersSrc)
);

const etfTabSrc = readFileSync(
  join(repoRoot, 'frontend/src/pages/workspace/FactorWorkspace.ETFFlowTab.tsx'),
  'utf8'
);
assert(
  '[7.3] ETFFlowTab 默认 export',
  /export\s+default\s+ETFFlowTab/.test(etfTabSrc)
);
assert(
  '[7.4] ETFFlowTab 调 /data/etf-flow endpoint',
  /\/data\/etf-flow/.test(etfTabSrc)
);
assert(
  '[7.5] ETFFlowTab import aggregateETFFlow from etfFlowHelpers (pure helper 抽出)',
  /from\s+['"]\.\/etfFlowHelpers['"]/.test(etfTabSrc) &&
    /aggregateETFFlow/.test(etfTabSrc)
);
assert(
  '[7.6] ETFFlowTab 有 data-testid 锚点',
  /data-testid=['"]etf-flow-tab['"]/.test(etfTabSrc) &&
    /data-testid=['"]etf-flow-industry-select['"]/.test(etfTabSrc) &&
    /data-testid=['"]etf-flow-top-inflow['"]/.test(etfTabSrc) &&
    /data-testid=['"]etf-flow-top-outflow['"]/.test(etfTabSrc)
);

const policyTabSrc = readFileSync(
  join(repoRoot, 'frontend/src/pages/workspace/FactorWorkspace.PolicyNewsTab.tsx'),
  'utf8'
);
assert(
  '[7.7] PolicyNewsTab 默认 export',
  /export\s+default\s+PolicyNewsTab/.test(policyTabSrc)
);
assert(
  '[7.8] PolicyNewsTab 调 /data/market-news endpoint',
  /\/data\/market-news/.test(policyTabSrc)
);
assert(
  '[7.9] PolicyNewsTab import 复用 helper (不再 inline 字典)',
  /from\s+['"]\.\/policyNewsHelpers['"]/.test(policyTabSrc) &&
    /filterPolicyNews/.test(policyTabSrc) &&
    /POLICY_TOPIC_ORDER/.test(policyTabSrc)
);
// 反向: tab 文件不应自己写 '央行' / '证监会' 关键字 (会与 helper 字典漂移)
assert(
  '[7.10] PolicyNewsTab 不 inline policy 关键字 (字典只在 helper)',
  !/POLICY_KEYWORDS\s*=/.test(policyTabSrc)
);
assert(
  '[7.11] PolicyNewsTab 有 topic chip data-testid 锚点',
  /data-testid=['"]policy-topic-chip-all['"]/.test(policyTabSrc) &&
    /data-testid=\{`policy-topic-chip-\$\{t\}`\}/.test(policyTabSrc)
);

const workspaceSrc = readFileSync(
  join(repoRoot, 'frontend/src/pages/workspace/FactorWorkspace.tsx'),
  'utf8'
);
assert(
  '[7.12] FactorWorkspace.tsx import ETFFlowTab + PolicyNewsTab',
  /from\s+['"]\.\/FactorWorkspace\.ETFFlowTab['"]/.test(workspaceSrc) &&
    /from\s+['"]\.\/FactorWorkspace\.PolicyNewsTab['"]/.test(workspaceSrc)
);
assert(
  '[7.13] FactorWorkspace.tsx tabs 数组含统一 insight 入口',
  /key:\s*['"]insight['"]/.test(workspaceSrc)
);
assert(
  '[7.14] FactorWorkspace.tsx 在 insight 分支渲染 ETF 与政策区块',
  /activeKey\s*===\s*['"]insight['"]/.test(workspaceSrc) &&
    /<ETFFlowTab\s*\/>/.test(workspaceSrc) &&
    /<PolicyNewsTab\s*\/>/.test(workspaceSrc)
);
// 反向: 现有 macro / block 仍存在 (没误删)
assert(
  '[7.15] insight 仍同时展示行业决策与宏观环境',
  /<IndustryBoardTab/.test(workspaceSrc) && /<MacroEnvTab\s*\/>/.test(workspaceSrc)
);

// ---- 报告 --------------------------------------------------------------------
const total = passed + failed;
console.log(`\n${passed} ok / ${failed} failed (of ${total})`);
if (failed > 0) process.exit(1);
process.exit(0);
