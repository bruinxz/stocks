/**
 * QA 主题/情绪分类原语 (批5 抽取).
 *
 * 原 EastMoneyQATopicService 已下线; 本模块保留 QAStatAggregator 仍依赖的纯分类
 * 常量与启发式函数 (无 IO / model / service 依赖), 供 QA 周聚合独立编译运行.
 * 内容逐字复制自原 EastMoneyQATopicService, 仅剥离数据源/模型/同步逻辑.
 */

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


/**
 * computeWeekStart — 任意日期 → 所在 ISO 周的周一 (UTC).
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
