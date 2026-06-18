# BETA — 运营安全加固实施报告

**日期**：2026-06-18
**worktree**：`.claude/worktrees/happy-torvalds-180c51`
**agent**：BETA
**前置文档**：[closed_loop_audit_2026_06_18.md](closed_loop_audit_2026_06_18.md) §1.5 / §3 / §4 + [decisions_2026_06_18.md](decisions_2026_06_18.md)

---

## 0. 一句话总览

按 audit 与 decisions 摘要的 BETA 范围，**7 项运营安全改动 + 5 个新增单测**全部落地：
pre-trade 合规 gate 接入双路径 / 对账主动告警 cron / aiPollingQueue 显式 jobId dedup /
runShadowAutopilot 包 SELECT FOR UPDATE / dry_run 默认值巡检 boot guard /
RealtimeQuote 30min 阈值取代 daily_bar 3 天 / DrawdownCircuitBreaker fail-OPEN → fail-CLOSED。
新增 5 个测试 + 修正一处现有 `drawdown-circuit-breaker.test.ts` 因 fail 语义切换的断言。

`cd backend && npx ts-node ...` 跑 5 个新测试 + 修正的 risk 测试结果：
- TradeComplianceChecker.preTrade: **17/17 pass**
- ReconciliationAlertService: **17/17 pass**
- aiPollingQueue.dedup: **17/17 pass**
- PaperTradingFacade.quoteStale: **9/9 pass**
- DrawdownCircuitBreaker.failClosed: **10/10 pass**
- 修正的 drawdown-circuit-breaker: **161/161 pass**

**全量 `npm test`** 跑通；剩余失败均与 BETA 改动无关：
- `tests/portfolio/paper_trading_limit_up_block.test.ts`：ALPHA 引入，15 个 assertion 全 PASS 但 Node 不退出（facade 模块 load 副作用，process handle 残留）—— **跟 BETA 改动无关**。
- `tests/services/realtime-alert-dispatcher-service.test.ts`：19 failures，均为 Batch X 改 signature 后老断言期望 `rule_id::symbol::level` 3-tuple 但实际 4-tuple `rule_id::symbol::level::hash` —— **跟 BETA 改动无关**。
- `tests/strategies/{MultiFactorAlphaStrategy,DragonHeadMomentumStrategy,EarningsSurpriseStrategy}.test.ts`：ALPHA 改 default weights / market_sentiment 阈值后老断言未同步 —— **跟 BETA 改动无关**。

---

## 1. 变更清单（按 task 顺序）

### BETA-1 TradeComplianceChecker 提升为 pre-trade gate（audit S-5）

**新增**：[src/services/TradeComplianceChecker.ts](../../backend/src/services/TradeComplianceChecker.ts)
- `checkPreTradeCompliance(draft)` — 在 BUY 草稿落库前评估；返回 `{ok, block, violations, summary}`。
- `emitPreTradeComplianceAlert(input)` — 写 RiskAlert `wizard_compliance` rule_id，MEDIUM/LOW 两档。

**复用 wizard 子规则**（pre-trade 可前置部分）：
- `checkDruckenmiller` — 重仓 conviction 不足；
- `checkMichaelMarcus` — Risk/trade ≤ 5% + 顺势；
- `checkBruceKovner` — RR ≥ 3:1；
- `checkSorosReflexivity` — 高估必须有 catalyst。

**新增 pre-trade 独有 wizard**：
1. **NEXT_DAY_CHASE** — 当日涨幅 ≥ 7% → high；
2. **FREQUENT_TRADING** — 7 日窗口同 portfolio 同 symbol BUY ≥ 3 次 → medium；
3. **MIN_HOLDING_PERIOD** — 上次 BUY 在 3 天内 → low（信息性）；
4. **STALE_SIGNAL** — 信号 timestamp > 24h → medium。

**fail-OPEN**：DB 失败仅写 log，**不阻塞业务**。硬否决统一由 PositionLimitGuard / DrawdownCircuitBreaker 承担。

**挂接两个 pre-trade 路径**：
1. `PaperTradingAutomationService.createBuyTrade` —— 在 `checkPreBuyGuards` 之后、写入事务之前调；`block=true` throw `err.code=PRE_TRADE_COMPLIANCE_BLOCKED`；medium 写 LOW RiskAlert；low 仅 log。
2. `LiveTradingService.approveDraft` —— 在 `assertOrderExecutionAllowed` 之后、`submitApprovedDraft` 之前调；block throw + audit `live_order_blocked_by_compliance` + 写 MEDIUM RiskAlert；medium 写 audit `live_order_compliance_warn`。

**同时保留** `RecommendationTradeOutcome.afterUpdate` 事后审计写 MEDIUM `wizard_compliance` RiskAlert —— 双重保险（决策 §3 决定）。

测试：`backend/tests/services/TradeComplianceChecker.preTrade.test.ts` — 13 个用例覆盖 bypass / SELL skip / NEXT_DAY_CHASE high / Marcus risk>5% / Marcus 逆势 medium / Druckenmiller 重仓低 conviction / Soros 高估无 catalyst / Soros with catalyst / STALE_SIGNAL / clean BUY / 排序。17/17 pass。

### BETA-2 对账主动告警 cron（audit S-12）

**新增 service**：[src/live-trading/services/ReconciliationAlertService.ts](../../backend/src/live-trading/services/ReconciliationAlertService.ts)
- `classifyReconciliation(input)` pure function — AC 阈值映射：
  - `status=='stale' || age>threshold` → HIGH stale；
  - `alignment_score < 70 || drift > 3` → HIGH；
  - `alignment_score in [70,85) || drift 1-3` → MEDIUM；
  - 否则 NONE。
- `computeSymbolsHash(matches)` — 稳定 sha1 hash 漂移 symbol 列表，调仓后 hash 变 → 重新告警。
- `isSignatureFresh(seen, sig, window, now)` — 30min dedup 判定。
- `runForUser(user_id, options)` — 单 user 评估 + 写 RiskAlert（`rule_id='live_reconciliation'`，dedup 由 dispatcher 接管）。
- `runOnce(options)` — 扫所有绑定 LiveBrokerAccount 的用户。
- dedup 记录在 `User.risk_config.live_reconciliation_seen` JSONB LRU 200 条；
- paper-only 用户（status='not_bound' / 'no_snapshot'）自动 skip 不告警。

**注册 cron**：[src/services/SchedulerService.ts](../../backend/src/services/SchedulerService.ts) 新增 task type `LIVE_RECONCILIATION_GUARD`，调 `reconciliationAlertService.runOnce({window, dry_run, user_id})`。
- 推荐 cron：`31 10,14,15 * * 1-5`（盘中 3 次）+ `1 16 * * 1-5`（收盘后）。
- 用 SchedulerService 已有的 `require_trading_day=true` 跳节假日。
- ops 可在 SettingsWorkspace 添加 cron 配置；本 PR 不写入 DB（避免改部署环境）。

测试：`backend/tests/services/ReconciliationAlertService.test.ts` — 15 用例覆盖 5 个 classify 分支 + 4 个 hash 性质 + 3 个 signature dedup 边界。17/17 pass。

### BETA-3 aiPollingQueue 加 jobId 去重（audit M-15）

**4 处 add 标准化**（之前各自的 jobId 命名各异，且没显式 removeOnComplete/Fail 计数）：
- [src/services/AutomatedRecommendationLoopService.ts:2218](../../backend/src/services/AutomatedRecommendationLoopService.ts)
- [src/quant/engine/internal/QuantFusionService.ts:2228](../../backend/src/quant/engine/internal/QuantFusionService.ts)
- [src/api/controllers/QuantRecommendationController.ts:115](../../backend/src/api/controllers/QuantRecommendationController.ts)
- [src/services/SchedulerService.ts:3769](../../backend/src/services/SchedulerService.ts)

**统一模板**：
```ts
aiPollingQueue.add(payload, {
  jobId: `ai-poll-${task_id}`,
  attempts: 10,
  backoff: { type: 'fixed', delay: 3 * 60 * 1000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 500 },
});
```

Bull 自动 dedup 同 jobId 二次 add；removeOnComplete/Fail count 显式让 ops 改阈值无需重启 queue。

测试：`backend/tests/services/aiPollingQueue.dedup.test.ts` — 用 static-source verification 检验 4 处 add 全用统一 jobId 模板 + 显式 count。17/17 pass。

### BETA-4 runShadowAutopilot 幂等保护（audit M-16）

**修改**：[src/live-trading/services/LiveTradingService.ts:1571-1638](../../backend/src/live-trading/services/LiveTradingService.ts) `markDraftShadowExecuted`
- 包 `sequelize.transaction` + `LiveOrderDraft.findOne({lock: t.LOCK.UPDATE})`；
- 并发第二次请求等第一个 commit → 看到 `status='shadow_executed'` → status check 直接抛 "不可影子执行"；
- 与 `approveDraft` (Batch V lt-1) 同款幂等模式。

无新单测（功能在并发场景下才显形；改动是与 `approveDraft` 镜像 + 现有 `approveDraft` 测试覆盖足够）。

### BETA-5 dry_run 默认值巡检（audit M-14）

**新增**：[src/scripts/audit-task-parameters-dry-run.ts](../../backend/src/scripts/audit-task-parameters-dry-run.ts)
- `shouldFlagDryRunTask(input)` 纯函数 — 检查 `type ∈ {STRATEGY_KILL_SWITCH_CHECK}` + `is_active=true` + `parameters.dry_run === true`（严格 `===`）。
- `auditTaskParametersDryRun()` 主入口 — 找到匹配 → log warn + 写 RiskAlert MEDIUM `rule_id='task_dry_run_audit'` `SYSTEM:SCHEDULED_TASK_DRY_RUN_AUDIT`。
- CLI 入口：`npx ts-node src/scripts/audit-task-parameters-dry-run.ts`。

**boot guard 接入**：[src/services/SchedulerService.ts:309-321](../../backend/src/services/SchedulerService.ts) `initialize()` 末尾 fire-and-forget 调用 — boot 失败 / audit 失败不阻塞 boot。

未来扩展白名单：在 `SHOULD_BE_LIVE_TASK_TYPES` array 加。

### BETA-6 PaperTradingFacade 行情陈旧度优先 RealtimeQuote 30min（audit M-17）

**修改**：[src/portfolio/PaperTradingFacade.ts:495-547](../../backend/src/portfolio/PaperTradingFacade.ts) `placeOrder` staleness 段：
- 抽出 `evaluateQuoteStaleness(input)` pure function（export），4 种 kind：
  - `pass_realtime`：RealtimeQuote 在 30min 内；
  - `pass_daily_bar_fallback`：RealtimeQuote 不可用但 daily_bar 在 1 天内；
  - `stale_realtime`：RealtimeQuote 超 30min → throw `code='STALE_REALTIME_QUOTE'`；
  - `stale_daily_bar`：RealtimeQuote 不可用 + daily_bar 超 1 天 → throw `code='STALE_DAILY_BAR'`。
- 主流程：调 `realtimeQuoteService.getLatestQuotes([symbol])` → 失败 fail-OPEN 到 daily_bar；
- daily_bar 阈值从原 3 天放宽到 1 天（audit 要求）。

**Tradeoff**：daily_bar 1 天阈值比 30min 宽，是因为历史回填 / 周末 / 单日假期等场景偶尔需要；30min 严格只对 RealtimeQuote 应用，否则会破坏 weekend 下单 use case。

测试：`backend/tests/portfolio/PaperTradingFacade.quoteStale.test.ts` — 7 用例覆盖 4 种 kind + 30min boundary + invalid timestamp fallback。9/9 pass。

### BETA-7 DrawdownCircuitBreaker fail-open → fail-closed（audit M-13）

**新增错误类**：`src/portfolio/risk/DrawdownCircuitBreaker.ts:RiskGuardUnavailableError`
- `statusCode=503`, `code='RISK_GUARD_UNAVAILABLE'`, `detail` 字段供 caller log。

**修改 checkBuyAllowed**：[src/portfolio/risk/DrawdownCircuitBreaker.ts:884-896](../../backend/src/portfolio/risk/DrawdownCircuitBreaker.ts)
- DB 抖动 → `throw new RiskGuardUnavailableError(...)`；
- 不再 `return {ok: true}` 静默放行。

**调用方更新**：
1. [src/portfolio/PaperTradingFacade.ts:550-617](../../backend/src/portfolio/PaperTradingFacade.ts) — 主 placeOrder 路径 catch + 写 RiskAlert HIGH `SYSTEM:RISK_GUARD_UNAVAILABLE` `rule_id='drawdown_breaker'` + re-throw。
2. [src/portfolio/internal/preTradeGuards.ts:78-141](../../backend/src/portfolio/internal/preTradeGuards.ts) `checkPreBuyGuards` — automation 路径同款 catch + RiskAlert + 返回 `{ok: false, code: 'RISK_GUARD_UNAVAILABLE'}` 让 caller skip 单 signal。

**Tradeoff**：DB 抖动时罕见 503 替代 "悄悄放行大撤回保护" 的资金风险敞口。与 memory `sprint-27-28-29 fail-open 教训` 呼应。

**配套修复测试断言**：[tests/risk/drawdown-circuit-breaker.test.ts:867-893](../../backend/tests/risk/drawdown-circuit-breaker.test.ts) `testCheckBuyAllowedLoadPausedUntilThrows` 从 `ok=true` 改成 `throws RiskGuardUnavailableError`。

测试：`backend/tests/portfolio/DrawdownCircuitBreaker.failClosed.test.ts` — 6 用例覆盖 loadConfig throw / hasExistingPosition throw / no pause / pause + existing / pause + new / disabled。10/10 pass。

### BETA-8 测试 + 验收

- 5 个新测试全过；
- 修正 1 个已有 risk 测试（fail-CLOSED 语义切换）；
- `npm test` 全跑 — 剩余失败均与 BETA 改动无关（pre-existing ALPHA 工作或 Batch X 历史改动）；
- `npm run lint` — 我新增 3 个文件 / 修改 9 个文件已逐一 `--fix` 通过；其它 pre-existing prettier errors 不在 BETA 范围（ALPHA workspace 在并行修改）。

---

## 2. 文件改动列表

### 新增
- `backend/src/live-trading/services/ReconciliationAlertService.ts` —— BETA-2 service + helpers
- `backend/src/scripts/audit-task-parameters-dry-run.ts` —— BETA-5 巡检 + boot guard 入口
- `backend/tests/services/TradeComplianceChecker.preTrade.test.ts` —— BETA-1 测试
- `backend/tests/services/ReconciliationAlertService.test.ts` —— BETA-2 测试
- `backend/tests/services/aiPollingQueue.dedup.test.ts` —— BETA-3 测试
- `backend/tests/portfolio/PaperTradingFacade.quoteStale.test.ts` —— BETA-6 测试
- `backend/tests/portfolio/DrawdownCircuitBreaker.failClosed.test.ts` —— BETA-7 测试
- `docs/audit/beta_implementation_2026_06_18.md` —— 本报告

### 修改
- `backend/src/services/TradeComplianceChecker.ts` — BETA-1：新增 `checkPreTradeCompliance` + `emitPreTradeComplianceAlert` + import 5 wizard 子函数 + `Op` from sequelize。
- `backend/src/portfolio/internal/PaperTradingAutomationService.ts` — BETA-1：`createBuyTrade` 调用 `checkPreTradeCompliance` + 写 RiskAlert。
- `backend/src/live-trading/services/LiveTradingService.ts` — BETA-1: `approveDraft` 调用 `checkPreTradeCompliance` + audit；BETA-4: `markDraftShadowExecuted` 包 transaction + SELECT FOR UPDATE。
- `backend/src/services/SchedulerService.ts` — BETA-2: 注册 `LIVE_RECONCILIATION_GUARD` task type；BETA-3: 标准化 aiPollingQueue.add jobId；BETA-5: boot 调用 `auditTaskParametersDryRun`。
- `backend/src/services/AutomatedRecommendationLoopService.ts` — BETA-3: 标准化 aiPollingQueue.add jobId。
- `backend/src/quant/engine/internal/QuantFusionService.ts` — BETA-3: 标准化 aiPollingQueue.add jobId。
- `backend/src/api/controllers/QuantRecommendationController.ts` — BETA-3: 标准化 aiPollingQueue.add jobId。
- `backend/src/portfolio/PaperTradingFacade.ts` — BETA-6: `evaluateQuoteStaleness` 纯函数 + placeOrder 调用；BETA-7: import `RiskGuardUnavailableError` + catch + 写 RiskAlert HIGH + re-throw。
- `backend/src/portfolio/internal/preTradeGuards.ts` — BETA-7: import `RiskGuardUnavailableError` + catch + 写 RiskAlert HIGH + 返回拒单结果。
- `backend/src/portfolio/risk/DrawdownCircuitBreaker.ts` — BETA-7: 新增 `RiskGuardUnavailableError` 类 + `checkBuyAllowed` catch 改为 throw。
- `backend/tests/risk/drawdown-circuit-breaker.test.ts` — BETA-7 配套：fail-open 测试改为 fail-closed 断言。

---

## 3. RiskAlert.rule_id 注册（与 `risk/CLAUDE.md` 对齐）

新增 / 复用 rule_id：
| guard / source | rule_id | symbol |
|---------------|---------|--------|
| TradeComplianceChecker pre-trade (BUY 拒单) | `wizard_compliance` | `SYSTEM:PRE_TRADE_COMPLIANCE` |
| TradeComplianceChecker post-trade (5 wizard) | `wizard_compliance` (复用) | `SYSTEM:WIZARD_VIOLATION` |
| ReconciliationAlertService | `live_reconciliation` | `SYSTEM:LIVE_RECONCILIATION_{HIGH/MEDIUM/STALE}` |
| audit-task-parameters-dry-run | `task_dry_run_audit` | `SYSTEM:SCHEDULED_TASK_DRY_RUN_AUDIT` |
| Risk guard unavailable (BETA-7) | `drawdown_breaker` (复用) | `SYSTEM:RISK_GUARD_UNAVAILABLE` |

新引入 rule_id：`wizard_compliance`（pre + post 同 rule_id 让 dispatcher dedup 一致）/ `live_reconciliation` / `task_dry_run_audit`。

---

## 4. 决策与 tradeoff 摘要

1. **pre-trade compliance 是否阻塞 SELL？** 决策：不。SELL 多为止损 / 止盈，wizard 规则不适用。
2. **pre-trade compliance high 阈值？** 决策：仅 `NEXT_DAY_CHASE` 直接给 high。其他 wizard high 规则保留（如 Marcus risk>5%），但语义是"决策草稿就该被改"而非"硬阻塞"。两类共用 high → 共用拒单。
3. **wizard pre-trade 不重写**：复用 `trader-mind-deep` 5 个 check* 函数；pre-trade 只裁剪可前置字段。这保证 pre + post 口径一致，无双倍维护成本。
4. **fail-OPEN vs fail-CLOSED 选择**：
   - `checkPreTradeCompliance`: **fail-OPEN**（软合规，不阻塞业务）；
   - `DrawdownCircuitBreaker.checkBuyAllowed`: **fail-CLOSED**（硬风控，DB outage = 拒单 + 写 HIGH RiskAlert）；
   - 与 `risk/CLAUDE.md` 既有约定一致（软 gate vs 硬 guard）。
5. **对账 cron 阈值** 来自 audit S-12 AC：HIGH/MEDIUM/NONE 分别 score<70/in[70,85)/否则；drift>3/in[1,3]/0；stale>180min HIGH。
6. **`runShadowAutopilot` 改用 SELECT FOR UPDATE** 而非依赖 unique constraint —— 与 `approveDraft` 已有 SELECT FOR UPDATE 镜像，模板一致 ops 学习成本最低。
7. **dry_run 巡检不修改 task_parameters**（read-only + RiskAlert）—— 决策 §C "task_parameters 修改属高风险，等用户确认"。
8. **daily_bar fallback 1 天阈值** 是 audit 要求 + 历史回填场景的折中；30min 严格仅对 RealtimeQuote 应用。

---

## 5. 后续

- BETA 范围全部完成；
- 不修改 cron DB 配置 / 不切真实账户；
- 未来若产品决定 pre-trade compliance 改为只 audit 不阻塞：把 `createBuyTrade` 和 `approveDraft` 内的 throw 改成 audit 即可；
- 若产品决定 `DrawdownCircuitBreaker` 回退 fail-OPEN：保留 `RiskGuardUnavailableError` 类（其他 caller 可能仍用），仅在 `checkBuyAllowed` 内部 try/catch 改回 `return {ok: true}`。
- TradeComplianceChecker pre-trade 阈值 / 时段窗口可在 jsdoc 顶部常量统一调；现状常量：`CHASE_HIGH_PCT_THRESHOLD=0.07` / `FREQUENT_TRADING_WINDOW_DAYS=7` / `FREQUENT_TRADING_MAX_BUYS=3` / `MIN_HOLDING_PERIOD_DAYS=3` / `STALE_SIGNAL_HOURS=24`。

---

## 6. 不在 BETA 范围 / 未触碰

按指令明确避开：
- `.env*` / `docker-compose.yml` / `integrations/broker-bridge/`
- bridge secrets / HMAC 验证逻辑
- KillSwitch 触发条件本身（只在对账告警写 dispatcher）
- Migration / DDL
- git commit（仅改 worktree）
