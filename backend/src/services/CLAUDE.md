# `backend/src/services/` — Service 层 patterns

本文件总结 backend service 层的约定，特别是 2026-06 之后新增的"高级量化"5
个核心 service（research / execution / meta / portfolio / governor）。

## 5 个高级量化 service 总览

| Service | 目录 | 接入位置 | 持久化表 |
|---------|-----|---------|---------|
| ResearchIntegrityService | `research/` | PromotionGate (QuantStrategyParamVersionService.refreshParamLifecycle) | `research_integrity_audits` |
| ExecutionFeasibilityService | `execution/` | Buy Gate (PaperTradingAutomationService) | `execution_feasibility_records` |
| MetaLabelService | `meta/` | 信号过滤 (PaperTradingAutomationService) | `meta_label_decisions` |
| PortfolioConstructionService | `portfolio/` | HTTP only (TODO: 一键再平衡接入 facade.applyAutomation) | `portfolio_construction_results` |
| EquityCurveGovernorService | `governor/` | Sizing 最终 multiplier (PaperTradingAutomationService.decideSizing hard cutover) | `equity_curve_governor_states` |

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
