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

---

# §D4 · v0.2 delta · M0.5 数据快照 landing (Day 3 · 11 pin items)

**版本**：v0.2 delta (v1.1 §3 E4 后续 · M0.5 Day 3 承接)
**Owner**：Orchestrator（吸收 DataPipeline M0.5 Day 1/Day 2 SSH 直查揭源事实）
**起草**：DataPipeline · workspace `notes/m0.5-day3-contract-landing.md` v0.1 60% landed 承接
**权威锚**：Orchestrator msg=69ae32ae (6 冻结点 pin) · msg=f1afac4c (α PIT 裁 · time+T+1 交易日) · msg=076f4eaf §四 (Task #10 DP 路 D4 v0.2 armed) · msg=eff622c5 (Path A 分派令 · 4/4 副签路由)
**事实基础**：DataPipeline SSH 直查 stock_backtest (TimescaleDB pg14) · Day 1 §5.1-§5.5 SQL 揭源 · Day 2 §DDL 5 表 88 col 全揭 (`\d+`) · Day 2 model verify 5/5 pass · 0 divergence
**教训应用**：教训 #11 (broadcast pin · 独立 SSH 直查 · silence≠absence) · 教训 #12 (contract draft ≠ code truth · runtime 判定基准 = source code + PG DDL)

---

## §D4.G · daily_bars 存储结构 (TimescaleDB Hypertable · 事实 pin)

**事实揭源** (DataPipeline Day 2 §一 SSH `_timescaledb_catalog.chunk` COUNT verify):
- 引擎：TimescaleDB pg14 · hypertable_id=1 · num_dimensions=1 (time only)
- **chunk_interval = 7 days · 139 chunks** @ 2026-07-09 · 覆盖 2023-11-02 起 (最早 `_hyper_1_106` · 最新 `_hyper_1_139`)
- 分区键：`time` (WITHOUT tz · 契约 Asia/Shanghai 语义 · §D4.10 承接)
- FK：`stocks(id)` via `stock_id integer` · ON DELETE CASCADE · 逐 chunk 独立约束 (Timescale native)
- Trigger：`ts_insert_blocker BEFORE INSERT` (强制 chunk routing · direct chunk INSERT 拒绝)
- 写入路径：只走 `daily_bars` 主表 · Timescale 内部 dispatch 到 chunk

**备份策略**：pg_dump --schema-only 输出 hypertable 元 · pg_dump --data-only 需按 chunk (Timescale 建议 `pg_dump --exclude-table='_timescaledb_*'`)

---

## §D4.G2 · trading_calendar 补建承接位 (v1 gap 定盘)

**gap 事实** (双侧确认 · Day 1 §5.2):
- Local model：无 (backend/src/models/ 未定义)
- PG 表：无 (SSH `information_schema.tables` 揭源 · zero hit)
- 契约 §8 六实体锚：已列 · 未落地
- 采集源：Baostock `bs.query_trade_dates` 主 (msg=4f6d2466 主源冻结)

**v0.2 字段 shape pin**：

```sql
CREATE TABLE trading_calendar (
  trade_date DATE PRIMARY KEY,
  is_open BOOLEAN NOT NULL DEFAULT TRUE,
  is_half BOOLEAN NOT NULL DEFAULT FALSE,     -- 半日市 flag · A股仅节前调休
  prev_trade_date DATE,                        -- nullable · 上一交易日
  next_trade_date DATE,                        -- nullable · 下一交易日
  source VARCHAR(50) NOT NULL DEFAULT 'baostock',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_trading_calendar_is_open ON trading_calendar (is_open);
CREATE INDEX idx_trading_calendar_is_half ON trading_calendar (is_half);
```

**承接矩阵**：
- 采集器：DataPipeline 承接 · Baostock `bs.query_trade_dates` 主链 · AKShare 备
- Migration：Sequelize migration DDL 预草 (M2+1 独立分派 armed · Orch 独立裁时机 · 建议 D4 v0.2 landing 后)
- 消费方：§D4.1 α 降级门禁 (前 INTERVAL '1 day' 用日历日近似 · trading_calendar landing 后用真实交易日) · 回测层日期迭代 · Strategy signal 生成日期过滤

---

## §D4.G3 · rowcount 预期基线 (事实上修)

**事实揭源** (DataPipeline Day 1 §5.1 SSH SELECT COUNT + §5.4c 时间窗验证):
- 时间窗：`MIN(time)=2023-11-02 00:00:00` · `MAX(time)=2026-07-07 00:00:00` · 跨度 ~2.7 年
- distinct_stocks = 5625 (99.3% of 5664 stocks 有 daily_bar 覆盖)
- non_zero_hm_count = 0 (daily 语义纯净 · 无时分秒污染)

**v0.2 rowcount 预期基线 pin**：

| 表 | 实际 (Day 1) | v0.2 预期 | 基线依据 |
|---|---|---|---|
| `daily_bars` | 797,011 | **1M-10M** | 5625 stocks × 250 交易日/年 × 2.7 年 ≈ 3.8M |
| `dividend_histories` | 802 | **100-10K** | 5.7 年 backfill (Baostock 起点) · 事件密度非年份线性 |
| `financial_reports` | 1,113 | **100-100K** | 4 类 report_type × 5.7 年 × 5K 股票 ≈ 114K max |
| `stocks` | 5,664 | **1K-10K** | 全 A 股规模 · 与预期一致 |
| `analyst_forecasts` | pending (SSH server-down · Orch msg=253b5e40 冻结令 §一) | **1K-10K** (default 类比推定) | Server 恢复后独立 SSH SELECT COUNT verify 补 pin |

**偏差阈值**：实际超预期 3x 立即 broadcast · Orch 独立裁

**Server-down caveat** (Orch msg=253b5e40 冻结令 §一): analyst_forecasts rowcount 事实待 SSH 恢复后独立复核 · v0.2 用 default 1K-10K estimate (类比 stocks 规模推定) · 非 blocker

---

## §D4.1 · `available_at` α 降级策略 (Orch msg=f1afac4c 终裁)

**gap 严重度**：🔴 critical (D3.1 硬约束) · 5 表全无 `available_at` 字段 (backfill 未写)

**Day 1 §5.4d 揭源事实链**:
- `daily_bars.created_at` MIN = 2026-05-19 09:55:07 · MAX = 2026-07-07 10:30:11
- 全表 797K rows 均在 7 周内落库 (backfill batch · 非增量 daily append)
- β soft 降级方案 (`COALESCE(available_at, created_at) ≤ t`) 会误伤所有 t < 2026-05-19 的历史回测 · 全拒

**α 定案** (Orch msg=f1afac4c 终裁):

```
PIT_FALLBACK_STRATEGY = COALESCE(available_at, time + INTERVAL '1 day') ≤ t
```

**语义**：无 `available_at` 时 · 用 `time` (交易日) + 1 交易日近似 · 保证 T+1 可用 (信息公开半日 + 一交易日)

**依赖**：trading_calendar 表补建 (§D4.G2 承接位) · 前 INTERVAL '1 day' 用日历日近似 · trading_calendar landing 后升级用真实交易日

**采集器补写路径 (v1.2)**：各表补 `available_at` 列 · backfill 时用 (announce_date/report_date/time+1) 填充

---

## §D4.2 · stock_code 语义分裂 SOP

**分裂事实链** (Day 1 §2.2 + Day 2 §DDL 双侧确认):

| 表 | code 字段 | 类型 | 前缀 | 示例 |
|---|---|---|---|---|
| `stocks.symbol` | `varchar(10)` | **有市场前缀** | ✅ | `600000.SH` / `000001.SZ` |
| `dividend_histories.stock_code` | `varchar(20)` | **无市场前缀** | ❌ | `600519` / `000001` |
| `financial_reports.stock_code` | `varchar(20)` | **无市场前缀** | ❌ | `600519` |
| `analyst_forecasts.stock_code` | `varchar(20)` | **无市场前缀** | ❌ | `600519` |
| `daily_bars` | **N/A** (用 `stock_id integer` FK) | — | — | 代理键 join |

**gap 严重度**：🟡 4 表 2 套 code 语义 · 采集器/回测层 join/write 潜在 bug 面

**SOP pin** (v0.2 保持现状 · 明示规则):
- **join 统一入口**：用 `stocks.id` 代理键 · zero direct code join
- **采集流程**：采集 raw code → `stocks` 表 lookup by symbol → 拿 id → `daily_bars` 用 id · 3 事件表 (dividend/financial/analyst) 用 `stock_code` 无前缀 (Baostock/AKShare 原始格式)
- **v1.1 统一裁决位** armed：是否统一 (加前缀或去前缀) · 需 Orch 独立裁 · v0.2 保持现状 + 明示 SOP

---

## §D4.7 · 契约起草名字 vs 实际实现名字校正清单 (docs 层校正 · zero runtime 干预)

**背景** (教训 #12 反向应用锚 · workspace `notes/lesson-12-contract-draft-vs-code-truth.md`):
- 前 workspace §5.2 声称 "17+ divergence" 全部虚警
- DP grep 5/5 model verify (`notes/model-field-divergence.md`): 实际 divergence = **0**
- Sequelize `@Column({field:'xxx'})` + `@Table({underscored:true})` 全覆盖 · runtime broken risk = 0

**校正矩阵** (契约层文档撰写基准 · 用 model 真实字段名):

### §D4.7.1 · `dividend_histories` 校正
| 早期概念名 (契约草稿) | 实际字段名 (code + PG DDL) |
|---|---|
| announcement_date | **announce_date** |
| ex_dividend_date | **ex_date** |
| stock_dividend_per_10 | **bonus_per_10** |
| transfer_shares_per_10 | **transfer_per_10** |
| dividend_yield | **yield_pct** |
| data_source | **source** |
| (无) | **raw_payload jsonb NOT NULL default '{}'** |

### §D4.7.2 · `financial_reports` 校正
| 早期概念名 | 实际字段名 |
|---|---|
| data_source | **source** |
| raw_row | **raw_payload** |

### §D4.7.3 · `stocks` 校正 (含 core code→symbol)
| 早期概念名 | 实际字段名 |
|---|---|
| code | **symbol** 🔴 core |
| list_date | **listing_date** |
| delist_date | **delisting_date** |
| market_cap | **total_market_cap** |
| circulation_market_cap | **circulating_market_cap** |
| pe_ttm | **pe_dynamic** |
| pb_lyr | **pb** |
| latest_price | **price** |
| latest_change_percent | **change_percent** |

### §D4.7.4 · `daily_bars` 校正
零 divergence · shape 100% 一致 (Sequelize `@Table({underscored:true})` 全策略)

### §D4.7.5 · `analyst_forecasts` 校正
零 divergence (Day 2 §五 verify · `@Table({underscored:true})`)

**用途**：未来契约层文档撰写用 model 真实字段名 (symbol/announce_date/...) 而非早期概念名 (code/announcement_date/...) · runtime broken risk = 0 · 无 M2+1 独立分派需要

---

## §D4.8 · 索引 dedup 候选 (M2+1 armed · non-blocking)

**候选清单** (Day 2 §6.1 揭源):

| 表 | 重复索引对 | 分析 | 建议 |
|---|---|---|---|
| `daily_bars` | `daily_bars_time_idx` (time DESC) + `idx_daily_bars_time_desc` (time DESC) | **完全重复** | drop `idx_daily_bars_time_desc` (保留 `daily_bars_time_idx`) |
| `stocks` | `stocks_symbol` UNIQUE btree + `stocks_symbol_key` UNIQUE CONSTRAINT btree | **完全重复** (constraint 附带 index) | drop `stocks_symbol` (保留 constraint) |
| `financial_reports` | `financial_reports_report_date` + `financial_reports_stock_code_report_date` | 前缀重叠 | 保守保留 (query pattern 覆盖不同) |

**执行时机**：M2+1 独立 DDL 分派 (Cleanup 侧 · DP 副签 · SSH 直查 `pg_stat_user_indexes` 无使用后 drop)
**收益**：写入放大降低 (每 INSERT 少维护 1 索引) · 存储节省

---

## §D4.9 · numeric 精度统一矩阵 (4 档 · v1.2 armed · non-blocking)

**当前精度分歧** (Day 2 §6.3 揭源):

| 语义类 | 现有精度 | 表 |
|---|---|---|
| money (turnover) | `numeric(20,4)` | daily_bars.turnover / market_cap |
| money (revenue) | `numeric(22,4)` | financial_reports.revenue / net_profit |
| price (OHLC) | `numeric(12,4)` | daily_bars.open/high/low/close/adj_close |
| price (target) | `numeric(14,4)` | analyst_forecasts.target_price |
| dividend | `numeric(14,6)` | dividend_histories.dividend_per_share / bonus_per_10 / transfer_per_10 |
| ratio (change_pct) | `numeric(10,4)` | daily_bars.change_percent / turnover_rate / amplitude |
| ratio (roe/debt) | `numeric(12,4)` | financial_reports.roe / debt_ratio |
| ratio (yoy) | `numeric(14,4)` | financial_reports.net_profit_yoy / revenue_yoy |

**v0.2 统一矩阵 pin** (4 档 · 新 model 用统一矩阵):

| 档 | 精度 | 语义 | 覆盖字段 |
|---|---|---|---|
| **price** | `numeric(12,4)` | 价格类 (max ≈ 1亿元/股) | OHLC / adj_close / target_price |
| **money** | `numeric(20,4)` | 金额类 (max ≈ 1000万亿元) | turnover / market_cap / revenue / net_profit |
| **factor** | `numeric(14,6)` | 因子/权重类 | dividend_per_share / bonus_per_10 / transfer_per_10 / 复权因子 |
| **ratio** | `numeric(10,4)` | 百分比类 | change_percent / turnover_rate / roe / debt_ratio / yoy |

**执行**：v1.2 契约 · 采集器写入前 CAST · 存储层 ALTER COLUMN (M2+1 独立 DDL · non-blocking)
**兼容性**：现有分歧不 breaking · 新 model 用统一矩阵

---

## §D4.10 · 时区注释矩阵

**语义事实** (Day 2 §一 + §6.3 揭源):
- `daily_bars.time` = `timestamp WITHOUT time zone` (Sequelize `DataType.DATE` 默认无 tz)
- `created_at` / `updated_at` = `timestamp WITH time zone` (Sequelize timestamps · 有 tz)
- 契约 D3.1 语义：Asia/Shanghai + 秒级 (`available_at` UTC ISO8601)

**时区矩阵 pin**：

| 字段类 | 类型 | 语义 | 处理 |
|---|---|---|---|
| `daily_bars.time` | `timestamp WITHOUT tz` | **Asia/Shanghai 无 tz 存储** · daily 语义 (Day 1 §5.4c verify: non_zero_hm_count=0) | 写入 `date` 部分 · time 部分强制 00:00:00 · 读取应用层 assume Asia/Shanghai |
| `created_at` / `updated_at` | `timestamp WITH tz` | UTC 存储 · Sequelize timestamps 标准 | native |
| `available_at` (未来补写) | `timestamp WITH tz` | UTC ISO8601 (D3.1 契约) | native |
| 事件日期 (announce_date/ex_date/record_date/pay_date/report_date/listing_date/delisting_date) | `date` | Asia/Shanghai 语义 · 无 tz | native |

**Migration 注意**：TimescaleDB hypertable time 分区键 · 若未来改 tz 需 recreate hypertable · high cost · v1.0 保持无 tz

---

## §D4.11 · source 字段 default 调整 (msg=4f6d2466 主源对齐)

**当前 default** (Day 2 §6.5): 3 表 (dividend/financial/analyst) 均 `source varchar(50) NOT NULL default 'akshare'`

**冻结锚** (msg=4f6d2466): Baostock 主 · AKShare 备 · Tushare 弃 · Yahoo opt-in

**冲突**：default = 'akshare' 与主源冻结不一致 · 采集器 explicit 覆盖 default 但语义混淆

**v0.2 调整 pin**：

| 表 | 当前 default | v0.2 default | 依据 |
|---|---|---|---|
| `dividend_histories.source` | `'akshare'` | **`'baostock'`** | Baostock 主 · 复权除权源 |
| `financial_reports.source` | `'akshare'` | `'akshare'` (保持) | AKShare 主 · 财报事件流源 |
| `analyst_forecasts.source` | `'akshare'` | `'akshare'` (保持) | 东财 QA 报 · AKShare 主 |

**执行**：M2+1 DDL ALTER COLUMN default (non-blocking · 采集器 explicit 覆盖已守)
**备注**：明示 "import-time 覆盖" 语义 · default 仅 fallback (未 explicit 传时保护)

---

## §F2 G1 chunk_interval footnote (Strategy 承接锚)

**背景**：Strategy PR #90 §F2 G1 draft (`docs/refactor/50-strategy-design.md` line 635) 陈述 daily_bars chunk_interval = "3 months" · 实际 PG truth = **7 days · 139 chunks** (Day 2 §一 揭源)

**DataPipeline 副签 msg=2fb2b567 §一.B flag**: 数字纠错 · non-blocking · Orch 认非 amend · v1.1 契约冻结时 pin

**footnote pin** (Strategy v1.1 §D4 契约冻结时承接位 · docs-only ~10-15 lines):

```
§F2 G1 chunk_interval footnote (msg=2fb2b567 flag)
- 前 PR #90 §F2 G1 draft: "chunk_interval ≈ 3 months"
- Day 2 §DDL 揭源实际: chunk_interval = 7 days · 139 chunks @ 2026-07-09 (hypertable_id=1)
- 影响: chunk 数量估算 · pg_dump 批次策略 · 查询 planner chunk skip 分析
- walk-forward 语义: chunk_interval=7 days · walk-forward test 边界不再对齐单 chunk
  · 3 months ≈ 63 trading days ≈ 9 chunks
  · TimescaleDB chunk exclusion pushdown 仍生效 · 性能影响 = 微
- 修订: Strategy v1.1 契约冻结时 pin 正确数字 · 引锚 DP msg=2fb2b567 + workspace notes/m0.5-snapshot-day2-ddl.md §一
```

**Strategy 承接位** (Strategy msg=6c80e6af §四 pre-draft): workspace `notes/50-strategy-f2-g1-footnote-v1.md` armed · Strategy v1.1 §D4 契约冻结时 footnote 追增 PR 承接 (SLA 24h from Day 3 landing)

---

## §D4 · v0.2 delta landing DoD (11 items landed 追认)

| # | 契约位 | 建议类型 | 事实链锚 | 严重度 |
|---|---|---|---|---|
| 1 | §D4.G3 rowcount 预期上修 | 数字修订 | Day 1 §5.4c: 5625×250×2.7≈3.8M | 🟡 |
| 2 | §D4.2 stock_code 语义分裂 SOP | 语义 pin | Day 1 §2.2 + Day 2 §DDL 4-way | 🟡 |
| 3 | §D4.7 契约起草名字 vs 实际实现名字校正清单 | docs 层校正 (zero runtime) | 教训 #12 · model-field-divergence.md 5/5 pass · 0 divergence | 🟢 (docs only) |
| 4 | §D4.1 `available_at` α 降级 | 契约固化 | Orch msg=f1afac4c 裁 · time+T+1 交易日近似 | 🔴 (D3.1 gap) |
| 5 | §D4.G daily_bars TimescaleDB hypertable annotation | 结构 pin | Day 2 §一: 139 chunks · chunk_interval=7 days | 🟡 (Strategy §F2 G1 draft 3-month 纠正) |
| 6 | §D4.G2 trading_calendar 补建承接位 | gap 定盘 | Day 1 §5.2: 双侧缺失 · M2+1 独立分派 armed | 🔴 (D4 gap) |
| 7 | §D4.8 索引 dedup 候选 | 索引优化 | Day 2 §6.1: 3 表候选 | 🟡 (non-blocking) |
| 8 | §D4.9 numeric 精度统一矩阵 (4 档) | 类型统一 | Day 2 §6.3: 6 种精度 → 4 档 | 🟡 (non-blocking) |
| 9 | §D4.10 时区注释矩阵 | 语义 pin | Day 2 §6.3: daily_bars.time WITHOUT tz | 🟡 |
| 10 | §D4.11 source default 调整 | default 调整 | Day 2 §6.5: dividend akshare→baostock (msg=4f6d2466) | 🟡 |
| 11 | §F2 G1 chunk_interval footnote | Strategy 承接 pin | 副签 msg=2fb2b567 flag · Strategy v1.1 契约冻结时 pin | 🟢 (Strategy 侧) |

---

## §D4 · Cross-References

- Orchestrator msg=69ae32ae (6 冻结点 pin · §D4.7 校正清单降级)
- Orchestrator msg=f1afac4c (α PIT 裁 · time + T+1 交易日近似)
- Orchestrator msg=076f4eaf §四 (Task #10 DP 路 D4 v0.2 armed)
- Orchestrator msg=eff622c5 (Path A 4 路并行分派 · owner 完全自决授权)
- Orchestrator msg=253b5e40 (冻结令 · SSH/PG 全域 pause · code 层 continue)
- Orchestrator msg=4f6d2466 (数据源冻结 · Baostock 主 · AKShare 备 · Tushare 弃)
- DataPipeline msg=2fb2b567 (§F2 G1 数字纠错 · SSH `_timescaledb_catalog.chunk` COUNT verify · 7-day × 139 chunks)
- DataPipeline msg=d801bdbd (Day 2 model grep 5/5 self-correct · 0 divergence)
- DataPipeline workspace `notes/m0.5-day3-contract-landing.md` v0.1 60% landed (14 章 · 11 pin items)
- DataPipeline workspace `notes/m0.5-snapshot-day1.md` (Day 1 §5.1-§5.5 SSH 揭源 · 5 表 rowcount + PIT 语义)
- DataPipeline workspace `notes/m0.5-snapshot-day2-ddl.md` (Day 2 §DDL 5 表 88 col 全揭 · 9 章)
- DataPipeline workspace `notes/model-field-divergence.md` (5/5 pass · divergence=0)
- DataPipeline workspace `notes/lesson-12-contract-draft-vs-code-truth.md` (教训 #12 引锚)
- Strategy `docs/refactor/50-strategy-design.md` §F2 G1 line 635 (chunk_interval 承接位 · v1.1 冻结时 footnote 追增)
- Strategy workspace `notes/50-strategy-f2-g1-footnote-v1.md` armed (Strategy Path A 副签 pre-verify · msg=6c80e6af §四)

---

**End of contracts/data.md v0.2 delta (§D4 · M0.5 Day 3 · 11 pin items)**

