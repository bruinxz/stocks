# 75 — 黑天鹅事件复盘（Black-Swan Postmortem）

## A. 操盘手心智

每年都会发生 3-5 次"黑天鹅"——单日 > 5% 跌（或涨）、系统异常、风控触发、监管事件、个股暴雷。每次事件后必须问 4 个问题：

1. **系统是否预警**？事件发生前 1-3 天，watchdog 有没有给出 alert
2. **风控是否触发**？kill-switch / circuit-breaker / position-limit 是否按预期工作
3. **实际损失多少**？比"什么都不做"亏多少 / 比"完全清仓"亏多少 / 比"按预案执行"亏多少
4. **应改进什么**？是数据没接到？规则没设？阈值太宽？bridge 失联？

**复盘必须 24 小时内出**——晚了情绪会美化或丑化判断。

---

## B. 系统设计

### B.1 触发条件（自动检测）

```
30 min cron `BLACK_SWAN_DETECTOR`
  ├─→ 检测 5 类信号:
  │     1. 单日组合 pnl < -3%
  │     2. 沪深 300 单日跌 > 4% OR 涨 > 4%
  │     3. RiskAlert 出现 level='critical'
  │     4. 任一持仓单股单日跌停 (-10%)
  │     5. broker-bridge fail 持续 > 10 min
  │
  ├─→ 命中任一 → enqueue BlackSwanPostmortem job
  └─→ 30 min 内生成报告 + 飞书推送
```

### B.2 报告结构（4 段）

```
Section 1: 事件概述
  - 触发时间 / 触发类型 / 影响范围
  - 当时大盘环境 / regime / 行业涨跌排名

Section 2: 系统响应轨迹
  - 事件前 1-3 天: 所有 RiskAlert / EventIntelligenceLayer.filter 结果
  - 事件当天: 风控触发记录（kill-switch / drawdown-breaker / position-limit）
  - 事件当天: 实际 trade 记录（buy / sell / abort）

Section 3: 损失量化
  - 实际 P&L vs 4 种 baseline:
    (a) 不动（hold-all）
    (b) 全清仓（zero）
    (c) 按预案执行（按 risk_config 设定的阈值）
    (d) 完美避险（事件前 1 天全清）
  - 哪些持仓受损最大 / 受益最大

Section 4: 改进建议
  - 检测短板（什么信号没接到 / 接到了没用）
  - 风控短板（什么规则没触发 / 触发了无效）
  - 流程短板（人工反应是否及时）
  - 配置短板（阈值是否过宽 / 过严）
```

---

## C. 现状 review

### C.1 已存在（部分）

| 文件 | 行 | 现状 |
|---|---|---|
| `backend/src/portfolio/risk/BlackSwanWatchdog.ts` | — | ✅ 黑天鹅 pre-trade 检测（ST 公告 / 退市预警 / 重大诉讼 / 减持暴增） |
| `backend/src/portfolio/risk/DrawdownCircuitBreaker.ts` | — | ✅ 组合最大回撤熔断（已修 fail-closed） |
| `backend/src/portfolio/risk/MarketRegimeAlertService.ts` | — | ✅ 市场环境警报 |
| `backend/src/services/RiskAlert*` 系列 | — | ✅ RiskAlert 模型 + 服务 |
| `backend/src/services/event-intelligence/EventIntelligenceLayer.ts` | — | ✅ 6 类事件 → 5 种 MetaFilterAction |
| `backend/src/portfolio/risk/MorningRiskCheckupService.ts` | — | ✅ 晨间体检 |

### C.2 关键缺口（黑天鹅事后复盘 = 0）

1. **完全没有"事后复盘"主入口**：BlackSwanWatchdog 是 `pre-trade gate`（事中阻断），不是"事后复盘"
2. **没有"事件检测器 + 自动触发"**：当前所有 watchdog 都是被动响应（trade-time），缺主动巡检"今天是不是黑天鹅"
3. **RiskAlert 表存在但**没有"事件聚合"概念：100 条相关 alert = 1 个 black-swan event，缺归集
4. **没有"4 baseline 反事实分析"**：当前损失只能看实际数字，不能跟 hold/zero/plan/perfect 对比
5. **没有"事件前 N 天的所有 watchdog 输出回放"**：debug 短板时无法快速复盘
6. **没有"改进建议自动归类"**：人工写 root cause 慢

### C.3 历史事件库缺失

完全没有 `black_swan_events` 表持久化历史事件 → 无法跨事件对比 → 无法回答"今年系统已经被黑了几次"

---

## D. 改造方案

| ID | 故事 | P | 依赖 |
|---|---|---|---|
| BS-001 | 新建 model `BlackSwanEvent.ts`：(id, detected_at, event_type, severity, scope JSONB, affected_portfolios JSONB, status 'detecting'/'analyzing'/'reported') + migration | P0 | — |
| BS-002 | 新建 model `BlackSwanPostmortemReport.ts`：(event_id, generated_at, sections JSONB, baselines JSONB, recommendations JSONB) + migration | P0 | BS-001 |
| BS-003 | 新建 `services/black-swan/BlackSwanDetector.ts`：30min cron 巡检 5 类信号 | P0 | BS-001 |
| BS-004 | 新建 `services/black-swan/BlackSwanPostmortemService.ts`：触发后 30min 内生成 4 段报告 | P0 | BS-002 |
| BS-005 | 新建 `services/black-swan/CounterfactualBaselineCalculator.ts`：4 种 baseline 反事实模拟（hold/zero/plan/perfect） | P0 | — |
| BS-006 | 新建 `services/black-swan/EventTimelineReplayer.ts`：拉取事件前 N 天的 RiskAlert / EventIntelligenceLayer.filter 输出 / Watchdog 触发记录 → 时间轴 | P0 | — |
| BS-007 | 新增 `services/black-swan/ImprovementSuggestor.ts`：根据 4 类短板（检测 / 风控 / 流程 / 配置）自动归类 + 模板生成建议 | P1 | BS-006 |
| BS-008 | SchedulerService 注册 cron `BLACK_SWAN_DETECT`（每 30min） + `BLACK_SWAN_POSTMORTEM_DRAINER`（处理 queue 任务） | P0 | BS-003 |
| BS-009 | RiskAlert 增加 `black_swan_event_id` 字段：关联到 event；BlackSwanDetector 自动归集 | P1 | BS-001 |
| BS-010 | 飞书推送 BlackSwanPostmortem：标题 + summary + 4 baseline 对比表 + 改进建议 | P0 | BS-004 |
| BS-011 | admin route `GET /api/admin/black-swan/events` + `GET /api/admin/black-swan/events/:id/report`：查历史 | P1 | BS-002 |
| BS-012 | 前端 SettingsWorkspace `/black-swan` tab：历史事件列表 + 详情页（含时间轴 + 4 baseline 图） | P2 | BS-011 |
| BS-013 | 季度报告：每季度初汇总"过去一季度黑天鹅事件 N 次 / 系统命中 X 次 / 改进采纳 Y 项"，发邮件给 trader | P2 | BS-002 |

---

## E. 验收口径

1. 故意制造一个测试事件（mock 单日跌 5%）→ 30 min 内 `BlackSwanEvent` 表新增记录 + `BlackSwanPostmortemReport` 落库
2. 报告 4 段齐全，含 4 baseline 数字 + ≥ 3 条改进建议
3. 飞书推送在 1 小时内送达
4. RiskAlert 自动关联到 event（black_swan_event_id 非空 ≥ 80%）
5. 用户能在 SettingsWorkspace 看到过去 90 天所有事件 + 详情
6. 季度报告显示"已采纳改进 / 待办改进"数量
7. `npm test -- black-swan/*.test.ts` 全绿
