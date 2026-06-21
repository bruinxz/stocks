# backend/src/live-trading/services — 实盘交易服务层

## bridgeFailSafe.ts — US-018 (EX-004) broker-bridge fail-safe 统一 helper

**职责**: KillSwitch 触发 / bridge 失联 时, 把所有 `live_broker_commands` 表中处于
`pending` / `dispatching` / `dispatched` 状态的命令"安全停掉", 防止 bridge 重启
或下次 pull 时把熔断窗口内的指令送进券商通道执行真单.

**契约**:
- `pending` 命令: 还没被 bridge 取走 → 直接 `status='aborted'` + `metadata.killed=true`
- `dispatching` / `dispatched` 命令: bridge 可能已在执行 → 不强改 status (避免 bridge
  ack 时 race), 只在 metadata 标 `killed=true` 让 bridge 自行识别并拒执行
- fail-safe: pending/inflight update throw 会上抛给 caller 决定 (KillSwitchService 用
  `.catch` swallow); audit 写入 throw 被 helper 内部 swallow + log warn, 永不阻塞主流程

**接入**: `KillSwitchService.abortPendingCommands` 是薄 wrapper, 调用
`abortBridgeCommandsOnKillSwitch(createProductionBridgeFailSafeDataSource(), {...})`.
未来若需在 `BlackSwanEvent` / `MarketRegimeAlert` 等场景也批量停掉 in-flight 命令,
复用同 helper 即可, **不要** 在新地方 inline 写 `LiveBrokerCommand.update`.

**测试**: `tests/live-trading/bridge-fail-safe.test.ts` 注入 fake `BridgeFailSafeDataSource`
完整覆盖 happy path + 部分 throw + audit fail-safe + meta-guard (KillSwitchService 不再
inline 拼 SQL). DB-less, 79 ok.

**未来扩展提醒**:
- 新增 abortable 状态码 → 加到 `ABORTABLE_COMMAND_STATUS` 或 `IN_FLIGHT_COMMAND_STATUSES`
  常量, 同步更新 `tests/live-trading/bridge-fail-safe.test.ts` 的 `testConstants`
- 新增 caller 用 helper 之前先看 GUARD pattern (`fail-safe + DataSource DI seam`),
  与 portfolio/risk/RiskGuardFailClosed.ts 是对偶设计 (一个 fail-CLOSED 一个 fail-safe)

## 既有约定 (审计 + 告警)

- `LiveAuditAlertService.sendLiveAuditAlert` 是飞书/IM 推送统一入口, severity ≥ error 默认推,
  warning 需 `LIVE_ALERT_INCLUDE_WARNING=true` opt-in. 单测在同目录 `LiveAuditAlertService.test.ts`.
- `KillSwitchService.trigger` 幂等: 已有 active 记录走 append metadata 路径, 不再 emit
  `kill_switch_triggered` 事件 (避免 SSE 反复断连). 真要"再次提醒"靠前端定期拉 detail.
- `LiveExecutionAuditLog` 写入失败一律 swallow + log error/warn, 不阻塞主流程.

## US-108 (EX-008) runShadowAutopilot 幂等 — autopilot 任务统一入口去重

**两层幂等**:
1. **进程内入口去重** — `LiveTradingService.runShadowAutopilot` 入口已包 `getDefaultAutopilotIdempotencyStore().run({task,user_id,source,window:dailyWindow(),extra:{dry_run,limit,account_role}}, {ttl_ms:30_000}, worker)`. 同 key 30s 内重复触发返 cached + `reused_from_idempotency=true` 标记; 并发同 key 调 worker 只跑 1 次 (in-flight join). 真实工作体在私有 `_runShadowAutopilotUncached(...)`, **不要** 在外部直接调它 — 必走 `runShadowAutopilot` 入口才有幂等保护.
2. **DB 层强幂等** — `markDraftShadowExecuted` 用 transaction + SELECT FOR UPDATE 防并发把同 draft 双标为 shadow_executed (BETA-4, audit M-16). 跨进程靠这层兜底.

**未来扩展提醒**: 新加 autopilot 类入口 (e.g. `runSignalAutopilot` / `runRiskAutopilot`) 复用 `backend/src/utils/autopilotIdempotency.ts` 同款 store, key 必须把"会改变业务语义"的参数全放进 `extra`. 不要 inline 写 in-flight Map. 测试在 `tests/live-trading/autopilot-idempotency.test.ts`, META-GUARD fs+regex 守 wiring 单一事实源.


## US-137 [EX-012] ReconciliationAlertConfig — 阈值持久化

之前 `classifyReconciliation` 4 个阈值硬编码 (HIGH<70 / MEDIUM<85 / drift>3 / drift>=1). 现在
持久化到 `User.risk_config.live_reconciliation_alert` JSONB, 与 8 个 risk guard 同款
`getConfig`/`updateConfig` + `normalizeXxxConfig` lenient + `Object.freeze` DEFAULT 范式.

**API 三件套**:
- `DEFAULT_RECONCILIATION_ALERT_CONFIG` (frozen, 与 v1 hardcoded 值完全等价 — 用户没改 →
  零行为漂移)
- `normalizeReconciliationAlertConfig(raw)` (沉默 fallback 默认; 内部一致性兜底: medium
  阈值 < high 时静默 swap, 防 MEDIUM 永远被 HIGH 决策覆盖)
- `service.getConfig(user_id)` / `service.updateConfig(user_id, raw)` (JSONB 写法
  `changed('risk_config', true)`)

**接入点**:
- `classifyReconciliation` 新增 optional `thresholds?: ReconciliationAlertConfig` 参数;
  缺省走 DEFAULT, 与 v1 hardcoded 行为完全一致 (backward compat, 既有单测 0 改动).
- `runForUser` 启动时先 `this.getConfig(user_id)` (fail-OPEN 用 DEFAULT). `cfg.enabled=false`
  时整 user 跳过. `dedupe_window_ms` 优先级: options > cfg.dedupe_window_minutes*60_000 >
  `DEDUPE_WINDOW_MS_DEFAULT`.
- HTTP: GET/PUT `/api/risk/reconciliation-alert` (RiskController + risk.routes.ts).
- UI: `SettingsWorkspace.RiskParametersCenterTab.tsx` 第 9 个 section.

**单测**: `tests/services/ReconciliationAlertService.test.ts` 新增 9 个 case 覆盖 DEFAULT
frozen / normalize empty / lenient invalid / happy / swap inverted thresholds / custom
threshold HIGH branch / custom threshold drift_relaxed / backward compat / extreme
threshold disables alerts (63 ok 总).


## US-138 [EX-013] fillAnomalyClassifier — 实盘 fill 异常分类

把 `live_broker_commands` 终态映射成 10 个归一化类别 (`filled_full` / `partial_only` /
`cancelled_unfilled` / `cancelled_partial` / `rejected` / `failed` / `expired` / `aborted`
/ `in_flight` / `unknown`), 是"运营 / 风控关注的 fill 异常率" 的事实源.

**主入口**: `classifyFillAnomaly(cmd)` 纯函数 + `aggregateFillAnomalies(iter)` 聚合; service
层 `LiveTradingService.getFillAnomalyStats(user_id, {since_hours, sample_per_category})`
查表后归类 + 提供 per-category 最近 N 条样本. HTTP: `GET /api/live-trading/fill-anomaly-stats`.

**关键设计**:
- 区分 `cancelled_partial` (撤单部分成交, 用户主动) 和 `expired` (TTL 过期, 系统被动) —
  filled>0 但 status='expired' 仍归 `expired`, 不归 `cancelled_partial`
- `failed` 状态走 metadata 二次分类: `error_kind='rejected_by_broker'` /
  `reason_code='reject_*'` / `rejected=true` → `rejected`; 其余 → `failed`. 与"网络/bridge
  异常"区分开, 让运营能识别"是券商拒了还是 bridge 挂了"
- `cancel_order` command 单独分支: 它的 status 描述的是"撤单这条指令的归宿", 不是"被撤的
  place_order 是否部分成交". cancel + cancelled/filled = `filled_full` (达成意图), cancel +
  failed = `failed`. 防 stats 双计.
- `ANOMALY_CATEGORIES` Set 显式排除 `filled_full` / `in_flight` / `unknown`, anomaly_rate =
  anomaly_total / terminal_total (in_flight 不进分母).
- 全部 `Object.freeze` (枚举数组 + label 字典) 防意外 mutate (与 US-137 reconciliation 同款)

**未来扩展提醒**:
- 新加终态 status (e.g. `auto_cancelled_by_market_close`) 必须同步加到 `classifyFillAnomaly`
  switch 分支 + `FILL_ANOMALY_CATEGORIES` + `FILL_ANOMALY_CATEGORY_LABELS` + 单测覆盖,
  否则会落到 `unknown` 桶 (告警没法 wireup)
- 想把 fill 异常率写入 RiskAlert / 飞书告警 → 参 ReconciliationAlertService 套路新加
  `FillAnomalyAlertService`, 不要在 `LiveTradingService.getFillAnomalyStats` 里硬塞告警逻辑
  (HTTP only-read 入口与定时 alert scan 应该解耦)

**单测**: `tests/live-trading/fill-anomaly-classifier.test.ts` 52 ok DB-less, 覆盖全枚举映射 +
rejected metadata 三种触发条件 + cancel_order 单独分支 + aggregate counters + 不变量
(frozen / label key 对齐 / ANOMALY_CATEGORIES 排除集).
