# 23 — 因子 IC 持续监测 + 自动调权 + 冗余剔除

## A. 操盘手心智

"一个因子 IC = 0.05" 不是终点 — 关键是：
1. **它什么时候开始失效**：60 日 rolling IC 跌穿 0.02 持续 3 个月，必须立即降权或下线
2. **它和别的因子重不重复**：value 和 quality_high 相关 0.8 = 用一个就够，用两个等于无意义放大单一信号
3. **它在不同 regime 下表现**：动量因子牛市 IC=0.08 / 熊市 IC=-0.02，等权混用等于平均掉 alpha

操盘手的核心问题是 **不让失效因子继续污染策略**，但人工监测 22 个因子 × 4 种 lookForward 太累。系统化必须：自动监测 + 自动降权 + 自动报警 + 一键剔除。

---

## B. 系统设计

### B.1 IC 监测三层

#### B.1.1 Layer 1 — 每日 IC 计算（FactorICReport）

`FactorICReport.generate({ factor_name, start_date, end_date, look_forward_days_list })` 计算：
- per-day spearman(factor_score[T], forward_return[T → T+N])
- 跨日聚合 mean / std / IR = mean/std × sqrt(252) / positive_ratio
- 写入 `factor_ic_results` 表，4-tuple PK (factor_name, look_forward_days, period_start, period_end)

#### B.1.2 Layer 2 — 自动告警（应有但缺）

IC 失效阈值（已在 CLAUDE.md 写明）：
- IC mean < 0.02 持续 3 个月 → 失效告警
- IC_IR < 0.3 → 因子不稳定
- 跨 lookForward 衰减 > 70% → 信号过于短期化

#### B.1.3 Layer 3 — 自动调权 / 自动剔除（缺）

- IC > 0.05 持续 6 个月 → 权重自动 ×1.5
- IC < 0.02 持续 3 个月 → 权重自动 ×0.5
- IC < 0 持续 6 个月 → 权重置 0（事实上下线）
- 同时配合 FactorCorrelationReport：|corr| > 0.7 的两个因子，IR 高的留下，另一个权重置 0

### B.2 FactorCorrelationReport 联动

`FactorCorrelationReport.generate({ factor_names })` 算横截面 Spearman 相关矩阵。
- |corr| > 0.7 → `is_redundant=true` + RiskAlert（已实现）
- 阈值可配置（默认 0.7，可降到 0.5 提示）

### B.3 调权决策表（建议设计）

| condition | action |
|---|---|
| 新因子上线 90 天内 | observation（不进 MFA） |
| 90 天后 IC mean ≥ 0.03 AND IR ≥ 0.3 | 上线，初始权重 = 默认 |
| 6 月 rolling IC ≥ 0.05 | 权重 ×1.5（capped at 2 × 默认） |
| 3 月 rolling IC < 0.02 | 权重 ×0.5 + 飞书 ALERT |
| 6 月 rolling IC < 0 | 权重 = 0（事实下线） + 邮件通知 |
| 与另一个 IR 更高因子 \|corr\| > 0.7 | 权重 = 0 + 加入"待二选一"列表 |

---

## C. 现状 review

### C.1 FactorICReport 已实现

证据: `backend/src/quant/factors/FactorICReport.ts` 859 行。
- 8 个纯函数 export（rankAscending / spearmanCorrelation / mean / sampleStddev / aggregateICSeries 等）
- DataSource 接口注入 + fake mode 让 118 个测试全脱 DB
- 4-tuple PK upsert
- MIN_CROSS_SECTION_SIZE = 30
- lookahead bias guard
- CLAUDE.md 详细文档化（`backend/src/quant/factors/CLAUDE.md:392-481`）

### C.2 FactorCorrelationReport 已实现

证据: `backend/src/quant/factors/FactorCorrelationReport.ts` 751 行。
- 3 个纯函数 export (dedupPairsToUpperTriangle / computeDailyCorrelation / aggregateCorrelationSeries)
- 共享 US-041 的 spearman / rank / mean / sampleStddev
- REDUNDANCY_THRESHOLD = 0.7 (绝对值，强负相关也算冗余)
- 自动 is_redundant=true + RiskAlert (symbol='SYSTEM:FACTOR_CORR')

### C.3 Cron 调度已有

证据: `backend/src/services/SchedulerService.ts:4350` `factor_ic_compute` 任务类型，调 `scripts/compute-factor-ic.ts`。

### C.4 ⚠️ 缺自动调权闭环

`MultiFactorAlphaStrategy.weightMode='ic_weighted'` (`MultiFactorAlphaStrategy.ts:814-836`) 已实现"按 IC 算权重"，但：
- **默认 weightMode='static'**（第 460 行）
- 没有"长期监测 + 自动告警 + 自动下线"闭环
- IC < 0 持续 N 月不自动 set weight=0

### C.5 ⚠️ 缺 redundancy 行动

FactorCorrelationReport 标了 is_redundant=true + 发 RiskAlert，但**没有任何下游服务消费这条告警自动改 MFA weights**。等于"知道冗余但没人处理"。

### C.6 ⚠️ FactorICReport / CorrelationReport 跑得不够频繁

`SchedulerService.ts:4350` factor_ic_compute 是任务，但要看 cron schedule 才知道频率。建议默认每周一次 + 月底全量；当前可能没有强制定期跑。

---

## D. 改造方案

### D.1 P0：FactorWeightController 自动调权服务

**新建** `backend/src/services/factor/FactorWeightController.ts`：

```ts
class FactorWeightController {
  // 每周日凌晨 cron 触发
  async rebalanceMfaWeights(): Promise<RebalanceReport> {
    // 1. 查所有 22 因子近 90 日 / 180 日 IC (lookForward=20)
    const icMap = await this.loadAllFactorICs();

    // 2. 查 FactorCorrelationReport 找 |corr| > 0.7 redundant pairs
    const redundantPairs = await this.loadRedundantPairs();

    // 3. 算每个因子的 effective_weight 动作（同 B.3 决策表）
    const actions = this.computeWeightActions(icMap, redundantPairs);

    // 4. 写入 quant_strategy_param_versions (新 version, status='draft')
    //    让人工 review 后 promote 到 active
    const draftVersion = await this.createDraftParamVersion(actions);

    // 5. 飞书 ALERT 给 ops
    await this.sendRebalanceAlert(actions, draftVersion);

    return { actions, draft_version_id: draftVersion.id };
  }
}
```

**user story**：
- 每周日凌晨 02:00 自动跑
- 输出 draft 版本不直接生效（防止"某周数据异常导致权重彻底跑偏"）
- 人工 review 后通过 admin API promote 到 active
- 每月底强制全量重算 + 通知

### D.2 P0：FactorICReport cron 加固

**user story**：
- 把 `FACTOR_IC_COMPUTE` cron 改成每周一次 + 月底全量（当前可能不定期）
- 失败重试 3 次；3 次都失败发飞书 ALERT
- 跑完后自动触发 FactorCorrelationReport（依赖 IC 完成后）

### D.3 P1：前端 FactorHealthDashboard

**痛点**: 22 个因子的 IC / IR / coverage / correlation 当前散在不同表，看一个因子要查 3 张表。

**user story**：
- 一个表格列出 22 因子：name / category / 30d IC / 90d IC / IR / coverage / redundant_with / weight_action
- 红/黄/绿色 status: 绿 (IC ≥ 0.03)，黄 (IC ∈ [0.01, 0.03])，红 (IC < 0.01 或负)
- 一键"模拟剔除该因子重跑 MFA top-30 看差异"
- 直接 admin "锁定/解锁权重" 操作（写入 draft）

### D.4 P1：FactorICReport 加分组 IC（行业 / 市值）

**痛点**: 一个因子全市场 IC = 0.04，可能"小盘 0.10 / 大盘 0.01"。混在一起看丢失重要信息。

**user story**：
- FactorICReport.generate 加 `group_by: 'industry' | 'market_cap_quantile'` 参数
- factor_ic_results 加 `group_dim` / `group_value` 字段（如 ('industry', '银行')）
- 前端按"行业 × 因子" 矩阵展示 IC

### D.5 P2：因子失效后回测验证

**痛点**: 自动权重 ×0.5 后实际策略表现如何？应有 backfill 验证。

**user story**：
- 每月触发"假设 3 个月前就按当前权重"的 walk-forward backtest
- 输出"权重调整 vs 不调整" sharpe 对比

---

## E. 验收口径

1. **告警闭环**: 任一因子 IC < 0.02 持续 3 月，第 4 个月一定触发飞书 ALERT + 写 RiskAlert
2. **调权可回退**: 自动调权写入 draft 版本，人工 review 后才生效；可一键回退到上一版本
3. **redundant 处理**: FactorCorrelationReport 标 is_redundant=true 的 pair，必须在 7 天内有"人工选择保留哪个"的决策记录
4. **IC dashboard 可用**: 前端打开 < 3s，22 因子全展示，每个因子可点开看 90 日 IC 走势图
5. **冗余消除**: 任何时点 MFA effective_weights 中权重 > 0 的因子，两两相关性 ≤ 0.7（保留高 IR 那一个）
