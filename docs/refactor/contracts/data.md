# 数据契约（contracts/data）

**版本**：v0（M0 骨架）
**Owner**：Orchestrator（吸收 DataPipeline 输入）
**上位规范**：`../adr/0001-layering-and-collab.md` §4
**冻结依赖**：Research 21 事实基线 + DataPipeline 数据源收敛方案

---

## 1. 时区 / 精度

- Asia/Shanghai；`available_at` 底层 UTC ISO8601，展示层转 SH
- 日线：`date`
- 分钟/tick：`ts: bigint (ms since epoch)`（v1.0 预留字段位，v1.1 入库）

---

## 2. 缺失值语义（禁 NaN 承载语义）

三态枚举：`SUSPENDED / NOT_LISTED / MISSING_DATA`

独立列（非语义槽）：
- `newly_listed_n: int` — 上市至今交易日数
- `resumed_today: bool` — 停牌复牌当日

---

## 3. 除权除息

- 主视图 = 前复权价
- 独立提供复权因子表（事件流 + 累计因子两视图并存）
- 每行携带 `adj_base_date`
- 基准日 = 每次 daily-update 快照的最新交易日
- rebase 规则：分红送股当日累计因子整段乘以新比例；历史序列快照分区不重写旧 `adj_base_date` 之前数据
- **回测入口默认取数方式 = 按窗口取对应 `adj_base_date` 分区**

---

## 4. 回测 / 因子读取接口默认签名

```
read(..., as_of_date: date | None = None)
```

- `as_of_date=None` → 最新交易日基准（生产）
- 指定 → 该 `as_of_date` 基准的前复权快照（滚动回测无回填无未来函数）
- 快照按 `adj_base_date` 分区存/取

---

## 5. PIT 三字段独立存储

- `report_date` / `publish_date` / `available_at` — 独立列
- **偏序不变式**：`report_date ≤ publish_date ≤ available_at`
- 三重保险：
  1. 存储层 CHECK 约束（DataPipeline）
  2. 契约级 assert（QADocs）
  3. Strategy 运行时 assert（QADocs 提供 helper）

---

## 6. 未来函数防护（三层护栏）

1. 静态 ESLint 自定义规则 / CI grep（QADocs 起草）
2. 运行时 `assert_pit_safe(df, t, timestamp_col='available_at')` — 默认强断言，关闭需 ADR
3. 契约漂移静态扫描：绕过 `as_of_date` 直读原始复权表拒合入

---

## 7. `daily_tradability` 派生视图

`(symbol, date)` join：

- `limit_up / limit_down / one_word_limit: bool`
- `tradable: bool`（最宽松综合位）
- 四向可动位：
  - `can_open_long`（非停牌 + 非一字涨停 + 流动性达标）
  - `can_open_short`（非停牌 + 非一字跌停 + 融券白名单）
  - `can_close_long`（非停牌 + 非一字跌停）
  - `can_close_short`（非停牌 + 非一字涨停）
- `suspend_reason: enum?`

A 股融券白名单 + T+1 规则语义边界由数据层写死，策略层不判断融券资格。

---

## 8. 六实体

1. **日线K线**
2. **复权因子**（事件流 + 累计因子）
3. **交易日历**（含半日市 flag）
4. **基本面 PIT**
5. **元信息**（symbol/name/list_date/delist_date/status/industry_code/exchange）
6. **行业/指数成分**（历史版本化）

v1.0 只锁日线；分钟/tick 到 v1.1，字段位在 v1.0 预留。

---

## 9. 数据源收敛（v1 冻结前留白）

**输入依赖**：
- Research `21-current-audit.md` 数据源全表
- DataPipeline `data-sources-consolidation.md`（EastMoney 家族→EastMoneyBase / Combined+MarketDataProvider+PythonMarketDataClient 门面唯一化 / AKShare 按实体拆读取 / 零调用无测试归 C 类）

**冻结路径**：Research 21 → DataPipeline 出方案 → Orchestrator 签字 → 本章 v1 落地。

**默认策略**：多源交叉校验。

---

## 10. Migrations 双路径

现状 `backend/scripts/migrations` + `backend/src/data/migrations` **本轮不动**；数据迁移方案里列统一建议，Phase 0 后执行。

---

## 11. QA 校验位（对齐 ADR-0001 §9）

1. `adj_base_date` 一致性回归测试
2. `daily_tradability` 视图完整性 + 组合真值表
3. PIT 三字段独立、非空、互不替代
4. 偏序不变式 `report_date ≤ publish_date ≤ available_at` 三保险
5. `as_of_date` 默认签名；绕过它拒合入
6. `available_at` 断言/lint 关闭需 ADR

---


---

## §3 E4 · fundamental_pit 表 3 字段扩展

### §3 E4.1 字段追加（PostgreSQL DDL 描述位）

**表**：`fundamental_pit`（PIT-aligned 财务数据表 · 已存在于 v1.0）

**v1.1 新增 3 列**：

```sql
ALTER TABLE fundamental_pit
  ADD COLUMN roa NUMERIC(12, 6) NULL,               -- 资产回报率 · net_income / total_assets
  ADD COLUMN data_source VARCHAR(20) NOT NULL       -- 数据源枚举 · v1 默认 'BAOSTOCK'
    DEFAULT 'BAOSTOCK'
    CHECK (data_source IN ('BAOSTOCK', 'TUSHARE_PRO', 'MERGED')),
  ADD COLUMN fallback_reason TEXT NULL;             -- BAOSTOCK 主 = NULL · MERGED 记合并规则版本
```

**索引位（可选 · v1.1 不强制）**：
```sql
CREATE INDEX idx_fundamental_pit_data_source
  ON fundamental_pit (data_source)
  WHERE data_source <> 'BAOSTOCK';  -- 部分索引 · 只索引非主链数据（未来 TUSHARE_PRO/MERGED 启用后加速筛选）
```

### §3 E4.2 3 值枚举 y/n 表 · 联动 v1 冻结状态

| `data_source` 值 | v1 允许写入 | v1 允许读出 | 触发条件 | 联动 ADR |
|-----------------|------------|------------|---------|---------|
| `BAOSTOCK` | ✅ y | ✅ y | 决策 2 = B · 免费主链 | ADR-0007 §1.1 |
| `TUSHARE_PRO` | ❌ n（空 slot） | ✅ y（历史数据回读位） | 未来 li-yiming 授权 · 走 §5.1 路径 A ADR | ADR-0007 §5 |
| `MERGED` | ❌ n（空 slot） | ✅ y（历史数据回读位） | 决策 2 → C 转正 · 走 §5.1 路径 B ADR | ADR-0007 §5 |

**语义解释**：
- **y = write allowed**：写侧 pipeline 允许生成此值（当前 v1 仅 BAOSTOCK 一值）
- **y = read allowed**：读侧永远兼容 3 值枚举（前向兼容锚 · 历史数据不 rewrite）
- **CHECK constraint 允许 3 值**：schema 侧允 3 值存在 · 但**写入路径 gate 只放 BAOSTOCK**（DataPipeline 侧应用层 gate）

### §3 E4.3 minor bump 兼容规则

- v1 → v1.x 加 enum value = **非破坏** · minor bump（e.g. v1.1 → v1.2）
- v1.x → v2 减 enum value = **破坏** · major bump（禁）
- 对齐 `10-contracts.md` §2 版本规则

### §3 E4.4 `roa` 字段计算规则

**事实层**（DataPipeline msg=be46f8bb 副签修正）：
- Baostock 官方 API **无 ROA 直接字段**（`q_ROA` 属 Tushare `fina_indicator` 命名 · 非 Baostock）
- Baostock 相关 API 返回字段：
  - `query_profit_data`：`roeAvg` / `epsTTM` / `netProfit` / `NRProfit` / `MBRevenue`
  - `query_balance_data`：`liabilityToAsset` / `currentRatio` 等
  - `query_dupont_data`：`dupontROE` 分解
- ROA 属**派生覆盖**（组合 profit + balance 两 API）

**优先级**：
1. **主**：Baostock 派生 · `net_income / total_assets`（组合 `query_profit_data` + `query_balance_data` · join by `(code, year, quarter)`）
2. **保护**：`total_assets = 0` 或 NULL · `roa = NULL`（非 0/0 除零）

**PIT 校准**：与 `fundamental_pit` 其他字段共享 `as_of` PIT 时点（`available_at ≤ t`）

**精度**：`NUMERIC(12, 6)`（12 位总长 · 6 位小数 · 精度足够表达 ROA 百分数）

### §3 E4.5 `fallback_reason` 字段规则

**取值语义**：

| `data_source` 值 | `fallback_reason` 值 |
|-----------------|---------------------|
| `BAOSTOCK` | `NULL`（主链无 fallback） |
| `TUSHARE_PRO` | `NULL`（未来 · 单源 · 无 fallback） |
| `MERGED` | 合并规则版本字符串（e.g. `'merge_rule_v1_baostock_priority'`） |

**长度限制**：TEXT（无长度硬限 · 应用层约 < 64 字符）

### §3 E4.6 迁移路径（v1 冻结时 landing 步骤）

**步骤 1**：DDL 执行（新增 3 列 · DEFAULT `BAOSTOCK` · 无 NOT NULL 破坏兼容）

**步骤 2**：历史数据回填
```sql
UPDATE fundamental_pit
  SET data_source = 'BAOSTOCK', fallback_reason = NULL
  WHERE data_source IS NULL OR data_source = '';
```

**步骤 3**：应用层写侧 gate 加固（v1 只允 BAOSTOCK 写入）
```typescript
function insertFundamentalPit(row: FundamentalPit): void {
  if (row.data_source !== 'BAOSTOCK') {
    throw new Error(`v1 冻结期间只允许 BAOSTOCK 写入，收到 ${row.data_source}`)
  }
  // insert logic
}
```

**步骤 4**：QA 断言 (`test_fundamental_pit_schema_v1_1.test.ts`)：
- 断言 A：DDL 3 列存在（`information_schema.columns` grep）
- 断言 B：CHECK constraint 3 值定义
- 断言 C：v1 写入路径拒 TUSHARE_PRO/MERGED（应用层 unit test）
- 断言 D：`roa` NULL 保护 · `total_assets=0` 场景 mock

---

## §3 E4 · Frontend 不 aware 权威锁

**规则**：`data_source` / `fallback_reason` 是**契约层字段** · **不透传** `explain_card` UX 层

**权威锚**：
- Orchestrator msg=f89e7ac0 §7 权威锁（首次锁定）
- Orchestrator msg=b8b3baf4 终版澄清（Q8 slug 移除 `quality_data_fallback_baostock` 后再次锁定）

**执行层**：
- Backend API 响应层过滤 `data_source` / `fallback_reason` 字段（不出网）
- `explain_card` DTO 无此 2 字段
- Frontend TypeScript 类型定义无此 2 字段（Frontend 侧无需 aware · 无需处理）

---

## §3 E4 v1.1 冻结 DoD

- ✅ DDL 3 列定义（`roa` NUMERIC · `data_source` VARCHAR CHECK · `fallback_reason` TEXT）
- ✅ 3 值枚举 y/n 表联动
- ✅ minor bump 兼容规则
- ✅ `roa` 计算规则 3 步优先级
- ✅ `fallback_reason` 取值语义 3 场景
- ✅ 迁移路径 4 步
- ✅ Frontend 不 aware 权威锁

---

## Cross-References

- Orchestrator msg=767ba280 · `data_source` 3 值枚举
- Orchestrator msg=f89e7ac0 §7 · Frontend 不 aware
- Orchestrator msg=b8b3baf4 · Q8 终版 slug 移除
- Orchestrator msg=84fa4b84 · M-Draft 挪入终裁
- Orchestrator msg=bf74c64c · li-yiming 全权授权
- Orchestrator msg=c2b28c7c · 自主推进边界令 v1
- Strategy §Q7-fundamental-pit（同批 landing · `contracts/strategy-v1-additions.md`）
- ADR-0007 quality-factor-fallback（同批 landing）
- ADR-0009 baostock-gpl-isolation（同批 landing）
- DataPipeline workspace `notes/40-data-contract-v1-1-e4.md`（源起草）
- QADocs Task #24 `test_quality_dual_source_divergence_alarm.test.ts`（休眠位 · TUSHARE_PRO 启用后转正）

---

**End of contracts/data.md v1.1 §3 E4 delta**
