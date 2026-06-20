# 99 — 实施路线图（Implementation Roadmap）→ ralph prd.json 启动清单

**作者**：高级量化操盘手 + AI/前端架构师
**日期**：2026-06-18
**输入文档**：本目录下 70+ 份设计文档 + `docs/audit/`
**目标**：把所有"现状缺口 + 改造 user story"汇总，**按依赖层（data → factor → strategy → portfolio → risk → execution → ai → frontend → ops）排序**，每个 story ≤ 1 context window 可完成，得到 ~180 个 story 列表，可直接转 `ralph/prd.json` 启动自动化实施。

---

## 0. 路线图概览

### 0.1 7 层依赖关系图

```
Layer 0: Ops 基础 (env / db / monitoring / scheduler)
  ↓
Layer 1: Data Layer (10+ 数据源, 25 个 SyncService)
  ↓
Layer 2: Factor Library (22+ factor + IC 监测)
  ↓
Layer 3: Strategy (13+ composite strategy + ensemble)
  ↓
Layer 4: Portfolio + Risk (sizing / rebalance / 9 guards)
  ↓
Layer 5: Execution + Reconciliation (TWAP/VWAP/Iceberg / bridge)
  ↓
Layer 6: AI Layer (analysis engine v2 + NLP + KOL + Copilot)
  ↓
Layer 7: Frontend (6 workspaces + alerts panel + analysis modal v2)
  ↓
Layer 8: Postmortem + Self-evolution (4 时间尺度 + 黑天鹅 + AI 日记)
```

### 0.2 优先级定义

- **P0**：1-2 sprint 内必做。补关键缺口、闭环卡点、生产风险。
- **P1**：3-6 sprint 内做。增强体验、提升 alpha、扩规模。
- **P2**：长期持续做。性能优化、新数据源、深度功能。

### 0.3 故事统计

| 层 | P0 | P1 | P2 | 小计 |
|---|---|---|---|---|
| Layer 0 Ops 基础 | 5 | 4 | 3 | 12 |
| Layer 1 Data Layer | 12 | 10 | 6 | 28 |
| Layer 2 Factor Library | 8 | 6 | 4 | 18 |
| Layer 3 Strategy | 7 | 6 | 4 | 17 |
| Layer 4 Portfolio + Risk | 9 | 7 | 4 | 20 |
| Layer 5 Execution | 5 | 5 | 3 | 13 |
| Layer 6 AI Layer | 14 | 14 | 9 | 37 |
| Layer 7 Frontend | 17 | 13 | 8 | 38 |
| Layer 8 Postmortem | 12 | 10 | 5 | 27 |
| **合计** | **89** | **75** | **46** | **210** |

> 三档共 **210 个 user story**。

---

## 1. 路线图主表

下表按依赖序列出，可直接转为 ralph prd.json 的 userStories[] 项。每行：
- **ID**：层前缀 + 序号（如 D-001 = Data #1）
- **标题**：≤ 30 字
- **描述**：As a / I want / so that
- **优先级**：P0 / P1 / P2
- **依赖**：前置 story ID 或 "—"
- **验收**：1-3 条 acceptanceCriteria（可作为 prd.json 的 acceptanceCriteria）

---

### Layer 0 — Ops 基础（12）

| ID | 标题 | 描述 | 优先级 | 依赖 | 验收 |
|---|---|---|---|---|---|
| OPS-001 | env 校验脚本 | 启动时校验 .env 必备字段（DATABASE_URL / REDIS_URL / TRADING_AGENTS_URL ...）；缺失立刻 fail-fast | P0 | — | npm run start 在缺关键 env 时立即报错并 exit 1；CI 跑 env-check 步骤通过 |
| OPS-002 | SchedulerService cron 注册中心 | 所有 cron job 在 SchedulerService 集中注册；新 cron 必须列入 CRON_REGISTRY 常量；启动时 dump 到日志 | P0 | OPS-001 | 启动日志列出所有 cron + 下次触发时间 |
| OPS-003 | dry_run 默认值巡检 boot guard | service 启动时跑 audit-task-parameters-dry-run，发现 task_parameters.dry_run=true 写 RiskAlert | P0 | OPS-002 | 已实现（BETA-5）；boot guard 已挂；扩展告警 channel |
| OPS-004 | Prometheus metric 标准化 | 所有 service 注册 metric 到 PrometheusRegistry；命名遵循 `<domain>_<verb>_<unit>` | P0 | — | 至少 20 个 metric 在 /metrics 可见 |
| OPS-005 | RiskAlert 标准 dispatcher | RiskAlertService.write 统一入口；按 severity 路由（critical→飞书+IM+toast，high→飞书，medium→inbox） | P0 | OPS-004 | 测试构造 3 级 alert 推送到正确 channel |
| OPS-006 | 飞书 webhook fail-open | feishuNotifier 失败时不阻塞主流程；写 fallback_log 表 + 5min retry | P1 | OPS-005 | mock feishu 504，主流程仍完成 |
| OPS-007 | DB 备份 cron | 每日 02:00 pg_dump → S3 / 本地 backup 目录；保留 30 天 | P1 | OPS-001 | 备份文件存在且可 restore 验证 |
| OPS-008 | 日志统一字段 | 所有 logger.info/warn/error 携带 trace_id + module；JSON format | P1 | — | grep trace_id 能追踪一次 request 全链路 |
| OPS-009 | OpenAPI 自动生成 | 所有 controller 输出 OpenAPI spec 到 docs/openapi.json；CI 校验未漂移 | P1 | — | openapi.json 与代码同步；CI 检查通过 |
| OPS-010 | Grafana dashboard 模板 | 提供 5 个 dashboard json：信号流 / 风控 / 对账 / 数据 SLA / 策略表现 | P2 | OPS-004 | dashboard 可导入即用 |
| OPS-011 | git filter-repo 抹掉 IP | 把 git 历史中的 `<legacy-internal-ip>` 删掉（implementation_summary 第 153 行明示） | P2 | — | git log --all 不再出现该 IP |
| OPS-012 | CI matrix 升级 | CI 跑 lint + tsc + npm test + frontend test + docker build；任一失败 block PR | P2 | — | GitHub Actions 配置完整 |

---

### Layer 1 — Data Layer（28）

| ID | 标题 | 描述 | 优先级 | 依赖 | 验收 |
|---|---|---|---|---|---|
| D-001 | 数据 SLO 仪表盘 | 新 /api/data/slo endpoint + 前端面板；25 类数据每类一行；last_synced_at / 今日记录数 / 7 日完整度 / health_status | P0 | OPS-004 | 仪表盘可访问；红黄绿状态正确 |
| D-002 | 跨源校验 cron | 每日 17:00 跑 DataCrossValidationService；100 只样本对比 AKShare vs Tencent；偏差 > 1% 写 RiskAlert | P0 | OPS-002 | data_cross_validation_logs 表有数据 |
| D-003 | 业务级 sanity check | 每个 SyncService 落库后调 DataSanityChecker；涨跌幅 ∈ [-21%, 21%]、PE > 0 等 | P0 | — | 违规记录写 data_quality_alerts |
| D-004 | LimitDownStock 表 | 仿 LimitUpStock 建表 + LimitDownSyncService；left_side_reversal 策略消费 | P0 | — | 每日 17:00 入库 |
| D-005 | 涨停连板跨长假回算 | LimitUpSyncService.computeContinuousDays 改用 TradingCalendar | P0 | — | 跨春节单测正确 |
| D-006 | DailyMarketBreath 派生表 | 每日 17:30 cron 统计涨停/跌停/涨家/跌家等；写 daily_market_breath | P0 | OPS-002 | 表中有数据；大盘择时模型消费 |
| D-007 | NorthboundMarketSnapshot 表 | 每日聚合 total_inflow/total_outflow/net；MarketSentimentIndex join | P0 | — | snapshot 表落库 |
| D-008 | 北向异常告警 cron | 每日 17:00 hold_ratio 单日变化 > 1.5% 写 RiskAlert | P0 | OPS-005 | alert 表能查到示例 |
| D-009 | 北向 hold_ratio 口径固定 | 显式选择"持股市值占A股市值比"；新增 hold_pct_of_float | P0 | — | 50 只蓝筹股口径与东财一致 |
| D-010 | 北向节假日回填 | cron 09:30 + 11:30 触发；前 7 日逐日检测；缺口写 data_quality_alerts | P0 | OPS-002 | 5 日内无数据缺口 |
| D-011 | ETF 申赎数据接入 | 新建 model ETFCreationRedemption + ETFFlowDataClient（AKShare fund_etf_iopv_em）；CLI sync 命令 | P0 | — | 每日 18:00 前入库 200+ ETF |
| D-012 | ETF 申赎 cron | SchedulerService 注册 ETF_FLOW_SYNC（17:30 工作日） | P0 | D-011, OPS-002 | cron 跑成功 |
| D-013 | 分钟线落库 | 新建 MinuteBar model + MinuteBarSyncService；候选池 + 持仓 100 只股 30 日 1-min bar | P1 | OPS-002 | 100 只可查 |
| D-014 | 集合竞价数据接入 | ak.stock_zh_a_pre_min 接口；pre_market_quotes 表；9:26 前入库 | P1 | OPS-002 | 候选池集合竞价可查 |
| D-015 | Tushare 兜底接入 | 第三方源；DataCrossValidation 三方比对 | P1 | D-002 | HealthService 显示 Tushare healthy |
| D-016 | QFII 接入 | AKShare stock_qfii_* + qfii_holdings 表；季报披露日窗口 | P1 | — | 数据可查 |
| D-017 | 涨停原因 NLP 分类 | LimitUpReasonClassifier：题材/板块/事件/业绩 4 类 | P1 | — | 100 个分类准确率 ≥ 85% |
| D-018 | 封板强度评分 | LimitUpStock 加 seal_strength_score 列 | P1 | — | score 跨日稳定 |
| D-019 | ConceptLimitUpBoard 派生 | 按概念聚合涨停 + 板块爆发度 + Top 5 成份股 | P1 | D-005 | 板块爆发度榜可查 |
| D-020 | 政策导向数据爬虫 | PolicyDirectivesScraper：央行/证监会/部委 RSS；落 policy_directives 表 | P1 | OPS-002 | 每天 ≥ 3 类来源新爬取 |
| D-021 | 北向衍生因子缓存 | northbound_change_summary 派生表：ratio_change_1d/5d/20d | P2 | D-007 | 因子计算时延降低 |
| D-022 | BJ 启停开关曝光前端 | SettingsWorkspace 加 include_bj_exchange toggle | P2 | — | 开关切换 universe |
| D-023 | 抽象 SyncService 基类 | BaseSyncService<TModel, TRaw>；新数据源 ≤ 50 行 | P2 | — | 1 个新源 PoC ≤ 50 行 |
| D-024 | 每类数据 SLO 卡 | 12 张 SLO 卡入 docs/trader-system/sla-data-layer.md | P2 | D-001 | 文档完成 |
| D-025 | AKShare reason 兜底 | LimitUp reason 解析失败回退自算 | P2 | — | 不可解析 < 1% |
| D-026 | 行情多源切换可视化 | DataWorkspace 显示主备源状态；一键切换 | P2 | D-001 | UI 可用 |
| D-027 | 数据补抓接口 | UI 一键触发某日某类数据补抓 | P2 | OPS-002 | 触发成功 |
| D-028 | 数据缺失独立告警 | 数据 alert 与 RiskAlert 分离 category | P2 | OPS-005 | UI 区分 |

---

### Layer 2 — Factor Library（18）

| ID | 标题 | 描述 | 优先级 | 依赖 | 验收 |
|---|---|---|---|---|---|
| F-001 | DividendYieldFactor | 新 factor：基于 DividendHistory + 价格；MFA 默认权 0.05 | P0 | — | factor 单测 + IC 验证 ≥ 0.02 |
| F-002 | TurnaroundFactor | 业绩反转因子：基于 FinancialReport YoY；MFA 候选 | P0 | — | 单测全绿 |
| F-003 | IpoFreshmanFactor | 次新股因子：基于 Stock.listing_date；MFA 候选 | P0 | — | 单测全绿 |
| F-004 | IndustryRelativeStrengthFactor | 个股 momentum / 行业 momentum 比 | P0 | F-002（同层并行） | 单测 |
| F-005 | ContinuousLimitUpPremiumFactor | 二连板转三连板胜率因子 | P0 | D-005 | 单测 |
| F-006 | FactorReviewRecommendation model | 月度因子健康表持久化模型 + migration | P0 | — | migration 跑通 |
| F-007 | MonthlyFactorICReviewService | 每月初聚合 IC × 4 lookback；落 FactorReviewRecommendation | P0 | F-006, OPS-002 | 月度 cron 输出 18 条 |
| F-008 | ICClassifier pure function | hot/warm/cold/dead 分类规则 | P0 | F-007 | 单测覆盖 4 类 |
| F-009 | HalfLifeEstimator | 拟合 IC 序列 exp decay；输出 half_life_days | P1 | F-007 | 估算误差 ±10% |
| F-010 | FactorWeightConfig model | (factor_key, effective_from, weight)；策略读它 | P1 | F-006 | model + migration |
| F-011 | applyRecommendations service | 把 review 转 weight_config；auto/manual 模式 | P1 | F-010 | 单测 + 集成 |
| F-012 | factor IC review admin route | POST /api/admin/factor-review/:month/apply | P1 | F-011 | 接口测试 |
| F-013 | factor IC review AI summary | LLM 输入 18 因子健康表 → 500 字 markdown | P1 | F-007 | 输出 ≥ 5 因子引用 |
| F-014 | 因子健康前端 dashboard | FactorWorkspace /factors/health tab：表 + heatmap + 折线 | P1 | F-007 | UI 完整 |
| F-015 | 分层 IC（大/中/小盘） | FactorICReport.runStratified by mcap_bucket | P2 | F-007 | 分层报告输出 |
| F-016 | 飞书 push factor review | feishuNotifier 月报卡片 | P2 | F-013 | 推送 |
| F-017 | fund_consensus / block_trade / concept_heat 单测 | 已有 factor 补齐单测 | P2 | — | 覆盖率 ≥ 80% |
| F-018 | 持续 IC cron 完善 | 22 个 factor 都进 FACTOR_IC_COMPUTE | P2 | OPS-002 | 22 因子日报全跑 |

---

### Layer 3 — Strategy（17）

| ID | 标题 | 描述 | 优先级 | 依赖 | 验收 |
|---|---|---|---|---|---|
| S-001 | StrategyParamCandidate model | 季度参数候选持久化 model + migration | P0 | — | 表结构 OK |
| S-002 | StrategyParamConfig model | 策略读它替代 hardcoded params | P0 | — | model OK |
| S-003 | 重构 13 策略读 StrategyParamConfig | 把 hardcoded params 改 DB 加载 | P0 | S-002 | 13 策略改造 |
| S-004 | QuarterlyParamRetrainService | 5 阶段流程编排（Grid → Bayes → WalkForward） | P0 | S-001 | 端到端跑通 |
| S-005 | RetrainPipeline | 串 GridSearchOptimizer + BayesianOptimizer + WalkForwardValidator + OverfitMetrics | P0 | S-004 | 1 策略跑通完整流程 |
| S-006 | ShadowParamRunner | 每日 cron 对 status='shadow' candidate 跑信号；落 param_shadow_results | P0 | S-001, OPS-002 | shadow 跑成功 |
| S-007 | QUARTERLY_PARAM_RETRAIN cron | 季初 09:00 触发；weekly review + daily shadow run cron | P0 | S-005, OPS-002 | cron 全注册 |
| S-008 | evaluateShadowVsLive | 4 周对比 → ready_for_cutover 标记 | P1 | S-006 | 标记触发 |
| S-009 | 参数 cutover admin route | POST /api/admin/param-retrain/candidate/:id/promote | P1 | S-008 | 接口测试 |
| S-010 | OverfitMetrics 强制集成 | PBO < 0.5 AND deflated_sharpe > 0 才 promote | P1 | S-005 | 失败 candidate 被 reject |
| S-011 | LowVolatilityStrategy 组合级实现 | 30 概览第 C.4 标记的缺失策略 | P1 | F-001 | 新策略上线 |
| S-012 | 策略 capacity 估算 | StrategyCapacityEstimator + 周报展示 | P1 | — | 估算输出 |
| S-013 | 策略 kill_switch_metric 生效 | 连续 N 天差 → 自动 disabled flag | P1 | S-002 | 触发自动停 |
| S-014 | 前端策略重训 tab | LabWorkspace /lab/retrain 展示候选 + shadow | P2 | S-008 | UI 完成 |
| S-015 | 季度重训飞书 push | 完成 / shadow 周报 / cutover 提议 3 类 | P2 | S-005 | 推送 |
| S-016 | 补缺失风格策略 3 个 | 高股息 + Pair Trading + RegimeAware | P2 | — | 上线 |
| S-017 | Ensemble regime 加权 | 自动按 MarketEnvironment 调子策略权重 | P2 | — | 单测 |

---

### Layer 4 — Portfolio + Risk（20）

| ID | 标题 | 描述 | 优先级 | 依赖 | 验收 |
|---|---|---|---|---|---|
| PR-001 | PortfolioOptimizer 真接入 | 当前未接入；接到 PaperTradingFacade autoBuyFromSignals | P0 | — | 跑通 |
| PR-002 | PositionLimitGuard 阈值持久化 | 移除 hardcoded；从 user.risk_config 读 | P0 | — | 配置驱动 |
| PR-003 | sizing vs limit 阈值一致性 | SizingPolicyService 与 PositionLimitGuard 阈值同步 | P0 | PR-002 | 单测覆盖 |
| PR-004 | RebalanceEngine 边界控制 | 偏离 > 3% 才触发；不日日动 | P0 | — | 单测覆盖 |
| PR-005 | TradeComplianceChecker pre-trade 全接入 | BETA-1 只接 2 处；完成剩余 caller 接入 | P0 | — | 全 caller 验收 |
| PR-006 | DrawdownCircuitBreaker fail-closed 巡检 | 已修；扩展到所有 risk_guard fail-closed pattern 统一 | P0 | — | 统一 helper |
| PR-007 | 行业集中度 KPI | PortfolioWorkspace 顶 KPI 显示最大行业集中度；> 25% 红色 | P0 | — | UI 完成 |
| PR-008 | 黑天鹅 watchdog 增强 | 减持暴增 / 重大诉讼 / 退市预警检测扩展 | P0 | — | 单测 |
| PR-009 | 限售解禁预警提前 5 日 | RestrictedShareWatchdog 提前 5 日仓位减半建议 | P0 | — | 单测 |
| PR-010 | BlackSwanEvent model | 黑天鹅事件持久化（id, detected_at, event_type, severity, scope） | P1 | — | model + migration |
| PR-011 | BlackSwanDetector | 30min cron 巡 5 类信号 | P1 | PR-010, OPS-002 | cron 跑成功 |
| PR-012 | BlackSwanPostmortemReport model | 报告模型 + 4 段 JSONB 字段 | P1 | PR-010 | model OK |
| PR-013 | BlackSwanPostmortemService | 触发后 30min 内生成 4 段 | P1 | PR-012 | 测试事件 → 报告生成 |
| PR-014 | CounterfactualBaselineCalculator | 4 baseline（hold/zero/plan/perfect）模拟 | P1 | PR-013 | 数值验证 |
| PR-015 | EventTimelineReplayer | 拉事件前 N 天 RiskAlert + Watchdog 输出 | P1 | PR-013 | 时间轴输出 |
| PR-016 | ImprovementSuggestor | 4 类短板归类 + 模板建议生成 | P1 | PR-013 | 建议输出 |
| PR-017 | MarketRegimeAlertService 完善 | 连续 3 日 跌停股 > 100 触发"全市场暂停建仓" | P2 | — | 触发逻辑 |
| PR-018 | 黑天鹅前端历史页 | SettingsWorkspace /black-swan tab：事件列表 + 详情 | P2 | PR-013 | UI 完成 |
| PR-019 | 季度黑天鹅汇总报告 | 每季度汇总并邮件 | P2 | PR-013 | 邮件 |
| PR-020 | 风控参数中心前端 | SettingsWorkspace 合并所有 risk 阈值到一个 panel | P2 | PR-002 | UI 完成 |

---

### Layer 5 — Execution（13）

| ID | 标题 | 描述 | 优先级 | 依赖 | 验收 |
|---|---|---|---|---|---|
| EX-001 | ExecutionFeasibility 全接入 | feasibility score < 60 不下单；接到 PaperTradingFacade + Bridge | P0 | — | gate 触发 |
| EX-002 | Composite backtest caller 接通 | ALPHA 已建 engine hook + MFA smoke；接通剩余 12 策略 | P0 | S-003 | 12 策略 trade_count > 0 |
| EX-003 | 对账 alignment_score 监控 | ReconciliationAlertService 已实现；扩展看板 | P0 | D-001 | dashboard 完成 |
| EX-004 | broker-bridge fail-safe 单测 | bridge 失联 / KillSwitch 激活 → 全 pending 转 aborted | P0 | — | 单测覆盖 |
| EX-005 | aiPollingQueue dedup 持久化 | BETA-3 已加 jobId；持久化到 Redis | P0 | — | 重复 enqueue 被合并 |
| EX-006 | TWAP/VWAP/Iceberg 算法实现 | 大单拆 N 笔；按 ADV 自适应 | P1 | EX-001 | 算法跑通 |
| EX-007 | 集合竞价 vs 连续 vs 收盘 区分处理 | ExecutionPolicyRouter 分时段策略 | P1 | EX-006 | 单测 3 段 |
| EX-008 | runShadowAutopilot 幂等 | BETA-4 已实现；扩展所有 autopilot 任务统一幂等 helper | P1 | — | 幂等单测 |
| EX-009 | bridge ed25519 升级 | 60 文档第 C.4 标记的 HMAC → ed25519 | P1 | — | 升级完成 |
| EX-010 | qmt vs ptrade 差异文档化 | 60 文档第 C.5 标记 | P1 | — | docs 完整 |
| EX-011 | 七闸门统一入口 | facade vs LiveTradingService 路径合并 | P2 | — | 统一 helper |
| EX-012 | ReconciliationAlert 阈值调参 UI | SettingsWorkspace 暴露 alignment_score 阈值 | P2 | OPS-005 | UI 完成 |
| EX-013 | 实盘 fill 异常分类 | partial / canceled / rejected 分类持久化 | P2 | — | 统计可用 |

---

### Layer 6 — AI Layer（37）

| ID | 标题 | 描述 | 优先级 | 依赖 | 验收 |
|---|---|---|---|---|---|
| AE-001 | archiveAnalysisEngineResult | AIInvestmentSignalService 加方法；source_type='analysis_engine' | P0 | — | 写库验证 |
| AE-002 | hard mode 实现 | ShadowDoubleRunService.hard 不再退化 shadow；调主路径 | P0 | AE-001 | mode='hard' 走新引擎 |
| AE-003 | AIAdvisorService hard 短路 | mode='hard' 时直接调 AnalysisEngineService | P0 | AE-002 | 集成测试 |
| AE-004 | AutomatedRecommendationLoop hard 分支 | 检测 source_type='analysis_engine' 走 hard 跟单 | P0 | AE-001 | 跟单触发 |
| AE-005 | FundamentalAnalyzer peer rank | 同行业 PE/PB/ROE 百分位 evidence | P1 | — | evidence 含百分位 |
| AE-006 | TechnicalAnalyzer entry_zone marketLimits | 替换 inline 实现接 marketLimits.ts | P1 | — | 接通 |
| AE-007 | IndustryRegimeAnalyzer dragon resonance | 同板块龙头共振 evidence | P1 | — | evidence 输出 |
| AE-008 | confidence_tier 字段 | high/medium/low 加 aggregator 输出 | P1 | — | 字段输出 |
| AE-009 | user analyzer_weights | risk_config 支持用户自定义 8 dim 权重 | P2 | — | 配置驱动 |
| AE-010 | RiskAnalyzer ATR-adjusted stop | max(support[0], close - 2×ATR) | P1 | — | 单测 |
| AE-011 | 3 样本股 hard 集成测试 | 600519/000858/300750 端到端比对 | P0 | AE-002 | 一致率 ≥ 80% |
| KOL-001 | ETFCreationRedemption model | 见 D-011/D-012；归 data 层 | — | — | 见 D-011 |
| KOL-002 | KOLAggregator 加 source_authority 权重 | research 0.6 / news 0.3 / kol 0.4 / etf 0.5 / policy 0.8 | P0 | D-011, D-020 | dedupeAndSort 升级 |
| KOL-003 | KOLAggregator ETF + 政策集成 | fetchETFFlow + fetchPolicyDirectives 方法 | P0 | KOL-002 | 5 类来源非空 |
| KOL-004 | NewsAnalyzer 接 KOLAggregator 真输出 | 替换占位；evidence top 3 + source tag | P0 | KOL-003 | evidence 真实 |
| KOL-005 | KOLAggregator time_decay | weight × exp(-days_old / 7) | P1 | — | 单测 |
| KOL-006 | KOLAggregator industry 维度聚合 | aggregateForIndustry | P1 | KOL-002 | 输出 |
| KOL-007 | KOLAuthorTrackingService | author 历史命中率统计 | P2 | — | 90 天后 ≥ 3 author 胜率 ≥ 60% |
| KOL-008 | ConceptLinkageAnalyzer | xq_hot_concept 同板块联动 | P2 | — | 输出 |
| KOL-009 | KOLAggregator semantic dedupe | NLP/embedding 去重 | P2 | — | 去重率 ≥ 70% |
| ANN-001 | AnnouncementNLP 加 event_type/priority/entities | model 加字段 + migration | P0 | — | migration 跑通 |
| ANN-002 | classifyEventType pure function | 7 大事件分类 | P0 | ANN-001 | 准确率 ≥ 80% |
| ANN-003 | extractEntities pure function | 人名/角色/持股比例 | P0 | — | 单测 |
| ANN-004 | extractEarningsGrade pure function | YoY% 抽取 + 分级 | P0 | — | 单测 |
| ANN-005 | computePriority pure function | event_type + sentiment + amounts → priority | P0 | ANN-002 | 单测 |
| ANN-006 | buildStructuredSummary | 替换 heuristicSummarize；含 entities + amounts_detailed | P0 | ANN-002,003,004 | 输出含 entities |
| ANN-007 | critical 公告 5min 飞书 push | enqueue feishuNotifier.sendCriticalAnnouncementCard | P0 | OPS-005 | 推送验证 |
| ANN-008 | AnnouncementEventRelation model | 公告关联公司 | P1 | — | model OK |
| ANN-009 | RelatedCompanyExtractor | 识别公告中提到的其它股票 | P1 | ANN-008 | 识别 ≥ 80% |
| ANN-010 | AnnouncementDedupeService | 同事件多次公告去重 | P1 | — | 去重 ≥ 70% |
| QA-001 | TOPIC_SUBCATEGORIES + classifySubtopic | 24+ subcategory | P0 | — | 准确率 ≥ 80% |
| QA-002 | EastMoneyQAStat model + aggregator | 周聚合 + answer_rate + template_score | P0 | — | 周一 04:00 前生成 |
| QA-003 | QALeadingSignalDetector | earnings questions 暴增 + answer 积极 | P0 | QA-002 | 90 天 ≥ 5 信号 |
| QA-004 | IndustryQAHeatService | 行业级 top 10 active | P1 | QA-002 | API 输出 |
| QA-005 | SentimentAnalyzer 接 QA 新维度 | evidence 含 questions_growth + answer_rate | P1 | QA-002 | evidence 升级 |
| CO-001 | Copilot 7 task intents | 扩展到 11 intent | P0 | — | normalizeIntent 单测 |
| CO-002 | EntityExtractor pure functions | extractStocks / industries / indicators / numbers / dates / strategyParams | P0 | — | 单测 |

---

### Layer 7 — Frontend（38）

| ID | 标题 | 描述 | 优先级 | 依赖 | 验收 |
|---|---|---|---|---|---|
| FE-001 | TodayWorkspace 今日大盘判断卡片 | 昨夜外盘 + regime + 仓位建议 | P0 | — | UI 完成 |
| FE-002 | TodayWorkspace 集合竞价异动卡片 | 9:25 后展示一字/高开/撤单 | P0 | D-014 | UI + 数据 |
| FE-003 | TodayWorkspace 今日交易计划卡 | 信号 → plan list | P0 | — | UI |
| FE-004 | TodayWorkspace AI 大盘 brief | trading-agents LLM 摘要 | P0 | — | ≤ 150 字 |
| FE-005 | TodayWorkspace 今日卖出建议卡 | 止盈/止损/减持 | P0 | — | UI |
| FE-006 | FactorWorkspace 因子健康列 | IC_90d / IR / classification | P0 | F-014 | UI |
| FE-007 | FactorWorkspace AI 权重对照 | slider 旁显示 AI 建议 | P0 | F-011 | UI |
| FE-008 | FactorWorkspace 组合模板 save/load | 自定义因子组合 | P0 | — | 持久化 |
| FE-009 | FactorWorkspace ETF + 政策 tab | 新增 2 tab | P0 | D-011, D-020 | UI |
| FE-010 | FactorWorkspace picks inline 理由 | 列表内嵌短理由 | P0 | — | UI |
| FE-011 | LabWorkspace 季度参数重训 tab | 候选 + shadow | P0 | S-008 | UI |
| FE-012 | LabWorkspace shadow run 区块 | shadow vs live 对比 | P0 | S-006 | UI |
| FE-013 | LabWorkspace OverfitMetrics 显示 | PBO + Deflated Sharpe | P0 | S-010 | 回测结果展示 |
| FE-014 | LabWorkspace 快速 grid 模板 | 参数空间预设 | P0 | — | UI |
| FE-015 | LabWorkspace leaderboard 超额列 | vs HS300 / ZZ500 | P0 | — | UI |
| FE-016 | PortfolioWorkspace 日归因卡 | 71 文档输出消费 | P0 | ATTR-007 | UI |
| FE-017 | PortfolioWorkspace weekly/monthly/quarterly tab | 复盘日记升级 | P0 | WK-012 | UI |
| FE-018 | PortfolioWorkspace 行业集中度 KPI | > 25% 红色高亮 | P0 | PR-007 | UI |
| FE-019 | PortfolioWorkspace 持仓 ATR/DD/days_held 列 | 高级指标 | P0 | — | UI |
| FE-020 | PortfolioWorkspace AI 日记 + 错误模式 tab | 76 文档消费 | P0 | EV-014 | UI |
| FE-021 | DataWorkspace 加厚 6 tab | 实际内容填充 | P0 | D-001 | 6 tab 真内容 |
| FE-022 | DataWorkspace SLA dashboard | 时效 SLA 可视化 | P0 | D-001 | UI |
| FE-023 | DataWorkspace 数据缺失独立告警 | category='data' | P0 | D-028 | UI |
| FE-024 | DataWorkspace 补抓按钮 | UI 一键触发 | P0 | D-027 | UI |
| FE-025 | DataWorkspace 数据源切换 | 主备源状态可视化 | P0 | D-026 | UI |
| FE-026 | SettingsWorkspace 分析引擎 mode 切换 | off/shadow/hard UI | P0 | — | UI |
| FE-027 | SettingsWorkspace 风控参数中心 tab | 合并所有 risk 阈值 | P0 | PR-020 | UI |
| FE-028 | SettingsWorkspace AI 引擎 8 dim 权重 slider | 用户调权 | P0 | AE-009 | UI |
| FE-029 | SettingsWorkspace 待办建议 tab | 黑天鹅/偏差/改进 | P0 | PR-013, EV-008 | UI |
| FE-030 | SettingsWorkspace 策略 kill-switch UI | 单独 disable/enable | P0 | S-013 | UI |
| FE-031 | AlertsBell 顶 nav bar | 全局浮动 badge | P0 | — | UI |
| FE-032 | AlertsPanel filter + search + 分类 | 完整 alerts panel | P0 | FE-031 | UI |
| FE-033 | AlertItem snooze + action | snooze 1h/1d/1w + 一键执行 | P0 | — | UI |
| FE-034 | WebSocket /ws/alerts 后端 + 前端 | 实时推送 + 30s polling fallback | P0 | — | 实时 |
| FE-035 | CriticalAlertModal 强制弹窗 | critical 必须确认 | P0 | — | UI |
| FE-036 | AIStockAnalysisModal v2 | 8 dim score bar + evidence + action plan | P0 | AE-002 | UI |
| FE-037 | AnalyzerScoreBar + ConfidenceRing + EvidenceList 组件 | v2 子组件 | P0 | FE-036 | UI |
| FE-038 | DataMissingBanner + ActionPlanCard | v2 子组件 | P0 | FE-036 | UI |

---

### Layer 8 — Postmortem（27）

| ID | 标题 | 描述 | 优先级 | 依赖 | 验收 |
|---|---|---|---|---|---|
| PM-001 | DailyAttributionService | 17:00 cron 触发；6 维归因 | P0 | OPS-002 | service 输出 |
| PM-002 | AttributionEngine | Brinson-Fachler 拆解算法 | P0 | PM-001 | 单测 ±5% |
| PM-003 | DailyAttributionReport model | (date, portfolio_id, breakdown JSONB, ai_summary TEXT) | P0 | — | model OK |
| PM-004 | ExecutionCostAggregator | slippage + commission + stamp_duty 汇总 | P0 | EX-013 | 与 LiveTradeFill 对账 ≥ 99% |
| PM-005 | AIAttributionSummary | LLM 输入 6 维归因 → ≤ 200 字 | P0 | PM-003 | 输出含 ≥ 3 数字 |
| PM-006 | DAILY_ATTRIBUTION_GENERATE cron | 17:00 工作日 | P0 | OPS-002, PM-005 | 表里有当日记录 |
| PM-007 | DailyAttribution route + controller | GET /api/portfolio/:id/attribution/daily | P0 | PM-006 | 接口测试 |
| PM-008 | BehaviorBiasDetector.detectIncremental | 只在今日新增上诊断 | P0 | — | 性能优化 |
| PM-009 | 飞书 push DailyAttribution | 17:35 前送达 | P0 | OPS-005, PM-005 | 推送 |
| PM-010 | PortfolioWorkspace 归因卡 | UI 展示 6 维 pie + best/worst + AI summary | P1 | PM-007 | UI |
| PM-011 | WeeklyReview strategy_performance 列 | 按 strategy_key 拆 pnl | P0 | — | payload 升级 |
| PM-012 | WeeklyReview correlation matrix | N×N pearson | P0 | — | 输出矩阵 |
| PM-013 | StrategyCapacityEstimator | capacity_used_pct | P1 | — | 输出 |
| PM-014 | AIWeeklyOpinion 替换 heuristic | LLM ≤ 300 字摘要 + 建议结构化 | P1 | — | 输出 ≥ 200 字 |
| PM-015 | WeeklyReview /apply 接口 | 建议落 strategy_config（人工 click） | P2 | PM-014 | 接口测试 |
| PM-016 | WeeklyReview 多 benchmark | 加中证 500 + 创业板 | P2 | — | 邮件出 3 benchmark |
| PM-017 | WeeklyReview 下周日历事件 | 读 EventsCalendar 未来 7 天 | P2 | — | 邮件 section |
| PM-018 | AIDiaryEntry model | (user_id, date, text, evidence JSONB) | P0 | — | model OK |
| PM-019 | AIDiaryService | 每日 18:00 LLM ≤ 500 字日记 | P0 | PM-018 | 每日生成 |
| PM-020 | AI_DIARY_GENERATE cron | 每日 18:00 | P0 | OPS-002 | cron 跑成功 |
| PM-021 | ErrorPatternReport model + Aggregator | 90 天 bias/outcome/attribution 聚合 | P0 | — | 周日生成 |
| PM-022 | WEEKLY_ERROR_PATTERN cron | 每周日 10:00 | P0 | OPS-002 | cron 跑成功 |
| PM-023 | ImprovementSuggestion model + Service | bias/pattern/factor 汇集 → 落表 | P0 | — | model OK |
| PM-024 | ImprovementSuggestion apply route | POST /api/.../suggestion/:id/apply | P1 | PM-023 | 接口测试 |
| PM-025 | PersonalityStrategyMatcher | 性格画像 vs 策略画像匹配度 | P1 | — | 输出 |
| PM-026 | BehaviorBias 新 detector style_drift + time_bias | 6 类 detector | P1 | — | 单测 |
| PM-027 | apply 后效果跟踪 | 30 天 effect_metrics | P2 | PM-024 | 落表 |

---

## 2. 优先级与时间窗口估算

### 2.1 P0 故事 (89 个) — 0-3 个月

按层并行：
- **Sprint 1 (W1-W2)**：Layer 0 OPS-001~005 + Layer 1 D-001~010 + Layer 7 FE-031~035 (AlertsBell)
- **Sprint 2 (W3-W4)**：Layer 2 F-001~007 + Layer 1 D-011~012 + Layer 6 AE-001~004 (hard cutover)
- **Sprint 3 (W5-W6)**：Layer 3 S-001~007 + Layer 4 PR-001~007 + Layer 6 AE-011
- **Sprint 4 (W7-W8)**：Layer 6 ANN-001~007 + KOL-002~004 + QA-001~003 + CO-001~002
- **Sprint 5 (W9-W10)**：Layer 7 FE-001~030 (全 P0 workspace 改造)
- **Sprint 6 (W11-W12)**：Layer 8 PM-001~023 + Layer 7 FE-036~038

### 2.2 P1 故事 (75 个) — 3-6 个月

灰度推进、新数据源接入、复盘自动化、AI 增强。

### 2.3 P2 故事 (46 个) — 6 个月以上

性能优化、深度功能、长期积累。

---

## 3. 故事拆解原则

每个 user story 必须满足：
1. **≤ 1 context window**（≤ 600 行 diff）可完成
2. **可独立验收**（acceptanceCriteria ≥ 1 条具体可执行）
3. **依赖明确**（前置 story ID 列出）
4. **可单测**（pure function 优先；service 必须 mock DI）

如果某 story > 600 行 → 必须拆 2 个 sub-story。

---

## 4. 跑 ralph 启动方式

```bash
# 1. 把本文档第 1 节表格转为 prd.json
node scripts/roadmap-to-prd.js docs/trader-system/99_implementation_roadmap.md > ralph/prd.json

# 2. 启动 ralph 自动化实施
cd ralph && ./ralph.sh

# 3. ralph 会按 priority 升序 + dependency 拓扑序逐个 story 落地
```

每个 story 落地后：
- ralph 自动跑 typecheck + lint + npm test
- 通过则 commit + push + 标记 `passes: true`
- 失败则 rollback + 报告原因

预计 **210 个 story 全部落地约 6 个月**（按当前 ralph 速度 ~1-2 story/天 估算）。

---

## 5. 风险与依赖

1. **TradingAgents 远端服务可用性**：多个 AI story 依赖；fallback heuristic 必须可降级
2. **LLM API 配额**：AI 日记 / 周报 / 公告 NLP / Copilot 大量消耗；建议接入本地 OpenAI key + rate limit
3. **数据源稳定性**：AKShare 接口变更频繁；BaseSyncService 抽象统一兜底
4. **Migration 顺序**：每个 model 改动必须先 staging → prod；本路线图涉及 ~30 个 migration
5. **shadow 验证窗口**：策略参数 shadow 4 周 / 引擎 shadow 2-4 周；不可压缩

---

## 6. 结语

**这个 210 story 清单是当前 stocks 系统从"模拟盘工作"到"高级量化系统"的完整路径**。

每个 story 都基于：
- 现有代码 review（`文件:行号` 证据）
- 操盘手心智（"why we need it"）
- 工程可实施（"how to do it"）
- 可验收口径（"when it's done"）

**这个清单将被转换为 `ralph/prd.json` 自动化启动**——ralph agent 会按 priority + dependency 拓扑序逐个落地，每个 story 完成后跑 typecheck + lint + npm test + commit。预计 6 个月内全部落地。

完成后：
- A 股全市场 5500 只票每日因子 + 信号生成 ≤ 15 min
- 单策略 sharpe ≥ 1.2 / 组合 sharpe ≥ 1.5
- 任意 30 日窗口最大回撤 ≤ 12%
- 数据源任一挂掉自动降级（fail-closed）
- 每笔交易能给出 ≥ 3 条 AI evidence
- 用户能看到日 / 周 / 月 / 季 / 黑天鹅 5 层复盘 + AI 日记
- 前端 6 工作区每个内部信息密度 + UX 显著升级

—— **从模拟到生产 paper trade 1-3 个月 + alignment_score ≥ 85 后，才有资格谈实盘**。这条红线本路线图不跨。

