# 43 — 执行算法（TWAP / VWAP / Iceberg / POV / WAIT）

> 同一个 BUY 信号：小单立即贴价、中单 TWAP/VWAP、大单 POV、跳空时 WAIT、临近涨停 SKIP。"很多量化系统不死在选股，死在执行。"

---

## A. 操盘手心智

**执行 = 在"成交确定性"与"成本"之间找平衡**。同一个 100 万的 BUY 信号：

- 小盘票（日成交 5000 万）一次拍 1% = 强冲击，自己 push 涨 2-3% → 实际拿到的价比信号价高 1.5%。
- 大盘票（日成交 50 亿）随便拍 → 冲击近 0。
- 跳空高开 5% → 等 15 分钟，多半下来 1-2%。
- 涨停板 1% 内 → 不追，等次日。
- 高波动日（intraday vol 5%）→ 别拍当日 close，分批 30 分钟拍。

工程化抽象：**routeExecutionPolicy(input) → policy + slice_count + participation_rate + wait_minutes**。

---

## B. 系统设计

### B.1 策略矩阵

| Policy | 触发条件 | 拆单方式 | 滑点容忍 |
|---|---|---|---|
| `SKIP` | vol ≥ 5% / 距涨停 ≤ 2% / 中大单+spread ≥ 0.5% | — | — |
| `WAIT_5M/15M/30M` | 开盘跳空 + 非紧急 | 等待 | — |
| `LIMIT_AT_TOUCH` | size < 0.5% 当日 turnover | 单笔限价单贴买/卖一档 | 0.2% |
| `TWAP` | 0.5% ≤ size < 2% | 5 切片均匀间隔 | 0.3% |
| `VWAP` | 2% ≤ size < 5% | 8 切片按当日成交量分布 | 0.5% |
| `POV` | size ≥ 5% | 参与率上限 10%，按盘口动态调 | 0.8% |
| `Iceberg` | （未实现）大单隐藏挂单 | 显示 5% 数量、剩余 hidden | 0.5% |

### B.2 集合竞价 vs 连续竞价

- **09:25 集合竞价**：A 股 9:15-9:25 撮合，9:25 出价。模拟盘 / 实盘**不允许**在该时段下连续单（`PaperTradingFacade.placeOrder` 09:30 前直接 reject `NON_TRADING_HOURS_OFF_HOURS`）。
- **盘中 09:30-11:30 / 13:00-15:00**：连续竞价。
- **14:57-15:00 收盘集合竞价**：A 股仅深交所有；POV/VWAP 切片避开此窗口（已被 15:00 收盘 reject 兜底）。

### B.3 主入口

```ts
// 位于 backend/src/services/execution/ExecutionPolicyRouter.ts
routeExecutionPolicy(input: ExecutionPolicyInput): ExecutionPolicyResult
```

优先级链：
1. SKIP（硬约束：vol / 临近涨停 / spread）
2. WAIT（开盘跳空 + 非紧急）
3. 按 size 分流 LIMIT / TWAP / VWAP / POV

### B.4 输入契约

```ts
interface ExecutionPolicyInput {
  symbol: string; side: 'BUY' | 'SELL';
  amount_yuan: number;             // 拟下单金额
  avg_daily_turnover: number;      // 近 20 日均成交额（元）
  current_volatility: number;      // ATR%/当日 intraday vol（0.01=1%）
  spread_pct: number;              // (ask - bid) / mid
  is_gap_up: boolean;              // 当日 |open - prev_close| / prev_close > 3%
  close_to_limit_up_pct: number;   // 距涨停板距离
  urgency?: 'low' | 'normal' | 'high';
}
```

---

## C. 现状 review

### C.1 Router 已就绪 + 接入 automation

- **路由器**：`backend/src/services/execution/ExecutionPolicyRouter.ts:1-378` —— 8 个 policy + 全 export 纯函数 `shouldSkip / shouldWait / pickSizeBasedPolicy / routeExecutionPolicy`，default options Object.freeze（line 88-100）。
- **生产接入**：`backend/src/portfolio/internal/PaperTradingAutomationService.ts:3091-3122` —— `executionPolicyResult = executionPolicyRouter.route(...)`；遇 SKIP 直接 skip 当前 trade。
- **cost 估算消费方**：`backend/src/services/tca/TCAService.ts:12,52,74` + `backend/src/services/meta-v2/EVDecisionService.ts:25,71` 都 import 用其 `estimateCostPct`。

### C.2 ⚠️ 关键缺陷：只算 policy 不真拆单

- **现状**：router 输出 `slice_count: 5`、`policy: 'TWAP'`，但 caller `PaperTradingAutomationService` 收到后**不拆单**——仍一次性 createBuyTrade 整笔 cost。
- **后果**：`policy='TWAP'/'VWAP'/'POV'` 在生产路径上**仅作为成本预估输入**，不实际执行拆单。SKIP / WAIT 倒是真生效（直接 skip 当前 trade）。
- **正确路径**：caller 应根据 slice_count 在 N 个时间点逐片下 child order，每片 = total / N，并按 participation_rate 监控盘口实际成交量动态调整。

### C.3 spread / vol / liquidity 输入来源

- `avg_daily_turnover` 来源：`DailyBar.amount` 近 20 日 avg（已在 ExecutionFeasibilityService 使用）；
- `spread_pct` 来源：`RealtimeQuote.raw_payload.bid1_price/ask1_price`（Sprint 34 #3b 已对接）+ fallback `(high-low)/close`；
- `current_volatility`：`AtrFactor` 14 期；
- `is_gap_up`：`|open - prev_close| / prev_close > 3%`。

### C.4 Iceberg 缺失

- 当前 8 policy 没有 Iceberg。
- A 股实务：大单 50 万股 → 显示 5 万股，broker 自动 refill。需要 broker-bridge 支持 `order_type=iceberg` + `display_qty` 参数。
- QMT / PTrade adapter 实测是否支持需 ops 确认（`integrations/broker-bridge/qmt_bridge/qmt_adapter.py` 待查）。

### C.5 集合竞价完全不支持

- `PaperTradingFacade.placeOrder:600-643` 强 reject 09:00-09:30、11:30-13:00、>15:00。
- 但**集合竞价**对 A 股开盘价决定权很大，回测策略中"集合竞价 BUY"模式（如 LeftSideReversal 抄底）无法在实盘复现。
- 缺少 `bypass_trading_hours=true` 之外的"call_auction_only" 显式 policy。

---

## D. 改造方案

### D.1 user story

| ID | 故事 | 验收 |
|---|---|---|
| US-EA-1 | **真拆单实现**：`ExecutionExecutorService.executeSliced(plan, policy_result)` — 按 slice_count 在 N 个时间窗口（TWAP 等距 / VWAP 按 historical volume curve）下 child orders；每 child 走 `facade.placeOrder`；累计成交 fill_count 写 audit | 1 个集成测：10 万元 BUY + policy=TWAP/slice=5 → 实际产生 5 笔 trade |
| US-EA-2 | **POV 动态调整**：每 30 秒读 `RealtimeQuote.volume` 增量 × participation_rate = 该窗口允许下单量；剩余 quantity 滚动到下一片；超过 max_slippage_pct → halt 剩余 | 单测：mock 盘口 volume 变化，下单 quantity 随之 |
| US-EA-3 | **Iceberg 接入**：broker-bridge 加 `order_type='iceberg'` + `display_qty` 字段；qmt_adapter / ptrade_adapter 试 broker SDK 支持情况；不支持时 fallback TWAP slice=10 | qmt/ptrade 至少一个支持，文档明确另一个的 fallback |
| US-EA-4 | **集合竞价 policy**：新增 `CALL_AUCTION_BUY`/`CALL_AUCTION_SELL` policy；09:15-09:25 / 14:57-15:00 时段内只允许这两种；走 `broker.submit_order(price=collect_call)` | 一次实盘集合竞价 BUY 走通 + 9:25 出价 |
| US-EA-5 | **policy 上线 shadow vs ground truth**：在 shadow 模式下记录 router 算的 expected slippage vs 实际 fill slippage；差值 > 30% 时 RiskAlert MEDIUM | TCA 报表里能看到对比 |
| US-EA-6 | **Iceberg / TWAP 反馈学习**：每月跑一次 `ExecutionPolicyTuner` 用过去 30 天 TCA 数据 grid-search 默认 slice_count / participation_rate；写 `ExecutionPolicyOptions` 用户配置 | 月报呈现新 / 旧参数对比 |

### D.2 与 62（旧编号）的合并

按用户要求 13 文档清单，原"62_execution_algorithms.md"（TWAP/VWAP/Iceberg 实现细节）**并入本文 B.1 + B.4 + D.1 US-EA-1/EA-2/EA-3**。

---

## E. 验收口径

- TWAP 5 切片场景下 5 笔 child order 真生成（不是只算 policy 不拆）
- POV 动态参与率每 30 秒重算；超 slippage 上限 halt
- Iceberg 至少在 qmt/ptrade 一处实现
- 集合竞价 BUY/SELL 走通至少 1 笔实盘
- TCA 报表 router_estimated_slippage vs actual_slippage 差 < 30%
- 文件位置：
  - `backend/src/services/execution/ExecutionPolicyRouter.ts`（已存在）
  - `backend/src/services/execution/ExecutionExecutorService.ts`（新建）
  - `integrations/broker-bridge/{qmt,ptrade}_bridge/*_adapter.py`（加 iceberg）
