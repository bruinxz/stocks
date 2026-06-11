# 实盘上线当天 RUNBOOK（One-pager）

> 打印或开第二屏。整个交易日不要离开桌面。
> 详细背景见 `docs/live_trading_launch_checklist.md` / `docs/live_trading_review_round_2.md`。

## 当天时间表

| 时间 | 你要做的事 |
| - | - |
| **T-1 收盘后** | 跑 `bash scripts/preflight/run_all.sh`；必须全 ✅ |
| **T-1 收盘后** | 跑 `node scripts/ops/end_of_day_reconciliation.js`（T-1 只读预热复盘） |
| **08:30** | 起 PG / Redis；`systemctl status postgresql redis-server` 均 active |
| **08:35** | 检查 `.env`：`grep '^LIVE_TRADING_ENABLED\|^LIVE_ORDER_EXECUTION_ENABLED\|^LIVE_TRADING_KILL_SWITCH' /opt/stocks/shared/backend.env`，必须分别 `true / true / true`（kill switch 还要保持熔断到 09:25） |
| **08:40** | `systemctl restart stocks-backend.service`；`journalctl -u stocks-backend -n 50` 看到 `[preflight] production env 校验通过` |
| **08:45** | bridge 端启动 + 在 QMT 客户端确认账户已登录且勾"允许策略下单"；服务端跑 `psql -c "SELECT * FROM live_broker_bridge_heartbeats ORDER BY received_at DESC LIMIT 3"`，确认看到 online 心跳 |
| **08:50** | 浏览器登录前端 admin 账号，打开 LiveTrading 页面 → 灰度账户 → 同步只读账户；账户卡片应显示真实资产（**不是 100000**） |
| **09:15** | 二次确认：风控阈值、kill switch 状态、bridge 心跳 |
| **09:25** | **改 `LIVE_TRADING_KILL_SWITCH=false`** + `systemctl restart stocks-backend`；从此刻起真下单通道打开 |
| **09:30–11:30** | 盘中值守（见下） |
| **13:00–15:00** | 同上 |
| **15:00** | 收盘；`systemctl restart` 不必，但 `LIVE_TRADING_KILL_SWITCH=true` + `restart` 防夜里误触发 |
| **15:30** | `node scripts/ops/end_of_day_reconciliation.js`；与 QMT 客户端"今日成交"页面逐笔对照 |

## 盘中值守

- **每 15 分钟**看一次飞书"实盘告警"群；任何 `🚨 critical` 或 `❌ error` 立即看
- **每 30 分钟**刷新 LiveTrading 页面，确认账户卡片、持仓、活跃委托数字与 QMT 客户端一致
- **每 1 小时**跑：
  ```sql
  SELECT count(*), status FROM live_broker_commands
    WHERE created_at >= now() - interval '1 hour' GROUP BY 2;
  SELECT count(*), bridge_status FROM live_orders
    WHERE created_at >= now() - interval '1 hour' GROUP BY 2;
  ```

## 紧急止血三件套（任一异常立即同时做三件）

```bash
# A. 服务端 kill switch（最快，5 秒生效）
KILL_SWITCH_TOKEN=<admin-jwt> bash scripts/ops/kill_switch_trigger.sh "异常详细" manual

# B. bridge 机 local kill switch（保险）
ssh <bridge-host> 'touch /path/to/KILL_SWITCH_ON'

# C. 兜底：改 .env 后重启 server
sudo sed -i 's/^LIVE_TRADING_KILL_SWITCH=.*/LIVE_TRADING_KILL_SWITCH=true/' /opt/stocks/shared/backend.env
sudo systemctl restart stocks-backend.service
```

异常恢复后：

```bash
# 1. 删除 bridge 本地文件
ssh <bridge-host> 'rm -f /path/to/KILL_SWITCH_ON'
# 2. 解除服务端
KILL_SWITCH_TOKEN=<admin-jwt> bash scripts/ops/kill_switch_resolve.sh "已解决：..."
# 3. .env 改回 false + restart
```

## 撤单

- 用户撤单：前端 LiveTrading 页面"活跃委托"行的"撤单"按钮
- bridge 也挂了：直接去 QMT 客户端手动撤；事后跑：
  ```sql
  UPDATE live_broker_commands SET status = 'cancelled', finalized_at = now()
    WHERE id = <cmd_id>;
  -- 然后写一条 audit 标 manual_broker_cancel
  ```

## 当天叫停条件（任一发生立刻进 §4.2 回滚）

- 同一分钟内 ≥3 个 `🚨 critical` 告警
- LiveTrading 页面账户资产数字与 QMT 客户端差异 > 1%
- 出现非预期成交（用户没强确认但 `live_trades` 多了行）
- bridge 心跳断 > 5 分钟
- 任一笔单成交价偏离限价 > 1%

## 回滚（如需）

```bash
# 1. 立刻熔断
KILL_SWITCH_TOKEN=<admin-jwt> bash scripts/ops/kill_switch_trigger.sh "回滚中" manual

# 2. 切回上一版本
ls -1dt /opt/stocks/releases/* | head -3   # 看可选版本
sudo ln -sfn /opt/stocks/releases/<prev> /opt/stocks/current
sudo systemctl restart stocks-backend.service

# 3. 灰度账户禁用
psql -c "UPDATE live_broker_accounts SET is_active=false WHERE account_role='grayscale'"

# 4. 跑 health gate
curl -fsS http://127.0.0.1:3000/health
```

## 速查表

| 想看什么 | 命令 |
| - | - |
| backend 实时日志 | `journalctl -u stocks-backend -f` |
| bridge 心跳 | `psql -c "SELECT * FROM live_broker_bridge_heartbeats ORDER BY received_at DESC LIMIT 5"` |
| 当日命令 | `psql -c "SELECT * FROM live_broker_commands WHERE created_at::date = CURRENT_DATE ORDER BY id DESC LIMIT 20"` |
| 当日成交 | `psql -c "SELECT * FROM live_trades WHERE trade_time::date = CURRENT_DATE ORDER BY id DESC LIMIT 20"` |
| 当日异常 audit | `psql -c "SELECT event_type, severity, message FROM live_execution_audit_logs WHERE created_at::date = CURRENT_DATE AND severity IN ('warning','error','critical') ORDER BY created_at DESC LIMIT 30"` |
| kill switch 状态 | `KILL_SWITCH_TOKEN=<jwt> bash scripts/ops/kill_switch_status.sh` |

## 联系人

- 主负责：__________
- 备援：__________
- 飞书"实盘告警"群链接：__________
- 1Password Vault：__________

---

**收尾**：当日没问题 → 写一段简短复盘到 `docs/post_mortem_<date>.md`（即便没事也记一条，作为基线）；
有问题 → 用 `docs/templates/post_mortem_template.md` 模板写完整复盘。
