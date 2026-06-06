# Factor 基础设施 (US-009)

`backend/src/quant/factors/` 是 A 股多因子打分体系的基础设施层。US-009
落地了**注册中心 + 横截面 pipeline + 标准化工具 + FactorScore 模型**，
US-010+ 在 `library/` 下添加具体因子实现。

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
    └── <NameFactor>.ts     ← 一个文件 = 一个因子（US-010+ 添加）
```

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
