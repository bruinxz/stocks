# 01 — 数据层总览

> 本文是模块 A（数据层）的入口；02-12 各自展开一类数据。先读 [00_overview.md](00_overview.md) 了解整体方法论。

## A. 操盘手心智

我每天看十几个数据源：行情（日线/分钟/实时/盘口/集合竞价）、基本面（财报/PE/PB/ROE）、北向、龙虎榜、涨停、行业资金流、研报、公告、舆情、互动易、解禁、融资融券、内部人交易、股东户数。**这些数据丢一类我都做不出当天判断**。

不看数据会错过什么：
- 涨停板没识别一字板 → 追高被一字埋
- 北向已经连续 3 日净流出我没看到 → 还在加仓白马
- 研报评级下调没接到推送 → 持仓票第二天高开低走还以为是技术性回调
- 解禁前 5 日没预警 → 解禁日跳空低开 8%

**3 个典型 use case**：
1. **盘前 8:30**：拼装"昨夜信号包"（涨停/北向/龙虎/研报/公告/解禁），形成今日操作纪要
2. **盘中 10:00 异动**：某行业突然拉升 → 立刻调取行业资金流 + 涨停股 + 同板块成份股，判断是否跟
3. **盘后 16:00 复盘**：对所有持仓和候选池做 sanity check，识别"昨天对的今天还对吗"

---

## B. 系统设计

### B.1 全部数据源清单

按"采集粒度 × 时效 × 主备"分组（基于 [`backend/src/data/services/DataSourceHealthService.ts:16-150`](../../backend/src/data/services/DataSourceHealthService.ts) `DEFAULT_DATA_PROVIDERS` + [`backend/python/akshare_helper.py`](../../backend/python/akshare_helper.py) 50+ helper）：

| 类别 | 主源 | 备源 | 落库表 | 更新节奏 |
|------|------|------|--------|----------|
| 股票基础 | AKShare | EastMoney / Tushare | `stocks` | T+1 / 全量 |
| 日线行情 | AKShare `stock_zh_a_hist` | Tencent / Sina / Baostock | `daily_bars` | T+1 收盘后 |
| 分钟线 | AKShare `stock_zh_a_hist_min_em` | — | （**未落库**，仅 helper 调用） | on-demand |
| 实时报价 | AKShare `stock_zh_a_spot_em` | Tencent qt.gtimg.cn | `realtime_quotes` | 15-60 秒 cron |
| 5档盘口 bid/ask | Tencent qt.gtimg.cn | — | `realtime_quotes.raw_payload` + `bid1/ask1` 列 | 同实时 |
| 财务报告 | AKShare `stock_financial_abstract` | — | `financial_reports` | 季度披露窗口 |
| 估值/基本面/资金流因子 | AKShare 多端点 | — | `stock_valuation_factors` / `stock_fundamental_factors` / `stock_money_flow_factors` | T+1 |
| 北向资金 | AKShare `stock_hsgt_hold_stock_em` | — | `northbound_holdings` | T+1（港交所滞后 1 日） |
| 龙虎榜 | AKShare `stock_lhb_detail_em` | — | `dragon_tiger_board` | T+1 |
| 涨停 / 跌停池 | AKShare `stock_zt_pool_em` + `stock_zt_pool_strong_em` | — | `limit_up_stocks` | T+1 |
| 行业资金流 | AKShare `stock_sector_fund_flow_rank` | — | `industry_flows` | T+1 |
| 公告 | AKShare `stock_notice_report` | — | `announcement_summaries` | T+1 |
| 研报 | AKShare `stock_research_report_em` | — | `analyst_forecasts` | 实时 (publish_date) |
| 业绩预告 | AKShare `stock_yjyg_em` | — | `earnings_forecasts` | 报告期窗口 |
| 解禁 | AKShare `stock_restricted_release_detail_em` | — | `restricted_share_releases` | T+1 / 未来日 |
| 融资融券 | AKShare `stock_margin_detail_szse` + `_sse` | — | `margin_trading_balances` | T+1 |
| 内部人增减持 | AKShare `stock_ggcg_em` | — | `shareholder_trade_records` | 实时（公告日） |
| 股东户数 | AKShare `stock_zh_a_gdhs_detail_em` | — | `shareholder_counts` | 季度 |
| 财经新闻 | AKShare `stock_news_cls / stock_info_global_em / sina` | — | `market_news` | 高频 / 30 天保留 |
| 互动易 Q&A | AKShare `stock_irm_cninfo`（**代理东财股吧**） | — | `east_money_qa_topics` | 周聚合 |
| 雪球热词 | AKShare `stock_hot_follow_xq` | — | `snowball_hot_keywords` | T+1 |
| 百度热搜 | AKShare `stock_hot_search_baidu` | — | `market_hot_searches` | T+1 |
| KOL 观点 | AKShare 多端聚合（研报+新闻+热门概念代理） | — | `kol_opinions` | 实时 |
| 社融/CPI/PMI 等宏观 | AKShare 多端点 | — | `macro_indicators` | 月度 / 季度 |
| 市场情绪指数 | 内部派生（融资+涨停数+市场宽度） | — | `market_sentiment_indices` | T+1 |
| ETF 申赎 / 基金重仓 | AKShare ETF + fund | — | `etf_flows` / `fund_top_holdings` | T+1 |

> ❗ **Tushare / Baostock 在 `DEFAULT_DATA_PROVIDERS` 中是 priority 10/20，但默认 `is_enabled=false`**（需要 `TUSHARE_TOKEN` + `TUSHARE_ENABLED=true`），所以**生产实质只有 AKShare（python）+ 腾讯/新浪/东财（HTTP）4 个能用的源**（[`DataSourceHealthService.ts:12-150`](../../backend/src/data/services/DataSourceHealthService.ts)）。

### B.2 数据流图

```
            AKShare (Python helper, primary)
            ├─ stock_*  (50+ endpoints)
            └─ JSON-line over subprocess stdout
                   ↓
          backend/python/akshare_helper.py (5732 行)
                   ↓
          backend/src/data/sources/AKShareClient.ts (TS adapter)
                   ↓
  ┌────────────────────────────────────────────────────┐
  │ 25+ XxxSyncService (in backend/src/data/services/) │
  │  - 每个 service 对应一类数据                       │
  │  - bulkCreate + updateOnDuplicate (idempotent)     │
  └────────────────────────────────────────────────────┘
                   ↓
          Postgres (105 个 model in backend/src/models/)
                   ↓
       ┌──────────┴──────────┬─────────────────┐
       ↓                     ↓                 ↓
  FactorService          策略层           AI 分析引擎
  (factor_scores)       (signal)          (8 analyzer)
       ↓                     ↓                 ↓
              ↓ paper trading → live bridge
```

### B.3 6 项硬要求 → 现状映射

| 要求 | 现状 | 评级 |
|------|------|------|
| 多源（行情至少 2 源） | 日线主源 AKShare + Tencent 备源；实时 AKShare → Tencent fallback（`RealtimeQuoteService.ts:178-200`） | ✅ 行情 OK；其他（北向/龙虎/财报）**仅 AKShare 单源** |
| 新鲜（盘中 ≤ 30 秒延迟） | RealtimeQuote cron 15/30/60s 可配；DailyBar T+1 | ✅ 盘中 OK |
| 完整（全 A 5500） | `get_all_stocks` 覆盖 5500+；BJ 8/4 开头被部分策略默认 skip（[`akshare_helper.py:1195`](../../backend/python/akshare_helper.py)） | ⚠️ 数据全；**消费侧 BJ 默认避开** |
| 可追溯 | 每条都有 `source` + `raw_payload` + `created_at` | ✅ |
| 可验证 | `DataSourceHealthService.ts:1103` 行；`recordSyncMetrics` 监控失败率（`DataSyncService.ts:136-205`） | ⚠️ 健康度有，但**业务级 sanity check**（涨跌幅范围 / 停牌识别 / 缺失率）**散落，无统一面板** |
| 可降级 | 行情有 AKShare → Tencent → Sina 三级 fallback；**其他大部分单源就裸跑** | ⚠️ 行情 OK；其他**单源故障即静默缺数** |

### B.4 健康度监控总入口

[`DataSourceHealthService.ts`](../../backend/src/data/services/DataSourceHealthService.ts) 1103 行，做到了：
- `seedDefaultProviders`：注册 6 个 provider（tushare/baostock/akshare/eastmoney/tencent/sina）
- `recordHeartbeat` / `recordFailure`：每次调用更新 health_score
- `statusScore` + `latencyScore` 加权（`L207-231`）
- `firstUsableRoute`：fallback router

**未做的**：
- 没有"业务级 sanity"（例如 RealtimeQuote 日内涨幅 > 11% 异常告警）
- 没有"缺失天数检测"（例如某只股票 daily_bars 连续 3 日无数据告警）
- 没有"跨源校验"（同一交易日同股 AKShare 收盘价 vs Tencent 偏差 > 1% 告警）

---

## C. 现状 review

### C.1 已落地（80%）

- 25 个 SyncService 全部存在（[`backend/src/data/services/`](../../backend/src/data/services/) ls 全部 .ts）
- 105 个 model（`ls backend/src/models | wc -l` = 105）
- AKShare helper 5732 行 + 50+ endpoint
- HealthService 1103 行 + 6 provider 自动健康度
- 行情有 3 级 fallback；其他单源 + raw_payload 全保留

### C.2 关键缺口（盘点 7 条）

| # | 缺什么 | 证据 | 影响 |
|---|--------|------|------|
| C1 | **没有"数据层 SLO 仪表盘"**：每类数据"今日是否同步""完整度多少""last_synced_at"散落在 `DataUpdateLog` 表里但没汇总 UI | `DataUpdateLog.ts`（看不到 dashboard） | 缺数据时操盘手不知道 |
| C2 | **分钟线不落库**：`get_intraday_bars` 只是 helper（[`akshare_helper.py:750`](../../backend/python/akshare_helper.py)），无 SyncService，无 model | grep -i "minute\|intraday" models 无结果 | 无法做日内回测 / 集合竞价分析 |
| C3 | **集合竞价数据缺失**：09:15-09:25 集合委托数据无 helper、无 model | grep "集合竞价" 仓内无结果 | 早盘策略瞎打 |
| C4 | **跨源校验缺失**：日线只用 AKShare 单源入库（`DataSyncService.ts:251-312` syncAllStocks 无对比逻辑） | `DataSyncService.ts` 内无 cross-validation | 单源数据错谁也不知 |
| C5 | **Tushare/Baostock 默认关闭**：尽管列入 DEFAULT_PROVIDERS（[`DataSourceHealthService.ts:12-14`](../../backend/src/data/services/DataSourceHealthService.ts)），但 `is_enabled` 条件 `process.env.TUSHARE_TOKEN` 缺失就直接 false | L12-14 | 备源形同虚设 |
| C6 | **BJ 8/4 默认被 strategy 层 skip**，但前端 UI 无开关曝光 | `akshare_helper.py:1195` "策略自己过滤" | 用户不知 BJ 不被覆盖 |
| C7 | **新数据源接入 cost 高**：每加一类数据要写 (a) Python helper (b) TS Client (c) SyncService (d) Model (e) migration — 5 文件 1 设计文档 | 现状 25+ SyncService 体量 | 数据扩展边际成本高 |

---

## D. 改造方案

### D.1 P0（先做，1-2 周内）

**US-D01：建立"数据层 SLO 仪表盘"**
- 描述：新建 `/api/data/slo` endpoint + 前端面板，显示每类数据 (a) `last_synced_at` (b) 今日记录数 vs 7 日均值 (c) 7 日完整度 % (d) 当前 health_status
- 验收：仪表盘点开能看到 25 类数据每类一行；任一行红色（≤ 70% 完整度或 > 6h 未同步）触发飞书告警

**US-D02：跨源校验 cron**
- 描述：每日 17:00 跑 `DataCrossValidationService.run()`：随机抽 100 只股票，对比 AKShare vs Tencent 收盘价；偏差 > 1% 写 `RiskAlert`
- 验收：cron 跑成功后 `data_cross_validation_logs` 有 100 行；偏差 > 1% 的列表能在 UI 看到

**US-D03：业务级 sanity check 标准化**
- 描述：每个 SyncService 落库后调 `DataSanityChecker.validate(records, schema)`：涨跌幅 ∈ [-21%, 21%]、PE > 0 / PE < 1000、turnover_rate ∈ [0, 100]
- 验收：违规记录写 `data_quality_alerts` 表 + 飞书弱告警

### D.2 P1（4-6 周内）

**US-D04：分钟线落库**
- 描述：新建 `MinuteBar` model + `MinuteBarSyncService`；初期只同步候选池 + 持仓股的最近 30 日 1-min bar
- 验收：100 只候选池股票 1-min bar 入库；可被 `IntradayBacktestService`（已存在）消费

**US-D05：集合竞价数据接入**
- 描述：包装 `ak.stock_zh_a_spot_em` + `stock_zh_a_pre_min` 接口，落 `pre_market_quotes` 表
- 验收：9:25 触发 cron，9:26 前完成入库；候选池股票当日集合竞价数据可查

**US-D06：Tushare 接入兜底**
- 描述：申请 Tushare 试用账户配置到 ops 环境；用作日线 / 财务交叉源
- 验收：HealthService 显示 Tushare 状态 healthy；DataCrossValidation 三方比对（AK / Tencent / Tushare）

### D.3 P2（持续）

**US-D07：BJ 启停开关曝光前端**
- 描述：SettingsWorkspace 加 `include_bj_exchange` toggle；保存到 `user_preferences`；策略读此 flag 决定 universe
- 验收：开关 ON → BJ 股票进入候选池；OFF → 自动剔除

**US-D08：抽象 SyncService 基类**
- 描述：从 25 个 SyncService 抽象 `BaseSyncService<TModel, TRaw>`：默认提供 fetch / validate / bulkUpsert / errorRecord / heartbeat 5 步
- 验收：新增 1 个数据源 ≤ 50 行代码

**US-D09：每类数据的"健康度指标卡"**
- 描述：每类数据明确 SLO（如：DailyBar：T+1 17:00 前完成，覆盖率 ≥ 99.5%；RealtimeQuote：cron 间隔 ≤ 60s，覆盖 ≥ 5000 只）
- 验收：12 张 SLO 卡入 `docs/trader-system/sla-data-layer.md`

---

## E. 验收口径

1. **数据 SLO 仪表盘** 上线后，操盘手 ops 工作区一眼看见昨晚 11 类核心数据全绿（DailyBar / RealtimeQuote / Northbound / DragonTiger / LimitUp / IndustryFlow / Announcement / AnalystForecast / EarningsForecast / RestrictedShare / MarginTrading）。
2. **跨源校验** 连续 7 日无异常 → 证明 AKShare 数据可信；有异常时操盘手能 30 秒内定位差异股票列表。
3. **业务 sanity check** 100% 覆盖：每个 SyncService 落库前调用，违规率 < 0.1% 是新基线。
4. **手动制造异常**：拔 AKShare（mock 返回空）→ 行情自动切 Tencent；其他数据 silent skip 但写 `data_quality_alerts`。
5. **5500 全 A 覆盖率**：随机抽 50 只股票（含 BJ），对每只查 11 类数据，缺失率统计 ≤ 2%（BJ 除外）。

---

## 引用文件清单（绝对路径）

- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/data/services/DataSourceHealthService.ts](../../backend/src/data/services/DataSourceHealthService.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/data/services/DataSyncService.ts](../../backend/src/data/services/DataSyncService.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/python/akshare_helper.py](../../backend/python/akshare_helper.py)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/models/DataSourceHealth.ts](../../backend/src/models/DataSourceHealth.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/models/DataUpdateLog.ts](../../backend/src/models/DataUpdateLog.ts)
