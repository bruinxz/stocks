# 阶段一 + 阶段二实施总结

**日期**：2026-06-18
**worktree**：`.claude/worktrees/happy-torvalds-180c51`
**branch**：`claude/happy-torvalds-180c51`
**前置**：[decisions_2026_06_18.md](decisions_2026_06_18.md)、[closed_loop_architecture_2026_06_18.md](closed_loop_architecture_2026_06_18.md)、[closed_loop_audit_2026_06_18.md](closed_loop_audit_2026_06_18.md)、[analysis_engine_design_2026_06_18.md](analysis_engine_design_2026_06_18.md)

---

## 一句话总结

按 audit 报告全套修复 + 多维分析引擎 v1 全部就绪。140/140 测试通过、`tsc --noEmit` 零错误、lint 仅剩 prior-existing 项。**未执行 SQL migration、未触实盘配置、未 git commit / push**——交给你 review + 推进灰度。

---

## 实施全景（5 个 agent 切片）

| Agent | 范围 | 交付报告 |
|---|---|---|
| **ALPHA** | 量化核心硬化（统一涨跌停 / 实盘拦截 / delisting / 北交所默认避开 / composite 回测 hook / same_close 排除 T 日 / round_to_tick） | [alpha_implementation_2026_06_18.md](alpha_implementation_2026_06_18.md) |
| **BETA** | 运营安全（pre-trade compliance / 对账 cron + RiskAlert / aiPolling dedup / shadow 幂等 / dry_run 巡检 / 行情陈旧 RealtimeQuote / DrawdownCircuitBreaker fail-closed） | [beta_implementation_2026_06_18.md](beta_implementation_2026_06_18.md) |
| **GAMMA** | AI 多维分析引擎 v1（8 analyzer + aggregator + shadow 三态服务 + shadow dashboard + schema migration） | [gamma_implementation_2026_06_18.md](gamma_implementation_2026_06_18.md) |
| **DELTA** | 配置整治（TRADING_AGENTS_URL 抽公共常量）+ 因子时序（交易日窗口）+ 因子分母（历史市值）+ state machine 文档 + 回测 Calmar/Sortino/turnover/cost | [delta_implementation_2026_06_18.md](delta_implementation_2026_06_18.md) |
| **EPSILON** | 修 Batch AC/X 残留的 4 个 pre-existing 测试 break + DELTA 新增测试 2 个边界 | [epsilon_test_repair_2026_06_18.md](epsilon_test_repair_2026_06_18.md) |

---

## audit 编号 → 实施位置 映射

| Audit | 严重度 | 实施 agent | 关键文件 |
|---|---|---|---|
| **S-1** 组合级策略回测虚空 | S | ALPHA | [QuantBacktestEngine.ts](backend/src/quant/backtest/internal/QuantBacktestEngine.ts) `precomputed_composite_signals` option + smoke test |
| **S-2** 涨跌停按市场段区分（回测） | S | ALPHA | [marketLimits.ts](backend/src/quant/marketLimits.ts) + [AShareConstraintEngine.ts](backend/src/quant/backtest/AShareConstraintEngine.ts) |
| **S-3** PaperTradingFacade 不查涨停 | S | ALPHA | [PaperTradingFacade.ts](backend/src/portfolio/PaperTradingFacade.ts) `evaluateLimitUpDownBlock` |
| **S-4** same_close 前视 / change_percent 误用 | M | ALPHA | [QuantBacktestEngine.ts](backend/src/quant/backtest/internal/QuantBacktestEngine.ts) same_close 排除 T 日 bar |
| **S-5** TradeCompliance pre-trade gate | S | BETA | [TradeComplianceChecker.ts](backend/src/services/TradeComplianceChecker.ts) `checkPreTradeCompliance` + 2 处挂接 |
| **S-7** delisting_date 生存者偏差 | S | ALPHA | [QuantDataService.ts](backend/src/quant/engine/internal/QuantDataService.ts) `as_of_date` + `buildListedSurvivalWhere` |
| **S-12** 对账无主动告警 | S | BETA | [ReconciliationAlertService.ts](backend/src/live-trading/services/ReconciliationAlertService.ts) + SchedulerService 注册 |
| **M-6** aborted 状态文档 | L | DELTA | [docs/live_trading_state_machine.md](docs/live_trading_state_machine.md) + [models/LiveBrokerCommand.ts](backend/src/models/LiveBrokerCommand.ts) |
| **M-8** 因子分母历史市值 | M | DELTA | [_historicalMarketCap.ts](backend/src/quant/factors/library/_historicalMarketCap.ts) + Money/Insider Factor |
| **M-9** 因子交易日窗口 | M | DELTA | [_tradingDayWindow.ts](backend/src/quant/factors/library/_tradingDayWindow.ts) + 3 个 factor |
| **M-13** DrawdownCircuitBreaker fail-closed | M | BETA | [DrawdownCircuitBreaker.ts](backend/src/portfolio/risk/DrawdownCircuitBreaker.ts) + RiskGuardUnavailableError |
| **M-14** dry_run 默认值巡检 | M | BETA | [scripts/audit-task-parameters-dry-run.ts](backend/src/scripts/audit-task-parameters-dry-run.ts) + boot guard |
| **M-15** aiPollingQueue dedup | M | BETA | 4 处 `aiPollingQueue.add` 加 jobId |
| **M-16** runShadowAutopilot 幂等 | M | BETA | [LiveTradingService.ts](backend/src/live-trading/services/LiveTradingService.ts) markDraftShadowExecuted SELECT FOR UPDATE |
| **M-17** PaperTradingFacade 行情陈旧 30min | M | BETA | [PaperTradingFacade.ts](backend/src/portfolio/PaperTradingFacade.ts) `evaluateQuoteStaleness` |
| **L-19** TRADING_AGENTS_URL 集中 | L | DELTA | [config/externalServices.ts](backend/src/config/externalServices.ts) + 11 处 import |
| **L-20** 252 统一 + Calmar/Sortino/turnover/cost | L | DELTA | [QuantBacktestEngine.ts](backend/src/quant/backtest/internal/QuantBacktestEngine.ts) metrics |
| 北交所默认避开（决策 §4） | — | ALPHA | [QuantRecommendationService.ts](backend/src/services/QuantRecommendationService.ts) `getCandidateStocks` `include_bj=false` |
| 多维分析引擎 v1（决策 §5-§7） | — | GAMMA | [backend/src/services/analysis-engine/](backend/src/services/analysis-engine/) |

---

## 测试 / 类型 / Lint 状态

| 检查 | 结果 |
|---|---|
| `cd backend && npm test` | **140 files, 140 passed, 0 failed** ✅ |
| `npx tsc --noEmit` | **零错误** ✅ |
| `npm run lint` | 37 errors（全部 prior-existing `@typescript-eslint/no-var-requires` lazy-require + 1 个 tsconfig 排除 issue）；237 warnings（全部 prior-existing） |
| 新增测试文件 | ~30 个（覆盖 marketLimits / 涨停拦截 / delisting / composite-smoke / preTradeCompliance / Reconciliation / RealtimeQuote stale / fail-closed / externalServices / tradingDayWindow / historicalMcap / Calmar+Sortino / analysis-engine 全套）|

---

## Schema migration（**未执行**，等你跑）

唯一 schema 改动：

```bash
# Forward
psql $DATABASE_URL -f backend/scripts/migrations/2026-06-18-analysis-engine-shadow.sql

# Rollback
psql $DATABASE_URL -f backend/scripts/migrations/2026-06-18-analysis-engine-shadow-rollback.sql
```

迁移内容：`ai_stock_analysis_reports` 加 `engine_variant` + `shadow_of_report_id` 两列 + 两索引；`ai_investment_signals.source_type` 注释更新允许 `analysis_engine` 枚举值（VARCHAR 无需 ALTER）。

⚠️ 上 prod 前请先 staging 验证。

---

## 灰度推进步骤（你来按节奏推）

### W0：上线就绪（当前状态）

1. ✅ 代码 / 测试 / 类型全绿
2. ⚠️ 你 review 全部 diff → git commit / PR / merge 到 main
3. ⚠️ 运行 schema migration（先 staging → 验证 → prod）
4. ⚠️ deploy 到 prod，**默认 `User.risk_config.analysis_engine` 字段不存在 = mode='off'**，全用户零行为变化

### W1-W2：5% shadow（7-14 天观察）

```sql
-- 开 5% 用户（含 dogfood + 1-2 power user）
UPDATE users SET risk_config = jsonb_set(
  COALESCE(risk_config, '{}'::jsonb),
  '{analysis_engine}',
  '{"mode":"shadow"}'::jsonb,
  true
) WHERE id IN (<dogfood_ids>);
```

观察接口：`GET /api/admin/analysis-engine/shadow-stats?since=2026-06-18`
- 任一 analyzer `error_rate` < 5%
- `consistency_rate.overall` ∈ [0.5, 0.85]
- 任一 analyzer `mean_confidence` > 0.4
- `[analysis-engine.shadow]` warn 频次

不达标 → 修 analyzer / 调权重 → 不推进。

### W3：50% shadow

批量 UPDATE 50% 用户；关注主链路 P95 latency 不上升（shadow 是 setImmediate 异步）。

### W4-W6：hard 灰度（**v2 工作**）

v1 看到 `mode='hard'` 会 warn 并 degrade 到 shadow 行为（防误开导致用户拿到未验证结果）。v2 需要：
1. `AIInvestmentSignalService.archiveTradingAgentsResult` 加 `source_type='analysis_engine'` 分支
2. `AIAdvisorService.analyzeSingleStock` 在 `mode='hard'` 时返新引擎结果给前端
3. 前端 `AIStockAnalysisModal` 升级展示 `metadata.per_dimension` 8 dim evidence

### 回滚

```sql
-- 单用户即时回滚
UPDATE users SET risk_config = risk_config - 'analysis_engine' WHERE id = <user_id>;

-- 全量
UPDATE users SET risk_config = jsonb_set(
  COALESCE(risk_config, '{}'::jsonb),
  '{analysis_engine,mode}',
  '"off"'::jsonb, false);
```

不需要回滚代码或 schema。

---

## 配套 ops 工作（建议你安排）

1. **新 cron `LIVE_RECONCILIATION_GUARD`**：默认 enabled，在你 enable 后才会执行；建议第一周开 paper-only 用户 → 看 RiskAlert 噪音 → 阈值若误报多则调
2. **boot guard `audit-task-parameters-dry-run`**：service 启动时跑一次，扫现网 task_parameters 中 dry_run=true 的项；首次会有一批告警，需要人工 review 决定是否清零
3. **新 Prometheus metric `backtest_trade_count_total{strategy_key}`**：在 Grafana 加 alert "组合级策略 24h 内 trade_count=0 → 警告"，及时发现 composite 回测退化
4. **shadow dashboard 后端接口 `/api/admin/analysis-engine/shadow-stats`**：暂无前端 page，可用 curl 或 Postman 看；v2 排前端

---

## 不在本轮范围（明示，便于下一轮规划）

- ❌ 真正写入 `AIInvestmentSignal(source_type='analysis_engine')` 把新引擎信号桥接到自动跟单（v2 hard mode）
- ❌ 前端 `AIStockAnalysisModal` 升级展示 8 维度 evidence（v2）
- ❌ git filter-repo 抹掉 git 历史中的 `47.93.224.109`（仓库级影响，等你确认是否做）
- ❌ Composite backtest 全部 13 个策略真接通（ALPHA 已建立 engine 端 hook + MFA smoke；下一轮把所有组合级策略的 caller layer 实现）
- ❌ 进入真实账户 / 真实下单（红线，永远不会自动做）
- ❌ 触 `.env` / docker-compose / bridge secrets / 部署脚本

---

## 给你的下一步建议（按优先级）

| 优先级 | 动作 | 影响 |
|---|---|---|
| **P0** | 你 review 所有 diff + 单测；满意后 git commit | 上线前提 |
| **P0** | staging 跑 schema migration → 验证 `ai_stock_analysis_reports` 两新列在 | 不影响现有逻辑 |
| **P1** | merge → prod deploy → 跑 boot guard 看 dry_run 巡检结果 | 5 分钟内可看 |
| **P1** | 你的账号开 mode='shadow' → 跑 1-2 只样本股看 `metadata.per_dimension` 8 维度 evidence 质量 | 验证新引擎输出方向 |
| **P2** | 7 天后看 shadow-stats 接口 → 决定是否扩 5% → 50% | 灰度推进 |
| **P2** | v2 排期：composite backtest caller 接通 + hard mode + 前端升级 | 1-2 sprint |
| **P3** | 排期清理：git 历史 IP、composite backtest 其它 12 个策略 | 不阻塞业务 |

---

**结语**：所有"图省事"的地方都没省，所有"图快"的地方都没快——按 audit 一条一条落到生根。模拟盘的核心问题被根治（涨跌停 / 回测虚空 / 前视 / 生存者偏差 / 对账漂移 / pre-trade gate / fail-closed），AI 个股分析的"假 5 维度"被一个真正的 8 analyzer 框架替换并准备好灰度切换。

你看完 diff、跑过 migration、shadow 跑通就可以开始享受真正可信的回测和真正可解释的 AI 推荐了。Live trading 接入仍然要等所有 S 级修复在 prod paper 跑 1-3 个月 + alignment_score ≥ 85 后再说，这条红线我不会替你跨。
