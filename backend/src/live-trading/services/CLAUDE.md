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

