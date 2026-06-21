# 71 — 每日交易归因（Daily Attribution）

## A. 操盘手心智

**今天赚了 1.2%，但我必须能说出**：
- 多少来自"选对了行业"（行业 β）
- 多少来自"在行业里选对了股"（alpha）
- 多少来自"时机踩准"（择时）
- 多少来自"持仓权重大"（sizing）
- 多少来自"运气好"（残差）
- 多少被"执行滑点 / 手续费"吃掉

**今天亏了 0.8%**：同样的拆解。**最怕的是"涨跌都不知道为什么"**——这意味着系统在赌博，不是在交易。

每日复盘必须 ≤ 1 小时完成：盘后 15:30 → 17:00 出报告 → 18:00 看完。**不能拖到第二天**——记忆 24 小时后衰减一半。

---

## B. 系统设计

### B.1 归因公式（Brinson-Fachler 改良版）

每笔 closed trade 的盈亏拆解到 6 维：

```
trade_pnl = factor_contribution        # 因子暴露贡献（基于多因子模型残差）
          + industry_contribution      # 行业 β 贡献
          + timing_contribution        # 入场/出场时机相对平均价
          + selection_contribution     # 在行业内的 alpha（symbol 选择）
          + sizing_contribution        # 权重选择
          + execution_cost            # 滑点 + 手续费 + 印花税
          + residual                  # 其它（运气）
```

**今日总归因** = Σ all closed trades + Σ holding trades 浮动盈亏

### B.2 输出结构

```ts
interface DailyAttributionReport {
  date: string;
  portfolio_id: number;
  total_pnl: number;
  total_pnl_pct: number;
  breakdown: {
    factor_contrib: { factor_key: string; pnl: number; pct: number }[];   // top 5
    industry_contrib: { industry: string; pnl: number; pct: number }[];   // top 5
    timing_contrib: number;
    selection_contrib: number;
    sizing_contrib: number;
    execution_cost: number;
    residual: number;
  };
  best_trades: TradeSummary[];   // top 3 winners
  worst_trades: TradeSummary[];  // top 3 losers
  ai_summary: string;             // ≤ 200 字
  bias_findings: BiasFinding[];   // 若今日新触发
  recommendations: string[];      // 明日改进
}
```

### B.3 触发链

```
17:00 cron `DAILY_ATTRIBUTION_GENERATE`
  ├─→ load 今日 closed trades + EOD positions
  ├─→ load factor_scores(today)
  ├─→ load industry_returns(today)
  ├─→ call AttributionEngine.compute()
  ├─→ call AIAttributionSummary.generate()    (LLM 或 heuristic)
  ├─→ call BehaviorBiasDetector.detectIncremental(today)
  ├─→ write DailyAttributionReport
  └─→ enqueue feishu push (含 ≤ 200 字 summary + 链接)
```

---

## C. 现状 review

### C.1 已存在

| 文件 | 行 | 现状 |
|---|---|---|
| `backend/src/services/TradePostmortemService.ts` | 24-103 | 单笔 trade 关闭后生成 5-bullet bullets + suggestions；root_cause 驱动；落 `outcome.metadata.postmortem` |
| `backend/src/services/RecommendationTradeOutcomeService.ts` | 1261-1445 | `getDashboard()` 提供 6 维度聚合：root_cause / strategy / industry / signal_type 等 |
| `backend/src/services/RecommendationTradeOutcomeService.ts` | 1017 | `getTrace(outcomeId)` 单笔追溯 |
| `backend/src/services/TradeRootCauseClassifier.ts`（推断） | — | root_cause 分类器（profit_take / stop_loss / wrong_entry / wrong_regime ...） |
| `backend/src/services/FieldGateAdjustmentAttributionService.ts` | 29-150 | 字段闸门调权归因（不同维度） |
| `backend/src/services/RiskThresholdAttributionService.ts` | — | 风险阈值归因 |

### C.2 关键缺口

1. **没有"今日全量"归因主入口**：TradePostmortem 是单笔；Dashboard 是历史聚合；缺一个"今日 close + holding 合并归因"的 service
2. **没有 Brinson-Fachler 风格的"行业 β vs 选股 α"拆解**：当前 dashboard 是按 industry 聚合 pnl，不区分"行业涨我跟着涨"vs"行业不涨我也涨"
3. **execution_cost 没有持久化**：滑点 / 手续费 / 印花税分散在 trade record 字段，没有合并到"今日总成本"
4. **AI summary 完全缺**：当前 TradePostmortem 的 `bullets.detail` 是模板拼字符串，不是 LLM 生成的自然语言
5. **明日改进建议 = `SUGGESTIONS_BY_ROOT_CAUSE` 静态查表**（TradePostmortemService.ts:81-100），不是基于今日具体表现的动态建议
6. **没有 cron 自动触发**：DailyAttribution 没有 SchedulerService 注册项

---

## D. 改造方案

| ID | 故事 | P | 依赖 |
|---|---|---|---|
| ATTR-001 | 新建 `backend/src/services/attribution/DailyAttributionService.ts`：实现 `generateDailyReport(portfolio_id, date)`；聚合今日所有 trade + holding 的 6 维归因 | P0 | — |
| ATTR-002 | 新建 `attribution/AttributionEngine.ts`：实现 Brinson-Fachler 拆解算法（pure function，可单测） | P0 | ATTR-001 |
| ATTR-003 | 新建 model `DailyAttributionReport.ts`（columns: date, portfolio_id, total_pnl, breakdown JSONB, best_trades JSONB, worst_trades JSONB, ai_summary TEXT, bias_findings JSONB, recommendations JSONB） + 迁移 | P0 | ATTR-001 |
| ATTR-004 | 新建 `attribution/ExecutionCostAggregator.ts`：从 LiveTradeFill + paper_trade 取 slippage / commission / stamp_duty，按 portfolio 汇总 | P0 | — |
| ATTR-005 | 新建 `attribution/AIAttributionSummary.ts`：调 trading-agents `/api/summarize` 或本地 GPT，输入 6 维归因 JSON → ≤ 200 字中文摘要；heuristic fallback | P0 | ATTR-001 |
| ATTR-006 | 在 SchedulerService 注册 cron `DAILY_ATTRIBUTION_GENERATE`（17:00 工作日）→ 调 generateDailyReport for all active portfolios | P0 | ATTR-001 |
| ATTR-007 | 新增 RESTful `GET /api/portfolio/:id/attribution/daily?date=YYYY-MM-DD` controller + route | P1 | ATTR-003 |
| ATTR-008 | BehaviorBiasDetector 增加 `detectIncremental(user_id, date)`：只在今日新增 trade 上诊断（性能） | P1 | — |
| ATTR-009 | 飞书 push：DailyAttribution 完成后调 `feishuNotifier.sendAttributionCard(report)` | P1 | ATTR-005 |
| ATTR-010 | 前端 PortfolioWorkspace `/review` tab 增加"今日归因"卡片（pie chart 6 维 + best/worst 3 + AI summary 文本） | P2 | ATTR-007 |

---

## E. 验收口径

1. 任一交易日 17:30 在 `DailyAttributionReport` 表里能 SELECT 到当日记录
2. JSONB `breakdown.factor_contrib` sum ≈ total_pnl × factor_weight（容差 ±5%）
3. AI summary 包含 ≥ 3 条具体数字（如"今日通信行业贡献 +0.42%"）
4. 飞书卡片 17:35 前送达
5. 用户能在 PortfolioWorkspace 看到至少 30 天的归因历史
6. execution_cost 项有数值（≥ 0），与 LiveTradeFill 字段对账 ≥ 99%
7. 周末跑 `npm test -- attribution/*.test.ts` 单测全绿
