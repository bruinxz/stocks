# 架构依赖扫描报告

**生成方式**: `node scripts/ci/check_architecture.js`
**生成时间**: 2026-06-01

## 摘要

| 指标 | 数 | 结论 |
| - | - | - |
| .ts 文件数 | 243 | - |
| 循环依赖 SCC | 4 | 全部是 sequelize models 之间的 belongs-to/has-many，**可接受** |
| 跨层违规 | 1 | SchedulerService → LiveTradingService（与上线无关，**记录但不阻塞**） |
| live-trading 未使用 export | 5 | `__resetXForTests`（测试用）+ `LIVE_AUDIT_EVENT_TYPES` 子常量（被字面量匹配规则误报），**预期** |

## 循环依赖详情

### 1. `models/DailyBar.ts ↔ models/Stock.ts`
sequelize 双向关联：`Stock.hasMany(DailyBar)` 与 `DailyBar.belongsTo(Stock)`。这是 sequelize-typescript 推荐写法，运行时无问题，仅在静态扫描里成环。

### 2. `models/{TradingJournal, RiskAlert, PaperTradingSnapshot, PaperTradingTrade, PaperTradingPosition, PaperTradingPortfolio, User, Trade, BacktestResult}.ts`
同上，多张模拟盘相关表互相外键引用形成的 9 节点强连通分量。建议**长期**改为延迟引用（`@ForeignKey(() => require('./X').X)`），但**上线前不动**。

### 3. `jobs/dataUpdateQueue.ts ↔ services/FeishuTaskReportService.ts`
任务队列 enqueue 时调 service 推送，service 又通过 queue 调度重试。这是有意为之的事件回调闭环，**保留**。

### 4. `services/SchedulerService.ts ↔ services/PaperTradingTuningApplyService.ts`
scheduler 调 service，service 又把 scheduler 用作下一次重调。**与实盘无关**，留作后续重构。

## 跨层违规详情

### `services/SchedulerService.ts → live-trading/services/LiveTradingService.ts`
SchedulerService 直接 import LiveTradingService，绕过了顶层路由层。**风险**：scheduler 是计划任务入口，如果误把实盘下单挂到定时任务里，会绕过用户强确认。

**结论**：核对了 SchedulerService 里对 LiveTradingService 的调用都是只读（`getOverview` / `getShadowAutopilotDashboard` 等），**没有调 approveDraft / submitApprovedDraft / requestOrderCancellation 等写接口**，上线安全。

**长期建议**：定义一个 `LiveTradingReadOnlyFacade` 暴露只读视图，禁止 scheduler 引到完整 service。

## 未使用 export

| 文件 | export | 说明 |
| - | - | - |
| `live-trading/middlewares/liveTradingRateLimit.ts` | `__resetRateLimiterForTests` | 单测用，正常 |
| `live-trading/services/LiveAuditAlertService.ts` | `__resetAuditAlertForTests` | 单测用，正常 |

## CI 用法

```bash
# dry-run（报告，但不 fail）
node scripts/ci/check_architecture.js

# 严格模式（循环依赖 / 跨层违规即 exit 1）
node scripts/ci/check_architecture.js --strict
```

**上线前推荐**：跑一次 dry-run 看是否有新增；新增了再单独评估。**不建议**短期内开 `--strict`，否则 sequelize 互引会立刻 fail。后续重构 models 用延迟引用后再开。
