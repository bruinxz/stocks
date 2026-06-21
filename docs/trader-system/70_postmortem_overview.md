# 70 — 复盘总览：4 个时间尺度 + AI 辅助 + 黑天鹅

## A. 操盘手心智

复盘是 alpha 的源头。每个动作（买、不买、卖、不卖）都有它的"为什么"和"事后看应该不应该"。一个高级操盘手会把复盘拆成 4 个时间尺度：

1. **每日**：今天每笔交易，赚了为什么、亏了为什么；归因到（因子 / 行业 / 时机 / 选股 / 择时 / 执行成本）
2. **每周**：每个策略 vs 基准、vs 上周；策略间相关性是不是涨了；capacity 还有多少
3. **每月**：因子还有没有 alpha — IC / IR / 半衰期；redundancy 是不是高了；该不该下线
4. **每季**：参数还合不合适 — grid search / Bayesian / walk-forward 重训；ensemble 权重再校准

加上 2 个"特殊"复盘：
- **黑天鹅特殊复盘**：单日 > 5% 跌 / 涨、系统异常、风控触发后，必须出独立报告
- **AI 辅助复盘**：自动生成"投资日记"、识别错误模式（追高 / 砍底 / 风格漂移）

**根本目标**：让"系统在跑"和"操盘手在学"是同一件事。

---

## B. 系统设计

```
日（T+0 17:00 触发）─┐
                    ├─→ 归因报告（自然语言摘要 + JSON evidence）
周（周六 09:00 触发）┤
                    ├─→ 推送（飞书 / 邮件）
月（月末 + 月初 09:00）┤
                    ├─→ 自动建议（调权 / 下线因子 / 重训参数）
季（季末 09:00）  ─ ┘

黑天鹅 watchdog ─→ 触发立即复盘 ─→ 30 分钟内推送
AI 日记 ─→ 每日 18:00 ─→ 错误模式聚合 ─→ 周末整合
```

**6 项硬要求**：
1. **每次复盘有"自然语言摘要 + 结构化 JSON evidence"双形态**：人看摘要，系统读 JSON
2. **不靠"看图说话"，每个结论必须能追溯到原始 trade / signal / quote**
3. **AI 摘要必须给出 3 类输出**：(a) 客观陈述 (b) 偏差判断 (c) 改进建议
4. **每个时间尺度的复盘都要落库**（不只是飞书 push 出去）
5. **可回溯 3 年**：任意时点的"当时是怎么判断的"都能复现
6. **AI 自进化闭环**：周复盘 + 月因子 + 季参数的 output → 自动写入 `risk_config / strategy_config` 调整

---

## C. 现状 review

### C.1 已存在的 4 个核心服务

| 文件 | 行 | 现状 |
|---|---|---|
| `backend/src/services/TradePostmortemService.ts` | 24-103 | ✅ 单笔 trade 关闭后自动生成 5-bullet 复盘；规则驱动；落 `outcome.metadata.postmortem` |
| `backend/src/services/WeeklyReviewReportService.ts` | 58-179, 552-794 | ✅ 周复盘已成熟：pnl 拆分、行业贡献、symbol 贡献、equity sparkline、heuristic opinion、邮件 HTML 生成 |
| `backend/src/services/RecommendationTradeOutcomeService.ts` | 763-1445 | ✅ 4717 行的"巨服务"：refreshOutcome、listOutcomes、getDashboard、getOptimizationDashboard、classify root_cause |
| `backend/src/services/BehaviorBiasDetector.ts` | 40-460 | ✅ 4 类偏差检测：chasing_high / overtrading / anchoring_loss / loss_aversion_early_take；severity 0-100；suggestions |

### C.2 已存在的辅助服务

- `backend/src/services/FieldGateAdjustmentAttributionService.ts:29-150`：环境闸门字段调权归因（policy snapshot 维度）
- `backend/src/services/ReviewPerformanceCenterService.ts`：performance center 聚合
- `backend/src/services/RiskThresholdAttributionService.ts`：风险阈值归因
- `backend/src/services/RecommendationLoopPolicySnapshotService.ts:83-1287`：loop 策略快照 + dashboard

### C.3 关键缺口（review 出来必须补的）

1. **日复盘不存在主入口**：TradePostmortemService 只是"单笔事后"，没有"今日所有交易合并归因"。一个"日 attribution report"主服务缺失
2. **月度因子 IC 衰减自动告警缺**：FactorICReport 类存在但**没有 cron**触发 + 没有"IC < 0.02 自动下线"动作
3. **季度参数重训没自动化**：GridSearch / BayesianOptimizer / WalkForward 都已实现（`backend/src/quant/backtest/`），但**没有 cron 驱动 + 自动 PR/灰度**
4. **黑天鹅复盘缺独立 service**：BlackSwanWatchdog 是 risk 层的 `pre-trade gate`，没有"事后复盘"的 service
5. **AI 自动写日记缺**：BehaviorBiasDetector 输出 finding，但"自然语言日记"生成 + 落库缺
6. **复盘结果反哺策略**缺：当前所有复盘的 output 都是给人看，**没有 hook 回写 strategy_config / factor_weights**

### C.4 现状评分

| 模块 | 完成度 | 缺口 |
|---|---|---|
| 单笔事后复盘 | 80% | 自然语言总结靠规则、没 LLM |
| 周复盘 | 70% | heuristic opinion 太弱、没 AI summary |
| 月因子 IC | 30% | 报告存在、没自动化 |
| 季参数重训 | 20% | 工具存在、没流程 |
| 黑天鹅复盘 | 0% | 完全缺失 |
| AI 日记 | 0% | 完全缺失 |
| 偏差检测 | 70% | 已有 4 种、缺前端 + 缺反哺 |

---

## D. 改造方案（user stories）

| ID | 故事 | P |
|---|---|---|
| PM-001 | 新建 `DailyAttributionService.ts`：每日 17:00 触发，输入今日所有 closed/holding trade，输出"今日总盈亏 + 6 维归因"。复用 TradePostmortemService 单笔逻辑 + 新增 daily aggregator | P0 |
| PM-002 | DailyAttribution 接入 AI summary：调用 trading-agents `/api/summarize` 或本地 OpenAI key，把 6 维归因转 ≤ 200 字自然语言；fail-back heuristic | P0 |
| PM-003 | WeeklyReviewReportService 升级 `buildHeuristicWeeklyOpinion` 为 `buildAIWeeklyOpinion`：把 6 个 anchor（pnl / 行业 / symbol / 偏差 / 事件 / 下周展望）填入 prompt template | P1 |
| PM-004 | 新建 `MonthlyFactorICReviewService.ts`：每月初 09:00 触发，跑 FactorICReport on 18+ factor × last_180d，输出 IC 衰减表 + 自动建议（保留 / 下线 / 降权） | P0 |
| PM-005 | MonthlyFactorICReviewService 增加"自动调权 hook"：写入 `factor_weights_config`，在 MultiFactorAlphaStrategy.generateSignals 读取 | P1 |
| PM-006 | 新建 `QuarterlyParamRetrainService.ts`：每季末 09:00，串联 GridSearch → WalkForward → BayesianOpt，输出 top 3 参数组合 + AB shadow 启动信号 | P0 |
| PM-007 | 新建 `BlackSwanPostmortemService.ts`：监听 RiskAlert 中 `level=critical` 的事件，30 min 内生成"是否预警 / 风控是否触发 / 实际损失 / 改进建议"4 段报告 | P0 |
| PM-008 | 新建 `AIDiaryService.ts`：每日 18:00 触发，整合 (a) 今日 attribution (b) 偏差 finding (c) 黑天鹅事件 → LLM 生成 ≤ 500 字"投资日记"，写 `ai_diary_entries` 表 | P1 |
| PM-009 | BehaviorBiasDetector 增加"风格漂移"detector：检测用户最近 30 天 trade 的 industry/style 分布 vs 历史均值的 KL divergence | P2 |
| PM-010 | 前端 PortfolioWorkspace 增加 `/portfolio/review` tab：展示日 / 周 / 月 / 季四级 review + 偏差 finding + AI 日记 | P1 |

---

## E. 验收口径

1. 任意一天能从 `/api/postmortem/daily?date=YYYY-MM-DD` 拿到归因 JSON + AI summary
2. 周末自动飞书推送一份"本周策略 vs 基准 + AI 建议"
3. 每月 1 号自动生成"上月因子 IC 衰减"邮件（含至少 1 个下线建议）
4. 季度末自动跑参数重训，shadow 库里出现新参数组合
5. 单日跌 > 5% 当天 18:00 前飞书收到"黑天鹅复盘"
6. 用户主页能看到至少 7 天的 AI 日记
7. BehaviorBias 报告里能识别出至少 1 类用户实际存在的偏差，并 suggestion 能形成"风险参数调整"提议（不自动落，需手工确认）
