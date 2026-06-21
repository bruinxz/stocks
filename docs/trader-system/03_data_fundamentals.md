# 03 — 基本面：财报 / 估值 / 基础因子

## A. 操盘手心智

A 股有 5500 只票，**真正"业绩驱动 + 估值合理"的常年只有 200-400 只**。基本面是筛选这 200-400 池子的核心 — 不看基本面就只剩"题材炒作 + 技术追涨"两条腿。

我每天看的基本面维度：
- **季报/年报**：营收增速、净利增速、ROE、负债率
- **估值**：PE-TTM、PB、PS、PEG、股息率
- **规模**：总市值、流通市值、流通股本（决定可投资性 + 流动性）
- **质量**：毛利率稳定性、净利率、自由现金流（无可得则用净利率代理）

**3 个典型 use case**：
1. **GARP 多因子选股**：连续 3 年净利增速 ≥ 15% + ROE 5 年均 ≥ 12% + PE < 30 + PEG ≤ 1 + 负债率 < 60%
2. **业绩超预期事件**：财报日实际 EPS > 分析师一致预期 EPS 20% → 第二天高开追买（PEAD 漂移信号）
3. **价值陷阱排雷**：低 PE 但 ROE < 5 / 负债率 > 80% / 连续 2 年净利负增长 → 价值陷阱，剔除

**不看基本面**：满仓追题材，遇到业绩雷直接 -10%；做不出"持仓 6 个月以上"的中线策略

---

## B. 系统设计

### B.1 数据模型层次

```
FinancialReport (季度发布)
   ↓ derive
StockFundamentalFactor (T+1 派生)  ← per-stock per-day 快照
   ↓
StockValuationFactor (T+1 派生)    ← PE/PB/PS/市值
```

### B.2 6 项硬要求

1. **as_of_date 时点正确性**：因子 _date 必须 ≥ 财报披露日（announce_date），**绝不能用未来财报**（lookahead bias）
2. **announce delay 显式建模**：年报披露窗口 1-4 月，强制 `as_of_date ≥ announce_date + 1 个交易日` 才进策略
3. **同比基数处理**：净利 YoY = 当期净利 / 去年同期净利 - 1；分母为负（去年亏）时输出 null 而非 inf
4. **季节性**：Q1 / H1 / Q3 / Annual 不直接累加；TTM = 最近 4 个季度净利之和
5. **市值用历史**：因子分母用 `factor_date` 当日历史市值，**不要用 latest market_cap**（已在 Sprint 26 中修复一部分）
6. **多源校验（远期）**：Tushare Pro 财务数据用作 sanity check

### B.3 schema 推荐

**FinancialReport**（现有，[`backend/src/models/FinancialReport.ts`](../../backend/src/models/FinancialReport.ts) 156 行）：
- PK `(report_date, stock_code)`
- 缺：**announce_date**（披露日）！现有 schema 只有 report_date（报告期末），无法识别"什么时候真正可知"
- 缺：cash_flow_operating（经营现金流）、free_cash_flow、capex —— EarningsSurpriseFactor 用净利代理 EPS 就是因为这些不可得（[`factors/CLAUDE.md:223`](../../backend/src/quant/factors/CLAUDE.md)）

**StockFundamentalFactor**（现有 [`StockFundamentalFactor.ts`](../../backend/src/models/StockFundamentalFactor.ts) 93 行）：
- 字段：roe / gross_margin / net_profit_growth / revenue_growth / debt_asset_ratio / eps / book_value_per_share
- 派生：quality_score（内部预算）
- **as_of = factor_date**（每日派生快照） + **report_period** 标注引用的报告

**StockValuationFactor**（[`StockValuationFactor.ts`](../../backend/src/models/StockValuationFactor.ts) 90 行）：
- 字段：pe_ttm / pb / ps_ttm / total_market_cap / circulating_market_cap / pe_percentile_250 / pb_percentile_250 / valuation_score
- **缺**：股息率 dividend_yield、PE-G、企业价值 EV / EBITDA

---

## C. 现状 review

### C.1 已实现

| 项 | 文件:行 | 状态 |
|---|---|---|
| FinancialReport model | [`FinancialReport.ts`](../../backend/src/models/FinancialReport.ts) | ✅ 6 关键字段 |
| StockFundamentalFactor + ValuationFactor | 见上 | ✅ |
| FinancialReportSyncService | [`FinancialReportSyncService.ts`](../../backend/src/data/services/FinancialReportSyncService.ts) 204 行 | ✅ |
| GARP 策略 / quality_high 因子 | [`factors/CLAUDE.md`](../../backend/src/quant/factors/CLAUDE.md) US-031 | ✅ |
| Sprint 26 因子分母历史市值修复 | 任务 #26 已完成 | ✅ |

### C.2 关键缺口

| # | 缺什么 | 证据 | 影响 |
|---|---|---|---|
| 03-1 | **announce_date 缺失** | `FinancialReport.ts` 仅 report_date 无 announce_date 字段 | **lookahead bias 隐患**：策略可能用"未来报告"做"过去信号"；EarningsSurpriseFactor 已显式承认这个问题（[`factors/CLAUDE.md:227`](../../backend/src/quant/factors/CLAUDE.md)） |
| 03-2 | **经营现金流 / 自由现金流缺** | grep "cash_flow\|operating_cf" backend/src/models 无结果 | quality_high 用净利率代 FCF 是次优代理（factors/CLAUDE.md 已注明） |
| 03-3 | **股息率缺** | `StockValuationFactor.ts` 无 dividend_yield 列 | 红利策略要现算（已有 DividendHistory 表，但因子没 join） |
| 03-4 | **TTM 计算落地不明确** | `StockFundamentalFactor` 字段是单期还是 TTM？无明显注释 | 多因子合成口径风险 |
| 03-5 | **季报 sanity check 缺** | sync 时无校验：营收负值、ROE > 200%、负债率 > 100% 都会入库 | 异常财报污染因子 |
| 03-6 | **Tushare 财务备源未启** | `DataSourceHealthService.ts:12` `is_enabled` 默认 false | 单源 AKShare，财务字段口径偏差无从对比 |
| 03-7 | **EV / EBITDA / PEG 等高阶估值缺** | `StockValuationFactor` 只有 PE/PB/PS | 价值策略局限 |

---

## D. 改造方案

### D.1 P0

**US-03-1：补充 announce_date 字段**
- 描述：`FinancialReport` 加 `announce_date` 列（nullable + 后续 backfill）；从 AKShare `stock_yjbb_em` 或 `stock_zh_index_value_csindex` 拿披露日；EarningsSurpriseFactor 把 180 自然日窗口（[`factors/CLAUDE.md:227`](../../backend/src/quant/factors/CLAUDE.md)）改为 `announce_date + 60 交易日`
- 验收：单测断言：用 2024Q3 报告，announce_date 必须 >= 2024-10-31；因子计算时跳过 `announce_date > as_of_date` 行

**US-03-2：财报 sanity check**
- 描述：FinancialReportSyncService 落库前调 validateFR()：revenue ≥ 0、|roe| ≤ 100、|debt_ratio| ≤ 150、net_profit_yoy ∈ (-1000%, 10000%) 范围外写 `data_quality_alerts`
- 验收：异常行不入库主表，alert 表能查

**US-03-3：股息率 + PEG 接入**
- 描述：从 DividendHistory 算 TTM 分红 / 当日股价 → dividend_yield；从 PE / net_profit_yoy 算 PEG；落 `StockValuationFactor` 新列
- 验收：随机选 50 只蓝筹股，dividend_yield 与第三方网站对比偏差 ≤ 0.5%

### D.2 P1

**US-03-4：经营现金流接入**
- 描述：从 AKShare `stock_cash_flow_sheet_by_report_em` 拿经营/投资/筹资现金流；落 `cash_flow_statements` 表（新建）
- 验收：QualityHighFactor 升级路径打开，FCF 不再用净利代理

**US-03-5：TTM 字段显式标注**
- 描述：在 `StockFundamentalFactor` 增加 `roe_ttm / net_profit_ttm / revenue_ttm` 显式字段；现有 roe 字段统一改为单期年化 ROE
- 验收：数据字典更新；因子文档明确每个用法

**US-03-6：Tushare 财务接入**
- 描述：申请 Tushare token；FinancialReportSyncService 加 Tushare 备源；交叉对比 ROE / revenue / net_profit；偏差 > 5% 告警
- 验收：连续 5 个季度跨源校验，偏差告警 ≤ 5 只

### D.3 P2

**US-03-7：业绩快报识别**
- 描述：业绩快报（含权益分派预案、利润分配）在 AnnouncementSummary 里出现，建议在 sync 时 join 一道写入 FinancialReport.announce_date
- 验收：抽 10 只票，业绩快报日期与 announce_date 偏差 = 0

---

## E. 验收口径

1. 任选 100 只蓝筹股 + 100 只小市值股，2020-2026 报告完整度 ≥ 95%
2. **lookahead bias 单测**：构造测试用例，财报 announce_date = 2024-10-31，as_of_date = 2024-09-30，因子结果必须为 null（未来报告不可用）
3. **跨源**：AKShare vs Tushare（启用后）net_profit 偏差 > 5% 触发告警；目标连续 5 季度 < 5 只异常
4. **PEG 准确**：PEG = PE-TTM / (net_profit_yoy × 100)，单测 5 只蓝筹股结果与 Wind 偏差 ≤ 5%
5. **GARP 策略实盘**：每月底跑 GARP 选股，输出 30 只候选；ops 抽查每只票的 5 个基本面字段都正确

---

## 引用文件清单

- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/models/FinancialReport.ts](../../backend/src/models/FinancialReport.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/models/StockFundamentalFactor.ts](../../backend/src/models/StockFundamentalFactor.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/models/StockValuationFactor.ts](../../backend/src/models/StockValuationFactor.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/data/services/FinancialReportSyncService.ts](../../backend/src/data/services/FinancialReportSyncService.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/python/akshare_helper.py](../../backend/python/akshare_helper.py)（`get_financial_report` L2176）
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/quant/factors/CLAUDE.md](../../backend/src/quant/factors/CLAUDE.md)（US-031 quality_high / US-032 earnings_surprise 代理范式）
