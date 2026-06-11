# 实盘交易系统 整体 Review #2 报告

**review 时间**: 2026-06-01
**范围**: 本轮 P0/P1 修复回归 + broker-bridge 全链路 + 灰度账户与 LiveTrading 前端 + 全仓 P0/P1 新增问题挖掘
**结论**: 上一轮 #1–#46 修复全部回归正常，本轮新发现 5 项需要立刻落地的问题（其中 1 项 P0、4 项 P1）和 3 项可清理的 P2。所有新发现问题本 commit 已修复。

---

## 一、本轮 P0/P1 修复回归（task #1–#46）

逐条核对全部通过：

- 鉴权 / 签名：bridgeAuth 写请求强制 `application/json`、HMAC base 含 canonicalized query、rawBody 由 `express.json({ verify })` 钩子注入，签名通过后才 INSERT nonce（跨进程去重 + 重放防御），逻辑正确。
- 状态机：`BridgeService.advanceCommandStatus` 用 `WHERE status NOT IN terminal` 原子 UPDATE，dry-run 前缀 `dryrun-*` 在 server 侧识别后只标 failed，不会污染 `live_orders.broker_order_id`。
- `submitApprovedDraft` 整段事务（LiveOrder + LiveBrokerCommand + draft）三同生同灭，事务回滚后将 draft 回到 pending 让用户重提。
- `replacePositions` 空集合保护 + 幽灵清零都在事务里，OK。
- `ingestOrders / ingestTrades` 逐条独立事务，单行 unique 冲突走 skipped 不污染全批，OK。
- `runAutoTriggerScan` per-account 维度，避免一个账户拖累全网。
- TTL 巡检 + nonce 清理都通过 `setInterval(...).unref?.()` 不阻塞测试退出，OK。
- 前端灰度账户切换 + 撤单按钮 disabled 条件、CONFIRM 文本、cancellable 状态判断，均与后端约束一致。

## 二、本轮新发现的问题

### P0 — JWT_SECRET 在 production 也回退到硬编码兜底
**位置**: `backend/src/middlewares/auth.ts:50`、`backend/src/api/controllers/AuthController.ts:20-22`
**影响**: 任何拿到源码或推断出 `your-secret-key-change-in-production` 字面量的人，都能自签 `role: admin` 的 JWT，绕过所有鉴权（包括 LiveTrading 全部接口、刚收紧的 kill_switch admin 路由）。
**修复**: production 环境必须显式配 `JWT_SECRET / JWT_REFRESH_SECRET`；缺失时立即 500 拒签拒验。dev 环境允许 `LIVE_DEV_JWT_SECRET` 兜底，但不再使用任何字面量。

### P1 — 任意已登录用户能触发 / 解除全局 kill switch
**位置**: `backend/src/live-trading/routes/liveTrading.routes.ts:31-32`
**影响**: kill switch 是进程级开关，一个普通用户调 `/kill-switch/trigger` 就把所有用户的下单接口熔断；恶意用户也能 `/kill-switch/resolve` 把运维触发的熔断解除。
**修复**: trigger/resolve 加 `requireRole('admin')`；GET 状态查询保留对所有用户开放（前端风控展示需要）。

### P1 — 用户并发点撤单按钮会产生多条 cancel_order command
**位置**: `backend/src/live-trading/services/LiveTradingService.ts: requestOrderCancellation`
**影响**: 同一 `order_id` 已有未终态 cancel 命令时，再次点击会再写一条；bridge 会向券商发两次撤单，券商日志和 `LiveBrokerCommandDispatch` 都会出现假阳性"漏单"。
**修复**: 入队前先查同 `order_id + command_type='cancel_order'` 且状态在非终态集合内的命令，命中即复用并写一条 `live_order_cancel_dedup` 审计，不再额外入队。

### P1 — BridgeCommandExpiryService 把已被推走的命令盖回 expired
**位置**: `backend/src/live-trading/services/BridgeCommandExpiryService.ts: scanCommandsExpired`
**影响**: `findAll` 拿到 pending/dispatched 一批后，在循环到某行执行 `row.update({ status: 'expired' })` 之前，可能有 bridge 事件先把该命令推到 submitted/partially_filled —— 这里 update 不带 WHERE 原状态条件，**直接把 submitted 行盖回 expired**，订单实际已委托但被错误标终态。
**修复**: 改为 `LiveBrokerCommand.update({ status: 'expired' }, { where: { id, status: NOT terminal, expires_at < now } })`。count=0 表示已被推走，不再写审计；联动的 LiveOrder.bridge_status update 也加 NOT IN terminal 保护。

### P1 — LiveOrder 缺 (account_id, broker_order_id) unique 约束
**位置**: `backend/src/models/LiveOrder.ts`，`BridgeService.ingestOrders` 把它当幂等键
**影响**: 模型没有 unique 兜底，bridge 并发 push 同 `broker_order_id` 多次，`findOne` 不命中就 create —— 数据库里会出现重复 LiveOrder。后续撤单 / 对账以为重复了券商委托号。
**修复**: model 加复合非唯一索引提示；`ensureLiveTradingRuntimeSchema` 创建 `partial unique (account_id, broker_order_id) WHERE broker_order_id IS NOT NULL`，与 `client_order_id` 的 partial unique 同型。

### P2 — KillSwitchService 自动巡检遗漏 last_sync_at 路径
**位置**: `backend/src/live-trading/services/KillSwitchService.ts: runAutoTriggerScan` 账户异常分支
**影响**: 注释承诺"connection_status=error 或 last_sync_at 超 24h 仍 active"两条路径，但代码只检查 connection_status，第二条永远不会触发。
**修复**: 补 `staleSyncCutoff = now - 24h`，account.last_sync_at < cutoff 时也触发 `account_anomaly` 熔断，metadata 带 `stale_hours`。

### P2 — Python canonicalize_query 与 Node encodeURIComponent 字节不对齐
**位置**: `integrations/broker-bridge/bridge_common/auth.py`
**影响**: Python `quote(safe="~")` 会编码 `! * ' ( )` 五个字符，Node `encodeURIComponent` 不编码。query 含这些字符的请求两端签名串不一致 → 401。
**修复**: 把 safe 集合补到 `~!*'()`，与 `encodeURIComponent` 严格对齐。

### P2 — BridgeService.ts.bak 备份残留
**位置**: `backend/src/live-trading/services/BridgeService.ts.bak`
**影响**: 老版本残留，未被任何 import，但容易被 grep 命中误以为是活跃实现。
**修复**: 文件内容已替换为单行注释 stub（mount 权限不允许直接删，请在主机上 `rm` 移除）。

## 三、本轮已确认不再是问题（避免重复打补丁）

- `bridgeAuth` rawBody 通过 `index.ts: express.json({ verify })` 注入；GET 请求 hashBody("") 是符合签名串约定。
- `KillSwitchService.trigger` 已有 `先查 existing → catch 23505 fallback` 双层并发兜底，partial unique `(active=true)` 由 runtime schema 创建。
- `pullPendingCommands` PG 路径用 `FOR UPDATE SKIP LOCKED`，sqlite 路径用 `UPDATE ... WHERE status='pending'` 的 affected-rows 兜底，原子派发可靠。
- `submitApprovedDraft` 已包整段事务；事务回滚后 audit 仍能落（在事务外 try）。
- `bridge_key` 输入只允许 ensureAccount 首次绑定，二次覆盖必须走专门运维接口，符合预期。

## 四、未在本次落地、需要后续动作

- `BridgeService.ts.bak` 主机层删除（VM 没有权限）。
- 文档 §6 / §7.4 需要补一段"用户撤单去重策略：同 order_id 未终态命令复用"以及"kill switch 触发/解除接口的 admin 限制"。
- 生产部署清单需要把 `JWT_SECRET` / `JWT_REFRESH_SECRET` 列为强制项；CI 中跑 `lint` 阶段检查 `process.env.JWT_SECRET ||` 兜底字面量再次出现。

## 五、修复涉及文件

- `backend/src/middlewares/auth.ts`
- `backend/src/api/controllers/AuthController.ts`
- `backend/src/live-trading/routes/liveTrading.routes.ts`
- `backend/src/live-trading/services/LiveTradingService.ts`
- `backend/src/live-trading/services/BridgeCommandExpiryService.ts`
- `backend/src/live-trading/services/KillSwitchService.ts`
- `backend/src/models/LiveOrder.ts`
- `backend/src/index.ts`
- `integrations/broker-bridge/bridge_common/auth.py`
- `backend/src/live-trading/services/BridgeService.ts.bak`
