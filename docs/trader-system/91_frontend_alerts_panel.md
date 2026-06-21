# 91 — 前端实时告警面板 + AI 分析弹窗 v2 升级

## A. 操盘手心智

**实时告警面板**是操盘手的"驾驶舱仪表盘"——必须 1 秒内识别"红黄绿"严重度、5 秒内点开看详情、10 秒内决策（清仓 / 减仓 / 观察）。当前 RiskAlert 已有但分散，UI 弱。

**AI 分析弹窗**是个股深度问答的入口——v1 是"5 段研报"展示，v2 需要"8 dimension evidence + 评分可视化 + 数据缺失提示 + 一键加自选/下单"。

两者一起做的原因：都是"信号到决策"的高频路径，UX 上互相联动（告警 click → 弹窗）。

---

## B. 系统设计

### B.1 实时告警面板（AlertsPanel）

```
位置: 全局浮动 / 顶 bar 整合到 PortfolioSelector 旁
触发: 任何 RiskAlert / BlackSwanEvent / FieldGateAdjustment / 数据告警

UI 结构:
┌──────────────────────────────────────────────┐
│ Bell icon + 未读数 badge (顶 nav bar)         │
└──────────────────────────────────────────────┘
  click ↓
┌──────────────────────────────────────────────┐
│ Filter: 全部 / critical / high / medium / low │
│ 分类: 风控 / 数据 / 黑天鹅 / 偏差 / 业绩       │
│ Search: 股票 / 关键字                          │
├──────────────────────────────────────────────┤
│ [critical] 600519 跌停拦截    11:23  click→ │
│ [high]     002230 解禁 5 日前  10:45         │
│ [high]     北向数据缺失        10:30         │
│ [medium]   GROWTH factor IC = 0.018  09:15  │
│ ...                                            │
├──────────────────────────────────────────────┤
│ "标记全部已读"                                 │
└──────────────────────────────────────────────┘

每条 alert 支持:
  - click → 跳详情（如个股 → AIStockAnalysisModal）
  - 一键 "已处理"
  - 一键 "snooze 1h / 1d"
  - 关联 action：清仓 / 减仓 / 加自选
```

### B.2 AI 分析弹窗 v2

```
位置: 全局 Modal（已在 TodayWorkspace/FactorWorkspace/PortfolioWorkspace 嵌入）
触发: 任意股票 click + AI 分析按钮

v1 (现状): 5 段 dimensions + key_points record，纯文本
v2: 8 dimension evidence + 评分可视化

UI 结构:
┌────────────────────────────────────────────────────────────────┐
│ Title: 600519 贵州茅台  |  v2 多维分析                          │
│ Subtitle: action chip (BUY/HOLD/...)  ⭐ confidence ring  风险标签 │
├────────────────────────────────────────────────────────────────┤
│ Section 1: 顶部 Summary                                         │
│   - AI summary 2-3 句                                           │
│   - data_quality verdict (good/partial/critical) banner        │
├────────────────────────────────────────────────────────────────┤
│ Section 2: 8 dimension Score Bars (left column)                │
│   fundamental  ████████████░░░░ +65  (high conf)               │
│   technical    █████████░░░░░░░ +30  (med conf)                │
│   capital      ███████████████░ +85  (high conf)               │
│   news         ████░░░░░░░░░░░░ -20  (low conf, data_missing)  │
│   sentiment    ████████░░░░░░░░ +45  (med conf)                │
│   industry     ███████████░░░░░ +70  (high conf)               │
│   risk         ██░░░░░░░░░░░░░░ -90  (HIGH WARN)               │
│   event        ░░░░░░░░░░░░░░░░  0   (neutral)                 │
├────────────────────────────────────────────────────────────────┤
│ Section 3: per-dimension evidence (展开折叠)                    │
│   每 dimension click → 展开 evidence list                       │
│   每条 evidence: label + direction icon + source tag           │
├────────────────────────────────────────────────────────────────┤
│ Section 4: Action Plan (right column)                          │
│   - entry_zone: [180.5, 185.2]                                 │
│   - stop_loss: 175.0                                           │
│   - take_profit: 200.0                                         │
│   - suggested_position_pct: 5%                                 │
│   - "一键加自选" "一键下买入单" 按钮                            │
├────────────────────────────────────────────────────────────────┤
│ Section 5: data_missing 黄色 banner                             │
│   "本次缺以下数据，结论可能不完整:"                              │
│   - level2_orderbook                                            │
│   - margin_balance                                              │
│   [一键补数据 + 重跑] 按钮                                       │
└────────────────────────────────────────────────────────────────┘
```

### B.3 实时性

```
WebSocket 连接 /ws/alerts:
  - 新 RiskAlert 推送 → 立即 badge 数 +1 + 浮动 toast
  - critical alert → 强制 Modal 弹出（不消失直到点击）
  - update existing alert（如 snooze）→ 状态同步

降级:
  - WebSocket 断 → 30s polling fallback
```

---

## C. 现状 review

### C.1 实时告警 - 已存在

| 文件 | 现状 |
|---|---|
| `backend/src/models/RiskAlert.ts`（推断） | ✅ RiskAlert 模型 |
| `backend/src/services/risk-alert/`（推断） | ✅ RiskAlertService |
| `frontend/src/services/riskAlertService.ts` | ✅ listRiskAlerts / markAlertsAsRead / markAllRiskAlertsRead |
| `frontend/src/pages/workspace/TodayWorkspace.tsx:53-66` | ✅ ALERT_CATEGORY_LABEL 引用；alerts tab |

### C.2 实时告警 - 关键缺口

1. **没有全局浮动告警面板**：告警只在 TodayWorkspace `alerts` tab 内可见
2. **没有 critical 强制弹窗**：critical 级别告警没有"必须确认"机制
3. **没有 WebSocket 实时推送**：依赖用户主动点 tab 才看到
4. **没有"分类筛选"**：风控 / 数据 / 黑天鹅 / 偏差 / 业绩告警全混在一起
5. **没有 snooze 功能**：用户处理不了的告警只能"标记已读"或忽略
6. **没有 action 按钮**：告警 → 必须跳页面再操作，缺一键执行
7. **没有 BlackSwanEvent / FieldGateAdjustment 集成**：这些新事件类型未进 alerts 流

### C.3 AI 分析弹窗 - 已存在

| 文件 | 行 | 现状 |
|---|---|---|
| `frontend/src/components/trading/AIStockAnalysisModal.tsx` | 1-296 | ✅ v1 完整：dimensions / key_points / loading / error / 重新分析 / 4 workspace 嵌入 |

### C.4 AI 分析弹窗 - 关键缺口

1. **完全是 v1 5 段 UI**：metadata.per_dimension 8 dim 完全不读
2. **没有 score bar 可视化**：dimension 是文本展示
3. **没有 confidence ring / risk_level tag**
4. **没有 action plan 区块**（entry/stop/take）
5. **没有 data_missing 提示 banner**
6. **没有"一键加自选 / 一键下单"按钮**：分析完只能关闭，闭环没接上
7. **没有"重跑（补数据）"按钮**

---

## D. 改造方案

### D.1 实时告警面板（10 个 user story）

| ID | 故事 | P |
|---|---|---|
| AL-001 | 新建全局组件 `AlertsBell.tsx`（顶 nav bar）：badge 数 + click 展开 panel | P0 |
| AL-002 | 新建组件 `AlertsPanel.tsx`：filter + search + 分类 tab + alert list | P0 |
| AL-003 | 新建组件 `AlertItem.tsx`：单条 alert 行 + click 跳详情 + snooze + action | P0 |
| AL-004 | 后端 WebSocket route `/ws/alerts`：推送新 RiskAlert / BlackSwanEvent | P0 |
| AL-005 | 前端 WebSocket client + 30s polling fallback | P0 |
| AL-006 | RiskAlert 表加 `snoozed_until` 字段 + migration；snooze 1h/1d/1w 按钮 | P0 |
| AL-007 | critical 告警强制弹窗组件 `CriticalAlertModal.tsx`：用户必须确认或处理 | P0 |
| AL-008 | RiskAlert 表加 `action_suggestions` JSONB 字段；alerts UI 渲染按钮（清仓 / 减仓 / 加自选） | P1 |
| AL-009 | BlackSwanEvent 自动写入 RiskAlert 表 + 标记 category='black_swan' | P0 |
| AL-010 | 数据缺失告警独立 category='data'；UI 黄色 banner 区分 | P1 |

### D.2 AI 分析弹窗 v2（10 个 user story）

| ID | 故事 | P |
|---|---|---|
| AM-001 | `AIStockAnalysisModal.tsx` v2：读 metadata.per_dimension 触发新 UI；旧 5 段降级保留 | P0 |
| AM-002 | 新建 `AnalyzerScoreBar.tsx` 组件：水平 bar -100 → +100 + name + score | P0 |
| AM-003 | 新建 `ConfidenceRing.tsx`：圆环 0-100% confidence + 数字 | P0 |
| AM-004 | 新建 `EvidenceList.tsx`：分组 8 dimension evidence + direction icon + source tag | P0 |
| AM-005 | 新建 `ActionPlanCard.tsx`：entry_zone / stop / take / position_pct 展示 + 一键加自选 / 一键下单按钮 | P0 |
| AM-006 | 新建 `DataMissingBanner.tsx`：黄色 banner 列缺字段 + "补数据并重跑"按钮 | P0 |
| AM-007 | AI summary 2-3 句展示（顶部）：metadata.ai_summary 或 fallback dimensions.summary | P0 |
| AM-008 | data_quality verdict banner: good (绿) / partial (黄) / critical (红) | P0 |
| AM-009 | risk_level tag (low/med/high)：顶部 chip 显示 | P0 |
| AM-010 | "一键下单"按钮 → 弹 PaperTrading order 弹窗（PaperTradingFacade.placeOrder） | P1 |

---

## E. 验收口径

1. 用户登录任意页面，顶部 bell 显示未读 alert 数
2. 新 RiskAlert 在 ≤ 2s 内通过 WebSocket 推送到前端 badge
3. critical alert 必须用户 click 确认才消失
4. Snooze 后 alert 在指定时段不再出现
5. AlertsPanel 支持 filter / search / 分类切换
6. AIStockAnalysisModal v2 在 mode='hard' 时展示 8 dim score bar
7. AnalyzerScoreBar 颜色 + 透明度准确反映 score + confidence
8. EvidenceList 展开/折叠正常，source tag 颜色区分（research/news/kol/etf/policy）
9. ActionPlanCard 显示 entry/stop/take，一键加自选/下单触发对应 service
10. DataMissingBanner 列出至少 1 个缺字段（mock data 验证）
11. WebSocket 断时 polling fallback 5s 内激活
12. 跑 `npm run test` frontend 全绿；lint pass
