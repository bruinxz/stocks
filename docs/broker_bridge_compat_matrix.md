# Broker Bridge 兼容矩阵 (QMT vs PTrade)

> **来源**：本文是 `docs/trader-system/60_execution_overview.md` §C.5 的补全落地（US-110 / [EX-010]）。
> 列出 broker-bridge 两个适配器（`qmt_bridge/qmt_adapter.py`、`ptrade_bridge/ptrade_adapter.py`）
> 在 **order_type / event / status / 错误码** 维度上的支持差异，给 adapter 写 fallback 用，
> 给 server 端 `LiveBrokerCommand` 派单前的能力探测用。
>
> **代码侧事实源**：`backend/src/live-trading/brokers/brokerCompatMatrix.ts` —— 同一份数据用 TS 常量
> 表达，单测 `backend/tests/live-trading/broker-compat-matrix.test.ts` 会同时锁住本文件和 TS 常量
> 任一漂移立刻 fail，防"改了文档忘改代码 / 改了代码忘改文档"。
>
> 任何修改本表的 PR 必须**同时**改 .md + .ts + 单测，否则 CI 红。

---

## 1. 总览（broker 元信息）

| broker_key | 适配器文件 | API SDK | 部署系统 | 状态 |
| --- | --- | --- | --- | --- |
| qmt | `integrations/broker-bridge/qmt_bridge/qmt_adapter.py` | `xtquant` v2.x | Windows + QMT 客户端 | **生产就绪** |
| ptrade | `integrations/broker-bridge/ptrade_bridge/ptrade_adapter.py` | PTrade Python API（券商版本相关）| Windows + PTrade 客户端 | **stub（未实现）** |

> **PTrade 状态**：PTrade 适配目前仅占位（无 SDK 引入），所有方法返回"unsupported"。
> 服务器派单前必须查 `brokerCompatMatrix` 判定能力，不要假设 broker_key=ptrade 可下单。
> 真正接入 PTrade 时按本表更新 supported=true 并落 adapter 实现。

---

## 2. order_type 兼容性

| order_type | qmt | ptrade | 备注 |
| --- | :-: | :-: | --- |
| `LIMIT`（限价）| ✅ | ⛔ | qmt 走 `xtconstant.FIX_PRICE`；ptrade 未实现 |
| `MARKET`（市价）| 🚫 | ⛔ | qmt SDK 支持 `xtconstant.MARKET` 但**服务器端 fail-closed 禁用**（流动性/成交价不可控，七闸门拒）|
| `IOC`（即时成交否则取消）| 🚫 | ⛔ | qmt SDK 支持，server 暂不派发；保留未来扩展 |
| `FOK`（全部成交否则取消）| 🚫 | ⛔ | 同 IOC，server 暂不派发 |
| `TWAP`/`VWAP`/`POV`（算法母单）| ↩️ | ↩️ | adapter 不直接下，由 `ExecutionAlgoSlicer` (US-106) 拆成 N 笔 `LIMIT` 子单逐个下 |
| `ICEBERG`（冰山）| ↩️ | ↩️ | 同上，slicer 拆 visible_qty 子单 |

图例：✅ 已实现且 server 允许；🚫 SDK 支持但 server 主动禁用；⛔ adapter 未实现（应拒）；
↩️ adapter 层不直接处理，由上游算法层拆单后下 LIMIT。

> **adapter 内 fallback 规则**：收到非 `LIMIT` 的 order_type，adapter `place_order` 必须返
> `{broker_order_id: null, error: "order_type not supported: <type>"}`，不允许"猜测降级"
> （比如把 MARKET 当 LIMIT 用涨停价下）—— 那是七闸门 + slippage gate 的事，不是 adapter 的事。

---

## 3. event / 事件流兼容性

| event | qmt | ptrade | server 侧处理 |
| --- | :-: | :-: | --- |
| `heartbeat` | ✅ | ✅ | bridge_common/client.py 统一发；适配器无关 |
| `account_snapshot` (`query_asset`) | ✅ | ⛔ | qmt `XtAsset` 字段全；ptrade unsupported |
| `positions` (`query_positions`) | ✅ | ⛔ | qmt `query_stock_positions`；ptrade unsupported |
| `today_orders` (`query_today_orders`) | ✅ | ⛔ | qmt `query_stock_orders(cancelable_only=False)`；ptrade unsupported |
| `today_trades` (`query_today_trades`) | ✅ | ⛔ | qmt `query_stock_trades`；ptrade unsupported |
| `order_events`（push 增量）| ⚠️ | ⛔ | qmt 走"轮询 query_orders 做差分"模拟 push；ptrade unsupported |
| `place_order` | ✅ | ⛔ | qmt `order_stock` 同步返 broker_order_id；ptrade unsupported |
| `cancel_order` | ✅ | ⛔ | qmt `cancel_order_stock` 异步（返 0 仅"已提交"），靠轮询验证；ptrade unsupported |

图例：⚠️ = 半支持（模拟 push，不是真实时回调）。

> **轮询 vs callback**：qmt SDK 提供 `XtQuantTraderCallback` 异步回调，但本 bridge **不依赖 callback**
> （主循环复杂度 + 进程崩溃恢复成本太高），全部走 `query_*` 轮询做差分。这是已知架构决策，
> 不是 bug，文档化在此防误改。

---

## 4. 订单状态 (status) 映射差异

server 端 `LiveOrder.bridge_status` 字典：`pending | submitted | partially_filled | filled | cancelled | failed`。

| QMT 状态码 | 含义 | server bridge_status |
| --- | --- | --- |
| 48 `ORDER_REPORTED` | 已报 | `submitted` |
| 49 `ORDER_REPORTED_CANCEL` | 已报待撤 | `submitted` |
| 50 `ORDER_PARTSUCC_CANCEL` | 部成待撤 | `partially_filled` |
| 51 `ORDER_PART_CANCEL` | 部撤 | `cancelled` |
| 52 `ORDER_CANCELED` | 已撤 | `cancelled` |
| 53 `ORDER_PART_SUCC` | 部成 | `partially_filled` |
| 54 `ORDER_SUCCEEDED` | 全成 | `filled` |
| 55 `ORDER_JUNK` | 废单 | `failed` |
| 56 `ORDER_UNREPORTED` | 未报 | `pending` |
| 57 `ORDER_WAIT_REPORTING` | 待报 | `pending` |
| 58 `ORDER_REJECTED` | 已拒 | `failed` |
| 其它 | 未知 | `submitted`（保守） |

实现见 `qmt_adapter._xt_status_to_str`。

> **PTrade 状态码**：未实现；接入时按 PTrade 文档枚举值列另一张表，map 到同一份 6 态字典
> （这是 server 端单一事实源，bridge 适配器各自归一）。

---

## 5. 错误码 / 失败语义

| 场景 | qmt 返回 | ptrade 返回 | 上层（BridgeService）处理 |
| --- | --- | --- | --- |
| adapter 未 connect | `{broker_order_id: null, error: "QmtAdapter not connected"}` | `{broker_order_id: null, error: "PtradeAdapter not implemented"}` | 写 `LiveBrokerCommand.status='failed'` + RiskAlert HIGH |
| QMT 客户端未登录 / connect 返非 0 | `{error: "XtQuantTrader.connect() returned <n>"}` | n/a | 同上，触发 heartbeat status=`logged_out` |
| order_stock 抛异常 | `{error: "xtquant exception: <msg>"}` | n/a | 同上 |
| order_stock 返 ret<0 | `{error: "order_stock returned <ret>"}` | n/a | 同上 |
| cancel 入参非整数 broker_order_id | `{submitted: False, error: "broker_order_id 不是合法整数"}` | n/a | server 不重试；属上层 bug |
| xtquant 模块缺失 | connect() 返 False + 日志 ImportError | constructor 直接 `NotImplementedError`（接入时改）| heartbeat status=`logged_out` |

> **error 字段语义**：error 为非空字符串即代表本次操作失败；server 端**不解析 error 内容做分支**
> （error 是给运维看的，不是给状态机看的）。状态机只看 `broker_order_id is None` 或 `submitted is False`。

---

## 6. 服务器侧能力探测

server 在派 `LiveBrokerCommand` 之前应查 `brokerCapabilityMatrix.ts` 的 `getBrokerCapability(broker_key)`：

```ts
import { getBrokerCapability, isOrderTypeSupported } from './brokerCompatMatrix';

const cap = getBrokerCapability('qmt');
if (!cap || !cap.trading_supported) {
  throw new Error(`broker ${broker_key} 不支持下单`);
}
if (!isOrderTypeSupported('qmt', 'LIMIT')) {
  throw new Error(`broker qmt 不支持 LIMIT`);
}
```

未来加新 broker（华泰、东方财富等）只需扩本表 + TS 常量 + 单测自动验通过。

---

## 7. 变更流程

1. 改 broker 能力（新增 order_type / 修复 status 映射）→ 同时改三处：
   - `integrations/broker-bridge/<broker>_bridge/<broker>_adapter.py` 真实现
   - `docs/broker_bridge_compat_matrix.md` 表格行
   - `backend/src/live-trading/brokers/brokerCompatMatrix.ts` 常量
2. 跑 `cd backend && npm test -- --filter=broker-compat-matrix`，必过。
3. PR 描述里说明本次变更是 server fail-closed 收紧、放开（影响七闸门派单）还是 bridge 侧实现补齐（影响真单执行）。

---

## 8. 关联文档

- `docs/trader-system/60_execution_overview.md` §C.5（本文档对应的设计章节）
- `docs/trader-system/63_execution_bridge.md`（bridge 协议 / 签名 / 状态机详解）
- `docs/QMT_PTRADE_LIVE_TRADING_ROADMAP.md`（整体上线路线图）
- `integrations/broker-bridge/QMT_INTEGRATION.md`（QMT Windows 接入指南）
- `docs/live_trading_state_machine.md`（订单状态机字典）
