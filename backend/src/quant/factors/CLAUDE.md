# Factor 基础设施 (US-009 + US-010 + US-029 + US-030 + US-031 + US-032 + US-033 + US-034 + US-035 + US-036 + US-041 + US-042)

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
代理）；US-035 增加了第 15 个 `shareholder_concentration` 因子（股东户数
环比变化 = -(latest - prev) / prev，集中度变化）；US-036 增加了第 16 个
`gradual_breakout` 因子（渐进强爆 = 近 30 日 Σ(daily_volume / avg_60d_volume - 1) ×
sign(涨跌幅)，温和放量逐步走强的价量配合累计）。后续 story 在 `library/`
下追加新文件即可，无需改 Pipeline / Registry。

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

## US-010 落地的 8 个基础因子 + US-029 LiquidityFactor + US-030 AnalystConsensusFactor + US-031 QualityHighFactor + US-032 EarningsSurpriseFactor + US-033 MomentumReversalFactor + US-034 EastMoneyQAFactor + US-035 ShareholderConcentrationFactor + US-036 GradualBreakoutFactor (参考实现)

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
| `shareholder_concentration` | flow | ShareholderCount (US-035) | 200 日窗口内有效快照 < 2 / 最新一期 share_change != 0 (默认过滤) / holder_count_prev ≤ 0 |
| `gradual_breakout` | momentum | DailyBar (close + volume) | bars < VOLUME_BASELINE_DAYS+1=61 / 60 日均量有效观测 < 30 / 近 30 日内有效贡献天 < 21 |

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
- ✅ `shareholder_concentration` (US-035) 用 **-(holder_count[latest] - holder_count[prev]) / holder_count[prev]**
  捕捉筹码集中度环比变化。**取负**：holder_count 下降（集中）→ 正分（机构 / 大户吸筹的
  buy signal）；上升（分散）→ 负分（散户接盘加剧的 sell signal）。**新 guard 模式 —
  "data-condition-based exclusion"**：默认 `EXCLUDE_SHARE_CHANGE_PERIODS=true` 时，
  最新一期 share_change != 0（送转股 / 增发）→ 整只股票跳过 — 因为股本变动后 holder_count
  自然增加，环比 % 无业务意义。**这是首个"按业务条件而非数据卫生过滤"的因子**：以往的
  null/NaN/边界值过滤是"数据本身不能用"，本 guard 是"数据能算但语义被破坏"。下次有
  类似场景（如送转后股价基准重置、停牌前后 close 比较、分红前后 PE 比较）可复用此 pattern。
  **失效条件 (4 个 guard 协同)**: (i) MIN_OBSERVATIONS_TOTAL=2（季度低频数据，2 期已是
  最低环比要求 — 与之前因子 5-10 期阈值差异显著，因数据本身只 ~4 期/年）; (ii) holder_count
  ≤ 0 / null/NaN 全部剔除（数据卫生）; (iii) holder_count_prev > 0 paranoid check 防分母
  爆炸; (iv) lookahead bias guard `report_date > as_of_date` 剔除（US-030 范式）。
  **LOOKBACK_DAYS=200 自然日的设计权衡**: 覆盖 2 个季度披露周期 + 公告滞后 30 天 +
  春节/十一假期；上限 200 防止把 12 个月前的快照当 "prev" 失去时效性。**纯函数 helper**
  (computeConcentrationChange + ShareholderObservation/ConcentrationBreakdown interface 全
  export) 让 84 个测试覆盖 share_change 5 边角 + 业务方向 + lookahead guard + 多期排序 +
  端到端机构吸筹/散户接盘场景的同时完全脱离 DB。属"绝对业务量"因子（per-stock 自身
  新旧 holder_count 之比），走标准模式 — 不属 LiquidityFactor 横截面参照例外。**与既有
  因子的相关性预估**：与 money_flow (US-010, 主力净流入) ~0.3-0.4（都反映"机构吸筹"，
  但 money_flow 高频日级 / 本因子低频季度级，可同时启用）；与 northbound (US-010,
  北向持股) ~0.1-0.2（境内 vs 境外机构行为，维度不同）。FactorIC (US-041) 上线后可验证。
- ✅ `gradual_breakout` (US-036) 用 **Σ_{近 30 个有效交易日} (daily_volume / avg_60d_volume - 1) × sign(close[T]-close[T-1])**
  累计因子捕捉"温和放量逐步走强"的价量配合 alpha。**业务方向 4 象限**：(1) 价涨 + 量增
  → 正贡献（渐进建仓信号）；(2) 价涨 + 量减 → 负贡献（量价背离，警惕拉高出货）；
  (3) 价跌 + 量减 → 正贡献（缩量调整不杀伤，主力惜筹）；(4) 价跌 + 量增 → 负贡献
  （恐慌出货）；(0) 平盘 → 0 贡献。**与既有 momentum / momentum_reversal 因子的关键
  区别**：momentum (US-010) / momentum_reversal (US-033) 是纯价格因子，本因子是
  **价 + 量配合**累计因子 — 同样的"涨"在"放量涨" vs "缩量涨" 给出截然不同的得分，
  捕捉的 alpha 维度完全不同（量价背离 vs 量价配合）；与 liquidity (US-029) 也不同：
  liquidity 是 U 形评分不关心价格方向，本因子要 vol/baseline × sign(close)，价量必须
  同向才正。三个因子相关性预计 < 0.5（非冗余），FactorIC (US-041) 上线后可验证。
  **`change_pct` 从 close[T]/close[T-1]-1 自算，不直接读 DailyBar.change_percent 列**：
  change_percent 是 nullable 列缺失率较高；本因子已经必须读 close 算累计的 ratio，
  额外 sign 在内存计算开销 0；同时避开 "change_percent 数据流入 DB 是 % 还是小数" 的
  歧义。**纯函数 helper** (extractSortedBars / computeChangeSigns / compute60dAvgVolumes
  / computeGradualBreakoutScore 全 export 含 BreakdownInterface) 让 105 个测试覆盖
  4 业务象限 + 数据卫生 + 滑动 baseline 算法精确性 + tail-index 对齐的同时完全脱离 DB。
  **failure modes (3 个 guard 协同)**: (i) bars < VOLUME_BASELINE_DAYS+1=61 → 跳过
  （次新股，无足够基线）; (ii) 60 日均量有效观测 < MIN_VOLUME_BASELINE_OBS=30 → baseline
  null（交易不活跃）; (iii) 近 30 日内 effective 贡献天 < MIN_RECENT_DAYS_FOR_VALID=21
  (= 30 × 70%) → null（停牌过多累计无业务意义）。属"绝对业务量"因子（per-stock 自身
  价量配合累计），走标准模式 — 不属 LiquidityFactor 横截面参照例外。tail-index 对齐
  （recent = bars[length-recentDays..length-1]）与 momentum / low_vol / momentum_reversal
  同款，自然消化春节/十一节假日 gap，不按日历日对齐。

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

## 因子诊断工具 (US-041 FactorICReport)

US-041 在 `quant/factors/` 引入了第一个**诊断工具**（不是新因子）：`FactorICReport`
负责计算每个因子的 IC、IC_IR、IC 衰减；落库到 `factor_ic_results` 表供
策略开发者判断"哪个因子真有 alpha / 哪个该淘汰"。

### 公共 API

```ts
import { factorICReport, FactorICReport, DEFAULT_LOOK_FORWARD_DAYS,
  rankAscending, spearmanCorrelation, aggregateICSeries
} from '../quant/factors';

// 主流程
const out = await factorICReport.generate({
  factor_name: 'value',
  start_date: '2024-01-01',
  end_date: '2026-06-05',
  look_forward_days_list: [1, 5, 10, 20, 60], // 默认即 AC 指定
});
// → { results_by_window: [{ look_forward_days, statistics: ICStatistics, ... }, ...] }

// admin
await factorICReport.getResults({ factor_name: 'value' });
await factorICReport.cleanupOlderThan(30);
```

### 关键设计判据

1. **Spearman 而非 Pearson**：AC 明确要求；抗异常值（小盘股单日 forward return
   +100% 让 Pearson 失真）；rank-based 相关天然无量纲。
2. **MIN_CROSS_SECTION_SIZE = 30**：单日横截面 < 30 只股票时整日 IC = null 不进
   入聚合，因 < 30 的横截面 IC 统计意义弱（噪音大）。**与 US-040
   `sample_count < 5 → sharpe=null` 同款思路** — 数据不足直接为 null 让下游
   automatic 跳过，不要写 0 或 placeholder。
3. **4-tuple PK `(factor_name, look_forward_days, period_start, period_end)`**：
   ops 重跑同 (因子, 窗口, 区间) 直接 idempotent upsert 覆盖最新统计而非堆 N 行；
   AC 提的 `computed_at` 是 "什么时候跑的" 信息，不该作为唯一性键。
4. **不复用 OptimizationRun 父表** — IC 报告是 "对已有 FactorScore 做事后分析"，
   不是优化任务，与 US-040 RegimeSegmentedBacktest 同款判据。直接 4-tuple PK
   独立写本表。
5. **per-day 串行 await**（同 US-040 cache-friendly 模式）：DailyBar 有 stock_id
   索引单查询 < 50ms；并发收益小，串行让日志可读、单日失败不影响后续。
6. **DataSource 接口注入**（与 GridSearchOptimizer.BacktestRunner /
   RegimeSegmentedBacktest.RegimeSource 同模式）：生产环境走
   `DefaultFactorICDataSource` 读 FactorScore + DailyBar + Stock；测试注入
   fake 完全脱离 DB / 网络。
7. **factor_name 校验仅在未注入 DataSource 时执行**（同 GridSearch/Bayesian/
   WalkForward 测试 fake mode 跳过 registry 的模式）。
8. **lookahead bias guard**：base_date + lookForwardDays 落在 end_date 之外 →
   该日跳过。factor_scores 必须严格早于 future_close 的 trade_date —— 这与
   `analyst_consensus` (US-030) 因子内部 `row_date > as_of_date` skip 是同款
   时序窗口防 lookahead 范式，**所有事后分析工具都要有此 guard**。
9. **`Number(null) === 0` 陷阱**（同 US-031）：DataSource 实现读 Sequelize raw
   DECIMAL 列时务必先 `Number.isFinite()` check 再 push 入数组，否则 NaN 值会
   破坏 Spearman 计算。

### 因子失效判定阈值

策略开发者用 IC report 判断因子是否要剔除：

- **IC mean < 0.02** 持续多次 → 因子失效，从 MultiFactorAlpha 权重剔除
- **IC_IR < 0.3** → 因子不稳定，单独跑 backtest 验证后再上线
- **跨多次 period 持续衰减**（lookForward 5d → 60d 衰减 > 70%）→ 信号过于
  短期化，不适合中长线策略

### 何时扩展

- **新 lookForward 窗口**（如 120d / 240d）：传入 `look_forward_days_list`
  即可，无需改 DataSource。
- **加新指标**（如 IC_t-stat / IC_significant_p_value）：在
  `ICStatistics` 接口和 `aggregateICSeries` 加字段；DB 列同步扩展。
- **分组 IC**（如 行业内 IC / 市值分桶 IC）：新建 `FactorICReportV2` 类
  vs 加 `group_by` 入参；前者更清晰，后者偶然耦合度高。

### 测试模式

- **纯函数（`rankAscending` / `spearmanCorrelation` / `mean` / `sampleStddev` /
  `aggregateICSeries`）必须 export**，单测可独立调用，断言 NaN / 边界 / 已知值
  / tie 处理（同 US-029+ 复杂因子 helper 全 export 模式）。
- **end-to-end `generate()` 测试通过 fake DataSource 完全脱离 DB**：构造
  `{ trade_dates, cross_sections, forward_returns }` 配置 + 注入
  `data_source` 选项 + `persist: false` 跳过 DB upsert。`backend/tests/factors/
  factor-ic-report.test.ts` 是参考实现（118 个测试 / 全部脱离 DB）。
- **构造横截面 ≥ MIN_CROSS_SECTION_SIZE (30)** 的 helper：
  `makeCorrelatedCrossSection(35)` / `makeAnticorrelatedCrossSection(35)` 让
  IC 严格 ±1（line-test 业务方向）；`makeSmallCrossSection(5)` 用来测 < MIN
  的 reject 路径。

## 因子相关性矩阵 (US-042 FactorCorrelationReport)

US-042 在 `quant/factors/` 引入了第 2 个**诊断工具**：`FactorCorrelationReport`
负责计算因子两两 Spearman 相关性矩阵 + 共线性诊断，落库到
`factor_correlation_results` 表，**|corr| > 0.7** 的对自动标记 `is_redundant=true`
并可选写入 RiskAlert。

### 公共 API

```ts
import { factorCorrelationReport, FactorCorrelationReport,
  REDUNDANCY_THRESHOLD, MIN_PAIR_SIZE,
  dedupPairsToUpperTriangle, computeDailyCorrelation, aggregateCorrelationSeries
} from '../quant/factors';

// 主流程
const out = await factorCorrelationReport.generate({
  factor_names: ['value', 'quality', 'momentum'],
  start_date: '2024-01-01',
  end_date: '2026-06-05',
}, {
  alert_user_ids: [adminUserId1, adminUserId2], // 可选 → redundant pair 发告警
});
// → { pair_results: [{ factor_a, factor_b, statistics, is_redundant, ... }, ...] }

// admin
await factorCorrelationReport.getResults({ is_redundant: true });
await factorCorrelationReport.getResults({ factor_name: 'value' }); // 匹配 a 或 b
await factorCorrelationReport.cleanupOlderThan(30);
```

### 与 US-041 FactorICReport 的关系

| 维度 | FactorICReport (US-041) | FactorCorrelationReport (US-042) |
|---|---|---|
| 分析对象 | factor.z_score vs forward return | factor_a.z_score vs factor_b.z_score |
| 时序窗口 | 多个 lookForwardDays（衰减分析） | 同一交易日横截面（无 lookahead 概念） |
| 输入 | 1 个 factor_name | ≥ 2 个 factor_names（对称矩阵上三角） |
| 阈值/告警 | IC mean < 0.02 → 失效（人工判定） | \|corr\| > 0.7 → 自动 is_redundant=true + RiskAlert |
| 单位写入 | 1 行 / (factor, lookForward, period) | 1 行 / (factor_a, factor_b, period) 上三角 |
| **共用基础设施** | rankAscending / spearmanCorrelation / mean / sampleStddev 全部从 FactorICReport export | ← FactorCorrelationReport import 复用 |

### 关键设计判据

1. **上三角去重**：`(a, b)` 与 `(b, a)` 完全对称，本表只存 `factor_a < factor_b`
   字典序的一半（C(N, 2) 行而非 N²）。下游查 b vs a 时反向 lookup 同一行。
   `dedupPairsToUpperTriangle(factor_names)` 是单独 export 的纯函数，保证
   顺序稳定 + 去重。
2. **MIN_PAIR_SIZE = 30**：与 US-041 MIN_CROSS_SECTION_SIZE 同款阈值；双因子
   横截面交集 < 30 整日 corr=null 不进聚合。同一份"横截面统计要有意义"判据。
3. **REDUNDANCY_THRESHOLD = 0.7**（AC 指定）：**用绝对值** —— 强负相关也算共线
   （一个是另一个的反向版本，组合优化里一加一减相当于没加）。
4. **无 lookahead bias guard**：与 IC 不同，相关性不涉及 forward return，
   只在同一交易日的横截面计算 —— `factor_score[T] vs factor_score[T]` 无未来信息。
5. **不复用 OptimizationRun 父表**（与 US-040 / US-041 同款判据）：相关性矩阵
   是"对已有 FactorScore 做事后分析"，不是优化任务。
6. **DataSource 接口注入**（同 US-041）：只需 2 个 loader
   （`loadTradeDatesInRange` + `loadFactorCrossSection` — 后者直接复用 US-041
   的 cross-section 加载语义）；测试 fake 完全脱离 DB。
7. **per-pair 串行 await**（同 US-041 模式）：N 因子 → C(N, 2) pair，每对内部
   再 per-day 串行；总调用次数 = pairs × days × 2（loadFactorCrossSection），
   上游 DB cache 可命中相同 (factor, date) 组合。
8. **共用 US-041 spearmanCorrelation / rankAscending / mean / sampleStddev**：
   避免代码复制；通过 `quant/factors/FactorICReport.ts` 的 export 直接 import。
   **跨模块复用判据**：US-041 和 US-042 都是事后分析（同一模块目录、相同语义
   层），spearman 等纯函数从 US-041 拿即可。不要再复制到 US-042。
9. **`Number(null) === 0` 陷阱防御**（同 US-031/US-041）：DataSource 读 Sequelize
   raw DECIMAL 列时先 `Number.isFinite()` check。
10. **告警 schema 借用 RiskAlert 现有字段**：`symbol='SYSTEM:FACTOR_CORR'`
    (系统级告警 sentinel)；`name=`${factor_a} vs ${factor_b}``；`level='HIGH'`；
    `message` 中文含 correlation 值 + 区间。前端 UI 按 `symbol` prefix
    过滤区分股票告警 vs 系统告警。

### 失效阈值约定（与因子失效判定阈值并列）

策略开发者用 correlation report 判断"哪两个因子需要二选一"：

- **|corr| > 0.7**：高度共线 → 必须移除其一（自动 is_redundant=true）
- **|corr| ∈ [0.5, 0.7]**：注意，可同时使用但权重要倾向 IC_IR 更高的那个
- **|corr| < 0.5**：因子独立性好，可同时进入多因子模型

### 何时扩展

- **行业内 / 市值分桶相关性**：新建 `FactorCorrelationReportV2` 类，加 `group_by` 入参
  会让单表 schema 膨胀（多一维 group_key 复合主键）。
- **新阈值（如 |corr| > 0.5 提示）**：传入 `redundancy_threshold: 0.5` 选项即可。
- **告警目标扩展（非 user_id，而是 Slack 或 webhook）**：在 RiskAlert 之外加
  独立 `factor_correlation_webhook_dispatch.ts`，不污染本模块；本模块只负责
  "标 is_redundant + 写 user-scoped RiskAlert"。

### 测试模式

- **3 个纯函数 export**：`dedupPairsToUpperTriangle` / `computeDailyCorrelation`
  / `aggregateCorrelationSeries` 全部 export，单测可独立调用（132 用例覆盖
  对称性 / 双有效过滤 / NaN/Inf 防御 / tie-break / 跨因子方向 / 自定义
  minPairSize）。
- **end-to-end `generate()` 通过 fake DataSource 完全脱离 DB**：构造
  `{ trade_dates, cross_sections }` 配置 + `data_source: new FakeFactorCorrelationDataSource(cfg)`
  + `persist: false`。`backend/tests/factors/factor-correlation-report.test.ts`
  是参考实现。
- **`makeLinearCrossSection(35, 1)` + `makeLinearCrossSection(35, -1)`** 构造
  完美 ±1 相关的因子对，`makeQuasiRandomCrossSection(35)` 构造 |corr| < 0.7
  的独立因子对——前者验 is_redundant=true 路径，后者验 false 路径。
