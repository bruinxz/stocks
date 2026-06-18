# 11 — 事件日历：业绩预告 / 解禁 / 央行政策 / IPO / 退市 / 分红

## A. 操盘手心智

事件日历是操盘手的 **"作战时间表"**。提前看 5-10 个交易日内的关键事件（业绩、解禁、IPO、分红、央行决议），能让我：
- 提前减仓 / 加仓
- 设置事件触发后的预案
- 风险预算前置（如：解禁前 5 日仓位降半）

我每天看的事件类型：
- **业绩预告 EarningsForecast**：报告期前披露 — 预增/预减/扭亏/首亏
- **限售解禁 RestrictedShareRelease**：解禁日 + 解禁市值 + 占流通市值比
- **分红 DividendHistory**：除权除息日 + 派息率
- **央行政策**：LPR / MLF / 准备金率会议
- **宏观数据公布**：PMI / CPI / 社融 / 进出口
- **IPO / 退市**：新股申购日 + 退市预警日
- **股权激励行权日 / 解除限售日**

**3 个典型 use case**：
1. **解禁前减仓**：持仓股 5 个交易日内解禁 + 解禁市值 > 流通市值 10% → 自动减仓 50%（RestrictedShareWatchdog 已实现）
2. **业绩预告超预期跟买**：is_surprise=true 公司 + 5 日内北向加仓 → 跟随
3. **央行降息前布局**：MLF 利率会议日 → 高股息板块（银行/地产）预加仓

**不看事件日历**：解禁日跳空低开来不及；业绩预告日满仓被埋

---

## B. 系统设计

### B.1 模型清单

| 事件类型 | Model | 数据源 | 时效要求 |
|---------|-------|--------|---------|
| 业绩预告 | [`EarningsForecast`](../../backend/src/models/EarningsForecast.ts) 164 行 | AKShare `stock_yjyg_em` | 报告期窗口前每周拉 |
| 解禁 | [`RestrictedShareRelease`](../../backend/src/models/RestrictedShareRelease.ts) 189 行 | AKShare `stock_restricted_release_detail_em` | T+1 / 30 日前瞻 |
| 分红 | [`DividendHistory`](../../backend/src/models/DividendHistory.ts) | AKShare | 实时 |
| 宏观经济 | [`MacroIndicator`](../../backend/src/models/MacroIndicator.ts) | AKShare `macro_china_*` | 月度 |
| **央行政策事件** | **缺** | AKShare `macro_china_*` 系列含 LPR 但**未派生事件表** | — |
| **IPO 日历** | **缺** | AKShare `stock_xgsglb_em`（新股申购）| — |
| **退市日历** | **缺** | AKShare 退市预警公告 | — |
| 交易日历 | [`backend/src/utils/tradingCalendar.ts`](../../backend/src/utils/tradingCalendar.ts) | 内置 | — |

### B.2 6 项硬要求

1. **未来 30 日前瞻**：所有事件至少能查未来 30 个交易日的"日历"
2. **per-stock 关联**：每只股票"未来 30 日内的事件清单" 一键可查
3. **风险预案前置**：解禁前 5 日 / 业绩预告前 1 日 / 除权前 1 日 触发不同 action
4. **复盘字段保留**：解禁后 20 日涨跌幅 / 业绩公告后 5 日股价等"事后字段"（[`RestrictedShareRelease.ts:47`](../../backend/src/models/RestrictedShareRelease.ts)）
5. **多事件日去重**：同一日同一股可能有多个事件（如除权 + 解禁），UI 聚合显示
6. **告警机制**：高 impact 事件（业绩超预期 / 解禁市值 > 流通 10%）自动触发 RiskAlert

### B.3 数据流

```
事件源（AKShare ~ 8 个 endpoint）
   ↓
EventSyncService（per type）
   ↓
事件表（5 模型）
   ↓
StockEventCalendarView（聚合视图）  ← per (stock_code, event_date) 多对一
   ↓
EventWatchdog（每日 cron）         ← 扫持仓 / 候选池触发告警
   ↓
RiskAlert + 飞书推送
```

---

## C. 现状 review

### C.1 已实现

| 项 | 文件 | 状态 |
|---|---|---|
| EarningsForecast model | [`EarningsForecast.ts`](../../backend/src/models/EarningsForecast.ts) 164 行 | ✅ 含 is_surprise |
| EarningsForecastSyncService | [`EarningsForecastSyncService.ts`](../../backend/src/data/services/EarningsForecastSyncService.ts) 262 行 | ✅ |
| EarningsForecastWatcher | `backend/src/services/EarningsForecastWatcher.ts` 1409 行 | ✅ 飞书推送 |
| RestrictedShareRelease model | [`RestrictedShareRelease.ts`](../../backend/src/models/RestrictedShareRelease.ts) 189 行 | ✅ |
| RestrictedShareSyncService | [`RestrictedShareSyncService.ts`](../../backend/src/data/services/RestrictedShareSyncService.ts) 251 行 | ✅ |
| RestrictedShareWatchdog | (US-089) | ✅ |
| DividendHistory + sync | [`DividendHistorySyncService.ts`](../../backend/src/data/services/DividendHistorySyncService.ts) 340 行 | ✅ |
| MacroIndicator model + sync | `MacroIndicator.ts` + macro 部分 | ✅ |
| TradingCalendar utils | [`backend/src/utils/tradingCalendar.ts`](../../backend/src/utils/tradingCalendar.ts) | ✅ |

### C.2 关键缺口

| # | 缺什么 | 证据 | 影响 |
|---|---|---|---|
| 11-1 | **统一 StockEventCalendarView 缺**：per (stock_code, event_date) 聚合 5 类事件 | grep 无 | 看持仓股事件要 join 5 表 |
| 11-2 | **央行政策事件无独立表**：LPR / MLF / 准备金率会议日历 | MacroIndicator 通用表存值，没标"事件日" | 政策驱动策略无法日历化 |
| 11-3 | **IPO 日历缺** | grep "ipo_calendar\|新股申购" backend/src 无 model | 打新功能不可做 |
| 11-4 | **退市预警日历缺** | grep "delist_warning\|退市预警" 无 model | 黑天鹅排雷依赖公告 NLP，不够及时 |
| 11-5 | **MacroIndicator 没有"announce_date"** | model 只有 observation_date | 不知何时知道、何时反应 |
| 11-6 | **业绩预告超预期阈值硬编码** | EarningsForecast.is_surprise 规则在 sync 时定（profit_change_low ≥ 50%） | 阈值不可调 |
| 11-7 | **股权激励事件无表** | grep "equity_incentive\|股权激励" 无 model | 行权信息缺 |
| 11-8 | **事件冲突识别缺**：业绩预告日 + 解禁日同日 → 风险叠加 | 未派生 | watchdog 各自跑 |

---

## D. 改造方案

### D.1 P0

**US-11-1：StockEventCalendarView 聚合表**
- 描述：每日 cron 19:00 跑：union 5 表 → 写 `stock_event_calendar`（stock_code, event_date, event_type, severity, payload_json）；未来 30 日前瞻
- 验收：UI "未来事件日历"可视化展示

**US-11-2：央行政策事件日历**
- 描述：建 `policy_event_calendar` 表 (event_date, policy_type ∈ {LPR/MLF/准备金率/PMI公布/CPI公布}, expected_value, actual_value, surprise_pct, market_reaction)；从 MacroIndicator + 公开日历手动维护
- 验收：未来 30 日内政策事件可查

**US-11-3：事件冲突识别**
- 描述：StockEventCalendarView 加 `conflict_count` 字段（同日 ≥ 2 事件）；conflict_count ≥ 2 触发 RiskAlert
- 验收：业绩公告 + 解禁同日案例必告警

### D.2 P1

**US-11-4：IPO 日历**
- 描述：建 `ipo_calendar` (apply_date, listing_date, code, name, price, ratio); 接 AKShare `stock_xgsglb_em`
- 验收：未来 5 日新股申购可查

**US-11-5：退市预警日历**
- 描述：建 `delist_warning_calendar` (warning_date, code, reason, warning_type ∈ {ST/退市风险/财务造假})；从公告 NLP 派生
- 验收：持仓股出现退市预警自动告警

**US-11-6：业绩预告 is_surprise 阈值可配**
- 描述：把硬编码 50% 改为可配置 `EARNINGS_SURPRISE_THRESHOLD`；ops 可调
- 验收：环境变量可配置；测试覆盖

### D.3 P2

**US-11-7：股权激励事件**
- 描述：建 `equity_incentive` 表 (announce_date, code, exercise_price, exercise_period, total_shares); 从公告 NLP 派生
- 验收：行权价相对当前股价折溢价可查

---

## E. 验收口径

1. StockEventCalendarView 覆盖 5 类事件；任选 10 只持仓股，未来 30 日事件一览准确
2. 央行政策事件：未来 30 日内 LPR / MLF 会议日期可查；与公开日历一致
3. RestrictedShareWatchdog：构造测试 case 解禁市值 > 流通 10%，必告警
4. EarningsForecastWatcher：构造业绩超预期，飞书推送 ≤ 30 秒
5. 事件冲突：构造解禁 + 业绩同日案例，conflict_count = 2 + 告警

---

## 引用文件清单

- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/models/EarningsForecast.ts](../../backend/src/models/EarningsForecast.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/models/RestrictedShareRelease.ts](../../backend/src/models/RestrictedShareRelease.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/models/DividendHistory.ts](../../backend/src/models/DividendHistory.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/models/MacroIndicator.ts](../../backend/src/models/MacroIndicator.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/data/services/EarningsForecastSyncService.ts](../../backend/src/data/services/EarningsForecastSyncService.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/data/services/RestrictedShareSyncService.ts](../../backend/src/data/services/RestrictedShareSyncService.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/services/EarningsForecastWatcher.ts](../../backend/src/services/EarningsForecastWatcher.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/utils/tradingCalendar.ts](../../backend/src/utils/tradingCalendar.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/python/akshare_helper.py](../../backend/python/akshare_helper.py)（L1117 `get_earnings_forecast` / L3934 `get_restricted_release`）
