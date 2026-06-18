# 53 — 组合熔断（Drawdown Circuit Breaker）

> 单股止损管不住"系统性沉没"——10 只票各跌 7% 就是组合 -7%。组合级回撤熔断是**最后一道兜底**：到 LEVEL_2/3 强制减仓 / 清仓 + 24h 冷却 + 复盘报告自动生成。

---

## A. 操盘手心智

我看过太多人在大撤里"按兵不动等反弹"——结果反弹没等到，撤回越来越大。所以系统必须**机械、分级、不可绕**：

1. **LEVEL_1 = 暂停新开仓 24h**：刚撤 10%，不应该再加杠杆 / 加新仓。允许减仓 + 加仓（已持仓的补到目标）。
2. **LEVEL_2 = 减仓 50%**：撤 15%，已经在加速亏，强制卖掉**涨幅最大的 50%**——这些是利润盘，留 cash 减少敞口、保留底仓继续追踪。
3. **LEVEL_3 = 清仓**：撤 20%，认输出场。重新评估策略、市场环境、自身判断。

冷却期：触发后 24h 内不允许 BUY 新仓（甚至 reset 后人工 review 才能开）。
复盘：每次 LEVEL_2/3 触发自动生成"为什么撤这么深"报告（哪些 stock 贡献最大、哪个 regime、哪些策略爆雷）。

---

## B. 系统设计

### B.1 阈值 + 动作

| Level | drawdown ≥ | 动作 | 24h pause |
|---|---|---|---|
| LEVEL_1 | 10% | 暂停新开仓（加仓允许） | 是 |
| LEVEL_2 | 15% | 卖出涨幅最大的 50% 标的（ceil(N/2)） | 是 |
| LEVEL_3 | 20% | 清仓全部 | 是（解除需人工 review） |

### B.2 数据流

```
EOD 16:00 cron (PAPER_TRADING_DRAWDOWN_BREAKER_CHECK)
  ↓
DrawdownCircuitBreaker.evaluateAfterClose(user_id?)
  ↓
peak_value = max(PaperTradingSnapshot.total_value[365d], current.total_value)
drawdown_pct = (peak - current) / peak
  ↓
pickDrawdownLevel(drawdown, config) → null | LEVEL_1 | LEVEL_2 | LEVEL_3 (短路链)
  ↓ 命中 LEVEL_X
LEVEL_1: User.risk_config.drawdown_breaker.paused_until = now + 24h
LEVEL_2: trigger top-50% by gain_ratio
LEVEL_3: trigger all
  ↓
RiskAlert HIGH (rule_id='drawdown_breaker', symbol='SYSTEM:DRAWDOWN_LEVEL_X')
  ↓
GuardSellExecutor.executeTriggers(...)  → facade.placeOrder SELL
  ↓
RealtimeAlertDispatcher → 飞书 "⚠️ 组合 drawdown -16%，触发 LEVEL_2 减仓"
```

### B.3 pre-trade hook

```ts
// placeOrder BUY 路径 line 793
breakerResult = await drawdownCircuitBreaker.checkBuyAllowed({user_id, symbol})
// 仅阻断"开新仓"（symbol 不在持仓内）；加仓允许
```

特殊：SELL 永远放行（即使在 LEVEL_3 期间）——平仓是降敞口动作。

### B.4 fail-CLOSED (BETA-7 修复)

```ts
// PaperTradingFacade.ts:797-832
try {
  breakerResult = await drawdownCircuitBreaker.checkBuyAllowed(...)
} catch (RiskGuardUnavailableError) {
  // 写 RiskAlert HIGH + 拒单
}
```

历史教训：DB 抖动时若 fail-OPEN，大撤回保护悄悄失效。BETA-7 改 fail-CLOSED 后 DB 抖动场景拒单 + 立即告警。

### B.5 LEVEL_2 卖谁

`sortGainDescStable`：
```
sort by gain_ratio DESC, symbol ASC
take top ceil(N/2)
```

涨幅最大的先卖——锁利润 + 减敞口 + 保留底仓（亏损的留着等反弹）。N=3 卖 2，N=1 卖 1，N=0 noop。

### B.6 24h pause + 解除

- `paused_until` ISO timestamp 写 `User.risk_config.drawdown_breaker.paused_until`
- `clearPause(user_id)` admin endpoint 早期解除
- LEVEL_3 解除需**人工 review** + audit log

---

## C. 现状 review

### C.1 主体已实现

- `backend/src/portfolio/risk/DrawdownCircuitBreaker.ts:1-100`（941 行）
- DEFAULT thresholds (line 116-122)：LEVEL_1=10%, LEVEL_2=15%, LEVEL_3=20%, pause=24h
- `evaluateAfterClose` + `checkBuyAllowed` + `clearPause` 三个 API
- LEVEL cascade 用 `pickDrawdownLevel` 短路链（LEVEL_3 > LEVEL_2 > LEVEL_1，only one wins）

### C.2 fail-CLOSED 已生效 (BETA-7)

- `PaperTradingFacade.ts:782-839` —— 完整实现 try/catch 抛 `RiskGuardUnavailableError` → 写 RiskAlert HIGH + 拒单。
- DB 抖动场景 statusCode=503 + code='RISK_GUARD_UNAVAILABLE'。

### C.3 GuardSellExecutor 接 LEVEL_2/3

- `backend/src/portfolio/risk/GuardSellExecutor.ts:30` —— 支持 trigger_kind = `drawdown_level_2` / `drawdown_level_3`。
- bypass_t_plus_1=true + bypass_trading_hours=true。

### C.4 ⚠️ 复盘报告未生成

- LEVEL_2/3 触发后**没有自动生成"原因分析"报告**。
- 当前仅 RiskAlert metadata 含 `triggered_positions` 列表，但无完整复盘（regime / 策略归因 / 行业归因）。

### C.5 ⚠️ LEVEL_3 解除流程缺人工 review

- `clearPause` 是 admin endpoint，但没有"必须填理由 + 上传报告"的强约束。
- 现状 LEVEL_3 24h 后可以一句话 admin 清除 → 容易出操作事故。

### C.6 peak_value 计算包含当前实时值

- 防"今天涨破历史峰但 snapshot 还没生成"导致 drawdown 暂时低估。
- `computePeakValue(snapshots, current_total_value) = max(...)`（CLAUDE.md L196-202 已 codify）

---

## D. 改造方案

### D.1 user story

| ID | 故事 | 验收 |
|---|---|---|
| US-DD-1 | **复盘报告自动生成**：LEVEL_2/3 触发后 1 小时内调 `DrawdownPostmortemService.generate(user_id, level, evaluated_at)`，输出 markdown 写 `drawdown_postmortems` 表 + 飞书推送；含 (a) 撤回拆分到 stock/strategy/industry; (b) 期间最高/最低; (c) 触发当日市场环境快照 | 复盘报告里能看到 top-3 失血 stock 名单 |
| US-DD-2 | **LEVEL_3 解除人工 review**：admin clearPause 必须填 (reason, ack_postmortem_id)；7 日内同账户 LEVEL_3 二次触发 → 强制人工签字 | 测：admin 不填 ack 直接 throw 400 |
| US-DD-3 | **regime 联动**：若触发同时 MarketRegimeAlertService 已经在 `bear`，自动延长 pause 到 72h（市场系统性下跌时不宜抄底） | 单测：mock regime=bear → pause_ms × 3 |
| US-DD-4 | **早期预警 LEVEL_0**：drawdown ≥ 7%（接近 LEVEL_1）发 MEDIUM RiskAlert "组合 drawdown 接近熔断"，不阻断；让用户提前减仓 | RiskAlert 出现且不阻塞 |
| US-DD-5 | **per-portfolio 分级**：当前 evaluate 是"per-user" 聚合 → 一只爆雷股拖累所有 portfolio；改 per-portfolio 独立 evaluate + 独立 pause（防止误伤其它策略） | snapshot 表加 portfolio_id 维度 |
| US-DD-6 | **LEVEL_2 卖谁优化**：当前 sort by gain DESC 卖涨幅最大；改为综合考虑 (gain DESC × 0.6 + spread ASC × 0.2 + liquidity DESC × 0.2)，避免卖到流动性差的票放大成本 | 单测：构造案例，排序 = composite score |

### D.2 与 52 (stop_loss) 关系

- PerStockStopLoss 看**单股**对**入场成本** → 每股独立触发
- TrailingStop 看**单股**对**期间最高** → 每股独立触发
- DrawdownCircuitBreaker 看**组合**对**历史峰值** → 整组合统一动作
- 三者复合不冲突：单股触发先于组合（更细粒度）；组合触发后即使个股没到止损线也会被强卖（兜底）

### D.3 与黑天鹅 / market_regime 的协同（见 55）

- 黑天鹅 watchdog (53/55) 命中某只持仓 → BlackSwanWatchdog 写 RiskAlert HIGH + 不直接卖；
- 若同期组合 drawdown ≥ LEVEL_2 → DrawdownCircuitBreaker 走 LEVEL_2 真卖（包含该黑天鹅股）；
- 协同：黑天鹅 = 单股事件性预警，drawdown = 组合系统性兜底。

---

## E. 验收口径

- 单测三 LEVEL 短路链 + 边界 (== 10%/== 15%/== 20%) + LEVEL_3 卖全 + LEVEL_2 卖 ceil(N/2)
- fail-CLOSED 场景：DB outage 时 BUY 被拒 + RiskAlert HIGH
- LEVEL_2/3 触发 1 小时内自动复盘报告
- LEVEL_3 解除强制 ack
- regime=bear 时 pause × 3
- 跑 60 天 paper：组合最大 drawdown ≤ -12%（LEVEL_2 兜底）
- 文件位置：`backend/src/portfolio/risk/DrawdownCircuitBreaker.ts`（已存在）+ 新 `DrawdownPostmortemService`
