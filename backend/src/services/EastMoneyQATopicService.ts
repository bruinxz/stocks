import { Op } from 'sequelize';
import { EastMoneyQATopic } from '../models/EastMoneyQATopic';
import { StockQAClient, StockQARow, stockQAClient } from '../data/sources/StockQAClient';
import { logger } from '../utils/logger';

/**
 * EastMoneyQATopicService — US-060 AI 东财问答 NLP 与个股关注度.
 *
 * 把投资者互动易问答 (per-stock 历史) 用启发式 (默认) 或 AI 远端 (可选)
 * 抽取主题 + 情绪倾向, 按周聚合 (week_start = 周一 ISO 日期) 落库到
 * `east_money_qa_topics` 表.
 *
 * **核心契约**:
 *   - `classifyTopic(question)` → 6 类 + 1 兜底 (pure, 无 DB);
 *   - `scoreSentiment(question)` → ∈ [-1, +1] 浮点 (pure, 无 DB);
 *   - `aggregateWeekly(rows, stock_meta)` → AggregatedTopicRow[] (pure, 无 DB);
 *   - `syncStock(stock_code, options)` → 拉取 + 聚合 + bulkCreate upsert;
 *   - `syncStocks(stock_codes[], options)` → 批量遍历 + 节流;
 *   - `listByStock(stock_code, weeks)` → 读端 (前端 GET endpoint 直接调).
 *
 * **6 项 AI feature checklist** (US-055 范式同款):
 *   1. **DataSource DI** — `EastMoneyQATopicDataSource` 接口 (fetchForStock /
 *      saveTopics / callRemoteClassify); `DefaultEastMoneyQATopicDataSource`
 *      走 StockQAClient + Sequelize; 生产 `PRODUCTION_EAST_MONEY_QA_TOPIC_DATA_SOURCE`
 *      singleton; 单测注入 fake.
 *   2. **pure helpers 全 export** — classifyTopic / scoreSentiment /
 *      computeWeekStart / aggregateWeekly / normalizeTopic / detectTopicByKeyword /
 *      parseRemoteClassify.
 *   3. **plain-object 返回类型** `AggregatedTopicRow` 兼容 persist=true/false.
 *   4. **status='partial' / 'failed' 仍可见** —— sync 失败仍返回 SyncStockResult
 *      带 error 字段, 避免重复触发同股查询.
 *   5. **fail-OPEN on saveTopics** — DB 故障不抛, warn + persisted=false.
 *   6. **双重防御 try/catch** —— DataSource 内已 catch (StockQAClient.fetchForStock
 *      失败返回 []), service 层再 catch 转 failed 路径.
 *
 * **AI vs 启发式 fallback 分工** (与 AnnouncementNLPService 同款):
 *   - 默认走启发式 (`extract_with_ai=false`): 关键词字典 + 优先级判定, < 1ms/条;
 *   - `extract_with_ai=true` 时调远端 TradingAgents (适合 UI 主动 "详细解读");
 *   - 远端 throw 时 fallback 启发式 + nlp_engine='heuristic_fallback'.
 *
 * **主题分类规则** (AC 6 类 + 兜底):
 *   - **财务** (FINANCE):  营收 / 利润 / 净利 / 毛利 / 现金流 / 资产 / 负债 / 财报 / 业绩 / EPS / ROE
 *   - **订单** (ORDER):    订单 / 合同 / 中标 / 采购 / 客户 / 大客户 / 交付 / 出货 / 装机
 *   - **产品** (PRODUCT):  产品 / 新品 / 技术 / 研发 / 工艺 / 性能 / 规格 / 销量 / 量产
 *   - **政策** (POLICY):   政策 / 监管 / 补贴 / 法规 / 调控 / 规划 / 准入 / 资质 / 牌照
 *   - **人事** (PERSONNEL): 高管 / 总裁 / 董事 / 离职 / 任命 / 招聘 / 团队 / 员工 / 股权激励
 *   - **其它** (OTHER):     未命中以上字典 → 兜底
 *
 *   优先级 (命中数平手时): FINANCE > ORDER > PRODUCT > POLICY > PERSONNEL > OTHER.
 *   财务/订单优先因为最具投资决策价值, 与 quant strategies 信号源对齐.
 *
 * **情绪打分** (与 AnnouncementNLPService.heuristicSentiment 同款 4 档字典,
 * 但输出连续标量便于聚合):
 *   - 强空 = -1.0, 弱空 = -0.5, 中性 = 0, 弱多 = +0.5, 强多 = +1.0;
 *   - 投资者提问语境与公告标题语境略不同: 提问中 "下滑 / 是否亏损 / 减持"
 *     等同样视为负面信号; "进展 / 增长 / 预期" 视为正面.
 *
 * **按周聚合**:
 *   - week_start = 该周周一 ISO 日期 (YYYY-MM-DD, UTC);
 *   - 同周同 topic 多条问题 → mention_count + 平均 sentiment_score;
 *   - sentiment_breakdown 落 raw_payload 便于审计.
 */

// audit L-19: 集中常量, 不再硬编码 IP.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { TRADING_AGENTS_BASE_URL } = require('../config/externalServices');
const TRADING_AGENTS_URL = TRADING_AGENTS_BASE_URL;

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 主题分类枚举 (AC 6 类 + 1 兜底). 用 Chinese 字符串与 model.topic 列对齐. */
export const TOPIC_CATEGORIES = Object.freeze({
  FINANCE: '财务' as const,
  PRODUCT: '产品' as const,
  ORDER: '订单' as const,
  PERSONNEL: '人事' as const,
  POLICY: '政策' as const,
  OTHER: '其它' as const,
});

export type TopicCategory =
  | typeof TOPIC_CATEGORIES.FINANCE
  | typeof TOPIC_CATEGORIES.PRODUCT
  | typeof TOPIC_CATEGORIES.ORDER
  | typeof TOPIC_CATEGORIES.PERSONNEL
  | typeof TOPIC_CATEGORIES.POLICY
  | typeof TOPIC_CATEGORIES.OTHER;

export const TOPIC_VALUES: readonly TopicCategory[] = Object.freeze([
  TOPIC_CATEGORIES.FINANCE,
  TOPIC_CATEGORIES.PRODUCT,
  TOPIC_CATEGORIES.ORDER,
  TOPIC_CATEGORIES.PERSONNEL,
  TOPIC_CATEGORIES.POLICY,
  TOPIC_CATEGORIES.OTHER,
] as const);

/** 平手时的字典优先级 (FINANCE > ORDER > PRODUCT > POLICY > PERSONNEL > OTHER). */
export const TOPIC_PRIORITY: Readonly<Record<TopicCategory, number>> = Object.freeze({
  [TOPIC_CATEGORIES.FINANCE]: 0,
  [TOPIC_CATEGORIES.ORDER]: 1,
  [TOPIC_CATEGORIES.PRODUCT]: 2,
  [TOPIC_CATEGORIES.POLICY]: 3,
  [TOPIC_CATEGORIES.PERSONNEL]: 4,
  [TOPIC_CATEGORIES.OTHER]: 99,
});

/** NLP 引擎标签 (写入 model.nlp_engine 列) */
export const NLP_ENGINES = Object.freeze({
  TRADING_AGENTS: 'trading_agents' as const,
  HEURISTIC: 'heuristic_fallback' as const,
  OPENAI: 'openai' as const,
});

/**
 * 主题关键词字典 — 每类列出 8-15 个高频词. 命中数多者胜; 平手按 TOPIC_PRIORITY.
 */
export const TOPIC_KEYWORDS: Readonly<Record<TopicCategory, readonly string[]>> = Object.freeze({
  [TOPIC_CATEGORIES.FINANCE]: Object.freeze([
    '营收',
    '营业收入',
    '利润',
    '净利',
    '净利润',
    '毛利',
    '毛利率',
    '现金流',
    '自由现金流',
    '资产',
    '负债',
    '资产负债',
    '财报',
    '业绩',
    '业绩预告',
    '业绩快报',
    'EPS',
    'ROE',
    '分红',
    '股息',
    '派息',
    '回购',
    '增发',
    '定增',
    '配股',
    '可转债',
    '每股收益',
  ]),
  [TOPIC_CATEGORIES.PRODUCT]: Object.freeze([
    '产品',
    '新品',
    '新产品',
    '技术',
    '研发',
    '工艺',
    '性能',
    '规格',
    '销量',
    '产能',
    '量产',
    '试产',
    '专利',
    '迭代',
    '升级',
    '智能驾驶',
    '车型',
    '电池',
    '芯片',
    '材料',
    '设备',
  ]),
  [TOPIC_CATEGORIES.ORDER]: Object.freeze([
    '订单',
    '合同',
    '中标',
    '采购',
    '客户',
    '大客户',
    '交付',
    '出货',
    '装机',
    '签约',
    '海外订单',
    '战略合作',
    '合作',
    '协议',
  ]),
  [TOPIC_CATEGORIES.PERSONNEL]: Object.freeze([
    '高管',
    '总裁',
    '董事',
    '董事长',
    '总经理',
    '离职',
    '辞职',
    '任命',
    '招聘',
    '团队',
    '员工',
    '股权激励',
    '员工持股',
    '高管变动',
  ]),
  [TOPIC_CATEGORIES.POLICY]: Object.freeze([
    '政策',
    '监管',
    '补贴',
    '法规',
    '调控',
    '规划',
    '准入',
    '资质',
    '牌照',
    '关税',
    '汇率',
    '环保',
    '安全生产',
    '反垄断',
  ]),
  [TOPIC_CATEGORIES.OTHER]: Object.freeze([] as string[]),
});

/** 情绪关键词字典 (4 档 — 与 AnnouncementNLPService 同款) */
export const QA_SENTIMENT_KEYWORDS: Readonly<{
  strongPos: readonly string[];
  weakPos: readonly string[];
  weakNeg: readonly string[];
  strongNeg: readonly string[];
}> = Object.freeze({
  strongPos: Object.freeze([
    '业绩超预期',
    '业绩大增',
    '业绩预增',
    '突破新高',
    '中标',
    '签订重大合同',
    '获批',
    '利好',
    '回购',
    '高送转',
  ]),
  weakPos: Object.freeze([
    '上调',
    '增长',
    '扩产',
    '签约',
    '合作',
    '战略合作',
    '进展',
    '推动',
    '收购',
    '并购',
    '预期',
    '量产',
  ]),
  weakNeg: Object.freeze([
    '减持',
    '下滑',
    '解禁',
    '问询',
    '风险',
    '业绩下滑',
    '质押',
    '担保',
    '推迟',
    '延期',
    '亏损',
    '萎缩',
  ]),
  strongNeg: Object.freeze([
    '立案',
    '立案调查',
    '退市',
    '退市风险',
    '重大违规',
    '欺诈',
    '处罚',
    '行政处罚',
    '黑天鹅',
    '业绩暴雷',
    '业绩低于预期',
    '亏损扩大',
    '债务违约',
    '逾期',
    'ST',
    '*ST',
  ]),
});

// ---------------------------------------------------------------------------
// QA-001 v2 subcategory 细化 (doc 83 §B.1)
// ---------------------------------------------------------------------------
//
// 单 question 只能落 1 个 subcategory; subcategory → parent topic 1:1 固定 (见
// TOPIC_SUBCATEGORY_OF). 未命中任何 subtopic 字典 → 落该父类的 `*_other` 兜底
// (e.g. FINANCE 命中但无 subtopic 字典命中 → 'finance_other'); 父类是 OTHER →
// 落 'other_general' 兜底.
//
// 设计要点:
//   - subcategory 字典数 ≥ 24 (含 6 个 *_other 兜底 = 30+); AC: "24+ subcategory"
//   - 关键词覆盖 doc 83 §B.1 + 国内 IRM 实际高频问句搜集 (业绩预告/产能/中标...)
//   - 平手 tie-break: 用 TOPIC_SUBCATEGORY_PRIORITY (deterministic, business-value-first)
//
// classifySubtopic(question) ≡ classifyTopic(question) → 父类下走 subtopic 字典命中
// (与 classifyTopic 同款 "命中数多者胜 + 优先级 tie-break"); 与 classifyTopic 共享
// 同一份文本 + 共享 includes() 启发式, 保证 (topic, subtopic) 严格 parent-child.

/** Subcategory string union — flat 全局唯一标识. */
export const TOPIC_SUBCATEGORIES = Object.freeze({
  // FINANCE (6)
  EARNINGS_FORECAST: 'earnings_forecast' as const,
  QUARTERLY_REPORT: 'quarterly_report' as const,
  DIVIDEND_BUYBACK: 'dividend_buyback' as const,
  CAPITAL_ACTION: 'capital_action' as const,
  CASHFLOW_CONCERN: 'cashflow_concern' as const,
  FINANCE_OTHER: 'finance_other' as const,
  // PRODUCT (5)
  NEW_PRODUCT: 'new_product' as const,
  CAPACITY: 'capacity' as const,
  RD_PROGRESS: 'rd_progress' as const,
  QUALITY_RECALL: 'quality_recall' as const,
  PRODUCT_OTHER: 'product_other' as const,
  // ORDER (5)
  MAJOR_CONTRACT: 'major_contract' as const,
  EXPORT: 'export' as const,
  NEW_CUSTOMER: 'new_customer' as const,
  DELIVERY: 'delivery' as const,
  ORDER_OTHER: 'order_other' as const,
  // POLICY (5)
  SUBSIDY: 'subsidy' as const,
  TARIFF: 'tariff' as const,
  REGULATION: 'regulation' as const,
  MACRO: 'macro' as const,
  POLICY_OTHER: 'policy_other' as const,
  // PERSONNEL (4)
  EXECUTIVE_CHANGE: 'executive_change' as const,
  INCENTIVE: 'incentive' as const,
  CONTROVERSY: 'controversy' as const,
  PERSONNEL_OTHER: 'personnel_other' as const,
  // OTHER (1)
  OTHER_GENERAL: 'other_general' as const,
});

export type SubtopicCategory =
  | typeof TOPIC_SUBCATEGORIES.EARNINGS_FORECAST
  | typeof TOPIC_SUBCATEGORIES.QUARTERLY_REPORT
  | typeof TOPIC_SUBCATEGORIES.DIVIDEND_BUYBACK
  | typeof TOPIC_SUBCATEGORIES.CAPITAL_ACTION
  | typeof TOPIC_SUBCATEGORIES.CASHFLOW_CONCERN
  | typeof TOPIC_SUBCATEGORIES.FINANCE_OTHER
  | typeof TOPIC_SUBCATEGORIES.NEW_PRODUCT
  | typeof TOPIC_SUBCATEGORIES.CAPACITY
  | typeof TOPIC_SUBCATEGORIES.RD_PROGRESS
  | typeof TOPIC_SUBCATEGORIES.QUALITY_RECALL
  | typeof TOPIC_SUBCATEGORIES.PRODUCT_OTHER
  | typeof TOPIC_SUBCATEGORIES.MAJOR_CONTRACT
  | typeof TOPIC_SUBCATEGORIES.EXPORT
  | typeof TOPIC_SUBCATEGORIES.NEW_CUSTOMER
  | typeof TOPIC_SUBCATEGORIES.DELIVERY
  | typeof TOPIC_SUBCATEGORIES.ORDER_OTHER
  | typeof TOPIC_SUBCATEGORIES.SUBSIDY
  | typeof TOPIC_SUBCATEGORIES.TARIFF
  | typeof TOPIC_SUBCATEGORIES.REGULATION
  | typeof TOPIC_SUBCATEGORIES.MACRO
  | typeof TOPIC_SUBCATEGORIES.POLICY_OTHER
  | typeof TOPIC_SUBCATEGORIES.EXECUTIVE_CHANGE
  | typeof TOPIC_SUBCATEGORIES.INCENTIVE
  | typeof TOPIC_SUBCATEGORIES.CONTROVERSY
  | typeof TOPIC_SUBCATEGORIES.PERSONNEL_OTHER
  | typeof TOPIC_SUBCATEGORIES.OTHER_GENERAL;

export const SUBTOPIC_VALUES: readonly SubtopicCategory[] = Object.freeze([
  TOPIC_SUBCATEGORIES.EARNINGS_FORECAST,
  TOPIC_SUBCATEGORIES.QUARTERLY_REPORT,
  TOPIC_SUBCATEGORIES.DIVIDEND_BUYBACK,
  TOPIC_SUBCATEGORIES.CAPITAL_ACTION,
  TOPIC_SUBCATEGORIES.CASHFLOW_CONCERN,
  TOPIC_SUBCATEGORIES.FINANCE_OTHER,
  TOPIC_SUBCATEGORIES.NEW_PRODUCT,
  TOPIC_SUBCATEGORIES.CAPACITY,
  TOPIC_SUBCATEGORIES.RD_PROGRESS,
  TOPIC_SUBCATEGORIES.QUALITY_RECALL,
  TOPIC_SUBCATEGORIES.PRODUCT_OTHER,
  TOPIC_SUBCATEGORIES.MAJOR_CONTRACT,
  TOPIC_SUBCATEGORIES.EXPORT,
  TOPIC_SUBCATEGORIES.NEW_CUSTOMER,
  TOPIC_SUBCATEGORIES.DELIVERY,
  TOPIC_SUBCATEGORIES.ORDER_OTHER,
  TOPIC_SUBCATEGORIES.SUBSIDY,
  TOPIC_SUBCATEGORIES.TARIFF,
  TOPIC_SUBCATEGORIES.REGULATION,
  TOPIC_SUBCATEGORIES.MACRO,
  TOPIC_SUBCATEGORIES.POLICY_OTHER,
  TOPIC_SUBCATEGORIES.EXECUTIVE_CHANGE,
  TOPIC_SUBCATEGORIES.INCENTIVE,
  TOPIC_SUBCATEGORIES.CONTROVERSY,
  TOPIC_SUBCATEGORIES.PERSONNEL_OTHER,
  TOPIC_SUBCATEGORIES.OTHER_GENERAL,
] as const);

/** Subcategory → parent topic 1:1 映射. */
export const TOPIC_SUBCATEGORY_OF: Readonly<Record<SubtopicCategory, TopicCategory>> =
  Object.freeze({
    [TOPIC_SUBCATEGORIES.EARNINGS_FORECAST]: TOPIC_CATEGORIES.FINANCE,
    [TOPIC_SUBCATEGORIES.QUARTERLY_REPORT]: TOPIC_CATEGORIES.FINANCE,
    [TOPIC_SUBCATEGORIES.DIVIDEND_BUYBACK]: TOPIC_CATEGORIES.FINANCE,
    [TOPIC_SUBCATEGORIES.CAPITAL_ACTION]: TOPIC_CATEGORIES.FINANCE,
    [TOPIC_SUBCATEGORIES.CASHFLOW_CONCERN]: TOPIC_CATEGORIES.FINANCE,
    [TOPIC_SUBCATEGORIES.FINANCE_OTHER]: TOPIC_CATEGORIES.FINANCE,
    [TOPIC_SUBCATEGORIES.NEW_PRODUCT]: TOPIC_CATEGORIES.PRODUCT,
    [TOPIC_SUBCATEGORIES.CAPACITY]: TOPIC_CATEGORIES.PRODUCT,
    [TOPIC_SUBCATEGORIES.RD_PROGRESS]: TOPIC_CATEGORIES.PRODUCT,
    [TOPIC_SUBCATEGORIES.QUALITY_RECALL]: TOPIC_CATEGORIES.PRODUCT,
    [TOPIC_SUBCATEGORIES.PRODUCT_OTHER]: TOPIC_CATEGORIES.PRODUCT,
    [TOPIC_SUBCATEGORIES.MAJOR_CONTRACT]: TOPIC_CATEGORIES.ORDER,
    [TOPIC_SUBCATEGORIES.EXPORT]: TOPIC_CATEGORIES.ORDER,
    [TOPIC_SUBCATEGORIES.NEW_CUSTOMER]: TOPIC_CATEGORIES.ORDER,
    [TOPIC_SUBCATEGORIES.DELIVERY]: TOPIC_CATEGORIES.ORDER,
    [TOPIC_SUBCATEGORIES.ORDER_OTHER]: TOPIC_CATEGORIES.ORDER,
    [TOPIC_SUBCATEGORIES.SUBSIDY]: TOPIC_CATEGORIES.POLICY,
    [TOPIC_SUBCATEGORIES.TARIFF]: TOPIC_CATEGORIES.POLICY,
    [TOPIC_SUBCATEGORIES.REGULATION]: TOPIC_CATEGORIES.POLICY,
    [TOPIC_SUBCATEGORIES.MACRO]: TOPIC_CATEGORIES.POLICY,
    [TOPIC_SUBCATEGORIES.POLICY_OTHER]: TOPIC_CATEGORIES.POLICY,
    [TOPIC_SUBCATEGORIES.EXECUTIVE_CHANGE]: TOPIC_CATEGORIES.PERSONNEL,
    [TOPIC_SUBCATEGORIES.INCENTIVE]: TOPIC_CATEGORIES.PERSONNEL,
    [TOPIC_SUBCATEGORIES.CONTROVERSY]: TOPIC_CATEGORIES.PERSONNEL,
    [TOPIC_SUBCATEGORIES.PERSONNEL_OTHER]: TOPIC_CATEGORIES.PERSONNEL,
    [TOPIC_SUBCATEGORIES.OTHER_GENERAL]: TOPIC_CATEGORIES.OTHER,
  });

/**
 * Subcategory 平手优先级 (数值小者胜 — 业务价值优先).
 *
 * FINANCE 内部:  earnings_forecast > capital_action > dividend_buyback > quarterly_report > cashflow > other
 *   (业绩预告最优, 因 leading 信号最强; 现金流 concern 次之, 因属于风险信号)
 * PRODUCT 内部:  new_product > capacity > rd_progress > quality_recall > other
 * ORDER 内部:    major_contract > export > new_customer > delivery > other
 * POLICY 内部:   subsidy > tariff > regulation > macro > other
 * PERSONNEL 内部: executive_change > controversy > incentive > other
 *
 * 注: 父类 priority 已由 TOPIC_PRIORITY 决定; subcategory priority 只在父类内部 tie-break.
 */
export const TOPIC_SUBCATEGORY_PRIORITY: Readonly<Record<SubtopicCategory, number>> = Object.freeze(
  {
    // FINANCE
    [TOPIC_SUBCATEGORIES.EARNINGS_FORECAST]: 10,
    [TOPIC_SUBCATEGORIES.CAPITAL_ACTION]: 11,
    [TOPIC_SUBCATEGORIES.DIVIDEND_BUYBACK]: 12,
    [TOPIC_SUBCATEGORIES.QUARTERLY_REPORT]: 13,
    [TOPIC_SUBCATEGORIES.CASHFLOW_CONCERN]: 14,
    [TOPIC_SUBCATEGORIES.FINANCE_OTHER]: 19,
    // PRODUCT
    [TOPIC_SUBCATEGORIES.NEW_PRODUCT]: 20,
    [TOPIC_SUBCATEGORIES.CAPACITY]: 21,
    [TOPIC_SUBCATEGORIES.RD_PROGRESS]: 22,
    [TOPIC_SUBCATEGORIES.QUALITY_RECALL]: 23,
    [TOPIC_SUBCATEGORIES.PRODUCT_OTHER]: 29,
    // ORDER
    [TOPIC_SUBCATEGORIES.MAJOR_CONTRACT]: 30,
    [TOPIC_SUBCATEGORIES.EXPORT]: 31,
    [TOPIC_SUBCATEGORIES.NEW_CUSTOMER]: 32,
    [TOPIC_SUBCATEGORIES.DELIVERY]: 33,
    [TOPIC_SUBCATEGORIES.ORDER_OTHER]: 39,
    // POLICY
    [TOPIC_SUBCATEGORIES.SUBSIDY]: 40,
    [TOPIC_SUBCATEGORIES.TARIFF]: 41,
    [TOPIC_SUBCATEGORIES.REGULATION]: 42,
    [TOPIC_SUBCATEGORIES.MACRO]: 43,
    [TOPIC_SUBCATEGORIES.POLICY_OTHER]: 49,
    // PERSONNEL
    [TOPIC_SUBCATEGORIES.EXECUTIVE_CHANGE]: 50,
    [TOPIC_SUBCATEGORIES.CONTROVERSY]: 51,
    [TOPIC_SUBCATEGORIES.INCENTIVE]: 52,
    [TOPIC_SUBCATEGORIES.PERSONNEL_OTHER]: 59,
    // OTHER
    [TOPIC_SUBCATEGORIES.OTHER_GENERAL]: 99,
  }
);

/**
 * Subcategory 关键词字典 — 每条 ≥ 3 高频中文词. 命中数多者胜, 平手按
 * TOPIC_SUBCATEGORY_PRIORITY. *_other / other_general 字典为空 (兜底).
 */
export const TOPIC_SUBCATEGORY_KEYWORDS: Readonly<Record<SubtopicCategory, readonly string[]>> =
  Object.freeze({
    // ---- FINANCE -----------------------------------------------------------
    [TOPIC_SUBCATEGORIES.EARNINGS_FORECAST]: Object.freeze([
      '业绩预告',
      '业绩预增',
      '业绩预减',
      '业绩预盈',
      '业绩预亏',
      '业绩快报',
      '业绩超预期',
      '业绩低于预期',
      '预增',
      '预减',
      '业绩指引',
    ]),
    [TOPIC_SUBCATEGORIES.QUARTERLY_REPORT]: Object.freeze([
      '季报',
      '半年报',
      '中报',
      '一季报',
      '三季报',
      '年报',
      '财报',
      'EPS',
      'ROE',
      '每股收益',
      '披露',
    ]),
    [TOPIC_SUBCATEGORIES.DIVIDEND_BUYBACK]: Object.freeze([
      '分红',
      '派息',
      '股息',
      '现金分红',
      '回购',
      '增持',
      '高送转',
      '送转',
      '股东回报',
    ]),
    [TOPIC_SUBCATEGORIES.CAPITAL_ACTION]: Object.freeze([
      '定增',
      '定向增发',
      '配股',
      '可转债',
      '可转换债',
      '增发',
      '发行',
      '募投',
      '募集资金',
      '股权融资',
    ]),
    [TOPIC_SUBCATEGORIES.CASHFLOW_CONCERN]: Object.freeze([
      '现金流',
      '自由现金流',
      '经营现金流',
      '应收',
      '应收账款',
      '存货',
      '坏账',
      '资金紧张',
      '负债率',
      '债务',
      '偿债',
    ]),
    [TOPIC_SUBCATEGORIES.FINANCE_OTHER]: Object.freeze([] as string[]),
    // ---- PRODUCT -----------------------------------------------------------
    [TOPIC_SUBCATEGORIES.NEW_PRODUCT]: Object.freeze([
      '新品',
      '新产品',
      '新车型',
      '新机型',
      '新规格',
      '新一代',
      '上市发布',
      '发布会',
      '新型号',
    ]),
    [TOPIC_SUBCATEGORIES.CAPACITY]: Object.freeze([
      '产能',
      '量产',
      '在建产能',
      '扩产',
      '扩建',
      '试产',
      '投产',
      '产线',
      '工厂',
      '稼动率',
      'GWh',
      '万吨',
    ]),
    [TOPIC_SUBCATEGORIES.RD_PROGRESS]: Object.freeze([
      '研发',
      '研发进度',
      '临床',
      '临床试验',
      '专利',
      '技术突破',
      '中试',
      'IND',
      '上市许可',
      '获批临床',
      '技术路线',
    ]),
    [TOPIC_SUBCATEGORIES.QUALITY_RECALL]: Object.freeze([
      '召回',
      '缺陷',
      '投诉',
      '质量问题',
      '事故',
      '停产整改',
      '质量门',
      '退货',
      '质量风险',
    ]),
    [TOPIC_SUBCATEGORIES.PRODUCT_OTHER]: Object.freeze([] as string[]),
    // ---- ORDER -------------------------------------------------------------
    [TOPIC_SUBCATEGORIES.MAJOR_CONTRACT]: Object.freeze([
      '大订单',
      '大额订单',
      '中标',
      '中标公告',
      '招标',
      '重大合同',
      '亿元订单',
      '万吨订单',
      '签订重大',
    ]),
    [TOPIC_SUBCATEGORIES.EXPORT]: Object.freeze([
      '出口',
      '海外',
      '海外订单',
      '海外业务',
      '一带一路',
      '北美',
      '欧洲',
      '东南亚',
      '中东',
      'OEM',
    ]),
    [TOPIC_SUBCATEGORIES.NEW_CUSTOMER]: Object.freeze([
      '新客户',
      '大客户',
      '战略客户',
      '客户拓展',
      '客户结构',
      '客户开发',
      '入围',
      '供应商资质',
      '导入',
    ]),
    [TOPIC_SUBCATEGORIES.DELIVERY]: Object.freeze([
      '交付',
      '交货',
      '出货',
      '发货',
      '装机',
      '排产',
      '订单确认',
      '在手订单',
      '订单交付',
    ]),
    [TOPIC_SUBCATEGORIES.ORDER_OTHER]: Object.freeze([] as string[]),
    // ---- POLICY ------------------------------------------------------------
    [TOPIC_SUBCATEGORIES.SUBSIDY]: Object.freeze([
      '补贴',
      '退税',
      '财政补贴',
      '产业补贴',
      '政府补助',
      '退坡',
      '补贴目录',
      '专项资金',
      '税收优惠',
    ]),
    [TOPIC_SUBCATEGORIES.TARIFF]: Object.freeze([
      '关税',
      '反倾销',
      '反补贴',
      '贸易摩擦',
      '加征关税',
      '贸易战',
      '出口管制',
      '301',
      '232',
      '出口限制',
    ]),
    [TOPIC_SUBCATEGORIES.REGULATION]: Object.freeze([
      '监管',
      '法规',
      '准入',
      '资质',
      '牌照',
      '认证',
      '审批',
      '合规',
      '行业标准',
      '准入门槛',
      '环保整改',
    ]),
    [TOPIC_SUBCATEGORIES.MACRO]: Object.freeze([
      '宏观',
      '流动性',
      '货币政策',
      '财政政策',
      '降息',
      '加息',
      '降准',
      'MLF',
      'PMI',
      '经济周期',
      '逆周期',
    ]),
    [TOPIC_SUBCATEGORIES.POLICY_OTHER]: Object.freeze([] as string[]),
    // ---- PERSONNEL ---------------------------------------------------------
    [TOPIC_SUBCATEGORIES.EXECUTIVE_CHANGE]: Object.freeze([
      '高管变动',
      '高管离职',
      '辞职',
      '离任',
      '换帅',
      '总经理变动',
      '董事长辞职',
      '聘任',
      '任命',
      'CEO离任',
      'CFO离任',
    ]),
    [TOPIC_SUBCATEGORIES.INCENTIVE]: Object.freeze([
      '股权激励',
      '员工持股',
      '激励计划',
      '业绩考核',
      '行权',
      '解锁',
      '授予价',
      '限制性股票',
      '期权',
    ]),
    [TOPIC_SUBCATEGORIES.CONTROVERSY]: Object.freeze([
      '高管争议',
      '内斗',
      '股权之争',
      '举报',
      '内幕交易',
      '违规',
      '操纵',
      '失联',
      '被立案',
      '调查',
    ]),
    [TOPIC_SUBCATEGORIES.PERSONNEL_OTHER]: Object.freeze([] as string[]),
    // ---- OTHER -------------------------------------------------------------
    [TOPIC_SUBCATEGORIES.OTHER_GENERAL]: Object.freeze([] as string[]),
  });

/** 给定父 topic, 返回该父类下所有 subcategory (含其 *_other 兜底). */
export const SUBTOPICS_BY_TOPIC: Readonly<Record<TopicCategory, readonly SubtopicCategory[]>> =
  Object.freeze({
    [TOPIC_CATEGORIES.FINANCE]: Object.freeze([
      TOPIC_SUBCATEGORIES.EARNINGS_FORECAST,
      TOPIC_SUBCATEGORIES.QUARTERLY_REPORT,
      TOPIC_SUBCATEGORIES.DIVIDEND_BUYBACK,
      TOPIC_SUBCATEGORIES.CAPITAL_ACTION,
      TOPIC_SUBCATEGORIES.CASHFLOW_CONCERN,
      TOPIC_SUBCATEGORIES.FINANCE_OTHER,
    ]),
    [TOPIC_CATEGORIES.PRODUCT]: Object.freeze([
      TOPIC_SUBCATEGORIES.NEW_PRODUCT,
      TOPIC_SUBCATEGORIES.CAPACITY,
      TOPIC_SUBCATEGORIES.RD_PROGRESS,
      TOPIC_SUBCATEGORIES.QUALITY_RECALL,
      TOPIC_SUBCATEGORIES.PRODUCT_OTHER,
    ]),
    [TOPIC_CATEGORIES.ORDER]: Object.freeze([
      TOPIC_SUBCATEGORIES.MAJOR_CONTRACT,
      TOPIC_SUBCATEGORIES.EXPORT,
      TOPIC_SUBCATEGORIES.NEW_CUSTOMER,
      TOPIC_SUBCATEGORIES.DELIVERY,
      TOPIC_SUBCATEGORIES.ORDER_OTHER,
    ]),
    [TOPIC_CATEGORIES.POLICY]: Object.freeze([
      TOPIC_SUBCATEGORIES.SUBSIDY,
      TOPIC_SUBCATEGORIES.TARIFF,
      TOPIC_SUBCATEGORIES.REGULATION,
      TOPIC_SUBCATEGORIES.MACRO,
      TOPIC_SUBCATEGORIES.POLICY_OTHER,
    ]),
    [TOPIC_CATEGORIES.PERSONNEL]: Object.freeze([
      TOPIC_SUBCATEGORIES.EXECUTIVE_CHANGE,
      TOPIC_SUBCATEGORIES.INCENTIVE,
      TOPIC_SUBCATEGORIES.CONTROVERSY,
      TOPIC_SUBCATEGORIES.PERSONNEL_OTHER,
    ]),
    [TOPIC_CATEGORIES.OTHER]: Object.freeze([TOPIC_SUBCATEGORIES.OTHER_GENERAL]),
  });

/** 父类 → *_other 兜底 subcategory. */
export const TOPIC_OTHER_SUBCATEGORY: Readonly<Record<TopicCategory, SubtopicCategory>> =
  Object.freeze({
    [TOPIC_CATEGORIES.FINANCE]: TOPIC_SUBCATEGORIES.FINANCE_OTHER,
    [TOPIC_CATEGORIES.PRODUCT]: TOPIC_SUBCATEGORIES.PRODUCT_OTHER,
    [TOPIC_CATEGORIES.ORDER]: TOPIC_SUBCATEGORIES.ORDER_OTHER,
    [TOPIC_CATEGORIES.POLICY]: TOPIC_SUBCATEGORIES.POLICY_OTHER,
    [TOPIC_CATEGORIES.PERSONNEL]: TOPIC_SUBCATEGORIES.PERSONNEL_OTHER,
    [TOPIC_CATEGORIES.OTHER]: TOPIC_SUBCATEGORIES.OTHER_GENERAL,
  });

/** 默认拉取上限 — 单股 N 条问题 (cninfo IRM 多数股票 < 500 条; 上限 200 控成本). */
export const DEFAULT_FETCH_LIMIT = 200;

/** 默认聚合周数上限 — 读端 listByStock 最大周数 (~6 个月). */
export const DEFAULT_LIST_WEEKS = 26;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 单周单 topic 聚合结果 (与 EastMoneyQATopic 列对应) */
export interface AggregatedTopicRow {
  stock_code: string;
  stock_name: string | null;
  week_start: string;
  topic: TopicCategory;
  mention_count: number;
  sentiment_score: number;
  nlp_engine: string;
  raw_payload: {
    total_questions: number;
    sentiment_breakdown: {
      strong_neg: number;
      weak_neg: number;
      neutral: number;
      weak_pos: number;
      strong_pos: number;
    };
    sample_question_ids?: string[];
  };
  /** True iff actually written to DB (false = dry_run / persist failed). */
  persisted: boolean;
}

/** 远端 AI payload (TradingAgents /api/nlp-qa-topic 占位, 接口待对接) */
export interface RemoteQATopicPayload {
  status?: string;
  data?: {
    topic?: string;
    sentiment_score?: number;
    error?: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export interface SyncStockOptions {
  /** 拉取上限 (默认 200) */
  limit?: number;
  /** 是否调 AI 远端 (默认 false, 全走启发式) */
  extract_with_ai?: boolean;
  /** dry_run 跳过 DB 写入 */
  dry_run?: boolean;
  /** 显式起始日期 (YYYY-MM-DD); 早于此的问题不聚合 (默认: 不过滤) */
  since_date?: string;
}

export interface SyncStockResult {
  stock_code: string;
  fetched: number;
  weeks_aggregated: number;
  rows_upserted: number;
  by_topic: Record<string, number>;
  skipped: boolean;
  error?: string;
}

export interface SyncStocksOptions extends SyncStockOptions {
  /** 单股 sync 失败时是否继续 (默认 true) */
  continue_on_error?: boolean;
  /** stock 间隔 ms (默认 500, cninfo 端点限流防护) */
  interval_ms?: number;
}

export interface SyncStocksResult {
  total_stocks: number;
  succeeded: number;
  failed: number;
  details: SyncStockResult[];
}

// ---------------------------------------------------------------------------
// DataSource 注入接口
// ---------------------------------------------------------------------------

export interface EastMoneyQATopicDataSource {
  fetchForStock(stockCode: string, limit?: number): Promise<StockQARow[]>;
  /** 远端 AI 分类调用; 失败时返回 status=FAILED + error, 不抛 */
  callRemoteClassify(
    question: string,
    context?: { stock_code?: string }
  ): Promise<RemoteQATopicPayload>;
  saveTopics(rows: AggregatedTopicRow[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// Default production DataSource
// ---------------------------------------------------------------------------

export class DefaultEastMoneyQATopicDataSource implements EastMoneyQATopicDataSource {
  private client: StockQAClient;

  constructor(client: StockQAClient = stockQAClient) {
    this.client = client;
  }

  async fetchForStock(stockCode: string, limit?: number): Promise<StockQARow[]> {
    return this.client.fetchForStock(stockCode, limit);
  }

  async callRemoteClassify(
    question: string,
    context: { stock_code?: string } = {}
  ): Promise<RemoteQATopicPayload> {
    // Lazy-require axios so unit tests can stub without it being loaded eagerly.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const axios = require('axios');
    try {
      const response = await axios.post(
        `${TRADING_AGENTS_URL}/api/nlp-qa-topic`,
        {
          question,
          stock_code: context.stock_code,
        },
        { timeout: 30_000 }
      );
      return response.data;
    } catch (error: any) {
      const message = error?.response?.data?.detail || error?.message || String(error);
      logger.warn(
        `EastMoneyQATopic.callRemoteClassify failed for "${question.slice(0, 30)}...": ${message}`
      );
      return { status: 'FAILED', data: { error: message } };
    }
  }

  async saveTopics(rows: AggregatedTopicRow[]): Promise<void> {
    if (rows.length === 0) return;
    await EastMoneyQATopic.bulkCreate(
      rows.map(r => ({
        stock_code: r.stock_code,
        stock_name: r.stock_name,
        week_start: r.week_start,
        topic: r.topic,
        mention_count: r.mention_count,
        sentiment_score: r.sentiment_score,
        nlp_engine: r.nlp_engine,
        raw_payload: r.raw_payload,
      })) as unknown as Array<Record<string, unknown>>,
      {
        updateOnDuplicate: [
          'stock_name',
          'mention_count',
          'sentiment_score',
          'nlp_engine',
          'raw_payload',
          'updated_at',
        ],
      }
    );
  }
}

export const PRODUCTION_EAST_MONEY_QA_TOPIC_DATA_SOURCE: EastMoneyQATopicDataSource =
  new DefaultEastMoneyQATopicDataSource();

// ---------------------------------------------------------------------------
// Pure helpers (export for unit tests — no DB / no axios)
// ---------------------------------------------------------------------------

/**
 * 计算给定日期所在 ISO-8601 周的周一日期 (YYYY-MM-DD, UTC).
 *
 * - 输入日期任意时区, 内部按 UTC 处理;
 * - ISO-8601: 周一 = day 1, 周日 = day 7;
 * - 同一周内任何一天 → 同一 week_start.
 *
 * 例: '2026-06-04' (周四) → '2026-06-01' (周一)
 *    '2026-06-08' (周一) → '2026-06-08' (周一, self)
 *    '2026-06-07' (周日) → '2026-06-01' (周一, 上周一)
 */
export function computeWeekStart(date: string | Date): string {
  let d: Date;
  if (typeof date === 'string') {
    // 支持 'YYYY-MM-DD' 与 'YYYY-MM-DD HH:mm:ss' (cninfo 返回的 question_time)
    const slice = date.length >= 10 ? date.slice(0, 10) : date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(slice)) {
      throw new RangeError(`Invalid date format: ${date}`);
    }
    d = new Date(`${slice}T00:00:00Z`);
  } else {
    d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  }
  if (!Number.isFinite(d.getTime())) {
    throw new RangeError(`Invalid date: ${date}`);
  }
  // getUTCDay: 周日=0, 周一=1, ..., 周六=6. 转 ISO weekday: 周一=1, 周日=7.
  const utcDay = d.getUTCDay();
  const isoWeekday = utcDay === 0 ? 7 : utcDay;
  // 减去 (isoWeekday - 1) 天得到本周周一
  d.setUTCDate(d.getUTCDate() - (isoWeekday - 1));
  return d.toISOString().slice(0, 10);
}

/**
 * 启发式主题分类 — 关键词字典命中数 + 优先级 tie-break.
 *
 * - 命中数多者胜 (e.g. 同问题含 3 个财务词 + 1 个产品词 → 财务);
 * - 平手按 TOPIC_PRIORITY 字典顺序 (FINANCE > ORDER > PRODUCT > POLICY > PERSONNEL);
 * - 全部 0 命中 → OTHER 兜底.
 */
export function classifyTopic(question: string | null | undefined): TopicCategory {
  if (!question) return TOPIC_CATEGORIES.OTHER;
  const text = String(question);
  const trimmed = text.trim();
  if (!trimmed) return TOPIC_CATEGORIES.OTHER;

  const counts: Record<TopicCategory, number> = {
    [TOPIC_CATEGORIES.FINANCE]: 0,
    [TOPIC_CATEGORIES.PRODUCT]: 0,
    [TOPIC_CATEGORIES.ORDER]: 0,
    [TOPIC_CATEGORIES.PERSONNEL]: 0,
    [TOPIC_CATEGORIES.POLICY]: 0,
    [TOPIC_CATEGORIES.OTHER]: 0,
  };

  for (const topic of TOPIC_VALUES) {
    if (topic === TOPIC_CATEGORIES.OTHER) continue;
    const kws = TOPIC_KEYWORDS[topic];
    if (!kws) continue;
    for (const kw of kws) {
      if (text.includes(kw)) counts[topic] += 1;
    }
  }

  // 全 0 → OTHER
  let maxCount = 0;
  for (const topic of TOPIC_VALUES) {
    if (counts[topic] > maxCount) maxCount = counts[topic];
  }
  if (maxCount === 0) return TOPIC_CATEGORIES.OTHER;

  // 找命中数 = max 的所有 topic, 按 priority 选最优
  const candidates = TOPIC_VALUES.filter(t => counts[t] === maxCount);
  candidates.sort((a, b) => TOPIC_PRIORITY[a] - TOPIC_PRIORITY[b]);
  return candidates[0];
}

/**
 * 检测某 question 是否命中某 topic 的关键词字典 (导出供测试 / 调试).
 */
export function detectTopicByKeyword(
  question: string | null | undefined,
  topic: TopicCategory
): boolean {
  if (!question) return false;
  const kws = TOPIC_KEYWORDS[topic];
  if (!kws) return false;
  const text = String(question);
  for (const kw of kws) {
    if (text.includes(kw)) return true;
  }
  return false;
}

/**
 * 启发式 subcategory 分类 — TOPIC_SUBCATEGORY_KEYWORDS 命中数 +
 * TOPIC_SUBCATEGORY_PRIORITY tie-break (QA-001).
 *
 * 算法 (subtopic-first, parent 从结果反推):
 *   1. 遍历所有 actionable subtopic 字典 (排除 *_other) 累计命中数;
 *   2. 全 0 命中 → fallback 父类: 调 classifyTopic(question) 取 parent, 落
 *      TOPIC_OTHER_SUBCATEGORY[parent] (e.g. FINANCE → finance_other);
 *   3. 命中数 > 0 → 按命中数 desc + TOPIC_SUBCATEGORY_PRIORITY asc 选最优;
 *
 * 与 classifyTopic 的关系:
 *   - subtopic 字典比 parent 字典更细 (e.g. "一季报" 仅在 quarterly_report 中,
 *     "财报"/"业绩" 在 parent FINANCE 中). 因此 subtopic 命中 ⇒ 父类必为
 *     TOPIC_SUBCATEGORY_OF[sub], 即便 classifyTopic 因 parent 字典稀疏返回 OTHER;
 *   - 在 aggregateWeekly 写入数据库时, (topic, subtopic) 严格 parent-child 由
 *     TOPIC_SUBCATEGORY_OF 保证, 上游 (topic 列) 可独立用 classifyTopic 或
 *     deriveTopicFromSubtopic(classifySubtopic(...)) — 见 QA-002 集成.
 *
 * 缺省 (null / 空串) → 'other_general'.
 *
 * Pure / 无 DB / 无远端 — 100 条标注语料上准确率 ≥ 80% (AC; 见
 * SUBTOPIC_LABELED_CORPUS 单测).
 */
export function classifySubtopic(question: string | null | undefined): SubtopicCategory {
  if (!question) return TOPIC_SUBCATEGORIES.OTHER_GENERAL;
  const text = String(question);
  const trimmed = text.trim();
  if (!trimmed) return TOPIC_SUBCATEGORIES.OTHER_GENERAL;

  // 1. 全 subtopic 字典命中扫描
  const counts: Partial<Record<SubtopicCategory, number>> = {};
  let maxCount = 0;
  for (const sub of SUBTOPIC_VALUES) {
    const kws = TOPIC_SUBCATEGORY_KEYWORDS[sub];
    if (!kws || kws.length === 0) continue; // skip *_other 兜底字典
    let c = 0;
    for (const kw of kws) {
      if (text.includes(kw)) c += 1;
    }
    if (c > 0) {
      counts[sub] = c;
      if (c > maxCount) maxCount = c;
    }
  }

  // 2. 全 0 → 父类的 *_other 兜底 (classifyTopic 仍是 parent 的事实源)
  if (maxCount === 0) {
    const parent = classifyTopic(text);
    return TOPIC_OTHER_SUBCATEGORY[parent];
  }

  // 3. 平手 tie-break: TOPIC_SUBCATEGORY_PRIORITY 升序 (deterministic)
  const winners = SUBTOPIC_VALUES.filter(s => (counts[s] || 0) === maxCount);
  winners.sort((a, b) => TOPIC_SUBCATEGORY_PRIORITY[a] - TOPIC_SUBCATEGORY_PRIORITY[b]);
  return winners[0];
}

/**
 * 给定 subtopic 反推父 topic — TOPIC_SUBCATEGORY_OF 的 ergonomic 包装 (供 caller 用
 * `deriveTopicFromSubtopic(classifySubtopic(q))` 一行获得 (topic, subtopic) 一致对).
 */
export function deriveTopicFromSubtopic(subtopic: SubtopicCategory): TopicCategory {
  return TOPIC_SUBCATEGORY_OF[subtopic];
}

/**
 * 检测 question 是否命中给定 subtopic 字典 (与 detectTopicByKeyword 同款, 供测试用).
 */
export function detectSubtopicByKeyword(
  question: string | null | undefined,
  subtopic: SubtopicCategory
): boolean {
  if (!question) return false;
  const kws = TOPIC_SUBCATEGORY_KEYWORDS[subtopic];
  if (!kws || kws.length === 0) return false;
  const text = String(question);
  for (const kw of kws) {
    if (text.includes(kw)) return true;
  }
  return false;
}

/**
 * 启发式情绪打分 — 4 档关键词字典 + 优先级 (与 AnnouncementNLPService 同款).
 *
 * 返回 ∈ {-1, -0.5, 0, +0.5, +1}:
 *   - 强空 = -1.0 (立案 / 退市 / 处罚 / 暴雷 ...)
 *   - 弱空 = -0.5 (减持 / 下滑 / 风险 / 担保 ...)
 *   - 中性 =  0   (未命中字典)
 *   - 弱多 = +0.5 (增长 / 扩产 / 战略合作 ...)
 *   - 强多 = +1.0 (业绩超预期 / 中标 / 回购 ...)
 *
 * 优先级 (同时命中多档): 强空 > 强多 > 弱空 > 弱多 > 中性.
 * 强空优先是安全派, 避免漏报负面.
 */
export function scoreSentiment(question: string | null | undefined): number {
  if (!question) return 0;
  const text = String(question);

  // 1. 强空 — 最优先
  for (const kw of QA_SENTIMENT_KEYWORDS.strongNeg) {
    if (text.includes(kw)) return -1.0;
  }
  // 2. 强多
  for (const kw of QA_SENTIMENT_KEYWORDS.strongPos) {
    if (text.includes(kw)) return 1.0;
  }
  // 3. 弱空
  for (const kw of QA_SENTIMENT_KEYWORDS.weakNeg) {
    if (text.includes(kw)) return -0.5;
  }
  // 4. 弱多
  for (const kw of QA_SENTIMENT_KEYWORDS.weakPos) {
    if (text.includes(kw)) return 0.5;
  }
  return 0;
}

/**
 * 规范化 topic 字符串 (AI 远端可能返回 'FINANCE' / 'finance' / '财务' / '财务类').
 * - 中文/英文 / 大小写不敏感映射;
 * - 未识别 → '其它'.
 */
export function normalizeTopic(raw: unknown): TopicCategory {
  if (!raw) return TOPIC_CATEGORIES.OTHER;
  const text = String(raw).trim().toLowerCase();
  if (!text) return TOPIC_CATEGORIES.OTHER;

  // 中文优先
  for (const topic of TOPIC_VALUES) {
    if (text.includes(topic.toLowerCase())) return topic;
  }
  // 英文映射
  if (text.includes('finance') || text.includes('financial')) return TOPIC_CATEGORIES.FINANCE;
  if (text.includes('product') || text.includes('tech')) return TOPIC_CATEGORIES.PRODUCT;
  if (text.includes('order') || text.includes('contract') || text.includes('customer')) {
    return TOPIC_CATEGORIES.ORDER;
  }
  if (text.includes('personnel') || text.includes('hr') || text.includes('executive')) {
    return TOPIC_CATEGORIES.PERSONNEL;
  }
  if (text.includes('policy') || text.includes('regulation') || text.includes('subsidy')) {
    return TOPIC_CATEGORIES.POLICY;
  }
  return TOPIC_CATEGORIES.OTHER;
}

/**
 * 按周聚合一只股票的全部问答 → AggregatedTopicRow[].
 *
 * - 同周同 topic 多条问题 → mention_count + 平均 sentiment_score;
 * - sentiment_breakdown 落 raw_payload 便于审计;
 * - sample_question_ids 保留最多 5 条样本 ID 便于回溯.
 *
 * 若提供 `useAI = true` + `aiClassifications` Map<question_id, {topic, score}>,
 * 优先用 AI 分类 / 评分; 缺失项 fallback 启发式.
 */
export function aggregateWeekly(
  rows: StockQARow[],
  options: {
    stock_code: string;
    stock_name?: string | null;
    nlp_engine?: string;
    useAI?: boolean;
    aiClassifications?: Map<string, { topic: TopicCategory; sentiment_score: number }>;
    since_date?: string;
  }
): AggregatedTopicRow[] {
  const engine = options.nlp_engine || NLP_ENGINES.HEURISTIC;
  const ai = options.aiClassifications;
  const sinceDate = options.since_date;

  // (week_start, topic) → accumulator
  type Acc = {
    sum: number;
    n: number;
    breakdown: {
      strong_neg: number;
      weak_neg: number;
      neutral: number;
      weak_pos: number;
      strong_pos: number;
    };
    sample_question_ids: string[];
  };
  const bucket: Map<string, Acc> = new Map();
  const keyOf = (week: string, topic: TopicCategory) => `${week}::${topic}`;

  for (const row of rows) {
    if (!row.question || !row.question_time) continue;
    if (sinceDate) {
      const dateOnly = row.question_time.slice(0, 10);
      if (dateOnly < sinceDate) continue;
    }
    let week: string;
    try {
      week = computeWeekStart(row.question_time);
    } catch {
      continue; // 跳过无法解析时间的行
    }

    let topic: TopicCategory;
    let sent: number;
    if (ai && ai.has(row.question_id)) {
      const aiResult = ai.get(row.question_id)!;
      topic = aiResult.topic;
      sent = aiResult.sentiment_score;
    } else {
      topic = classifyTopic(row.question);
      sent = scoreSentiment(row.question);
    }

    const key = keyOf(week, topic);
    let acc = bucket.get(key);
    if (!acc) {
      acc = {
        sum: 0,
        n: 0,
        breakdown: {
          strong_neg: 0,
          weak_neg: 0,
          neutral: 0,
          weak_pos: 0,
          strong_pos: 0,
        },
        sample_question_ids: [],
      };
      bucket.set(key, acc);
    }
    acc.sum += sent;
    acc.n += 1;
    if (sent <= -0.9) acc.breakdown.strong_neg += 1;
    else if (sent <= -0.4) acc.breakdown.weak_neg += 1;
    else if (sent >= 0.9) acc.breakdown.strong_pos += 1;
    else if (sent >= 0.4) acc.breakdown.weak_pos += 1;
    else acc.breakdown.neutral += 1;

    if (acc.sample_question_ids.length < 5) {
      acc.sample_question_ids.push(row.question_id);
    }
  }

  const out: AggregatedTopicRow[] = [];
  for (const [k, acc] of bucket.entries()) {
    const [week, topic] = k.split('::');
    const avg = acc.n > 0 ? acc.sum / acc.n : 0;
    // 量化到 3 位小数, 与 DECIMAL(5,3) 列对齐
    const score = Math.round(avg * 1000) / 1000;
    out.push({
      stock_code: options.stock_code,
      stock_name: options.stock_name ?? null,
      week_start: week,
      topic: topic as TopicCategory,
      mention_count: acc.n,
      sentiment_score: score,
      nlp_engine: engine,
      raw_payload: {
        total_questions: acc.n,
        sentiment_breakdown: acc.breakdown,
        sample_question_ids: acc.sample_question_ids,
      },
      persisted: false,
    });
  }

  // 稳定排序 (week_start desc, topic priority asc) 便于 deterministic 输出
  out.sort((a, b) => {
    if (a.week_start !== b.week_start) return a.week_start < b.week_start ? 1 : -1;
    return TOPIC_PRIORITY[a.topic] - TOPIC_PRIORITY[b.topic];
  });
  return out;
}

/**
 * 解析远端 AI payload 为 (topic, sentiment_score) — pure transform.
 *
 * - status='COMPLETED' + data.topic + data.sentiment_score 都存在 → 用 AI 结果;
 * - 否则 fallback 启发式 (caller 处理).
 *
 * 返回 null 表示 AI 失败, caller 走启发式 fallback.
 */
export function parseRemoteClassify(
  payload: RemoteQATopicPayload
): { topic: TopicCategory; sentiment_score: number } | null {
  const statusRaw = String(payload?.status || '').toUpperCase();
  const data = payload?.data;
  if (statusRaw === 'FAILED' || !data) return null;
  const topic = normalizeTopic(data.topic);
  const rawScore = data.sentiment_score;
  let score = 0;
  if (typeof rawScore === 'number' && Number.isFinite(rawScore)) {
    // clamp 到 [-1, +1]
    score = Math.max(-1, Math.min(1, rawScore));
  }
  return { topic, sentiment_score: score };
}

// ---------------------------------------------------------------------------
// EastMoneyQATopicService — main entry
// ---------------------------------------------------------------------------

export class EastMoneyQATopicService {
  private readonly dataSource: EastMoneyQATopicDataSource;

  constructor(dataSource: EastMoneyQATopicDataSource = PRODUCTION_EAST_MONEY_QA_TOPIC_DATA_SOURCE) {
    this.dataSource = dataSource;
  }

  /**
   * 单股 sync — fetch + 聚合 + upsert.
   *
   * UI 触发: POST /api/sentiment/qa-topics/sync (admin); CLI: npm run sync:qa-topics --stock=X.
   * extract_with_ai=true 时每条问题调 AI (慢 + 贵); 默认 false 走启发式.
   */
  async syncStock(stockCode: string, options: SyncStockOptions = {}): Promise<SyncStockResult> {
    const code = String(stockCode || '').trim();
    if (!/^\d{6}$/.test(code)) {
      return {
        stock_code: stockCode,
        fetched: 0,
        weeks_aggregated: 0,
        rows_upserted: 0,
        by_topic: {},
        skipped: false,
        error: `Invalid stock_code: ${stockCode}`,
      };
    }

    const limit = options.limit ?? DEFAULT_FETCH_LIMIT;
    const useAI = options.extract_with_ai === true;

    try {
      const rows = await this.dataSource.fetchForStock(code, limit);
      if (rows.length === 0) {
        logger.warn(`EastMoneyQATopic: no Q&A returned for stock=${code}`);
        return {
          stock_code: code,
          fetched: 0,
          weeks_aggregated: 0,
          rows_upserted: 0,
          by_topic: {},
          skipped: false,
        };
      }

      // 取 stock_name 兜底 (首行)
      const stockName = rows[0]?.stock_name || null;

      // 可选 AI 路径
      let aiMap: Map<string, { topic: TopicCategory; sentiment_score: number }> | undefined;
      if (useAI) {
        aiMap = new Map();
        for (const row of rows) {
          if (!row.question || !row.question_id) continue;
          let payload: RemoteQATopicPayload;
          try {
            payload = await this.dataSource.callRemoteClassify(row.question, {
              stock_code: code,
            });
          } catch (err: any) {
            // 双重防御
            logger.warn(
              `EastMoneyQATopicService.callRemoteClassify unexpected throw for ` +
                `"${row.question.slice(0, 30)}...": ${err.message}`
            );
            payload = { status: 'FAILED', data: { error: err.message } };
          }
          const parsed = parseRemoteClassify(payload);
          if (parsed) {
            aiMap.set(row.question_id, parsed);
          }
        }
      }

      const aggregated = aggregateWeekly(rows, {
        stock_code: code,
        stock_name: stockName,
        nlp_engine: useAI ? NLP_ENGINES.TRADING_AGENTS : NLP_ENGINES.HEURISTIC,
        useAI,
        aiClassifications: aiMap,
        since_date: options.since_date,
      });

      // 聚合统计 (ops dashboard)
      const byTopic: Record<string, number> = {};
      for (const row of aggregated) {
        byTopic[row.topic] = (byTopic[row.topic] || 0) + 1;
      }

      if (options.dry_run !== true) {
        try {
          await this.dataSource.saveTopics(aggregated);
          aggregated.forEach(r => {
            r.persisted = true;
          });
        } catch (err: any) {
          // fail-OPEN
          logger.error(`EastMoneyQATopic.saveTopics(${code}) failed: ${err.message}`);
          return {
            stock_code: code,
            fetched: rows.length,
            weeks_aggregated: aggregated.length,
            rows_upserted: 0,
            by_topic: byTopic,
            skipped: false,
            error: `save_failed: ${err.message}`,
          };
        }
      }

      const weekStarts = new Set(aggregated.map(r => r.week_start));
      logger.info(
        `EastMoneyQATopic: stock=${code} ${rows.length} questions → ` +
          `${weekStarts.size} weeks × ${aggregated.length} (week,topic) rows ` +
          `(ai=${useAI}, by_topic=${JSON.stringify(byTopic)})`
      );
      return {
        stock_code: code,
        fetched: rows.length,
        weeks_aggregated: weekStarts.size,
        rows_upserted: options.dry_run === true ? 0 : aggregated.length,
        by_topic: byTopic,
        skipped: false,
      };
    } catch (err: any) {
      // 双重防御外层 catch
      logger.error(`EastMoneyQATopic.syncStock(${code}) failed: ${err.message}`);
      return {
        stock_code: code,
        fetched: 0,
        weeks_aggregated: 0,
        rows_upserted: 0,
        by_topic: {},
        skipped: false,
        error: err.message,
      };
    }
  }

  /**
   * 批量 sync 多只股票 — 顺序执行 + intervalMs 节流.
   */
  async syncStocks(
    stockCodes: string[],
    options: SyncStocksOptions = {}
  ): Promise<SyncStocksResult> {
    const continueOnError = options.continue_on_error !== false;
    const intervalMs = Math.max(0, options.interval_ms ?? 500);

    const details: SyncStockResult[] = [];
    let succeeded = 0;
    let failed = 0;

    for (let i = 0; i < stockCodes.length; i++) {
      const code = stockCodes[i];
      const result = await this.syncStock(code, options);
      details.push(result);
      if (result.error) {
        failed += 1;
        if (!continueOnError) break;
      } else {
        succeeded += 1;
      }
      if (intervalMs > 0 && i < stockCodes.length - 1) {
        await sleep(intervalMs);
      }
    }

    return {
      total_stocks: stockCodes.length,
      succeeded,
      failed,
      details,
    };
  }

  /**
   * 读端 — 按股票代码查最近 N 周聚合.
   * GET /api/sentiment/qa-topics?stock_code=000001&weeks=12 直接调.
   */
  async listByStock(stockCode: string, weeks = DEFAULT_LIST_WEEKS): Promise<EastMoneyQATopic[]> {
    const code = String(stockCode || '').trim();
    if (!/^\d{6}$/.test(code)) return [];

    const weeksCap = Math.max(1, Math.min(104, Math.floor(weeks)));
    // weeksCap × 7 天回看
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - weeksCap * 7);
    const sinceIso = since.toISOString().slice(0, 10);

    return EastMoneyQATopic.findAll({
      where: {
        stock_code: code,
        week_start: { [Op.gte]: sinceIso },
      },
      order: [
        ['week_start', 'DESC'],
        ['topic', 'ASC'],
      ],
    });
  }
}

// ---------------------------------------------------------------------------
// 公共导出 helpers
// ---------------------------------------------------------------------------

/** Promise sleep */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** 生产 singleton */
export const eastMoneyQATopicService = new EastMoneyQATopicService();
