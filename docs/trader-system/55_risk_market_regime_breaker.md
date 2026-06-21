# 55 — 市场环境 + 黑天鹅 + 限售解禁 + Kill Switch（合并）

> 本节合并原 55 / 56 / 57 / 58 四份风控为一份："**外部冲击**"——市场系统性下跌、个股突发利空、解禁砸盘、broker 异常 → 任一触发 → 暂停 / 清仓 / 熔断。

---

## A. 操盘手心智

这四类是"**不可预测但必有**"的外部冲击：

1. **市场暴跌**：3 日跌 5% / 20 日跌 15% / MA20 死叉 MA60 → 暂停建仓（不抄底）
2. **个股黑天鹅**：ST / 停牌 / "立案"新闻 → 立即清仓（持仓 + 候选池里都清）
3. **限售解禁**：未来 5 日解禁市值 > 流通 10% → 仓位降一半（提前 5 日预防）
4. **broker 异常**：心跳丢 5min / 失败连 3 / 日浮亏超阈 / 单日成交 1.5× / 账户 connection_status=error → 全停 + abort pending command + 飞书告警

四个 guard 独立但共享同一套架构（DataSource 注入 + 纯函数 helper + RiskAlert + sentinel symbol + fail-OPEN）。

---

## B. 系统设计

### B.1 MarketRegimeAlertService（市场环境）

#### 信号

| Signal | 触发 | level |
|---|---|---|
| `drop_3d` | 沪深 300 近 3 日累计跌 ≥ 5% | HIGH |
| `drop_20d` | 沪深 300 近 20 日累计跌 ≥ 15% | HIGH |
| `death_cross` | MA20 < MA60 且昨日 MA20 ≥ MA60 | HIGH |

并行触发（可同时 3 个），sentinel `SYSTEM:MARKET_REGIME_<TYPE>`。

#### 联动动作

- DrawdownCircuitBreaker pause × 3 倍（详见 53）
- PortfolioConstructionService 切换 regime=bear（详见 40）
- PaperTradingFacade.placeOrder BUY 加 pre-trade hook：regime=bear 且非加仓 → 写 LOW alert（不阻断，提醒）

### B.2 BlackSwanWatchdog（个股黑天鹅）

#### 事件源

| Type | AKShare endpoint | 持久化 |
|---|---|---|
| `ST` | `stock_zh_a_st_em` | 当日 ST 列表，与持仓 inner-join |
| `SUSPENDED` | `stock_zh_a_stop_em` | 停牌列表 |
| `NEWS_KEYWORD` | `stock_news_em(symbol)` | 24h 内含关键词（立案/退市/重大违规/处罚/问询函）的新闻 |

#### dedup

- LRU 200 entries 存 `User.risk_config.black_swan_seen`
- ST/停牌 signature 长效（事件持续期内只告警 1 次）
- NEWS_KEYWORD signature 含 title hash（不同新闻分别告警）

#### 触发动作

- 写 RiskAlert HIGH (rule_id='black_swan', symbol=stock.symbol)
- **不直接卖**（事件性预警，由 caller / 人工决定是否立即清仓）
- 若同期组合 drawdown ≥ LEVEL_2 → DrawdownCircuitBreaker 兜底卖（包含黑天鹅股）

### B.3 RestrictedShareWatchdog（限售解禁）

#### 输入

- 限售解禁日历 `RestrictedShareRelease`（AKShare `stock_restricted_release_detail_em(start, end)`）
- 当前流通市值（Stock.circulating_market_cap）

#### 触发

```
release_ratio = release_market_value / stock.circulating_market_cap
if release_ratio ≥ 10% AND ex_date ∈ [today, today + 5 trading days]:
    写 RiskAlert MEDIUM
```

#### Signature

`RESTRICTED::<symbol>::<window_end>` — 窗口推进时自然失效（与 ST 反向，proactive 预警必须随窗口失效，否则用户在长仓位上只能收一次警告）

#### 联动动作

- 写 alert + 显式提示用户"建议提前 5 日仓位降半"
- 不直接卖（用户决策权）

### B.4 KillSwitchService（broker 异常 / 总熔断）

#### 5 触发条件

| Trigger | 阈值 | 来源 |
|---|---|---|
| `heartbeat_lost` | bridge 心跳 ≥ 5 min 无更新 | `live_bridge_health.last_heartbeat_at` |
| `failure_streak` | broker 连续 failed 命令 ≥ 3 | LiveBrokerCommand 滚动窗口 |
| `daily_loss_breach` | 实盘账户当日浮亏 > daily_loss_limit | LiveBrokerAccount.daily_pnl |
| `volume_spike` | 当日成交量 > 历史均值 1.5× | LiveBrokerCommand 当日 filled qty agg |
| `account_anomaly` | LiveBrokerAccount.connection_status='error' | account sync 失败 |

#### 动作

1. 写 `live_kill_switch_states.active=true`（partial unique 兜底并发）
2. emit event `kill_switch_triggered`
3. 调 `abortPendingCommands(reason_code, reason_detail)`：
   - 所有 status='pending' → status='aborted'（aborted 终态，不再 TTL 巡检，详见 63）
   - status IN ('dispatching','dispatched') → 写 audit `KILL_SWITCH_MARK_INFLIGHT`（不强改 status 避免 bridge ack 冲突）
4. bridge long-poll 立刻 204 / 断 SSE
5. 飞书告警

#### 解除

- **必须人工 admin resolve**（不自动恢复）
- aborted 命令**不会自动复活**——用户手动 resubmit（强制 review）

---

## C. 现状 review

### C.1 MarketRegimeAlertService 已就绪

- `backend/src/portfolio/risk/MarketRegimeAlertService.ts:1-100, 792 行`
- DEFAULT (line 99-103)：`drop_3d_pct=0.05, drop_20d_pct=0.15`
- 并行多 signal（同 US-050 设计）
- 严格 `<` MA death-cross（昨日 ≥ 今日 < 才算穿越）

### C.2 BlackSwanWatchdog 已就绪

- `backend/src/portfolio/risk/BlackSwanWatchdog.ts:1-100, 1044 行`
- DEFAULT (line 141-147)：`news_keywords=['立案','退市','重大违规','处罚','问询函'], news_lookback_hours=24`
- Hotfix 5 (commit 7c33aa4)：keywords 扩展 + fallback 兜底

### C.3 RestrictedShareWatchdog 已就绪

- `backend/src/portfolio/risk/RestrictedShareWatchdog.ts:1-100, 965 行`
- DEFAULT (line 120-122)：`release_threshold=0.10, lookforward_trading_days=5`
- ⚠️ **无 HTTP / config endpoint**（CLAUDE.md L763 已记录）
- ⚠️ **无 SchedulerService cron 注册**（CLAUDE.md L770-774 已记录）—— 当前生产环境**不会自动跑**，需运维注册

### C.4 KillSwitchService 已就绪

- `backend/src/live-trading/services/KillSwitchService.ts:1-541`
- 5 trigger 实现：line 483-498（account_anomaly）+ 其它分散
- `abortPendingCommands` 实现：line 213-278
- aborted 终态已 codified（model L72-77 + state_machine.md L82-89 BETA-9 audit M-6）

### C.5 ⚠️ DrawdownCircuitBreaker 与 MarketRegime 联动未做

- 当前 BlackSwan / Drawdown / MarketRegime 三个 guard 独立运行；
- 没有"regime=bear 时延长 drawdown pause"的联动逻辑（详见 53 US-DD-3）。

### C.6 ⚠️ 黑天鹅触发不直接卖

- BlackSwanWatchdog 只写 alert，不调 GuardSellExecutor；
- 操盘手心智里"个股 ST → 立即清仓"在系统层面**没有自动执行**；
- 依赖用户/ops 在飞书看到 alert 后手动操作 → 反应慢。

### C.7 限售解禁 cron 未注册（生产空跑）

- 仅 evaluator 实现，cron 不在 SchedulerService 注册；
- 即使有用户 PUT 配置，每天**不会自动跑**。

---

## D. 改造方案

### D.1 user story

| ID | 故事 | 验收 |
|---|---|---|
| US-MR-1 | **regime 状态导出 API**：`MarketRegimeAlertService.getRegimeStatus()` 暴露 `regime: 'bull'|'bear'|'range'` 给 PortfolioConstructionService 等下游消费 | 一个 GET endpoint 返回 regime label |
| US-BS-1 | **黑天鹅自动清仓**：BlackSwanWatchdog 触发 ST/SUSPENDED 时自动调 GuardSellExecutor 清该 stock（NEWS_KEYWORD 仅写 alert 不自动卖，避免单条新闻误判） | 单测：mock ST 命中持仓 → SELL 单生成 |
| US-BS-2 | **NEWS_KEYWORD 双重验证**：单条新闻命中关键词 → 写 LOW alert；2 条新闻或 24h 内 3+ 媒体源转载 → 升 HIGH + 触发清仓 | 测：1 条只写 alert；3 条 trigger 清仓 |
| US-RS-1 | **限售 cron 注册**：在 SchedulerService 注册 `RESTRICTED_SHARE_WATCHDOG` daily 08:30 跑 `restrictedShareWatchdog.evaluateAfterOpen()` | cron 启动；DB 任务表新行 |
| US-RS-2 | **限售自动减半**：MEDIUM alert 触发 + 用户 risk_config.restricted_share.auto_trim=true → 调 RebalanceEngine 自动卖该 stock 50% | 配置开启后单测验证卖 50% |
| US-RS-3 | **限售 HTTP endpoint**：GET/PUT `/api/risk/restricted-share` + SettingsWorkspace tab | 用户能 PUT 调阈值 |
| US-KS-1 | **kill switch 1-click 解除审计**：admin resolve 必须填 (reason, ack_postmortem_id)；aborted 命令显示 list 让用户决定哪些 resubmit | UI 流程通 |
| US-KS-2 | **daily_loss_limit 自动 trigger 测试**：每日 14:00 + 14:55 各跑一次 evaluator；mock 浮亏超阈直接 trigger | cron 跑通；模拟超阈 trigger=true |
| US-MR-2 | **regime=bear 联动**：DrawdownCircuitBreaker pause 时 if regime=bear → pause × 3；MarketRegimeAlertService 触发时 if drawdown ≥ 7% → pause 时长按 drawdown 等比例延长 | 单测两联动 |

### D.2 与 50_overview 三层闸门的位置

- **MarketRegime**：watchdog 层（不阻断单笔 BUY，但写 alert + 联动其它 guard）
- **BlackSwan**：watchdog 层（事件性 alert + 改造后自动卖）
- **RestrictedShare**：watchdog 层（proactive 预警）
- **KillSwitch**：watchdog 层 + 全系统熔断（中断所有 broker 命令）

### D.3 操盘手补充：缺失的 "市场闷盘" 检测

操盘手还会看一个信号：**连续 N 日全 A 涨停个股数 < 30** = 市场进入"无人接盘"段，应该减仓。当前 MarketRegimeAlertService 只看指数，没看涨停数。补一个：

- 新 signal `low_breadth` = 近 5 日均涨停股数 < 30
- 触发：写 MEDIUM alert + 建议组合现金比例 ≥ 30%

---

## E. 验收口径

- MarketRegimeAlertService 3 signal + regime export + bull/bear/range 联动
- BlackSwanWatchdog ST/停牌自动清；NEWS_KEYWORD 双重验证
- RestrictedShare cron 注册 + 自动减半 toggle + UI
- KillSwitch 5 trigger 全单测 + admin 解除强 ack + aborted 命令 resubmit UI
- 跑 60 天 paper：在大撤段（构造 mock 沪深 300 -7%）三联动正确触发
- 文件位置：`backend/src/portfolio/risk/{MarketRegimeAlertService,BlackSwanWatchdog,RestrictedShareWatchdog}.ts` + `backend/src/live-trading/services/KillSwitchService.ts`
