# 63 — broker-bridge 协议（QMT + PTrade）

> Node 后端 → Python bridge → 券商客户端的"最后一公里"。HMAC + nonce 防重放、长轮询 pull、事件回传 ack、TTL 过期、kill switch 兜底、aborted 终态。

---

## A. 操盘手心智

bridge 是整个系统**唯一**触达真实资金的位置——所以这一段必须满足：

1. **可信**：每条命令带签名，server 与 broker 互验
2. **可追**：每条命令带 client_order_id，broker 回报 join 这个 id 不丢
3. **可逆**：bridge 失联时所有 in-flight 命令 expired/aborted，不允许"消息黑洞"
4. **可熔断**：kill switch 激活时立刻断 long-poll，pending 一次性 aborted
5. **可重启**：Windows 上 bridge 进程重启后 nonce + event_seq 都不丢

---

## B. 系统设计

### B.1 协议层（HTTP 长轮询）

```
bridge_client (Windows)              server (Node)
       ↓ GET /api/live-trading/bridge/commands/pull
       |   X-Live-Bridge-Key
       |   X-Live-Bridge-Timestamp
       |   X-Live-Bridge-Nonce
       |   X-Live-Bridge-Signature (HMAC-SHA256)
       |   long-poll up to 25s
       ←─ 200 [{command_id, type, symbol, ...}, ...]  或 204 no-content

       ↓ POST /api/live-trading/bridge/commands/:id/ack
       ←─ 200 {ok}

       (broker 执行 ...)

       ↓ POST /api/live-trading/bridge/events
       |   body: {command_id, event_type, broker_order_id, filled_qty, ...}
       ←─ 200 {ok, event_id}
```

### B.2 签名 + nonce

签名串（行分隔）：
```
method
path
canonical_query
timestamp_ms
nonce
sha256(body)
```

- HMAC-SHA256 with per-bridge `secret`（每个 bridge 一份 secret，不共用）
- nonce 入 `live_bridge_nonces` 表（UNIQUE 防重放）
- 时间窗口 `nonceWindowMs`：超出窗口的请求拒
- 周期 cleanup nonce 表（`BridgeCommandExpiryService.cleanupNonces`）

**双侧字节对齐**（CLAUDE 注释强调）：
- Node `encodeURIComponent` 不编码 `! * ' ( )`
- Python `urllib.parse.quote` 默认编码这些
- 因此 Python 端 `safe="~!*'()"`

### B.3 状态机映射

`LiveBrokerCommand.status` 全状态：

```
pending → dispatching → dispatched → submitted → partially_filled → filled
                    ↓
                    expired (TTL)
                    aborted (KillSwitch)
                    failed (broker_error / no broker_order_id)
                    cancelled (撤单回报)
```

aborted 终态特别说明（BETA-9 audit M-6 修复）：
- 由 `KillSwitchService.abortPendingCommands` 写
- 不进 TTL 巡检（`scanCommandsExpired` WHERE 不含 aborted）
- 解除后**不自动复活**（设计意图：强制人工 review）

### B.4 TTL 巡检

`BridgeCommandExpiryService.scanCommandsExpired`：
- `WHERE status IN ('pending','dispatching','dispatched') AND expires_at < now()`
- → status='expired' + 写 audit `BROKER_COMMAND_EXPIRED`
- 兜底"创建了命令但 bridge 永远没拿走"

`scanOrdersExpired`：
- 处理"创建 order 但 command 创建失败"的孤儿（grace = TTL × 5）

### B.5 KillSwitch 联动

激活时（见 55_kill_switch）：
1. 写 `live_kill_switch_states.active=true`
2. pending → aborted（一次性）
3. dispatching/dispatched → 写 audit `KILL_SWITCH_MARK_INFLIGHT`（不强改避免 bridge ack 冲突）
4. bridge long-poll 立刻 204 / 断 SSE
5. 飞书告警

### B.6 QMT vs PTrade 差异

| 特性 | QMT | PTrade |
|---|---|---|
| 适配器 | `qmt_bridge/qmt_adapter.py` | `ptrade_bridge/ptrade_adapter.py` |
| 底层 | XtQuant Python API | PTrade restful |
| 部署 | 必须 Windows + QMT 客户端 | Windows / Linux |
| iceberg | 待确认 | 待确认 |
| 集合竞价 | 支持 (price_type=call_auction) | 支持 |

---

## C. 现状 review

### C.1 协议 + HMAC + nonce 完整

- `backend/src/live-trading/middlewares/bridgeAuth.ts:1-250`：签名校验 + nonce 表 + 时钟窗口
- `integrations/broker-bridge/bridge_common/auth.py`：Python 端签名生成
- 字节对齐（safe="~!*'()" 注释 P2 review）
- nonce cleanup 周期跑（`BridgeCommandExpiryService.cleanupNonces`）

### C.2 状态机收敛 + aborted 已 codify

- `docs/live_trading_state_machine.md:42-67` mermaid 含 aborted
- model L72-77：aborted 终态 + 不再 TTL 巡检
- BETA-9 audit M-6 修复完成

### C.3 ⚠️ qmt vs ptrade 兼容矩阵缺

- 两 adapter 实现略有差异但**没有文档对照表**
- iceberg / 集合竞价 / 异常码 等差异
- ops 切 broker 时容易踩坑

### C.4 ed25519 升级路径未实现（详见 60 US-EO-2）

- 当前仅 HMAC-SHA256
- ed25519 是 future-proof 方向

### C.5 Windows 部署约束

- QMT 必须 Windows + 同账户在线
- bridge 进程要随券商客户端启动而启动
- 心跳：每 30s POST `/health` → server 更新 `live_bridge_health.last_heartbeat_at`
- 缺一个 ops 部署手册（重启 bridge 步骤 / 抓 log 路径 / 排查清单）

### C.6 KillSwitch 联动已实现

- `KillSwitchService.abortPendingCommands` (line 213-278)
- pending → aborted; dispatching/dispatched → mark only
- bridge long-poll `isTriggered()` 返回 []

### C.7 BETA-9 audit M-6 已修

- aborted 终态加进 model L72-77 注释 + state_machine.md L82-89 mermaid
- 明确"aborted 不需 TTL 巡检"
- KillSwitch resolve 后 aborted 命令不自动复活

---

## D. 改造方案

### D.1 user story

| ID | 故事 | 验收 |
|---|---|---|
| US-BR-1 | **qmt/ptrade 兼容矩阵文档**：`docs/broker_bridge_compat_matrix.md` 列出 order_type / event / 错误码差异；adapter 内补 fallback | 文档存在 + 测试断言两 adapter 同接口 |
| US-BR-2 | **ed25519 签名 path**：bridge_common/auth.py 加 ed25519 sign + verify；config.py 加 `signature_method=hmac/ed25519` toggle；旧 hmac 保持兼容 | 两 method 单测都通 |
| US-BR-3 | **ops 部署手册**：`docs/broker_bridge_deploy.md` 含 Windows 安装、bridge 启停脚本、log 路径、心跳排查、常见故障（断网、QMT 客户端挂、券商系统维护） | 文档存在 + ops 跑通 happy path |
| US-BR-4 | **bridge 健康 metric**：Prometheus `bridge_latency_ms / heartbeat_age_seconds / event_lag_seconds / pending_command_count`；Grafana 面板 | metric 可查 + 面板上线 |
| US-BR-5 | **aborted 命令 resubmit UI**：admin 看 aborted list，勾选 resubmit → 重新写 LiveBrokerCommand pending | UI 流程 + 测试 |
| US-BR-6 | **bridge SDK 版本号 metric**：bridge 心跳带 `version` 字段；server 写 `live_bridge_health.sdk_version`；dashboard 出"哪些 bridge 落后版本" | 心跳 payload 含 version |
| US-BR-7 | **client_order_id 命名规范**：当前用 UUID；改 `<env>-<user_id>-<draft_id>-<timestamp>` 让 broker 端 log 可读 + 跨账户唯一 | 测：解析 id 反查 draft 通过 |

### D.2 audit M-6 已完成（BETA-9）

无需再做。状态机文档 + model 注释 + scanCommandsExpired 行为 三处一致。

### D.3 反向兼容

ed25519 上线时：
- Server 同时支持 HMAC（旧 bridge）+ ed25519（新 bridge）
- Header `X-Live-Bridge-Sigalg: hmac-sha256 | ed25519` 决定
- Migration plan: 旧 bridge 灰度升级，全量后再砍 HMAC 路径

---

## E. 验收口径

- HMAC + nonce 防重放跑通（重发同 nonce 拒）
- 字节对齐：服务端能验 Python 客户端签
- aborted 终态：KillSwitch trigger → pending 一次性 aborted + 不进 TTL
- TTL 巡检不覆盖 aborted（WHERE 验证）
- qmt/ptrade 兼容矩阵文档 + ops 部署手册
- Grafana 健康面板
- 文件位置：
  - `backend/src/live-trading/middlewares/bridgeAuth.ts`
  - `backend/src/live-trading/services/{BridgeService,BridgeCommandExpiryService,KillSwitchService}.ts`
  - `integrations/broker-bridge/{bridge_common,qmt_bridge,ptrade_bridge}/`
  - `docs/live_trading_state_machine.md`（已更新）
