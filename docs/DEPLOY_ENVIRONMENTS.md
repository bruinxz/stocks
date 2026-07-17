# 生产部署说明（main-only）

当前只保留一个生产环境：

| 环境 | 根目录 | 后端 | 前端 | systemd |
|---|---|---|---|---|
| main | `/opt/stocks` | 3000 | 3001 | `stocks-backend.service` |

历史 `lym` / `xz` 沙箱已经关停，不再是发布目标，也不再共享生产数据库或 Redis。

## 目录约定

- `/opt/stocks/releases/<release-id>`：不可变发布目录
- `/opt/stocks/current`：指向当前发布的软链
- `/opt/stocks/shared/backend.env`：生产环境变量，不进入 Git
- `/opt/stocks/shared/logs`：跨 release 日志
- `/opt/stocks/shared/venv`：Python 运行环境

## 发布

```bash
export SSH_HOST='<production-host>'
export DEPLOY_PASSWORD='<deploy-user-password>'
export OPS_PASSWORD='<ops-user-password>'
bash scripts/deployment/deploy_remote_build.sh main main
```

该脚本会在远端拉取已推送的 `main`、安装 Node/Python 依赖、构建前后端、创建不可变 release、切换 `current`、重启 `stocks-backend.service` 并执行健康门禁。`scripts/ops/deploy_main_release.sh` 是服务器侧旧制品解包脚本，不是当前发布入口。

发布完成必须验证：后端 health、前端静态资源、数据库 schema、scheduler active count、默认自动浏览会话以及核心只读 smoke。

## 约束

1. 只从已合入 `main` 的提交构建 release。
2. 禁止把服务器地址、密码、令牌、私钥或真实 `.env` 打进 release 包/提交历史。
3. 禁止直接修改 `current`；需要修复时创建新 release。
4. 回滚只切换软链，并重新执行 health gate。
5. 数据同步与 scheduler 只在 main 运行，避免重复写入。

发布目标定义以 `scripts/deployment/release_targets.js` 为准。
