# 37 — NorthboundFollow 北向资金跟随策略

## A. 操盘手心智

北向资金（沪深股通）是 A 股的"聪明钱"代理 — 外资机构资金，长期来看择股能力显著（国金证券 2019 实证 alpha 持续 5%+）。背后逻辑：
- **外资有全球视野**：选 A 股时会与 EM / DM 标的对比，挑性价比最高的
- **被动 ETF 跟踪**：MSCI / FTSE 调整成份会引发被动加仓（不带主观判断的纯增量）
- **主动机构资金**：QFII / RQFII / 沪深股通的 hedge fund 持仓与 alpha 高度相关

跟随策略不是"北向买什么我就买什么"——而是：
1. **5 日累计加仓 ≥ 0.5pp**（短期单日 noise 大）
2. **当前 hold_ratio > 1%**（排除"刚开始建仓试盘"的微仓）
3. **流通市值 > 100 亿**（北向偏好大盘股，小盘股噪音大）
4. **反向减仓 -0.3pp 必须卖**（北向掉头你也得跟，不要"我觉得长线没问题"）

跟随策略的关键 alpha 区别：
- **机构资金 momentum** (基本面/价值导向，中长线)
- **北向资金 momentum** (全球视角/EM 配置，中长线)
- 与游资资金（短线/题材）信号迥异

---

## B. 系统设计

### B.1 策略定义

证据: `backend/src/quant/strategies/NorthboundFollowStrategy.ts:350-385`：
- strategy_key: `northbound_follow`
- style: `large_cap_value` → 基准沪深 300
- 触发: 每日
- maxPositions: 20
- 持有 30 自然日
- Position: structured（entry_date / entry_price / entry_ratio / entry_industry）
- expected_edge_pct: 7% / expected_holding_days: 30
- kill_switch: win_rate_30d < 0.48

### B.2 入场 4 维 AND

证据: `NorthboundFollowStrategy.ts:21-26`：
1. 近 5 个交易日北向持股比例累计上升 ≥ +0.5pp
2. 当前 hold_ratio > 1.0%（排除微仓）
3. circulating_market_cap > 100 亿
4. 非 ST / *ST

### B.3 出场优先级 A→C

证据: `NorthboundFollowStrategy.ts:28-32`：
- A. 持有 ≥ 30 自然日 → SELL
- B. (close - entry) / entry ≤ -8% → SELL
- C. 近 5 个交易日北向减仓 ≥ |-0.3pp| → SELL（反向数据信号 exit！）
- D. 默认 HOLD

### B.4 候选池构造（全市场跟随类）

证据: CLAUDE.md L208-244 "跟随类策略 vs 事件驱动策略"对比表。
- 触发源是连续信号（北向每日都有）
- 候选池 = 全市场有北向数据的股票
- DataSource `loadCandidateRatioDeltas(asOfDate, lookbackDays)` 不接受 stockCodes — universe 由触发本身定义

### B.5 同源数据 entry + exit 复用

`loadCandidateRatioDeltas` 拉到 ratioSnapshots 后既给入场判定（delta ≥ 0.5%）又给出场判定（delta ≤ -0.3%）— 同一份数据用两次，避免重复 query。

### B.6 反向数据信号 exit（C 类）

NorthboundFollow 是首个引入"反向数据信号 exit"模式的策略（CLAUDE.md L246-249）。跟随策略的命脉：方向反转就退出，不能"我觉得长线没问题"硬扛。后续 GameTraderRelay（C= famous_yz 消失）、Breakout（C= 跌破 MA20）都是同一范式。

---

## C. 现状 review

### C.1 已实现部分

证据: `NorthboundFollowStrategy.ts` 785 行：
- 4 维入场 + 3 阶出场（含反向数据信号 C 类）
- DataSource 注入接口完整
- 同源数据 entry + exit 复用
- 优先级 A 硬约束 > B 止损 > C 软信号
- excludeST 默认 true
- 测试覆盖：candidateRatioDeltas / positionRatioDeltas / stockMeta / dailyClose 4 loader 可独立 mock

### C.2 与机构资金动量的区别（v.s. 北向资金动量）

NorthboundFollow 跟的是北向资金；但仓内**没有专门跟"机构资金"（公募基金 + 保险 + 社保）的策略**。机构资金动量 vs 北向资金动量是两个独立的 alpha：
- 北向: 外资视角，配置驱动 + 短期套利
- 机构: 境内视角，基本面驱动 + 长期持仓

FundConsensusFactor (Batch AC, 已有) 是机构资金的横截面 alpha 信号，但没有"跟随类"策略消费它。

### C.3 ⚠️ 北向减仓阈值偏松

|-0.3pp| 在 5 日窗口中是较温和的减仓。如果北向只是因为 MSCI 调成份被动减仓，- 0.3pp 1 周内反弹是常见 noise；可能"假减仓出场"错过后续行情。

### C.4 ⚠️ 缺被动 vs 主动北向区分

MSCI / FTSE 调整成份引发的"被动减仓"和主动 hedge fund 的"主动减仓"alpha 含义完全不同：
- 被动减仓 = 跟踪误差，不影响基本面
- 主动减仓 = 机构看法变化，需要警惕

数据层缺这个区分（NorthboundHolding 表只记 hold_ratio）。可考虑：MSCI 调成份日期前后 5 天的 ratio 变化打"被动"标签，其余打"主动"标签。

### C.5 ⚠️ 北向 5 日累计窗口过于刚性

5 日窗口在 bear regime 整体北向流出时，所有股票都"5 日累计 -0.X%"，eligible_count=0；但其中可能有"5 日 -0.1% 但前 15 日累计 +1%"的"逆势加仓"股，被错过。

可考虑：双窗口（5 日 + 20 日）相对动量。

### C.6 行业不中性

NorthboundFollow 没有 industryNeutral 参数。北向偏好白酒 / 银行 / 家电几大行业，top-20 可能严重集中。

### C.7 与 EarningsSurprise 北向加仓信号重复

两个策略都用"北向加仓" 作为信号：
- NorthboundFollow: 5 日累计 ≥ +0.5pp（中性候选）
- EarningsSurprise: 5 日累计 ≥ 0（双确认）

Ensemble 同时启用时会重复推荐同一只股票（vote 自然加分，这是设计预期）。

---

## D. 改造方案

### D.1 P0：增加机构资金跟随策略（与 NorthboundFollow 对偶）

**user story**：
- 新建 `backend/src/quant/strategies/FundFollowStrategy.ts`
- 入场: 近 1 个季度公募 top10 持仓 + 持仓基金数环比上升 + 流通市值 > 100 亿
- 数据源 FundTopHolding (已有 sync)
- 出场: 持仓 90 自然日 / -10% 止损 / 反向减持仓数下降
- Ensemble 在 bull / range regime 同时纳入两者（NorthboundFollow + FundFollow），形成"内外资双跟随"
- 验收: 新策略 sharpe ≥ 0.6；与 NorthboundFollow 收益相关性 < 0.5（独立 alpha）

### D.2 P0：行业中性约束

**user story**：
- default `industryNeutral=true, maxPerIndustry=4`
- 验收: top-20 单行业占比 ≤ 20%

### D.3 P0：双窗口北向 delta + 被动 / 主动区分

**user story**：
- 入场加 5 日 + 20 日双窗口确认（短中期同向）
- 出场加 "排除 MSCI 调成份前后 5 日的减仓" 过滤
- DataSource 加 loadMsciAdjustmentDates(year)
- 验收: 减少"假减仓出场"次数 ≥ 30%

### D.4 P1：北向减仓阈值动态化

**user story**：
- exitRatioDecreasePct 默认 -0.3pp 改为相对值（vs 全市场北向总流入）
- 全市场净流出日 北向都在减仓时，单股 -0.3pp 不触发（避免群体性"假减仓"）
- 验收: bear regime 不会一日把所有持仓全 SELL

### D.5 P1：FundConsensusFactor 联动

**user story**：
- 入场第 5 维: fund_consensus z_score ≥ 0（公募也共识）
- 北向加 + 公募持仓 = 内外资双共识，更强信号
- 验收: 启用后 win_rate 提升 ≥ 5pp，但 eligible_count 下降 50%（更严格筛选）

### D.6 P2：分级仓位

- delta ∈ [0.5, 1.0]pp → 标准仓
- delta ∈ [1.0, 2.0]pp → 1.2 倍仓
- delta > 2.0pp → 1.5 倍仓（强信号）

---

## E. 验收口径

1. **稳定性**: 同 (date, currentPositions) 重跑一致
2. **alpha 显著**: backtest 2023-2025 sharpe ≥ 0.8 / win_rate ≥ 50%
3. **反向 exit 触发**: 任意 backtest 区间 C 类 exit 占比 ≥ 15%（证明"跟随"机制真起作用）
4. **行业分散**: 单行业占比 ≤ 20%
5. **与新增 FundFollow 对偶**: 两者 backtest 收益相关性 < 0.5
6. **kill_switch**: win_rate_30d < 0.48 时 enabled=false
