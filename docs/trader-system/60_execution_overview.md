# 60 — 执行总览（Execution Overview）

> 从"用户点了 BUY"或"信号自动产生"到"broker 真成交"再到"对账"——完整链路图 + 七闸门 + 三个状态机 + bridge 协议。本节是 60-64 的导航总览。

---

## A. 操盘手心智

执行链路的好坏直接决定了系统能不能上规模。我衡量执行的 4 个标准：

1. **正确性**：用户/策略意图 → broker 真单 100% 一一对应（没有"信号产了没下、下了没成、成了没回"）
2. **幂等**：网络抖 / 服务重启 / 用户连点，同一意图只产 1 笔单
3. **可观测**：每笔单从意图到成交在 audit log 完整可追溯
4. **可熔断**：bridge 失联 / kill switch 激活 → 所有 pending 命令 abort + 飞书告警

---

## B. 系统设计

### B.1 三层架构

| 层 | 表 | 状态机 |
|---|---|---|
| **L1 草稿** | `LiveOrderDraft` | preview → pending → approved → submitted (终态 submitted/rejected/shadow_executed) |
| **L2 命令** | `LiveBrokerCommand` | pending → dispatching → dispatched → submitted → partially_filled → filled (终态 filled/cancelled/failed/expired/aborted) |
| **L3 委托** | `LiveOrder.bridge_status` | 镜像 L2 (一对一) |

详见 `docs/live_trading_state_machine.md`。

### B.2 完整链路图

```
┌──────────────────────────── USER ────────────────────────────┐
│  UI 手动 BUY / SELL → POST /api/paper-trading/trade           │
│  自动化 cron → autoBuyFromSignals → facade.placeOrder         │
│  实盘审批 → POST /api/live-trading/drafts/:id/approve         │
└───────────────────────────────────────────────────────────────┘
                              ↓
┌──────────── facade.placeOrder (paper) ──────────────┐
│  pre-trade 7 闸门：                                  │
│    1. 交易时段                                       │
│    2. 涨跌停 (audit S-3 已修)                        │
│    3. 行情陈旧度 (RealtimeQuote → fallback daily_bar)│
│    4. DrawdownCircuitBreaker (fail-CLOSED, BETA-7)   │
│    5. PositionLimitGuard                             │
│    6. T+1 (SELL)                                     │
│    7. cash                                           │
│  → 事务 (SELECT FOR UPDATE) 写 position + portfolio  │
│  → 写 PaperTradingTrade                             │
└─────────────────────────────────────────────────────┘
                              ↓
┌──────── LiveTradingService.createDraft / approveDraft ────────┐
│  双重 wizard 复核 + 实盘 RiskGuardService.evaluate              │
│  → 写 LiveOrderDraft / LiveBrokerCommand / LiveOrder            │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌──────────── BridgeService (HTTP long-poll) ──────────┐
│  pullPendingCommands (SELECT FOR UPDATE SKIP LOCKED) │
│  ackCommand                                          │
│  events: submitted / trade / cancelled / failed      │
│  advanceCommandStatus (WHERE status NOT IN terminal) │
└───────────────────────────────────────────────────────┘
                              ↓
┌─────── broker-bridge (Python on Windows) ────────┐
│  bridge_common/auth.py (HMAC-SHA256 + nonce)     │
│  qmt_bridge/qmt_adapter.py (QMT XtQuant)         │
│  ptrade_bridge/ptrade_adapter.py (PTrade)        │
└───────────────────────────────────────────────────┘
                              ↓
                          券商通道
                              ↓
                    成交回报 (event 反向)
                              ↓
┌──────── Reconciliation ──────────┐
│  intraday: 10:30/14:30/15:30 cron│
│  EOD: 16:00 cron                  │
│  ReconciliationAlertService       │
└───────────────────────────────────┘
```

### B.3 七闸门 vs 状态机

七闸门（pre-trade）阻止"不该下的单进入命令层"——一旦写入 `LiveBrokerCommand` 就只能 cancel / expire / abort 不能撤销。

| 闸门 | 文件 |
|---|---|
| 交易时段 | PaperTradingFacade.ts:600-643 |
| 涨跌停 | PaperTradingFacade.ts:762-780 + 964-979 |
| 行情陈旧度 | PaperTradingFacade.ts:693-738 |
| DrawdownCircuitBreaker fail-CLOSED | PaperTradingFacade.ts:782-839 |
| PositionLimitGuard | PaperTradingFacade.ts:841-859 |
| T+1 | PaperTradingFacade.ts:981-1004 (SELL) |
| cash | PaperTradingFacade.ts:861-862 + 873-875 |

实盘额外（LiveTradingService.approveDraft）：
- TradeComplianceChecker pre-trade（BETA-1）
- LiveRiskGuardService（block_limit_up_buy 等）
- KillSwitchService.isTriggered

### B.4 Bridge HMAC + nonce

`backend/src/live-trading/middlewares/bridgeAuth.ts:24-43`
+ `integrations/broker-bridge/bridge_common/auth.py`

签名串：
```
method
path
canonical_query
timestamp_ms
nonce
sha256(body)
```

- HMAC-SHA256 with per-bridge `secret`
- nonce 入 `live_bridge_nonces` 表（UNIQUE 防重放）
- 时间窗口 nonce expire = 现在 + nonceWindowMs
- 时钟偏差 ≤ X 秒（在 timestamp 校验）

---

## C. 现状 review

### C.1 七闸门 9 处全部生效（audit 修复后）

- 涨跌停 S-3 BETA 修复（line 762-780）；
- DrawdownCircuitBreaker fail-CLOSED BETA-7 完成（line 797-832）；
- 行情陈旧度 RealtimeQuote + fallback daily_bar BETA-6 完成（line 693-738）；
- 其余历史已存在（PositionLimitGuard / T+1 / cash / 交易时段）。

### C.2 三个状态机收敛清晰

- `docs/live_trading_state_machine.md` 已完整记录
- aborted 终态 BETA-9 audit M-6 已 codify（model L72-77）
- LiveOrder.bridge_status 与 LiveBrokerCommand.status 同字典串

### C.3 bridge HMAC + nonce 已生效

- 两侧（Node + Python）字节对齐（CLAUDE 注释强调 `safe="~!*'()"`）
- 防重放：`live_bridge_nonces` 表 UNIQUE
- 时间窗口：`nonceWindowMs` 配置

### C.4 ✅ ed25519 升级路径已支持 (US-109 [EX-009])

- HMAC-SHA256 仍是缺省 (`X-Live-Bridge-Sig-Method` 缺省 / `hmac` → 老路径,兼容老 bridge)
- 新增 ed25519 (`X-Live-Bridge-Sig-Method: ed25519`): bridge 持 private key 签名, server 仅持公钥验证 → 即使 server env/DB 泄露也无法伪造命令
- 灰度切换: server 同一 `bridge_key` 可同时配 `LIVE_BRIDGE_SECRETS` (hmac) + `LIVE_BRIDGE_ED25519_PUBKEYS` (ed25519), 两条 path 共享同一 base string + nonce 表, 单 bridge 切换零迁移成本
- 公钥配置: `LIVE_BRIDGE_ED25519_PUBKEYS={"bridge_key":"<pub_hex_64>"}` (接受 PEM / hex 32-byte raw / hex SPKI DER / base64 raw)
- Bridge 端: `config.yaml` 加 `signature_method: ed25519` + `ed25519_private_key: <hex>`, 调 `bridge_common.auth.derive_ed25519_pubkey_hex()` 派生公钥配到 server
- 测试: `backend/tests/live-trading/bridge-ed25519.test.ts` 覆盖两 method round-trip + 错误 pubkey/secret/sig 长度/篡改 base 全部 fail + Python ↔ Node 字节对齐契约

### C.5 ⚠️ qmt vs ptrade 差异未文档化

- `integrations/broker-bridge/qmt_bridge/qmt_adapter.py` + `ptrade_bridge/ptrade_adapter.py` 实现略有差异
- 哪些 order_type 两边都支持、哪些只 qmt 支持（如 iceberg）—— 缺统一兼容表

### C.6 七闸门入口在两条 path（facade vs LiveTradingService.approveDraft）

- 模拟盘走 facade 7 闸门
- 实盘审批走 LiveTradingService.approveDraft（额外 wizard + LiveRiskGuard + KillSwitch）
- **风险**：直接调 facade 走真实盘 path 时可能跳过 LiveTradingService 那一段额外校验
- 实盘 path 必须强制走 approveDraft，不允许 bypass

---

## D. 改造方案

### D.1 user story

| ID | 故事 | 验收 |
|---|---|---|
| US-EO-1 | **七闸门统一文档化**：抽 `backend/src/portfolio/internal/preTradeGuards.ts` 已有 `checkTPlus1`，加 `checkAllPreTradeGates(ctx)` 统一入口；automation / facade / LiveTradingService 都通过它走 | 三个 caller grep 都命中 checkAllPreTradeGates |
| US-EO-2 | **bridge ed25519 path**：bridge_common/auth.py 加 ed25519 sign + verify 路径；config.py 加 `signature_method=hmac/ed25519` toggle；旧 hmac 保持兼容 | 测试两 method 都通 |
| US-EO-3 | **qmt/ptrade 兼容矩阵**：写 `docs/broker_bridge_compat_matrix.md` 列出每个 order_type / event / 错误码两 broker 的支持差异；adapter 内补 fallback | 文档存在 + adapter 标注 unsupported |
| US-EO-4 | **kill switch UI 实时看板**：dashboard 显示 KillSwitch 状态（active / triggers / aborted_command_count）；admin 一键 resolve | UI 上线 |
| US-EO-5 | **实盘 path 强制 approveDraft 审计**：实盘 user 调 facade.placeOrder（绕过 LiveTradingService）→ throw + 写 RiskAlert HIGH；通过 user.account_type=live 判定 | 单测：live user 直接 facade.placeOrder throw |
| US-EO-6 | **bridge connect 健康看板**：Grafana 看 `bridge_latency_ms / heartbeat_age_seconds / event_lag_seconds`；缺一则 KillSwitch heartbeat_lost 触发 | Grafana 面板上线 |

### D.2 与 61/62/63/64 的导航

- **61_execution_feasibility.md** — 流动性 / 盘口 / 涨跌停距离评分（闸门 7 之外的"软评估"）
- **62 (合并进 43)** — 执行算法 TWAP/VWAP/Iceberg
- **63_execution_bridge.md** — bridge 协议 + qmt/ptrade 适配 + 状态机
- **64_reconciliation.md** — 对账 + ReconciliationAlertService 主动告警

---

## E. 验收口径

- 七闸门统一 entry point，三 caller 100% 通过它走
- bridge ed25519 可切换 + qmt/ptrade 兼容表
- 实盘 path 强制 approveDraft（绕过 throw）
- kill switch UI + bridge 健康看板 Grafana
- aborted 命令 UI 可见 + resubmit
- 文件位置：`backend/src/portfolio/PaperTradingFacade.ts` + `backend/src/live-trading/services/{LiveTradingService,BridgeService,KillSwitchService}.ts` + `integrations/broker-bridge/bridge_common/auth.py`
