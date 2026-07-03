# 21 — ETF 因子库（4 因子详解）

> 本文档已随重构改写。旧的「18+4=22 个个股 factor（含北向/龙虎榜/涨停连板/互动易/融资/大宗等 A 股特色因子）」库已删除——那套是给个股横截面选股用的，与新主线（ETF 因子轮动）无关。新主线只有 **4 个 ETF 层因子**，实现于 `backend/src/quant/etf/ETFFactorService.ts`，口径严格对齐 `SIGNAL_FIRST_PLAN.md` §4.1。

## A. 操盘手心智

因子是「市场无效性的可量化抓手」，每个因子背后必有一个**经济学故事**——故事讲不通的都是 data mining，迟早归零。新主线只保留有硬论文锚定、且能在 ETF 层稳定捕获的因子：

- **Value / Quality / LowVol**：有 Fama-French / Asness QMJ / 低波异象 论文支撑，MSCI 2025 明确指出 A 股高股息、低波比全球更突出。
- **Momentum 降级 shadow**：Hsu et al. (2017) 证明 A 股短期动量会反转，且 20 日动量与题材卫星逻辑重叠，一旦入核心会把主线拖向短线化。故权重 0、只观察、walk-forward 6 个月后再议。

> **ETF 层 vs 成分股层**：Value/Quality 是「先把 ETF 展开成成分股 → 每个成分股算原始值 → 按成分权重加权得 ETF 原始值 → 在 ETF 池内 z-score」。LowVol/Momentum 直接在 ETF 价格序列上算，不下沉成分股。

---

## B. 因子详解

### B.1 通用：ETF → 成分股展开

实现：`ETFConstituentExpander`（`backend/src/quant/etf/`）。

```sql
-- 宽基/风格因子/行业 ETF：用 index_components（跟踪指数），point-in-time 月末快照
SELECT stock_code, weight
FROM index_components
WHERE index_code = <etf_tracked_index>      -- e.g. '000300.SH'（沪深300）
  AND trade_date = <point_in_time_month>     -- 当月末快照
```

**Fallback**：若 `index_components` 无该 ETF 数据，用 `fund_top_holdings`（基金前十，覆盖 60-80% 权重已足够代表）。两者都空 → 该 ETF 从当月 candidate 池剔除。

### B.2 因子 1：Value（估值，权重 0.40）

- 逻辑：**Fama-French value premium** — 低估值长期跑赢
- 原始值（成分股层）：`stock_value_raw = z(1/pb) + z(1/pe_ttm) + z(dividend_yield)`
  - `1/pb` 市净率倒数、`1/pe_ttm` 市盈率倒数、`dividend_yield` 股息率，越高越便宜/越好
  - **z-score in universe** = 在全部候选 ETF 的所有成分股里做横截面 z-score
- 数据源：`daily_bars`（pe/pb）+ `financial_reports`（dividend_yield）
- ETF 层聚合：`etf_value_raw = Σ(weight_i × stock_value_raw_i) / Σ weight_i`
- 缺失：单字段缺 → universe median 填充；> 30% 成分股缺关键字段 → 该 ETF 当月 `data_incomplete`，不参与排名

### B.3 因子 2：Quality（质量，权重 0.30）

- 逻辑：**Asness QMJ** — 高 ROE / 稳定利润的优质公司长期跑赢
- 原始值（成分股层）：`stock_quality_raw = z(roe) + z(-stddev_5y_net_profit) + z(roe_5y_avg)`
  - `roe` 最近报告期净资产收益率
  - `stddev_5y_net_profit` 过去 5 年净利润标准差（取负，越稳越高分）
  - `roe_5y_avg` 过去 5 年 ROE 均值（吸收当期噪音）
- 数据源：`stock_fundamental_factors`（roe）+ `financial_reports`（5 年年报序列）
- ETF 层聚合：同 Value（成分权重加权）
- **Point-in-time 约束**：财报有滞后，3 月末算 4 月 Quality 必须用已披露年报，`report_period` 严格早于 `factor_date` ≥ 30 天

### B.4 因子 3：LowVol（低波动，权重 0.30）

- 逻辑：**低波异象** — 低波动股风险调整后跑赢；MSCI 2025 指出 A 股尤其突出
- 原始值（**ETF 层直接算，不下沉成分股**）：`etf_lowvol_raw = z(-vol_60d) × 0.6 + z(-vol_20d) × 0.4`
  - `vol_60d` = 过去 60 交易日每日 log-return 标准差 × √252（年化），取负
  - `vol_20d` = 过去 20 交易日年化波动率
  - 60 天权重 0.6、20 天权重 0.4 → 主看中长期兼顾近月
- 数据源：`daily_bars`（ETF 自身价格序列，`log_return = LN(close/prev_close)`）
- 缺失：交易日缺 > 5 天 → 该 ETF 当月剔除
- z-score in universe = 在全部候选 ETF 之间横截面标准化

### B.5 因子 4：Momentum（动量，权重 0.0 shadow only）

- 逻辑：观察题材/热点 ETF 是否有短期动量（**不入实盘**）
- 原始值（ETF 层）：`etf_momentum_raw = z(return_20d) − z(return_5d) × 0.3`
  - `return_20d` = close(t)/close(t-20) − 1
  - 减 `return_5d` = 反转过滤（短期猛涨的打折扣，Hsu 2017）
- 数据源：`daily_bars`（ETF 价格）
- 用途：**不进 total_score**，每月单独存 `momentum_shadow` 列，walk-forward 观察 6 个月后再定是否入正式权重

---

## C. Universe 定义（排名池）

- **候选 ETF 池 46-63 只**：宽基 8-12 / 风格因子 6-10 / 行业 20-25 / 主题 8-10 / 债券商品 4-6（见 §4.1 表）
- 通过 L1 `eligibility_gate`（§5.2）：上市 ≥ 180 天、日均成交额 ≥ 2000 万、非停牌、数据完整率 ≥ 90%

## D. 缺失处理阈值（`ETFFactorService` 常量）

| 阈值 | 值 | 处置 |
|---|---|---|
| `MAX_MISSING_CONSTITUENT_RATIO` | 0.30 | > 30% 成分股缺关键字段 → 该 ETF `data_incomplete`，不排名 |
| `MAX_MISSING_TRADING_DAYS` | 5 | LowVol 交易日缺 > 5 天 → 该 ETF 剔除 |
| 单字段缺 | — | universe median 填充 |

---

## E. 参考来源

- S&P Global, *Examining Factor Strategies in China's A-Share Market*
- MSCI 2025, *China A-Share Factor Investing*
- Asness, Frazzini, Pedersen, *Quality Minus Junk*
- Hsu, Viswanathan, Wang, Wool (2017), *Anomalies in Chinese A-Shares* (SSRN 2955144)
- CAIA, *Factor Investing in the China A-Share Market*

> **已删因子备忘**：value/quality/growth/momentum/lowvol/moneyflow/northbound/dragontiger/margin/insider/blocktrade/conceptheat/eastmoneyqa/shareholder 等个股 factor 文件仍物理存在于 `quant/factors/library/`（供 ETF 成分股层复用底层计算 + 历史回测），但**不再组装成个股选股信号**。新主线只消费上述 4 个 ETF 层因子。
