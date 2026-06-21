# 84 — AI 策略 Copilot（Task-driven Copilot）

## A. 操盘手心智

操盘手最大的痛点不是不会做策略，而是**做策略的"试错成本"太高**：
- 想问"今天有没有 北向加仓 + RSI 超卖 + 行业 hot 的票"→ 要去 SQL 里写 join
- 想试"我把 MFA 策略的 topN 从 30 改 50 看回测会怎样"→ 要去 LabWorkspace 跑回测
- 想要"列出我所有持仓里行业集中度 > 25% 的"→ 要去 Portfolio 页过滤
- 想知道"为什么这只 600519 被推荐"→ 要去 AI Modal 看 8 dimension

每个动作都要点 5+ 次鼠标。**Copilot 的价值**：用自然语言一句话**直接拿到结果或执行动作**，而不是给一段研报式解释。

v1 Copilot 是"对话式"（4 个 intent：解释回测 / 调参 / 生成草案 / 通用），v2 升级为"**任务式**" — 用户说话 → 系统识别 task → 自动执行（SQL / 调 service / 跑 backtest）→ 返回结果。

---

## B. 系统设计

### B.1 v2 Task 类型扩展

```
v1: 4 个 intent (对话式)
  - EXPLAIN_BACKTEST / SUGGEST_PARAMS / GENERATE_DRAFT / GENERAL

v2 新增 7 个 task 类型 (执行式):
  - QUERY_STOCKS      ("找今天北向加仓 + RSI 超卖 + 行业 hot 的票")
  - RUN_BACKTEST      ("跑 MFA 策略 topN=50 lookback=20")
  - QUERY_POSITIONS   ("我现在哪些持仓行业集中度 > 25%")
  - EXPLAIN_PICK      ("为什么 600519 今天被推荐")
  - WHAT_IF           ("如果我现在全清 ZX 行业，pnl 会变多少")
  - SET_ALERT         ("如果 002230 跌破 50，提醒我")
  - GET_DIAGNOSIS     ("我最近 30 天为什么 underperform 基准")
```

### B.2 执行流程

```
askCopilot(prompt) v2:
  1. detectIntent (扩展到 11 个 intent)
  2. extractEntities (股票 / 行业 / 指标 / 数字 / 日期)
  3. routeToHandler:
     - QUERY_STOCKS → SQLBuilderService.fromNaturalQuery() → execute → render table
     - RUN_BACKTEST → BacktestService.runQuick(extracted_params) → render report
     - QUERY_POSITIONS → PaperTradingFacade.getPortfolio() + filter → render
     - EXPLAIN_PICK → AnalysisEngineService.analyzeStock() → render evidence
     - WHAT_IF → PortfolioReturnSimulator.simulate() → render diff
     - SET_ALERT → RiskAlertService.create() → confirm
     - GET_DIAGNOSIS → MultiPostmortemAggregator.diagnose() → render
  4. (如果 task 走偏) fallback to v1 LLM reply
  5. save conversation + result + 自动嵌入下一句的 context
```

### B.3 SQL Builder（QUERY_STOCKS 核心）

```
NaturalQueryToSQL("找今天北向加仓 + RSI 超卖 + 行业 hot")
  ├─→ 分解为 3 个 condition:
  │     (1) 北向加仓 → northbound_holding.hold_volume_yoy > 0 (today)
  │     (2) RSI 超卖 → technical.rsi_14 < 30 (today)
  │     (3) 行业 hot  → market_environment.industry_heat = 'hot'
  │
  ├─→ build SQL:
  │     SELECT s.stock_code, s.name, s.industry, ...
  │     FROM stock s
  │     JOIN northbound_holding nh ON ...
  │     JOIN technical_indicators ti ON ...
  │     JOIN market_environment me ON ...
  │     WHERE nh.hold_volume_yoy > 0
  │       AND ti.rsi_14 < 30
  │       AND me.industry_heat = 'hot'
  │       AND nh.trade_date = CURRENT_DATE
  │     LIMIT 50
  │
  ├─→ execute (safe read-only DB role)
  └─→ render as table (前端 antd Table)
```

### B.4 自然语言 → entity 抽取

```
extractEntities("跑 MFA 策略 topN=50 lookback=20")
  → {
      strategy_key: 'multi_factor_alpha',
      params: { topN: 50, lookback: 20 },
      action: 'run_backtest'
    }

extractEntities("我现在哪些持仓行业集中度 > 25%")
  → {
      target: 'positions',
      filter: { industry_concentration: { op: '>', value: 0.25 } }
    }
```

---

## C. 现状 review

### C.1 已存在

| 文件 | 行 | 现状 |
|---|---|---|
| `backend/src/services/StrategyCopilotService.ts` | 70-77 | ✅ 4 个 intent: EXPLAIN_BACKTEST / SUGGEST_PARAMS / GENERATE_DRAFT / GENERAL |
| `StrategyCopilotService.ts` | 339-393 | ✅ pure function normalizeIntent — 正则 + override 模式 |
| `StrategyCopilotService.ts` | 395-486 | ✅ formatBacktestSummary / buildPromptContext / buildPromptText |
| `StrategyCopilotService.ts` | 505-527 | ✅ parseStrategyDraft（从 LLM 回复抽取 strategy code） |
| `StrategyCopilotService.ts` | 528-722 | ✅ buildHeuristicFallback / buildResponseFromPayload / buildConversationId |
| `StrategyCopilotService.ts` | 759-881 | ✅ class StrategyCopilotService + askCopilot + DI |
| `frontend/src/components/trading/StrategyCopilotPanel.tsx` | — | ✅ 前端对话 panel |

### C.2 关键缺口

1. **只有"对话式"intent**：4 个 intent 全是"问 → 答"，**没有执行式 task**（QUERY / RUN / SET_ALERT 等）
2. **没有 SQL Builder**：用户问"找今天北向加仓 + RSI 超卖"无法 translate 到 SQL
3. **没有 entity 抽取**：normalizeIntent 是正则 hit，但抽不出 (strategy_key, topN=50, lookback=20)
4. **没有 task router**：所有意图都丢给 LLM 回复 free text，没有"调 service 执行 + 拿结果"
5. **没有"对话 context 注入"**：下一句问"那把它扩到 60"，系统不知道指代什么
6. **没有"权限边界"**：用户问"全清持仓"应该 confirm 二次确认而非直接执行
7. **safe SQL execution layer 缺**：直接拼 SQL 有注入风险，缺只读 DB role + query whitelist
8. **没有"执行结果可视化"**：当前 reply 是文本，不是 table / chart
9. **buildHeuristicFallback 弱**：LLM 不可用时只是给一句模板话
10. **没有"task 历史"持久化**：每个 conversation 一次性，无法回看"我上周问过什么"

---

## D. 改造方案

| ID | 故事 | P | 依赖 |
|---|---|---|---|
| CO-001 | 在 `COPILOT_INTENTS` 增加 7 个 task 类型 + `TASK_INTENTS` 集合 | P0 | — |
| CO-002 | 升级 `normalizeIntent`：增加 7 个 task 类型的正则识别 | P0 | CO-001 |
| CO-003 | 新建 `services/copilot/EntityExtractor.ts` pure functions：extractStocks / extractIndustries / extractIndicators / extractNumbers / extractDates / extractStrategyParams | P0 | — |
| CO-004 | 新建 `services/copilot/NaturalQueryToSQL.ts`：分解 condition → 拼 safe SQL；只允许 SELECT；query whitelist 表/字段 | P0 | CO-003 |
| CO-005 | 新建只读 DB role `copilot_readonly`：只能 SELECT，连接池独立 | P0 | — |
| CO-006 | 新建 `services/copilot/TaskRouter.ts`：根据 intent 路由到对应 handler；返回结构化结果 + reply text | P0 | CO-002, CO-003 |
| CO-007 | 实现 7 个 handler：QUERY_STOCKS / RUN_BACKTEST / QUERY_POSITIONS / EXPLAIN_PICK / WHAT_IF / SET_ALERT / GET_DIAGNOSIS | P0 | CO-006 |
| CO-008 | 新建 model `CopilotConversation.ts` + `CopilotMessage.ts`：(user_id, conversation_id, role, intent, entities, result JSONB, ts) + migration | P1 | — |
| CO-009 | conversation context 注入：新 message 调 router 前 inject 最近 5 条 message → 解析 "把它改为 60" 等指代 | P1 | CO-008 |
| CO-010 | 高危 task confirm: SET_ALERT / WHAT_IF (with side-effect) / 涉及实际下单的 task 必须二次 confirm | P0 | CO-006 |
| CO-011 | 前端 `StrategyCopilotPanel.tsx` v2: 多轮 chat UI + 任务执行结果可视化（render table / chart / report 卡片） | P0 | CO-007 |
| CO-012 | 前端结果渲染组件：`CopilotResultTable` / `CopilotResultBacktest` / `CopilotResultAnalysisCard` / `CopilotResultDiff` | P0 | CO-011 |
| CO-013 | 历史会话页面：用户能看到过去 30 天所有 conversation + 结果 | P2 | CO-008 |
| CO-014 | 升级 `buildHeuristicFallback`：失败时给具体可点击的"下一步"建议（"去 LabWorkspace 跑 MFA 回测"链接） | P1 | — |
| CO-015 | SQL 执行 timeout + row limit (默认 1000)：防止重 query 拖垮 DB | P0 | CO-004 |
| CO-016 | Copilot prompt audit log：所有 SQL / task 执行记录 audit log，便于排查 | P1 | CO-006 |
| CO-017 | 集成测试：20 条 prompt → 验证 task routing 准确率 ≥ 80%；SQL 安全（含 SQL injection 尝试 case） | P0 | CO-007 |

---

## E. 验收口径

1. 用户输入"找今天北向加仓 + RSI 超卖 + 行业 hot 的票" → 前端展示结果 table，≤ 5s
2. 用户输入"跑 MFA topN=50 lookback=20" → 自动跑 backtest，≤ 30s 返回结果 + chart
3. 用户输入"我现在哪些持仓行业集中度 > 25%" → 立即返回 filter 后的持仓 list
4. 用户输入"为什么 600519 今天被推荐" → 调 AnalysisEngine 返回 8 dimension evidence
5. SQL injection 攻击尝试被拒绝（10 个 case 测试）
6. 任意 high-risk task（含 SET_ALERT）二次 confirm
7. 多轮对话：第 1 句"找今天北向加仓的票"+ 第 2 句"那把 RSI < 40 也加进去" → 第 2 句结果继承上下文
8. CopilotConversation 表持续累积 → 用户能在历史页看回 30 天对话
9. task routing 准确率 ≥ 80%（20 条 prompt 测试集）
10. `npm test -- copilot/*.test.ts` 全绿
