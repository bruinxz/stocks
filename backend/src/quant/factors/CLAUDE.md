# Factor 基础设施 (US-009 + US-010 + US-029 + US-030 + US-031 + US-032 + US-033 + US-034)

`backend/src/quant/factors/` 是 A 股多因子打分体系的基础设施层。US-009
落地了**注册中心 + 横截面 pipeline + 标准化工具 + FactorScore 模型**；
US-010 在 `library/` 下注册了 **8 个基础因子**（`value` / `quality` / `growth` /
`momentum` / `low_vol` / `northbound` / `money_flow` / `dragon_tiger`）；
US-029 增加了第 9 个 `liquidity` 因子（流动性 U 形评分）；US-030 增加了
第 10 个 `analyst_consensus` 因子（分析师 EPS 一致预期上修方向）；US-031
增加了第 11 个 `quality_high` 因子（高阶质量 = ROIC 代理 + 毛利率稳定性 +
净利率代理 等权合成）；US-032 增加了第 12 个 `earnings_surprise` 因子（盈利
惊喜代理 = (actual EPS - 一致预期 EPS) / |一致预期 EPS|）；US-033 增加了
第 13 个 `momentum_reversal` 因子（动量反转 = 120 日动量 - 5 日动量，正值
代表趋势延续、负值代表短期超涨反转）；US-034 增加了第 14 个 `east_money_qa`
因子（东财问答热度 = 近 5 日 / 近 30 日 post_count 比率，散户关注度变化
代理）。后续 story 在 `library/` 下追加新文件即可，无需改 Pipeline / Registry。

## 目录约定

```
backend/src/quant/factors/
├── types.ts                ← Factor / FactorContext / FactorComputeOutput
├── FactorRegistry.ts       ← 全局单例 factorRegistry + class FactorRegistry
├── FactorPipeline.ts       ← FactorPipeline.runForDate(date, factorNames[])
├── normalization.ts        ← winsorize / zscore / percentileRanks（横截面）
├── index.ts                ← 模块出口（re-export 上面 4 个）
└── library/
    ├── index.ts            ← import-time 把每个因子文件 import 进来（自我登记）
    ├── _helpers.ts         ← library 内部共享 helper（前缀 `_` = "仅 library 用"）
    │                        提供 stripSuffix / inferStockSymbol / loadStocksByCodes /
    │                        isFiniteNumber / lookbackStartDate
    └── <NameFactor>.ts     ← 一个文件 = 一个因子（US-010+ 添加）
```

**`_helpers.ts` 是 library 内部约定**——前缀 `_` 表示它不应被 library 之外
的代码 import；因子基础设施的对外契约只通过 `quant/factors/index.ts` 暴露。
新增因子要复用 `loadStocksByCodes(codes, attrs)` / `stripSuffix(symbol)` /
`lookbackStartDate(asOf, days)`，不要 inline 同样的 5 行。

## 添加新因子的步骤（US-010+）

1. 在 `library/` 新建 `<NameFactor>.ts`：

   ```ts
   import { Factor } from '../types';
   import { factorRegistry } from '../FactorRegistry';
   import { StockValuationFactor } from '../../../models/StockValuationFactor';

   export const valueFactor: Factor = {
     name: 'value',
     description: 'PE-TTM 倒数 + PB 倒数 合成的价值因子',
     category: 'value',
     async compute(ctx) {
       const rows = await StockValuationFactor.findAll({
         where: { symbol: ctx.universe, factor_date: ctx.as_of_date },
         raw: true,
       });
       const map = new Map<string, number>();
       for (const r of rows as any[]) {
         const pe = Number(r.pe_ttm), pb = Number(r.pb);
         if (!Number.isFinite(pe) || !Number.isFinite(pb) || pe <= 0 || pb <= 0) continue;
         map.set(stripSuffix(r.symbol), 1 / pe + 1 / pb);
       }
       return map;
     },
   };

   factorRegistry.register(valueFactor);

   function stripSuffix(s: string): string { return s.split('.')[0]; }
   ```

2. 在 `library/index.ts` 加一行 `import './ValueFactor';` —— 不要 re-export，
   FactorRegistry 是单一事实源。

3. 跑 `npm run compute:factors -- --date=2026-06-05 --factors=value` 验证。

## 关键设计约束

### 1. 因子只输出**未标准化**的 raw_value

因子内部**不要**自己做 winsorize / z-score / 归一化。`FactorPipeline` 会统一做，
否则跨因子 z_score 不可比，多因子加权也失去意义。

**例外（US-029 LiquidityFactor 引入）**：当因子的经济意义**本身**就要求一个
横截面参照点（U 形评分、距均值偏离、横截面贴现等），可以在 compute() 内做
*单点参照* 的简单变换，但仍**不要**做 winsorize / zscore（Pipeline 后续会做）。
判据：参照统计量是因子语义的一部分（无法外推到调用方），就属此例外；只是
"想让分布更好看"则属普通归一化，禁止内置。LiquidityFactor 的 `-|(turn - P30)/sd|`
变换满足前者（"过低过高都减分"的语义没有 P30/sd 表达不出）。后续 US-031 /
US-033 等"贴现 / 偏离"类因子按此例外处理；普通线性因子仍走标准模式。

### 2. 因子返回稀疏 Map 即可

缺数据的股票不需要出现在返回 Map 中——Pipeline 会自动补 "中性行"
（raw_value = null, z_score = 0, percentile = 0.5）。这样既保留行用于审计
"因子覆盖了哪些股票"，又不污染横截面统计量。

### 3. 因子的 stock_code 必须**无市场前缀**

`FactorScore.stock_code` 与 `NorthboundHolding / LimitUpStock / IndustryFlow`
保持一致 —— `"600519"` / `"000001"`，不含 `.SH` / `.SZ` 后缀。从 `Stock`
表查到的 `symbol` 是 `"600519.SH"` 形式，需要 `split('.')[0]` 截掉。

### 4. FactorPipeline 串行调度因子

按 (date, factor) 串行而不是 Promise.all 并行：
- 因子间无依赖，并行的收益主要在 DB IO；当前 DB 通常不是瓶颈。
- 串行让日志可读、单因子失败不影响别的、调试更容易。

### 5. FactorRegistry 不允许同名重复注册

要演化因子语义，请改名（`value` → `value_v2`），不要静默覆盖。

### 6. FactorScore 行数 = universe × factors（含中性补全）

哪怕因子覆盖率只有 30%，写入的行数仍是 100% universe × 因子数。这样：
- 查询 `WHERE trade_date=? AND stock_code=?` 拿到该股票全部因子（即使是 null）
- 多因子合成无需 LEFT JOIN，每个 (date, stock, factor) 都有行可读

## 测试模式

- 单元测试因子时，构造一个 mock 的 `FactorContext`（universe + as_of_date），
  直接调 `factor.compute(ctx)`，断言返回的 Map 内容；**不**要走 Pipeline。
- 测试 Pipeline 时，构造一个 mock Factor（实现 `Factor` 接口的 plain object），
  通过 `new FactorRegistry()`（注意：构造 FactorRegistry 实例而不是用单例）
  注册，再传 `new FactorPipeline(registry)` 调 `runForDate`。
- 测试 winsorize / zscore / percentileRanks 直接调 `normalization.ts`，不需 DB。
- **因子测试统一放 `backend/tests/factors/<NameFactor>.test.ts`**（US-029 新建目录，
  与 `backend/tests/strategies/` / `backend/tests/backtest/` 同款约定）。跑法：
  `cd backend && npx ts-node --transpile-only tests/factors/<Name>Factor.test.ts`。
  目录在 tsconfig `include` (`src/**/*`) 之外，typecheck 不扫；测试只断言纯函数 +
  Map metadata + 空 universe 路径，**不**走 DB / 不 mock Sequelize（成本/复杂度
  与因子简单语义不匹配）。需要端到端走 DB 的，写到 `backend/scripts/` 当作冒烟脚本。

## US-010 一定会踩的坑

- **Stock.symbol 是 `"600519.SH"`，FactorScore.stock_code 是 `"600519"`**——
  因子内部查 Stock / DailyBar 等表后必须 `stripSuffix`。
- **`StockValuationFactor` / `StockFundamentalFactor` / `StockMoneyFlowFactor`**
  是历史项目里既有的因子模型表，其中 `symbol` 字段是带后缀的形式。读这些
  表时需要先 strip。
- **NorthboundHolding / DragonTigerBoard / LimitUpStock / IndustryFlow**
  的 `stock_code` 已经是无后缀形式（与 FactorScore.stock_code 直接 join）。
- **缺数据 ≠ 因子失效**：缺数据返回稀疏 Map；因子失效（例如 PE<=0）应该
  `continue` 不写入这只股票，让 Pipeline 把它当作中性。

## US-010 落地的 8 个基础因子 + US-029 LiquidityFactor + US-030 AnalystConsensusFactor + US-031 QualityHighFactor + US-032 EarningsSurpriseFactor + US-033 MomentumReversalFactor + US-034 EastMoneyQAFactor (参考实现)

| 因子 name | 类别 | 数据源 | 失效条件 |
|---|---|---|---|
| `value` | value | StockValuationFactor | PE-TTM ≤ 0 / PB ≤ 0 / 任一缺 |
| `quality` | quality | StockFundamentalFactor | ROE 观测 < 2 个 |
| `growth` | growth | StockFundamentalFactor | net_profit_growth 与 revenue_growth 都缺 |
| `momentum` | momentum | DailyBar (经 Stock.id 解析) | bars < 121 |
| `low_vol` | volatility | DailyBar (同上) | bars < 121 或 stddev = 0 |
| `northbound` | flow | NorthboundHolding | 当日无数据，或窗口内仅 1 条 |
| `money_flow` | flow | StockMoneyFlowFactor + Stock | 窗口内无累计、或 circulating_market_cap ≤ 0 |
| `dragon_tiger` | flow | DragonTigerBoard | 窗口内无 famous_yz 且 net_amount > 0 的行 |
| `liquidity` | liquidity | DailyBar.turnover_rate | 单只股票有效 turnover_rate < 10 个 / 全市场样本 < 2 |
| `analyst_consensus` | sentiment | AnalystForecast (US-030) | 90 日窗口内有效研报 < 5 / 任一年度 recent\|baseline 空 / baseline avg ≈ 0 |
| `quality_high` | quality | FinancialReport(年报)+StockFundamentalFactor.gross_margin | 任一子分量缺失：年报缺 / gross_margin 观测 < 5 / revenue ≤ 0 |
| `earnings_surprise` | event | FinancialReport + AnalystForecast (US-030) + StockFundamentalFactor.eps | 最近财报 > 180 自然日 / 财报前研报 < 3 / 缺 actual eps / `|consensus|` < 0.01 元/股 |
| `momentum_reversal` | momentum | DailyBar (与 momentum / low_vol 同表) | bars < LONG_MOMENTUM_WINDOW+1=121 / close ≤ 0 (T / T-5 / T-120 任一) |
| `east_money_qa` | sentiment | StockSentiment (US-034) | 30 日窗口内有效 post_count < 10 / recent\|baseline 空 / baseline avg < 1.0 |

**典型查询模式（US-029+ 添加新因子可直接复制）**：

- "时序聚合" 类（quality / growth）：拉 `factor_date ∈ [as_of - N天, as_of]`
  全集 → 按 symbol 分组 in-memory 聚合 → stripSuffix 输出
- "时序 + 截面" 类（momentum / low_vol）：先 `loadStocksByCodes(universe)`
  拿 `Stock.id`，再用 `Op.in: stock_ids` + time range 拉 DailyBar；按
  `stock_id` 分组 + `arr.sort((a,b)=>a.time-b.time)` 后从尾部计数对齐
- "纯无后缀表" 类（northbound / dragon_tiger）：直接 `Op.in: ctx.universe`
  + trade_date 窗口；stock_code 字段就是输出 key，**不需要走 Stock 表**

**横截面 z-score 友好的 raw_value 形态**（重要！）：

- ✅ `dragon_tiger` 用 "天数" 而非 "笔数"：龙虎榜笛卡尔展开下 "笔数" 噪音
  巨大，"独立日数 ∈ [0, 20]" 是更稳健的连续量。
- ✅ `dragon_tiger` 不在 Map 里写 0（让 Pipeline 中性补全为 percentile=0.5）：
  "未上榜" 与 "上榜但被卖" 语义不同；强行写 0 会让大量股票挤在 raw=0，
  把横截面均值拖向 0、zscore 分布失真。
- ✅ `low_vol` 取 `-stddev` 而不是 `1/stddev`：避免分母趋零放大噪音；
  zscore 后高分仍代表低波动股。
- ✅ `value` 用 `1/PE + 1/PB` 而非 `-PE - PB`：分母倒数无量纲、自然加权
  (二者都在 0..1 区间)；直接相加避免一只股票 PE=100 完全淹没 PB。
- ✅ `momentum` 用 `close[T-20]/close[T-120] - 1` 比值差：避免对数收益的
  极端值；截尾后的 zscore 已经能让横截面稳定。
- ✅ `liquidity` (US-029) 用 **-|(avg_turnover_20 - P30) / sd|** U 形评分：捕捉
  "过低 = 僵尸 / 过高 = 拥挤"双侧惩罚；P30 + sd 是因子语义本体（参见上面
  "设计约束 #1 的例外"）。**纯数学 helper（quantileAtSortedAsc / sampleStddev /
  liquidityPenaltyScore / computeAvgTurnoverFromBars）抽成 `export function` 让
  单测可独立 ↑** —— 复杂因子按此模式拆分。
- ✅ `analyst_consensus` (US-030) 用 **per-year revision = (recent_avg - baseline_avg) / |baseline_avg|**
  然后跨年度算数均值：抓"卖方一致预期上修"的 alpha 信号。**按 `forecast_year_y1` 分组
  极其关键** —— AKShare 的 "{Y}-盈利预测-收益" 列名年份跨年滚动；不分组会拿
  "2024 末的 2025E EPS" 直接对比 "2025 末的 2026E EPS"，得无意义噪音。**baseline 接近 0
  时跳过该年度**（亏损股的微小 EPS 变化会让 revision 爆炸到百分之几千）。同样把
  纯函数 helper（mean / isoDateMinusDays / computeRevisionPerYear / aggregateRevisions）
  全部 `export`，单测可独立调用不走 DB。属"绝对业务量"因子（per-stock 自身新旧
  EPS 之比），走标准模式 — 不属 LiquidityFactor 横截面参照例外。
- ✅ `quality_high` (US-031) 用 **3 子分量等权合成**：ROIC 代理 (FinancialReport.roe 最新年报)
  + 毛利率 5 年稳定性 (1/sd, sd clamp 到 MIN_GROSS_MARGIN_SD=0.05% 防爆炸) + 净利率代理
  (net_profit/revenue × 100)。**任一子分量缺失 → 整体 null**（与 quality 缺 debt 仍能算
  ROE 的"宽容"策略不同 —— 3 维度异构，缺一项用 0 代入会让另两项被人为放大）。**纯函数
  helper（sampleStddev / computeGrossMarginStability / computeNetMargin / combineQualityHigh）
  全 export，单测独立调用不走 DB。属"绝对业务量"因子（per-stock 自身 3 个财务量），
  走标准模式。
- ✅ `earnings_surprise` (US-032) 用 **(actual_eps - consensus_eps_avg) / |consensus_eps_avg|**
  捕捉 PEAD (Post-Earnings Announcement Drift) alpha。**双重代理（按 US-031 范式）**：(1)
  AC 原始公式用 net_profit，但 AnalystForecast 不提供 net profit 预测且本仓库无 total_shares
  无法 EPS→net_profit 互转 — 用 EPS 维度双向比较替代 (forecast_eps_y1 ↔ StockFundamentalFactor.eps)；
  (2) AC 原始公式用 announce_date + 60 交易日窗口，但 FinancialReport 无 announce_date —
  用 `report_date + 180 自然日` 窗口替代（覆盖 announce delay 上限 ~90d + PEAD drift ~90d）。
  **关键约束**：consensus 构造时 forecast.report_date 必须 **严格小于** actual report_date
  （分析师在公司报告 *之前* 发研报才算 forecast，否则是事后 review）；forecast_year_y1
  必须 == year(actual report_date)（同年度才可比，US-030 同款跨年禁止约束）；|consensus|
  < 0.01 元/股（亏损股/微利股）跳过避免分母噪音爆炸。**纯函数 helper** (mean /
  isoDateMinusDays / isoDatePlusDays / yearOfIsoDate / computeSurprise / selectFreshestReport
  / buildConsensusEps) 全 export，单测独立调用不走 DB。属"绝对业务量"因子（per-stock
  自身 actual vs consensus 之比），走标准模式 — 不属 LiquidityFactor 横截面参照例外。
- ✅ `momentum_reversal` (US-033) 用 **mom_120 - mom_5** 长短动量差值：正值代表
  "中长期动量强、短期动量弱"= 趋势延续信号（长期稳健上涨 + 短期健康回调）；负值
  代表"短期动量强但中长期一般"= 反转 / 超涨信号（短期过热脉冲，未来均值回归概率高）。
  **与既有 momentum (US-010) 的关键区别**：momentum 用 `close[T-20] / close[T-120] - 1`
  是 Asness 风格 12-1 月动量（剔除短反转），输出**单一动量值**，正负只代表"涨/跌"；
  momentum_reversal 是**长短两段动量的差值**（两段都包含 close[T]，差值消去 close[T]
  方向，只保留"长 vs 短"对比），正负代表"延续 vs 反转"。两个因子相关性预计
  0.3-0.5（非冗余）；FactorIC (US-041) 上线后可监测，> 0.7 再考虑剔除。**纯函数
  helper** (computeWindowMomentum / combineMomentumReversal / extractSortedCloses) 全
  export，单测独立调用不走 DB（74 用例覆盖窗口大小 / 边界 close / NaN / 时间排序 /
  端到端"延续 vs 反转"三个真实场景）。**"任一窗口缺失 → 整体 null"**（与 quality_high
  同款判定：两段同维度 "涨幅 %"，但缺一段后 "0 代入" 让另一段被当作 spread 主体，
  因子语义崩坏）。属"绝对业务量"因子（per-stock 自身两段动量的差值），走标准模式 —
  不属 LiquidityFactor 横截面参照例外。**tail-index bar 对齐**（close[len-1] /
  close[len-1-window]）与 momentum / low_vol 同款，自然消化春节/十一节假日 gap，不
  按日历日对齐。
- ✅ `east_money_qa` (US-034) 用 **avg(post_count[recent 5d]) / avg(post_count[total 30d 内 baseline 25d])**
  捕捉散户关注度的近期变化方向。ratio > 1 = 关注度上升 (短期资金涌入信号)；ratio < 1 =
  关注度回落。**双重代理（按 US-031/US-032 范式）**：(1) AC 期望 post_count = 东方财富股吧
  每日发帖数 — AKShare 中 `stock_guba_em` **根本不存在**，guba 网页无公开 API；选 EastMoney
  人气榜 rank 倒数 **(round(100000 / rank))** 作为 post_count 代理（rank 是综合 click/post/
  favorite/search 后排名，与发帖数高度相关）。(2) AC 期望 stock_guba_em / stock_hot_rank_em
  — 前者不存在；后者只返回**当日 top 100**实时榜（无历史，无法建因子）。选 `stock_hot_rank_detail_em`
  提供 per-stock 365 日历史（rank + 粉丝占比）。代理已在 Python 端落库到 StockSentiment.post_count
  物化列，因子层读 column 不读源，**升级路径**: 若未来引入 XQ / TuShare Pro 真实发帖数，
  仅需 sync 阶段填入该列，因子无需改动。**纯函数 helper** (mean / isoDateMinusDays /
  computePostCountRatio + RatioBreakdown 结构) 全 export，单测独立调用不走 DB
  （76 用例 + 1 异步，覆盖边界 / null/NaN/string 数据卫生 / 超窗剔除 / lookahead bias guard
  / 5 个典型 ratio 数值场景）。属"绝对业务量"因子（per-stock 自身新旧 post_count 之比），
  走标准模式 — 不属 LiquidityFactor 横截面参照例外。**与既有因子的相关性预估**：与
  liquidity (换手率) ~0.3-0.5（非冗余 — 换手反映真实交易，本因子反映情绪关注，前者更
  早信号但易因机构盘磨蚀波动）；与 money_flow (主力净流入) ~0.1-0.2（主力是机构资金，
  与散户情绪不同维度）。FactorIC (US-041) 上线后可验证。

### 关键代理记号（US-031 引入 "AC 数学公式 ≠ 数据可得" 的处理范式）

当 AC 指定的公式所需字段在当前数据模型不可得（如 NOPAT / 投入资本 /
自由现金流 / 资本支出），**先用学术认可的代理替代 + 把代理标注在 description
与 jsdoc 顶部，不要默默改公式名**。判据：

1. **代理必须有学术 / 实证依据**：ROE 与 ROIC 在 A 股相关性 0.85+ (Fama-French
   类研究)；净利率与 FCF/Revenue 在稳态企业相关性 0.6+。不要瞎编代理。
2. **factor.name 保留 AC 命名**（如 `quality_high`），不要悄悄改成 `quality_proxy`
   或 `quality_high_v0` —— 既污染 FactorRegistry 命名空间，下游又要做映射。
3. **description 字段显式包含"代理"字样**（如 "ROIC 代理(ROE 最新年报)"），
   让前端 / 报告 / FactorIC 自动暴露代理事实。
4. **jsdoc 写清三件事**：(a) AC 原始公式 (b) 当前数据不可得的具体字段 (c) 选定的
   学术代理与系数 (d) 未来引入完整数据后的"升级路径"（如"US-034+ 引入现金流量表后
   可换 FCF/Revenue 真公式"）。
5. **TS factor 文件 + 本 CLAUDE.md 同时记录**，让下游策略接入新因子时一眼看到代理边界。

任何后续 story 遇到"AC 指定字段不可得"都按此范式处理；不要硬塞 placeholder
（如 `roic = 0`）或 NOPAT 用净利润替代（差异太大不算合理代理）。`quality_high`
的 jsdoc 顶部 70 行是参考实现。

## 添加新因子的 checklist (US-029+)

每加一个 `<NameFactor>.ts`，必做：

1. 文件尾部 `factorRegistry.register(factor)`；
2. 在 `library/index.ts` 按字母序追加 `import './<NameFactor>';`；
3. compute() 内部**不要**做 zscore / winsorize；
4. 复用 `_helpers.ts` 的 `stripSuffix` / `loadStocksByCodes` / `lookbackStartDate`；
5. 缺数据 → 不入 Map（让 Pipeline 补中性，避免污染横截面均值）；
6. 在本 CLAUDE.md "8 个基础因子" 表格追加一行（数据源 + 失效条件）；
7. 跑 `./node_modules/.bin/ts-node --transpile-only -e "import('./src/quant/factors/library').then(()=>import('./src/quant/factors/FactorRegistry').then(r=>console.log(r.factorRegistry.listNames())))"` 验证新因子出现。
