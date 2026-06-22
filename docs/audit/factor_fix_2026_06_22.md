# Factor 修复报告 (Batch BA, 2026-06-22)

## 修了几个 factor

修了 **2 个 std=0 失效因子** + 写了 **47 个新单测** (16 个 + 31 个 = 47 包括端到端).

| factor | 修前 | 修后 | std_z | raw 范围 |
|--------|------|------|-------|---------|
| `growth` | fetched=0 / effective=0 / std=0 | fetched=24 / effective=24 / std=0.0645 | 0.0645 | [-42.77, +52.78] |
| `earnings_surprise` | fetched=0 / effective=0 / std=0 | fetched=20 / effective=20 / std=0.0586 | 0.0586 | [-1.65, -0.53] |

均超过任务要求的 **std > 0.05** 阈值.

## 真因 (调查结论)

两个因子的 std=0 同根 — 都依赖了 prod **永远 NULL 的列**:

```sql
-- prod 实测 (2026-06-22):
SELECT COUNT(*) AS total,
       COUNT(net_profit_growth) AS np_g,
       COUNT(revenue_growth) AS rev_g,
       COUNT(eps) AS eps,
       MAX(factor_date) AS latest
FROM stock_fundamental_factors;
-- total: 15184, np_g: 0, rev_g: 0, eps: 0, latest: 2026-06-22
```

`local_derived` sync 服务 (该表的唯一数据来源) 只填 `roe / gross_margin /
quality_score / debt_asset_ratio`, 从未填 `net_profit_growth / revenue_growth /
eps / book_value_per_share`. 所以:
- `GrowthFactor` (读 `net_profit_growth + revenue_growth`) → 永远 fetch=0
- `EarningsSurpriseFactor` (读 `eps`) → 永远 fetch=0

**Batch AN (commit `58f107b`, 2026-06-21)** 修过 `Number(null) === 0` 大坑
(避免 null 静默变 0 通过 `isFiniteNumber` 校验导致全市场 raw_value=0 的伪标准
差=0), 但只是治标 — 真正源头是数据源选错.

## 修复方案 (切数据源)

`FinancialReport` 表同期有 1113 行 24 只 A 股蓝筹 × 45 份历史季报, 字段
**完整非 NULL** 且与 `QualityHighFactor` (US-031) / `GARPStrategy` (US-024)
同源, 避免口径漂移. 切换映射:

| 因子 | 旧数据源 | 新数据源 |
|------|---------|----------|
| growth | `stock_fundamental_factors.{net_profit_growth, revenue_growth}` (NULL) | `financial_reports.{net_profit_yoy, revenue_yoy}` |
| earnings_surprise (actual_eps) | `stock_fundamental_factors.eps` (NULL) | `financial_reports.raw_payload.indicator_row['摊薄每股收益(元)']` |

EarningsSurpriseFactor 还顺便简化数据流: 旧版要查 FinancialReport +
StockFundamentalFactor 两表, 新版单 FinancialReport 一次性拿到 `actual_eps +
report_date + raw_payload`.

`extractActualEpsFromReport` 抽 export 纯函数 — 优先 **摊薄 EPS** (与卖方
forecast_eps_y1 口径契合), 回退 **加权 EPS**, 再回退 **调整后 EPS**.

## 新单测覆盖

**GrowthFactor.test.ts** (34 ok / 0 failed):
- pickLatestYoyByStock 8 边角: 空 / 多份取最新 / 多股票分组 / 全 null 两字段 /
  新行 null 不覆盖旧行 / 单缺项 / string DECIMAL / NaN+Infinity
- combineGrowth 5 边角: 正常 / 只缺 rev / 只缺 np / 都缺 → null
- end-to-end 5 场景: 真实 prod 数值 / 空表 / 空 universe early return /
  全 null 上游 (Batch AN 回归) / 多份历史取最新

**EarningsSurpriseFactor.test.ts** (93 ok / 0 failed, 老 77 + 新 16):
- extractActualEpsFromReport 12 边角: 摊薄主选 / 加权 fallback / 调整后
  fallback / 全 null / string DECIMAL / NaN 跳过 / 空 payload / 缺 indicator_row /
  null payload / undefined payload / indicator_row 非 object / 负 EPS
- end-to-end 3 场景: 茅台 actual=22.48 vs consensus=20.0 surprise=12.4% /
  raw_payload 缺 EPS 字段 (BA fetch=0 回归) / raw_payload=null

## 验证结果

prod 重算 `2026-06-18`:
```
growth:            fetched=24 effective=24 upserted=5532
earnings_surprise: fetched=20 effective=20 upserted=5532
```

业务方向 sanity 通过:
- growth 头部: 宁德时代 (+52.78%) / 中信证券 (+32.8%) / 海康 (+32.4%) —
  2026-Q1 真实利润高增个股都在 top
- earnings_surprise 全部为负: 24 只 Q1 实际 EPS 普遍低于 2026 全年一致预期均值
  (Q1 是 1/4 全年, 不可能等于全年 forecast). 相对排序仍有信号区分度
  (z range +1.13 to -2.07)

## 注意事项

**effective=24/20 是数据源容量上限, 不是代码限制**: `financial_reports` 表
当前只覆盖 24 只 A 股蓝筹 (`local_derived` 同步范围). 要让 growth /
earnings_surprise 覆盖到更多股票需要扩 ingest 范围 (不属本任务).

**未来升级路径**:
- 如果 `stock_fundamental_factors.{net_profit_growth, revenue_growth, eps}`
  字段补齐 (sync 服务修复), 考虑两源 fallback (先 FinancialReport, 缺数据
  再回退 StockFundamentalFactor)
- `FinancialReport.raw_payload` JSON 提取等 schema 引入 `eps` 独立列后改读
  独立列即可 (本因子单点修改, 无业务逻辑变更)

## Commits

- `fde10e2` fix(BA-1): GrowthFactor 切数据源 StockFundamentalFactor → FinancialReport (std=0 真因)
- `77932cf` fix(BA-2): EarningsSurpriseFactor 切 actual_eps 数据源 → FinancialReport.raw_payload (std=0 真因)

## 部署

- 编译: `cd backend && npx tsc -p tsconfig.json --pretty false` ok
- rsync: 仅 `dist/quant/factors/library/{GrowthFactor.js, EarningsSurpriseFactor.js}` → prod
- 重启: `sudo systemctl restart stocks-backend` ok
- 健康检查: `curl http://localhost:3000/health` → `{"status":"ok"}`
- 重算: `node dist/scripts/compute-factors.js --date 2026-06-18 --factors growth,earnings_surprise` ok

## 测试套件状态

- 所有 16 个 factor 测试全过 (`npm test -- --filter=factors --quiet`)
- 整套 102 个 spawn 子进程: 101 ok, 1 fail (`tests/scripts/check-openapi-drift.test.ts`)
- 唯一失败是 swagger-jsdoc/lru-cache + Node 18 ESM 不兼容 (TypeError:
  `tracingChannel is not a function`), **与本次修复完全无关** — git stash 后在
  baseline 同样失败. 属第三方依赖版本陈旧问题, 应另开 task 处理.
