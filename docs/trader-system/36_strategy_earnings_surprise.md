# 36 — EarningsSurprise 业绩超预期策略

## A. 操盘手心智

业绩超预期是 A 股最经典的事件驱动 alpha 之一——背后是 **Post-Earnings Announcement Drift (PEAD)**：超预期股在公告后 30-90 日继续漂移上涨。这个 alpha 在美股研究了 50 年仍然有效，A 股也持续显著。

但单一"业绩超预期"信号在 A 股容易踩坑：
1. **业绩预告 vs 实际报告差异**：预告"预增 50%" 实际"增 30%"，预期落空
2. **大盘大跌时所有股票都跌**：即使业绩好也跑不赢；需要"业绩好 + 资金面认可"双确认
3. **预告披露日 vs 价格已 priced in**：预告 1 天前股价已涨 20%，公告当天高开低走（known is dead）

老练的事件策略手法：
1. **预告类型只挑"预增/扭亏/续盈"**（不挑预减/续亏/略增）
2. **profit_change_low ≥ 50%**（高门槛，宁缺毋滥）
3. **配合北向资金近 5 日加仓**（机构验证）— 双源确认
4. **持有 60 天** 吃 PEAD drift
5. **-10% 严苛止损**（事件落空就跑）

事件分布稀疏 — 一年只有 4 个集中披露期（一季报 4 月 / 中报 8 月 / 三季报 10 月 / 年报 4 月），其余日子 `eligible_count=0` 是正常的。

---

## B. 系统设计

### B.1 策略定义

证据: `backend/src/quant/strategies/EarningsSurpriseStrategy.ts:410-433`：
- strategy_key: `earnings_surprise`
- style: `mid_cap_balanced` → 基准中证 500
- 触发: 每日（但只在公告日有信号）
- maxPositions: 20
- 持有 60 自然日
- structured EarningsSurprisePosition with entry_date / entry_price / entry_report_period

### B.2 入场 2 个核心维度（双确认）

证据: `EarningsSurpriseStrategy.ts:18-23`：
1. **业绩超预期**: forecast_type ∈ {预增, 扭亏, 续盈} AND profit_change_low ≥ minProfitChangeLow(50)
2. **北向加仓**: hold_ratio[as_of] > hold_ratio[as_of - lookbackDays(5)]
+ 非 ST

### B.3 出场优先级 A→B

证据: `EarningsSurpriseStrategy.ts:25-28`：
- A. 持有 ≥ 60 自然日 → SELL
- B. (close - entry_price) / entry_price ≤ -10% → SELL
- C. 默认 HOLD（无技术信号 / 反向资金信号 exit）

### B.4 判定顺序"早过滤先做"

`EarningsSurpriseStrategy.ts` DataSource 设计：
1. 事件触发过滤（forecast_type + profit_change_low）—— 通常剔除 80%+ 候选
2. 元数据过滤（ST）—— 单 Map 查询
3. 多源确认（北向 delta > 0）—— 最贵查询最后做

避免反过来"先批量查北向再过滤"会浪费 IO。

### B.5 DataSource 4 个 loader

- `loadAnnouncedForecasts(date)` — 事件触发源（当日 announce_date 公告 + 过滤超预期类型）
- `loadNorthboundRatioDelta(date, lookbackDays, codes)` — 确认源（双确认必须）
- `loadStockMeta(codes)` — 元数据（ST 过滤）
- `loadDailyClose(date, codes)` — 价格快照（止损 / 入场参考价）

### B.6 事件驱动 + 稀疏的特性

证据: CLAUDE.md L195-199 "业绩预告一年只有 4 个集中披露期。`generateSignals(date)` 大多数交易日返回 `eligible_count=0` 是**正常的**。"

不要把"无信号日"当告警。

---

## C. 现状 review

### C.1 已实现部分

证据: `EarningsSurpriseStrategy.ts` 813 行：
- 双确认入场（业绩 + 北向）
- 早过滤先做（事件 → ST → 北向）
- 60 天持有 + -10% 止损
- EarningsSurprisePosition 含 entry_report_period（debug 用："我是因为哪期预告进场的"）
- DataSource 4 loader 全部抽离
- 与 EarningsSurpriseFactor (US-032) 是不同维度：策略基于 forecast 表 + 北向；因子基于 actual EPS vs consensus EPS

### C.2 ⚠️ 缺业绩公布前 5 日布局窗口

当前只在 announce_date 当日触发信号。但实际经验：
- 业绩预告公告**当日**股价已 priced in（涨幅 5-10% 高开）
- 提前 1-5 日布局收益更大（机构可能从其他渠道提前知晓）

可考虑加：
- 业绩预告日历提前 5 日通知（接近预告窗口的股票，且历史业绩持续超预期）
- 用 AnalystForecast 表的 EPS 预期上修速率作 leading indicator

### C.3 ⚠️ 缺 PEAD drift 跟踪 / 减仓

PEAD 经典研究: 超预期股的漂移从公告日开始，30-60 日内继续上涨 3-8%，60 日后衰减。当前持有 60 天后强制 SELL 是合理的，但**不区分"涨上去的票"vs"震荡的票"**——前者应该 trailing stop 保护浮盈，后者应该 60 天到期裸出。

更细：
- 涨 > 15% → 启动 trailing stop（peak - 5% 或 - 2 × ATR）
- 涨 < 5% → 60 天到期裸出
- 跌 > -10% → 已经止损

### C.4 ⚠️ 北向加仓 5 日窗口可能太短

5 日 lookback 容易被单日大额 noise 主导。可考虑：5 日 + 20 日双窗口确认（短期加仓 + 中期趋势同向）。

### C.5 ⚠️ minProfitChangeLow=50 偏松

profit_change_low 是预告下限（"预增 50-100%"中的 50）。50% 在 A 股不算极高（很多周期股复苏季 100%+）。可考虑：
- 中等门槛: minProfitChangeLow=50
- 严格门槛: minProfitChangeLow=100（精选超预期"很多"的股）

### C.6 ⚠️ 行业不中性

EarningsSurprise 没有行业中性约束。某季度某行业整体业绩好（如 2023 Q1 半导体），top-20 可能 80% 半导体股，行业风险集中。

### C.7 实际报告 vs 预告差异未处理

策略基于 forecast（预告），但很多公司预告后 1-3 个月才出 actual report。actual 不达预告时，进场逻辑已经无效（"反预期"），应该退出。

---

## D. 改造方案

### D.1 P0：业绩公布前 5 日布局窗口

**user story**：
- 新增 param `useForecastLeadDays: number`（默认 0 = 当前行为兼容）
- 启用后：DataSource.loadAnnouncedForecasts 多查"预计未来 5 日 announce_date"的候选 + 该公司过去 4 季度持续超预期标记
- 入场信号在 announce_date - 5 触发（如果其他条件满足）
- 验收: 启用 LeadDays=5 后 backtest avg return / trade 提升 ≥ 2pp，但胜率可能下降（提前进场的不确定性）

### D.2 P0：actual report 反预期 exit

**user story**：
- 加 D 类出场：actual report 公告日，若 actual_eps < forecast_consensus → SELL 全部
- DataSource 加 loadActualReport(asOfDate, codes)
- 验收: 减少"预告超预期但实际落空"的尾部风险

### D.3 P0：行业中性约束

**user story**：
- 默认 industryNeutral=true / maxPerIndustry=4
- 验收: top-20 单行业占比 ≤ 20%

### D.4 P1：PEAD trailing stop

**user story**：
- 加 D 类: 涨 > 15% 后启动 trailing stop = peak - max(5%, 2 × ATR_10)
- Position 加 peak_close
- 验收: 涨 ≥ 15% 的票最终 avg return ≥ +12%

### D.5 P1：双窗口北向确认

**user story**：
- minIncreasePctShort (5 日，默认 +0.5%) AND minIncreasePctMid (20 日，默认 +1%)
- 双窗口都满足才入场
- 验收: 减少单日北向 noise 导致的假信号

### D.6 P2：分级 profit_change 门槛

- 50% ≤ profit_change_low < 100% → 0.7 倍仓
- 100% ≤ profit_change_low < 200% → 1.0 倍仓
- ≥ 200% → 1.3 倍仓（最强信号）

### D.7 P2：IV 暴涨提示

- 公告前 5 日股票的 implied volatility 暴涨 = 市场预期事件大（不论正负）
- 可作为"提前布局"额外信号（与 D.1 联动）

---

## E. 验收口径

1. **事件覆盖**: 4 个集中披露期内每天 ≥ 5 个 eligible 候选；其余日子 eligible=0 不告警
2. **双确认强度**: 入场必须同时满足业绩 + 北向，缺一不进
3. **持仓周期**: 平均 holding_days 在 [30, 60]
4. **行业分散**: top-20 单行业占比 ≤ 20%
5. **alpha 显著**: backtest 2023-2025 trade 数 > 50，avg return / trade ≥ +5%
6. **降低 actual 落空风险**: actual_eps < forecast 的票当天 SELL 触发率 ≥ 80%（剩余 20% 是停牌等无法卖出）
7. **稳定性**: 同 (date, currentPositions) 重跑一致
