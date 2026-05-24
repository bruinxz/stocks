# 多环境部署说明（main / lym / xz）

> **xz 开发者完整上下文（换机、AI 交接）请读：[DEV_XZ_ONBOARDING.md](./DEV_XZ_ONBOARDING.md)**

## 环境隔离

| 环境 | 服务器路径 | 后端 | 前端 | systemd |
|------|------------|------|------|---------|
| main | `/opt/stocks` | 3000 | 3001 | `stocks-backend.service` |
| lym | `/opt/stocks-lym` | 3010 | 3011 | `stocks-backend-lym.service` |
| xz | `/opt/stocks-xz` | 3020 | 3021 | `stocks-backend-xz.service` |

各环境独立 `releases/` + `current` 软链 + `shared/backend.env`，**默认发布不会互相切换目录**。

## 默认行为（不变）

```bash
node scripts/deployment/deploy_release_package.js
# 等价于 DEPLOY_TARGETS=main,lym
```

只更新 main 与 lym，**不会动 xz**。

## 只发布 xz（推荐 xz 开发者使用）

```bash
bash scripts/deployment/deploy_xz.sh
# 或
DEPLOY_TARGETS=xz node scripts/deployment/deploy_release_package.js
```

## Git 分支建议

| 分支 | 用途 |
|------|------|
| `main` | 生产主线 |
| `dev_lym` | lym 沙箱功能开发 |
| `dev_xz` | xz 沙箱功能开发 |

xz 开发流程与 lym 对齐：在 `dev_xz` 上改代码 → 本机构建 → **仅** `deploy_xz.sh` 发布到 `/opt/stocks-xz`。

## 避免 lym 与 xz 互相干扰

1. **发布隔离**：各自用 `DEPLOY_TARGETS=lym` 或 `xz`，不要误用默认 `main,lym` 时期望更新 xz。
2. **定时任务 / 队列**：沙箱 `shared/backend.env` 建议保持：
   - `DISABLE_SCHEDULER=true`
   - `DISABLE_QUEUE_WORKERS=true`
   避免与 main 或其它沙箱重复跑 Bull / cron。
3. **Redis（可选）**：若某沙箱需要开启 worker，建议在对应 `shared/backend.env` 使用不同 `REDIS_DB`（例如 lym=0，xz=2）。
4. **数据库**：当前三套环境共用 `stock_backtest`；模拟盘默认用户可通过 `PAPER_TRADING_DEFAULT_USERNAME` 区分（lym / xz）。

配置定义见 `scripts/deployment/release_targets.js`。
