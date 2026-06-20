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
  {
    type: 'REALTIME_QUOTE_SYNC',
    category: 'data_sync',
    owner: 'data',
    intraday: true,
    description: '盘中实时行情快照刷新 (TradingAgents prompt 数据源)',
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
    description: '雪球热门话题词同步',
  },
  {
    type: 'STOCK_SENTIMENT_SYNC',
    category: 'data_sync',
    owner: 'data',
    description: '个股情绪聚合同步',
  },
  {
    type: 'MARKET_NEWS_SYNC',
    category: 'data_sync',
    owner: 'data',
    description: '宏观 / 行情新闻同步',
  },
  {
    type: 'SOCIAL_SENTIMENT_SYNC',
    category: 'data_sync',
    owner: 'data',
    description: '社交媒体 / 论坛情绪同步',
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

  // ===== L7 清理 =====
  {
    type: 'CLEANUP_OLD_DATA',
    category: 'cleanup',
    owner: 'ops',
    description: '过期 backtest / log / alert 清理',
    dryRunDefault: true,
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
