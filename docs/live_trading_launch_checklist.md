# 实盘上线 Checklist（阶段二：灰度真下单 / main 环境）

**生效场景**: qmt_bridge 接 1 个灰度账户，`allow_order_execution=true`，限额极小，每笔手动确认。
**目标**: 第一次有真钱往券商走时，把所有"我以为开了/我以为对了"的环节都按死。
**约定**: 每一项都标了"机器可验证 / 必须人工 / 阻断"，没打勾不要上线。

---

## 0. 阻断项汇总（任何一项未解都不要上线）

| # | 阻断项 | 严重度 | 处置 |
| - | - | - | - |
| B1 | **QmtAdapter 当前是完整 stub**：`place_order` 直接返回 `error: "QMT adapter stub: place_order disabled"`，`query_asset` 返回固定 mock，`connect()` 永远 true | P0 阻断 | 灰度真下单等同于**根本下不了单**。必须先用 xtquant 接好 5 个方法：`connect / is_logged_in / query_asset / query_positions / query_today_orders / query_today_trades / place_order / cancel_order`。完成前只能跑阶段一（只读）。 |
| B2 | production `JWT_SECRET` / `JWT_REFRESH_SECRET` 仍为占位符或历史泄漏值 | P0 阻断 | 上线前改为 32+ 位随机值；生产预检会按泄漏指纹和占位符规则 fail-closed。 |
| B3 | `release_health_gate.js` smoke 用 `lym` / `666` 登录；同一份默认密码 = 任何人都能登 admin → 任何人都能用上一轮 review 收紧的 `kill-switch/trigger`、所有 `/api/live-trading/*` 接口 | P0 阻断 | 把 `lym`、`xz`、`xz`（init 时建的 admin）密码全部改成强密码；smoke 用专用 `SMOKE_PASSWORD` 环境变量传入，绝不复用 admin。 |
| B4 | `LIVE_BRIDGE_SECRETS` 必须在 server 侧配齐 bridge_key → secret 的映射，否则 bridgeAuthMiddleware 直接 401 | P0 阻断 | 用运维下发，不进 git。secret 建议 64 位随机。 |
| B5 | `(account_id, broker_order_id) partial unique` 是上一轮新加的 runtime schema，**production DB 上是否真的能创建成功** | P0 阻断 | 上线前先在 PG 上跑 [§3 §3.2 dry-run SQL]，确认无脏数据再让 server 自己 ensureLiveTradingRuntimeSchema 建索引。 |

---

## 1. 上线前必做（T-24h）

### 1.1 代码与依赖
- [ ] **机器** `git log -n 1 --oneline` 确认本轮 review 修复全部合入：`auth.ts` / `AuthController.ts` / `liveTrading.routes.ts` / `LiveTradingService.ts` / `BridgeCommandExpiryService.ts` / `KillSwitchService.ts` / `models/LiveOrder.ts` / `index.ts` / `broker-bridge/bridge_common/auth.py`。
- [ ] **机器** `cd backend && npx tsc -p tsconfig.json --noEmit` 通过。
- [ ] **机器** `node scripts/tests/smoke_readonly_core.js`（用专用账户）通过。
- [ ] **机器** `node backend/dist/scripts/live-trading-safety-smoke.js` 通过（kill_switch 默认 true、gateway allowlist、capability、licensed 闸门全部覆盖）。
- [ ] **机器** `cd integrations/broker-bridge && python -m py_compile bridge_common/*.py qmt_bridge/*.py` 通过。
- [ ] **人工** 在测试机上完整跑一遍"灰度账户绑定 → 下单 → bridge dry-run → 状态推进 → 撤单"端到端，确认 LiveTrading 页面 4 块（账户卡片、仓位、订单草稿、活跃委托）数据正确。

### 1.2 环境变量（main 服务器 `/opt/stocks/current/backend/.env`）
按"必须配 / 灰度下单必须 / 推荐"三档列。复制走逐项确认：

**必须配（缺一就直接 500 或安全降级）**

- [ ] `NODE_ENV=production`
- [ ] `JWT_SECRET=` 32+ 位随机（**不是占位符**）
- [ ] `JWT_REFRESH_SECRET=` 32+ 位随机
- [ ] `DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD` 指向生产 PG
- [ ] `REDIS_HOST / REDIS_PORT / REDIS_PASSWORD` 指向生产 Redis（即便不开 queue 也要可联通）
- [ ] `ALLOWED_ORIGINS=https://<前端域名>`（生产域名逗号分隔，**不要**指望默认 localhost 回退）
- [ ] `LIVE_TRADING_ALLOW_DB_OFFLINE`**不要**设为 true（这样 DB 挂掉时 server 拒启，不会半启动放流量）

**灰度真下单必须**

- [ ] `LIVE_TRADING_ENABLED=true`
- [ ] `LIVE_ORDER_EXECUTION_ENABLED=true`
- [ ] `LIVE_TRADING_KILL_SWITCH=false`（仅在准备好的瞬间设为 false，平时按 true 默认）
- [ ] `LIVE_BROKER_GATEWAY=qmt_bridge`
- [ ] `LIVE_MARKET_DATA_PROVIDER=licensed_configured` + `LIVE_LICENSED_QUOTE_URL_TEMPLATE=...`（不配则被持牌闸门拦下）
- [ ] `LIVE_BRIDGE_SECRETS={"<bridge_key>":"<64-char-secret>"}` JSON 字符串，**严禁与 `LIVE_BRIDGE_KEY` / `LIVE_BRIDGE_SECRET` 两个旧变量同时存在**
- [ ] `LIVE_BRIDGE_MAX_CLOCK_SKEW_SECONDS=60`（默认）
- [ ] `LIVE_BRIDGE_NONCE_WINDOW_SECONDS=300`（默认）
- [ ] `LIVE_BRIDGE_COMMAND_TTL_SECONDS=60`
- [ ] `LIVE_BRIDGE_CANCEL_COMMAND_TTL_SECONDS=180`

**强烈推荐（不配会导致风控/巡检默认值不合灰度场景）**

- [ ] `LIVE_RISK_MAX_SINGLE_ORDER_PCT=0.2`（灰度阶段，单笔 ≤ 总资产 0.2%）
- [ ] `LIVE_RISK_MAX_DAILY_ORDER_COUNT=3`（灰度阶段，每天最多 3 笔；超 4.5 笔即触发熔断）
- [ ] `LIVE_RISK_FAIL_STREAK_KILL=2`（灰度更敏感）
- [ ] `LIVE_RISK_DAILY_LOSS_KILL_PCT=1`（当日浮亏 1% 即熔断）
- [ ] `LIVE_RISK_HEARTBEAT_TIMEOUT_MINUTES=3`
- [ ] `LIVE_KILL_SWITCH_SCAN_INTERVAL_MS=30000`（灰度阶段更勤）
- [ ] `LIVE_BRIDGE_HEARTBEAT_TIMEOUT_SECONDS=120`（pullPendingCommands 用）
- [ ] **灰度账户** `risk_config.max_single_order_amount = 2000`（元）写到 `live_broker_accounts.risk_config`，per-account 覆盖 env

### 1.3 反向代理与 timeout（必须与 `LIVE_BRIDGE_LONG_POLL_SECONDS` 联动；默认 30）
按 [`docs/QMT_PTRADE_LIVE_TRADING_ROADMAP.md` §7.4.2] 配齐：

- [ ] Nginx bridge 路由独立 `location /api/live-trading/bridge/ { proxy_read_timeout 40s; proxy_send_timeout 40s; proxy_buffering off; }`
- [ ] SSE 路由 `/order-commands/stream` 显式 `X-Accel-Buffering: no` 头
- [ ] Express `server.keepAliveTimeout=35000`、`server.headersTimeout=40000`（pm2/systemd 起的 node 实例里设）
- [ ] ALB / NLB idle timeout ≥ 60s
- [ ] **容器健康检查不打 bridge 路由**（避免占用长连接配额）

### 1.4 数据库（生产 PG）
用 `psql` 在生产 DB 上 dry-run 后再上代码：

- [ ] `\d+ live_broker_accounts` 确认 `bridge_key / account_role / risk_config / permission_scope` 字段存在
- [ ] `\di+ idx_live_broker_accounts_bridge_key_unique` partial unique 存在
- [ ] **预检脏数据**：
  ```sql
  -- B5 阻断：上线后 ensureLiveTradingRuntimeSchema 会创建
  -- idx_live_orders_account_broker_order_id_unique (account_id, broker_order_id) WHERE broker_order_id IS NOT NULL
  -- 创建前必须没有冲突行
  SELECT account_id, broker_order_id, count(*)
  FROM live_orders
  WHERE broker_order_id IS NOT NULL
  GROUP BY 1, 2 HAVING count(*) > 1;
  -- 期望 0 行；非 0 行先合并/删除，再上线
  ```
- [ ] 同样预检 `live_broker_commands.client_order_id`、`live_trades.broker_trade_id`、`live_bridge_nonces (bridge_key, nonce)` 是否有重复
- [ ] `live_kill_switch_states` 当前 `WHERE active=true` 行数为 0 或确认就是想保留的熔断
- [ ] DB 上 `stocks_app` 用户对 `live_*` 全部表有 SELECT/INSERT/UPDATE 权限（运维确认）

### 1.5 bridge 进程（用户本地，跑 QMT 那台机器）
- [ ] `integrations/broker-bridge/` 整目录拷到该机器；`config.yaml` 由 `config.example.yaml` 复制并填好
  - `server_base_url=https://<production-domain>/api/live-trading/bridge`（HTTPS！）
  - `bridge_key` / `bridge_secret` 与 server 侧 `LIVE_BRIDGE_SECRETS` 一致
  - `allow_order_execution: true`（灰度阶段）
  - `readonly_only: false`
  - `max_single_order_amount: 2000`（本地兜底，再保险一次）
  - `local_kill_switch_file:` 选一个**bridge 进程有写权限**的绝对路径
  - `clock_skew_startup_threshold_seconds: 30`
- [ ] **机器** `python -m qmt_bridge.main --config config.yaml` 启动；检查 server 侧 `live_broker_bridge_heartbeats` 表 30s 内出现新行
- [ ] **人工** 在 QMT 客户端确认账户已登录且勾"允许策略下单"
- [ ] **人工** `touch <local_kill_switch_file>` 立即拒单测试，然后删除；触发 server 端 audit 一次熔断+恢复
- [ ] 部署到 windows 服务/启动文件夹/任务计划，确保 QMT 重启 + bridge 自动起来

### 1.6 账号与权限
- [ ] 默认 admin 用户密码（`lym / xz`）已重置为强密码，文档化收口在 1Password / Vault
- [ ] 真实交易用户角色 = `user`，**不是 admin**（用户不应能 trigger kill switch）
- [ ] `INTERNAL_API_KEY` 已轮换，并通过 secret store 下发；不得使用任何历史默认值
- [ ] `RELEASE_SMOKE_PASSWORD` 通过环境变量传，不再依赖 `'666'` 默认值

### 1.7 可观测性 & 告警
- [ ] 飞书 webhook（`FEISHU_RECOMMENDATION_BOT_WEBHOOK`）改成"实盘告警"专用群，与日常推送分群
- [ ] `live_execution_audit_logs` 接入飞书：`event_type IN ('live_kill_switch_triggered','live_order_enqueue_failed','live_bridge_status_failed','live_broker_command_expired','live_order_cancel_dedup')` 实时推送
- [ ] PG 慢查询日志 ≥ 500ms 打开
- [ ] systemd 单元 `stocks-backend.service` 配 `Restart=on-failure RestartSec=5`
- [ ] `journalctl -u stocks-backend -f` 远程聚合到 ELK / 飞书机器人
- [ ] 监控 `/health` 5xx 率 + 5 分钟 5 次连续失败短信告警

---

## 2. 上线中（T-0 切流量）

> **强烈建议先做 §2.0 只读预热（T-1 提前一个交易日）**，验证 bridge / 行情 / 风控全链路能在 main 环境跑起来，再在 T 日把真下单开关打开。少跑这一天，所有"我以为配好了"的环境差异都要在真钱面前现形。

### 2.0 T-1 只读预热交易日（强烈推荐）
目标：用一个完整的交易日证明 main 环境 bridge / 行情 / 风控接全，但**绝对不发起任何真实委托**。

- [ ] **机器** 当前 `.env` 设 `LIVE_TRADING_ENABLED=true` + `LIVE_ORDER_EXECUTION_ENABLED=false` + `LIVE_BROKER_GATEWAY=bridge_readonly` + `LIVE_TRADING_KILL_SWITCH=true`
- [ ] **机器** bridge 端 `config.yaml` 设 `readonly_only: true` + `allow_order_execution: false`
- [ ] **人工** `scripts/preflight/db_unique_dup_check.js` 跑一次，要求全部 `[ok]`
- [ ] **人工** 部署完成后跑 `scripts/ops/kill_switch_status.sh` 拿到当前熔断状态 baseline
- [ ] **开盘 9:30** 前 bridge 进程已启动；server 心跳表 5 分钟内有 online 行
- [ ] **盘中** 每 1 小时核对：
  - `live_account_snapshots` 有新行入库，total_asset 不是 stub 的 100000
  - `live_positions` 数量与 QMT 客户端持仓数一致
  - `live_orders` 当日新增条数 = QMT 客户端今日委托数（用户当天就算手工在 QMT 下了单也应该被 bridge 推上来）
  - LiveTrading 前端"灰度账户"tab 显示资产卡片、持仓表都有数据
- [ ] **盘中** 故意触发一次 bridge 离线 ≥ 3 分钟（拔网线 / 关 QMT），验证 server 在 `LIVE_RISK_HEARTBEAT_TIMEOUT_MINUTES` 后自动触发 `bridge_heartbeat_lost` kill switch；恢复后人工 `scripts/ops/kill_switch_resolve.sh` 解除
- [ ] **盘中** 故意创建一笔金额 ≥ 1000 元的草稿但 **不强确认**；验证草稿状态 = `pending` / `blocked`，没有任何 `live_broker_commands` 行产生
- [ ] **盘中** 故意创建一笔金额过大（超 `LIVE_RISK_MAX_SINGLE_ORDER_PCT`）的草稿，验证风控直接 block，draft.status=blocked
- [ ] **收盘后** 用 SQL 比对：
  ```sql
  -- bridge 推送的 trades 与 QMT 当日成交一致
  SELECT count(*), sum(trade_amount) FROM live_trades WHERE trade_time::date = CURRENT_DATE;
  -- audit 中无意外 event_type
  SELECT event_type, count(*) FROM live_execution_audit_logs
   WHERE created_at::date = CURRENT_DATE
   GROUP BY 1 ORDER BY 2 DESC;
  ```
- [ ] **收盘后** 复查 `live_execution_audit_logs` 当日 severity ∈ {warning, error, critical} 的所有行，每条都能解释（预期 / 故意触发 / 已知噪音）

通过条件：当日 bridge 心跳没断（人工触发的离线除外）、资产/持仓与 QMT 客户端一致、没有任何 `live_order_*_failed` 未解释告警。
**不通过 → 当天不允许进 §2.1 真下单**。

### 2.1 T+0 真下单切流量

按顺序执行，**不允许跳步**：

1. [ ] **机器** 拉起 PG / Redis，确认 `psql -c 'select 1'` 通。
2. [ ] **机器** 把 §1.2 的 `.env` 写到 `/opt/stocks/shared/backend.env`，systemd 单元 EnvironmentFile 指向它（独立于 release 目录，不会被 deploy 覆盖）。
3. [ ] **人工** `LIVE_TRADING_ENABLED=false` + `LIVE_TRADING_KILL_SWITCH=true` 跑一次完整部署（`node scripts/deployment/deploy_release_package.js`），验证：
   - smoke 用专用账号通过
   - `/health` 200
   - `/api/live-trading/safety` 返回 `mode: simulation_only`、`blockers` 包含开关未启用
4. [ ] **人工** 起 bridge 进程；server 侧 `select * from live_broker_bridge_heartbeats order by id desc limit 5` 看到 online 心跳
5. [ ] **人工** 用灰度用户登录前端，切到"灰度账户"tab，点"同步只读账户"；确认 LiveTrading 页面账户卡片有真实资产数字（不是 stub 的 100000）。**如果是 100000 → QmtAdapter 还在 stub 状态，立即停手回 §0 B1。**
6. [ ] **人工** 把 server `.env` 改为 `LIVE_TRADING_ENABLED=true` + `LIVE_ORDER_EXECUTION_ENABLED=true` + `LIVE_TRADING_KILL_SWITCH=false`，`systemctl restart stocks-backend`
7. [ ] **人工** 灰度用户创建一笔金额 ≤ 2000 元的草稿；查看 `/safety` 应当 `mode=approval_execution_enabled`、`blockers=[]`
8. [ ] **人工** 强确认提交，盯 4 处：
   - PG `live_broker_commands` 出现 status=pending 行
   - bridge 日志 30s 内拉到该 cmd，ack 成功
   - PG `live_broker_events` 看到 submitted 事件、`live_broker_commands` 推到 submitted
   - QMT 客户端委托列表出现该笔
9. [ ] **人工** 等真实成交回报；`live_broker_events` 出现 trade、`live_broker_commands` 推到 filled、`live_orders.bridge_status=filled`、`live_trades` 落行
10. [ ] **人工** 立刻在前端做一次撤单（哪怕这单已成交也试一遍），验证去重逻辑：第一次返回 `success`、第二次返回**同一个 command_id**且审计落 `live_order_cancel_dedup`

任一步异常 → §4 应急处置。

---

## 3. 上线后值守（T+24h）

- [ ] 每 30 分钟人工看一次 `live_execution_audit_logs ORDER BY created_at DESC LIMIT 20`
- [ ] 收盘后核对：
  - [ ] `select count(*), status from live_broker_commands where created_at >= today() group by 2` 与 QMT 客户端委托数一致
  - [ ] `select sum(trade_amount) from live_trades where created_at >= today()` 与券商对账单一致
  - [ ] `live_kill_switch_states` 当日有无 active=true（如有，看 reason_detail 复盘）
- [ ] T+1 早盘前确认 bridge 心跳没断、`live_bridge_nonces` 表行数没爆（cleanup 任务在跑）

---

## 4. 应急处置（按优先级，先做"立即止血"再做"复盘"）

### 4.1 立即止血（任一发生立刻执行）
| 触发条件 | 立即动作（用 admin 账户 + 命令行双保险） |
| - | - |
| 出现非预期成交 / 价格偏离 / 委托速度异常 | **A.** 前端 admin 用户 `POST /api/live-trading/kill-switch/trigger { reason_code: "manual", reason_detail: "..." }`；**B.** bridge 机 `touch <local_kill_switch_file>`；**C.** server `.env` 改 `LIVE_TRADING_KILL_SWITCH=true` 然后 `systemctl restart stocks-backend`（最重）。三者任一即断流；都做最稳。 |
| Server 进程异常 / DB 不可用 | `systemctl stop stocks-backend`（命令队列冻结，bridge 长轮询 401/超时即停发新单；TTL 巡检也跟着停） |
| Bridge 进程挂 / QMT 客户端断线 | 心跳 3 分钟内被 server kill switch 自动熔断（`bridge_heartbeat_lost`）；同时人工 `touch local_kill_switch_file` 防 bridge 复活后误派发 |
| 单一委托想撤 | 前端"撤单"按钮 → 后端 `requestOrderCancellation`；若 bridge 也挂了 → 直接去 QMT 客户端手动撤；事后在 `live_broker_commands` 手工 update status=cancelled + audit "manual_broker_cancel" |

### 4.2 回滚
- 代码层回滚：`release_health_gate.js` 健康检查失败已自动 `RELEASE_AUTO_ROLLBACK=true` 切回上一个 release 并重启；手动回滚 `ln -sfn /opt/stocks/releases/<prev> /opt/stocks/current && systemctl restart stocks-backend.service`
- 数据层回滚：本轮**只新增 partial unique 索引、加列**，无破坏性 alter，可以直接前向兼容。若新加的 partial unique 创建失败导致 server 起不来 → `DROP INDEX idx_live_orders_account_broker_order_id_unique` 后重启
- 灰度账户回滚：`UPDATE live_broker_accounts SET is_active=false WHERE account_role='grayscale'`，瞬间禁用灰度账户全部接口

### 4.3 必看日志位置
- `journalctl -u stocks-backend -n 500`
- PG `select * from live_execution_audit_logs ORDER BY created_at DESC LIMIT 100`
- bridge 机本地 `stdout`（默认 logging）；`var/seq.last` 是 event_seq 状态文件，**禁止手动改**
- Nginx access log 关注 `/api/live-trading/bridge/*` 401/499/504

### 4.4 真亏了怎么办
- 收盘后立即在 `live_execution_audit_logs` 全量导出当日所有 `live_order_*` 事件 + `live_broker_commands` + `live_broker_events` + `live_trades`，与 QMT 客户端交割单逐笔比对
- 把差异部分（多/少/价格不对）写复盘单，按差异类型分类：风控阈值不严 / bridge dry-run 误识别 / 状态机覆盖 / 撤单未生效
- 灰度阶段定义"可承受损失"上限（建议账户总资产 1%）；触及上限即回退到阶段一（只读）

---

## 5. 本轮 review 已经修但**部署侧仍要主机层确认**的 7 项

| review# | 修了什么 | 部署侧还要做什么 |
| - | - | - |
| P0 JWT_SECRET | 代码不再兜底字面量 | 删 `/opt/stocks/shared/backend.env` 里残留的占位符；改 32+ 位随机串 |
| P1 kill switch admin | 路由加 `requireRole('admin')` | 确认真实交易用户 role=user；admin 收口到 1-2 个运维 |
| P1 撤单去重 | `requestOrderCancellation` 复用未终态命令 | 前端按钮防双击仅是 UX，**真实并发去重在后端**，不要再加客户端 race 修补 |
| P1 expiry 原子 | `BridgeCommandExpiryService` 改为带 WHERE 的 UPDATE | 灰度期建议 `LIVE_BRIDGE_EXPIRY_SCAN_INTERVAL_MS=10000` 更快兜底 |
| P1 LiveOrder unique | 加 partial unique `(account_id, broker_order_id)` | §1.4 dry-run SQL 必须先跑，确认无脏数据再放 server 启动 |
| P2 KillSwitch stale | 补 last_sync_at > 24h 路径 | 灰度账户若长时间没用，会被这条熔断；定期清理 inactive 账户或拉长阈值 |
| P2 Python canonicalize | safe 集合补 `!*'()` 与 Node 对齐 | bridge 机更新部署 |

---

## 6. 不在本轮范围、但上线前**强烈建议**补的事

1. `BridgeService.ts.bak` 主机层 `rm`（VM mount 权限不允许，所以代码里只能改成 stub）
2. `deploy_release_package.js` 把 `sshPassword` / `opsPassword` 走 SSH key + sudoers，不再 expect 灌密码；这是部署链安全债，不影响运行时但被拿到部署机会泄露 server
3. `INTERNAL_API_KEY` 走 secret store，不再写 `.env`
4. 飞书 webhook 之外加 1 个备用渠道（短信 / 钉钉），避免飞书宕机时静默
5. 把 `JWT_SECRET` 缺失场景纳入 lint：CI 跑 `grep -R "your-secret-key-change" backend/src` 必须 0 匹配；今天我替换后只剩注释，CI 应排除注释行

---

**最后一句话**：阶段二第一次真下单建议你**全程坐在电脑前**盯完整个交易日。今天 review 把代码侧能堵的都堵上了，剩下能咬人的是 1) QMT adapter 还是 stub 这件事必须先解决；2) `.env` / 用户密码 / 反向代理 timeout 这三件事必须人去主机上做。代码不能替你做。
