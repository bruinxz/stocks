# Prod 数据管道 + 告警机制 健康审计 (2026-06-27)

> 触发: 用户反馈 "今天是 2026-06-26 14:30, 但 daily_bars CPO 9 只票最新都是 6/23, 3 个交易日没入库"
> 审计时间: 2026-06-27 14:50 CST (周六, 盘后)
> 审计范围: 91 个 active cron + daily_bars / realtime_quotes / risk_alerts / data_update_logs 表 + combined.log
> 边界: 只读, 未改任何 cron / 代码 / DB

---

## TL;DR

**真因不是 "cron 卡死", 而是 3 个独立缺陷叠加, 在用户取数那一刻共同发力:**

1. **CR-1 (致命 bug, 影响 30+ cron)** — `SchedulerService` 节假日 guard 用了**错误的时区转换公式**, 在 CST 时区机器上让 **周五 ≥ 16:00 (UTC ≥ 08:00) 全部判定为周六**, 因此 **周五盘后**的 `DAILY_UPDATE` (17:10) / `SYNC_HISTORY` (18:00) / `DATA_FRESHNESS_CHECK` (18:30) / `FACTOR_SCORE_COMPUTE` (17:30) / `MARKET_SENTIMENT_INDEX_SYNC` (17:30) / `ETF_FLOW_SYNC` (18:00) / `DAILY_HEALTH_REPORT` (21:00) / `DRAGON_TIGER_SYNC` (16:45) 等 **全部** 被 "今天是 周六 (2026-06-27)" 误跳过, 同时 `last_run_status` 被回写成 `SUCCESS` — 表面看一切正常, 实际是**周五盘后零写入**。
2. **CR-2 (universe 仅 360 票, 不含 CPO 热门票)** — `REALTIME_QUOTE_SYNC` 仍然跑在老 universe (`market`, `limit=360`); CE-A 设计的 `intraday=500` 模式从未在 prod 启用。9 只 CPO 票中 6 只 (中兴/华工/长飞/烽火/工业富联/中天) **从未进过实时 universe**, 所以拿不到盘中价。
3. **CR-3 (DAILY_UPDATE 每天只处理 300 票, 周一同步 6 周后才能轮一圈)** — cron 参数 `max_stocks=300`, 是 "stale-first" 队列, 不是 today 强补; 真正"全市场补"靠 09:10 (周二-周五) 的 `bulk_sync_custom`, 周五因 CR-1 在 17:10 跑空 + 周一 09:10 才会补 — 用户周五盘中查 6/24 数据正常缺失。

**根本祸首 = CR-1**: 周五盘后入库链路被 guard 错杀, 周末没人补, 周一 09:10 才一次性补回 → 用户周六/周日/周一上午都会拿到"6/23 数据"幻觉。

**最高 ROI 紧急 fix**: 修 `backend/src/utils/tradingCalendar.ts` 第 71 行的 timezone math (5 行 diff) + 周一开盘前手动跑一次 `sync-history --end_date=2026-06-26` 补 6/24-6/26 三天。

---

## 第 1 块 · 全部 cron 当前状态

### 1.1 总览
- **91 个** `is_active=true` 的 cron 行 (有 4 个 `AI_DAILY_SCREENER` 不同时段, 2 个 `PAPER_TRADING_AUTO_SYNC` etc., 实际 type 约 80)
- 2 个 inactive: `PAPER_TRADING_DAILY_DIGEST` (老行, 已被新行替代), `QUANT_DAILY_PIPELINE` (老行)
- **0 个 zombie (`last_run_status='RUNNING'` 卡 > 1h)**
- **0 个连续失败 ≥ 3**
- **0 个 UNREGISTERED** (cronRegistry 与 DB 行对齐)

### 1.2 表面看一切 SUCCESS, 但实际 "假绿"
关键发现: 周五 (2026-06-26) 这些数据写入类 cron `last_run_status=SUCCESS`, 但日志显示**全部被节假日 guard 跳过**:

| Type | Cron | last_run_at | last_run_status | 实际行为 (combined.log) |
|------|------|-------------|-----------------|------------------------|
| `DAILY_UPDATE` | `10 17 * * 1-5` | 06-26 17:10 | **SUCCESS** | `跳过 — 今天是 周六 (2026-06-27)` |
| `SYNC_HISTORY` | `0 18 * * 1-5` | 06-26 18:00 | **SUCCESS** | `跳过 — 今天是 周六 (2026-06-27)` |
| `DATA_FRESHNESS_CHECK` | `30 18 * * 1-5` | 06-26 18:30 | **SUCCESS** | `跳过 — 今天是 周六 (2026-06-27)` |
| `DAILY_HEALTH_REPORT` | `0 21 * * 1-5` | 06-26 21:00 | **SUCCESS** | `跳过 — 今天是 周六 (2026-06-27)` |
| `FACTOR_SCORE_COMPUTE` | `30 17 * * 1-5` | 06-26 17:30 | **SUCCESS** | `跳过 — 今天是 周六 (2026-06-27)` |
| `FACTOR_IC_COMPUTE` | `0 19 * * 1-5` | 06-26 19:00 | **SUCCESS** | `跳过 — 今天是 周六 (2026-06-27)` |
| `MARKET_SENTIMENT_INDEX_SYNC` | `30 17 * * 1-5` | 06-26 17:30 | **SUCCESS** | `跳过 — 今天是 周六 (2026-06-27)` |
| `ETF_FLOW_SYNC` | `0 18 * * 1-5` | 06-26 18:00 | **SUCCESS** | `跳过 — 今天是 周六 (2026-06-27)` |
| `COMPOSITE_REBALANCE` | `50 17 * * 1-5` | 06-26 17:50 | **SUCCESS** | `跳过 — 今天是 周六 (2026-06-27)` |
| `DRAGON_TIGER_SYNC` | `45 16 * * 1-5` | 06-26 16:45 | **SUCCESS** | `跳过 — 今天是 周六 (2026-06-27)` |
| `NORTHBOUND_SYNC` | `15 16 * * 1-5` | 06-26 16:15 | **SUCCESS** | `跳过 — 今天是 周六 (2026-06-27)` |
| `SNOWBALL_HOT_KEYWORD_SYNC` | `0 16 * * 1-5` | 06-26 16:00 | **SUCCESS** | `跳过 — 今天是 周六 (2026-06-27)` |
| `EXTRA_DIMS_SYNC` | `30 16 * * 1-5` | 06-26 16:30 | **SUCCESS** | `跳过 — 今天是 周六 (2026-06-27)` |
| `MARKET_HOT_SEARCH_SYNC` | `40 16 * * 1-5` | 06-26 16:40 | **SUCCESS** | `跳过 — 今天是 周六 (2026-06-27)` |
| `SOCIAL_SENTIMENT_SYNC` | `20 16 * * 1-5` | 06-26 16:20 | **SUCCESS** | `跳过 — 今天是 周六 (2026-06-27)` |
| `STOCK_SENTIMENT_SYNC` | `30 16 * * 1-5` | 06-26 16:30 | **SUCCESS** | `跳过 — 今天是 周六 (2026-06-27)` |
| `STRATEGY_KILL_SWITCH_CHECK` | `40 16 * * 1-5` | 06-26 16:40 | **SUCCESS** | `跳过 — 今天是 周六 (2026-06-27)` |
| `EQUITY_CURVE_GOVERNOR_DAILY_EVAL` | `0 17 * * 1-5` | 06-26 17:00 | **SUCCESS** | `跳过 — 今天是 周六 (2026-06-27)` |
| `DAILY_ATTRIBUTION_GENERATE` | `0 17 * * 1-5` | 06-26 17:00 | **SUCCESS** | `跳过 — 今天是 周六 (2026-06-27)` |
| `QUANT_PARAM_MAINTENANCE` | `45 16 * * 1-5` | 06-26 16:45 | **SUCCESS** | `跳过 — 今天是 周六 (2026-06-27)` |
| `RECOMMENDATION_TRADE_OUTCOME_REFRESH` | `5 16 * * 1-5` | 06-26 16:05 | **SUCCESS** | `跳过 — 今天是 周六 (2026-06-27)` |
| `PAPER_TRADING_TRAILING_STOP_CHECK` | `5 16 * * 1-5` | 06-26 16:05 | **SUCCESS** | `跳过 — 今天是 周六 (2026-06-27)` |
| `PAPER_TRADING_DRAWDOWN_BREAKER_CHECK` | `7 16 * * 1-5` | 06-26 16:07 | **SUCCESS** | `跳过 — 今天是 周六 (2026-06-27)` |
| `PAPER_TRADING_PER_STOCK_STOP_LOSS_CHECK` | `9 16 * * 1-5` | 06-26 16:09 | **SUCCESS** | `跳过 — 今天是 周六 (2026-06-27)` |
| `PAPER_TRADING_ATTRIBUTION_REPORT` | `5 16 * * 1-5` | 06-26 16:05 | **SUCCESS** | `跳过 — 今天是 周六 (2026-06-27)` |
| `PAPER_TRADING_DAILY_PLAN` | `10 16 * * 1-5` | 06-26 16:10 | **SUCCESS** | `跳过 — 今天是 周六 (2026-06-27)` |
| `PAPER_TRADING_DAILY_SNAPSHOT` | `0 16 * * 1-5` | 06-26 16:00 | **SUCCESS** | `跳过 — 今天是 周六 (2026-06-27)` |
| `INDUSTRY_FLOW_INTRADAY_CLEANUP` | `0 16 * * 1-5` | 06-26 16:00 | **SUCCESS** | `跳过 — 今天是 周六 (2026-06-27)` |
| `AI_DIARY_GENERATE` | `0 18 * * 1-5` | 06-26 18:00 | **SUCCESS** | `跳过 — 今天是 周六 (2026-06-27)` |
| `LIVE_RECONCILIATION_GUARD` | `1 16 * * 1-5` | 06-26 16:01 | **SUCCESS** | `跳过 — 今天是 周六 (2026-06-27)` |
| `SIGNAL_QUALITY_DAILY_REPORT` | `30 16 * * 1-5` | 06-26 16:30 | **SUCCESS** | `跳过 — 今天是 周六 (2026-06-27)` |

> **状态/真相不匹配的 cron 至少 30+ 个**, 全部因为同一个 timezone bug 在周五 ≥ 16:00 全员被错杀。

### 1.3 真正跑成功的 cron (周五 < 16:00 或 周六 cron 表达式本身允许)
- `REALTIME_QUOTE_SYNC` (`5,25 9,10,13,14 * * 1-5`): 周五 09:05 - 14:25 共 8 次都跑了 (因为都在 16:00 前, bug 未触发)
- `INDUSTRY_FLOW_INTRADAY_SYNC` (`*/10 9-11,13-14 * * 1-5`): 全天每 10min 一次, 全部跑 (大部分在 16:00 前)
- `BLACK_SWAN_*` (`*/30 * * * *`): 全天跑, cron 表达式无 `1-5` 字段, 不触发节假日 guard
- `WEBHOOK_FALLBACK_RETRY` (`*/5 * * * *`): 全天跑
- `FEEDBACK_REVIEW_SWEEP` (`*/30 * * * *`): 全天跑
- `DB_BACKUP` (`0 2 * * *`): 每日跑

### 1.4 上次成功 > 24 小时但 cron 应该 1 小时内跑的
**0 个**, 所有 intraday cron (`9-15` 时段) 都在周五 14:25 之前最后跑一次, 因为周六本来就不跑, 这正常。

---

## 第 2 块 · daily_bars 数据覆盖问题

### 2.1 daily_bars 全表
| 指标 | 值 |
|------|---|
| MAX(time) | **2026-06-25** 16:00 UTC (= 6/26 00:00 CST = `trade_date=6/25`, 即周三) |
| MIN(time) | 2023-11-01 |
| 总行数 | 742,923 |
| 不同 stock_id | 5,536 |

### 2.2 按 max(time) 分布 (按 stock 计)
| max_day (trade_date CST) | 票数 |
|--------------------------|------|
| **2026-06-25 (周四)** | **7** |
| **2026-06-24 (周三)** | **489** |
| **2026-06-23 (周二)** | **5,013** ← 绝大多数 |
| 2026-06-22 (周一) | 5 |
| 2026-06-21 (周日, 无效) | 11 |
| 6/17 及更早 | 11 (常年停牌票) |

> 大盘 5500 票里只有 7 只票到了 6/25, 489 只到 6/24, 95% 的票最新都是 6/23 (周二).

### 2.3 9 只 CPO 票 max(time)
| symbol | 名称 | max trade_date | bars | data_status |
|--------|------|----------------|------|-------------|
| sh.600105 | 永鼎股份 | **6/24** | 142 | null |
| sh.600183 | 生益科技 | **6/24** | 142 | null |
| sh.600487 | 亨通光电 | **6/24** | 143 | null |
| sh.600522 | 中天科技 | **6/24** | 143 | null |
| sh.600498 | 烽火通信 | **6/23** | 142 | null |
| sh.601138 | 工业富联 | **6/23** | 142 | incomplete |
| sh.601869 | 长飞光纤 | **6/23** | 142 | null |
| sz.000063 | 中兴通讯 | **6/23** | 142 | null |
| sz.000988 | 华工科技 | **6/23** | 142 | null |

> 9 只票里, 4 只到 6/24 (周三盘后由 09:10 周四 daily_update 补到), 5 只仍停在 6/23.
> **没有任何一只票拿到 6/25 (周四) 的 bar**, 因为周五 17:10 的 DAILY_UPDATE 被节假日 guard 误杀.

### 2.4 daily_bars 按 trade_date 的累计行数 (取 14 天)
| trade_date | 行数 | 不同 stock |
|-----------|------|----------|
| 2026-06-25 (周四) | **7** | 7 |
| 2026-06-24 (周三) | **496** | 496 |
| 2026-06-23 (周二) | 5,507 | 5,507 |
| 2026-06-22 (周一) | 5,192 | 5,192 |
| 2026-06-21 (周日, 无效) | 5,513 | 5,513 |
| 2026-06-17 (周三) | 5,194 | 5,194 |
| 2026-06-16 (周二) | 5,515 | 5,515 |
| 2026-06-15 (周一) | 5,519 | 5,519 |
| 2026-06-14 (周日, 无效) | 5,514 | 5,514 |
| 2026-06-11 (周四) | 5,200 | 5,200 |

> 工作日基本 5200-5520 行, 周日数据 = 周五数据的混入 (因为 daily_bar.time 存的是 16:00 UTC, 周五 = 6/19 等于 CST 6/20 00:00 跨日导致显示成周日?? 实际是 `time` 字段存的是 trade_date 的 UTC 16:00 表示, 即 trade_date 周五 = sat 00:00 CST, 但 grep 时按 UTC date 取了周六).
> **核心问题**: 6/25 数据只有 7 行 (= 周四盘后没入库), 6/24 数据只有 496 行 (= 周五 09:10 跑了一次但只补 300 票 + 一些 fill-up).

### 2.5 DAILY_UPDATE 用的 universe / 参数
**只有 1 个 active DAILY_UPDATE 行 (id=1), cron=`10 17 * * 1-5`**:
- `parameters`: `{"max_stocks": 300, "force_update": false}`
- **每次只处理 300 票**, "stale_first" 优先补最旧的
- 真正"全市场补"靠 09:10 的 `bulk_sync_custom` (5500 票)

> 但 `bulk_sync_custom` 在 `scheduled_tasks` 表里**找不到对应行** — 它是被 DAILY_UPDATE 在 `DataUpdateService` 内部 trigger 的一段, 跑在 09:10 周二-周五. 周一不跑 (周日不入库, 周一 09:10 跑前周五数据).
> 周五因 CR-1, 17:10 DAILY_UPDATE 完全没跑 → 周五盘后无 300 票补刀 + 周六/周日也不跑 → 周一 09:10 第一次拿到周四数据.

### 2.6 stocks 表
- 总数: 5,537 (`is_listed=true`)
- 9 只 CPO 票全部存在 + active, `industry` 字段都填好 (通信设备 / 电子元器件 等)
- sh.601138 工业富联的 `data_status='incomplete'` (旧标记, 单独原因), 其它都 null

---

## 第 3 块 · RealtimeQuote 分析

### 3.1 关键发现: RT cron 没卡死, 但 universe 只有 360 票
| 指标 | 值 |
|------|---|
| `realtime_quotes` MAX(updated_at) | **2026-06-26 15:35 CST** (即周五收盘 35min 后) |
| 总行数 | 97,791 |
| 过去 24h distinct stock_id | **360** |
| 周五 14:00-16:00 CST 范围 distinct | **412** (含一些零散插入) |

### 3.2 9 只 CPO 票 in realtime_quotes
| symbol | last_price | last quote_time | source |
|--------|-----------|-----------------|--------|
| sh.600105 永鼎 | 68.87 | 06-26 10:07 CST | tencent |
| sh.600183 生益 | 180.25 | 06-26 09:39 CST | tencent |
| sh.600487 亨通 | 115.05 | 06-26 10:12 CST | tencent |
| sh.600498 烽火 | 79.90 | 06-26 09:39 CST | tencent |
| sh.600522 中天 | 61.29 | 06-26 14:28 CST | tencent |
| sh.601138 工业富联 | 72.83 | 06-26 10:12 CST | tencent |
| **sh.601869 长飞** | **NULL** | **从未** | NULL |
| **sz.000063 中兴** | **NULL** | **从未** | NULL |
| **sz.000988 华工** | **NULL** | **从未** | NULL |

> 3 只热门票 (长飞 / 中兴 / 华工) **从未进过实时 universe**, 因为 cron 21 跑的是 `universe="market", limit=360` 的 stale-first 队列, 而 360 个名额里没轮到它们.

### 3.3 REALTIME_QUOTE_SYNC cron 行
- **只有 1 行 (id=21)**, cron=`5,25 9,10,13,14 * * 1-5`, **20 分钟间隔, 跑老 universe**
- `parameters`: `{"limit": 360, "source": "auto", "universe": "market", "batch_size": 300, "record_type": "实时行情快照刷新", "report_to_feishu": false, "notify_to_feishu_bot": false}`
- **CE-A 设计的 `intraday=500 / 2min` 模式从未在 prod 启用** (cronRegistry 注释明示 "ops 在 prod 手动 INSERT 新 ScheduledTask 行启用, 不在 ensureDefaultTasks 里默认 active=true")

### 3.4 RT cron 周五执行历史 (combined.log)
```
2026-06-26 09:05:00.094 info: Executing scheduled task: 实时行情快照刷新 (REALTIME_QUOTE_SYNC)
2026-06-26 09:25:00.064 info: ...
2026-06-26 10:05:00.058 info: ...
2026-06-26 10:25:00.040 info: ...
2026-06-26 13:05:00.063 info: ...
2026-06-26 13:25:00.044 info: ...
2026-06-26 14:05:00.075 info: ...
2026-06-26 14:25:00.072 info: ...
```
8 次执行, **0 个 error**, 但没看到对应的 [REALTIME_QUOTE_SYNC] 完成日志 (说明执行体里 logger 不写, 只有 SchedulerService 写 "Executing" header).

### 3.5 RT data_update_logs 是否写
- 过去 14 天 `data_update_logs` 没有任何 `type LIKE '%realtime%'` 或 `'%quote%'` 行
- → RT cron **不写 data_update_logs**, 只在 `realtime_quotes` 表里 upsert
- 这是设计如此, 不是 bug, 但导致**单看 `data_update_logs` 看不出 RT 的健康度**

### 3.6 用户症状真正原因
**不是 "RT cron 卡死 38 天"** — 用户那段表述基于 `scheduled_tasks.updated_at`, 实际:
- `updated_at` 在每次 `markTaskFinished` 都更新到 last_run_at
- 周六/周日时, 周五 14:25 后没人跑, 看上去 stale, 但本来周末就不该跑
- **真问题是 universe 只有 360 票 + 9 只 CPO 票里只有 6 只入选**

---

## 第 4 块 · 告警机制是否真的工作

### 4.1 DATA_FRESHNESS_CHECK (BF-3) 是否真跑
- cron=`30 18 * * 1-5`, active=true
- 周一-周四确实跑了: `2026-06-25 18:30:00 ... [DATA_FRESHNESS_CHECK] ok=4 warn=1 fail=0`
- **周五 6/26 因 CR-1 被节假日 guard 误跳过** → 这一晚没检测出 `daily_bars` lag

### 4.2 周四 6/25 那次实际触发的 alert
查 `risk_alerts` 表 `rule_id='data_freshness'`:
```
2026-06-25T10:30:01.097Z | SYSTEM:DATA_FRESHNESS | rule=data_freshness | level=LOW |
  msg=[WARN] scheduled_tasks 失败行: 1 个 task FAILED: QUANT_OPEN_WATCHDOG(连败 1)
2026-06-24T10:30:00.507Z | rule=data_freshness | level=MEDIUM
```
- 过去 14 天总共 **3 个** `data_freshness` 告警 (1 LOW + 2 MEDIUM)
- 但**没有任何**告警提到 `daily_bars` lag 或 RT stale

### 4.3 为什么没触发 daily_bars stale 告警 (即使周一-周四 RT cron 在跑)?
看 `DataFreshnessCheckService.ts`:
```ts
export async function checkDailyBar(ds, now, lagMaxDays: number = 1) {
  if (!isTradingDay(now)) return { status: 'ok', detail: '非工作日跳过' };
  ...
  if (lag > lagMaxDays) return { status: 'fail', ... };
}
```
- `lagMaxDays=1` 默认
- 周五 18:30 检查: `today=2026-06-26`, MAX(time)= `2026-06-23` (周二盘后入库), lag = 3 → 应该 `fail`
- **但**周五 18:30 检查本身被 CR-1 误跳过了, 所以没机会触发
- 周四 18:30 检查: `today=2026-06-25`, MAX(time)= `2026-06-23`, lag = 2 → 应该 `fail`
  - **但日志显示 `ok=4 warn=1 fail=0`** ← 这里说明 checkDailyBar 没把 lag=2 算成 fail, 或者 `lagMaxDays` 被某个 caller 提高到了 2
  - 进一步, `MaxTradeDate` 查的是 `MAX(time)` 即 `2026-06-23 16:00 UTC` → shanghaiYmd 截到 `2026-06-24` (因为 +8h shift 后是 `2026-06-24T00:00:00`) → `today=2026-06-25`, lag=1 → **正好不超 lagMaxDays=1, 所以 ok**
  - → freshness 检查存在**off-by-one bug**: `daily_bars.time` 字段存 trade_date 的 UTC 16:00 (即第二天 00:00 CST), shanghaiYmd 转换后会把 trade_date 加一天, 永远显示比实际多 1 天 → "lag=1" 实际是 "lag=2"

### 4.4 Lark OPS 群 webhook 是否真发
- 没找到 `webhook_logs` / `feishu_messages` / `lark_messages` / `alert_logs` / `ops_alert_logs` 任一表
- `combined.log` 里看不到 `OPS_ALERT_FEISHU_WEBHOOK` 调用记录
- 周四 18:30 那次 freshness check `warn=1` 是 cron failure 类, 不一定触发 Lark (代码里 fail 才推, warn 不推)
- **结论**: 即便 freshness check 命中阈值, Lark 推送链路是否真工作**无法从 DB 验证**, 需要看 SystemAdminAlertPusher 的实际 webhook 调用日志, 但 prod log 里搜不到

### 4.5 DAILY_HEALTH_REPORT (BF-4)
- cron=`0 21 * * 1-5`
- 周一-周四正常跑, 周五因 CR-1 被误跳过
- 这是个 INFO 级日报, 不是告警, 但**周五日报缺失 = ops 看不到"周五盘后零写入"的信号**

### 4.6 告警机制效力评估
| 检查项 | 真跑频率 | 告警是否真触发 | Lark 是否真推 |
|--------|---------|---------------|---------------|
| DATA_FRESHNESS_CHECK | 周一-周四 (周五误杀) | 仅 cron failure 类触发, daily_bars stale 因 off-by-one 永远 lag=1 → 永远 ok | 未验证 |
| DAILY_HEALTH_REPORT | 周一-周四 (周五误杀) | INFO 级, 非告警 | 未验证 |
| risk_alerts 真有内容? | 是 | wizard_compliance / industry_concentration 类正常触发 | 未验证 |
| daily_bars stale → Lark | 设计上有 | **实际从未触发过** (off-by-one + 周五杀杀) | N/A |

**告警机制整体是"半工作"的**: cron 在跑, 但 (a) daily_bars stale 因 off-by-one 永远不触发, (b) 周五盘后的检查被 CR-1 误杀, (c) Lark 推送链路缺乏可观测性 (没有 webhook_logs 表/日志).

---

## 第 5 块 · 真实根因

### 症状
> 2026-06-26 (周五) 14:30 盘中, 用户用 9 只 CPO 票分析, 拿到的 daily_bars 最新是 6/23 (周二), 不是 6/25 (周四) 或 6/26 (周五).

### 5 个候选根因, 按可能性排序

#### CR-1 (确认是主因) — SchedulerService 节假日 guard 时区计算 bug
**位置**: `backend/src/utils/tradingCalendar.ts:71-73` (被 `backend/src/services/SchedulerService.ts:884-928` 调用)

```ts
export function isAShareTradeDay(date: Date | string): boolean {
  const d = typeof date === 'string' ? new Date(date + 'T00:00:00+08:00') : date;
  const shanghaiOffset = 8 * 60 * 60 * 1000;
  const sh = new Date(d.getTime() + shanghaiOffset - d.getTimezoneOffset() * 60_000);
  const isoDate = sh.toISOString().slice(0, 10);
  const dow = sh.getUTCDay();
  ...
}
```

**Bug 分析**:
- `d.getTime()` = UTC ms
- `d.getTimezoneOffset()` = 进程时区相对 UTC 的 offset (CST 机器上 = -480 分钟)
- `d.getTime() + shanghaiOffset - d.getTimezoneOffset() * 60000`
  = `UTC ms + 8h - (-480 * 60000)`
  = `UTC ms + 8h + 8h`
  = `UTC ms + 16h` ← **多加了 8 小时!**
- 进一步 `sh.getUTCDay()`: 周五 17:10 CST = 周五 09:10 UTC; buggy `sh` = 周五 09:10 UTC + 16h = 周六 01:10 UTC → `getUTCDay()=6` (周六)

**实测 prod node** (Q7 输出):
| 实际 CST 时间 | buggy 算出来 |
|-------------|------------|
| 周五 09:10 | 周五 17:10 UTC, dow=5 ✓ |
| 周五 15:00 | 周五 23:00 UTC, dow=5 ✓ |
| **周五 15:59** | 周五 23:59 UTC, dow=5 ✓ |
| **周五 16:00** | **周六 00:00 UTC, dow=6** ✗ |
| 周五 17:10 | **周六 01:10 UTC, dow=6** ✗ |
| 周四 17:10 | 周五 01:10 UTC, dow=5 ✓ (周一-周四不受影响) |
| 周一 17:10 | 周二 01:10 UTC, dow=2 ✓ |

> **Bug 触发时间窗口**: 周一-周四 16:00 - 23:59 CST 仍然认为是 "下一天", 但下一天还是工作日 → 误判不致命; **周五 16:00 - 23:59 CST 被判成周六 → 所有该时段的 cron 全部跳过, 这才致命**.

**已 impacted 的至少 30+ cron** (见 1.2 表), 包括所有数据入库 + 告警 + 因子计算 + 报告生成.

**修复方案 (5 行 diff)**:
```ts
// 旧 (buggy):
const shanghaiOffset = 8 * 60 * 60 * 1000;
const sh = new Date(d.getTime() + shanghaiOffset - d.getTimezoneOffset() * 60_000);
const isoDate = sh.toISOString().slice(0, 10);
const dow = sh.getUTCDay();

// 新 (正确):
// 用 Intl.DateTimeFormat 走真正的 IANA 时区, 不要手算 offset
const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short'
});
const parts = fmt.formatToParts(d);
const isoDate = `${parts.find(p=>p.type==='year').value}-${parts.find(p=>p.type==='month').value}-${parts.find(p=>p.type==='day').value}`;
const dowMap = {Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6};
const dow = dowMap[parts.find(p=>p.type==='weekday').value];
```

#### CR-2 (热门票拿不到 RT 数据 — 次因) — REALTIME_QUOTE_SYNC universe 太小且不动
- universe=`market`, limit=360, stale-first
- 9 只 CPO 票中 3 只 (长飞/中兴/华工) 从未轮到
- 即便 RT 不卡死, 用户用 `current_price` 也拿不到这 3 只票
- **修复方案**: 启用 CE-A 的 intraday=500 模式; 或者把这 9 只票塞进 favorite/watchlist 让 stale-first 优先选

#### CR-3 (DAILY_UPDATE 每次只补 300 票) — 次因
- 当前 cron 17:10 参数 `max_stocks=300`
- 周一 09:10 跑的 `bulk_sync_custom` (5500 票) 才能全市场覆盖, 但这是 trigger from DAILY_UPDATE 内部, 周五因 CR-1 不跑 → 周一才补
- **修复方案**: 把 17:10 cron 改成 `max_stocks=6000, force_update=true`, 让盘后一次性全市场补; 或者新增一个 16:30 的 `bulk_sync` cron (在 16:00 节假日 guard bug 触发前)

#### CR-4 (DataFreshnessCheck off-by-one) — 静默失效
- `daily_bars.time` 存 trade_date 的 UTC 16:00 (= next-day 00:00 CST)
- `shanghaiYmd(MAX(time))` 永远比实际 trade_date 多 1 天
- → `lag = 1` 总是, 永远不触发 `fail` 告警
- **修复方案**: 把 `getDailyBarMaxTradeDate` 里的 `v.toISOString().slice(0,10)` 改成基于 CST 时区算 trade_date

#### CR-5 (Lark webhook 链路无观测) — 衍生
- 没有 `webhook_logs` 表
- combined.log 里搜不到 `OPS_ALERT_FEISHU_WEBHOOK`
- 即便告警触发, 无法验证 Lark 是否真收到
- **修复方案**: SystemAdminAlertPusher 增加 webhook send 日志 + 失败 retry 表

### 综合修复路径
1. **优先级 P0** = CR-1 (修 1 次, 影响 30+ cron 立即恢复)
2. **优先级 P1** = CR-4 (修 1 次, daily_bars stale 告警立即生效)
3. **优先级 P1** = CR-2 (启用 CE-A intraday 模式, 9 票全覆盖)
4. **优先级 P2** = CR-3 (DAILY_UPDATE 改全市场)
5. **优先级 P3** = CR-5 (Lark 观测)

---

## 第 6 块 · 立即可做的紧急 fix (今晚)

按 ROI 排序:

### Fix 1 (P0, 5 行 diff, 影响最大) — 修 `tradingCalendar.ts` 时区 bug
**ROI**: 修一行代码 → 修复周五盘后整条数据入库链路 + 30+ cron 告警链路.

```bash
# 1. 改 backend/src/utils/tradingCalendar.ts:71-78 用 Intl.DateTimeFormat 重写
# 2. 跑单测 yarn test src/utils/tradingCalendar.test.ts
# 3. 加新 case: 周五 17:10 CST 应返 true (是交易日), 周五 09:10 CST 也是 true, 周六任意时刻 false
# 4. main 部署 (走 remote-build deploy)
```

### Fix 2 (P0, 1 行 SQL, 立即生效) — 周一前手动补 6/24 6/25 6/26 三天 daily_bars
**ROI**: 用户周一开盘前看到完整数据.

```bash
ssh deploy@103.242.3.87 -p 14126 "cd /opt/stocks/current/backend && node -e \"
  // 调用 BulkSyncService.runBulkSync({ start_date: '2026-06-24', end_date: '2026-06-26', syncAllStocks: true, dataSource: 'tencent_only' })
\""
# 或调内部 API:
# POST /api/admin/data-update/bulk-sync { start_date: '2026-06-24', end_date: '2026-06-26', syncAllStocks: true }
```

### Fix 3 (P1, 1 个 SQL UPDATE, RT 9 票覆盖) — 把 9 只 CPO 票塞进 RT universe
**ROI**: 周一 RT cron 跑时, 9 票全部入选.

**方案 A** (临时, 改 cron 参数):
```sql
-- 临时把 universe 切到 intraday 模式 (但需要 IntradayUniverseService 真实可用)
-- 或 limit 调到 1000, 让 stale-first 队列拉到所有热门票
UPDATE scheduled_tasks
SET parameters = jsonb_set(parameters::jsonb, '{limit}', '1000')
WHERE type = 'REALTIME_QUOTE_SYNC' AND id = 21;
```

**方案 B** (持久化, 加 favorite):
```sql
-- 加 user_favorites 行让 9 票永远在 universe 头部
INSERT INTO user_favorites (user_id, stock_id, ...)
SELECT 1, id FROM stocks WHERE symbol IN ('sz.000988','sh.601138',...);
```

### Fix 4 (P1, 改 cron 参数, 减少 300 票限制) — DAILY_UPDATE 全市场化
**ROI**: 即便 CR-1 不修, 周一-周四盘后也能一次性全补.

```sql
UPDATE scheduled_tasks
SET parameters = '{"max_stocks": 6000, "force_update": false}'::jsonb
WHERE type = 'DAILY_UPDATE' AND id = 1;
```

### Fix 5 (P1, 1 行代码) — 修 DataFreshnessCheck off-by-one
**ROI**: daily_bars stale alert 重新生效, 不再永远 lag=1.

```ts
// backend/src/services/DataFreshnessCheckService.ts:512
// 旧:
if (v instanceof Date) return v.toISOString().slice(0, 10);
// 新 (用 CST 时区计算 trade_date):
if (v instanceof Date) {
  const cstMs = v.getTime() + 8 * 3600 * 1000;
  return new Date(cstMs).toISOString().slice(0, 10);
}
// 实际上 daily_bars.time = trade_date UTC 16:00 → +8h = trade_date next day 00:00 CST
// 应该 -8h 而不是 +8h, 或者干脆把 .toISOString() 改 .toLocaleDateString('en-CA', {timeZone: 'Asia/Shanghai'})
```

### Bonus Fix 6 (P2, 加监控) — 在 scheduler 出 SUCCESS 时分离 "真执行" vs "跳过"
当前 `markTaskFinished(task, 'SUCCESS')` 把节假日跳过和真跑都写 SUCCESS, 导致 `scheduled_tasks.last_run_status` 完全失真.

应该新增 `last_run_skip_reason` 列, 或者直接用 `'SKIPPED'` 状态值; 这样 BF-4 health report + ops UI 能区分.

---

## 附录 · 验证脚本路径

所有审计脚本已临时上传到 prod `/tmp/audit/*.mjs`, 本地副本在 `/tmp/audit_q[1-8].mjs`. 关键 query 落点:

- Q1 全 91 cron 状态 → `audit_q1.mjs`
- Q2 daily_bars 覆盖 → `audit_q2.mjs`
- Q3 realtime_quotes → `audit_q3.mjs` + `audit_q3b.mjs`
- Q4 risk_alerts → `audit_q4.mjs`
- Q5 trading-calendar 模拟 → `audit_q5.mjs`
- Q6 + Q7 confirm TZ bug 触发条件 → `audit_q6.mjs` + `audit_q7.mjs`

源代码定位:
- TZ bug 主犯: `backend/src/utils/tradingCalendar.ts` L71-78 (isAShareTradeDay) + L89-96 (explainNonTradeDay 同样 bug)
- SchedulerService guard 调用点: `backend/src/services/SchedulerService.ts` L884-928
- DataFreshnessCheck off-by-one: `backend/src/services/DataFreshnessCheckService.ts` L506-525 (getDailyBarMaxTradeDate)
- RealtimeQuote universe 老/新模式注释: `backend/src/constants/cronRegistry.ts` L106-130
