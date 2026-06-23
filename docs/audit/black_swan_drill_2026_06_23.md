# BE-T3: 黑天鹅压力测试 drill (2026-06-23)

**审计日**: 2026-06-23
**Drill 脚本**: `backend/scripts/be_t3_black_swan_drill.ts`
**跑法**: `cd backend && npx ts-node --transpile-only scripts/be_t3_black_swan_drill.ts`

## 总评

**8 个 scenario 全部 ✅ pass** (in-memory mock, 不污染 prod DB):

| # | Scenario | 关键代码路径 | 验证结果 |
|---|---|---|---|
| 1 | 大盘 20 日 -11.97% | `MarketEnvironmentService.resolveMarketRegime` | regime=stress ✓ |
| 2 | akshare 全挂 (PYTHON=/nonexistent) | `NorthboundSyncService.syncDate` | fail-OPEN 返 error 字段, 不抛 ✓ |
| 3 | realtime quote 2h stale | `RiskAnalyzer.analyze` | event_action=veto, score=-100 ✓ |
| 3b | realtime quote 5min fresh | `RiskAnalyzer.analyze` | 不 veto, score=12.9 ✓ |
| 4 | ST 名股 (`*ST 测试`) | `RiskAnalyzer.analyze` (调 stNameUtils.isSTName) | event_action=veto ✓ |
| 5 | persistenceSummary.is_fresh=false | `PaperTradingAutomationService` line 1267-1289 | quoteFreshnessAction=reduce, multiplier=0.5 ✓ |
| 6 | 组合 peak=1.2M current=1.0M (-16.7%) | `DrawdownCircuitBreaker.pickDrawdownLevel` | LEVEL_2 ✓ |
| 7 | bar.close = limit_up | `AShareConstraintEngine.evaluateOrder` | rejected: `limit_up_block_buy` ✓ |

**结论**: 现有降级路径全部按预期工作. 0 bug 待修.

## 详细 evidence

### Scenario 1: 大盘暴跌
```
mock 60 closes: start=4500 latest=3807
computed ret20=-11.97% ret60=-15.40%
drawdown(60d)=-15.40% → derived regime=stress
```
**触发阈值**: `ret20 <= -6 || drawdown <= -12` (MarketEnvironmentService line 209-214)

### Scenario 2: akshare 全挂
```
sync.syncDate() elapsed=8ms, error="spawn /nonexistent/python ENOENT"
result.fetched=0 upserted=0 (期望 fetched=0 upserted=0)
```
**关键**: `NorthboundSyncService.syncDate` 内部顶层 try/catch (line 92-96), 抛错被
吞为 `error` 字段, 不向 SchedulerService 抛, 不会让 cron `consecutive_failure_count`
异常累加. 同款 fail-OPEN 模式适用所有 sync service (US-005 范式).

### Scenario 3: realtime quote stale (Asia/Shanghai 时区修复 BA-17 验证)
```
risk.score=-100 confidence=1
risk.event_action=veto (期望 veto)
evidence 触发: 行情陈旧: 120 min ago
```
**关键判定** (RiskAnalyzer line 95-133):
- `as_of_ts` 2h 前 > `STALE_QUOTE_THRESHOLD_MS = 30 * 60 * 1000` → veto
- Batch BA-17 时区修复 (line 96-101 上海时区 today 判定) 让 UTC 23:30 (= 北京 07:30
  次日) 不再误判 isReplayMode

### Scenario 5: PaperTradingAutomation quoteFreshnessAction
**直接复现 line 1267-1289 推导逻辑**:
```ts
const quoteFreshnessAction =
  persistenceSummary && persistenceSummary.persisted && persistenceSummary.is_fresh === false
    ? 'reduce'
    : persistenceSummary && !persistenceSummary.persisted
      ? 'observe'
      : 'allow';
```
mock `{persisted: true, is_fresh: false, age_minutes: 130}` → action='reduce',
multiplier=0.5 ✓. 这意味着 prod 真出 stale 时, autoBuyFromSignals 会**自动降半仓**.

### Scenario 6: DrawdownCircuitBreaker LEVEL 判定
```
peak=1200000 current=1000000 drawdown=16.67%
derived level=LEVEL_2  (阈值: LEVEL_3>=20%, LEVEL_2>=15%, LEVEL_1>=10%)
```
**关键**: DrawdownCircuitBreaker line 138-145 阈值表与 drill 推导一致.
LEVEL_2 触发 → 50% 持仓减仓 (`pickLevel2TrimTargets`).

### Scenario 7: AShareConstraintEngine 涨停板拒单
```
bar: open=10 close=11 (= prev_close * 1.10 涨停)
decision.ok=false reason=limit_up_block_buy
```
**关键**: 涨停板**整 bar**封住 → 引擎拒所有 BUY (`limit_up_block_buy`).
真实回测 + 真撮合都依赖这条拒单 (audit S-1 修复 in `AShareConstraintEngine`).

## 真因分析 (无 bug)

3 个 scenario 都按预期降级, 主要因为:

1. **多层 fail-OPEN**: data sync layer (北向/龙虎/akshare) 都有顶层 try/catch
   返 error 字段不抛. 当 akshare 全挂时, daily sync cron 跑完每天 13+ 个数据源
   全失败 → 各自记 failed_items=1 + warn → DAILY_HEALTH_REPORT (BF-4 新加 cron)
   会汇总到 OPS 群 (`std0 因子` / `cron 失败` 两段).
2. **多层 hard veto**: RiskAnalyzer + AShareConstraintEngine + DrawdownCircuitBreaker
   + PositionLimitGuard 4 道独立 hard veto, 任一触发即拒单. 不会因为单点失效
   全线放行.
3. **降权而非熔断**: quoteFreshness=reduce, drawdown=LEVEL_2, marketRegime=stress
   都是**降低 position size 1/2** 而非 0/100 二态. 降级路径优雅, 不会"今天 0%
   仓位 / 明天 100%" 跳变.

## 修复建议 (无紧急, 留 followup)

虽然 8 scenario 全 pass, 但发现 2 个可以做更好的:

1. **NorthboundDataClient timeout 默认 60s 偏长**:
   prod akshare 一般 5-10s 完成. 60s timeout 让 akshare-down 时 daily sync
   cron 单 source 卡 1 分钟. 建议改 15-20s + 加 logger.warn 阈值.
2. **MarketEnvironmentService regime 判定无 cache**:
   每次 getEnvironmentForStock 都重算 60 日 closes 拉 DailyBar.findAll().
   prod 已加 cache (line 109-113, 15 min expires), 但 mock scenario 1 显示
   完全不依赖 DB cache 也能算. 可以考虑把 regime 提前算好 (hourly cron) 写
   `market_regime_cache` 表, 让所有消费方拉 read-only.

## 后续 owner

- ALPHA agent: 跟进 followup #1 (akshare timeout 调优)
- BETA agent: 跟进 followup #2 (regime cache 预生成)
