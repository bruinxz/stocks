# 2026-06-21 端到端真实数据验证（不信代码层证据）

**主审日**: 2026-06-21 21:30 CST
**Prod**: `103.242.3.87:14126`, `/opt/stocks/current/backend` (release `20260621153239-main`)
**Backend service start**: `2026-06-21 20:55:03 CST`
**Dist 最新文件 mtime**: `2026-06-21 20:54:33`（服务启动早于最新 dist 30 秒，OK）
**前端 build mtime**: `2026-06-21 20:46`（早于服务，亦 OK）
**main HEAD**: `bdd0629`

## 总评

**14 个"声称已修但实际未生效/不到位"的问题**。其中 5 个属于"功能上线但 prod 0 行/0 调用"，6 个属于"数据陈旧/coverage 不足"，3 个属于"配置脏 (重复/Never run)"。前两类直接说明：本周提交的代码大量没有发挥设计预期。

---

## 1. AI 多维分析引擎 (multi_dim_v1) 真实使用量 = 0

**SQL**:
```sql
SELECT engine_variant, COUNT(*) FROM ai_stock_analysis_reports GROUP BY engine_variant;
SELECT COUNT(*) FROM ai_stock_analysis_reports WHERE engine_variant = 'multi_dim_v1';
SELECT COUNT(*) FROM ai_investment_signals WHERE source_type = 'analysis_engine';
SELECT COUNT(*) FROM ai_stock_analysis_reports WHERE shadow_of_report_id IS NOT NULL;
```

**输出**:
- `ai_stock_analysis_reports` 总数 = 2 (全部 `engine_variant='tradingagents_legacy'`)
- `multi_dim_v1` 报告数 = **0**
- `source_type='analysis_engine'` 信号数 = **0**
- shadow 报告数 = **0**

**期望**: Batch AI/AJ/AK/AO/AQ 几个 patch 反复写"AI 多维分析引擎闭环上线"、"shadow mode + hard cutover 完成"。线上至少应该有几十到上百条 `multi_dim_v1` 报告 + 影子比对。

**差距**: 引擎"上线"了，**真实业务路径完全没走它**。`ai_polling_tasks` 表都不存在（grep dist/ 也找不到），说明触发链条根本没有 wire 到生产请求里。前端"AI 多维分析引擎"节点显示 gray 也正是这个事实。

**修复**:
- 立刻把 AIAdvisorService 的入口 wire 到 `maybeRunHardShortCircuit` 至少 shadow 模式
- 或加一个 `ANALYSIS_ENGINE_BATCH_RUN` cron，每天对 portfolio 持仓股 + watchlist 跑一遍并归档到 `ai_investment_signals(source_type='analysis_engine')`
- 加 prod 监控: `multi_dim_v1` 周报告数 < 10 时告警

---

## 2. AI 分析引擎在 prod 直接调用就崩 (Sequelize 模型未注册)

**命令**: 在 prod node REPL 调用 `analysisEngineService.analyzeStock('688008', { userId: 1 })`

**输出（核心错误）**:
```
EventIntelligence isHardBlocked 失败 (sh.688008): Model not initialized:
  Member "findOne" cannot be called. "Stock" needs to be added to a Sequelize instance.
EventIntelligence isInEarningsWindow 失败: "EarningsForecast" needs to be added to a Sequelize instance.
KOLAggregator.loadResearchReports failed: "AnalystForecast" needs to be added to a Sequelize instance.
KOLAggregator.fetchETFFlow failed: "Stock" needs to be added to a Sequelize instance.
EventIntelligence loadNorthboundDelta5d 失败: "NorthboundHolding" needs to be added to a Sequelize instance.
EventIntelligence loadDragonTigerSummary 失败: "DragonTigerBoard" needs to be added to a Sequelize instance.
```

**期望**: 引擎调用应返回完整 8 维度 score + confidence。

**差距**: 模块级 `require('./AnalysisEngineService')` 没有触发 models/index 的 `defineModels(sequelize)` 注册流程。当后台 cron 触发引擎时也会同样静默失败 —— 这就是 #1 里 multi_dim_v1=0 的更深层原因。`tradingagents_legacy` 路径有 `connect ECONNREFUSED 47.93.224.109:8000`（python sidecar 也挂着）。

**修复**:
- AnalysisEngineService 模块顶端补 `require('../models')` 或在 service 内的 dataSource adapter 用 `models` registry 而非裸 model class
- 加 boot-time integration test: 启动后 1 分钟内对 1 票跑一次 dry-run，失败发告警

---

## 3. KOLAggregator akshare python sidecar 完全挂掉

**输出（多次出现）**:
```
KOLAggregator.fetchPolicyDirectives(688008) failed: Python script failed (exit=1):
  ModuleNotFoundError: No module named 'akshare'
KOLAggregator.fetchHotConcepts: ModuleNotFoundError: No module named 'akshare'
KOLAggregator.fetchNews: ModuleNotFoundError: No module named 'akshare'
[KOLAggregator] stock=688008 collected 0 (research=0 news=0 concept=0 etf=0 policy=0) persisted=false
```

并且 `kol_opinions` 表近 7 天 0 行：
```sql
SELECT COUNT(*) FROM kol_opinions WHERE created_at > NOW() - INTERVAL '7 days';  -- 0
```

**期望**: 政策、热点概念、新闻聚合该有 KOL signal 落库。

**差距**: prod 部署后没装 `akshare` python 包。AnnouncementClient / LimitDownClient / MarginBalanceClient / StockQAClient 都用同一个 sidecar，全部 fallback。

**修复**:
- `pip3 install akshare` on prod & add to deploy script
- 加 boot self-test: 启动后 ping 一次 `akshare_helper.py --healthcheck`，失败告警

---

## 4. 7 个"L8 闭环"功能 prod 数据全 0

**SQL & 输出**:
| 表 | 行数 | 最新 | 期望 |
|---|---|---|---|
| `ai_stock_analysis_reports` (multi_dim_v1) | 0 | NULL | 每天若干 |
| `ai_diary_entries` | **0** | NULL | 日记 cron 每日 1 条 |
| `improvement_suggestions` | **0** | NULL | 周报至少 1 条 |
| `black_swan_events` | **0** | NULL | 即使无事件也应记录 fired-but-clean cron 心跳 |
| `user_feedbacks` | 0 | - | 表存在 OK |
| `kol_opinions` 7d | 0 | NULL | 应有 |
| `weekly_review_*` table | **不存在** | - | 周报应有归档 |

**期望**: 这些是 Batch AH/AI/AK/AM/AN/AQ 主打的功能。

**差距**: 前端 system topology 7 个"L8"节点 (gray) 的 status 正好对应：
```
gray   improvement_suggestions   改进建议闭环
gray   black_swan_postmortem    黑天鹅复盘
gray   ai_diary                 AI 日记
gray   user_feedback            用户反馈
gray   trade_reason             操作理由覆盖率
gray   daily_attribution        每日归因  ← 见 #7 其实有数据
gray   ai_analysis_engine_v2    AI 多维分析引擎
```

**修复**: 每个 gray 节点都要给一条"为什么 0"的 root cause + acceptance test。先抓最大头：AI 引擎入口（#1/#2）和 ai_diary cron（#9）。

---

## 5. `trade_reason` 写入率 100% 失败（功能上线 = 0 行命中）

**SQL**:
```sql
SELECT COUNT(*) FROM paper_trading_trades WHERE trade_reason::text != '{}';
SELECT COUNT(*) FROM paper_trading_trades WHERE trade_reason_summary IS NOT NULL;
SELECT id, direction, trade_reason, trade_reason_summary FROM paper_trading_trades ORDER BY created_at DESC LIMIT 5;
```

**输出**:
- 全表 0 行有 trade_reason
- 全表 0 行有 trade_reason_summary
- 最近 5 笔 (6/18) 全部 `trade_reason='{}'`、`trade_reason_summary=null`

**期望**: PaperTradingFacade / RebalanceEngine / GuardSellExecutor / IndustryConcentrationGuard 都通过 `tradeReasonBuilder` 注入，Task #48-57 已完成。

**差距**: ⚠️ **数据上线时间盲区**：最近一笔交易是 `2026-06-18 05:45`，**当前 build 是 6/21 20:46**。所以"全 0"的样本全部来自 trade_reason patch 部署之前。但既然部署 3 天来 0 笔交易，说明 paper trading 主循环可能也停了 — 这是另一个隐患。

**修复**:
- 验证 paper trading 主循环（PAPER_TRADING_RISK_CHECK 等）是不是 6/18 之后真在跑，但因为周末没产出交易（合理）
- 周一 6/22 复盘：抓一笔新 trade 看 reason 是否真有写入
- 加 cron `WEEKLY_TRADE_REASON_COVERAGE` 检查覆盖率 < 95% 告警

---

## 6. `scheduled_tasks` 重复 cron 11 个 type

**SQL**:
```sql
SELECT type, COUNT(*) FROM scheduled_tasks WHERE is_active=true GROUP BY type HAVING COUNT(*)>1;
```

**输出 (11 个 type 各有 2 行)**:
```
EARNINGS_FORECAST_WATCH         (id=26 cron="*/15 9-15 * * 1-5", id=27 cron="35 15 * * 1-5")
EQUITY_CURVE_GOVERNOR_DAILY_EVAL (id=42, id=74)
LIVE_RECONCILIATION_GUARD       (id=75, id=76) ← 两条都 NEVER 跑过
MARKET_NEWS_SYNC                (id=65, id=66)
PAPER_TRADING_DRAWDOWN_BREAKER_CHECK (id=49, id=53)
PAPER_TRADING_TRAILING_STOP_UPDATE (id=40, id=51)
PAPER_TRADING_TRAILING_STOP_CHECK (id=48, id=52)
PAPER_TRADING_MARKET_REGIME_CHECK (id=39, id=54)
PAPER_TRADING_PER_STOCK_STOP_LOSS_CHECK (id=50, id=55)
QUANT_DAILY_PIPELINE            (id=4, id=5, id=38 ← 3 行)
RESEARCH_INTEGRITY_BATCH_AUDIT  (id=43, id=77)
```

**期望**: 上一次"seed 14 missing crons + reverse drift guard"应该去重。

**差距**: 同 type 多 cron 会双跑（cron-expr 不同的情况），相当于把开仓/止损扣 2 次扳机。`PAPER_TRADING_DRAWDOWN_BREAKER_CHECK` 这种关键风控**最危险**。`LIVE_RECONCILIATION_GUARD` 两条都 NEVER 跑，又是 #8 的体现。

**修复**:
- 手动 DB cleanup：每个 type 只保留 1 行
- `scheduled_tasks` 表加 `UNIQUE (type)` 约束防回归
- seedTasks 改为 upsert by type，老 id 来源标志位区分

---

## 7. 15 个 active cron `last_run_at` = NULL（从未跑过）

**SQL**:
```sql
SELECT type, last_run_at, last_run_status FROM scheduled_tasks
WHERE is_active=true AND last_run_at IS NULL;
```

**输出 (15 行)**:
```
WEEKLY_QA_STAT_AGGREGATE, SYNC_ALL_STOCKS, DATA_QUALITY_SCAN,
WEEKLY_ERROR_PATTERN_AGGREGATE, BLACK_SWAN_QUARTERLY_SUMMARY,
AI_DIARY_GENERATE, TCA_WEEKLY_REPORT,
LIVE_RECONCILIATION_GUARD (×2!), DAILY_ATTRIBUTION_GENERATE,
RESEARCH_INTEGRITY_BATCH_AUDIT (其中一条),
EQUITY_CURVE_GOVERNOR_DAILY_EVAL (其中一条),
DB_BACKUP, ETF_FLOW_SYNC, WEEKLY_IMPROVEMENT_SUGGESTION_GENERATE
```

注：日志里还出现 `nextRunAt=2034-01-01 10:00:00 CST` —— scheduler 把 next run 算到 8 年后了（cron expr 解析有问题或 cron `0 10 * * 0` 当前一直没 trigger）。

**期望**: seed 后注册成功，至少首次窗口内跑过。

**差距**:
- `AI_DIARY_GENERATE` NEVER → ai_diary_entries 0 行（#4）
- `LIVE_RECONCILIATION_GUARD` NEVER → 对账主动告警 gray（#4）
- `ETF_FLOW_SYNC` NEVER → etf_flows 仅 37 行 (#10)
- `WEEKLY_IMPROVEMENT_SUGGESTION_GENERATE` NEVER → improvement_suggestions 0 行
- `DB_BACKUP` NEVER → **数据库未备份**，灾难恢复风险高
- `nextRunAt=2034` 看着像 cron schedule 解析 bug

**修复**:
- 手动 trigger 一次每条上面 cron 看是不是代码错（exception → never insert last_run_at）
- 排查 `nextRunAt=2034` 计算
- DB_BACKUP 立刻手动跑 + 监控

---

## 8. `LIVE_RECONCILIATION_GUARD` 同 type 两行都 NEVER

**SQL**: 见 #6, #7

**输出**:
```
LIVE_RECONCILIATION_GUARD id=75 cron="31 10,14,15 * * 1-5" last=NULL status=null
LIVE_RECONCILIATION_GUARD id=76 cron="1 16 * * 1-5"        last=NULL status=null
```

**期望**: 对账告警是 BETA-2 deliver 的核心 cron。

**差距**: 两条 schedule 都从未触发。结合 #6（duplicate）和 #7（never），说明 BETA-2 实际**没生效**。topology 节点 `reconciliation_alert` = gray 也正是这个事实。

**修复**: 删一条重复 + 调查为什么 cron 不 fire（可能 SchedulerService 注册时 model registry race）。

---

## 9. `realtime_quotes` 工作日数据缺 (近 5 个交易日仅 6/15-6/19 中 1 天有最新)

**SQL**:
```sql
SELECT updated_at::date d, COUNT(DISTINCT symbol) FROM realtime_quotes
WHERE updated_at::date >= '2026-06-15' AND updated_at::date <= '2026-06-19'
GROUP BY 1 ORDER BY d DESC;
```

**输出**:
```
2026-06-20 (Sat — 实际是 6/20 16:00 UTC = 6/21 00:00 CST，被算到周六): 807 distinct symbols
2026-06-17 16:00: 3240 stocks
2026-06-16 16:00: 3600 stocks
```

近 7 天 distinct symbol total = 807（声称应 ≥ 500，OK 但仅勉强 50% 覆盖率）。

**期望**: A 股全市场 5536 stocks，应至少覆盖 main board + ChiNext > 4000 票。

**差距**: 仅 807 个 symbol 有最近 quote。说明 `REALTIME_QUOTE_SYNC` 只抓了热门票或抓了一半就被 rate limit。EastMoney 日志里 3000+ 次 socket hang up（#11）佐证 fetch 失败率高。

**修复**:
- 抓取批量 size + 重试策略调优
- 切换备用数据源（已有 sina fallback 但触发率太低）
- monitor: distinct symbol 7d 覆盖率 < 60% 告警

---

## 10. `etf_flows` 仅 37 行 + `ETF_FLOW_SYNC` cron 从未跑

**SQL**:
```sql
SELECT COUNT(*) FROM etf_flows;  -- 37
SELECT * FROM scheduled_tasks WHERE type='ETF_FLOW_SYNC'; -- last_run_at NULL
```

**期望**: 上次任务 #43 明确 "Add ETF_FLOW_SYNC cron"，完成后应至少几千行（每个 ETF × 日）。

**差距**: cron 注册了但从未触发（同 #7）→ etf_flows 表几乎空。**KOLAggregator.fetchETFFlow 失败也是因为依赖这个表 + Stock model 没注册**。

**修复**: 同 #7。

---

## 11. ERROR log 24h = 3546 行，99% 是 EastMoney socket hang up

**命令**:
```bash
awk '/2026-06-2[01]/' /opt/stocks/shared/logs/error.log | wc -l  # 3546
```

**Top 错误（按 count）**:
- 1179× `EastMoney API request failed`
- 6×171 = 1026× `Failed to fetch history k data for 600280/600256/600163/600157/600121/600064 from EastMoney`
- 6×171 = 1026× `queryHistoryKData from 东方财富 ... 在 1 次重试后失败`

**期望**: 部分股票偶尔失败 OK；但同一批 6 票 171 次反复试 → 重试上限/熔断没生效。

**差距**: BETA-7 / 等改进的 DrawdownCircuitBreaker fail-closed 没作用于数据源 fetch 层。这些是退市股 (sh.600121=三毛派神已退市等) 没拉黑名单。每次 SYNC_HISTORY 都重试 171 次，浪费大量 IO + 污染 log。

**修复**:
- 把 6 个反复失败的 symbol 加入 stocks.is_active=false 或 fetch blacklist
- 数据源 fetch 失败 N 次自动 quarantine 该 symbol N 小时

---

## 12. `northbound_holdings` 最新 trade_date = 2024-08-15（22 个月前！）

**SQL**:
```sql
SELECT MAX(trade_date), MAX(updated_at) FROM northbound_holdings;
SELECT created_at::date, COUNT(*) FROM northbound_holdings
WHERE created_at > NOW() - INTERVAL '5 days' GROUP BY 1;
```

**输出**:
```
latest_trade_date: 2024-08-15 (22 个月前)
latest_updated_at: 2026-06-21 11:04  ← 今日刚跑过 sync
6/21 ingest: 7722 rows ALL with trade_date='2024-08-15'
```

`NORTHBOUND_SYNC` cron 也 `last_run_status='SUCCESS' last_run_at='2026-06-19'` 看似正常。

**期望**: 北向资金应有 6/19 (上 trading day) 最新数据。

**差距**: **akshare upstream 数据源停留在 2024-08-15**（很可能因为 akshare 接口 schema 改了或被反爬），但代码以为 "拿到数据 = 成功"，于是反复 upsert 同一天的旧数据。**Topology 节点 `northbound_data` 也因此显示 red**（lag > 5 days）。

这跟上次教训"拓扑数据停留 7 周前"几乎是同一种 bug 再发。

**修复**:
- `NorthboundSyncService` 加 freshness assert: `IF trade_date < CURRENT_DATE - 5 THEN throw "stale upstream"`
- 升级 akshare + 加 alt 数据源（Wind / 同花顺）
- 加 monitor: `MAX(trade_date) < now - 7d` 告警

类似问题: `dragon_tiger_board` 最新 = 2026-06-10 (11 天前)，也 stale。

---

## 13. `factor_scores` 6 个因子 std=0（凑数因子）

**SQL**:
```sql
SELECT factor_name, COUNT(DISTINCT raw_value) uvals, MIN(raw_value), MAX(raw_value)
FROM factor_scores WHERE trade_date = (SELECT MAX(trade_date) FROM factor_scores)
GROUP BY factor_name HAVING STDDEV(z_score) = 0;
```

**输出**:
```
analyst_consensus    uvals=1 (单一值 -0.260066，全表写死)
earnings_surprise    uvals=0 (raw_value 全 NULL)
growth               uvals=0
insider_trade        uvals=0
liquidity            uvals=0
northbound           uvals=0
```

且 `value` factor 有 5532 stocks 覆盖，其他 21 个 factor 只有 360 stocks → 严重 universe 不一致。

**期望**: 22 个 factor 都应有实际打分（设计中 ≥15 个 std>0.05），覆盖全市场。

**差距**:
- **6 factor 等于 0** → 多 dim engine 即便能跑，dimension 也大半 dead
- coverage 不匹配（5532 vs 360）→ 信号融合时存在严重选择偏差
- `northbound` factor std=0 因为 #12 数据 stale → loadNorthboundDelta5d 全 NULL → factor 全 0
- `insider_trade` 0 因为 KOL 数据缺 + shareholder trade 主表查询逻辑问题

**修复**:
- 每周一 sanity: `factor_health_report.cron`，列出 std=0 factor
- 6 个 dead factor 各开 ticket 调查计算式
- value vs others coverage 修齐（共用一个 stock universe）

---

## 14. `ai_stock_analysis_reports` 2 行全部 status=failed

**SQL**:
```sql
SELECT status, COUNT(*) FROM ai_stock_analysis_reports GROUP BY status;
SELECT error, generated_at FROM ai_stock_analysis_reports ORDER BY created_at DESC LIMIT 2;
```

**输出**:
- 全表 2 行，status 全 failed
- error = `connect ECONNREFUSED 47.93.224.109:8000`（python TradingAgents 服务挂了）

**期望**: 该 endpoint 是用户主入口 `/api/ai/analyze-stock`，应有成功记录。

**差距**: legacy TradingAgents 服务 8000 端口下线（externalServices.ts/AnalysisAgent 没切换到新引擎）+ multi_dim_v1 引擎也未 wire（#1）→ **AI 分析功能从用户视角完全坏掉**。

**修复**:
- AIAdvisorController.analyzeSingleStock 立即 fallback 到 multi_dim_v1
- 修复 47.93.224.109:8000 服务或下线该路径
- 加 e2e smoke test: 每天对一票调 endpoint 验证 status=success

---

## 关联问题（次要 / 监控向）

15. error.log 18 行只是 grep `ERROR|FATAL` 大小写敏感漏匹配 → 实际 error 级日志 3546 行 (#11)
16. 部分 cron `nextRunAt=2034-01-01` 看起来 cron 解析器 bug，没继续深挖
17. `WEEKLY_REVIEW_*` 表完全不存在但代码引用 weeklyReview Apply UI → 前端可能也 silent fail
18. `pg_polling_tasks` / `ai_polling_tasks` 不存在但 ShadowDoubleRunService 设计依赖

---

## 教训 vs 上次 review

上次教训 4 个里 **3 个本次再现**：
| 教训 | 上次表现 | 本次 |
|---|---|---|
| loader 字段名错 (stock_code vs symbol) | AI engine 错列 | ✗ analyzeStock 调用 hang on `symbol.trim` (signature mismatch) |
| factor_scores 严格 trade_date 周末返 0 | factor 全 NULL | ✗ 6 因子 std=0, 用 stale upstream 数据 |
| 拓扑数据停留 7 周前 | NB stale | ✗ NB stale **22 个月**！ (#12) |
| 服务 restart 时间 < dist 文件时间 | 部署没生效 | ✓ 本次 SVC_START 20:55:03 ≥ dist mtime 20:54:33 OK |

**新一类问题**：表/cron"建好了但从未真正写入数据" —— L8 闭环 7 张表全 0 (#1, #4, #10)。

## 建议优先级

| P | 项 | 影响 |
|---|---|---|
| P0 | #2 模型未注册 → AI 引擎不可用 | 阻断 #1 |
| P0 | #12 NB 数据 22 月前 stale | 核心信号源已死 |
| P0 | #7 15 个 cron NEVER (含 DB_BACKUP) | 数据丢失风险 |
| P1 | #5 trade_reason 0 覆盖（待 6/22 复检） | 决策可解释性 |
| P1 | #6 11 type cron 重复 | 风控扣 2 次 |
| P1 | #11 3546 错误/天 | log 噪音 + IO 浪费 |
| P1 | #14 AI report 全 failed | 用户主入口坏 |
| P2 | #3 akshare 缺包 | KOL fallback |
| P2 | #13 6 factor std=0 | 引擎信噪比 |

最关键的一刀：**AI 多维分析引擎 deploy 了但 0 调用** —— 整个 Batch AI/AJ/AK/AO/AQ 的核心承诺没兑现。这次 review 不深就是因为只看代码层，建议每次 deploy 后用本脚本做一次 30 分钟的数据层 sanity sweep。
