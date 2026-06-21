# 50 — 风控总览 + 仓位上限（51 合并）

> 系统的命门。"不爆仓比赚钱更重要"——本节列 9 个 guard 的清单 + 三层闸门（pre-trade / post-trade / watchdog）+ fail-closed 原则 + RiskAlert → 飞书的告警链路 + 仓位上限的具体阈值。

---

## A. 操盘手心智

我对 risk 的信念：**靠纪律不靠运气；靠机器不靠人**。一年里有 5-10 个交易日会让人"愣 5 秒"——突发跳水、突然黑天鹅、突然爆量、突然涨停板冲下——那 5 秒就是亏 50% 的可能。所以：

1. **机械化所有止损 / 减仓 / 拒单**：没有"再扛一天"的空间。
2. **fail-closed**：任何风控不可用 → 拒单，不放行（DB 抖动也算）。
3. **三层 + 多 guard 互不依赖**：一个 guard 出 bug 不影响其余。
4. **告警必达**：每个 HIGH RiskAlert 自动飞书 + 30min dedup（防刷屏）。

---

## B. 系统设计

### B.1 三层闸门 + 9 个 guard

```
┌─────────────────────── pre-trade ──────────────────────┐
│ 1. TradeComplianceChecker (5 wizard) — pre-trade gate   │
│ 2. PositionLimitGuard      — 单股10/行业30/持仓数20     │
│ 3. DrawdownCircuitBreaker  — LEVEL_1 暂停新开仓         │
│ 4. 涨跌停拦截 (evaluateLimitUpDownBlock)                │
│ 5. T+1 拦截 (preTradeGuards.checkTPlus1)                │
│ 6. 行情陈旧度 (evaluateQuoteStaleness)                  │
│ 7. ExecutionFeasibilityService (流动性 / 盘口)          │
└─────────────────────────────────────────────────────────┘
                       ↓ 下单
┌─────────────────────── post-trade ─────────────────────┐
│ 8. PerStockStopLossGuard   — 单股止损 -7%               │
│ 9. TrailingStopGuard       — 追踪止损                   │
│ 10. DrawdownCircuitBreaker — LEVEL_2/3 减仓/清仓        │
│ 11. IndustryConcentrationGuard — 行业超 35% 告警        │
└─────────────────────────────────────────────────────────┘
                       ↓ EOD / watchdog
┌─────────────────────── watchdog ───────────────────────┐
│ 12. BlackSwanWatchdog      — ST / 停牌 / 新闻关键词     │
│ 13. RestrictedShareWatchdog— 解禁前 5 日预警            │
│ 14. MarketRegimeAlertService — 3日/20日跌幅+死叉        │
│ 15. KillSwitchService      — 5 触发条件 → 全停          │
└─────────────────────────────────────────────────────────┘
```

### B.2 fail-closed 原则

| Guard | DB 抖动行为 | 决策 |
|---|---|---|
| DrawdownCircuitBreaker | 抛 `RiskGuardUnavailableError` | **fail-CLOSED** 拒单 + RiskAlert HIGH |
| PositionLimitGuard | DB 失败 throw | fail-CLOSED 拒单 |
| 涨跌停拦截 | 纯函数无 DB | n/a |
| T+1 | DB 失败 throw | fail-CLOSED 拒单 |
| 行情陈旧度 | RealtimeQuote fail → daily_bar fallback | fail-open（有 fallback） |
| BlackSwanWatchdog | AKShare fail → `[]` continue | **fail-OPEN**（事后告警，不阻塞当下） |
| 其余 EOD watchdog | per-user try/catch | fail-OPEN（不阻塞批次） |

判据：**pre-trade 一律 fail-CLOSED；post-trade 评估类一律 fail-OPEN**。后者本质是"发现问题写 alert"，DB 挂了 alert 写不进也不该阻塞业务。

### B.3 RiskAlert → RealtimeAlertDispatcher 链路

```
guard.writeAlert(...)
  ↓
RiskAlert.create({level: 'HIGH', rule_id: '...', symbol: 'SYSTEM:XXX'})
  ↓ (model @AfterCreate hook)
realtimeAlertDispatcher.dispatch(...)
  ↓ (30 min dedup by rule_id+symbol+level)
飞书 / 邮件 / 微信 webhook
```

`rule_id` 命名表（已落实，见 portfolio/CLAUDE.md L786-797）：
| Guard | rule_id |
|---|---|
| PositionLimitGuard | `position_limit` |
| TrailingStopGuard | `trailing_stop` |
| DrawdownCircuitBreaker | `drawdown_breaker` |
| MarketRegimeAlertService | `market_regime_alert` |
| PerStockStopLossGuard | `per_stock_stop_loss` |
| IndustryConcentrationGuard | `industry_concentration` |
| BlackSwanWatchdog | `black_swan` |
| RestrictedShareWatchdog | `restricted_share` |
| 新增 | 见各文档 |

### B.4 仓位上限（原 51 合并）

#### 配置 schema

```jsonc
// User.risk_config.position_limits
{
  "max_positions": 20,             // 单账户最多 20 只
  "max_single_stock_pct": 0.10,    // 单股 10%（项目 wide 默认）
  "max_single_industry_pct": 0.30, // 单行业 30%
}
```

来源：`backend/src/portfolio/risk/PositionLimitGuard.ts:56-75` `DEFAULT_POSITION_LIMITS = Object.freeze({max_positions:20, max_single_stock_pct:0.10, max_single_industry_pct:0.30})`。

#### 阈值边界

- **仓位 cap 用严格 `>`**（恰好触线允许；不同于"防御硬触发用 `≤`"）
- 与 `PositionSizingPolicy.max_position_pct=12%` **不一致**——sizing 算法允许 12%、PositionLimitGuard 拦 10% → 实际上限 10%（取严）

#### 三条规则

1. **max_positions 20**：仅对新开仓拦（加仓允许）
2. **max_single_stock_pct 10%**：(existing + proposed) / total > 10% → 拒
3. **max_single_industry_pct 30%**：(industry + proposed) / total > 30% → 拒

#### 优先级链

`pickSingleViolation` 顺序：
1. max_positions（最容易理解）
2. max_single_stock_pct
3. max_single_industry_pct

短路：第一个失败就 throw，避免 cascade 让用户看多条 violation 困惑。

---

## C. 现状 review

### C.1 三层闸门已搭起来

- pre-trade：`PaperTradingFacade.placeOrder` 内 inline 调用顺序（line 762-1004）：
  1. line 766-780：涨跌停（audit S-3 修复 BETA 完成）
  2. line 782-839：DrawdownCircuitBreaker.checkBuyAllowed（BETA-7 fail-CLOSED）
  3. line 847-859：positionLimitGuard.checkBuyOrder
  4. line 861-862：cash 检查
  5. line 985-1004：T+1（SELL 路径）
- post-trade：guard cron 每日跑 EOD evaluation。
- watchdog：BlackSwan / Restricted / MarketRegime cron。

### C.2 ⚠️ TradeComplianceChecker pre-trade 由 BETA-1 添加但仅部分接入

- `backend/src/services/TradeComplianceChecker.ts:1-200` — BETA-1 新增 `checkPreTradeCompliance`。
- ⚠️ **caller 是否覆盖所有创建路径**待确认：grep `checkPreTradeCompliance` 是否在 `createBuyTrade` 与 `approveDraft` 双侧都调用。

### C.3 PositionLimitGuard 阈值硬编码

- `DEFAULT_POSITION_LIMITS` Object.freeze（line 71-75），per-user 可在 `User.risk_config.position_limits` JSONB 覆盖（line 401-408 `normalizePositionLimitsConfig`）。
- **UI 配置缺失**：SettingsWorkspace 没有"Position Limits" tab，用户不能在 UI 上调。

### C.4 sizing vs limit 阈值不一致

- `PositionSizingPolicy.DEFAULT_SIZING_POLICY.max_position_pct = 12`（基础是 sizing 上限）
- `PositionLimitGuard.DEFAULT_POSITION_LIMITS.max_single_stock_pct = 0.10`（10%）
- 取严后实际 10%，但 sizing log 会显示"算出 11.5%，未触 max_position_pct"，用户困惑。

### C.5 RealtimeAlertDispatcher hook 已生效（US-067）

- RiskAlert model `@AfterCreate` hook 调 dispatcher（CLAUDE.md L805-816）；
- HIGH 自动推飞书，MEDIUM/LOW 不推。
- dedup 30min by `rule_id+symbol+level`（CLAUDE.md L780-803）。

---

## D. 改造方案

### D.1 user story

| ID | 故事 | 验收 |
|---|---|---|
| US-RO-1 | **统一阈值常量**：抽 `backend/src/constants/portfolioLimits.ts` 导出 `MAX_SINGLE_STOCK_PCT=0.10` `MAX_INDUSTRY_PCT=0.30` `MAX_POSITIONS=20`；PositionLimitGuard / SizingPolicy / RebalanceEngine 都 import | grep 旧硬编码 0 命中 |
| US-RO-2 | **SettingsWorkspace Position Limits UI**：GET/PUT `/api/risk/position-limits`（已有），加前端 tab | 用户能调，调后下一笔 trade 即生效 |
| US-RO-3 | **TradeComplianceChecker pre-trade hook 全覆盖审计**：grep 确认 `createBuyTrade` + `approveDraft` + 任何"draft → broker"路径都调；缺一补一 | grep 覆盖 100% |
| US-RO-4 | **风控总览 dashboard**：新页面展示 9 个 guard 状态（last_eval_at / triggered_count_today / latest_alert）+ kill switch 状态 | 页面能看到 9 个 guard 全绿 |
| US-RO-5 | **fail-CLOSED 普及**：PerStockStopLossGuard / TrailingStopGuard / IndustryConcentrationGuard 的 pre-trade hook 也按 BETA-7 改 fail-CLOSED（只 inline pre-trade 调用，EOD evaluation 保持 fail-OPEN） | DB 抖动场景下单被拒 |
| US-RO-6 | **alert dedup 配置化**：30min 改 per-rule 可调（黑天鹅 rule 缩到 5min、对账 rule 60min） | dispatcher 表新 column |

### D.2 三层闸门图（更新）

新设计后的 pre-trade 顺序（fail-CLOSED 全员）：
```
0. checkPreTradeCompliance (5 wizard 硬规则)  [BETA-1 + US-RO-3]
1. 涨跌停拦截 (evaluateLimitUpDownBlock)
2. T+1 拦截 (preTradeGuards.checkTPlus1, SELL 路径)
3. 行情陈旧度 (evaluateQuoteStaleness)
4. DrawdownCircuitBreaker.checkBuyAllowed (fail-CLOSED)
5. PositionLimitGuard.checkBuyOrder (fail-CLOSED)
6. PerStockStopLossGuard pre-buy hook (新, fail-CLOSED)
7. ExecutionFeasibilityService (fillable_score)
8. ExecutionPolicyRouter (policy decision)
9. cash 检查
10. broker.submit
```

---

## E. 验收口径

- 9 个 guard 都有自动化测试 + cron 每日跑
- HIGH RiskAlert 30 min 内必达飞书（dedup 后）
- DB 抖动场景：pre-trade 全 fail-CLOSED；EOD 全 fail-OPEN
- 阈值常量统一文件
- SettingsWorkspace 至少 8 个 guard 有 UI 配置 tab
- 文件位置：`backend/src/portfolio/risk/*.ts` + `backend/src/constants/portfolioLimits.ts`（新建）
