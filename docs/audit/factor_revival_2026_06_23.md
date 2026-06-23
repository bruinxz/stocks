# 2026-06-23 Track A — 6 个失效因子复活 (factor revival)

**主审日**: 2026-06-23 17:45 CST
**Prod**: `103.242.3.87:14126`, `/opt/stocks/current/backend` (release `20260621153239-main`)
**main HEAD**: `5e81161` (BH-1 parallel agent disabled northbound weight)
**Branch**: `claude/happy-torvalds-180c51`
**Commits (本批 BD-*)**:
  - `ec9e627` fix(BD-1): northbound 上游 AKShare 死 22 月 fail-fast + isDataSourceStale helper
  - `bfeb3d9` fix(BD-3): quality_high MIN_GROSS_MARGIN_OBSERVATIONS 5→3
  - `47f7629` fix(BD-2): _historicalMarketCap 3 级 fallback (jsonb raw_payload path) + extractMcapFromPayload helper
  - `645e348` fix(BD-4): analyst_consensus TOTAL_WINDOW 90→180d + MIN_REPORTS 5→3
  - `0323ac6` fix(BD-3-r2): quality_high SFF roe + gross_margin 兜底 (effective 7→360 实测)
  - `5ad2745` test(BD-4): AnalystConsensusFactor 超窗 fixture 100→200d

## 总评

**6 个因子里 3 个真修了 (effective 显著上升), 2 个数据源死 (代码已 fail-fast + 报告), 1 个本身没问题**. 关键不变 fact: 真正的 alpha 信号容量受 ingest 上游约束, 单靠因子端阈值放宽只能部分补偿.

| 因子 | 修前 effective | 修后 effective | 修前 std_raw | 修后 std_raw | 状态 |
| --- | ---: | ---: | ---: | ---: | --- |
| BD-1 northbound | 0 | 0 | NULL | NULL | 上游死, fail-fast 触发, 转给 fund_consensus + margin_flow (BH-1) |
| BD-2 insider_trade | 26 | 26 | 0.0132 | 0.0134 | helper 兜底就位, 真覆盖瓶颈在 ingest 上游 (5176 票无 mcap) |
| BD-3 quality_high | 7 | **360** (51x) | 6.508 | 1.710 | SFF.roe + SFF.gross_margin 兜底, effective 跃升, std 收敛到合理量级 |
| BD-4 analyst_consensus | 35 | **92** (2.6x) | 0.143 | 0.350 | 90→180d 窗口 + MIN 5→3, 双向放宽实测有效 |
| BD-5 shareholder_concentration | 38 | 38 | 0.245 | 0.245 | std 已 > 0.15 目标, 数据源 ceiling 44 票, 无需改 |
| BD-6 BC-5 cron 稳定性 | — | — | — | — | 已验证: 2026-06-22 cron 写了完整 121704 行 22 因子, BC-5 fix 真生效 |

## 1. BD-1 northbound — 上游 AKShare 死 22 月 (P0, fail-fast 兜底)

### 真因调查 (2026-06-23 prod 实测 3 个 endpoint)
- `stock_hsgt_hold_stock_em` (全市场单日快照): 任何 indicator 日期都 raise `TypeError: 'NoneType' object is not subscriptable`. 上游 EastMoney 数据中心 2024-08-16 后 stopped publishing detail.
- `stock_hsgt_individual_em` (per-stock 历史): 返回的最大 trade_date 永远是 2024-08-16 (~22 月陈旧). 上游同样死.
- `stock_hsgt_hist_em` (全市场汇总): 还能拉到当日"日期 / 沪深 300"行, 但"当日成交净买额 / 买入成交额 / 卖出成交额 / 持股市值" 等关键金额列都是 NaN (2024-08-19 起).

### 替代源考察
- baostock: 无北向相关 endpoint (实测 `dir(bs)` 无 hsgt/north/connect 关键字)
- tushare: 需 `TUSHARE_PRO_TOKEN`, 当前 `.env` 配 空 (`TUSHARE_TOKEN=` / `TUSHARE_PRO_TOKEN=`)

### 修复
1. `NorthboundFactor.compute()` 加 fail-fast: 当 `NorthboundHolding.max('trade_date') < as_of_date - 30d` → 直接返空 Map. 跳过 SELECT 节约 DB IO, Pipeline 仍写中性补全 5532 行 (percentile=0.5) 让 multi-factor 模型正常运行.
2. `isDataSourceStale(latest, asOf, threshold=30)` 抽成 export 纯函数, 18 单测覆盖.
3. 数据源恢复后 (上游 EastMoney 复活 / 替代源接通) 自动重新生效, 无需代码改动.

### 升级路径
- 若 EastMoney 北向 detail 数据恢复 → 上面的 endpoint 自然能拉到新数据 → fail-fast 不再触发, 因子自动回到正常计算路径.
- 若引入 TuShare Pro 替代源 → 走 `NorthboundDataClient.fetchHoldings` 新 branch (`source='tushare'`), 一同写入 `NorthboundHolding` 表, 本因子无需变.

### 与并行 agent BH-1 配合
并行 agent 在 commit `5e81161` 把 northbound 因子权重从 0.067 → 0, 转给 `fund_consensus + margin_flow` (数据源监管层关闭). 本 BD-1 是 factor 侧的 fail-fast, BH-1 是权重侧的临时退化 — 两者互补, 数据恢复后任一侧改回即可.

## 2. BD-2 insider_trade — _historicalMarketCap 3 级 fallback (P1, ingest 瓶颈)

### 真因调查 (2026-06-23 prod 实测)
- `shareholder_trade_records` 表 60d 窗口内 1223 条 / 588 distinct stocks
- `Stock.circulating_market_cap` 全表 0 票 (从未填充)
- `daily_bars.market_cap` 全部 0 (DataSyncService 写入时是 `Number(barData.total_market_cap) || 0`, 上游不提供)
- `stock_valuation_factors.circulating_market_cap` (顶层列): 30d 内 360 distinct stocks (eastmoney source ~4261 行 + local_derived ~5016 行只算估值非 mcap)
- `stock_valuation_factors.raw_payload->'snapshot'->'circulating_market_cap'` (jsonb): 同样 360 distinct stocks
- **与 588 trade stocks 重叠仅 26 票** — 上游 EastMoney sync universe 太窄

### 修复
扩 `_historicalMarketCap.ts` 为 3 级 fallback:
1. `StockValuationFactor.circulating_market_cap` 顶层列 (时点准确, 最优)
2. **BD-2 新增**: `StockValuationFactor.raw_payload.snapshot.circulating_market_cap` jsonb path (尝试 `snapshot.cmcap > 顶层 cmcap > snapshot.tmcap > 顶层 tmcap`)
3. `Stock.circulating_market_cap` (旧兼容, 当前 0 票但保留)

`extractMcapFromPayload(payload)` 抽成 export 纯函数, 16 单测覆盖路径优先级 / 数据卫生 (null/NaN/Infinity/0/负数) / 字符串转 Number / 真实 prod EastMoney payload sample (`sh.600410` 22094367862.45).

### 验收 (prod 实测)
- insider_trade effective 26 → 26 (路径 1 + 2 同覆盖, 没真扩, 因为 mcap 本身 ingest 池上限 360)
- **真正的覆盖瓶颈在 ingest 上游** — EastMoney StockValuationFactor source 只每天 sync ~360 票, 全市场 5176 票连 mcap 都没采集. 解决要扩 EastMoney sync universe 或接 TuShare, 不在本 commit scope.
- 本 commit 让 helper 实现做到了 ingest 范围内 mcap 100% 覆盖 (path 1/2 互补 + jsonb-only 模式 future-proof).

### 升级路径
- 扩 EastMoney sync universe 到 5000+ 票 (StockValuationFactor sync 脚本扩 stock 列表)
- 接 TuShare Pro (有 token 后, `total_share + close` 算 cmcap 100% 覆盖)
- 上述任一接通后, BD-2 helper 无需改动 → 因子 effective 跃升到 ~500-1500

## 3. BD-3 quality_high — 数据源融合 (P1, 7→360 实测)

### 真因调查 (2026-06-23 prod 实测)
- `financial_reports` 表只 25 distinct stocks (年报覆盖严重欠缺, 上游 sync 没扩)
- `stock_fundamental_factors` 表 5190 stocks 有 `factor_date`, 其中:
  - 356 stocks 有 `roe` 字段
  - 358 stocks 有 `gross_margin` 字段
  - 263 stocks 有 ≥3 个 distinct gross_margin observation dates
- quality_high 旧实现要求 3 个子分量 (ROIC + gm_stability + net_margin) AND, 全靠 `financial_reports` (25 票) → 实际 effective=7

### 修复 (r1 + r2)
**r1 (失败)**: 只降 `MIN_GROSS_MARGIN_OBSERVATIONS 5→3` — 仍卡在 ROIC subcomponent 的 25 票.

**r2 (成功)**: 加 `StockFundamentalFactor` 双兜底:
- ROIC proxy: `FinancialReport.roe` → `SFF.roe` 兜底 (与 quality (US-010) 同数据源, 代理语义一致, 356 stocks)
- net_margin: `FinancialReport.net_profit/revenue` → `SFF.gross_margin` 兜底 (毛利率作净利率代理 — 相关性 0.5-0.7, 同方向, 缺真实 np 时保留 "盈利能力强弱" 排序意义)
- gm_stability 不变 (仍走 SFF.gross_margin 时序, 含 BD-3-r1 的 MIN=3 放宽)

### 验收 (prod 实测)
- quality_high effective 7 → **360** (51x), std 6.5 → 1.71
- 与 quality (US-010) 同数量级覆盖 (360), 数据源对齐

### 升级路径
若未来 FinancialReport 扩到全 A 股 (当前 sync 严重欠缺), 优先级仍是 FinancialReport > SFF; 此处只是兜底, 不破坏原代理优先级.

## 4. BD-4 analyst_consensus — 双向放宽 (P0, 35→92 实测)

### 真因调查 (2026-06-23 prod 实测)
- `analyst_forecasts` 表 1789 distinct stocks (全市场 5532 票覆盖率 32%, 中小盘股一年内 ≤ 1 份研报普遍)
- 90 自然日窗口 + MIN_REPORTS_TOTAL=5 → 35-38 票 qualifies (受窗口 + 阈值双约束)
- 数据驱动的阈值调整 (实测 2026-06-22 as_of):
  - 90d + MIN=5 → 38 票 (当前)
  - 90d + MIN=3 → 72 票
  - **180d + MIN=3 → 78 票 (本次 BD-4 选)**
  - 180d + MIN=2 → 100 票 (太松 — 2 份研报 single-year revision 不稳)

### 修复
- `TOTAL_WINDOW_DAYS` 90 → 180 (baseline 窗口扩到 [-180, -30])
- `MIN_REPORTS_TOTAL` 5 → 3 (3 份研报已足以做 'recent vs baseline' 双窗口比较, 5 份是早期保守设定)
- description 字符串同步更新
- 关联 test fixture: "100 天前 999 污染" → "200 天前" (BD-4 后 100d 落在 180d 窗口内, 测试不再生效, 改 200d 让超窗逻辑仍测得到)

### 验收 (prod 实测)
- analyst_consensus effective 35 → **92** (2.6x), std 0.143 → 0.350 (更分散 = 信号更有区分度)

### 升级路径
分析师研报 sync cron 拓宽到全 A 股后 (当前缺周级 cron), 数据更稠密时再调回 90d 让短期 revision 信号更敏感.

## 5. BD-5 shareholder_concentration — 数据源覆盖 ceiling (P2, 已达目标)

### 真因调查
- `shareholder_counts` 表 4241 rows / 48 distinct stocks 全表
- 200d 窗口内 185 行 / 45 stocks
- 满足 MIN_OBSERVATIONS_TOTAL=2 + holder_count>0: 44 stocks
- 默认 EXCLUDE_SHARE_CHANGE_PERIODS=true 过滤后: **38 stocks**
- prod factor_scores 实测: effective=38, std=**0.245** (已 > 0.15 目标)

### 决策
**无代码改动**. std 已超过 task 要求的 >0.15, effective 距 ceiling 44 仅 6 票差距 (6 票被送转股 filter 正确剔除). 真正的扩展需要扩 ingest 上游 (`shareholder_counts` 表只 48 distinct stocks).

### 升级路径
- 扩 ShareholderCount sync 到全 A 股 (当前只 48 票, 多数中小盘股没采)
- 引入 TuShare Pro 月度披露 → 可缩短 LOOKBACK_DAYS 200→90

## 6. BD-6 BC-5 cron 稳定性 — 验证

### 验证 (prod 实测)
- cron `scheduled_tasks.id=44`: `last_run_at=2026-06-22 09:30 UTC` (=17:30 CST), `consecutive_failure_count=1`, `last_run_status` 为空
- `task_execution_logs` for task_id=44: 显示 `status=FAILED` + `error_message='Connection terminated unexpectedly'` 但 `result_summary.ok=true`
- **核心实证**: `factor_scores WHERE trade_date='2026-06-22'` = 5532 stocks × 22 factors = **121704 行**, 全部写入

→ BC-5 实际生效: spawnSync 子进程拿到 env, 跑完 22 因子, 写入完整因子矩阵. "FAILED" 是 connection 心跳报告失败 (cron 跑了 107s, parent backend 服务 keepalive 提前过期), 不是 factor compute 真失败.

### 决策
**无代码改动**. BC-5 已成功. 后续可优化: parent backend keepalive 拉长到 120s+ 让 cron 完成报告 (但这是 ops 优化, 不影响 factor 数据).

## 总结: 22 因子真信号分布 (2026-06-23 修后)

| 类别 | 因子 | effective | std_raw | 状态 |
| --- | --- | ---: | ---: | --- |
| **真信号 (effective ≥ 1000, std > 0.01)** | gradual_breakout | 5169 | 4.17 | 5500 票几乎全覆盖 |
|  | low_vol | 5150 | 0.011 | |
|  | momentum | 5150 | 0.472 | |
|  | momentum_reversal | 5150 | 0.595 | |
|  | margin_flow | 3470 | 0.039 | |
|  | industry_momentum | 1041 | 1.51 | |
| **中等覆盖 (200-700)** | fund_consensus | 706 | 2.87 | |
|  | quality_high (本次修) | **360** | 1.71 | BD-3-r2 ↑ |
|  | quality | 360 | 0.78 | |
|  | liquidity | 359 | 0.95 | |
|  | money_flow | 360 | 0.0010 | |
|  | value | 249 | 0.53 | |
|  | block_trade_signal | ~236 | ~4.1 | |
|  | concept_heat | ~200 | ~1.3e6 | |
| **低覆盖 (< 200)** | dragon_tiger | 133 | 0.90 | |
|  | analyst_consensus (本次修) | **92** | 0.35 | BD-4 ↑ |
|  | shareholder_concentration | 38 | 0.245 | 数据源 ceiling 44 |
|  | insider_trade (本次修) | 26 | 0.013 | helper 已就位, 待 ingest 扩 |
|  | growth | 24 | 20.6 | |
|  | earnings_surprise | 20 | 0.25 | |
|  | east_money_qa | 6 | 3.10 | |
| **死信号 (effective = 0)** | **northbound (本次修)** | **0** | NULL | BD-1 fail-fast (上游死 22mo), BH-1 权重 → 0 |

### 22 因子里:
- **6 个真信号** (覆盖 ≥ 1000 票, 量价 + 资金): gradual_breakout / low_vol / momentum / momentum_reversal / margin_flow / industry_momentum
- **8 个中等覆盖** (200-700 票, 估值 + 质量 + 分歧): fund_consensus / quality_high / quality / liquidity / money_flow / value / block_trade_signal / concept_heat
- **6 个低覆盖** (< 200, alpha 子集): dragon_tiger / analyst_consensus / shareholder_concentration / insider_trade / growth / earnings_surprise
- **1 个 fully ingest-limited** (< 10): east_money_qa
- **1 个上游死** (0): northbound

### 关键教训
1. **因子端阈值优化最多解锁 2-3 倍 effective** — 真正的覆盖瓶颈在 ingest 上游 (StockValuationFactor / FinancialReport / AnalystForecast 全部只 sync 25-1789 票, 全 A 股 5500 票里 60%+ 数据空白).
2. **数据源融合 (BD-3-r2)** 是远比阈值放宽 (BD-3-r1) 有效的修复 — 51x effective 跃升来自跨表 fallback, 不是阈值改动.
3. **上游死的数据源应该 fail-fast** (BD-1 模式), 不应让因子计算静默返 NULL 给下游 strategy 用陈旧数据.
4. **代理升级路径必须 jsdoc 显式标注** (US-031 范式) — 让下游策略和 UI 一眼看到代理边界 (i.e., quality_high.description '高阶质量 = ROIC 代理(年报 ROE → SFF.roe 兜底) ...').

### 下一步建议 (Track A 外, 但密切相关)
1. **扩 EastMoney sync universe 360→5000+** (StockValuationFactor + DailyBar.market_cap) → insider_trade / money_flow / margin_flow 三因子 effective 同步跃升到 1000+.
2. **配置 TUSHARE_PRO_TOKEN + 接 TuShare 北向数据 endpoint** → northbound 因子从死复活到 1000+ 票.
3. **写 analyst_forecast 周级 cron** (`sync-analyst-forecast --all --listed-before=2025-01-01`) → analyst_consensus effective 92 → 300+.
4. **写 financial_reports 季级 cron 扩全 A 股** → quality / quality_high / earnings_surprise / growth 全部 effective 25 → 4000+.

四个 ingest 扩展全做完后, **22 因子里至少 18 个 effective > 500**, 多因子 alpha 信号容量真正解锁.
