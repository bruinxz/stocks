# `backend/src/services/` — Service 层 patterns

本文件总结 backend service 层的约定，特别是 2026-06 之后新增的"高级量化"5
个核心 service（research / execution / meta / portfolio / governor）。

## 5 个高级量化 service 总览

| Service | 目录 | 接入位置 | 持久化表 |
|---------|-----|---------|---------|
| ResearchIntegrityService | `research/` | PromotionGate (QuantStrategyParamVersionService.refreshParamLifecycle) | `research_integrity_audits` |
| ExecutionFeasibilityService | `execution/` | Buy Gate (PaperTradingAutomationService) | `execution_feasibility_records` |
| MetaLabelService | `meta/` | 信号过滤 (PaperTradingAutomationService) | `meta_label_decisions` |
| PortfolioConstructionService | `portfolio/` | **Sprint 29: buy-decision loop 已接入** (`PortfolioConstructionAdapter.ts`, 默认 mode='off' shadow/hard 用户切换) | `portfolio_construction_results` |
| EquityCurveGovernorService | `governor/` | **Sprint 28: 全 sizing method 生效** (含默认 equal_pct, 从 hard_cutover 分支移出) | `equity_curve_governor_states` |

## Service 编写约定（与 risk/ 一致）

1. **DataSource DI 模式**：每个 service 都有 `XxxDataSource` interface +
   `PRODUCTION_XXX_DATA_SOURCE` Sequelize 实现 + 单测注入 fake 完全脱 DB。

2. **纯函数 helpers 全 export**：所有业务逻辑可独立单测，service 本身只做
   DI + 持久化 + 错误处理 + log。

3. **fail-open 默认**：所有 gate 失败时 (DB 出错 / 数据缺失) **不阻塞主流程**
   — 仅写 warning log。这避免单个 service 故障让整个交易流程瘫痪。
   反例：DrawdownCircuitBreaker 是硬触发，DB 出错时也必须 pause。

4. **persist 可选**：所有 `xxx.action(input, { persist: true })` 默认为 false，
   caller 显式开启写库。这让单测 / dry-run / CLI preview 无需 DB schema 即可
   运行。

5. **Model 必须注册到 `config/database.ts`**：否则 `Model.create()` 会报
   `"Model not initialized: Member 'create' cannot be called"`。每加新 model 检查 list。

6. **5 项 DataSource 约定**：
   - 优先用 lazy `require()` 避免 service 顶部 import 重量级 model
   - try/catch 包裹外部 DB 查询，失败返回 null/[] 而非抛错
   - 测试注入 fake 用 `new XxxService(fakeDataSource)` 而非 monkey-patch

7. **rule_id 写入 RiskAlert（如适用）**：所有写 RiskAlert 的 guard 必须显式
   设 `rule_id` 让 dispatcher dedup 正确（见 `risk/CLAUDE.md` rule_id 表）。
   advanced quant 服务暂不写 RiskAlert（输出在自家表）；未来若加 alert，
   建议 `meta_label_low_confidence` / `execution_feasibility_blocked` 等。

## 集成路径（PaperTradingAutomationService 内）

下单候选 signal 流经的顺序（从早到晚）:

```
signal
  ↓ skip if 收益闸门 / outcome 反馈 / 数据质量 / etc.
  ↓ skip if seenSymbols (dedup)
  ↓ skip if entryRiskGuard (PaperTradingRiskProfileService)
  ↓ skip if environmentPolicy (regime)
  ↓ skip if executionReality (PaperTradingFacade pre-trade)
  ↓
  ↓ Sprint 2A: MetaLabelService.shouldBet → skip if decision='skip'
  ↓
  ↓ strategyVariant / strategyAllocationPolicy / sizing prep
  ↓ confidenceMultiplier / dataQualityMultiplier
  ↓ effectiveTargetPct 计算
  ↓
  ↓ Sprint 1B: ExecutionFeasibility.computeFeasibility → skip if decision='blocked'
  ↓ (decision='risky' 只 log warning)
  ↓
  ↓ Sprint 2 (existing): PositionSizingPolicy.decideSizing (Kelly / vol_target / atr_based)
  ↓
  ↓ Sprint 3: hard_cutover 时 effectiveTargetPct ×= governor.getCurrentMultiplier()
  ↓ skip if effectiveTargetPct < 0.5 (governor 降权后过低)
  ↓
  ↓ tradeRisk evaluation (industry concentration, position limits)
  ↓ facade.placeOrder
```

每个 gate 都 try/catch + fail-open（除 PositionLimit / DrawdownCircuitBreaker 等
硬风控）。所有"软过滤" gate 失败仅记 warning，让主流程继续。

## 错误隔离

- **per-signal try/catch**: 单条 signal 处理失败不影响后续 signals（已存在）
- **每个 service 内部 per-user try/catch**: governor.evaluateAll / RI batch
  audit 等批量场景，单 user 失败不阻塞其他 user
- **fail-open vs fail-closed 决策**:
  - fail-open (本批服务): MetaLabel / ExecutionFeasibility / Governor multiplier
  - fail-closed (硬风控): PositionLimitGuard / DrawdownCircuitBreaker.checkBuyAllowed

## 持久化模型加载（MetaLabel 特例）

`MetaLabelService` 启动时自动从 `data/meta-label-model.json` 加载训练好的模型。
- 文件不存在 → 走 fallback rule (signal_score × regime_multiplier)
- 文件 schema 不对 → log warn + 走 fallback
- CLI `npm run train:meta-label -- --since-days=180` 训练后自动写入此文件
- 进程已运行时调 `metaLabelService.reloadFromDisk()` 热更新

## Cron 任务接入（SchedulerService）

3 个新 task type:

```
EQUITY_CURVE_GOVERNOR_DAILY_EVAL  — 每日收盘后评估所有 portfolio (推荐 cron: "30 15 * * 1-5")
RESEARCH_INTEGRITY_BATCH_AUDIT    — 周批量审计近 N 天 backtest (推荐 cron: "0 2 * * 1")
STRATEGY_KILL_SWITCH_CHECK        — 已存在 (Phase 4)
```

加新 task type 步骤:
1. SchedulerService 加 `else if (task.type === 'XXX')` 分支
2. 调对应 service.method
3. 写 ScheduledTaskExecutionLog 包含 result_summary
4. ops 通过 SettingsWorkspace 添加 cron 配置

## HTTP 路由

所有 advanced quant endpoint 统一 mount 在 `/api/advanced-quant/*`:
- `/research-integrity/*` (audit, recent, by-strategy, by-backtest)
- `/execution-feasibility/*` (check, batch, recent)
- `/meta-label/*` (decide, train, model, recent)
- `/portfolio-construction/*` (construct, recent)
- `/governor/*` (evaluate, evaluate-all, multiplier, history)

详见 `api/routes/advancedQuant.routes.ts`。

## 与 risk/ 的关系

risk/ 是 **pre-trade hard guards**（PositionLimit / Drawdown / TrailingStop / etc.）。
advanced quant 5 个 service 是 **soft decision layers**（MetaLabel 过滤 / Feasibility
评分 / PortfolioConstruction 权重 / Governor multiplier / ResearchIntegrity gate）。

两者**串联**而非平行：每个 signal 先过 risk/ 硬 guard，再过 advanced quant 软
gate，最后 facade.placeOrder。两层都 fail 都阻止下单。

## RiskAlertService — 系统级风控告警统一入口 (OPS-005)

**何时用**：server-side 任何模块想发一条 "系统级" 风控告警时（与 risk guards
的 `RiskAlert.create` + model afterCreate hook 路径并存，本 service 提供
**按 severity 路由 + 多通道 fan-out** 的高阶 API）。

```ts
import { riskAlertService, RISK_ALERT_SEVERITY } from './RiskAlertService';
await riskAlertService.write({
  user_id, symbol, name, message,
  severity: RISK_ALERT_SEVERITY.CRITICAL, // 'critical' | 'high' | 'medium'
  rule_id: 'drawdown_breaker',
});
```

**路由规则（不可改，已强制测试）**：
- `critical` → inbox(DB level=HIGH) + 飞书 OPS 群 + IM(email) + toast(metadata.toast=true)
- `high`     → inbox(DB level=HIGH) + 飞书 OPS 群
- `medium`   → inbox(DB level=MEDIUM)

**与既有路径关系**：
- 不取代 risk guards 里散落的 `RiskAlert.create({...})`（那些走 model
  afterCreate hook → RealtimeAlertDispatcher 个性化推送，覆盖 level='HIGH'）
- 不取代 `audit-task-parameters-dry-run.ts` 的 risk_alert + feishu_ops 双
  通道（那是脚本专用 boot guard）
- critical/high 写完后还会 fire `RealtimeAlertDispatcher`（在 model hook
  之外补一道路径，hook 失效时 ops 仍能收到）

**channel 控制**：
- 默认按 severity 走 `SEVERITY_TO_CHANNELS` 表
- `options.override_channels` 强制覆盖（inbox 自动 prepend 防 DB 漏写）
- `options.dry_run=true` → 空 plan，所有通道不调
- `options.feishu_webhook_url` / `options.im_address` → 覆盖 env / user 表

**飞书 OPS 群 webhook env**：`OPS_ALERT_FEISHU_WEBHOOK`（与
audit-task-parameters-dry-run.ts 共享同一 env，避免运维多配一份）

## 测试

5 个 service 各有独立单测（188 tests）+ 1 个集成 smoke test:
- `tests/services/research-integrity-service.test.ts` (51 tests)
- `tests/services/execution-feasibility-service.test.ts` (44 tests)
- `tests/services/meta-label-service.test.ts` (30 tests)
- `tests/services/portfolio-construction-service.test.ts` (32 tests)
- `tests/services/equity-curve-governor-service.test.ts` (31 tests)
- `tests/services/advanced-quant-integration.test.ts` (10 tests E2E)

跑全部: `cd backend && npm test`（runner 顺序跑全部 .test.ts）
跑单个: `npx ts-node --transpile-only tests/services/research-integrity-service.test.ts`

## AnnouncementNLP — ANN-001 (US-025) 新字段约定

`AnnouncementSummary` 表 + `AnnouncementNLPRecord` 在 2026-06-19 ANN-001 落地后**多出三列**，
任何后续 ANN-002~007 / 新接入 caller 都必须同时填充：

| 列 | 类型 | 默认 | 由谁填 | 注意 |
|---|---|---|---|---|
| `event_type` | VARCHAR(40) NULL | NULL | US-026 `classifyEventType` | NULL = 未跑过分类；`'其它'` = 跑过且不属于前 6 类 (语义不同！) |
| `priority` | VARCHAR(20) NOT NULL | `'low'` | US-029 `computePriority` | `'critical'` 触发 US-031 5min 飞书 push — 任何 normalizer 默认必须返 `'low'`，绝不擅自 escalate |
| `entities` | JSONB NOT NULL | `[]` | US-027 `extractEntities` | 元素必须 `{name, role, holding_pct?}`；额外字段透传 |

**接入清单**（任何新建/扩展 NLP record 的代码 6 处必须改）：
1. `AnnouncementNLPRecord` interface 字段（`backend/src/services/AnnouncementNLPService.ts`）
2. `buildHeuristicNLPResult()` 默认占位
3. `buildNLPResultFromPayload()` — 成功路径走 `normalize*()`，FAILED fallback 走默认值
4. `DefaultAnnouncementNLPDataSource.saveSummaries()` 的 `bulkCreate` map + `updateOnDuplicate` 数组（漏一处 = re-sync 漂回默认值）
5. 测试 fake store + `installModelStubs()` 的 `FakeRowState`（不加新列 → 字段消失但测试不挂）
6. Model：`backend/src/models/AnnouncementSummary.ts` `@Column` + indexes

**归一函数 (`normalizePriority` / `normalizeEventType` / `normalizeEntities`) 安全默认**：

- `normalizePriority(raw)`: 未识别 → `'low'`（**绝不 escalate 到 `'critical'`**，否则远端 AI 返垃圾会触发飞书 push 风暴）
- `normalizeEventType(raw)`: 未识别字符串 → `'其它'`；null/empty → `null`（区分"跑过没识别"与"没跑过"）
- `normalizeEntities(raw)`: 非 array → `[]`；缺 name 或 role 的元素直接 drop（不报错）

**Migration**：`backend/scripts/migrations/2026-06-19-announcement-nlp-event-priority-entities.sql`
（+ 同名 `-rollback.sql`）— `IF NOT EXISTS` + `IF EXISTS` 幂等，可重复跑；
**生产执行**：`psql $DATABASE_URL -f backend/scripts/migrations/2026-06-19-announcement-nlp-event-priority-entities.sql`。

测试守护：`tests/services/announcement-nlp-service.test.ts` 内
`testSaveSummariesUpdateOnDuplicateIncludesNewFields` + `testAnnouncementSummaryModelHasNewColumns` +
`testMigrationSqlPresentAndComplete` 三处 META-GUARD（fs+regex 扫源文件 + SQL）— 漏改任何一处立刻挂。

---

## EastMoneyQATopicService — QA-001 subcategory 细化（2026-06-19）

`TOPIC_SUBCATEGORIES` 在 6 大父类 (FINANCE/PRODUCT/ORDER/POLICY/PERSONNEL/OTHER)
下细分 26 个 subcategory（含 6 个 `*_other` + 1 个 `other_general` 兜底，actionable = 20）。
`classifySubtopic(question)` 是 sub-first 启发式（命中数多者胜 + `TOPIC_SUBCATEGORY_PRIORITY` 升序 tie-break），
未命中走 `classifyTopic()` 的父类落 `*_other` 兜底，保证 `(topic, subtopic)` 严格 parent-child。

**新增 subtopic 字典 4 步**：
1. `TOPIC_SUBCATEGORIES` 加常量 + `SubtopicCategory` union 加成员 + `SUBTOPIC_VALUES` 数组追加
2. `TOPIC_SUBCATEGORY_OF` 加 1:1 父类映射（必填，否则 `deriveTopicFromSubtopic` 返 `undefined`）
3. `TOPIC_SUBCATEGORY_PRIORITY` 加数值（父类内升序，`*_other` 留 19/29/39/49/59 末档）
4. `TOPIC_SUBCATEGORY_KEYWORDS` 加 ≥ 3 关键词（`*_other` 留空数组，由 fallback 路径触发）

**字典顺序坑**：父类内更具体的 subtopic 关键词命中数若与泛化项打平，靠 `TOPIC_SUBCATEGORY_PRIORITY`
决定（不是字典声明顺序）。新增字典必须同步加单测样本到 `SUBTOPIC_LABELED_CORPUS` 维持 ≥ 80% 准确率
AC，已记录 1 例已知 misclassification（"出口管制" 中 'export' 比 'tariff' 命中先且数高）— 改进需引入
"否定词上下文 / 多词 phrase 优先" 启发，目前 99.1% 准确率不阻塞 AC。

---

## QALeadingSignalDetector — QA-003 业绩 leading 信号（2026-06-19）

`services/qa/QALeadingSignalDetector.ts` 是 **derived view**：消费 `EastMoneyQAStat`
（QA-002 已落表的按周聚合）→ 输出 3 类 leading signal（earnings_bullish /
earnings_bearish / earnings_forecast_leading）。**不写库 / 不写 RiskAlert / 不重拉远端 /
不重跑 NLP** —— 告警通路与 factor 接入分别由 QA-009 / QA-010 owner。

**新增信号 4 步**：
1. `SIGNAL_TYPES` 加常量 + `QALeadingSignalType` union 加成员
2. `SIGNAL_THRESHOLDS` 加数值阈值（**严格 > / <**，等于阈值不触发，防默认值 = 阈值误报）
3. `detectForStat()` 加 if 分支 push 到 `out[]`（同周多信号都返回，全局排序在 service 层）
4. `qa-leading-signal-detector.test.ts` 加 happy + 边界 + null 兜底 + AC 主验收

**`prev=null` vs `prev=0` 严格区分**（首坑）：
- `prev=null/undefined` → growth=null → 不触发 growth-class 信号（无 baseline week 存在）
- `prev=0 curr>0` → growth=+Infinity → 触发 growth-class（合法的 "0 → N" 暴增）
- 任一混淆都会过/漏触发。`detectForStat` 内有显式 prev null-check（短路 computeQuestionsGrowthPct）。

**`top_subtopic = earnings_forecast` 但 `template_score=null` 必须不触发 leading**：
NULL = 当周无任何回答（合法语义状态），≠ "回答模板分 0"。`detectForStat` 显式
`templateScore !== null` guard。

**Sequelize DECIMAL 字符串坑**：`EastMoneyQAStat.answer_rate / answer_template_score`
等 DECIMAL 列在原生 sequelize-typescript 返回字符串。`rowToStatLike()` 是统一入口，
对每个 numeric 字段 `Number()` 转一遍（带 string→0.5 + null→null 单测覆盖）。
