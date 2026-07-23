# 本地开发环境说明

本文说明如何在本地运行前后端，同时通过 SSH 隧道连接远端测试数据库 `stock_backtest_dev`。该环境用于日常开发、接口调试、页面联调和量化功能验证；它不是生产环境，也不是长期保留测试数据的环境。

## 架构约定

本地开发链路如下：

```text
frontend localhost:3001
  -> backend localhost:3002
  -> SSH tunnel localhost:15432
  -> remote PostgreSQL stock_backtest_dev
```

关键约定：

- 本地后端必须连接 `stock_backtest_dev`，不要连接生产库 `stock_backtest`。
- 数据库用户使用 `stock_dev`。
- Redis 使用本地 `127.0.0.1:6379`，不要连接远端 Redis。
- 前端通过 `frontend/.env.development.local` 请求 `http://localhost:3002/api`。
- `backend/.env`、`frontend/.env.development.local` 都是本地文件，不提交敏感信息。

本地脚本会校验 `backend/.env` 必须指向：

```bash
DB_HOST=127.0.0.1
DB_PORT=15432
DB_NAME=stock_backtest_dev
DB_USER=stock_dev
```

如果不满足，脚本会拒绝启动后端，避免误连生产库。

## 启停脚本

统一使用：

```bash
scripts/development/local-dev.sh
```

首次使用前，需要在本机 shell 中提供远端 SSH host：

```bash
export STOCKS_DEV_SSH_HOST=<remote-host>
```

该值只用于建立本地数据库隧道，不要把真实主机、密码或私钥写进仓库。

查看帮助：

```bash
scripts/development/local-dev.sh --help
```

查看当前状态：

```bash
scripts/development/local-dev.sh status
```

状态里后端会额外显示 DB-backed 健康，例如：

```text
backend   running  pid=12345  port=3002  backend-db=ok
```

如果看到 `backend-db=down(tunnel)` 或 `backend-db=down(api)`，说明后端进程还在，但已经不能正常访问测试库。此时不要只看 `/health`，直接执行：

```bash
scripts/development/local-dev.sh repair
```

停止全部本地服务：

```bash
scripts/development/local-dev.sh stop
```

查看日志：

```bash
scripts/development/local-dev.sh logs backend
scripts/development/local-dev.sh logs frontend
scripts/development/local-dev.sh logs tunnel
scripts/development/local-dev.sh logs redis
```

日志和 pid 文件放在：

```text
tmp/local-dev/
```

在 macOS 上，脚本会优先使用当前用户的 `launchctl` 临时托管后端和前端进程；因此 `start` 返回后服务仍会保留，`status` 和 `stop` 也可以在新的终端里继续使用。在非 macOS 环境下，脚本会退回到普通 `nohup` 后台启动。

SSH 隧道默认使用密码优先模式，避免本机 SSH agent 里过多 key 导致 `Too many authentication failures` 后还没来得及输入密码就失败。如果你已经配置好可用私钥，可以改用：

```bash
export STOCKS_DEV_SSH_AUTH_MODE=auto
```

脚本会把上次使用过的 SSH host 缓存在 `tmp/local-dev/ssh-host`，方便 `repair` 在新终端里复用；缓存里不保存密码。

## 三档启动模式

### safe：默认模式

```bash
scripts/development/local-dev.sh start
# 等价于
scripts/development/local-dev.sh start safe
```

适合：

- 页面开发
- 普通 API 联调
- 读取测试库数据
- 手动触发的轻量接口测试

行为：

- 启动 SSH 数据库隧道
- 启动本地 Redis 或复用已有 Redis
- 启动后端
- 启动前端
- 关闭队列 worker
- 关闭 scheduler
- 关闭实盘后台扫描

这是日常默认选择。

这里的“关闭队列 worker”使用的是 `DISABLE_QUEUE_WORKERS=true` 总开关，会同时关闭数据同步 worker、AI polling worker 和量化回测 worker。需要消费异步量化队列时切到 `quant` 模式。

### quant：量化异步调试模式

```bash
scripts/development/local-dev.sh start quant
```

适合：

- 异步量化回测
- Bull 队列任务进度
- `QUEUED -> RUNNING -> COMPLETED` 这类任务状态流转

行为：

- 在 `safe` 基础上打开队列 worker
- scheduler 仍然关闭
- 默认任务 seed 仍然关闭
- 实盘后台扫描仍然关闭

注意：当前代码里量化 worker、数据同步 worker、AI polling worker 共用 `DISABLE_QUEUE_WORKERS` 总开关。因此 `quant` 模式会打开所有 Bull worker，不是只打开量化 worker。调试时要关注日志，避免误触发数据同步或 AI polling。

### full：完整后台链路模式

```bash
scripts/development/local-dev.sh start full
```

适合：

- 专门验证 scheduler
- 验证默认任务 seed
- 验证后台任务自动触发链路
- 尽量接近完整后端运行形态的联调

行为：

- 打开队列 worker
- 打开 scheduler
- 打开默认任务 seed
- 打开实盘后台扫描

风险：

- 可能自动执行定时任务。
- 可能写入测试库大量任务日志。
- 可能触发数据同步、AI polling、量化任务。
- 多人同时使用时容易互相影响。

`full` 不建议作为日常启动方式。使用前最好确认没有其他人正在依赖测试库做稳定验证。

## 脚本中的保护开关

不管使用 `safe`、`quant` 还是 `full`，脚本都会保持以下开关：

```bash
SKIP_DB_SYNC=true
SKIP_LEGACY_SCHEMA_REPAIR=true
SKIP_RECOMMENDATION_RUNTIME_SYNC=true
SKIP_DEFAULT_USER_INIT=true
```

原因：

- 避免本地启动时对远端测试库执行全量 `sequelize.sync({ alter: true })`。
- 避免每次启动都扫描历史字段兼容逻辑。
- 避免每次启动都同步推荐、量化、实盘运行时表。
- 避免本地启动时 bootstrap 默认用户。

这些开关只影响本地脚本启动的后端进程。远端正常部署没有配置这些变量时，不受影响。即使误把 `SKIP_LEGACY_SCHEMA_REPAIR` 或 `SKIP_RECOMMENDATION_RUNTIME_SYNC` 配到 production，后端也会忽略这两个 skip，并继续执行关键 schema 兜底。

## Redis 行为

脚本会检查 `127.0.0.1:6379`：

- 如果已有 Redis，直接复用。
- 如果没有 Redis，优先尝试用 Docker 启动 `stocks-local-dev-redis`。
- 如果 Docker 不可用，但本机有 `redis-server`，则启动本机 Redis。
- 如果都不可用，脚本会提示先安装或启动 Redis。

停止时：

- 如果 Redis 是脚本启动的 Docker 容器或本地进程，脚本会停止它。
- 如果 Redis 是外部已有服务，脚本不会误停。

## 测试库的定位

`stock_backtest_dev` 是共享测试库，不是个人私有库。

适合：

- 本地页面/API 调试
- 读取接近生产的数据
- 短期量化功能验证
- 可重复创建的测试数据

不适合：

- 长期保留个人测试结果
- 存放不能被覆盖的数据
- 多人同时跑完整后台任务
- 验证生产级调度并发

多人同时开发时：

- 普通读接口通常没问题。
- 写操作会互相可见。
- 使用同一账号会导致收藏、回测、模拟盘、策略配置等数据混在一起。
- `quant` 模式下，每个人的 Bull job 在自己的本地 Redis；数据库任务记录共享，但 job 消费不共享。
- `full` 模式不建议多人同时使用。

## 局限性

### 自动 schema 变更不会执行

本地脚本不会让后端启动时自动修改远端测试库结构。

如果开发涉及新增表、字段、索引或约束：

- 优先写 migration 或明确 SQL。
- 在 `stock_backtest_dev` 上手动执行并验证。
- 不建议为了一次调试关闭 `SKIP_DB_SYNC` 去跑全量 alter。

### 页面投影表由 migration 管理

日韩行情、高倍潜力、PIT 回测证据和 AI 推荐表包含复合外键、约束触发器与
ownership marker，模型的 `sync()` 被刻意设为 no-op，`sequelize.sync({ alter: true })`
不会创建它们。个人本地库首次初始化或重建后执行：

```bash
cd backend
npm run db:apply-projection-schema
```

命令会幂等创建并验证全部页面投影表；发现只安装了一部分时会拒绝继续，避免把
半套 schema 当成成功。共享 `stock_backtest_dev` 仍须按正常 migration 审批流程执行，
不要把个人调试命令直接指向共享或生产数据库。

### 数据不是实时生产数据

测试库是从生产库复制出来的快照。生产库后续新增的行情、任务、用户配置、报告，不会自动进入测试库。

如果发现数据明显过期，需要手工刷新测试库。

### 后台任务默认关闭

`safe` 模式不会跑 scheduler 和 worker。异步任务可能只入队不消费。

需要验证异步量化任务时使用：

```bash
scripts/development/local-dev.sh start quant
```

需要验证 scheduler 时使用：

```bash
scripts/development/local-dev.sh start full
```

### 外部依赖需要单独准备

TradingAgents、akshare、飞书 webhook 等外部依赖不会因为本地脚本自动变得可用。需要调这些链路时，单独确认环境变量和本地服务。

## 测试库数据同步约定

`stock_backtest_dev` 需要定期从生产库手工同步。

建议触发时机：

- 每周固定刷新一次。
- 生产数据结构有重要变化后刷新。
- 行情/量化数据明显过期时刷新。
- 做较大功能联调前刷新。

同步前约定：

- 通知正在使用测试库的人。
- 停止本地 `quant` / `full` 模式。
- 接受测试库里的临时回测、模拟盘、收藏、任务日志会被覆盖。

推荐同步方式：

1. 从生产库 dump。
2. drop/recreate `stock_backtest_dev`。
3. restore 到 `stock_backtest_dev`。
4. 确认 TimescaleDB 扩展和恢复流程正常。
5. 修复 owner 和 grants，使 `stock_dev` 可读写业务表。
6. 按需清理或脱敏敏感数据。
7. 验证核心数据量和本地 API。

验证项：

```bash
scripts/development/local-dev.sh start safe
scripts/development/local-dev.sh check
```

预期：

- DB 隧道可用。
- Redis 可用。
- 后端 `/health` 返回正常。
- DB-backed `/api/stocks?limit=1` 返回成功。
- `status` 显示 `backend-db=ok`。

## 推荐日常流程

开始开发：

```bash
scripts/development/local-dev.sh start safe
```

调异步量化：

```bash
scripts/development/local-dev.sh restart quant
```

调完整后台链路：

```bash
scripts/development/local-dev.sh restart full
```

结束开发：

```bash
scripts/development/local-dev.sh stop
```

如果后端行为异常，先看：

```bash
scripts/development/local-dev.sh status
scripts/development/local-dev.sh logs backend
scripts/development/local-dev.sh check
```

如果页面报 `connect ECONNREFUSED 127.0.0.1:15432`，优先执行：

```bash
scripts/development/local-dev.sh repair
```

`repair` 会重新确认 Redis、SSH 数据库隧道、后端和前端，并且最后必须通过 DB-backed 接口检查，否则会失败并提示看日志。
