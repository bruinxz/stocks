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
  /**
   * 已下线墓碑: 底层 service 在批5移除, SchedulerService 仅保留空跑 dispatch 分支
   * 防止 DB 存量任务触发 `Unsupported task type` 抛错. ensureDefaultTasks 不再 seed,
   * 也不应有新 DB 任务使用. 登记在此仅为通过 cron-registry 双向一致性单测 (dispatch 有→registry 必须有).
   */
  retired?: boolean;
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
  // 实时行情快照刷新：每 5 分钟触发一次，handler 内再用 A 股连续竞价时段
  // (09:30-11:30, 13:00-15:00) 做精确 guard，避免集合竞价和午休空转。
  {
    type: 'REALTIME_QUOTE_SYNC',
    category: 'data_sync',
    owner: 'data',
    intraday: true,
    recommendedCron: '*/5 9-11,13-14 * * 1-5',
    description: 'A 股连续竞价期间每 5 分钟刷新行情；处理器会跳过集合竞价与午休窗口',
  },
  {
    type: 'GLOBAL_MARKET_DAILY_SYNC',
    category: 'data_sync',
    owner: 'data',
    recommendedCron: '0 9 * * *',
    description:
      '每日 09:00 刷新 A 股日报快照、JP/KR 市场水位、美股科技板块/代表股/ETF 与海外催化摘要',
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
  {
    // 批5 墓碑: MarketSentimentIndexService 移除, SchedulerService 仅空跑分支.
    type: 'MARKET_SENTIMENT_INDEX_SYNC',
    category: 'data_sync',
    owner: 'quant',
    retired: true,
    description: '[已下线] 市场情绪指数同步 — 批5 移除 service, 保留空跑分支防存量任务报错',
  },
  // Path C.3 (2026-07-09): TradingCalendarSyncService.syncRange daily 增量同步.
  // Path A M0.5 Day 3 trading_calendar 契约冻结 (PR #94) + Path C 三方完形 (PR #96/#98/#100/#103)
  // + Path C.2 韧性件三合一 (PR #106 retryWithBackoff [1s,2s,4s] + AKShare fallback + HALF_DAY
  // populate) 后 daily 生产验证位承接. 每日 03:00 Asia/Shanghai 增量拉 T-1 至 T+30 rolling
  // window 保证 §D4.1 α PIT next_trade_date(time) code truth 永久兑现 (未来 30 交易日窗口 unblock).
  // idempotent upsert (trade_date PK) · fail-OPEN warn 不抛 (与 ETF_FLOW_SYNC 一致 pattern).
  // seed 首版 is_active=false, ops 手动激活 (与 REALTIME_QUOTE_SYNC intraday 模式同 pattern).
  {
    type: 'TRADING_CALENDAR_SYNC',
    category: 'data_sync',
    owner: 'data',
    recommendedCron: '0 3 * * *',
    description:
      '每日 03:00 (Asia/Shanghai) 增量同步 trading_calendar T-1 至 T+30 rolling window (Baostock 主 + AKShare fallback + retryWithBackoff 三档 · idempotent upsert · Path C.2 韧性件生产验证位)',
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
    type: 'FINANCIAL_REPORT_SYNC',
    category: 'data_sync',
    owner: 'data',
    recommendedCron: '0 1 * * 0',
    description:
      '周日 01:00 按最新报告期批量同步全市场业绩报表，为 growth / quality_high / earnings_surprise 提供真实事实源。',
  },
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
    type: 'DERIVED_FACTOR_SYNC',
    category: 'data_sync',
    owner: 'data',
    recommendedCron: '0 17 * * 1-5',
    description: '派生因子(估值/质量/资金流)落库 — 东方财富免费源, ETF 因子轮动(Core 70%)命脉数据',
  },
  {
    type: 'INDEX_COMPONENT_SYNC',
    category: 'data_sync',
    owner: 'data',
    recommendedCron: '0 7 * * 1',
    description: '宽基指数成份股同步(AKShare) — 供 ETF→成份股展开做因子横截面',
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
    // 批5 墓碑: QuantRecommendationService 移除, 全市场量化候选池不再产出.
    type: 'AI_DAILY_SCREENER',
    category: 'quant_engine',
    owner: 'quant',
    retired: true,
    description: '[已下线] AI 每日选股 — 批5 移除 service, 保留空跑分支防存量任务报错',
  },
  {
    // 批5 墓碑: AutomatedRecommendationLoopService 移除, 全市场荐股闭环停用.
    type: 'AUTO_RECOMMENDATION_LOOP',
    category: 'quant_engine',
    owner: 'quant',
    retired: true,
    description: '[已下线] 全市场自动荐股闭环 — 批5 移除 service, 保留空跑分支防存量任务报错',
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
    type: 'RESEARCH_TRADING_LOOP',
    category: 'paper_trading',
    owner: 'paper',
    intraday: true,
    recommendedCron: '35,50 9 * * 1-5',
    description: 'A股早报 + 高倍潜力联合决策并驱动唯一研究闭环模拟盘；09:50 幂等补跑',
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
    retired: true,
    description:
      '[已下线] 限售股解禁巡检 — RestrictedShareWatchdog 与其持久化模型已移除，仅保留存量任务墓碑',
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
    // 批5 墓碑: StrategyKillSwitchMonitor 移除, 熔断改由 EquityCurveGovernor.
    type: 'STRATEGY_KILL_SWITCH_CHECK',
    category: 'risk_control',
    owner: 'quant',
    retired: true,
    description:
      '[已下线] 策略熔断检查 — 批5 移除 service (熔断改由 EquityCurveGovernor), 保留空跑分支防存量任务报错',
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
    // 批5 墓碑: EarningsForecastWatcher 移除.
    type: 'EARNINGS_FORECAST_WATCH',
    category: 'data_sync',
    owner: 'quant',
    retired: true,
    description: '[已下线] 业绩预告监控 — 批5 移除 service, 保留空跑分支防存量任务报错',
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
  // US-102 PR-013 — 每 30min 巡最近 24h BlackSwanEvent (PR-010) → 生成
  // BlackSwanPostmortemReport (PR-012). 4 段中本 cron 只负责第 1 段 event_summary;
  // PR-014/015/016 各自接力填 counterfactual_baselines / event_timeline /
  // improvement_suggestions. UNIQUE(black_swan_event_id) 让本 cron 重跑走 UPSERT
  // 仅覆盖 event_summary + generated_at + sections_filled — 其余 JSONB 段不出现在
  // payload 里, sequelize 不动它们 (保留 PR-014/015/016 已写值). 错峰链
  // (13,43 postmortem → 23,53 baseline → 33,3 timeline → 43,13 improvement) 上游
  // BlackSwanEvent 读端由外部写入源承担 (本 cron 只消费).
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
  // 让 cron 跑顺序与段间依赖匹配 (13,43 postmortem → 23,53 baseline →
  // 33,3 timeline). fail-OPEN: loadCandidates throw →
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
  // 顺序与段间依赖匹配 (13,43 postmortem → 23,53 baseline →
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
  // 飞书统一通知 outbox worker。业务路径先落库；即时投递失败后由这里持久化补投。
  {
    type: 'FEISHU_NOTIFICATION_DISPATCH',
    category: 'cleanup',
    owner: 'ops',
    recommendedCron: '*/5 * * * *',
    description: '每 5min 扫 feishu_notification_outbox 的 due/retry/stale-lock 通知并投递',
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
  // PR-M3 (2026-06-29) — 板块情绪指数日度聚合. 学术 + 大 V 共识 (龙头战法 4 核心因子:
  // 涨停数 / 连板高度 / 封板率 / 炸板率) + 30 日板块动量 z-score. 工作日 16:00 跑
  // (limit_up sync 在 15:35-15:40 之后), 给推荐 service 消费做 "龙头板块加权 / 弱势板块 skip".
  // PR-O5 (2026-06-30) — 题材发酵 5 阶段 detector. 消费 PR-M3 industry_sentiment_indices
  // (16:00 写完) + 昨日 phase, 给每个板块打 germinate/launch/outbreak/climax/recession 标签 +
  // 主线切换检测. 工作日 16:30 跑.
  {
    type: 'THEME_FERMENTATION_DETECT',
    category: 'analytics',
    owner: 'quant',
    recommendedCron: '30 16 * * 1-5',
    description:
      '工作日 16:30 跑题材发酵 5 阶段 detector — 消费 industry_sentiment_indices + 昨日 phase, 给每个板块打 germinate/launch/outbreak/climax/recession 标签 + 检测主线切换. PR-I-v2 §6.4 板块/题材轮动战法落地. 给推荐 service 用 "启动/爆发推次龙头, 高潮 reduce, 退潮换主线" 决策.',
  },
  // 批6 (2026-07) — ETF 因子轮动月度再平衡. 信号优先重构主线核心 (Core 70%),
  // 替代旧 29 策略融合. 每月 1 号 09:30 跑四因子打分 (Value/Quality/LowVol) top4买/
  // top6卖缓冲带, 落 AIInvestmentSignal(action=TARGET_WEIGHT, rebalance_id).
  {
    type: 'ETF_FACTOR_ROTATION_REBALANCE',
    category: 'analytics',
    owner: 'quant',
    recommendedCron: '30 9 1 * *',
    description:
      '每月 1 号 09:30 跑 ETF 因子轮动月度再平衡 — 46-63 只候选 ETF 四因子打分 (Value 0.40 / Quality 0.30 / LowVol 0.30 / Momentum shadow), top4 买 / top6 卖缓冲带, 单只<=15% 核心总仓<=70%, 落 action=TARGET_WEIGHT 信号供 V3 展示 + paper 执行. 信号优先重构主线核心 (Core 70%).',
  },
  // 批6d (2026-07, §4.3) — 现金 10% 闲置管理. 收益现金 5% 配国债 ETF 511010 / 短融 ETF 511360,
  // 应急现金 5% 留活期不落信号. 每月 1 号 09:35 (核心再平衡后) 跑.
  {
    type: 'CASH_ALLOCATION_REBALANCE',
    category: 'analytics',
    owner: 'quant',
    recommendedCron: '35 9 1 * *',
    description:
      '每月 1 号 09:35 (核心再平衡后) 跑现金 10% 闲置管理 (§4.3) — 收益现金 5% 均分到国债 ETF 511010 / 短融 ETF 511360 (各 2.5%, 年化~3%), 落 action=TARGET_WEIGHT 信号 (source_type=cash_management, bucket=cash); 应急现金 5% 留活期(~2%)不落信号. 现金层压舱石不做短线. 主线现金 (Cash 10%) 层.',
  },
  // 批6d (2026-07, §6.1) — 合规 RSS 财经新闻入库. 拉新浪/财联社等 RSS, 关键词题材兜底打
  // industry 标签, 落 market_news (幂等 + 30 天保留). 主线数据基础的一半 (公告半=sync-announcements).
  {
    type: 'RSS_NEWS_SYNC',
    category: 'data_sync',
    owner: 'quant',
    recommendedCron: '*/30 9-15 * * 1-5',
    description:
      '交易日盘中每 30 分钟拉合规 RSS 财经源 (新浪财经 / 财联社, feed 可用 RSS_NEWS_FEEDS 环境变量覆盖) — 极简正则解析 item, matchTheme 关键词字典兜底打 industry 标签, findOrCreate 落 market_news (主键 publish_time+title_hash 幂等, 30 天保留期自动清理). 排除爬虫与付费终端 (§6.1 合规). 只写 market_news 不产信号, 供题材探测器/fan-out 消费. 主线数据源 (RSS 主渠道) 层.',
  },
  // 批6c (2026-07, §6.2-B) — 卫星题材 fan-out. ThemeFermentationDetector 是 soft-layer 只写
  // theme_fermentation_phases; 本 cron 读当日 phase 把 top_codes 扇出成个股信号进主信号表.
  // 工作日 17:00 跑 (在 THEME_FERMENTATION_DETECT 16:30 之后).
  {
    type: 'THEME_EVENT_FANOUT',
    category: 'analytics',
    owner: 'quant',
    recommendedCron: '0 17 * * 1-5',
    description:
      '工作日 17:00 跑卫星题材 fan-out — 读当日 theme_fermentation_phases, 把 launch/outbreak 题材 top_codes 扇出成个股 BUY 信号 (climax → SELL 减仓, recession/germinate → skip), 落 AIInvestmentSignal(source_type=theme_event, action=BUY/SELL, theme_id, 卫星 -7% soft 止损 / +20% 止盈). 信号优先重构卫星 (Satellite 20%) 主信号产出层 (§6.2-B).',
  },
  // 批6d (2026-07, §4.2) — 卫星自动退出. 每日 EOD 扫卫星仓做硬止损/止盈/时间退出/主动止损,
  // 走 executeGuardSells; 组合级 60 日滚动亏损冻结 + 连续 3 月 alpha<0 永久停. 工作日 15:10.
  {
    type: 'SATELLITE_AUTO_EXIT',
    category: 'analytics',
    owner: 'quant',
    recommendedCron: '10 15 * * 1-5',
    description:
      '工作日 15:10 (收盘后) 跑卫星自动退出 (§4.2) — 扫 theme_event 卫星持仓, 按 -15% 硬止损 / +20% 止盈 / 21 交易日时间退出 / -7% 主动止损(主题仍活跃且盘中反弹>3% 时缓冲 T+1 复核) 裁决, 走 executeGuardSells 保留完整记账链. 组合级风控: 60 日滚动窗口卫星累计亏损 >5% 冻结卫星 30 天; 自然月连续 3 月 alpha<0 永久停用卫星资金归核心. 卫星 (Satellite 20%) 退出执行层.',
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
