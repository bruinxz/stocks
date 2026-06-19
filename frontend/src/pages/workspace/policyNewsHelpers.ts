/**
 * US-048 FactorWorkspace 政策要闻 tab (FE-009) — 纯函数 helper.
 *
 * 后端 `GET /api/data/market-news` 已经把多源 (cls/em/sina/baidu) 全市场要闻
 * 聚合 + 按 publish_time DESC 排序入库. 但 "政策类" 要闻 (央行降准, 证监会
 * 新规, 财政部公告, 行业部委通知...) 在 80~200 条混合流里通常只占 5~15%,
 * 操盘手要在这堆生意快讯里挑出"今天监管层做了什么事"非常吃力.
 *
 * 这个 helper 提供 3 个纯函数:
 *   - isPolicyNews(row) — 用关键字字典判定单条新闻是否政策类
 *   - classifyPolicyTopic(row) — 进一步把 policy 细分成 6 个主题
 *   - filterPolicyNews(rows) — 主入口, rows → policy 子集 (附 topic + score)
 *
 * 设计:
 *   - **关键字字典优先级排序** (与 backend US-026 classifyEventType 同款 pattern):
 *     更具体的关键词在前 (e.g. '降准' 在 '货币' 前). topic 检测短路返第一个命中.
 *   - **policy gate 与 topic 解耦**: isPolicyNews 只判"是不是政策", 不细分; topic
 *     在 isPolicyNews=true 时再算. 单测两路独立验.
 *   - **fail-safe 默认 null/false**: 任何不能识别的 row → 不入 policy. 宁可漏报
 *     不能误报 — 用户看政策 tab 是为了"今天监管层做了什么", 把生意快讯混进来
 *     会立刻丧失信任.
 *   - **不依赖 React / antd / DOM**: 与 [[factorAIWeightHelpers]] / [[factorComboTemplateHelpers]]
 *     同款, 单测可在 backend ts-node 直接跑.
 *
 * 单测: backend/tests/services/policy-news-helpers.test.ts
 *   cd backend && npx ts-node --transpile-only tests/services/policy-news-helpers.test.ts
 */

/** policy topic 6 档 — 决定 UI Tag 颜色与排序优先级 */
export type PolicyTopic =
  | 'monetary' // 货币政策 (央行/降准/降息/MLF/逆回购/利率)
  | 'fiscal' // 财政政策 (财政部/专项债/减税降费/赤字)
  | 'regulatory' // 监管 (证监会/银保监/网信办/工信部/反垄断/合规)
  | 'industry' // 行业部委政策 (发改委/能源局/教育部/卫健委/工信部产业政策)
  | 'capital_market' // 资本市场制度 (IPO/退市/再融资/北交所/创业板/科创板/T+0)
  | 'macro_signal'; // 宏观/官媒信号 (GDP/CPI/人民日报评论/中央经济工作会议)

/** UI 友好的 topic 中文标签 */
export const POLICY_TOPIC_LABELS: Record<PolicyTopic, string> = Object.freeze({
  monetary: '货币政策',
  fiscal: '财政政策',
  regulatory: '监管动态',
  industry: '产业政策',
  capital_market: '资本市场',
  macro_signal: '宏观信号',
});

/**
 * 关键字字典 — Object.freeze 防意外 mutate.
 *
 * 检测顺序: monetary → fiscal → regulatory → capital_market → industry → macro_signal
 * (从 "工具最具体" 到 "信号最虚"). 同一条新闻可能同时含 '央行' + '货币政策' +
 * '人民日报', 取第一个命中的 topic (避免 monetary 被 macro_signal 抢走).
 *
 * 关键字命中策略: 简单的 String.includes (不分词, 中文 NLP 短文本 60 字内
 * 用分词带来的 precision 提升不抵 recall 下降, 与 backend US-026 同款决策).
 */
export const POLICY_KEYWORDS: Readonly<Record<PolicyTopic, ReadonlyArray<string>>> = Object.freeze({
  monetary: Object.freeze([
    '降准',
    '降息',
    '加息',
    'MLF',
    '逆回购',
    'LPR',
    '人民银行',
    '央行',
    '货币政策',
    '存款准备金率',
    '公开市场操作',
    'SLF',
    'PSL',
    '再贴现',
    '再贷款',
  ]),
  fiscal: Object.freeze([
    '财政部',
    '专项债',
    '国债',
    '地方债',
    '减税',
    '降费',
    '退税',
    '财政赤字',
    '增值税',
    '所得税',
    '消费税',
    '财政政策',
    '积极财政',
    '稳增长',
  ]),
  regulatory: Object.freeze([
    '证监会',
    '银保监',
    '保监会',
    '银保监会',
    '国家金融监督管理总局',
    '金融监管总局',
    '网信办',
    '反垄断',
    '反不正当竞争',
    '市场监管总局',
    '行政处罚',
    '立案调查',
    '稽查',
    '问询函',
    '关注函',
    '警示函',
    '合规',
    '风险提示',
  ]),
  capital_market: Object.freeze([
    'IPO',
    '退市',
    '再融资',
    '注册制',
    '北交所',
    '创业板',
    '科创板',
    '主板',
    '新股',
    '配股',
    '可转债',
    '定增',
    '减持新规',
    '回购',
    '做市商',
    '互联互通',
    '北向资金',
    '南向资金',
    '沪深港通',
    'T+0',
    '涨跌停',
    '上市公司',
  ]),
  industry: Object.freeze([
    '发改委',
    '国家发改委',
    '工信部',
    '能源局',
    '国家能源局',
    '商务部',
    '住建部',
    '教育部',
    '卫健委',
    '国家卫健委',
    '药监局',
    '国家药监局',
    '海关总署',
    '国资委',
    '国家国资委',
    '产业政策',
    '行业规划',
    '十四五',
    '十五五',
    '专项规划',
  ]),
  macro_signal: Object.freeze([
    '中央经济工作会议',
    '政治局会议',
    '国务院',
    '国务院常务会议',
    '国常会',
    '总理',
    '人民日报',
    '新华社',
    '官媒',
    'GDP',
    'CPI',
    'PPI',
    '社融',
    '社会融资',
    'PMI',
    '经济数据',
    '稳预期',
    '稳就业',
  ]),
});

/** 显式 topic 检测顺序 (与 POLICY_KEYWORDS 中的优先级一致). */
export const POLICY_TOPIC_ORDER: ReadonlyArray<PolicyTopic> = Object.freeze([
  'monetary',
  'fiscal',
  'regulatory',
  'capital_market',
  'industry',
  'macro_signal',
]);

/** 一条 market news 行 (与 backend /api/data/market-news 返 data[i] 形状对齐). */
export interface MarketNewsRow {
  title: string;
  content?: string | null;
  publish_time: string;
  publish_date?: string;
  source: string;
  category?: string | null;
  url?: string | null;
}

/** filterPolicyNews 的输出 — 在原 row 上附加 topic + matched_keywords. */
export interface PolicyNewsRow extends MarketNewsRow {
  topic: PolicyTopic;
  /** 命中的关键词 (≤ 5, 用于 UI tooltip "为什么进政策榜") */
  matched_keywords: string[];
}

/**
 * 判定单条新闻是否政策类. 仅检 title + content 中是否含任一 POLICY_KEYWORDS 关键词.
 *
 * 不空字符串短路: 标题空或非 string → false. 标题/正文均 trim 后空 → false.
 *
 * **重要**: 这里检 OR 而不是 AND, 因为新闻标题已经是高浓缩(<60 字), 含一个
 * 政策关键词的概率本身就不高; AND 会让 recall 暴跌. precision 由 keyword
 * 字典本身的"高政策性"保证 (e.g. '央行' / '证监会' / 'LPR' 几乎不可能出现
 * 在生意快讯里).
 */
export function isPolicyNews(row: MarketNewsRow | null | undefined): boolean {
  if (!row || typeof row.title !== 'string') return false;
  const text = `${row.title || ''} ${row.content || ''}`.trim();
  if (!text) return false;
  for (const topic of POLICY_TOPIC_ORDER) {
    const dict = POLICY_KEYWORDS[topic];
    for (const kw of dict) {
      if (text.includes(kw)) return true;
    }
  }
  return false;
}

/**
 * 给一条新闻打 topic 标签. 短路返第一个命中的 topic (按 POLICY_TOPIC_ORDER 顺序).
 *
 * 不命中任何 topic → null. caller 通常先用 isPolicyNews 过滤再调本函数,
 * 但本函数自己也防御 null/undefined/空 row.
 *
 * 同时返 matched_keywords 数组 (前 5 个匹配的 keyword, 顺序与 POLICY_KEYWORDS 一致),
 * 让 UI 可以解释 "为什么这条进了政策榜".
 */
export function classifyPolicyTopic(
  row: MarketNewsRow | null | undefined
): { topic: PolicyTopic; matched_keywords: string[] } | null {
  if (!row || typeof row.title !== 'string') return null;
  const text = `${row.title || ''} ${row.content || ''}`.trim();
  if (!text) return null;

  for (const topic of POLICY_TOPIC_ORDER) {
    const dict = POLICY_KEYWORDS[topic];
    const matched: string[] = [];
    for (const kw of dict) {
      if (text.includes(kw)) matched.push(kw);
      if (matched.length >= 5) break;
    }
    if (matched.length > 0) {
      return { topic, matched_keywords: matched };
    }
  }
  return null;
}

/**
 * 主入口: 把市场新闻流过滤成 policy 子集, 并附 topic + matched_keywords.
 *
 * 输入 null/undefined/非数组 → 返 []. 单 row 抛错被 try/catch 吞 (single bad row
 * 不应让整个 policy tab 空白).
 *
 * **保留输入顺序** (调用方传入的就是 publish_time DESC, 不再排序).
 */
export function filterPolicyNews(
  rows: ReadonlyArray<MarketNewsRow> | null | undefined
): PolicyNewsRow[] {
  if (!Array.isArray(rows)) return [];
  const out: PolicyNewsRow[] = [];
  for (const row of rows) {
    try {
      const cls = classifyPolicyTopic(row);
      if (!cls) continue;
      out.push({
        ...row,
        topic: cls.topic,
        matched_keywords: cls.matched_keywords,
      });
    } catch {
      // 单 row 解析失败 → skip, 不阻塞其它 row
    }
  }
  return out;
}

/**
 * 统计每个 topic 的命中条数 (UI 顶部 chip 用).
 *
 * 输入空 → 返 zero counts (而非 {}); UI 可以稳定渲染 6 个 KPI 不闪烁.
 */
export function countPolicyByTopic(
  rows: ReadonlyArray<PolicyNewsRow> | null | undefined
): Record<PolicyTopic, number> {
  const init: Record<PolicyTopic, number> = {
    monetary: 0,
    fiscal: 0,
    regulatory: 0,
    industry: 0,
    capital_market: 0,
    macro_signal: 0,
  };
  if (!Array.isArray(rows)) return init;
  for (const r of rows) {
    if (r && r.topic && (r.topic as PolicyTopic) in init) {
      init[r.topic as PolicyTopic] += 1;
    }
  }
  return init;
}
