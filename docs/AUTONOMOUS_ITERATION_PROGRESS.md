# Autonomous Iteration Progress

> Last updated: 2026-05-20
> Purpose: machine-readable handoff for continuing autonomous development after context compression.

## Current branch / workspace

- Branch: `dev_lym`
- Workspace: `/Users/bytedance/go/src/github.com/bruinxz/stocks`
- Primary server paths from prior context:
  - main: `/opt/stocks`, backend `3000`, frontend `3001`
  - lym: `/opt/stocks-lym`, backend `3010`, frontend `3011`
  - xxz: do not touch unless explicitly requested

## Validation commands

Use Codex Node runtime:

```bash
/Applications/Codex.app/Contents/Resources/node backend/node_modules/typescript/bin/tsc -p backend/tsconfig.json --pretty false
cd frontend && /Applications/Codex.app/Contents/Resources/node node_modules/typescript/bin/tsc --noEmit --pretty false
cd frontend && CI=false /Applications/Codex.app/Contents/Resources/node node_modules/react-scripts/bin/react-scripts.js build
git diff --check
```

Known frontend build warnings are historical Prettier warnings in existing files:

- `src/components/task/AuditSummaries.tsx`
- `src/components/task/RiskLimitPreviewModal.tsx`
- `src/pages/RecommendationLoopPolicies.tsx`
- `src/pages/TaskScheduler.tsx`

## Completed in current autonomous batch

### 2026-05-21 continuous iteration: real free factor source + opening rehearsal

- 数据更真实：
  - `EastMoneyClient` 增加免费实时快照接口，返回价格、成交额、换手率、PE/PB、市值、弱资金流/质量代理。
  - `StockFactorService` 的 provider plan 扩展为 `auto | tushare | eastmoney | local_derived`。
  - `auto` 现在优先 Tushare（如已配置），再使用东方财富免费真实快照，最后用 `local_derived` 兜底。
  - 因子覆盖 `source_quality` 增加 provider 状态，运行时健康可区分 `real_ready / derived_ready / limited / missing`。
- 纪律更可执行：
  - `QuantOpeningPreflightService` 增加安全演练 `runDryRun()`。
  - 新接口：`POST /api/strategy-research/opening-preflight/dry-run`。
  - 演练会刷新因子/行情并跑量化融合链路，但不会提交 Agent、不会写飞书、不会模拟买入，用于确认明天开盘任务能否跑出候选。
- 页面更简洁：
  - 今日作战台新增“明日开盘自动荐股准备度”，集中展示日扫任务、因子覆盖、真实数据源、自动参数与演练结果。
  - 复杂自检 issue 与演练明细折叠到“查看自检细节”，默认保持结论优先。
- 部署更稳定：
  - 只读 smoke 增加 `/api/strategy-research/opening-preflight` 结构校验，发布前可提前发现开盘链路接口断裂。

### 2026-05-21 continuous iteration: runtime buy gate grading

- 纪律更可执行：
  - `QuantRuntimeHealthService` 增加 `buy_gate`，把运行时异常拆成：
    - `blocking`：数据库字段、策略注册、实时行情缺失、自动任务缺失等硬阻断，暂停买入；
    - `degraded`：因子覆盖不足、闭环样本不足、参数观察项等非致命风险，降仓/观察放行；
    - `watch`：仅展示，不影响自动买入。
  - `QuantFusionService` 不再把所有 runtime `risk` 一律视为 no-buy；只有 `buy_gate.blocked=true` 才阻断，非致命风险会写入 `risk_profile_gate` 并自动降低交易数量/仓位。
  - 开盘自检把“因子覆盖已有真实源样本但不足 70%”从硬风险调整为降仓观察，避免系统长期停在 watch-only。
- 页面更简洁：
  - 量化收益驾驶舱的运行时健康卡新增 Buy Gate，直接说明“正常放行 / 降仓放行 / 暂停买入”，并展示硬阻断数、降仓项。
- 部署更稳定：
  - smoke 对 `/api/quant/runtime-health` 增加 `buy_gate` 结构校验，防止门禁字段缺失。

### 2026-05-21 continuous iteration: effective factor coverage window

- 数据更真实：
  - 修复因子覆盖率口径：不再只按“全局最新因子日”统计覆盖，避免当天仅同步一小批东方财富真实快照后，把其它仍有效的历史/派生因子误判为 0 覆盖。
  - `StockFactorService.getCoverage()` 改为按股票取 7 日有效窗口内最新因子快照，并按 source 统计有效来源。
  - 返回新增 `effective_factor_date`，用于区分“最新落盘日”和“有效覆盖口径日”。
- 纪律更可执行：
  - Buy Gate 的因子覆盖输入更稳定，避免因为局部真实快照试跑导致开盘链路被错误降仓/阻断。
- 页面更简洁：
  - 数据同步页、量化收益驾驶舱兼容 `effective_factor_date` 展示。
- 部署更稳定：
  - smoke 增加 `effective_factor_date` 结构校验，避免覆盖口径回退。

### Five-priority continuation batch (2026-05-20)

- Strategy runtime policy is now no longer only editable:
  - `QuantStrategyService.getRuntimePoliciesByStrategy()` exposes merged execution/environment/lifecycle policies.
  - `QuantSignalService.generateSignals()` reads per-strategy `execution_policy.min_score` and persists `strategy_runtime_policy` / `strategy_environment_policy` into signal raw factors.
  - Strategy environment policy is applied as a **soft guard**: preferred regimes lightly boost score, blocked regimes reduce score instead of hard-killing candidates.
  - Factor freshness discipline is applied in scoring: missing/stale factor snapshots add risk flags and reduce score.
- Quant fusion / simulated trading now carries strategy runtime policy:
  - `QuantFusionService` clamps candidate suggested position by strategy-level `max_position_pct`.
  - Archived AI signals and Agent polling jobs carry `strategy_runtime_policy`, so paper trading can obey per-strategy caps.
  - Daily pipeline result now surfaces `runtime_policy_diagnostics`.
- Parameter lifecycle is now operator-actionable:
  - Strategy Research Overview adds “预览生命周期” and “应用参数调整”.
  - Calls `POST /api/quant/param-lifecycle/refresh` with dry-run/apply modes.
  - Shows applied count and lifecycle summary in-page.
- Strategy visual editor is simplified:
  - Default drawer shows only enable/order + execution policy first.
  - Strategy params, environment policy and lifecycle rules are collapsed under advanced sections.
- Deployment stability hardening continues:
  - upload runtime path uses `UPLOADS_ROOT` / `shared/uploads` / writable fallbacks.
  - deployment scripts prepare `shared/uploads/avatars` before build/restart.

### Five-priority hardening batch

- Added runtime upload path resolver:
  - `backend/src/utils/runtimePaths.ts`
  - upload/static serving now prefers `shared/uploads` or explicit `UPLOADS_ROOT` over release-local `backend/uploads`
  - prevents release switch permission issues from crashing backend on avatar directory creation
- Deployment scripts now self-heal runtime directories before build/restart:
  - new `scripts/deployment/ensure_runtime_paths.js`
  - used by `simple_deploy.js` and `sync_and_deploy.js`
- Added real factor provider smoke test:
  - `StockFactorService.runProviderSmokeTest()`
  - `TushareClient.smokeTest()`
  - endpoint `GET /api/market/factors/provider-smoke`
- Opening preflight now includes `factor_provider`:
  - clearly reports whether real Tushare slices (`daily_basic / moneyflow / fina_indicator`) are available
  - if not, conclusion explicitly states fallback to `local_derived`
- Quant data freshness now includes `factor_snapshots`:
  - latest factor date
  - minimum coverage rate across valuation / money_flow / fundamental
  - source breakdown visibility
- Today Command Center now includes `discipline`:
  - buy allowed or paused
  - max new positions
  - default position pct
  - single-position cap
  - min cash reserve / max total exposure
  - forbidden industries / high-risk symbols
  - review time and concise execution actions
- Frontend simplification first slice shipped:
  - Today page adds “今日交易纪律” and “卖出/减仓优先队列”
  - Strategy Research Overview adds “参数生命周期状态” and “真实因子源状态”
  - remains conclusion-first without changing existing functionality

### P4 quant parameter / factor loop

- Added `QuantStrategyParamVersionService.getActiveParamsForScan()`.
  - Priority: manual override > champion > active_candidate (`grid_search` / `experiment`) > baseline.
  - Returns `recommended_params_by_strategy`, `adopted_param_version_by_strategy`, `selections`, `diagnostics_by_strategy`.
- `QuantFusionService.runDailyPipeline()` now uses active scan params.
  - Keeps explicit task `params_by_strategy` highest priority.
  - New result field: `generated.active_scan_params`.
- Fixed `QuantController.runDailyPipeline()` so default strategy params are not incorrectly passed as manual overrides.
- Added endpoint: `GET /api/quant/param-versions/active-scan`.
- Strategy Research Center now displays “next opening scan param versions” and simplified candidate diagnostics.
- Grid-search param version UX improved in `/quant/backtests`:
  - Shows explanation that deposited versions join daily scan and A/B validation.
  - Shows version tags after upsert.
- Quant daily pipeline now does pre-scan factor sync by default.
  - Options: `sync_factors_before_scan`, `factor_sync_scope`, `factor_sync_limit`, `factor_sync_skip_if_coverage_rate_gte`.
  - Default skip threshold: 92% min coverage across valuation/money_flow/fundamental.
- Added pluggable factor provider plan in `StockFactorService`.
  - `provider=auto | local_derived | tushare`.
  - `auto` attempts Tushare when enabled, keeps `local_derived` fallback.
- Added Python Tushare command `tushare_get_factor_snapshot`.
  - Best-effort calls: `daily_basic`, `moneyflow`, `fina_indicator`.
  - Per-endpoint failures are captured in `errors` instead of failing whole sync.
- Added `TushareClient.getFactorSnapshots()`.
- Factor coverage endpoint now returns `source_breakdown`.
- Data sync page shows factor source composition.
- `QuantDataService` now prefers factor rows by latest `factor_date`, then provider priority:
  - tushare > eastmoney > akshare > local_derived > unknown.
- Factor-aware strategies now include factor source tags in raw factors.
- Feishu quant task report now includes:
  - factor refresh count/provider/upserts,
  - active scan param version summary,
  - these are included in markdown message and JSON summary.

## Important files changed in this batch

Backend:

- `backend/src/quant/services/QuantStrategyParamVersionService.ts`
- `backend/src/quant/services/QuantFusionService.ts`
- `backend/src/api/controllers/QuantController.ts`
- `backend/src/api/routes/quant.routes.ts`
- `backend/src/data/services/StockFactorService.ts`
- `backend/src/data/sources/TushareClient.ts`
- `backend/python/market_data_helper.py`
- `backend/src/quant/services/QuantDataService.ts`
- `backend/src/quant/strategies/MultiFactorRankingStrategy.ts`
- `backend/src/quant/strategies/LowVolatilityQualityStrategy.ts`
- `backend/src/quant/strategies/VolumePriceConfirmationStrategy.ts`
- `backend/src/services/SchedulerService.ts`
- `backend/src/services/FeishuTaskReportService.ts`
- `backend/src/services/StrategyResearchCenterService.ts`

Frontend:

- `frontend/src/pages/QuantBacktestLab.tsx`
- `frontend/src/pages/StrategyResearchCenter.tsx`
- `frontend/src/pages/DataUpdateStatus.tsx`
- `frontend/src/index.css`

Docs:

- `docs/ITERATION_PLAN_0507.md`
- `docs/FUNCTION_GUIDE_AND_OPERATION_MANUAL.md`
- `docs/AUTONOMOUS_ITERATION_PROGRESS.md`

## Suggested next tasks

1. Add a lightweight scheduled-task preflight/check endpoint for tomorrow open:
   - Verify active `QUANT_DAILY_PIPELINE` exists.
   - Verify factor coverage >= threshold.
   - Verify realtime quote persistence recently worked.
   - Verify Feishu table/bot reporting not disabled.
2. Add UI badge on Today Command Center for:
   - latest factor sync status,
   - active scan param status,
   - next scheduled quant task time.
3. Implement Tushare token smoke test endpoint:
   - Calls factor snapshot for 1 symbol with very small scope.
   - Shows missing package/token/permission errors clearly.
4. Improve grid-search rank score:
   - Penalize too few trades,
   - penalize high execution blocked ratio,
   - prefer validation + test consistency.
5. Add factor freshness guard to strategy score:
   - If factor_date is too stale, reduce factor contribution or add risk flag.

## Do not forget

- Keep Feishu messages concise: conclusion + core reasons only.
- Recommendation messages must include current/analysis price.
- Do not touch xxz server/path unless explicitly requested.
- Preserve snake_case for DB/model/API fields.

## Server reset closed-loop rebuild (2026-05-19)

Goal: rebuild data loop after server data loss:

1. full-market A-share daily bars;
2. derived/real factor snapshots;
3. historical quant backtests;
4. quant signals/rankings;
5. small fusion pipeline smoke before tomorrow open.

Current verified server:

- Host: `103.242.3.87`, SSH port `29767`.
- Project: `/opt/stocks/current`.
- Public service: `http://103.242.3.87:3001`.
- DB/Redis containers: `stocks-postgres`, `stocks-redis`.
- Backend/Nginx active.

Current data snapshot:

- `stocks = 5522`.
- `daily_bars = 24099`.
- `stocks_with_bars = 367`.
- `quant_strategies = 9`.
- `quant_backtest_tasks/results/trades = 0`.
- `quant_signals = 0`.
- factor tables are still empty.

Fix already applied before this note:

- `SYNC_HISTORY` cold-start no longer skips no-bar stocks when coverage is low.
- Full-history task 2 now uses `tencent_only`, `batch_limit=100`, `concurrency=2`, `lookback_days=180`.
- History sync prioritizes `sh.60%`, `sz.00%`, `sz.30%`, `sh.68%`, then `bj.%`.

New helper:

- `scripts/deployment/rebuild_data_closed_loop.sh`
  - Resumable server-side rebuild script.
  - Loops `/api/tasks/2/run` while data-update queue is idle.
  - Uses correct `count(distinct ...)` coverage stats.
  - Can optionally run factor chunks, queue quant backtest chunks, generate quant signals, and run a no-write/no-report daily-pipeline smoke.

Recommended next command on server:

```bash
cd /opt/stocks/current
RUN_FACTORS_AFTER=0 \
RUN_BACKTESTS_AFTER=0 \
RUN_SIGNALS_AFTER=0 \
RUN_DAILY_PIPELINE_AFTER=0 \
MAX_MARKET_ROUNDS=80 \
TARGET_WITH_BARS=5000 \
TARGET_COVERAGE_PCT=92 \
./scripts/deployment/rebuild_data_closed_loop.sh
```

After coverage threshold:

```bash
RUN_FACTORS_AFTER=1 \
RUN_BACKTESTS_AFTER=1 \
WAIT_BACKTESTS_AFTER_QUEUE=1 \
RUN_SIGNALS_AFTER=1 \
RUN_DAILY_PIPELINE_AFTER=1 \
MAX_MARKET_ROUNDS=0 \
BACKTEST_CHUNK_SIZE=500 \
FACTOR_CHUNK_SIZE=800 \
./scripts/deployment/rebuild_data_closed_loop.sh
```

Script update: it now captures queued quant backtest task IDs and can wait for those tasks to leave `QUEUED/RUNNING` before generating signals (`WAIT_BACKTESTS_AFTER_QUEUE=1`, default enabled).

## Additional completed after progress file creation

- Added `QuantOpeningPreflightService` and `GET /api/strategy-research/opening-preflight`.
  - Checks active quant daily task, watchdog, factor coverage, realtime quote persistence, active scan params, Feishu table/bot config.
  - Strategy Research Overview now shows top preflight alert + tags.
- Added factor sync skip guard:
  - `skip_if_coverage_rate_gte` in `StockFactorService.syncDerivedFactors()`.
  - `factor_sync_skip_if_coverage_rate_gte` in quant daily pipeline and scheduler params.
  - Default threshold is 92%.
- `active-scan` now returns `diagnostics_by_strategy` with candidate ranking and why non-selected candidates were not adopted.
- Feishu quant report includes `factor_sync` and `active_scan_params` in both readable message and JSON summary.

## Latest validation after additional work

Passed:

```bash
/Applications/Codex.app/Contents/Resources/node backend/node_modules/typescript/bin/tsc -p backend/tsconfig.json --pretty false
cd frontend && /Applications/Codex.app/Contents/Resources/node node_modules/typescript/bin/tsc --noEmit --pretty false
cd frontend && CI=false /Applications/Codex.app/Contents/Resources/node node_modules/react-scripts/bin/react-scripts.js build
git diff --check
```

## Server reset closed-loop rebuild finalization (2026-05-19 evening)

Completed on production `/opt/stocks/current` and verified through API:

- Full-market daily bars restored:
  - listed A-share stocks: `5518`
  - stocks with bars: `5516` (`99.96%`)
  - `daily_bars = 596231`
  - date range: `2025-11-20 ~ 2026-05-19`
- Factor snapshots restored with free `local_derived` fallback:
  - `stock_valuation_factors = 5190`
  - `stock_money_flow_factors = 5190`
  - `stock_fundamental_factors = 5190`
- Historical quant backtests completed:
  - `quant_backtest_tasks = 11`, all `COMPLETED`
  - `quant_backtest_results = 99`
  - `quant_backtest_trades = 5501`
  - best result: `multi_factor_ranking`, total return `35.4854%`, excess `32.6211%`, max drawdown `-10.6479%`, Sharpe `3.6351`
- Quant signals/ranking restored:
  - `quant_signals = 1022`
  - `ai_investment_signals = 60`
  - daily-pipeline smoke succeeded in `archive_only` mode: scanned `215`, signal count `220`, archive total `30`, selected `30`
- API/UI fixes deployed:
  - `/api/quant/rankings` summary no longer overwrites quant `buy_count` with fusion `buy_count`; fusion counts now use `fusion_*` fields.
  - Ranking APIs fall back to the latest available signal/fusion date when the requested date has no rows.
  - `/api/quant/performance-dashboard` now exposes `latest_backtests.overview` so the page directly shows task/result/trade count, average return, positive-result rate and latest run range.
  - `StockFactorService.getCoverage()` uses the latest factor date instead of requiring exact same-day factor rows when daily bars are newer than low-frequency factors; preflight factor risk is cleared.
  - Market universe ordering no longer depends on mostly-null `updated_at`/market-cap fields after cold reset; main A-share prefixes are prioritized before BJ.
  - `RealtimeQuoteService` now falls back to Tencent real-time quote endpoint when AKShare/EastMoney returns empty or disconnects.
- Latest opening preflight:
  - `risk_count = 0`
  - `warn_count = 0`
  - conclusion: opening quant chain self-check passed.
  - realtime quote rows persisted via Tencent fallback: `120` symbols, latest quote time `2026-05-19T08:15:00Z`.

Validation commands passed locally:

```bash
cd backend && node node_modules/typescript/bin/tsc --noEmit --pretty false
cd frontend && DISABLE_ESLINT_PLUGIN=true node node_modules/react-scripts/bin/react-scripts.js build
git diff --check -- <targeted changed files>
```

Remaining observations:

- `quant_fusion_audits = 0` because the rebuild smoke intentionally disabled Agent submission/Feishu/paper-trading writes. Tomorrow's scheduled open/close pipeline should create fusion audits once Agent async jobs complete.
- Realtime quote freshness can become `stale` outside market hours, but preflight now treats persisted stale quotes as OK because the open scan refreshes quotes again before scoring.
- The current rebuild used Tencent daily bars and local-derived factors. Paid/real Tushare factors can later replace/enrich `local_derived` without schema changes.

## Final online validation and notification hardening (2026-05-19 late evening)

Additional hardening completed after initial rebuild validation:

- Quant scheduled tasks now explicitly include `notify_to_feishu_bot=true`:
  - `量化策略全市场扫描` (`32 15 * * 1-5`)
  - `量化策略开盘机会扫描` (`35 9 * * 1-5`)
  - `量化开盘链路看门狗` (`55 9 * * 1-5`)
- `SchedulerService` passes `notify_to_feishu_bot` into `QuantFusionService.runDailyPipeline`; default is `true` unless task params explicitly disable it.
- Public read-only smoke script now supports production frontend URLs (`:3001`) by:
  - trying `/health` then `/healthz` for process health,
  - skipping root JSON check by default because the public root normally serves React HTML.

Latest online validation:

```bash
SMOKE_BASE_URL=http://127.0.0.1:3001 \
SMOKE_USERNAME=lym \
SMOKE_PASSWORD=666 \
SMOKE_TIMEOUT_MS=20000 \
node scripts/tests/smoke_readonly_core.js
```

Result:

- `passed = 27`
- `failed = 0`
- `critical_failed = 0`
- `skipped = 2` (`api root`, external TradingAgents health)

Additional online checks:

- `/api/tasks/automation-health`: `critical_issues = 0`, `warnings = 0`, queues idle, runtime schema `healthy`.
- `/api/strategy-research/opening-preflight`: `risk_count = 0`, `warn_count = 0`.
- Quant tasks confirmed in DB with `refresh_realtime_quotes=true`, `report_to_feishu=true`, `notify_to_feishu_bot=true`, `submit_agent_analysis=true`, `run_paper_trading=true` for open/close scans.

## 2026-05-19 continuous iteration: lifecycle guard + freshness observability

Completed in this iteration:

- Added quant data freshness snapshot API `GET /api/quant/data-freshness`:
  - Checks `realtime_quotes`, `quant_signals`, archived quant recommendations, `quant_fusion_audits`, param validations, and paper-trade outcomes.
  - Returns `status / summary / checks / issues` without writing data, triggering queues, Agent, or trades.
- Extended opening preflight with `data_freshness` so the strategy research overview can show whether the open recommendation chain has recent quotes, signals, archives, Agent fusion, A/B samples, and paper-trading outcomes.
- Added a concise frontend “开盘数据闭环检查” card in `StrategyResearchCenter` using a light, readable card grid. It surfaces only the result users need: normal / observe / risk plus one-line reason.
- Strengthened param-version lifecycle:
  - Promotion/degrade/rollback thresholds are now adjusted by strategy risk level (`low / medium / high`).
  - High-risk breakout-style strategies require more samples, stronger excess return, stronger win rate, and more environment confirmation before becoming champion.
  - Low-risk defensive strategies can promote with slightly lower sample thresholds but require more trade evidence before rollback.
  - Degraded/rolled-back versions get `lifecycle_cooldown_until`; rolled-back versions and still-cooling degraded versions are excluded from opening-scan candidates.
  - Active-scan diagnostics now exposes excluded versions and reasons, making it clear why a candidate parameter did not enter production scanning.
- Feishu quant task report now includes a short line explaining that risk-adjusted param lifecycle guard is active, while keeping the message conclusion-oriented.
- Read-only smoke now includes `quant data freshness` endpoint validation.

Local validation passed:

```bash
node --check scripts/tests/smoke_readonly_core.js
cd backend && node node_modules/typescript/bin/tsc --noEmit --pretty false
cd frontend && DISABLE_ESLINT_PLUGIN=true node node_modules/react-scripts/bin/react-scripts.js build
```

Next priority:

1. Deploy this guard/freshness iteration to `/opt/stocks/current`, restart backend/nginx, and run production smoke.
2. After 09:35/09:55 open scan, verify data freshness moves from archived-only state to Agent fusion + paper-trade state.
3. If `quant_fusion_audits` stays empty after Agent jobs finish, inspect `ai_polling` jobs and TradingAgents health.

## 2026-05-19 continuous iteration: dashboard freshness entry

Completed after deployment smoke:

- `QuantPerformanceDashboardService` now includes `data_freshness` in `/api/quant/performance-dashboard`.
- Readiness score adds “闭环无关键风险” so the dashboard no longer only checks raw quote persistence; it also considers whether the chain has critical gaps.
- Quant收益驾驶舱新增“今日推荐链路可信度” card:
  - realtime quotes
  - quant signals
  - archived recommendations
  - Agent fusion audits
  - parameter A/B validation
  - paper-trading outcomes
- This mirrors the strategy-research preflight card but is closer to where users decide whether today's recommendations are worth watching.

Local validation passed again:

```bash
cd backend && node node_modules/typescript/bin/tsc --noEmit --pretty false
cd frontend && DISABLE_ESLINT_PLUGIN=true node node_modules/react-scripts/bin/react-scripts.js build
```

## 2026-05-19 continuous iteration: historical signal anti-lookahead guard

During data-closure backfill, a historical `trade_date=2026-04-20` signal used the latest realtime quote metadata from `2026-05-19`, which could pollute historical A/B validation.

Fix completed:

- `QuantSignalService.generateSignals` now defaults `include_realtime_quote=false` for historical `trade_date < today`.
- Current/future open scans still default to realtime quote integration.
- Manual callers can still explicitly pass `include_realtime_quote` if needed, but historical backfill no longer time-travels by default.

Next cleanup:

- Delete and rebuild the contaminated `2026-04-20` quant signals and param validations after deploying this guard.

## 2026-05-19 continuous iteration: closed-loop recovery fixes completed

Completed after the historical anti-lookahead guard deployment:

- Deployed `QuantSignalService` anti-lookahead guard to `/opt/stocks/current` and reran production smoke successfully.
- Cleaned and rebuilt the contaminated historical backfill day `2026-04-20`:
  - deleted `254` historical `quant_signals` and `860` related `quant_strategy_param_validations` for that date only;
  - regenerated `254` signals with `include_realtime_quote=false` and `refresh_realtime_quotes=false`;
  - rebuilt `860` completed A/B validation rows;
  - verification now shows `price_source in (daily_bar, stock_snapshot)` and `latest_quote_time is null`, so no future realtime quote remains in the historical sample.
- Diagnosed why pure quant paper-trading outcomes stayed at `0`:
  - cold-start profit/outcome gates reduced position size to about `0.68%`;
  - A-share one-lot trading requires `100` shares, so most higher-priced candidates were skipped as “cannot buy one lot”.
- Added a controlled minimum-lot sampling guard for forced pipeline signals in `PaperTradingAutomationService`:
  - applies only to explicitly forced `signal_ids`;
  - still respects cash, max daily new positions, daily exposure, total exposure, industry exposure, and strategy single-stock cap;
  - records `min_lot_sample` and `min_lot_sample_reason` in trade payload and signal metadata.
- Executed a small real pure-quant paper-trade sample:
  - `Codex纯量化模拟盘（20W）` bought `sz.300693 盛弘股份` and `sz.300691 联合光电`, 100 shares each;
  - `recommendation_trade_outcomes` now has `2` open rows, enabling downstream outcome feedback.
- Diagnosed why `quant_fusion_audits` stayed at `0`:
  - `ai_polling` jobs completed, and TradingAgents was healthy;
  - but `loopRunId` was undefined and the worker still queried `RecommendationLoopPolicySnapshot` with `where: { loop_run_id: undefined }`, causing Sequelize to throw before archiving the TradingAgents signal.
- Fixed `aiPollingWorker` so policy snapshot lookup is skipped when `loopRunId` is absent.
- Repaired the two already completed quant Agent jobs:
  - archived `2` TradingAgents signals;
  - created `2` `quant_fusion_audits`;
  - Agent conclusions were conservative (`watch` / `avoid`), so the Agent-fusion paper portfolio correctly did not force a buy.

Current online closed-loop health:

- `/api/quant/data-freshness`: `status=ok`, `risk_count=0`, `warn_count=0`.
- `/api/quant/performance-dashboard`: `readiness.score=100`, `ready=true`.
- Key counts:
  - realtime quotes today: `200`
  - quant signals today: `1182`
  - archived quant recommendations today: `71`
  - Agent fusion audits today: `2`
  - parameter validations completed: `860`
  - paper-trade outcomes open: `2`

Follow-up observation for tomorrow:

1. Confirm 09:35 open scan refreshes fresh quotes and creates new quant recommendations without manual intervention.
2. Confirm 09:55 watchdog remains green and writes concise Feishu message.
3. Confirm newly completed Agent jobs archive without `loop_run_id` errors and increment `quant_fusion_audits` automatically.
4. Track pure-quant open outcomes over 1/3/5/10 days before raising position limits.

## 2026-05-20 continuous iteration: runtime realism and safer release gate

Focus: make the system more real-data aware and prevent unstable deployments from staying online.

Completed:

- Production verification after the previous runtime-health release:
  - restarted main + lym backend services only;
  - verified `/health`, frontends, `/api/quant/runtime-health` and read-only smoke on both environments;
  - smoke result: `29 passed / 0 failed` for main and lym.
- Runtime health now includes a dedicated **factor coverage / real-source** check:
  - samples market factor coverage before open scans;
  - reports minimum valuation/money-flow/fundamental coverage;
  - reports real-provider rate vs local-derived fallback;
  - exposes `factor_coverage` in `/api/quant/runtime-health` and dashboard payload.
- `StockFactorService.getCoverage()` now returns:
  - `latest_landed_factor_date`
  - `factor_lag_days`
  - `coverage_status`
  - `source_quality.real_provider_rate`
  - clearer next actions when factors are stale or mostly local-derived.
- Quant daily pipeline now has a hard discipline guard:
  - after signal archive, it re-checks runtime health;
  - if runtime health is `risk`, it keeps archived watch-only signals but blocks Agent/paper-buy execution;
  - default scheduled open/close quant pipeline parameters now set `block_buy_on_runtime_risk=true`.
- Scheduled quant defaults are more explicit:
  - factor sync before scan enabled;
  - factor sync scope/limit/skip threshold persisted in default task parameters.
- Read-only smoke now validates factor coverage appears in runtime-health.
- Added `scripts/deployment/release_health_gate.js`:
  - restarts requested services;
  - runs backend/frontend health and read-only smoke;
  - rolls back `current` symlink to previous release and restarts when health fails;
  - defaults to main + lym and intentionally does not touch xxz.

Next:

1. Wire `release_health_gate.js` into the normal deploy path so activation + health + rollback becomes one command.
2. Add factor freshness and real-provider rate into the quant dashboard UI summary so users can see whether the model is using real data or local fallback.
3. Add a small backend audit record for runtime-risk blocked quant runs so “why no buy today” is visible in task history.

## 2026-05-21 continuous iteration: release gate integration and visible no-buy reasons

Focus: make deployment more stable and make “why no buy today” visible to operators/users.

Completed:

- Added `task_execution_logs.result_summary` as a JSONB runtime summary column.
  - Startup guard and deployment migration both add it idempotently.
  - Runtime schema required-column health now checks it.
- Quant daily pipeline now writes a compact execution summary into `task_execution_logs.result_summary`:
  - trade date / scanned stocks / signal count / archived signals;
  - Agent submitted/failed;
  - paper-trading executed/planned/skipped;
  - runtime health status/score/factor coverage;
  - explicit `runtime_risk_blocked` and `runtime_block_reason` when the pipeline only archives watch signals and blocks buy actions.
- Task Scheduler history modal now includes an “执行结论” column:
  - shows “风险阻断买入” tag when runtime discipline blocked buy actions;
  - shows runtime health score, factor coverage, reason and compact execution counts.
- Feishu task report and Feishu bot webhook now surface runtime-risk blocked pipeline runs clearly:
  - concise conclusion: watch-only / no simulated buy;
  - reason from runtime health summary;
  - health score and factor real-source/coverage metrics.
- Added `scripts/deployment/deploy_release_package.js` as a one-command wrapper for the current release-package production layout:
  - build backend/frontend;
  - package without node_modules/env/runtime dirs;
  - upload tarball;
  - activate main + lym releases;
  - run `release_health_gate.js` with auto rollback.
  - default targets remain `main,lym`; xxz is not touched.

Validation:

```bash
node --check scripts/deployment/deploy_release_package.js
node --check scripts/deployment/release_health_gate.js
/Applications/Codex.app/Contents/Resources/node backend/node_modules/typescript/bin/tsc -p backend/tsconfig.json --pretty false
cd frontend && /Applications/Codex.app/Contents/Resources/node node_modules/typescript/bin/tsc --noEmit --pretty false
cd frontend && CI=false /Applications/Codex.app/Contents/Resources/node node_modules/react-scripts/bin/react-scripts.js build
```

Next:

1. Deploy and verify `result_summary` appears in production task logs after the next quant/manual dry run.
2. Add a read-only task-log smoke assertion for `result_summary` once at least one new-format log exists.
3. Continue real-data-source work: configure/validate Tushare Pro or another paid real factor source so `factor_real_provider_rate` rises above local-derived fallback.

## 2026-05-21 continuous iteration: runtime discipline dashboard

Focus: make “why no buy” visible from the quant cockpit, not only from task-log details.

Completed:

- `QuantPerformanceDashboardService` now aggregates recent quant pipeline execution summaries from `task_execution_logs.result_summary`.
- `/api/quant/performance-dashboard` now includes `runtime_discipline`:
  - 14-day quant run count;
  - runtime-risk blocked count and blocked rate;
  - latest blocked run;
  - top blocked reasons;
  - recent quant run summaries.
- Read-only smoke now asserts `runtime_discipline.summary` exists in the quant dashboard payload.
- Quant收益驾驶舱 adds a new “买入纪律与阻断原因” card:
  - no-buy block count;
  - block rate;
  - top reasons;
  - recent run ledger with pass/block tags;
  - keeps copy conclusion-first and light visual weight.

Validation:

```bash
/Applications/Codex.app/Contents/Resources/node backend/node_modules/typescript/bin/tsc -p backend/tsconfig.json --pretty false
cd frontend && /Applications/Codex.app/Contents/Resources/node node_modules/typescript/bin/tsc --noEmit --pretty false
cd frontend && CI=false /Applications/Codex.app/Contents/Resources/node node_modules/react-scripts/bin/react-scripts.js build
```

Next:

1. Deploy and run release health gate on main + lym.
2. After the next scheduled quant run, verify dashboard `runtime_discipline.recent_runs` contains the new run and displays block/pass correctly.
3. Add a small manual safe dry-run endpoint/button later if we want to create a non-trading discipline sample on demand.

## 2026-05-21 continuous iteration: effective factor coverage count fix

Focus: keep runtime buy discipline realistic by avoiding false low factor coverage after partial real-source refreshes.

Completed:

- Fixed `StockFactorService.getEffectiveFactorCoverageRows()` effective-window aggregation:
  - the previous SQL counted source groups instead of effective stocks after grouping by source;
  - coverage now uses `SUM(source_count)` so `coverage` matches the effective per-stock source breakdown.
- Added a read-only smoke regression check for `/api/quant/runtime-health`:
  - if `source_breakdown` has effective rows, `coverage` must not be lower than the source sum.
- This keeps Buy Gate from over-penalizing valid local-derived/eastmoney factor windows and makes dashboard coverage percentages align with the displayed provider breakdown.

Validation:

```bash
/Applications/Codex.app/Contents/Resources/node backend/node_modules/typescript/bin/tsc -p backend/tsconfig.json --pretty false
node --check scripts/tests/smoke_readonly_core.js
git diff --check
```

Next:

1. Deploy to main + lym and verify runtime factor coverage rises from the false ~1% value to the effective stock-window coverage.
2. Re-run lym opening preflight dry-run and confirm Buy Gate degradation is driven by real-provider/data freshness, not false coverage math.
3. Continue raising real-provider rate with broader EastMoney refresh or a paid Tushare source.

## 2026-05-21 continuous iteration: EastMoney batch real-factor coverage

Focus: make quant recommendations use more real market data instead of stopping at local-derived factor coverage.

Completed:

- Added EastMoney `ulist.np/get` batch quote snapshots in `EastMoneyClient`:
  - one request can return price, change pct, volume, turnover, PE/PB, market cap and main net-inflow proxy for many symbols;
  - single-stock `stock/get` remains as fallback when batch coverage is incomplete or the endpoint fails.
- Factor sync now passes batch options to EastMoney and keeps concurrency fallback.
- Added `skip_if_real_provider_rate_gte` / `factor_sync_skip_if_real_provider_rate_gte` controls:
  - scheduled quant scans no longer skip real-source refresh just because local-derived coverage is already high;
  - default skip requires both factor coverage >= 92% and real-provider rate >= 65%.
- Opening dry-run disables both skip gates so it always rehearses the live refresh path safely.
- Runtime health now marks high local-derived coverage with very low real-provider rate as a warning, not invisible green.
- Data status page manual factor sync now requests the same real-source-aware thresholds and explains EastMoney batch + Tushare + local-derived fallback.

Validation:

```bash
/Applications/Codex.app/Contents/Resources/node backend/node_modules/typescript/bin/tsc -p backend/tsconfig.json --pretty false
cd frontend && /Applications/Codex.app/Contents/Resources/node node_modules/typescript/bin/tsc --noEmit --pretty false
cd frontend && CI=false /Applications/Codex.app/Contents/Resources/node node_modules/react-scripts/bin/react-scripts.js build
```

Next:

1. Deploy main + lym and run opening preflight dry-run to confirm EastMoney batch snapshots increase `factor_real_provider_rate`.
2. If provider connectivity is unstable, keep fallback safe and consider adding a Tencent-derived valuation-light factor path for price/turnover realism.
3. Continue real paid-data evaluation, especially Tushare Pro/JQData, for true financial-quality factors.

## 2026-05-21 continuous iteration: EastMoney provider-smoke alignment

Focus: avoid false data-source diagnostics after the batch EastMoney factor path became the primary real-source refresh path.

Completed:

- Updated `StockFactorService.runProviderSmokeTest()` for `eastmoney` to try `getQuoteSnapshots([symbol])` first, so smoke tests exercise the same batch endpoint used by real factor sync.
- Kept single-symbol `stock/get` as fallback for compatibility.
- This removes the mismatch where manual factor sync succeeded through batch snapshots but provider-smoke still reported a failed single-stock endpoint.

Validation:

```bash
/Applications/Codex.app/Contents/Resources/node backend/node_modules/typescript/bin/tsc -p backend/tsconfig.json --pretty false
git diff --check
```

Next:

1. Deploy main + lym and verify `/api/market/factors/provider-smoke?provider=eastmoney` returns `ok=true`.
2. Run a 220-symbol real factor sync and confirm real-provider rate moves toward the 65% skip threshold.

## 2026-05-21 continuous iteration: EastMoney single-symbol batch smoke

Focus: finish the diagnostic cleanup after real-factor batch sync proved effective online.

Completed:

- `EastMoneyClient.getQuoteSnapshots()` now allows the batch `ulist.np/get` path for a single symbol as well as multi-symbol calls.
- This makes `/api/market/factors/provider-smoke?provider=eastmoney&symbol=...` use the same working endpoint as the production factor sync path before falling back to `stock/get`.

Online observation before this patch:

- 220-symbol manual factor sync succeeded in ~17s.
- Runtime factor coverage reached 100%; real-provider rate reached 100%; Buy Gate stayed `allow`.
- Provider-smoke still falsely returned `ok=false` because it was blocked from the single-symbol batch path.

Validation:

```bash
/Applications/Codex.app/Contents/Resources/node backend/node_modules/typescript/bin/tsc -p backend/tsconfig.json --pretty false
git diff --check
```

## 2026-05-21 continuous iteration: trading-session-aware quote freshness

Focus: remove false runtime-health warnings while keeping intraday buy discipline strict.

Completed:

- `RealtimeQuoteService.getPersistenceSummary()` now understands A-share sessions:
  - continuous trading: 09:30-11:30 and 13:00-15:00 on weekdays;
  - lunch break / after close / pre-open / non-weekday are non-continuous sessions.
- During continuous trading, quotes still must be within `REALTIME_QUOTE_FRESHNESS_MINUTES` to be `fresh`.
- During non-continuous sessions, a same-day snapshot with enough symbols is treated as `same_day_snapshot` and `is_fresh=true`.
- Runtime health should no longer stay `warn` at lunch/after close solely because the last quote is older than 30 minutes, while 09:35 open scans remain strict after refresh.

Validation:

```bash
/Applications/Codex.app/Contents/Resources/node backend/node_modules/typescript/bin/tsc -p backend/tsconfig.json --pretty false
git diff --check
```

Next:

1. Deploy main + lym and verify `/api/quant/runtime-health` becomes `ready` when all other checks are green.
2. Ensure `quote_persistence.freshness_status` clearly reports `same_day_snapshot` outside continuous trading.

## 2026-05-21 continuous iteration: quote freshness copy cleanup

Focus: make the now session-aware quote freshness status readable in the UI.

Completed:

- Quant performance dashboard now renders quote freshness as Chinese labels:
  - `fresh` -> 实时新鲜
  - `same_day_snapshot` -> 当日快照可用
  - `stale` -> 行情滞后
  - `missing` -> 未落盘
- Strategy research preflight tag uses the same label mapping.

Validation:

```bash
cd frontend && /Applications/Codex.app/Contents/Resources/node node_modules/typescript/bin/tsc --noEmit --pretty false
git diff --check
```
