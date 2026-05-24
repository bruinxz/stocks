# xz 开发者上手指南（换机 / 新会话必读）

> 仓库：`https://github.com/bruinxz/stocks`  
> 沙箱分支：`dev_xz`（已合并部署相关改动到 `main`）  
> 最后更新：2026-05-24  

本文档汇总 xz 环境的服务器布局、Git 流程、发布脚本与隔离设计，避免换机器或新开 AI 会话时重复踩坑。

---

## 1. 项目是什么

A 股**回测 + 量化研究 + 模拟盘 + AI 投顾**一体化平台：

- **后端**：Node.js + TypeScript + Express + Sequelize + PostgreSQL（TimescaleDB）+ Redis + Bull  
- **前端**：React + Ant Design + Redux Toolkit  
- **架构说明**：根目录 `AGENTS.md`（事件驱动回测、模块角色划分）  
- **功能手册**：`docs/FUNCTION_GUIDE_AND_OPERATION_MANUAL.md`  

---

## 2. 三台服务器环境（同一项目，三套目录）

同一台机器 `103.242.3.87` 上并行三套部署根，**互不默认覆盖**：

| 环境 | 部署根 | `current` 示例 | 后端 | 前端 (Nginx) | systemd |
|------|--------|----------------|------|--------------|---------|
| **main** 主站 | `/opt/stocks` | `releases/20260523142541-main` | 3000 | 3001 | `stocks-backend.service` |
| **lym** 沙箱 | `/opt/stocks-lym` | `releases/…-lym` | 3010 | 3011 | `stocks-backend-lym.service` |
| **xz** 沙箱 | `/opt/stocks-xz` | `releases/…` 或历史 `initial` | **3020** | **3021** | `stocks-backend-xz.service` |

**xz 访问地址（看 feature 用这个）：**

- 前端：<http://103.242.3.87:3021>  
- 后端 API：<http://103.242.3.87:3020>  
- 健康检查：<http://103.242.3.87:3020/health>  

Nginx 配置：`/etc/nginx/sites-enabled/stocks-dev-envs.conf`（xz 段 listen 3021）。

进程管理：**systemd**（不是 PM2）。重启 xz 后端：

```bash
sudo systemctl restart stocks-backend-xz
```

---

## 3. 目录结构（releases / current / shared）

```text
/opt/stocks-xz/
├── current → releases/<时间戳>-xz    # 软链，线上只跑这一份
├── releases/
│   ├── initial/                     # 早期快照（可能落后于 main）
│   └── <YYYYMMDDHHMMSS>-xz/       # 每次 deploy_xz 自动新建
├── shared/
│   ├── backend.env                  # 密钥、端口、DISABLE_* 开关（不打进 tar）
│   └── frontend.env.production      # REACT_APP_API_BASE_URL=/api
├── repo/                            # 可选：服务器上 git clone，便于在机子上改部署脚本
└── .ssh/                            # 服务器推 GitHub 用的 deploy key（见 §8）
```

要点：

- **`releases/*` 不是 Git 仓库**，是每次发布的**只读快照**；不要在某个 release 里长期手改当开发目录。  
- **`shared/`** 跨版本共用：数据库密码、JWT、`PORT=3020`、是否禁用调度器等。  
- **开发在 Git（本机或 `repo/`）**，**运行在 `current`**。

与主站 `/opt/stocks` 对比：主站 `releases/` 下约有 70 个历史版本；xz 若长期只用 `initial` 会**落后于** Git `main`，需用 `deploy_xz.sh` 发新版。

---

## 4. Git 分支策略（注意：主线叫 `main`，不是 `master`）

| 分支 | 用途 |
|------|------|
| `main` | 生产主线，含全量功能（如实盘 `live-trading` 等） |
| `dev_lym` | lym 沙箱功能开发 |
| **`dev_xz`** | **xz 沙箱功能开发（你用这个）** |

### 换机 / 新机第一次

```bash
git clone https://github.com/bruinxz/stocks.git
cd stocks
git fetch origin
git checkout dev_xz
# 与最新主线对齐（可选）：
git fetch origin
git rebase origin/main
```

### 日常提交

```bash
git add .
git commit -m "..."
git push origin dev_xz
```

功能稳定后可 PR / merge 到 `main`（团队约定）。

**重要：`deploy_xz.sh` 不会执行 `git push`**。部署与推代码是**两步**。

---

## 5. 标准开发迭代流程（与 lym 对齐）

```text
┌─────────────┐    git push     ┌──────────┐   deploy_xz.sh   ┌─────────────────┐
│ 本机 dev_xz │ ──────────────► │  GitHub  │ ◄─────────────── │ 本机执行脚本     │
│ 改代码+自测  │                 │          │                  │ 构建+上传+激活   │
└─────────────┘                 └──────────┘                  └────────┬────────┘
                                                                       │
                                                                       ▼
                                                            /opt/stocks-xz/releases/新目录
                                                            current → 新目录 → :3021 访问
```

### 5.1 本地开发自测

```bash
# 后端
cd backend && npm install && npm run dev    # 默认本机 3000

# 前端（新终端）
cd frontend && npm install
# 配置 frontend/.env.development.local：
#   REACT_APP_API_BASE_URL=http://localhost:3000/api
PORT=3001 npm start
```

本地端口与服务器 xz（3020/3021）**无关**。

### 5.2 部署到 xz 沙箱（只动 xz，不动 main/lym）

在本机仓库**根目录**：

```bash
export DEPLOY_PASSWORD='...'   # SSH 用户 deploy
export OPS_PASSWORD='...'      # ops sudo（release 健康检查）

bash scripts/deployment/deploy_xz.sh
```

等价于：

```bash
DEPLOY_TARGETS=xz RELEASE_TARGETS=xz node scripts/deployment/deploy_release_package.js
```

脚本会（详见 `scripts/deployment/deploy_release_package.js`）：

1. 本机 `tsc` + `frontend build`（可用 `DEPLOY_SKIP_BUILD=true` 跳过）  
2. 打 `stocks_release_root.tgz`（不含 `.git`、`.env`、`node_modules`）  
3. 上传到服务器 `/tmp/stocks-upload/`  
4. 执行 `/tmp/activate_stocks_release.sh /opt/stocks-xz xz` → **新建** `releases/<时间>-xz` 并切换 `current`  
5. 从 **`/opt/stocks-xz/current`** 跑 `release_health_gate.js`：重启 `stocks-backend-xz`、smoke、失败回滚上一版  

**默认** `deploy_release_package.js` 的 `DEPLOY_TARGETS` 仍是 `main,lym`，**不会更新 xz**。

部署目标配置集中定义在：`scripts/deployment/release_targets.js`。

更短的隔离说明：`docs/DEPLOY_ENVIRONMENTS.md`。

---

## 6. 与 lym / main 如何避免互相干扰

| 机制 | 说明 |
|------|------|
| 发布目标隔离 | xz 必须用 `deploy_xz.sh` 或 `DEPLOY_TARGETS=xz` |
| 目录隔离 | `/opt/stocks-xz` vs `/opt/stocks-lym` vs `/opt/stocks` |
| 端口隔离 | 3020/3021 vs 3010/3011 vs 3000/3001 |
| 进程隔离 | 独立 systemd unit |
| 调度 / 队列 | xz `shared/backend.env` 建议保持 `DISABLE_SCHEDULER=true`、`DISABLE_QUEUE_WORKERS=true` |
| Redis（可选） | 若开 worker，建议 xz 用 `REDIS_DB=2`，lym 用 `0`，避免 Bull 抢任务 |
| 数据库 | 当前三套共用 `stock_backtest`；模拟盘可用 `PAPER_TRADING_DEFAULT_USERNAME` 区分 |

---

## 7. 发布脚本与「在 release 下新建文件夹」

**不是**人工 `cp` 上一版再改。

自动建目录的是服务器上的 **`/tmp/activate_stocks_release.sh`**（由部署脚本 SSH 调用）：

- 新目录名：`releases/<YYYYMMDDHHMMSS>-xz`  
- 解压本机上传的 tar  
- 注入 `shared/backend.env` → `backend/.env`  
- 复用上一版 `node_modules` 软链（加快激活）  
- `current` 指向新目录  

历史 `releases/*` 保留用于**回滚**，平时只有 `current` 在提供服务。

---

## 8. 服务器侧 Git（可选）

路径：`/opt/stocks-xz/repo`（`git@github.com:bruinxz/stocks.git`）。

- 日常开发**推荐本机 clone**，不必在服务器改业务代码。  
- 服务器 deploy key：`/opt/stocks-xz/.ssh/id_ed25519_github.pub`（已加 GitHub Deploy key 时可从服务器 `git push`）。  

---

## 9. xz 与 Git `main` 的版本关系（历史背景）

- Git `main` @ 2026-05-23 与 `/opt/stocks/current` 基本同步。  
- `/opt/stocks-xz/releases/initial` 约为 2026-05-19 快照，**缺少**如实盘 `live-trading`、模拟盘订单意图等后续功能。  
- 在 xz 上看最新代码：**必须**跑过至少一次 `deploy_xz.sh`，不要假设 `initial` 等于 `main`。  

---

## 10. 常用命令速查

```bash
# 本机
git checkout dev_xz && git pull origin dev_xz
git rebase origin/main
bash scripts/deployment/deploy_xz.sh

# 服务器（需 sudo）
sudo systemctl status stocks-backend-xz
sudo systemctl restart stocks-backend-xz
readlink -f /opt/stocks-xz/current
ls -lt /opt/stocks-xz/releases | head
curl -s http://127.0.0.1:3020/health
```

默认测试账号（见 `AGENTS.md`）：`xz / 666`（服务器 `User` 表 bcrypt 由模型钩子处理，勿手动 double-hash）。

---

## 11. 相关文档索引

| 文件 | 内容 |
|------|------|
| `README.md` | 项目概述、本地 Docker 启动 |
| `AGENTS.md` | 回测引擎角色、事件流、模型规范（snake_case） |
| `docs/DEPLOY_ENVIRONMENTS.md` | main/lym/xz 部署隔离简表 |
| `docs/FUNCTION_GUIDE_AND_OPERATION_MANUAL.md` | 业务功能与运维手册 |
| `docs/AUTONOMOUS_ITERATION_PROGRESS.md` | 自动迭代 / 机器交接进度 |
| `scripts/deployment/release_targets.js` | 三环境路径、端口、systemd 元数据 |
| `scripts/setup_and_db/init-db-full.sql` | 数据库全量 schema |

---

## 12. 给 AI / 新同事的提示

若在新会话中继续改 xz 相关代码，请默认：

1. Git 分支：`dev_xz`；主线名：`main`。  
2. 部署 xz：**仅** `deploy_xz.sh`，不要改默认 `DEPLOY_TARGETS` 影响 lym。  
3. 验证地址：**3021 / 3020**，不是 3001/3010。  
4. 不要在 `/opt/stocks-xz/releases/<某版>` 里做长期开发；改 Git + 重新 deploy。  
5. `deploy_xz.sh` ≠ `git push`，两步都要做。
