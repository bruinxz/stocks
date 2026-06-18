# 72 — 每周策略表现复盘（Weekly Strategy Review）

## A. 操盘手心智

每周日下午是我固定的"复盘 + 调仓"时间。要回答 5 个问题：

1. **本周哪个策略赚了 / 亏了**？vs 沪深 300 / 中证 500 / 创业板指 / 同行
2. **策略间相关性**变化了没？两个策略都赚或都亏，说明它们"看的是同一个 alpha"，应该合并
3. **策略 capacity** 还有多少？本周如果加 50% 资金进去，市场冲击会不会超 0.3%
4. **是否有策略该 kill-switch**？连续 4 周亏 / 跑输基准 → 暂停 1 个月
5. **下周计划**：哪个加权、哪个减权、哪个停

每周复盘的关键不是"看 pnl 多少"，而是"判断策略状态"——cold（不工作）/ warm（一般）/ hot（赚钱）。

---

## B. 系统设计

### B.1 周报核心 8 段

```
┌─ Section 1: 大盘环境 ─────────────────────────┐
│  上证 / 沪深 300 / 中证 500 / 创业板 周收益    │
│  本周 regime：bull/bear/range/correction       │
│  下周日历事件预览                              │
└──────────────────────────────────────────────┘

┌─ Section 2: 组合表现 ─────────────────────────┐
│  Total Return / Benchmark Return / Excess     │
│  Sharpe / Max DD / Win Rate / Profit Factor   │
│  Equity Curve sparkline                       │
└──────────────────────────────────────────────┘

┌─ Section 3: 策略表现矩阵 ─────────────────────┐
│  每个 active 策略一行：                       │
│  | strategy | pnl | vs_bench | sharpe | trades | status |
│  status: hot/warm/cold/at_risk                │
└──────────────────────────────────────────────┘

┌─ Section 4: 行业贡献 ─────────────────────────┐
│  top 5 winners / top 5 losers 行业            │
│  vs 上周变化                                  │
└──────────────────────────────────────────────┘

┌─ Section 5: Symbol 贡献 ──────────────────────┐
│  top 5 best / worst trades 这周               │
│  每个含 entry/exit/holding/reason             │
└──────────────────────────────────────────────┘

┌─ Section 6: 策略相关性矩阵 ───────────────────┐
│  N×N 热力图（pearson 60-day rolling）         │
│  > 0.7 高亮红色：建议合并或下线                │
└──────────────────────────────────────────────┘

┌─ Section 7: Capacity 评估 ────────────────────┐
│  每个策略：本周平均下单冲击 / ADV 占用率       │
│  距离 capacity 上限百分比                     │
└──────────────────────────────────────────────┘

┌─ Section 8: AI 总结 + 下周建议 ───────────────┐
│  ≤ 300 字自然语言                             │
│  含：3 个调权建议 / 1-2 个 kill-switch 提议  │
└──────────────────────────────────────────────┘
```

---

## C. 现状 review

### C.1 已存在（已经做得不错）

| 文件 | 行 | 现状 |
|---|---|---|
| `backend/src/services/WeeklyReviewReportService.ts` | 58-179 | Payload 定义完整：PrevWeekRange / WeeklyEquityPoint / IndustryContributionRow / SymbolContributionRow / UpcomingEventRow / AIWeeklyOpinion / WeeklyReviewPayload |
| `WeeklyReviewReportService.ts` | 262-289 | `computePrevWeekRange()` — 上周交易日窗口 |
| `WeeklyReviewReportService.ts` | 290-353 | `computeWeeklyPnL()` + `aggregateIndustryContribution()` + `aggregateSymbolContribution()` |
| `WeeklyReviewReportService.ts` | 406-448 | `buildEquityCurveSparkline()` SVG-style 文本 |
| `WeeklyReviewReportService.ts` | 449-535 | `buildHeuristicWeeklyOpinion()` — 模板拼装的"AI 意见" |
| `WeeklyReviewReportService.ts` | 552-794 | `buildWeeklyReviewEmail()` — 完整 HTML 邮件 |
| `WeeklyReviewReportService.ts` | 816-875 | `DefaultWeeklyReviewDataSource` — DI |

### C.2 关键缺口

1. **没有"策略表现矩阵"section**：当前 payload 是组合级 pnl + industry + symbol 三段，**没有按 strategy_key 拆**
2. **没有策略相关性矩阵**：策略间相关性是关键指标，缺失
3. **没有 capacity 评估**：每策略当前规模 / capacity 上限百分比缺
4. **AI opinion 是 heuristic 拼字符串**（buildHeuristicWeeklyOpinion），**没接 LLM**
5. **kill-switch 提议没有 hook**：即使 opinion 说"建议暂停 X 策略"，没有自动写 `strategy_config.disabled=true`
6. **vs 基准**只比沪深 300，缺中证 500 / 创业板指对比
7. **没有"跟踪误差"指标**（tracking error vs benchmark）
8. **下周日历事件预览缺**：没有读 `EventsCalendar` 模型

---

## D. 改造方案

| ID | 故事 | P | 依赖 |
|---|---|---|---|
| WK-001 | 在 `WeeklyReviewPayload` 加 `strategy_performance: StrategyRow[]` 字段，含 strategy_key / pnl / vs_bench / sharpe / trades / status | P0 | — |
| WK-002 | 实现 `computeStrategyPerformance(trades, snapshots)` pure function：按 strategy_key 拆 pnl / sharpe | P0 | WK-001 |
| WK-003 | 实现 `computeStrategyCorrelationMatrix(trades, lookback_days=60)`：返回 N×N pearson | P0 | — |
| WK-004 | 在 `WeeklyReviewPayload` 加 `correlation_matrix` + `high_corr_pairs` 字段 | P0 | WK-003 |
| WK-005 | 新建 `StrategyCapacityEstimator.ts`：基于历史成交量 + ADV + 平均 turnover 估算 strategy_capacity；输出 `capacity_used_pct` | P1 | — |
| WK-006 | 在 `WeeklyReviewPayload` 加 `capacity_estimates: CapacityRow[]` | P1 | WK-005 |
| WK-007 | 替换 `buildHeuristicWeeklyOpinion` → `buildAIWeeklyOpinion`：调 trading-agents 或本地 LLM；输入 payload → ≤ 300 字摘要 | P1 | WK-001~WK-006 |
| WK-008 | AI opinion 输出"建议清单"结构化（建议类型 + strategy_key + action：boost/reduce/kill）；写 `weekly_review_recommendations` 表 | P1 | WK-007 |
| WK-009 | 后端 `POST /api/weekly-review/:id/apply` 接口：把 AI 建议落到 `strategy_config`，但**必须人工 click 确认**才生效 | P2 | WK-008 |
| WK-010 | 多 benchmark 对比：加入中证 500 + 创业板指；HTML email 出 3 个 vs_benchmark | P2 | — |
| WK-011 | 周报增加"下周日历事件"section：读 `EventsCalendar` 模型未来 7 天事件，标记影响 ≥ 5 的 | P2 | — |
| WK-012 | 前端 PortfolioWorkspace 新增 `/review/weekly` tab：展示完整 8 段 + correlation heatmap（recharts heatmap） | P1 | WK-001~WK-006 |

---

## E. 验收口径

1. 周六 09:00 自动生成上周周报，所有 active 用户飞书/邮件收到
2. 邮件含完整 8 段（增加"策略矩阵 + 相关性 + capacity + 下周事件"）
3. AI opinion ≥ 200 字、引用 ≥ 3 个具体数字、给出 ≥ 1 个调权建议
4. 高相关策略对（pearson > 0.7）能在矩阵 UI 高亮
5. capacity > 80% 的策略在"建议清单"出现"减权"提议
6. 用户能在前端展开过去 12 周历史周报
7. 跑 `npm test WeeklyReviewReportService.test.ts` 覆盖新增 6 个 pure helper 全绿
