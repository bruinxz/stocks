# 02 — 行情数据：日线 / 实时 / 盘口 / 集合竞价

## A. 操盘手心智

行情是**所有判断的地基**。技术派看 K 线、价值派看市值、量化派看收益率序列 — 没有干净的行情，所有上层信号都是空中楼阁。

我每天看的行情维度：
- **日线（OHLCV + 换手率 + 复权）**：用来回测、算动量/低波/突破因子、看年线月线均线
- **分钟线（1/5/15/30/60 分钟）**：用来盘中判断"上午冲高回落是否企稳"、"尾盘是否拉升"
- **实时报价（每 15-30s）**：盘中看当前价、涨跌幅、量比、换手
- **5档盘口 bid/ask**：判断"是真买盘还是假挂单"、"卖压在哪一档"
- **集合竞价（9:15-9:25）**：早盘判断"是高开还是低开"、"撤单率多少"、"开盘是否要追"

**3 个典型 use case**：
1. **盘前 9:20**：候选股集合竞价开盘价高于昨收 3% 以上 → 触发"高开追涨"分支；高开 7% 以上 → 谨慎或弃买
2. **盘中 10:30 异动**：单只股 30 秒内涨幅 > 2% + 量比 > 5 → 走 ExecutionFeasibility 判断流动性 + 真实 bid/ask spread 是否能下大单
3. **回测**：用 5 年日线 + 复权后收盘 + 同期换手率算 IC / IR、做 walk-forward 回测

**不看这些数据**会发生：
- 用未复权价回测 → 收益率虚高（除权日"假跌停")
- 没盘口 → 大单成交不了或滑点巨大
- 没集合竞价 → 早盘开盘价错估，TWAP / VWAP 起点偏

---

## B. 系统设计

### B.1 4 类数据 schema 推荐

**日线（DailyBar）**：
- PK: `(time, stock_id)` 复合
- 必有：open / high / low / close / volume / turnover / **adj_close**（复权收盘价）
- 推荐补：**adj_factor**（复权因子，方便策略层临时切前/后/不复权）、**turnover_rate**（换手率，已有但在 `StockMoneyFlowFactor` 表）、**market_phase**（开盘/午休/收盘 — 处理停牌当日的特殊场景）

**分钟线（MinuteBar，缺）**：
- PK: `(time, stock_id, period)` —— period ∈ {1m, 5m, 15m, 30m, 60m}
- 数据保留：1m 30 日；5m 90 日；其他全量
- 数据来源：`ak.stock_zh_a_hist_min_em`

**实时报价（RealtimeQuote）**：
- 现有：`(symbol, quote_time)` UNIQUE
- 已有字段：current_price / change_percent / open / high / low / volume / turnover
- 已加（Sprint 34）：bid1_price / ask1_price / bid1_volume / ask1_volume
- **缺**：bid2-5 / ask2-5（在 raw_payload 里，但未提列出方便查询）

**集合竞价（PreMarketQuote，缺）**：
- PK: `(trade_date, stock_code, snap_time)` — snap_time = 9:15:30 / 9:20 / 9:25
- 字段：matched_price / matched_volume / pre_volume / pre_amount / withdraw_volume（撤单量） / open_implied

### B.2 4 项硬要求

1. **复权一致性**：所有回测、因子计算用复权后；显示给用户用不复权；adj_close 必须每天 sync 时刷新（避免历史除权后旧 adj_close 失效）。
2. **盘中 ≤ 30 秒延迟**：cron 间隔 15-30s 可配；fallback 到 Tencent 必须在 5s 内完成切换。
3. **5500 全覆盖（含 BJ 920/430）**：日线全 sync；实时按 universe（候选池+持仓）。
4. **校验**：日内涨幅 > 11% 或 < -11% 写 RiskAlert（非 ST），明日开盘前 ops 复核。

### B.3 多源策略

- **日线主源**：AKShare（`stock_zh_a_hist`，[`akshare_helper.py:284`](../../backend/python/akshare_helper.py)）
- **备源**：Tencent（增量历史，priority 45）/ Sina（最后兜底）/ Baostock（免费历史）
- **跨源校验**：每日 17:00 抽 100 只对比 AKShare vs Tencent 收盘价，偏差 > 1% 告警

### B.4 BJ 920/430 处理

- 默认全量入库（数据层不歧视）
- 策略层 [`akshare_helper.py:1195`](../../backend/python/akshare_helper.py) "策略自己过滤" 备注 — 用户应明确知情
- 推荐：SettingsWorkspace 加 `include_bj` toggle

---

## C. 现状 review

### C.1 已实现

| 项 | 文件:行 | 状态 |
|---|---|---|
| DailyBar model | [`backend/src/models/DailyBar.ts`](../../backend/src/models/DailyBar.ts) 182 行 | ✅ 含 adj_close / amplitude / turnover_rate |
| 日线 sync | [`DataSyncService.ts:251`](../../backend/src/data/services/DataSyncService.ts) | ✅ syncAllStocks + 单股 syncStockProfile |
| RealtimeQuote model | [`RealtimeQuote.ts`](../../backend/src/models/RealtimeQuote.ts) 86 行 | ✅ |
| 实时 sync + 3 级 fallback | [`RealtimeQuoteService.ts:178-200`](../../backend/src/data/services/RealtimeQuoteService.ts) | ✅ AKShare → Tencent；Sina 在 CombinedDataSource 里 |
| 盘口 bid1/ask1 | [`RealtimeQuoteService.ts:112-132`](../../backend/src/data/services/RealtimeQuoteService.ts) | ✅ Sprint 34 引入；只到 bid1/ask1 |
| 分钟线 helper | [`akshare_helper.py:750`](../../backend/python/akshare_helper.py) | ⚠️ 只有 helper，**未落库** |

### C.2 关键缺口

| # | 缺什么 | 证据 | 影响 |
|---|---|---|---|
| 02-1 | **分钟线无 model 无 SyncService** | grep "MinuteBar\|minute_bars" 无结果 | 无法做日内回测、无法分析"开盘 30 分钟"决定整日 |
| 02-2 | **集合竞价数据完全缺失** | grep "集合竞价\|pre_market\|stock_zh_a_pre" backend/ 无结果 | 早盘策略只能凭实时报价猜，撤单率无从知 |
| 02-3 | **bid/ask 只到 1 档**，5 档 spread 不可见 | `RealtimeQuoteService.ts:115-132` | ExecutionFeasibility 评分粗糙；大单可行性失真 |
| 02-4 | **跨源校验缺失** | `DataSyncService.ts:251-312` 无 cross-validation | AKShare 异常静默 |
| 02-5 | **adj_close 重算策略不清** | `DailyBar.ts` 仅存当时入库的 adj_close，未发现"除权日批量回算"逻辑 | 老股票发生除权后，旧日线 adj 失效 |
| 02-6 | **stock_id 非 stock_code 形态**：DailyBar 用 stock_id，其他表（NorthboundHolding / DragonTigerBoard）用 stock_code（6 位）；join 必须先 loadStocksByCodes | [`backend/src/quant/factors/CLAUDE.md:146`](../../backend/src/quant/factors/CLAUDE.md) | 因子开发踩坑高发地（注释明确警告） |
| 02-7 | **涨跌停 sanity check 不在 SyncService**：sync 时无校验，策略层各自检查（[`PaperTradingAutomationService` 内有 isLimitUp` 等）— **数据层未拒**写入异常涨跌幅 | grep "isLimitUp\|涨停拦截" services | 异常数据直接污染 factor |

---

## D. 改造方案

### D.1 P0

**US-02-1：建立 MinuteBar 体系**
- 描述：新建 `MinuteBar` model（PK `time, stock_id, period`）+ `MinuteBarSyncService`；先支持 5m / 1m 两种 period；先 sync 候选池 + 持仓约 500 只股票
- 验收：500 只股票最近 30 个交易日 5m 全覆盖；`IntradayBacktestService` 能消费

**US-02-2：bid2-5 / ask2-5 全档位提列**
- 描述：把 RealtimeQuote 现有 `raw_payload` 中的 bid2-5 / ask2-5 提为独立列；扩展 `RealtimeQuoteService.persistQuotes`（[`RealtimeQuoteService.ts:300-320`](../../backend/src/data/services/RealtimeQuoteService.ts)）
- 验收：feasibility 评分能用 5 档 spread 算 weighted spread；spread 计算单测覆盖 5 档情况

**US-02-3：日线 sanity check（行情专属）**
- 描述：DailyBar 落库前调 `validateDailyBar(row)`：涨跌幅 ∈ [-21%, 21%]（ST -5%、ST +5%；BJ ±30%；CYB/KCB ±20%）、|high - low| > 0、volume ≥ 0
- 验收：sanity 违规写 `data_quality_alerts`；违规率监控可见

### D.2 P1

**US-02-4：集合竞价数据落库**
- 描述：包装 `ak.stock_zh_a_pre_min`（如不可用退而用 `stock_zh_a_spot_em` 9:25 触发抓取）；落 `PreMarketQuote` 表 + cron 9:15/9:20/9:25 三次
- 验收：候选池股 9:25 后 60 秒内能查到 matched_price / pre_volume / withdraw_volume

**US-02-5：日线跨源校验 cron**
- 描述：每日 17:00 跑 `DailyBarCrossValidate`：抽 100 只对比 AKShare vs Tencent close；偏差 > 1% 写 RiskAlert
- 验收：连续 7 日无 alert = 数据可信

**US-02-6：复权一致性 nightly job**
- 描述：每日 18:00 跑 `AdjFactorRecompute`：对当日发生除权除息的股票，回算其全部历史 adj_close
- 验收：单测断言除权日前后 adj_close 衔接平滑（前一日 adj_close × (1 - 除权比例) ≈ 当日 adj_close）

### D.3 P2

**US-02-7：交易日历 ground truth**
- 描述：单独建 `TradingCalendar` 表（已存在则补全）；所有 sync cron 跑前先查"今天是不是交易日"；非交易日直接 skip
- 验收：周末 / 节假日 cron log 显示 "skipped (non-trading day)"

---

## E. 验收口径

1. 任选 50 只股票（5 主板 / 5 创业板 / 5 科创板 / 5 BJ / 30 沪深普通），过去 1 年 daily_bars 完整度 ≥ 99.5%（缺的允许是 ST/停牌）
2. 实时 sync cron 跑 1 小时，候选池股票 RealtimeQuote 最新一条 quote_time 距 now ≤ 2 分钟
3. 任选 5 只候选池股票，9:30 开盘后 3 秒内能查到当日开盘价
4. MinuteBar 5m 数据：随机选股 + 随机日期，4 小时连续 K 线（48 根）完整
5. 复权一致性：除权除息日前后单测算 adj_close 衔接，偏差 < 0.01%
6. 故意把 AKShare URL 改错（mock），RealtimeQuote 自动切 Tencent + 写 health 降级 log

---

## 引用文件清单

- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/models/DailyBar.ts](../../backend/src/models/DailyBar.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/models/RealtimeQuote.ts](../../backend/src/models/RealtimeQuote.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/data/services/RealtimeQuoteService.ts](../../backend/src/data/services/RealtimeQuoteService.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/data/services/DataSyncService.ts](../../backend/src/data/services/DataSyncService.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/python/akshare_helper.py](../../backend/python/akshare_helper.py)（`get_daily_data` L284 / `get_intraday_bars` L750 / `get_realtime_quotes` L664）
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/quant/factors/CLAUDE.md](../../backend/src/quant/factors/CLAUDE.md)（stock_id vs stock_code 警告）
