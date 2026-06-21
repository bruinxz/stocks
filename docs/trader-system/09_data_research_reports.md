# 09 — 研报（一致预期 / 评级 / 目标价）

## A. 操盘手心智

研报是 **"卖方分析师对单股深度分析 + 一致预期"** 的来源。卖方的特点：
- 预测方向更可信（评级上调 / 下调即为信号），数值不一定准
- 重大评级变化往往领先股价 1-5 个交易日（机构对研报的反应快）
- "卖方分歧度"（同一股不同机构评级差异）= 风险信号

我每天看的研报维度：
- **一致预期 EPS**（年度 forecast_eps_y1/y2/y3）：用于算 PEG、判断 valuation
- **评级**（买入/增持/中性/减持/卖出）：评级被上调（buy → strong buy）是 alpha
- **目标价**：当前价 / 目标价 = upside 空间
- **研报频次（analyst_count）**：近 30 日有多少机构覆盖；高覆盖 = 共识强

**3 个典型 use case**：
1. **评级上调追买**：某股评级从"中性"调整到"买入" → 当日尾盘建仓
2. **业绩超预期事件**：财报后 5 个交易日内分析师集体上调 forecast_eps_y1 > 10% → PEAD 漂移信号
3. **价值修复识别**：当前 PE < forecast_eps_y1 隐含 PE 的 80% → 价值低估

**不看研报**：信号来源单一（只有量价 + 资金），失去机构对基本面共识的视角

---

## B. 系统设计

### B.1 schema 推荐

**AnalystForecast**（现有 [`backend/src/models/AnalystForecast.ts`](../../backend/src/models/AnalystForecast.ts) 226 行）：
- 3 元 PK: `(report_date, stock_code, analyst_firm)`
- 字段：rating / **forecast_eps_y1/y2/y3** + **forecast_year_y1/y2/y3** / target_price (nullable) / analyst_count / report_title / report_pdf_url

### B.2 6 项硬要求

1. **per-stock 同步**（不是 per-date）：每只股票一次拉全部历史研报；与 DividendHistory / FinancialReport 同款（[`AnalystForecastSyncService.ts:14-17`](../../backend/src/data/services/AnalystForecastSyncService.ts)）
2. **年度滚动**：AKShare 列名 "{Y}-盈利预测-收益" 跨年自动滚动；按 forecast_year_y1 显式存储年份字段（已实现 [`AnalystForecast.ts:149-152`](../../backend/src/models/AnalystForecast.ts)）
3. **同股同日多份研报 dedup**：保留信息量更多的那条（[`AnalystForecastSyncService.ts:20-23`](../../backend/src/data/services/AnalystForecastSyncService.ts)）
4. **target_price 缺**：AKShare 当前 endpoint 不提供；保留列待将来补
5. **派生计算在因子层**：上修幅度 / 评级变化等 alpha 不物化，在 `AnalystConsensusFactor` 实时算
6. **lookahead bias guard**：因子 compute() 跳过 report_date > as_of_date

### B.3 派生指标

- **rating_changes**：(prev_rating, new_rating, change_date) — 评级上调/下调事件流；**目前缺**
- **consensus_revision_rate**：近 90 日 forecast_eps_y1 平均变化率；**因子层算**
- **分歧度**：同股不同机构 forecast_eps_y1 的 std/mean；**缺**

---

## C. 现状 review

### C.1 已实现

| 项 | 文件:行 | 状态 |
|---|---|---|
| AnalystForecast model | [`AnalystForecast.ts`](../../backend/src/models/AnalystForecast.ts) 226 行 | ✅ |
| AnalystForecastSyncService | [`AnalystForecastSyncService.ts`](../../backend/src/data/services/AnalystForecastSyncService.ts) 267 行 | ✅ per-stock + dedup |
| AnalystConsensusFactor | [`library/AnalystConsensusFactor.ts`](../../backend/src/quant/factors/library/AnalystConsensusFactor.ts)（US-030） | ✅ per-year 上修因子 |
| EarningsSurpriseFactor | [`library/EarningsSurpriseFactor.ts`](../../backend/src/quant/factors/library/EarningsSurpriseFactor.ts)（US-032） | ✅ |
| Python helper | [`akshare_helper.py:2398`](../../backend/python/akshare_helper.py) `get_analyst_forecast` | ✅ |

### C.2 关键缺口

| # | 缺什么 | 证据 | 影响 |
|---|---|---|---|
| 09-1 | **target_price 全为 null** | AKShare 当前 endpoint 不返回 + AnalystForecast.ts 注释 | upside 计算不可用 |
| 09-2 | **评级变化事件表（rating_changes）缺** | grep 无 | 评级上调 / 下调追踪困难，需 join 同一股相邻 report 比较 |
| 09-3 | **分歧度无 derive** | 因子未覆盖 | 风险视角缺 |
| 09-4 | **研报关联到事件类型缺**：业绩点评 / 深度报告 / 行业研究 / 公司调研 | report_title 是 free text | NLP 分类未做 |
| 09-5 | **research_count_30d / count_90d 派生缺** | analyst_count 是当下时点的 AKShare 返回的数 | 历史覆盖度趋势看不到 |
| 09-6 | **同步频次低** | per-stock 同步成本高，5500 全市场每股 ~200ms = 18 分钟；当前 only 候选池 | 候选池外的股票研报数据陈旧 |
| 09-7 | **forecast_eps_y1 中位数 vs 平均**：因子用 mean 还是 median？大行 vs 小行权重？ | grep 实现 | 不同口径影响因子稳定性 |

---

## D. 改造方案

### D.1 P0

**US-09-1：评级变化事件表**
- 描述：建 `analyst_rating_changes` 表 (id, stock_code, change_date, prev_rating, new_rating, analyst_firm, direction ∈ {upgrade, downgrade, init, drop_coverage})；每日 cron 扫近 30 日新增研报 join 同股最近一份做 diff
- 验收：评级变化事件每日入表；策略可消费 direction='upgrade' 跟买

**US-09-2：分歧度派生因子**
- 描述：建 `AnalystDispersionFactor`：每股近 90 日 forecast_eps_y1 std / mean，分歧度高 → 风险（reduce weight）
- 验收：因子注册成功；IC 监测 3 个月

**US-09-3：研报全市场同步策略**
- 描述：扩展到候选池 + 持仓 + 北向重仓 top 200 共 ~500 只；每周日 03:00 跑增量；保证最新研报 ≤ 7 日
- 验收：500 只股票分析师覆盖度 dashboard 可见

### D.2 P1

**US-09-4：target_price 备源接入**
- 描述：寻找 target_price 数据：Wind 或 Tushare Pro 财务模块；接入后填 target_price 列
- 验收：500 只股票 target_price 覆盖率 ≥ 80%

**US-09-5：研报类型分类**
- 描述：用 NLP（同 AnnouncementNLPService 同款）分类 report_title → {业绩点评/深度报告/行业研究/调研/事件}；落 `report_type` 新列
- 验收：分类准确率 ≥ 85%

**US-09-6：研报覆盖度时序派生**
- 描述：派生 `analyst_count_30d / _90d / _180d`：每股近 N 日发研报机构数；落新表 `analyst_coverage_summary`
- 验收：可查趋势：某股 30d 覆盖度从 5 升到 15

### D.3 P2

**US-09-7：研报情感打分**
- 描述：title NLP 情感（强多/弱多/中性/弱空/强空）；同 KOLOpinion 同款映射 [-1, +1]
- 验收：情感打分 + sentiment_score 列；可与北向 / 龙虎榜 cross-validate

---

## E. 验收口径

1. 任选 100 只白马股，近 1 年研报覆盖率 ≥ 90%
2. 评级变化事件表：随机 10 个上调事件，stock_code + change_date 与人工核对一致
3. AnalystConsensusFactor 单测：构造测试 case，per-year 上修幅度计算正确（[`factors/CLAUDE.md`](../../backend/src/quant/factors/CLAUDE.md) US-030 已有测试）
4. EarningsSurpriseFactor：抽 5 个真实 PEAD 案例，因子值符号方向正确（[`factors/CLAUDE.md`](../../backend/src/quant/factors/CLAUDE.md) US-032）
5. target_price 接入后：upside 计算（current_price / target_price）单测覆盖

---

## 引用文件清单

- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/models/AnalystForecast.ts](../../backend/src/models/AnalystForecast.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/data/services/AnalystForecastSyncService.ts](../../backend/src/data/services/AnalystForecastSyncService.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/quant/factors/library/AnalystConsensusFactor.ts](../../backend/src/quant/factors/library/AnalystConsensusFactor.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/quant/factors/library/EarningsSurpriseFactor.ts](../../backend/src/quant/factors/library/EarningsSurpriseFactor.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/python/akshare_helper.py](../../backend/python/akshare_helper.py)（L2398 `get_analyst_forecast`）
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/quant/factors/CLAUDE.md](../../backend/src/quant/factors/CLAUDE.md)（US-030 / US-032 设计判据）
