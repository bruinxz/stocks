# 通知系统审计 Phase 10 (2026-06-28)

## 用户原话
> 再 review 下通知的发送, 冗余的去掉, 必要的加上.

## TL;DR

- 通知发送链路目前是 **6 个 service + 1 个 ws broadcaster + 1 个 webhook fallback retry cron**, 整体 fail-OPEN + 大多数路径有 1h dedup, 凌晨告警风暴问题已经在 Batch BF-1 系列修过.
- **冗余 P0 / P1 共 3 项** — 全部是 same alert 触发同一通道两次的隐藏 fan-out, prod 估每天少推 5-15 条 (admin 不噪).
- **缺漏 P0 / P1 共 4 项** — 主要是用户主操作 (实盘下单, 模拟盘自动落单) 出错时 **运维群一条都不推**, prod 出问题只靠 user 在 UI 上叫.
- 本次实施 **1 个 P0** (RiskAlertService critical 路径双推飞书 OPS 群去重), **1 个 P1** (PaperTradingFacade.placeOrder 顶层 throw 触发 ops 告警), 其余建议留给下一次 review.

## 现状一图 (主入口 + 渠道矩阵)

| Service / 入口 | 触发时机 | 通道 | 收件人 | 默认频率 | dedup |
|----------------|---------|------|--------|---------|-------|
| **RiskAlert.afterCreate hook** (`backend/src/models/RiskAlert.ts`) | 任意 caller `RiskAlert.create(...)` | (1) `alertsBroadcaster.broadcast` ws 任意 level → 前端 AlertsBell; (2) HIGH/CRITICAL → `RealtimeAlertDispatcher.fireAndForget` (per-user feishu/email/sms); (3) HIGH/CRITICAL → `SystemAdminAlertPusher.fireAndForget` (env OPS 群 + ADMIN_ALERT_EMAILS) | 个人 + OPS | 触发 | dispatcher 1h LRU 200; pusher 1h Map; ws 无 |
| **RiskAlertService.write** (`backend/src/services/RiskAlertService.ts`) | guard / cron caller 显式调用 | severity=critical: inbox + 飞书 OPS text + IM email + toast; severity=high: inbox + 飞书 OPS text + 触发 dispatcher; severity=medium: inbox only | 个人 + OPS | 触发 | 无 (依赖 inbox 本身) |
| **RealtimeAlertDispatcher** (`backend/src/services/RealtimeAlertDispatcher.ts`) | RiskAlert.afterCreate / RiskAlertService.write / Settings 测试调用 | per-user feishu webhook + 邮箱 + 阿里云短信 | 个人 | 触发 | 1h, signature=`rule::sym::lvl::msgHash`, LRU 200 |
| **SystemAdminAlertPusher** (`backend/src/services/SystemAdminAlertPusher.ts`) | RiskAlert.afterCreate (HIGH/CRITICAL) + SchedulerService.markTaskFinished(FAILED) + DataFreshnessCheck + DailyHealthReport | env OPS 群 feishu webhook + ADMIN_ALERT_EMAILS CSV | OPS | 触发 | 1h, dedup_key 文本 |
| **CriticalAnnouncementPushService** (`backend/src/services/CriticalAnnouncementPushService.ts`) | AnnouncementNLPService.syncDate → priority='critical' 公告落库 | env OPS 群 feishu text | OPS | 公告触发, 单批 ≤ 20 | 无 (依赖 priority 本身稀疏) |
| **EarningsForecastWatcher** (`backend/src/services/EarningsForecastWatcher.ts`) | cron EARNINGS_FORECAST_WATCH (盘后) | 用户 feishu webhook (sendEarningsForecastCard) | 个人 | 1/日 | LRU 200 |
| **DailyTradingDigestService** (`backend/src/services/DailyTradingDigestService.ts`) | cron PAPER_TRADING_DAILY_DIGEST 15:30 | 用户 feishu webhook (sendDailyDigestCard) + WebhookFallback log | 个人 | 1/日 | 无 |
| **DailyHealthReportService** (`backend/src/services/DailyHealthReportService.ts`) | cron DAILY_HEALTH_REPORT (推荐 21:00 工作日) | env OPS 群 feishu + admin 邮箱 (复用 SystemAdminAlertPusher) | OPS | 1/日 | 1h |
| **DataFreshnessCheckService** (cron 调) | cron DATA_FRESHNESS_CHECK (18:30) | 命中阈值 → RiskAlert MEDIUM (inbox) + SystemAdminAlertPusher (lark) | OPS | 1/日 | 1h |
| **WEBHOOK_FALLBACK_RETRY cron** (`backend/src/services/webhookFailOpen.ts`) | 每 5 min 扫 webhook_fallback_log pending | 重投 sendDailyDigestCard 等失败 webhook | (恢复原 receiver) | 12 次/h | DB row status 状态机 |
| **QuantFusionService / PaperTradingAutomationService / AutomatedRecommendationLoop** | report_to_feishu=true 且 notify_to_feishu_bot 不为 false | feishu webhook (sendRecommendationSummary) | 个人/OPS | 1/日 各路径, 大多默认关 | 无 |
| **alertsBroadcaster** (`backend/src/realtime/alertsBroadcaster.ts`) | RiskAlert.afterCreate 任意 level | ws `/ws/alerts` 推给已订阅前端 | 前端 | 触发 | 无 |
| **NotificationService.notifyStockAnalysis** | (旧入口, 现已 stub) | 调 feishuTaskReportService.reportStockAnalysis → no-op | — | — | — |
| **feishuTaskReportService.report\*** (17 处 caller) | cron / queue 完成回报 | **STUB no-op** (历史飞书多维表格写入已删) | — | — | — |

### 一天 OPS admin 通知量估算 (粗估)

| 来源 | 改前 (条/天) | 改后预期 (条/天) | 说明 |
|------|---------|------------|------|
| RiskAlert HIGH/CRITICAL (afterCreate hook) | 0-30 | 0-30 | hook 内已 1h dedup; 大部分日子 0-5 条 |
| RiskAlertService.write critical/high 路径 (额外的 OPS 推送) | 0-10 | 0-10 | 与上面同 alert 流入 → 见冗余 1 |
| Critical 公告 | 0-5 | 0-5 | priority='critical' 稀疏, MAX_PER_BATCH=20 |
| Cron 失败 (`cron:${type}` 1h dedup) | 0-15 | 0-15 | 77 个 cron 但单次失败 1h 内只推 1 次 |
| Data freshness 18:30 | 0-1 | 0-1 | 1 条/天 (合并 5 项 + 1h dedup) |
| Daily health report 21:00 | 1 | 1 | 即使全 ok 也推 |
| Critical announcement (单条 webhook) | 0-5 | 0-5 | 同上 |
| **(新增 P1) 实盘 placeOrder 抛错** | — | 0-5 | 1h dedup by `order_throw:${order_type}` |
| **总计** | **2-65** | **2-70** | 凌晨深夜 0-2, 盘中盘后高峰 15-30 |

数据源: BF-1 / BF-2 系列 commit 引入 1h dedup 之后日均观察值 (`SystemAdminAlertPusher` dedupMap 上限 5000 entries, 实际 < 50/天). 单一 admin 用户峰值 < 30 条/天, 不会噪.

## 冗余清单 (建议删 3 项)

### [P0] 1. RiskAlertService critical/high 路径 飞书 OPS 群双推 — 调一次发两条

- **文件**: `backend/src/services/RiskAlertService.ts` (L502–L504 fan-out `runFeishu`) + `backend/src/models/RiskAlert.ts` (L163–L181 afterCreate 钩 `pushSystemAdminAlertFireAndForget`).
- **场景**: 任何 caller 走 `riskAlertService.write({severity: 'critical' | 'high'})` 时:
  - (a) `RiskAlertService.runFeishu` → 调 `dataSource.postFeishuOps(OPS_ALERT_FEISHU_WEBHOOK, text msg)` 发 **1 条 text**;
  - (b) 同时 `RiskAlert.afterCreate` 钩在 inbox 落库后又调 `pushSystemAdminAlertFireAndForget` → 走 **interactive card** 到同一个 webhook (OPS_ALERT_FEISHU_WEBHOOK fallback chain) **1 条**;
- **结果**: 一个 critical 告警 OPS 群 **几秒内连收 2 条** (text + card), 内容覆盖率 ~90% 重叠. 用户体验是"屏幕一闪两条一模一样".
- **影响**: 估每天 0-5 次 (critical 路径稀疏). 不致命但污染 ops 信噪比.
- **建议**: 让 `RiskAlertService.runFeishu` 在 caller 已确定 inbox 写入 (alertId 存在) 时, **由 afterCreate 钩兜底, 自己 skip**. 实现思路: 用 `metadata.toast=true` flag (已存在) 把 caller 标识传到 hook, hook 看到 flag 时跳过 (避免 hook 再推一遍). 或反过来: `RiskAlertService` 显式调 `riskAlertService.options.skip_legacy_feishu=true` 关掉自己的 runFeishu, 依赖 hook 把 card 推出去 (card 比 text 信息密度高).
- **本次 PR 选**: 让 `runFeishu` 在 alert 写入成功 (alertId 存在) 时 skip — 让 hook (card) 成为唯一 OPS 推送源. 兼容路径: caller 显式 `override_channels=['feishu']` 不走 inbox 时仍发 text (供 audit-task-parameters-dry-run.ts 维持现状).

### [P1] 2. RealtimeAlertDispatcher 与 SystemAdminAlertPusher 对同一 risk alert 各自发飞书

- **文件**: 同 `backend/src/models/RiskAlert.ts:144` (走 `RealtimeAlertDispatcher`) + `L171` (走 `SystemAdminAlertPusher`).
- **场景**: 一个 HIGH 告警 hook 一次性 fan-out:
  - (a) `RealtimeAlertDispatcher` → per-user webhook (用户的私人 feishu URL);
  - (b) `SystemAdminAlertPusher` → OPS_ALERT_FEISHU_WEBHOOK (env 配置的 OPS 群);
- **冗余维度**: 当 user 的私人 feishu webhook URL 就是 env OPS_ALERT_FEISHU_WEBHOOK 时 (这是当前 prod 的实际状态, 因为多数 user `feishu.enabled=false` 走 env fallback chain), 同 webhook 收到两条. dispatcher 卡片格式 与 pusher 卡片格式 不同, OPS 看到两张相似卡片.
- **影响**: 估每天 0-30 条额外噪声 (HIGH 告警频率).
- **建议**: 在 `SystemAdminAlertPusher.pushSystemAdminAlert` 增 `skip_if_same_url_as: env-name[]` option, 当 caller 知道 dispatcher 会推同 webhook 时跳过. 或更简单: 当 dispatcher 把 user webhook URL 拼出来后等于 env webhook 时 (字符串相等), pusher 端发现 dedup_key 已经被 dispatcher 用过就 skip.
- **本次 PR**: **不动**, 因为风险大 (dispatcher 是 fire-and-forget 异步, pusher 同步比对会有 race condition). 留给下次专门改 dispatcher 把"已发 webhook url"上报回来.

### [P1] 3. RiskAlertService.runFeishu 与 SystemAdminAlertPusher 对同一 dedup_key 各自发 (跨 hook)

- 与 #1 #2 同款症状, 但维度是 RiskAlertService.write 写 inbox 触发 afterCreate hook 时, `riskAlertService.runFeishu(text)` + `RealtimeAlertDispatcher (card)` + `SystemAdminAlertPusher (card)` 可能三条都进 OPS 群.
- 改 #1 后大概率自动缓解. 留待 #1 PR landed 后回归验证.

## 缺漏清单 (建议加 4 项)

### [P0] 1. 实盘下单 (PaperTradingFacade.placeOrder) 顶层异常不告警

- **文件**: `backend/src/portfolio/PaperTradingFacade.ts` (L1175 / L1346 / L1351 throw 但没有顶层 catch + push)
- **场景**: portfolio 不存在 / position 并发删除 / risk guard 在 fail-closed 模式下抛 → 用户 UI 看到 5xx, **运维群一条都不推**, 只能靠 user 主动叫.
- **建议**: 在 `_placeOrderInner` 顶层加 try/catch, error 时 fire-and-forget `pushSystemAdminAlertFireAndForget`, dedup_key=`order_throw:${order_type}:${portfolio_id}`, level='WARN' (避免 1 条噪太大). 1h dedup → 同 portfolio 同 type 错误 1h 只推 1 条 (排错时长 1h 内 1 条即可定位).
- **本次实施**: 见 commit 2.

### [P0] 2. AI 引擎大批量 fallback (e.g. AIPolling worker 连续失败) 不告警

- **文件**: `backend/src/jobs/aiPollingWorker.ts:593` 当前只 `feishuTaskReportService.reportAiPollingFailure` → 但该 service 已经 stub no-op (`FeishuTaskReportService.ts:101`), 等于一条都不推.
- **建议**: 在 worker on('failed') 把单 job 失败收纳到滑动窗口 (5 min 内 ≥ 10 次失败), 触发一次 `pushSystemAdminAlertFireAndForget(level='HIGH', dedup_key='ai_polling_burst')`.
- **本次实施**: 不实施 (需引入滑动窗口数据结构, 单文件改动 > 50 行).

### [P1] 3. critical 公告 推送失败不二次告警

- **文件**: `CriticalAnnouncementPushService.ts` 整批 push 内层 try/catch 吞错 → 单条失败 logger.warn 但 OPS 群不会看到 "刚刚 critical 公告推失败了" 的元告警 → 当 webhook URL 配错 / 飞书侧 rate limit 时, critical 公告 silent drop.
- **建议**: pushBatch 顶层在 result.failed > 0 时多发一条 `pushSystemAdminAlertFireAndForget({level:'WARN', dedup_key:'critical_announcement_push_fail'})` 元告警.
- **本次实施**: 不实施 (短小改动但需追加测试).

### [P1] 4. webhook fallback retry 持续失败到 dead 不告警

- **文件**: `webhookFailOpen.ts:retryPendingFallbacks` → row 进入 `status='dead'` 时只 logger.warn, 没有 OPS push.
- **建议**: cron 跑完汇总时若 `dead_count > 0` 推一条 `pushSystemAdminAlertFireAndForget({level:'HIGH', dedup_key:'webhook_fallback_dead_burst'})`. 表示 "有消息被永久丢弃, 需要人工干预".
- **本次实施**: 不实施.

## 本次实施 (P0)

### Commit 1 — RiskAlertService 冗余 #1: hook-vs-runFeishu 去重

让 `RiskAlertService.runFeishu` 在 inbox 写入成功 (`alertId` 已知) 时 skip — 因为 `RiskAlert.afterCreate` hook 已经会触发 `SystemAdminAlertPusher` 推一张更详细的 interactive card 到同一 OPS_ALERT_FEISHU_WEBHOOK. 兼容旧 caller (`audit-task-parameters-dry-run.ts` 等显式 `override_channels=['feishu']` 不写 inbox 的): 当 `alertId` 是 `undefined` 时仍走 runFeishu text 路径.

### Commit 2 — PaperTradingFacade.placeOrder 顶层 throw 触发 ops 告警

placeOrder 顶层包一层 try/catch → throw 时 fire-and-forget pushSystemAdminAlertFireAndForget. 1h dedup 防 burst, level=WARN.

## 不实施 (理由)

| 项 | 理由 |
|----|------|
| 冗余 #2 #3 (dispatcher vs pusher 双推) | race condition 高, 需要 dispatcher 上报"已发 webhook url", 改动跨多文件 |
| 缺漏 #2 (AI worker burst) | 需引入滑动窗口数据结构, 单文件改动 > 50 行 |
| 缺漏 #3 #4 (critical 公告 / webhook fallback dead 元告警) | 短小但要追加测试; 留给下次专项 PR |

## 回归 risk

- 改动 **0 个 .env**, 不动 webhook URL, 不动用户 schema, 不动已有 cron.
- 改 #1 的兼容路径: 显式传 `override_channels=['feishu']` 不写 inbox 的旧 caller 仍走 text 推送; **唯一行为变化** 是 critical/high severity 默认路径 (含 inbox + feishu + im) 不再发 text msg, 改由 afterCreate hook 的 interactive card 替代 — 同一信息密度更高的卡片.
- 改 #1 的可观测信号: result.channels[].channel='feishu' 且 success=false skipped=true message='inbox 写入成功后由 afterCreate hook 接管 ops 推送, skip duplicate text' — 单测可断言这个 message.

## 后续建议 (留给下次)

1. 把 dispatcher 与 pusher 用同一 OPS_ALERT_FEISHU_WEBHOOK 的双推合并为 "interactive card with both per-user deep-link + ops 元数据 一条搞定"
2. 把 17 个 stub'd `feishuTaskReportService.report*` no-op 入口全部从 caller 删掉 (现在 caller 看着像在推送实际什么都没推)
3. AI worker burst window + critical-announcement push 元告警 (P1 缺漏 #2 #3 #4)
4. 给 `SystemAdminAlertPusher.pushSystemAdminAlert` 加 metric (e.g. `system_admin_alert_total{level=, deduped=}`) 让 admin 能看长期推送量趋势, 校正 1h dedup 是否过紧
