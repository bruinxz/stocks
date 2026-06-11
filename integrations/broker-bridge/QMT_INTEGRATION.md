# QMT Bridge Windows 接入指南

> 把本仓库的 `qmt_adapter.py` 跑起来，让它真的连到 QMT 客户端、能读账户/持仓/委托并下真单。
> 本文是给在 **Windows + QMT 客户端 + 真券商账户**机器上做接入的工程师看的，
> 假设你已经看过 `docs/live_trading_launch_checklist.md` 知道整个上线流程。

## 前置条件

- Windows 10/11，已安装 QMT 极速策略交易系统（迅投）
- 用真实账户在 QMT 客户端登录，且在 **"系统设置 → 账户管理 → 模型设置"** 中勾选"允许策略下单"
  - 没勾这一项，xtquant 收到的所有 order_stock 都会返回失败，且 QMT 客户端不会有任何弹窗，**只能事后查 broker_order_id<0 才知道**
- Python 3.9–3.11（xtquant 在 3.12 上有兼容问题，建议 3.10）
- 服务器已部署完 `live_trading_launch_checklist.md` §1，给你分配了一个 `bridge_key` 和 `bridge_secret`

## 安装

1. 把仓库 `integrations/broker-bridge/` 整目录拷到 Windows 机器（建议路径 `C:\stocks-bridge\`，避免空格和中文）。
2. 安装 Python 依赖：
   ```powershell
   cd C:\stocks-bridge
   pip install -r requirements.txt
   pip install xtquant
   ```
   `xtquant` 必须从迅投官方渠道安装；公网 PyPI 上的同名包是占坑的旧版本，不能用。具体看 QMT 客户端目录下的 `bin\xtquant\` 是否带 `.whl`，有就 `pip install <whl-path>`。
3. 写 `config.yaml`：
   ```powershell
   copy config.example.yaml config.yaml
   notepad config.yaml
   ```
   关键字段：
   - `server_base_url`: `https://<生产域名>/api/live-trading/bridge`（**HTTPS**）
   - `bridge_key` / `bridge_secret`: 服务器侧分配
   - `qmt_userdata_path`: QMT 客户端的 userdata 目录，通常是 `C:\迅投极速策略交易系统\userdata`
   - `qmt_account_id`: 资金账号（不是手机号）
   - `allow_order_execution`: **灰度阶段 true，但配合 server 端 `LIVE_ORDER_EXECUTION_ENABLED` 双开关**
   - `readonly_only`: 灰度阶段 false；只读预热阶段 true
   - `max_single_order_amount`: 本地兜底（元），建议 2000
   - `local_kill_switch_file`: 选一个 bridge 进程有写权限的绝对路径，**建议放在桌面或独立盘**，紧急时一个 `touch` 就能熔断

## 自检（接 QMT 之前）

不依赖 xtquant 跑一遍单测，确认骨架没问题：

```powershell
cd C:\stocks-bridge
python -m qmt_bridge.test_qmt_adapter
# 应看到 19 passed, 0 failed
```

如果有 fail，先解决再继续。

## 第一次跑 bridge（只读模式）

1. 在 QMT 客户端登录账户，确认资产/持仓页面有数据。
2. `config.yaml` 设：
   ```yaml
   readonly_only: true
   allow_order_execution: false
   ```
3. 启动：
   ```powershell
   python -m qmt_bridge.main --config config.yaml
   ```
4. 5 分钟内服务器侧应能看到：
   ```sql
   SELECT * FROM live_broker_bridge_heartbeats
     WHERE bridge_key = '<your-bridge-key>'
     ORDER BY received_at DESC LIMIT 5;
   -- 期望 status=online、broker_client_status=logged_in
   ```
5. 在服务器 LiveTrading 页面切到对应账户的"只读视图"，应能看到资产/持仓数字与 QMT 客户端一致（**不是 stub 的 100000**）。

只读模式跑稳一个完整交易日后，才能进真下单。

## 切真下单（灰度阶段）

按以下顺序，**任何一步异常都立即停手**：

1. `config.yaml` 改：
   ```yaml
   readonly_only: false
   allow_order_execution: true
   ```
2. 重启 bridge 进程。
3. 在服务器 LiveTrading 页面用灰度用户创建一笔金额 ≤ `max_single_order_amount` 的草稿。
4. 强确认提交，盯 4 处：
   - PG `live_broker_commands` 出现 `status=pending` 行
   - bridge 日志 30s 内拉到该 cmd，`ack` 成功
   - PG `live_broker_events` 看到 `submitted` 事件、`live_broker_commands` 推到 `submitted`
   - QMT 客户端委托列表出现该笔，**broker_order_id 与服务器记录一致**
5. 等真实成交回报，`live_broker_events` → `trade`、`live_broker_commands` → `filled`、`live_orders.bridge_status=filled`、`live_trades` 落行。
6. 故意做一次撤单验证 cancel_order 链路。

## xtquant 关键 API 速查

接入时如果 query/place 返回字段对不上，对照 `qmt_adapter.py` 文件顶部的 docstring，列了 QMT v2.x 的真实 API 签名和 `XtAsset/XtPosition/XtOrder/XtTrade` 的字段名。

不同 QMT 版本可能微调字段名（比如 `volume` vs `qty`），如果遇到全部字段为 0，先在 Python REPL 里 `dir(asset)` 看真实字段名，再回去改 `qmt_adapter.py` 里的 `getattr(asset, "字段名", 0)`。

## 故障排查

| 现象 | 可能原因 | 处置 |
| - | - | - |
| `xtquant import 失败` | 没装 xtquant 或 Python 版本不对 | 用 QMT 客户端目录下的 whl 装 |
| `XtQuantTrader.connect() 返回 -1` | QMT 客户端未登录 / 未开放策略交易 | 客户端勾选"允许策略下单"，重新登录 |
| `subscribe(account) 返回非 0` | account_id 写错 / 账户不在 QMT 客户端 | 资金账号是数字串，不是手机号 |
| 心跳一直 `logged_out` | `is_logged_in()` 内的 `query_stock_asset` 抛错 | 看 bridge 日志，通常是 QMT 客户端进程崩了 |
| 下单成功但 server 没收到 trade 事件 | bridge 主循环没在跑 snapshot loop | 看 `_snapshot_loop` 日志是不是在 backoff |
| broker_order_id 类型错（int/string） | 不同 QMT 版本 order_stock 返回类型不同 | adapter 已 `str(ret)` 兜底；如果 cancel 时"不是合法整数"，确认 broker_order_id 是数字串 |

## 进程级注意事项

- **session_id 必须唯一**：adapter 用 `int(time.time())` 兜底，但同一秒重启两次仍会撞。重启时停 5 秒再起。
- **不要在多台机器同时跑同一个 bridge_key**：server nonce 表跨进程去重会让其中一边一直 401。
- **建议挂 NSSM 装系统服务**：QMT 客户端要长期登录，bridge 要长期跑；用任务计划/启动文件夹/NSSM 让它崩了能自动起。
- **日志至少留 30 天**：`bridge_<date>.log` 滚动，本机+服务器各一份。
