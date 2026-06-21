# 35 — HighDividendValue 高股息价值策略

## A. 操盘手心智

高股息策略是 A 股最稳健的"防御性 alpha"——长期年化 8-10% + 牛市跟不上但熊市抗跌。背后逻辑：
- **高股息率 = 实打实派现金**：业绩造假可能，分红不能造假（公司账上必须真有钱）
- **低 PE = 估值便宜**：分红收益率 / PE 一起看 = 实际"股权收益率"
- **ROE 5 年均值高 = 长期盈利能力**：避开"一次性高分红 + 周期性盈利"
- **大盘股 > 200 亿**：稳定派息 + 流动性好 + 不容易被借壳 / 重组打乱

这种策略不追求"踩准节奏"，而是"持有 3 年永远在派息"：
- 季度调仓（不每天动）
- 不设止损（长线相信价值回归）
- 行业可选中性（默认 false，因为高分红集中在金融/能源/公用事业）
- 持有 90+ 天

在 bear / volatile regime 是 Ensemble 必备的防守仓位。

---

## B. 系统设计

### B.1 策略定义

证据: `backend/src/quant/strategies/HighDividendValueStrategy.ts:18-50, 525-548`：
- strategy_key: `high_dividend_value`
- style: `high_yield_defensive` → 基准上证指数
- 触发: 季度（每季度第 1 个交易日，由 DataSource gate 判定）
- maxPositions: 30
- 持有 90+ 天（季度自然换仓）
- Position schema: string[]（长线不需 per-position state）

### B.2 入场 4 维 AND

证据: `HighDividendValueStrategy.ts:20-37`：
1. 近 lookbackYears(3) 年平均股息率 (yield_pct) ≥ minAvgDividendYield(4%)
2. PE-TTM ≤ maxPE(15) AND > 0（剔除亏损股）
3. ROE 5 年均值 ≥ minROE(10%)（≥ 2 个观测）
4. 总市值 > minTotalMarketCap(200 亿)
+ 非 ST

### B.3 季度调仓 gate

证据: `HighDividendValueStrategy.ts:40-43, 539-557`：
- DataSource.isFirstTradingDayOfQuarter(tradeDate) 内部判定
- 非调仓日 → 返回 `{is_rebalance_day: false, target_portfolio: previousSelection, signals: []}`
- 调仓日 → 走完整 4 维筛选 → BUY/SELL/HOLD 增量
- 调用方可 fearlessly 每日调用

### B.4 出场

证据: `HighDividendValueStrategy.ts:46-48`：
- **不设止损**（长线相信价值回归）
- 仅在调仓日 SELL（不在 top-N 内的 currentPositions 自动卖出）
- 长线策略止损归 portfolio 层 DrawdownCircuitBreaker (US-049)

### B.5 排序

`dividend_yield DESC → PE ASC → stock_code ASC`：股息率优先 + PE 越低越好 + 稳定 tie-break。

### B.6 DataSource 7 个 loader

`HighDividendValueDataSource`：
- `loadCandidateUniverse(asOfDate)` — 全 A 股 is_listed=true
- `loadAvgDividendYield(asOfDate, lookbackYears, codes)` — 3 年 yield_pct 均值
- `loadValuationSnapshot(asOfDate, codes)` — 最新 pe_ttm + total_market_cap
- `loadRoe5yAvg(asOfDate, codes)` — ROE 5 年均值
- `loadStockMeta(codes)` — name / industry / fallback total_market_cap
- `loadDailyClose(asOfDate, codes)` — BUY reference_price
- `isFirstTradingDayOfQuarter(tradeDate)` — gate

### B.7 market_cap 双源 fallback

证据: CLAUDE.md L420-422 `StockValuationFactor.total_market_cap 是"最新一日 valuation 数据"，可能落后 3 个月；Stock.total_market_cap 是"最新已知" — 优先 valuation，缺则 meta 兜底`。

---

## C. 现状 review

### C.1 已实现部分

证据: `HighDividendValueStrategy.ts` 921 行：
- 4 维 AND 入场完整
- 季度调仓 gate 在 DataSource 内部（非调仓日不动持仓）
- market_cap 双源 fallback 已实现
- 7 loader DataSource 全部抽离便于测试
- 不设止损（明确长线策略 design choice）
- excludeST 默认 true / industryNeutral 默认 false

### C.2 ⚠️ 与红利指数 ETF 缺基准对比

策略 backtest 当前 vs 上证指数。但更合适的基准是**中证红利指数 (000922)** 或**红利低波 (000922.SH)**——这两个是市场公认的"红利策略基准"。策略 alpha 应该用 vs 红利指数 alpha 衡量。

### C.3 ⚠️ dividend_yield 计算未除权调整

`DividendHistory.yield_pct` 是基于 ex_date 前日 close 计算的"派现率"，不是"未来 12 月预期收益率"。如果一只票去年突然派 5% 但今年减派到 1%，过去 3 年均值还是 3% — 不能反映真实派息可持续性。

### C.4 ⚠️ 缺"派息可持续性"check

应该加：free_cash_flow / dividend_paid ≥ 1.5（派息覆盖率 ≥ 1.5 倍才可持续）。否则会选到"借钱派息" / "卖资产派息" 的伪高股息股。

### C.5 ⚠️ industryNeutral 默认 false 易踩雷

高股息股集中在金融（银行 + 保险）+ 能源 + 公用事业 3 大行业。默认 false 时 top-30 可能 80% 是银行；如果银行行业系统性回调（如 2023 H2），策略整体重挫。

### C.6 ⚠️ 缺"作为 Ensemble 防御性 base 仓位"配置文档

Ensemble bear regime 用 HighDividend 0.60 + LowVol 0.40，但 LowVol 未实现，HighDividend 独食 1.00。bear 整段时间 portfolio 等于"高股息 30 只持仓"，capacity / 风格集中度风险大。

---

## D. 改造方案

### D.1 P0：基准对标改红利指数 / 红利低波 ETF

**user story**：
- 策略 backtest 默认 benchmark 改成中证红利 (000922) 或者沪深 300 红利 (000919)
- Ensemble 报告里 vs 红利指数 alpha + vs 沪深 300 alpha 双展示
- 验收: backtest 2020-2025 vs 沪深 300 红利 alpha ≥ 0%；vs 上证 alpha ≥ +3%

### D.2 P0：派息可持续性 check

**user story**：
- 入场 4 维 → 5 维：新增 free_cash_flow / dividend_paid ≥ minFcfDividendRatio(1.5)
- DataSource 加 loadFcfDividendRatio(asOfDate, codes)
- 验收: top-30 剔除"借钱派息"假高股息股；持仓 90 天内股息中断率 ≤ 5%

### D.3 P0：industryNeutral 默认改 true + maxPerIndustry=5

**user story**：
- 默认开启行业中性，单行业 ≤ 5 只
- 让 top-30 至少分布在 6+ 行业
- 验收: 任意 quarter top-30 单行业占比 ≤ 17% (5/30)

### D.4 P1：dividend_yield 用 forward 估算

**user story**：
- 加权: 0.6 × 历史 3 年均值 + 0.4 × 最近 1 年（更反映"近期派息能力"）
- 或者用最近季度公告的"未来 12 月预计派息"如果 announcement 数据可得
- 验收: 减少"过去派现高但未来减派"的踩雷概率

### D.5 P1：作为 Ensemble base 仓位的官方配置

**user story**：
- Ensemble 在 bear / volatile regime 默认把 HighDividend 当作 base（最低权重 0.50），不论其他子策略如何
- bull regime 也保留 HighDividend 0.10-0.15 作为"防御性仓位 base"
- 前端 Ensemble 详情页明示 "base allocation vs alpha allocation"

### D.6 P2：分级仓位（按股息率档次）

- 股息率 4-6% → 标准仓
- 股息率 6-8% → 1.2 倍仓（极优）
- 股息率 > 8% → 1.0 倍仓但加额外 check（防止"高股息陷阱" — 即将停止派息）

### D.7 P2：股息再投资模式

- BUY 时把上期分红到帐金额自动加进新仓位（"复利"）
- 需要与 PaperTradingFacade 联动获取 cash dividend 入账信号

---

## E. 验收口径

1. **稳定性**: 同 (date, params, previousSelection) 重跑一致
2. **季度调仓**: 非调仓日 BUY/SELL 信号数 = 0；调仓日换手率 ∈ [10%, 30%]
3. **风格防守**: 任意 12 个月窗口 max_dd ≤ 12%（防御性目标）
4. **派息可持续**: top-30 平均 fcf_dividend_ratio ≥ 1.5
5. **行业分散**: 单行业 ≤ 17%（开启 industryNeutral 后）
6. **alpha 显著**: vs 沪深 300 红利指数 alpha ≥ 0；vs 沪深 300 alpha ≥ +3%/year
7. **作为 Ensemble base**: bear regime 真持有该策略 ≥ 50% 权重（不是单一 HighDividend 独食）
