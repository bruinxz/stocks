# 量化系统数据扩展完成报告

## 完成时间
2026-06-11 07:10 (release `20260611071010-main`)

## 新增 4 个量化数据维度

| 表 | 行数 | 数据来源 | 频率 | 用途 |
|----|------|---------|------|------|
| `macro_indicators` | 1847 | AKShare macro_china_* | 月度/日度 | PMI / CPI / M2 / SHIBOR / 10Y国债 / GDP |
| `option_qvix` | 6080 | AKShare index_option_*_qvix | 日度 | 4 个 QVIX 波动率指数 (50ETF/300ETF/500ETF/创业板) |
| `block_trades` | 3549 | AKShare stock_dzjy_mrmx | 日度 | 大宗交易明细 + 折溢价 + 营业部 |
| `fund_top_holdings` | 1788 | AKShare fund_portfolio_hold_em | 季度 | 12 个代表性公募基金重仓股 |

## MarketEnvironmentService 升级

`MarketEnvironmentSnapshot` 新增 2 个字段:
- `macro`: { pmi_latest, pmi_change_3m, m2_yoy, treasury_10y, shibor_overnight, cpi_yoy }
- `qvix`: { qvix_300etf_latest, qvix_300etf_change_5d_pct, qvix_300etf_percentile_60d, is_panic }

**regime 分类规则升级:**
- `stress` 触发新增条件: QVIX 60d 80% 分位 + 5d 上升 >10% + ret20 ≤ -2% (QVIX 先行恐慌信号)
- `bull` 触发禁止条件: PMI < 49 时即使指数涨也不切 bull (经济收缩期)

**EnsembleStrategy 自动受益** — `mapToEnsembleRegime` 把新触发的 stress 映射到 volatile 子策略组 (GARP 0.5 + HighDividendValue 0.5)。

## 新增 5 个 API

```
GET /api/macro/indicators           宏观时间序列
GET /api/macro/qvix                 QVIX 时间序列 (4 标的)
GET /api/macro/regime-snapshot      完整 market env (含 macro+qvix)
GET /api/macro/block-trades         最近 N 天大宗交易
GET /api/macro/fund-holdings/:code  某股被哪些公募重仓
```

## 新增前端 Tab

**FactorWorkspace → "宏观环境" tab**:
- 当前 regime 大字 + 触发依据
- 6 个宏观 KPI (PMI < 50 红色 + 警告 banner)
- QVIX 4 标的折线图 (近 90 日, 300ETF 加粗 = 主信号)
- 恐慌阈值触发时 error alert

## 新增 cron 任务

`EXTRA_DIMS_SYNC` 每个交易日 16:30 自动跑:
- macro 同步 (PMI/CPI/M2/SHIBOR/国债/GDP)
- qvix 同步 (4 个标的)
- block 近 7 天

Fund 维度因为是季度数据 + 需要 --year 参数，不进入 cron, 季报披露后手动跑。

## 当前 regime 实测 (2026-06-10)

- **PMI**: 49.4 (经济收缩，bull 被禁)
- **QVIX 300ETF**: 19.5 (60d 68% 分位，非恐慌)
- **沪深300 20d**: -4.87%
- **regime**: range (震荡均衡)

## 数据完整性

14 个数据源中:
- **10 green** (所有 critical + high 维度 ≤ 1d 滞后)
- **1 yellow** (财务报告 70d - 正常季报窗口)
- **3 unknown** (北向 / 舆情热度 / KOL - 接口死或低频数据)
- **0 red** ✅

## Commit 记录

```
a46465c feat(scheduler): EXTRA_DIMS_SYNC cron 16:30 自动跑 macro/qvix/block
69729b1 fix(macro-tab): 补全 RegimeSnapshot.breadth 子字段类型
eca7ce0 feat(macro): /api/macro/* + FactorWorkspace 宏观环境 tab
4a1c7b8 fix(fund-holdings): dedup PK 防 ON CONFLICT DO UPDATE row affected 2x
33c5620 feat(regime): MarketEnvironmentService 加入 macro + QVIX 信号
a741b96 fix(extra-dims): fund 维度默认 12 只代表性基金
aa6ff72 fix(block_trades): AKShare 实际列名是 '成交额' 不是 '成交金额'
fe39dbe feat(data): 新增 4 个量化数据维度（宏观/期权/大宗/基金）
```
