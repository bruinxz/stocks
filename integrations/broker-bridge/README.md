# broker-bridge

本地交易桥。配合 QMT / PTrade 客户端，把账户/持仓/委托/成交推送到项目服务器，
并执行服务器派发的下单 / 撤单命令。

## 设计原则（路线图 §3 / §6 / §7）

- **服务器不存券商密码**：bridge 跑在用户本地登录 QMT/PTrade 的机器上，密码留在本地。
- **bridge 主动连接服务器**：bridge → server 推数据 + 长轮询拉命令；服务器永远不主动连 bridge。
- **HMAC 签名**：`X-Live-Bridge-Key/Timestamp/Nonce/Signature`，时钟偏差 60s 内有效，nonce 5 分钟去重。
- **TTL + ack 双保险**：服务器派发命令后 bridge 必须 ack；超过 TTL 未 ack 自动 expired，绝不自动重试。
- **event_seq 单调**：`wall_clock_us * 10000 + atomic_counter`，跨重启持久化最后一次 max seq。
- **本地 kill switch**：`KILL_SWITCH_ON` 文件存在即拒绝所有下单。

## 目录

```
broker-bridge/
  bridge_common/    # 协议层（签名、HTTP client、event_seq、kill switch、模型）
  qmt_bridge/       # QMT 适配（xtquant）
  ptrade_bridge/    # PTrade 适配
  config.example.yaml
```

## 快速开始

1. `cp config.example.yaml config.yaml` 并填好 `bridge_key/bridge_secret/server_base_url`。
2. 在服务器侧用运维接口把 `bridge_key` 绑定到 `live_broker_accounts.bridge_key`。
3. `python -m qmt_bridge.main --config config.yaml` 启动。

仅 stub：本仓库目前只实现协议骨架与配置加载，QMT/PTrade 真实 API 调用留 TODO，
便于先把 server 侧链路打通后再分别替换。

## 配置不要提交到 Git

`config.yaml` 含密钥；`.gitignore` 已经覆盖。生产环境通过运维平台分发。
