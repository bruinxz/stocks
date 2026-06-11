# 实盘部署架构 — Ubuntu server + Windows bridge

> **物理拓扑**：两台机，分工明确。Server 跑业务和数据库，Bridge 跑 QMT 客户端。
> 这份文档是给你看的"全景图"；细节命令仍走 `live_trading_launch_checklist.md` / `live_trading_launch_runbook.md`。

## 1. 谁在哪台机

```
┌────────────────────────────────────────────────────────────┐
│  Ubuntu Server （公网 / 内网均可）                         │
│  ────────────────────────────────────────────────────────  │
│  - Node.js 18+（apt 装或 nodesource）                      │
│  - PostgreSQL 14+                                          │
│  - Redis（可选；任务队列用）                                 │
│  - Nginx（HTTPS / 反向代理）                                │
│  - systemd → stocks-backend.service                        │
│  - pm2 / serve → frontend                                  │
│                                                            │
│  跑：所有 /api/* + LiveTrading 前端 + DB + 风控 + 命令派发    │
└────────────────────────────────────────────────────────────┘
                        ▲
                        │ HTTPS（HMAC 鉴权 + nonce 去重）
                        │ bridge 主动发起；server 永不主动连 bridge
                        │
┌────────────────────────────────────────────────────────────┐
│  Windows 机（你本地 / 云桌面 / 小主机）                       │
│  ────────────────────────────────────────────────────────  │
│  - Windows 10 / 11                                         │
│  - QMT 极速策略交易系统（迅投官方下载，必须登录）              │
│  - Python 3.10（推荐）                                     │
│  - xtquant（从 QMT 客户端目录里的 whl 装）                   │
│  - integrations/broker-bridge/ 目录（仓库这份）              │
│  - 任务计划 / NSSM → python -m qmt_bridge.main              │
│                                                            │
│  跑：QMT 客户端 + bridge 进程（推 heartbeat/snapshot；拉 cmd） │
└────────────────────────────────────────────────────────────┘
```

## 2. 网络方向

- Bridge 端**主动**发起到 server 的 HTTPS 请求：
  - `POST /api/live-trading/bridge/heartbeat`（每 15s）
  - `POST /api/live-trading/bridge/account-snapshot`（每 30s）
  - `POST /api/live-trading/bridge/positions / orders / trades`
  - `GET  /api/live-trading/bridge/order-commands?wait=30`（长轮询，server 端 wait 满 30s 或有命令就返回）
  - `POST /api/live-trading/bridge/order-commands/:id/ack`
  - `POST /api/live-trading/bridge/order-events`
- Server 端**永远不**主动连 bridge。这样：
  - bridge 端不用开公网端口，**用家用宽带都能跑**
  - server 端只用一道 HMAC + nonce + IP 白名单
  - 中间网络 / 路由器 / 公司防火墙都不需要打洞

## 3. 安全分隔

| 项 | Server (Ubuntu) | Bridge (Windows) |
| - | - | - |
| 券商账号密码 | **永远不存** | 只在 QMT 客户端登录，密码留本地 |
| JWT_SECRET | 32+ 随机字符 | 不需要 |
| LIVE_BRIDGE_SECRETS | 服务端配，JSON `{bridge_key: secret}` | bridge 端只配自己的 bridge_key + secret |
| 数据库密码 | 在 `.env` | 不接 DB |
| 数据库实例 | PG 在 server 本机或 VPC 内 | 不需要 |
| 用户登录 | admin / user 登录前端 | 不接受任何用户登录 |

## 4. Ubuntu server 上线步骤（按顺序）

1. **安装依赖**（`apt`）：
   ```bash
   sudo apt update
   sudo apt install -y nodejs npm postgresql redis-server nginx
   # 或用 nodesource 装 node 18+：
   curl -fsSL https://deb.nodesource.com/setup_18.x | sudo bash -
   sudo apt install -y nodejs
   ```

2. **DB 初始化**：
   ```bash
   sudo -u postgres psql -c "CREATE USER stock_admin WITH PASSWORD '<强随机>';"
   sudo -u postgres psql -c "CREATE DATABASE stock_backtest OWNER stock_admin;"
   ```

3. **拉代码 / 构建** —— 走 `node scripts/deployment/deploy_release_package.js`（已修，不再硬编码 macOS 路径）。

4. **写 `.env`** —— 复制 `backend/.env.example.production` 到 `/opt/stocks/shared/backend.env`，填全 `[MUST]` 项。

5. **DB 预检** —— 跑 `node scripts/preflight/db_unique_dup_check.js` 全 ✅。

6. **admin bootstrap** —— `node scripts/ops/admin_bootstrap.js --username lym --apply`（密码走 stdin 隐藏输入）。

7. **systemd** —— 拷贝 `scripts/deployment/samples/stocks-backend.service` 到 `/etc/systemd/system/`，改 ExecStart 里的 node 路径（apt 装就是 `/usr/bin/node`），`sudo systemctl daemon-reload && systemctl enable --now stocks-backend`。

8. **nginx** —— 拷贝 `scripts/deployment/samples/nginx-stocks.conf` 到 `/etc/nginx/sites-available/`，改 server_name、ssl_certificate。

9. **一键预检** —— `bash scripts/preflight/run_all.sh` 全 ✅。

10. **bridge 离线等待中** —— server 起来了但还没接 bridge，`/api/live-trading/safety` 应返回 `broker_gateway=qmt_bridge` + `blockers` 含心跳超时。

## 5. Windows bridge 上线步骤

完全按 `integrations/broker-bridge/QMT_INTEGRATION.md` 来。要点：

1. **不要在 Ubuntu 上跑** `python -m qmt_bridge.main`！xtquant 在 Linux 上 import 必失败，bridge 会一直返回 `connect()=False`，server 心跳超时熔断。
2. **QMT 客户端必须在 Windows 桌面前台**登录并勾"允许策略下单"（这是 QMT 客户端 UI 设置，不是代码层）。
3. bridge 进程**主动**连 server 的 HTTPS：填好 `config.yaml` 里的 `server_base_url=https://<server-domain>/api/live-trading/bridge`。
4. **任务计划程序**让它开机自启 + 崩了自动重启（推荐 NSSM 包装成 Windows 服务）。
5. **Windows 机不要关机**。如果是你个人电脑，强烈建议买个 Windows 云桌面（约 100-300 元/月）专门挂 bridge。

## 6. 验证两边连通

按这个顺序排查：

```bash
# server 端
sudo journalctl -u stocks-backend -f                # 应无 ERROR
curl -fsS http://127.0.0.1:3000/health              # {status:"ok"}

# server PG
psql -c "SELECT * FROM live_broker_bridge_heartbeats ORDER BY received_at DESC LIMIT 3"
# bridge 起来后应每 15s 一条新行；status=online、broker_client_status=logged_in
```

Bridge 端：

```powershell
# Windows bridge 端
python -m qmt_bridge.main --config config.yaml
# 应看到 "QMT 连接成功" + 每 15s "heartbeat" 日志
# 如果是 "xtquant import 失败" → 你装的是 PyPI 同名占坑包，不是 QMT 官方那个
```

## 7. 常见 Ubuntu 特定坑

| 坑 | 解决 |
| - | - |
| `sudo systemctl start stocks-backend` 报 `Failed to execute /usr/bin/node` | `which node` 查实际路径，改 unit ExecStart |
| `npm install` 在 server 上很慢 / 失败 | 不要在 server 上 install；用 `deploy_release_package.js` 在本地构建好 tgz 推过去 |
| `pg_hba.conf` 默认禁外网连接 | 改 `pg_hba.conf` + `postgresql.conf` `listen_addresses='localhost'`（推荐 PG 只听本地，backend 也在同机） |
| Nginx 502 但 backend 正常 | nginx user 没权限连 backend 的 socket / port；用 127.0.0.1:3000 而不是 unix socket |
| systemd 限制 file descriptor | unit 已设 `LimitNOFILE=65535`；bridge 长轮询要靠它 |
| Ubuntu 系统时间偏差 → bridge HMAC 时钟偏差 401 | `sudo apt install chrony && sudo systemctl enable --now chrony` |
| 防火墙 ufw 默认禁 80/443 | `sudo ufw allow 'Nginx Full'` |

## 8. Windows bridge 常见坑

| 坑 | 解决 |
| - | - |
| QMT 客户端被锁屏 / 用户登出 | 用 Windows 自动登录 + 永不锁屏；推荐云桌面 |
| `python -m qmt_bridge.main` 报 import xtquant | xtquant 从 QMT 客户端 `bin\xtquant\*.whl` 装，不是 PyPI |
| `connect() 返回 -1` | QMT 客户端没勾"允许策略下单"，或账号没登录 |
| Windows 时间与 server 偏差 > 60s | `w32tm /resync` 或开 NTP |
| bridge 跨夜后心跳挂了 | QMT 客户端默认 16:00 后会关，重启后 bridge 也得重启；用任务计划重启 |

## 9. 一句话总结

**Ubuntu server** = 业务/数据/风控/前端，公网可见，对外服务。
**Windows bridge** = 只跑 QMT + 一个 Python 进程，对内主动连 server，不需要公网入口。

两边耦合点就一个：**HMAC 签名的 HTTPS 长轮询**。其他一切都不共享：不共享文件系统、不共享密码、不共享数据库。

如果哪天你想换券商（PTrade / 雪球 / 同花顺）只需要换 bridge 侧的 adapter；server 侧一行不用动。

---

## 10. 关于"非 Windows 也能跑 bridge"

技术上能：
- **PTrade** 在 Linux 上有 CTP 通道（需要券商账户支持）
- **雪球 / 同花顺** 有云 API，可以直接在 Ubuntu server 上跑 bridge 进程
- 用 docker on Windows 跑 bridge 配合 wine 跑 QMT —— **不推荐**，xtquant 会各种诡异挂

对你当前阶段（灰度真下单 + QMT），**就别为难自己**：拿一台便宜 Windows 云桌面 / 小主机挂着 24/7，本地有空看一眼，比想办法 Linux 跑 QMT 省心一万倍。
