/**
 * CRON_REGISTRY (US-002 / OPS-002)
 *
 * 项目中所有合法的 ScheduledTask.type 在这里集中登记。SchedulerService 在
 * initialize() 阶段会:
 *   1. 把整个 CRON_REGISTRY dump 到日志 (运维可以一眼看到"系统认为自己会跑哪些 cron");
 *   2. 把 DB 里 is_active=true 但 type 不在 registry 的 task 标为 UNREGISTERED, 写
 *      warn 日志 (= 配置漂移信号);
 *   3. 给每个 schedule 成功的 task 算出下一次触发时间 (node-cron@4 `getNextRun()`),
 *      连同 type/name/cron_expression 一起 dump.
 *
 * 新增 cron task type:
 *   - 在 CRON_REGISTRY 加一行 (type / owner / description / 推荐 cron / 是否盘中类)
 *   - 在 SchedulerService._executeTaskLogic 加 `} else if (task.type === '...')` 分支
 *   - 在 DB seed / migration / SchedulerSeedService 注入对应记录
 *
 * 这份 registry 是"应该存在的 cron 任务清单"的事实源, 不是"当前 DB 里的真实记录"。
 * 真实状态走 SchedulerService.getActiveTaskIds() + GET /api/scheduler/tasks.
 */

export type CronTaskCategory =
  | 'data_sync' // 行情 / 财务 / 行业 / 情绪等数据同步
  | 'quant_engine' // 量化主流程 / 参数维护 / 信号生成
  | 'paper_trading' // 模拟盘自动化 / 风控触发
  | 'live_trading' // 实盘相关 (kill switch / 影子委托 / 对账)
  | 'analytics' // 归因 / 性能 / 复盘 / 报表
  | 'risk_control' // 风控类周期任务
  | 'cleanup' // 清理 / 归档
  | 'factor'; // 因子计算 / IC / correlation

export interface CronTaskDefinition {
  /** 与 ScheduledTask.type 严格一致 (大写下划线) */
  type: string;
  category: CronTaskCategory;
  /** 业务 owner / 模块负责人 (供 on-call 找人) */
  owner: string;
  /** 推荐 cron expression (Asia/Shanghai), 仅作为 ops 参考 */
  recommendedCron?: string;
  /** 一句话说明任务做什么 */
  description: string;
  /** 是否盘中类 (需要交易日守卫 / 9:30-15:00 时段触发) */
  intraday?: boolean;
  /** 默认 dry_run (parameter audit 会比对) */
  dryRunDefault?: boolean;
}

/**
 * 项目所有 cron task type 的集中注册表。新增 cron 必须列入此处, 否则:
 *   - SchedulerService 启动会打 warn (UNREGISTERED)
 *   - 单测 `cron-registry.test.ts` 比对 SchedulerService._executeTaskLogic 里出现的
 *     所有 'task.type === ...' 字符串 与 CRON_REGISTRY 的 key set 一致, 不一致即挂
 *
 * 注意: 这里的 type 是"被允许的 cron 任务类型"的白名单, 不是"现在 DB 里真的有"的清单。
 */
export const CRON_REGISTRY: ReadonlyArray<CronTaskDefinition> = Object.freeze([
  // ===== L1 数据同步 =====
  {
    type: 'DAILY_UPDATE',
    category: 'data_sync',
    owner: 'data',
    recommendedCron: '0 18 * * 1-5',
    description: '每个交易日盘后 K 线 / 财务 / 龙虎榜等基础数据更新',
  },
  {
    type: 'SYNC_ALL_STOCKS',
    category: 'data_sync',
    owner: 'data',
    description: '股票基础信息全量同步',
  },
  {
    type: 'SYNC_HISTORY',
    category: 'data_sync',
    owner: 'data',
    description: '历史 K 线回补',
  },
  // 实时行情快照刷新 — 支持 2 种 cron 模式:
  //   (A) 老 universe='market' / limit=5000: 20min 间隔, '5,25 9,10,13,14 * * 1-5'
  //       覆盖全 A 股 5500 票, AI 引擎下游需要.
  //   (B) CE-A 新 universe_source='intraday' / limit=500: 2min 间隔
  //       '*/2 9-11,13-14 * * 1-5'. 走 IntradayUniverseService 选 ≤500 票活跃
  //       universe (持仓 + 涨跌幅榜 + 涨停 + 成交额), batch_size=100. 给实时机会
  //       推送 / 异动告警类下游用. ops 在 prod 手动 INSERT 新 ScheduledTask 行启用,
  //       不在 ensureDefaultTasks 里默认 active=true (避免代码层强加新 cron).
  {
    type: 'REALTIME_QUOTE_SYNC',
    category: 'data_sync',
    owner: 'data',
    intraday: true,
    recommendedCron: '*/2 9-11,13-14 * * 1-5',
    description:
      '盘中实时行情快照刷新 (TradingAgents prompt 数据源). 2 模式: market 全量 (20min) / intraday 活跃 ≤500 (2min, CE-A)',
  },
  {
    type: 'BENCHMARK_INDEX_SYNC',
    category: 'data_sync',
    owner: 'data',
    description: '基准指数日线同步 (沪深300 / 中证500 / 创业板指等)',
  },
  {
    type: 'INDUSTRY_FLOW_SYNC',
    category: 'data_sync',
    owner: 'data',
    description: '行业资金流同步',
  },
  // BK-2 (2026-06-24): 盘中 10min 行业资金流时序快照 + 清理.
  //   工作日 9:35-11:30 + 13:00-14:55 每 10min 调 AKShare stock_sector_fund_flow_rank
  //   → industry_flow_intraday 表 (snapshot_ts, industry_code) 复合主键.
  //   配合 INDUSTRY_FLOW_INTRADAY_CLEANUP 每日 16:00 删 > 3 日老快照, 总量 ~6200 行控量.
  //   前端 TodayWorkspace "资金流向" tab 直接消费, 类似抖音"分时累计资金流"图.
  //   fail-OPEN: 单点拉取失败仅 warn, 10min 后下次再补.
  {
    type: 'INDUSTRY_FLOW_INTRADAY_SYNC',
    category: 'data_sync',
    owner: 'data',
    intraday: true,
    recommendedCron: '*/10 9-11,13-14 * * 1-5',
    description: '盘中 10min 行业资金流时序快照 (累计净流入), 给前端画分时图',
  },
  {
    type: 'INDUSTRY_FLOW_INTRADAY_CLEANUP',
    category: 'cleanup',
    owner: 'data',
    recommendedCron: '0 16 * * 1-5',
    description: '每日 16:00 删 industry_flow_intraday > 3 日老快照',
  },
  // Macro 串联补丁 (2026-06-21) — US-092 行业 ETF 资金流 daily sync.
  // 工作日 18:00 (盘后 + AKShare fund_etf_fund_daily_em T+1 数据可用) 跑前一交易日
  // 全市场 ETF 净流入 / 份额 + per-ETF 历史. 写 etf_creation_redemption 表,
  // 下游 KOL aggregator / 行业资金流面板消费. CLI 入口 backend/src/scripts/sync-etf-flow.ts
  // 仍保留供 ops 手动补数 / 范围回填; cron 默认仅 syncDate(today).
  // fail-OPEN: ETFFlowSyncService.syncDate 已 try/catch + 返 SyncDateResult.error,
  // cron 仅记 failed_items=1 + warn 不抛.
  {
    type: 'ETF_FLOW_SYNC',
    category: 'data_sync',
    owner: 'data',
    recommendedCron: '0 18 * * 1-5',
    description:
      '工作日 18:00 拉前一交易日 30+ 行业 ETF 净流入 / 份额 (AKShare fund_etf_fund_daily_em + fund_etf_hist_em) → etf_creation_redemption',
  },
  // PR-M1 (2026-06-29): 隔夜信号矩阵 — A50 期指 + 港股恒指 + 美股纳指/DXY/VIX.
  // 北京时间 21-23 (隔夜美股开盘) + 0-9 (隔夜+早盘前) 每 15min 跑一次,
  // 5 个 source 并行 (fail-OPEN). 给 9:25 早盘 QuantRecommendationService /
  // OpeningRushDetectorService 消费判定大盘方向, 避免普跌日盲推 (PR-I 教训).
  // 数据源真实可调: index_global_em + stock_hk_index_spot_em +
  // index_us_stock_sina(.IXIC/.VIX) + forex_spot_em.
  // 不限工作日: 周末美股已收 (跑出空数据无害); 一日 ~36 次 × 5 source = 180 行
  // (~90 KB / 日).
  {
    type: 'OVERNIGHT_SIGNAL_SYNC',
    category: 'data_sync',
    owner: 'data',
    recommendedCron: '*/15 0-9,21-23 * * *',
    description:
      'A50 期指 + 港股恒指 + 美股纳指/DXY/VIX 隔夜信号矩阵 — 给早盘 QuantRecommendationService 消费 (5 source fail-OPEN, *15 min)',
  },
  // BJ-8 (2026-06-24): 市场情绪指数每日计算 - 真因 MarketSentimentIndexService 写
  //   全自动 (US-057), 但 cron 没有调度, 仅 sync-market-sentiment 脚本手动跑过 2 次
  //   (2026-06-09 + 06-11), 之后停摆 13 日 → DATA_FRESHNESS_CHECK 永远 fail.
  //   现在工作日 17:30 自动 sync (盘后 30min, daily_bar/limit_up 已落 + 早于 18:30
  //   DATA_FRESHNESS_CHECK 1h 让 sentiment 当天能算上).
  {
    type: 'MARKET_SENTIMENT_INDEX_SYNC',
    category: 'data_sync',
    owner: 'data',
    recommendedCron: '30 17 * * 1-5',
    description:
      '工作日 17:30 计算并持久化当日全市场情绪指数 (4 维: 涨跌停 + 北向 + 融资 + QA 热度) → market_sentiment_indices',
  },
  // BF-3 (2026-06-23): 数据陈旧度检查 - 工作日盘后 18:30 (ETF_FLOW_SYNC 后 30min, 让本日数据落库再检)
  // 检 5 项: realtime_quotes 1h+ stale / daily_bars 不是 today / factor std=0 > 2 / cron FAILED / sentiment 陈旧
  // 命中任一阈值 → RiskAlert MEDIUM + Lark OPS 群推 (1h dedup)
  // fail-OPEN: 任一检查 throw → 仅 warn 不阻塞.
  {
    type: 'DATA_FRESHNESS_CHECK',
    category: 'data_sync',
    owner: 'data',
    recommendedCron: '30 18 * * 1-5',
    description:
      '工作日 18:30 检查 5 项数据陈旧度 (RT 1h / daily_bars / factor std / cron FAILED / sentiment) → 命中阈值推 Lark + RiskAlert MEDIUM',
  },
  // BH-2 (2026-06-23): 分析师研报全市场 sync — 真因 analyst_forecasts 表只有 50 票
  // 一次性 backfill 后没 cron 续接. 这是 analyst_consensus factor std 仅 0.0190 的真因.
  // 周一 03:00 跑全市场 (--all --interval-ms=400, 5500 票 × ~2s/票 = ~3h, 周末前一日跑完成).
  // CLI 内置 skip-existing 断点续传, 已 sync 过的票仅做 metadata refresh.
  {
    type: 'ANALYST_FORECAST_SYNC',
    category: 'data_sync',
    owner: 'data',
    recommendedCron: '0 3 * * 1',
    description:
      '周一 03:00 全市场 sync 分析师研报 (AKShare stock_research_report_em). 解决 analyst_consensus factor std<0.02 真因.',
  },
  // BH-3 (2026-06-23): 股东户数全市场 sync — 真因 shareholder_counts 表只有 48 票
  // (factor effective 仅 38 票, std=0.0818 偏低). 与 BH-2 (analyst) 同款"一次性 backfill
  // 后无 cron"问题. 周三 02:00 错峰 (避开 ANALYST_FORECAST_SYNC 周一 03:00).
  // CLI 内置 skip-existing, 5500 票 × ~3s = ~4h.
  {
    type: 'SHAREHOLDER_COUNT_SYNC',
    category: 'data_sync',
    owner: 'data',
    recommendedCron: '0 2 * * 3',
    description:
      '周三 02:00 全市场 sync 股东户数 (AKShare stock_zh_a_gdhs_detail_em). 解决 shareholder_concentration factor std<0.10 真因.',
  },
  {
    type: 'LIMIT_UP_SYNC',
    category: 'data_sync',
    owner: 'data',
    description: '涨停板数据同步',
  },
  {
    type: 'NORTHBOUND_SYNC',
    category: 'data_sync',
    owner: 'data',
    description: '北向资金 / 港股通持股同步',
  },
  {
    type: 'SNOWBALL_HOT_KEYWORD_SYNC',
    category: 'data_sync',
    owner: 'data',
    recommendedCron: '0 16 * * *',
    description: '雪球热门话题词同步 (周末也跑 — 雪球周末仍有讨论)',
  },
  {
    type: 'STOCK_SENTIMENT_SYNC',
    category: 'data_sync',
    owner: 'data',
    recommendedCron: '30 16 * * *',
    description: '个股情绪聚合同步 (周末也跑 — 周末无新交易但用户讨论照旧)',
  },
  {
    type: 'MARKET_NEWS_SYNC',
    category: 'data_sync',
    owner: 'data',
    description: '宏观 / 行情新闻同步 (盘中 30min + 收尾 17:17, 17:17 全周 7 天)',
  },
  {
    type: 'SOCIAL_SENTIMENT_SYNC',
    category: 'data_sync',
    owner: 'data',
    recommendedCron: '20 16 * * *',
    description: '社交媒体 / 论坛情绪同步 (周末也跑 — 用户讨论 7×24)',
  },
  // PR-A (2026-06-29): 公告 NLP 全市场扫描. 之前只有 sync-announcements.ts CLI
  // 存在但没注册成 cron, 导致 announcement_summaries 表自 2026-06-09 后 0 更新.
  // 现在每天 17:00 跑当日全市场 (--all --with-ai=false 走启发式, 不调远端 AI),
  // 写 announcement_summaries.priority / event_type. critical 级会触发
  // CriticalAnnouncementPushService 推 OPS 飞书群. 周末也跑 — 公告系统周末仍有
  // 临时公告 (停牌 / 重大事项 / 风险提示).
  {
    type: 'ANNOUNCEMENT_NLP',
    category: 'data_sync',
    owner: 'data',
    recommendedCron: '0 17 * * *',
    description:
      '每天 17:00 全市场公告 NLP 抽取 (sync-announcements --all) → announcement_summaries.priority/event_type. critical 级会触发 CriticalAnnouncementPushService 推 OPS 飞书群. 周末也跑.',
  },
  // PR-A (2026-06-29): KOL 观点聚合 cron 接入. sync-kol-opinions.ts CLI 存在但
  // 之前从未被 cron 调用过, kol_opinions 整张表是空的. 现在每天 18:30 跑
  // --favorites --lookback-days=14 把用户收藏股票的 KOL 观点聚合落表, 给
  // NewsAnalyzer + BullishEventDetector 消费. 周末也跑 — 研报 / 媒体 / 集体市场
  // 周末仍有内容.
  {
    type: 'KOL_AGGREGATE',
    category: 'data_sync',
    owner: 'data',
    recommendedCron: '30 18 * * *',
    description:
      '每天 18:30 KOL 观点聚合 (sync-kol-opinions --favorites --lookback-days=14) → kol_opinions. NewsAnalyzer + BullishEventDetector 消费. 周末也跑.',
  },
  {
    type: 'MARKET_HOT_SEARCH_SYNC',
    category: 'data_sync',
    owner: 'data',
    description: '市场热搜词同步',
  },
  {
    type: 'DRAGON_TIGER_SYNC',
    category: 'data_sync',
    owner: 'data',
    description: '龙虎榜每日同步',
  },
  {
    type: 'EXTRA_DIMS_SYNC',
    category: 'data_sync',
    owner: 'data',
    description: '扩展维度 (estimize / 公告 NLP / qa-topic 等) 数据同步',
  },
  {
    type: 'DATA_QUALITY_SCAN',
    category: 'data_sync',
    owner: 'data',
    description: '数据质量深度扫描 (空表 / 旧数据 / 数据漂移)',
  },

  // ===== L2 因子 =====
  {
    type: 'FACTOR_SCORE_COMPUTE',
    category: 'factor',
    owner: 'quant',
    description: '因子打分日常计算',
  },
  {
    type: 'FACTOR_IC_COMPUTE',
    category: 'factor',
    owner: 'quant',
    description: '因子 IC 计算',
  },
  {
    type: 'FACTOR_CORRELATION_WEEKLY',
    category: 'factor',
    owner: 'quant',
    description: '周度因子相关性矩阵',
  },
  {
    type: 'COMPOSITE_REBALANCE',
    category: 'factor',
    owner: 'quant',
    description: '复合因子组合 rebalance',
  },

  // ===== L3 量化引擎 =====
  {
    type: 'QUANT_DAILY_PIPELINE',
    category: 'quant_engine',
    owner: 'quant',
    description: '量化主流水线 (扫描 → 信号 → AI 审批 → 模拟盘买入)',
  },
  {
    type: 'QUANT_PARAM_MAINTENANCE',
    category: 'quant_engine',
    owner: 'quant',
    description: '参数后验 / 推广 / 降级 / 回滚',
  },
  {
    type: 'QUANT_OPEN_WATCHDOG',
    category: 'quant_engine',
    owner: 'quant',
    intraday: true,
    description: '盘中 quant 健康守护 (异常时触发熔断)',
  },
  {
    type: 'AI_DAILY_SCREENER',
    category: 'quant_engine',
    owner: 'ai',
    description: 'AI 日级筛选器 (TradingAgents 批处理)',
  },
  {
    type: 'AUTO_RECOMMENDATION_LOOP',
    category: 'quant_engine',
    owner: 'ai',
    description: '推荐闭环 (生成 → 审批 → 评估 → 反馈)',
  },

  // ===== L4 模拟盘 =====
  {
    type: 'PAPER_TRADING_AUTO_SYNC',
    category: 'paper_trading',
    owner: 'paper',
    description: '模拟盘自动持仓同步 (订单状态 / 复盘 / 报告)',
  },
  {
    type: 'PAPER_TRADING_DAILY_PLAN',
    category: 'paper_trading',
    owner: 'paper',
    description: '日级模拟盘计划生成',
  },
  {
    type: 'PAPER_TRADING_DAILY_SNAPSHOT',
    category: 'paper_trading',
    owner: 'paper',
    description: '日终模拟盘净值快照',
  },
  {
    type: 'PAPER_TRADING_DAILY_DIGEST',
    category: 'paper_trading',
    owner: 'paper',
    description: '日终模拟盘摘要推送',
  },
  {
    type: 'PAPER_TRADING_ATTRIBUTION_REPORT',
    category: 'paper_trading',
    owner: 'paper',
    description: '模拟盘归因报告 (按因子 / 行业 / 信号)',
  },

  // ===== L4 风控 (基于 paper trading) =====
  {
    type: 'PAPER_TRADING_RISK_CHECK',
    category: 'risk_control',
    owner: 'risk',
    intraday: true,
    description: '模拟盘综合风控检查',
  },
  {
    type: 'PAPER_TRADING_TRAILING_STOP_UPDATE',
    category: 'risk_control',
    owner: 'risk',
    intraday: true,
    description: '动态止损价更新',
  },
  {
    type: 'PAPER_TRADING_TRAILING_STOP_CHECK',
    category: 'risk_control',
    owner: 'risk',
    intraday: true,
    description: '动态止损触发检查',
  },
  {
    type: 'PAPER_TRADING_DRAWDOWN_BREAKER_CHECK',
    category: 'risk_control',
    owner: 'risk',
    intraday: true,
    description: '组合最大回撤熔断',
  },
  {
    type: 'PAPER_TRADING_MARKET_REGIME_CHECK',
    category: 'risk_control',
    owner: 'risk',
    intraday: true,
    description: '市场风格切换告警',
  },
  {
    type: 'PAPER_TRADING_PER_STOCK_STOP_LOSS_CHECK',
    category: 'risk_control',
    owner: 'risk',
    intraday: true,
    description: '个股止损线检查',
  },
  {
    type: 'PAPER_TRADING_MORNING_CHECKUP',
    category: 'risk_control',
    owner: 'risk',
    description: '盘前晨检 (停牌 / ST / 退市 / 解禁等)',
  },
  {
    type: 'PAPER_TRADING_RESTRICTED_SHARE_CHECK',
    category: 'risk_control',
    owner: 'risk',
    description: '限售股解禁巡检',
  },
  {
    type: 'PAPER_TRADING_INDUSTRY_CONCENTRATION_CHECK',
    category: 'risk_control',
    owner: 'risk',
    intraday: true,
    description: '行业集中度告警',
  },
  {
    type: 'EQUITY_CURVE_GOVERNOR_DAILY_EVAL',
    category: 'risk_control',
    owner: 'risk',
    description: '组合净值守卫日评 (策略熔断 / 降仓)',
  },
  {
    type: 'STRATEGY_KILL_SWITCH_CHECK',
    category: 'risk_control',
    owner: 'risk',
    intraday: true,
    description: '策略级 kill switch 巡检 (失败率 / 连败 / pnl)',
  },

  // ===== L5 实盘相关 =====
  {
    type: 'LIVE_SHADOW_AUTOPILOT',
    category: 'live_trading',
    owner: 'live',
    description: '影子委托自动驾驶 (生成 + shadow 落单)',
    dryRunDefault: true,
  },
  {
    type: 'LIVE_SHADOW_WEEKLY_REVIEW',
    category: 'live_trading',
    owner: 'live',
    description: '影子委托周度复盘 + 预算调整建议',
  },
  {
    type: 'LIVE_RECONCILIATION_GUARD',
    category: 'live_trading',
    owner: 'live',
    description: '实盘对账守卫 (持仓 / 成交 / 资金对账)',
  },

  // ===== L6 信号 / 报表 / 分析 =====
  {
    type: 'SIGNAL_PERFORMANCE_REFRESH',
    category: 'analytics',
    owner: 'analytics',
    description: '信号 forward return 刷新',
  },
  {
    type: 'SIGNAL_QUALITY_DAILY_REPORT',
    category: 'analytics',
    owner: 'analytics',
    description: '信号质量日报',
  },
  {
    type: 'RECOMMENDATION_TRADE_OUTCOME_REFRESH',
    category: 'analytics',
    owner: 'analytics',
    description: '推荐 → 交易 → outcome 刷新',
  },
  {
    type: 'RESEARCH_INTEGRITY_BATCH_AUDIT',
    category: 'analytics',
    owner: 'analytics',
    description: '研究产物完整性审计',
  },
  {
    type: 'EARNINGS_FORECAST_WATCH',
    category: 'analytics',
    owner: 'analytics',
    description: '业绩预告监控 / 提醒',
  },
  {
    type: 'WEEKLY_REVIEW_EMAIL',
    category: 'analytics',
    owner: 'analytics',
    description: '周度复盘邮件',
  },
  {
    type: 'MARKET_BRIEF_GENERATE',
    category: 'analytics',
    owner: 'analytics',
    description: '盘前 / 盘中 / 盘后简报生成',
  },
  {
    type: 'ENHANCED_TRADING_JOURNAL_GENERATE',
    category: 'analytics',
    owner: 'analytics',
    description: '增强版交易日志生成',
  },
  {
    type: 'TCA_WEEKLY_REPORT',
    category: 'analytics',
    owner: 'analytics',
    description: 'TCA (Transaction Cost Analysis) 周报',
  },
  // US-083 PM-006 — 工作日 17:00 (盘后 + DAILY_UPDATE 18:00 前) 给所有 active
  // paper trading portfolio 生成 6 维归因报告并 upsert 到 daily_attribution_reports.
  // 默认 dry_run=false; portfolio_ids 显式 list (空 = 取全部 is_active=true);
  // ai_summary_source='off' 让 cron 跑零 AI 链路(走 heuristic); reference_date
  // 默认今日 Asia/Shanghai. fail-OPEN: 单 portfolio 失败 continue 不阻塞 batch.
  {
    type: 'DAILY_ATTRIBUTION_GENERATE',
    category: 'analytics',
    owner: 'analytics',
    recommendedCron: '0 17 * * 1-5',
    description:
      '工作日 17:00 给所有 active portfolio 生成 6 维归因 (factor/industry/timing/selection/sizing/execution_cost) 并落 daily_attribution_reports',
  },
  // US-091 PM-020 — 工作日 18:00 (盘后 + DAILY_ATTRIBUTION_GENERATE 17:00 之后)
  // 给所有 active user 生成 ≤ 500 字 AI 投资日记并 upsert ai_diary_entries.
  // 默认 dry_run=false + enable_llm=false (走 heuristic 零外网链路);
  // ops 显式启 LLM 改 ScheduledTask.parameters.enable_llm=true.
  // fail-OPEN: 单 user 失败 continue 不阻塞 batch.
  {
    type: 'AI_DIARY_GENERATE',
    category: 'analytics',
    owner: 'analytics',
    recommendedCron: '0 18 * * 1-5',
    description:
      '工作日 18:00 给所有 active user 生成 ≤ 500 字 AI 投资日记并 upsert ai_diary_entries',
  },
  // US-093 PM-022 — 每周日 10:00 (与 AI_DIARY_GENERATE 错峰) 给所有 active user
  // 聚合最近 90 天 DailyAttributionReport → 落 error_pattern_reports
  // (单 user 一周 = 一行 status='ok'/'skipped'/'failed' 三态都留痕).
  // 默认 dry_run=false + lookback_days=90 (走 heuristic 零外网); ops 可调
  // ScheduledTask.parameters.lookback_days 跑短窗口.
  // fail-OPEN: 单 user 失败 continue 不阻塞 batch.
  {
    type: 'WEEKLY_ERROR_PATTERN_AGGREGATE',
    category: 'analytics',
    owner: 'analytics',
    recommendedCron: '0 10 * * 0',
    description:
      '周日 10:00 给所有 active user 聚合最近 90 天 DailyAttributionReport → upsert error_pattern_reports',
  },
  // Macro 串联补丁 (2026-06-21) — US-094 PM-023 改进建议生成 cron 接入.
  // 周二 09:00: 错峰在 WEEKLY_ERROR_PATTERN_AGGREGATE (周日 10:00) 完成 1.5 天后,
  // 让上周 error pattern 已落库, 再聚合成 actionable suggestion. 每周一次足够,
  // 与 PM-023 service `(user_id, period_end, category, key)` UNIQUE 配合 upsert 幂等.
  // fail-OPEN: 单 user 失败 continue 不阻塞 batch (与 WEEKLY_ERROR_PATTERN_AGGREGATE
  // 同款 per-user try/catch + service 三层 fail-OPEN).
  {
    type: 'WEEKLY_IMPROVEMENT_SUGGESTION_GENERATE',
    category: 'analytics',
    owner: 'analytics',
    recommendedCron: '0 9 * * 2',
    description:
      '周二 09:00 给所有 active user 把最近 ErrorPatternReport → 生成 improvement_suggestions (heuristic 模板, fail-OPEN)',
  },
  // Macro 串联补丁 (2026-06-21) — US-146 PM-027 改进建议效果回采 cron 接入.
  // 每日 19:30: 错峰在 FACTOR_IC_COMPUTE (19:00) + DAILY_ATTRIBUTION_GENERATE
  // (17:00) 之后, 让当日所有 portfolio 的 attribution 已落库, 再算 apply 后 30 天
  // 的 effect_metrics. 默认 30 天 window, 仅处理 effect_tracked_at IS NULL 的 applied 行.
  // fail-OPEN 三层 (list throw / 单条 trackForSuggestion throw / writeBack 失败均不抛).
  {
    type: 'DAILY_IMPROVEMENT_EFFECT_TRACK',
    category: 'analytics',
    owner: 'analytics',
    recommendedCron: '30 19 * * *',
    description:
      '每日 19:30 扫 apply ≥ 30 天 + effect_tracked_at IS NULL 的 improvement_suggestions → 计算 effect_metrics 写回 (heuristic Sharpe, fail-OPEN)',
  },
  // US-038 QA-002 — 周一 02:00 (早于 AC "周一 04:00 前生成" 截止) 聚合上周
  // 全市场 (或 ScheduledTask.parameters.stock_codes 显式 list) 投资者问答按
  // (stock, week) 落 east_money_qa_stats 表.
  {
    type: 'WEEKLY_QA_STAT_AGGREGATE',
    category: 'analytics',
    owner: 'ai',
    recommendedCron: '0 2 * * 1',
    description: '周一 02:00 (≤ AC 04:00) 聚合上周投资者问答 → east_money_qa_stats',
  },

  // BF-4 (2026-06-23): 每日健康日报 - 工作日 21:00 (盘后 + ETF/归因/AI 报告均已落库)
  // 聚合 7 段 (实盘下单/草稿拒绝/模拟盘/cron 失败/RiskAlert HIGH+/AI 引擎/factor std=0)
  // 推 Lark OPS 群 + admin 邮箱 (复用 SystemAdminAlertPusher, dedup_key='daily-health:date')
  // level='INFO' (无论好坏每日 1 张; 真出事走 RiskAlert HIGH push 单独推)
  // fail-OPEN: per-section try/catch, 主流程不阻塞
  {
    type: 'DAILY_HEALTH_REPORT',
    category: 'analytics',
    owner: 'ops',
    recommendedCron: '0 21 * * 1-5',
    description:
      '工作日 21:00 聚合 7 段健康指标 (实盘/模拟/cron/告警/AI/factor) → Lark OPS 群 + admin 邮箱 (INFO 级, 每日 1 张)',
  },

  // ===== L7 清理 =====
  {
    type: 'CLEANUP_OLD_DATA',
    category: 'cleanup',
    owner: 'ops',
    description: '过期 backtest / log / alert 清理',
    dryRunDefault: true,
  },
  // Batch AL (2026-06-21) — SystemWorkspace 用户反馈闭环 cron 入口.
  // 每 30 分钟扫 user_feedbacks (status='pending' AND (reviewed_at IS NULL OR < now-6h))
  // 跑启发式分类器 (bug/feature_request/question/praise/other) + 优先级 1..5 + 摘要 ≤ 200 字,
  // 写回 ai_classification/ai_priority/ai_summary/reviewed_at. 真正 resolve 必须 admin 手工触发.
  {
    type: 'FEEDBACK_REVIEW_SWEEP',
    category: 'analytics',
    owner: 'product',
    recommendedCron: '*/30 * * * *',
    description:
      '每 30 分钟扫 pending 用户反馈 → 启发式分类 + 优先级 + 摘要 (cron 永不自动 resolve)',
  },
  // US-100 PR-011 — 每 30min 巡 5 类黑天鹅信号 (ST / SUSPENDED / NEWS_KEYWORD /
  // SHAREHOLDER_REDUCTION / MARKET_REGIME), 复用 BlackSwanWatchdog (US-053)
  // 当事件枚举器, 把跨 user 拍平 + (event_type, signature) 去重后 bulkCreate
  // BlackSwanEvent (PR-010); ignoreDuplicates: true 让 UNIQUE
  // (event_type, signature, detected_at::date) 拦的同事件静默跳过. 与 watchdog
  // per-user 写 RiskAlert 互补不取代 (本 cron 始终让 watchdog dry_run=true).
  // fail-OPEN: watchdog/bulkCreate 任一 throw → 仅 failed_items=1 + warn 不抛.
  {
    type: 'BLACK_SWAN_DETECT',
    category: 'risk_control',
    owner: 'risk',
    recommendedCron: '3,33 * * * *',
    description:
      '每 30min 巡 5 类黑天鹅信号 (ST/SUSPENDED/NEWS_KEYWORD/SHAREHOLDER_REDUCTION/MARKET_REGIME) → 落 BlackSwanEvent (global 视角, 与 BlackSwanWatchdog per-user RiskAlert 互补)',
  },
  // US-102 PR-013 — 每 30min 巡最近 24h BlackSwanEvent (PR-010) → 生成
  // BlackSwanPostmortemReport (PR-012). 4 段中本 cron 只负责第 1 段 event_summary;
  // PR-014/015/016 各自接力填 counterfactual_baselines / event_timeline /
  // improvement_suggestions. UNIQUE(black_swan_event_id) 让本 cron 重跑走 UPSERT
  // 仅覆盖 event_summary + generated_at + sections_filled — 其余 JSONB 段不出现在
  // payload 里, sequelize 不动它们 (保留 PR-014/015/016 已写值). 与 BLACK_SWAN_DETECT
  // 错峰 10min (3,33 → 13,43): detector 先把事件落表, postmortem 再读出来生成报告.
  // fail-OPEN: loadEvents throw → 整次 success=false + error; 单事件 upsert throw →
  // reports_failed +1 但不抛. status 初始 'partial', PR-014/015/016 全填后由它们升 'ok'.
  {
    type: 'BLACK_SWAN_POSTMORTEM',
    category: 'risk_control',
    owner: 'risk',
    recommendedCron: '13,43 * * * *',
    description:
      '每 30min 巡最近 24h BlackSwanEvent → UPSERT BlackSwanPostmortemReport (本 cron 只填 event_summary 段; PR-014/015/016 各自填其它 3 段)',
  },
  // US-103 PR-014 — 每 30min 扫最近 24h status='partial' 且 sections_filled 不含
  // 'counterfactual_baselines' 的 BlackSwanPostmortemReport, 对每行调
  // CounterfactualBaselineService 算 4 baseline (hold/zero/plan/perfect) 模拟,
  // UPDATE 仅覆盖 counterfactual_baselines + metadata.sections_filled + status
  // (其它 JSONB 段不出现在 payload, sequelize 不动它们; 保留 PR-013 已填的
  // event_summary, 与 [[多段 JSONB 报告分阶段 UPSERT]] 同款). 与
  // BLACK_SWAN_POSTMORTEM (13,43) 错峰 10min (23,53): PR-013 先填 event_summary →
  // 本 service 再补 counterfactual_baselines, 让 cron 跑顺序与段间依赖匹配.
  // fail-OPEN: loadCandidates throw → success=false + error; 单事件 engine /
  // upsert throw → skipped/failed 累计但不抛.
  {
    type: 'BLACK_SWAN_BASELINE',
    category: 'risk_control',
    owner: 'risk',
    recommendedCron: '23,53 * * * *',
    description:
      '每 30min 扫 partial postmortem → 算 4 baseline (hold/zero/plan/perfect) → UPDATE counterfactual_baselines 段 (PR-013 已填 event_summary; PR-015/016 各自填其它 2 段)',
  },
  // US-104 PR-015 — 每 30min 扫最近 24h status='partial' 且 sections_filled 不含
  // 'event_timeline' 的 BlackSwanPostmortemReport, 对每行调
  // EventTimelineReplayerService 把事件前 N 天 (默认 7) RiskAlert / BlackSwanWatchdog
  // 触发 (rule_id='black_swan' 的 RiskAlert) 排时间轴, UPDATE 仅覆盖 event_timeline
  // 段 + metadata.sections_filled + status (其它 JSONB 段不出现在 payload,
  // sequelize 不动它们; 保留 PR-013/014 已填的 event_summary/counterfactual_baselines,
  // 与 [[多段 JSONB 报告分阶段 UPSERT]] 同款). 与 BLACK_SWAN_BASELINE (23,53)
  // 错峰 10min (33,3): PR-014 先填 baseline → 本 service 再补 event_timeline,
  // 让 cron 跑顺序与段间依赖匹配 (3,33 detector → 13,43 postmortem →
  // 23,53 baseline → 33,3 timeline). fail-OPEN: loadCandidates throw →
  // success=false + error; 单事件 loadRiskAlerts / upsert throw → skipped/failed
  // 累计但不抛.
  {
    type: 'BLACK_SWAN_TIMELINE',
    category: 'risk_control',
    owner: 'risk',
    recommendedCron: '33,3 * * * *',
    description:
      '每 30min 扫 partial postmortem → 拉前 N 天 RiskAlert/Watchdog 触发排时间轴 → UPDATE event_timeline 段 (PR-013 已填 event_summary, PR-014 已填 counterfactual_baselines; PR-016 后续填 improvement_suggestions)',
  },
  // US-105 PR-016 — 每 30min 扫最近 24h status='partial' 且 sections_filled 不含
  // 'improvement_suggestions' 的 BlackSwanPostmortemReport, 对每行从已填段
  // (event_summary + counterfactual_baselines + event_timeline) 启发式归类
  // 4 类短板 (detection/response/execution/risk_control), 套模板生成建议, UPDATE
  // 仅覆盖 improvement_suggestions 段 + metadata.sections_filled + status (其它
  // JSONB 段不出现在 payload, sequelize 不动它们; 保留 PR-013/014/015 已填的
  // event_summary/counterfactual_baselines/event_timeline, 与 [[多段 JSONB 报告
  // 分阶段 UPSERT]] 同款). 与 BLACK_SWAN_TIMELINE (33,3) 错峰 10min (43,13):
  // PR-015 先填 timeline → 本 service 再补 improvement_suggestions, 让 cron 跑
  // 顺序与段间依赖匹配 (3,33 detector → 13,43 postmortem → 23,53 baseline →
  // 33,3 timeline → 43,13 improvement). 4 段全填后由本 service 升 status='ok'.
  // fail-OPEN: loadCandidates throw → success=false + error; 单事件 engine /
  // upsert throw → skipped/failed 累计但不抛.
  {
    type: 'BLACK_SWAN_IMPROVEMENT',
    category: 'risk_control',
    owner: 'risk',
    recommendedCron: '43,13 * * * *',
    description:
      '每 30min 扫 partial postmortem → 4 类短板归类 + 模板建议生成 → UPDATE improvement_suggestions 段 (PR-013/014/015 已填前 3 段; 本段为 4 段最后一段, 通常升级 status=ok)',
  },
  // US-134 PR-019 — 每季度首日 09:05 扫上一季 BlackSwanEvent 全量, 按 event_type
  // / severity / scope / symbol 聚合 + 高严重事件高亮, 渲染 HTML 邮件发给
  // QUARTERLY_BLACK_SWAN_RECIPIENTS env 列表收件人 (与 WeeklyReviewReportService
  // US-065 同款 EmailNotificationService channel). 与单事件复盘 (PR-013/014/015/016)
  // 互补 — 季度报告关注 "上季 black swan 风险面" 总览, 单事件报告关注根因分析.
  // dry_run=true → 仅返聚合 payload, 不发邮件 (UI / ops 预览). fail-OPEN: loadEvents
  // throw → success=false + error + failed_items=1 warn 不抛; 单收件人发送失败
  // → 累计 failed 但其它收件人继续. 收件人空 → skipped (success=true).
  {
    type: 'BLACK_SWAN_QUARTERLY_SUMMARY',
    category: 'risk_control',
    owner: 'risk',
    recommendedCron: '5 9 1 1,4,7,10 *',
    description:
      '每季首日 09:05 把上一季全量 BlackSwanEvent 聚合 (event_type/severity/scope/top_symbols/critical+high 高亮) → HTML 邮件发给 ops 收件人列表',
  },
  // US-095 OPS-006 — 每 5min 扫 webhook_fallback_log status='pending' AND
  // next_retry_at <= NOW(), 透传 sender 重投递; 成功 → 'sent', 失败 attempts+=1
  // + 指数 backoff; attempts >= max_attempts → 'dead'. 主流程 (FeishuBotWebhookService)
  // 已 fail-OPEN, 本 cron 是"为了不丢消息"的第二道防线.
  {
    type: 'WEBHOOK_FALLBACK_RETRY',
    category: 'cleanup',
    owner: 'ops',
    recommendedCron: '*/5 * * * *',
    description: '每 5min 扫 webhook_fallback_log pending 行重投递',
  },
  // US-096 OPS-007 — 每日 02:00 跑 scripts/backup-db.sh: pg_dump → gzip →
  // backups/YYYY-MM-DD.sql.gz + 自动清 30 天前旧备份. shell 自己有 retention
  // purge, 服务层只负责 spawn + 扫文件 + 写 task_execution_logs.
  // fail-OPEN: spawn 失败仅写 failed_items=1 + warn 日志, 不抛.
  // dry_run=true 仅扫现有备份不 spawn (供 ops 在生产 cron 前预览).
  {
    type: 'DB_BACKUP',
    category: 'cleanup',
    owner: 'ops',
    recommendedCron: '0 2 * * *',
    description: '每日 02:00 全库 pg_dump → backups/YYYY-MM-DD.sql.gz, 保留 30 天',
  },
  // CE-B (2026-06-26) — 盘中实时机会规则引擎.
  // 每 3min 拉 IntradayUniverseService.resolveUniverse() (≤500 票) → 跑 10 类
  // detector → 命中走 analyzeStock 二次审核 (overall_confidence × 100 ≥ 65) →
  // 调 intradayOpportunityPusher.push (内置 dedup / circuit breaker / 飞书 fan-out).
  // ops 在生产 INSERT 新 ScheduledTask 行启用; 默认不在 ensureDefaultTasks 强加.
  {
    type: 'INTRADAY_OPPORTUNITY_SCAN',
    category: 'quant_engine',
    owner: 'quant',
    intraday: true,
    recommendedCron: '*/3 9-11,13-14 * * 1-5',
    description: '盘中 3min 跑 10 类机会规则 → analyzeStock 二次审核 → 飞书机会卡片推送',
  },
  // PR-B (2026-06-29) — 利好事件主动推送. 用户原话 "周末利好华工科技的新闻你看到了吗,
  // 这类新闻你需要发消息提示我". 系统缺一条主动扫"利好新闻 / 业绩预喜公告 / 关注度突
  // 增 / KOL 集中看多"的链路, 本 cron 每 30min 跑一次 4 detector, 命中即写 RiskAlert
  // (level=MEDIUM, rule_id='stock_bullish_event') + 推 OPS 飞书群. 24h dedup 通过
  // RiskAlert.message 末尾追加 [dedup_key:STOCK:DETECTOR:YYYY-MM-DD] 实现. 周末也跑.
  {
    type: 'BULLISH_EVENT_DETECT',
    category: 'risk_control',
    owner: 'quant',
    recommendedCron: '*/30 * * * *',
    description:
      '每 30 分钟扫描用户持仓 + 自选 + 近 30 日推荐过的股票, 4 类利好 detector (critical 公告 / 正面新闻 / 关注度突增 / KOL 集中关注), 命中写 RiskAlert + 飞书 OPS 群. 24h dedup. 用户 2026-06-28 诉求落地.',
  },
  // PR-M2 (2026-06-29) — 集合竞价 snapshot + 30-min K 线 + 日内动量 detector.
  // 学术依据: Han/Hu/Jia 2023 SSRN (集合竞价信息含量) + Zhang/Ma/Zhu 2019 EM (9:30-10:00 预测 14:30-15:00, 中国市场最 robust).
  {
    type: 'AUCTION_SNAPSHOT_SYNC',
    category: 'data_sync',
    owner: 'quant',
    intraday: true,
    recommendedCron: '25 9 * * 1-5',
    description:
      'PR-M2 集合竞价撮合后 (9:25) 拉 universe ~500 票开盘价 + 量 + 昨收, 计算 7+1 战法 pattern → 写 auction_snapshots.',
  },
  {
    type: 'INTRADAY_KLINE_30MIN_SYNC',
    category: 'data_sync',
    owner: 'quant',
    intraday: true,
    recommendedCron: '5 10,11,13,14 * * 1-5',
    description:
      'PR-M2 盘中每 30 分钟拉 universe ~500 票当日 30-min K 线 → 写 intraday_klines_30min.',
  },
  {
    type: 'INTRADAY_MOMENTUM_DETECT',
    category: 'risk_control',
    owner: 'quant',
    intraday: true,
    recommendedCron: '25 14 * * 1-5',
    description:
      'PR-M2 14:25 跑日内动量 detector. r1>+1% buy 推全 user, r1<-1% 持仓 sell. 论文: Zhang/Ma/Zhu 2019 EM.',
  },
]);

const CRON_REGISTRY_BY_TYPE: ReadonlyMap<string, CronTaskDefinition> = new Map(
  CRON_REGISTRY.map(def => [def.type, def])
);

export function getCronTaskDefinition(type: string): CronTaskDefinition | undefined {
  return CRON_REGISTRY_BY_TYPE.get(type);
}

export function isRegisteredCronType(type: string): boolean {
  return CRON_REGISTRY_BY_TYPE.has(type);
}

export function listRegisteredCronTypes(): string[] {
  return CRON_REGISTRY.map(def => def.type);
}

export interface CronRegistryDumpLine {
  type: string;
  category: CronTaskCategory;
  owner: string;
  recommendedCron?: string;
  intraday?: boolean;
  description: string;
}

/**
 * 把 CRON_REGISTRY 序列化成稳定排序的 dump 行 (供 SchedulerService 启动日志使用)。
 * 同一 category 内按 type 字母序, category 之间按固定顺序。
 */
export function buildCronRegistryDump(): CronRegistryDumpLine[] {
  const categoryOrder: CronTaskCategory[] = [
    'data_sync',
    'factor',
    'quant_engine',
    'paper_trading',
    'risk_control',
    'live_trading',
    'analytics',
    'cleanup',
  ];
  const byCategory = new Map<CronTaskCategory, CronTaskDefinition[]>();
  for (const def of CRON_REGISTRY) {
    if (!byCategory.has(def.category)) byCategory.set(def.category, []);
    byCategory.get(def.category)!.push(def);
  }
  const lines: CronRegistryDumpLine[] = [];
  for (const cat of categoryOrder) {
    const defs = byCategory.get(cat) || [];
    defs.sort((a, b) => a.type.localeCompare(b.type));
    for (const d of defs) {
      lines.push({
        type: d.type,
        category: d.category,
        owner: d.owner,
        recommendedCron: d.recommendedCron,
        intraday: d.intraday,
        description: d.description,
      });
    }
  }
  return lines;
}

/**
 * 比对一组 DB task type 与 registry, 返回未在 registry 中的 type 列表。
 * SchedulerService 启动时用这个识别"配置漂移": DB 有 type 但代码 / 文档没登记。
 */
export function findUnregisteredTypes(dbTypes: Iterable<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of dbTypes) {
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    if (!isRegisteredCronType(t)) out.push(t);
  }
  out.sort();
  return out;
}
