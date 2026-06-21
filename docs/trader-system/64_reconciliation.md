# 64 — 对账（Reconciliation）

> 实盘 vs 模拟盘的持仓/cash/PnL 必须每日核对——差异长时间漂移无人发现是最危险的事情。BETA-2 已经把对账接入 cron + 主动告警，本节细化阈值合理性 + 验证路径。

---

## A. 操盘手心智

每个交易日的最后一步永远是**对账**。

我看 4 个数字：
1. **持仓行数**：模拟盘 30 行 vs 实盘 30 行（数量必须完全一致）
2. **每只数量**：每行 model.quantity vs broker.quantity（一致到股）
3. **cash 余额**：模拟盘 expected_cash vs 实盘 broker.available_cash（差异 < 0.1%）
4. **PnL**：模拟盘当日 PnL vs 实盘当日 PnL（差异 < 0.5%）

差异原因经常是：
- 手续费率分叉（回测 0.025%、实盘 0.03%）
- 滑点估算不准
- 撤单回报漏处理
- 配股/送股没同步

漂移如果两周不发现 → 数字越差越远，最后归零重设。

---

## B. 系统设计

### B.1 alignment_score 计算

`backend/src/live-trading/services/LiveTradingService.ts:374-572`

```ts
async getReconciliation(user_id, options) {
  const liveAccount = await loadLiveAccount(user_id)
  const livePositions = await fetchBrokerPositions(liveAccount)
  const paperPositions = await fetchPaperPositions(user_id)

  const positionMatches = matchPositions(livePositions, paperPositions)
  // each match: { symbol, status: 'aligned'|'live_only'|'paper_only'|'paper_underweight'|'live_underweight' }

  const alignedCount = positionMatches.filter(s.status === 'aligned').length
  const totalCount = positionMatches.length
  const alignment_score = (alignedCount / totalCount) * 100

  return {
    alignment_score,
    live_only_count, paper_only_count,
    matches: positionMatches, ...
  }
}
```

### B.2 cron + 主动告警（BETA-2 / audit S-12）

`backend/src/services/SchedulerService.ts:4432-4469` 注册 `LIVE_RECONCILIATION_GUARD`：

调度时点（建议）：
- 10:30 intraday
- 14:30 intraday
- 15:30 收盘对账
- 16:00 EOD（最终）

阈值（`ReconciliationAlertService.classifyReconciliation`）：

| 条件 | severity | sentinel |
|---|---|---|
| `snapshot_age > LIVE_RECONCILIATION_STALE_MINUTES` | HIGH | `SYSTEM:LIVE_RECONCILIATION_STALE` |
| `alignment_score < 70` 或 `live_only + paper_only > 3` | HIGH | `SYSTEM:LIVE_RECONCILIATION_HIGH` |
| `70 ≤ alignment_score < 85` 或 漂移 1-3 | MEDIUM | `SYSTEM:LIVE_RECONCILIATION_MEDIUM` |
| paper-only 用户（无 live 账户） | NONE skip | — |

### B.3 dedup（30 min）

`User.risk_config.reconciliation_alert_seen` LRU 存 signature；同 (symbols_hash, severity) 30 min 内不重发。

RealtimeAlertDispatcher 二级 dedup by `rule_id+symbol+level` 兜底。

### B.4 EOD 脚本（独立 path）

`scripts/ops/end_of_day_reconciliation.js`：
- CLI 工具，运维手动 / cron 调用
- 输出 markdown 报告 + 持久化到 `reconciliation_history` 表
- 供 dashboard 看历史对账曲线

### B.5 fail-OPEN per-user

`getReconciliation` 抛错 → 记 warning + 跳过该 user，不中断 batch（同 risk guard 模式）。

---

## C. 现状 review

### C.1 BETA-2 实现完整

- `backend/src/live-trading/services/ReconciliationAlertService.ts:1-397`（397 行）
- 阈值 classifier (line 90-130)
- dedup 30 min 用 `User.risk_config` JSONB
- fail-OPEN per-user

### C.2 cron 已注册

- `SchedulerService.ts:4432-4469`：`LIVE_RECONCILIATION_GUARD` task type
- 调度时点由 DB `scheduled_tasks` 表配（ops 可调假期）
- scenarios 字段含 `live_reconciliation_guard`

### C.3 ⚠️ paper account 数据尚未验证

- 当前仓内**没有真实 live broker 账户运行 30 天的对账数据**
- BETA-2 完成后还没人跑出"30 天 alignment_score 趋势报告"
- 阈值 70 / 85 是 audit 建议值，未基于真实数据 calibrate

### C.4 阈值合理性待 calibrate

- alignment_score 70 太宽：30 行持仓里 9 行漂移才触发？太晚
- 经验值：
  - 100%：完美（≥ 99% 偏差）
  - 95-99%：1-2 只小漂移（正常波动）
  - 90-95%：3-5 只漂移（要查）
  - < 90%：系统性问题
- 建议 MEDIUM = `< 95`，HIGH = `< 85`，stale 阈值看 cron 频率

### C.5 ⚠️ stale 阈值常量未配

- `stale_threshold_minutes` 在 ReconciliationAlertService 内 hardcode 或从 env 读？需查 `LIVE_RECONCILIATION_STALE_MINUTES`
- 30 min 比较合理（intraday cron 30 min 一次，未跑就是 stale）

### C.6 EOD 脚本不自动 cron

- `scripts/ops/end_of_day_reconciliation.js` 仅 CLI，audit S-12 提到"不在 cron 注册"
- BETA-2 解决了 ReconciliationAlertService 的 cron 接入；但**EOD report 持久化**部分仍需运维记得跑

### C.7 cash + PnL 维度的告警未实现

- ReconciliationAlertService 只看 alignment_score + 漂移行数
- cash 差异 / PnL 差异未单独告警 → 可能"持仓全对但 cash 差 5%"通过

---

## D. 改造方案

### D.1 user story

| ID | 故事 | 验收 |
|---|---|---|
| US-RC-1 | **paper account 30 天 calibrate 跑**：注册一个 paper-vs-live shadow 账户（用模拟 broker），连跑 30 天，每日记录 alignment_score；统计分位决定生产阈值 | 30 天报表 + 阈值建议（如 P10=92, P50=98） |
| US-RC-2 | **cash 差异独立告警**：`abs(paper_cash - live_cash) / total_value > 0.5%` → HIGH alert (rule_id='live_reconciliation_cash') | 单测：mock cash 差异 1% → 告警 |
| US-RC-3 | **PnL 差异独立告警**：`abs(paper_daily_pnl - live_daily_pnl) / total_value > 0.5%` → MEDIUM | 单测 |
| US-RC-4 | **EOD report 自动持久化**：cron `EOD_RECONCILIATION_REPORT` 17:00 跑，调 `end_of_day_reconciliation.js` 内部逻辑，写 `reconciliation_history` 表 + 飞书摘要 | 表行数每日 +1 + 飞书摘要 |
| US-RC-5 | **dashboard 对账曲线**：reconciliation_history 表喂前端，画"过去 30 天 alignment_score 折线 + 失败原因 top-3 饼图" | 前端页面上线 |
| US-RC-6 | **`stale_threshold_minutes` 环境化**：从 env / DB 配置读，默认 30 min；intraday cron 频率改时同步调 | env 改后下次 cron 用新值 |
| US-RC-7 | **多 live 账户对账**：当前假定一用户一 live 账户；改支持 N live 账户（用户在多券商开户），逐 account 评估 | 单测多账户 fan-out |

### D.2 与 KillSwitch 的协同

- alignment_score 长期 < 70 且不收敛（5 个 EOD 连续）→ 自动 trigger KillSwitch 'reconciliation_breach'（防止系统状态严重不一致继续下单）
- 详见 KillSwitch 55_kill_switch US-KS-2

### D.3 与 PaperTradingFacade 数据一致性

- 每次 facade.placeOrder BUY/SELL 成功 → 异步写 `reconciliation_intent` 表
- bridge event filled → join intent 表 → 标 reconciled=true
- 漂移检测：intent 表 reconciled=false 持续 > 1 hour → MEDIUM alert

---

## E. 验收口径

- BETA-2 cron 实际跑 7 天后报"过去 7 天 alignment_score 分布"
- 阈值基于真实数据 calibrate（不再用拍脑袋值）
- cash + PnL 独立告警生效
- EOD report 自动持久化 + dashboard 曲线
- 文件位置：
  - `backend/src/live-trading/services/{LiveTradingService,ReconciliationAlertService}.ts`
  - `backend/src/services/SchedulerService.ts`
  - `scripts/ops/end_of_day_reconciliation.js`
