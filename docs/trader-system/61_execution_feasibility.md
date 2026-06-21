# 61 — 执行可行性预判（Execution Feasibility）

> 在"该不该下这一单"前再加一道软评估——综合流动性、盘口、涨跌停距离、停牌/ST 状态算 `fillable_score ∈ [0, 100]` 决定 fillable / risky / blocked。

---

## A. 操盘手心智

我每天都遇到这种情况：信号说"BUY 600519 50 万"，但盘口告诉我：
- 距涨停 0.3% → 上去就涨停封死，根本拿不到
- avg_volume 5000 万 → 50 万是 1% 当日 volume，冲击成本 1.5%
- spread (ask - bid) / mid = 0.4% → 卖一档没量，要吃 5 档

这些信息综合起来 → "能不能成交"。能成交 → 走 ExecutionPolicyRouter 决定怎么拆单；不能 → SKIP 这单。

工程化：抽 4 个子分量加权打分 + 4 个硬约束（status_score）。

---

## B. 系统设计

### B.1 4 子分量加权

| 子分量 | 权重 | 含义 |
|---|---|---|
| `limit_proximity_score` | 0.3 | 距涨/跌停板的距离（5% 100 / 0% 0） |
| `volume_coverage_score` | 0.3 | target_qty / avg_5d_volume（< 0.1% 100 / > 10% 0） |
| `spread_score` | 0.2 | (ask - bid) / mid（< 1% 100 / > 5% 0） |
| `status_score` | 0.2 | 硬约束：suspended/ST/limit_up/limit_down/T+1 任一触 0 |

```
composite_score = 0.3 × limit + 0.3 × volume + 0.2 × spread + 0.2 × status
```

### B.2 决策阈值

| composite | decision | 处置 |
|---|---|---|
| ≥ 70 | `fillable` | 放行进入 ExecutionPolicyRouter |
| 30-70 | `risky` | 写 warning + 进 router 但 size 减半 |
| < 30 | `blocked` | SKIP + 写 RiskAlert LOW |
| 任一 block_reason | `blocked` | 同上（status_score=0 自动 blocked） |

### B.3 涨跌停距离按市场段

复用 `quant/marketLimits.ts`（audit S-2 修复）：
- 主板 10%
- 创业板 / 科创板 20%
- 北交所 30%
- ST 5%（不分段）

`distance / limit_pct → score`：距 5% = 100，距 0 = 0，线性插值。

### B.4 盘口数据来源

| 字段 | 来源 |
|---|---|
| `bid1_price / ask1_price` | RealtimeQuote.raw_payload（Sprint 34 #3b） |
| `spread` | `(ask1 - bid1) / mid` |
| fallback | `(high - low) / close` （high_low_proxy）|

bid/ask 缺失时 spread_score 用 proxy 算（精度差）；audit M-18 建议加 Prometheus metric 监控真实比例。

### B.5 T+1 校验

BUY 不查；SELL 时若 `holding_buy_date == today` → block。
由 `preTradeGuards.checkTPlus1` 统一实现（详见 60 七闸门）。

### B.6 Almgren-Chriss 升级（v2）

`use_almgren_chriss=true` 时用线性 impact model 替换 volume_coverage：
```
impact_cost = γ × (target_qty / avg_volume)^α
score = impactCostToScore(impact_cost)
```

更精确但要求 calibration 输入。生产默认 v1。

---

## C. 现状 review

### C.1 实现完整

- `backend/src/services/execution/ExecutionFeasibilityService.ts:1-200, 795 行`
- 4 子分量 + 决策阈值 + 硬约束都在
- DataSource DI + persist 可选

### C.2 marketLimits 统一已完成（audit S-2）

- line 43-51: 重新导出 `quant/marketLimits` 常量
- line 171-185: `inferMarketSegment / getLimitPct` 兼容 wrapper
- 三处（feasibility / backtest / facade）共用一份实现

### C.3 ⚠️ 生产侧 spread 多走 proxy（audit M-18）

- `backend/src/portfolio/internal/PaperTradingAutomationService.ts:2351,4386,4451` 注释承认"akshare/daily_bar fallback 时缺 bid/ask"
- 真实 bid/ask 仅在 RealtimeQuote 抽取成功时才有；fallback 时 spread_score 退化到 (high-low)/close
- memory `sprint-34` 写的"真盘口"在生产路径上不是 100% 真

### C.4 决策阈值"risky → size 减半"未实现

- 当前 risky 走和 fillable 一样的下一步路径，没有 size 减半逻辑
- 系统设计文档说 risky 应该 size×0.5 但没人实现

### C.5 status_score 任一触发就 blocked

- 5 个硬约束（suspended / ST / limit_up / limit_down / T+1）任一 → block_reasons 加一条 → status_score=0 → composite ≤ 80 但仍可能 ≥ 70 fillable
- ⚠️ **逻辑 bug**：blocked_reasons 非空时应直接 decision='blocked'，但 `block_reasons + composite ≥ 70` 双满足时实际给出 'fillable'？需要 trace 验证

### C.6 Almgren-Chriss v2 已有但未默认

- `use_almgren_chriss=true` 才走 (line 134 `ExecutionFeasibilityOptions`)
- 生产默认 v1（high_low proxy 体积一致）

---

## D. 改造方案

### D.1 user story

| ID | 故事 | 验收 |
|---|---|---|
| US-EF-1 | **修 blocked vs composite 互锁 bug**：`block_reasons.length > 0 → decision='blocked'` 强制，不看 composite | 单测：构造 ST + composite=80 → decision='blocked' |
| US-EF-2 | **risky size 减半实现**：caller (PaperTradingAutomationService) 收到 `decision='risky'` 时 `target_qty *= 0.5`；写 audit "feasibility_risky_downsize" | 单测：risky → quantity 减半 |
| US-EF-3 | **bid/ask 真实占比 metric**：Prometheus `feasibility_bid_ask_source{type=real|proxy}` counter；面板看占比 | metric /metrics 可查 |
| US-EF-4 | **新股 / 次新股识别**：上市 ≤ 90 日的股标记 `is_new_stock=true`；feasibility 加权降 spread_score（新股 spread 大但不该 block） | 上市 30 天股 spread=3% 仍可 fillable |
| US-EF-5 | **ETF 特殊处理**：ETF (代码 5xxxxx / 1599xx) limit 10% 主板规则，但流动性可能很差 → volume_coverage 用 5d AUM 而非 5d volume | ETF 510300 spread proxy 正确 |
| US-EF-6 | **AH 股识别**：港股通双柜台股 `is_ah_share=true`；feasibility 跳过 limit_proximity（H 股影响 A 股大跳空，硬涨跌停 fillable 评分不准） | AH 股 evaluate 跳过 limit_proximity |
| US-EF-7 | **集合竞价段 feasibility**：09:15-09:25 / 14:57-15:00 时段调用时 spread_score 用集合委托量代理，不用 bid/ask | 集合段 feasibility ≠ 0 |
| US-EF-8 | **持久化采样**：`persist=true` 时随机采样 1% 写表（per call too noisy），dashboard 报"过去 7 天 blocked 比例 + 主要原因" | 表行数控制在 1% 内 |

### D.2 与 ExecutionPolicyRouter 关系

- Feasibility 答"能不能成交"（fillable / risky / blocked）
- Router 答"该怎么成交"（LIMIT / TWAP / VWAP / POV / SKIP）
- 顺序：feasibility 先 → blocked 直接 SKIP；fillable/risky 进 router；router 内自己再判一次 SKIP（vol/spread/limit）

---

## E. 验收口径

- composite 公式单测覆盖 4 子分量 × 边界
- block_reasons + composite 互锁修复
- risky size 减半生效
- bid/ask 真实占比 metric ≥ 70%
- 新股 / ETF / AH 股特殊处理 case 通过
- 文件位置：`backend/src/services/execution/ExecutionFeasibilityService.ts`
