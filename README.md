# A股股票回测系统

[![CI](https://github.com/bruinxz/stocks/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/bruinxz/stocks/actions/workflows/ci.yml)
[![Security Lint](https://github.com/bruinxz/stocks/actions/workflows/security-lint.yml/badge.svg?branch=main)](https://github.com/bruinxz/stocks/actions/workflows/security-lint.yml)

## 📘 入门指南

**新用户从这里开始**：👉 [docs/USER_GUIDE.md](./docs/USER_GUIDE.md) — step-by-step 教你启动系统、同步数据、选策略、跑模拟盘、阅读复盘、调参、配置风控。

**开发者扩展**（添加新策略 / 新因子 / 新数据源 / 编写测试 / 调试技巧 / 提交规范）：👉 [docs/DEVELOPER_GUIDE.md](./docs/DEVELOPER_GUIDE.md) — 含 7 章完整代码模板，复制即可。

## 项目概述
构建完整的A股股票回测系统与智能辅助决策平台，包含网页操作界面。支持历史数据回测、策略定义、性能分析和可视化展示，并深度集成了多智能体大模型（TradingAgents）以提供个股分析与买卖建议。

## 技术方案

### 技术栈
- **后端**：Node.js + TypeScript + Express.js + PostgreSQL + TimescaleDB + Redis + Bull
- **前端**：React + TypeScript + Ant Design + Recharts + Redux Toolkit
- **数据源**：AKShare (开源A股全市场数据与基本面API) + 代理IP池
- **AI智能体**：TradingAgents (FastAPI, 运行于独立服务器)
- **开发环境**：Docker Compose (PostgreSQL + Redis)

### 架构设计
- **数据层**：AKShare API集成 + PostgreSQL TimescaleDB时序数据库
- **回测引擎**：事件驱动回测，支持多策略、多时间框架
- **API层**：RESTful API + WebSocket/SSE实时更新
- **前端界面**：单页面应用，模块化组件设计
- **任务队列**：Bull + Redis处理长时间回测任务与全市场数据同步

## 工具计划

### 开发工具
- **版本控制**：Git
- **代码质量**：ESLint + Prettier + TypeScript严格模式
- **测试框架**：Jest (后端) + React Testing Library (前端)
- **容器化**：Docker + Docker Compose
- **数据库管理**：Sequelize ORM + Sequelize CLI

### 部署工具
- **容器编排**：Docker Compose / Kubernetes
- **持续集成**：GitHub Actions / GitLab CI
- **监控日志**：Winston + ELK Stack
- **性能监控**：Prometheus + Grafana

### 数据工具
- **数据获取**：AKShare API客户端 + 代理IP池机制 + 定时任务
- **数据清洗**：数据验证和标准化管道
- **数据缓存**：Redis缓存热点数据与分布式锁
- **数据分析**：ta/tulind技术指标库

## 实施计划

### 阶段1：项目初始化 ✅ 已完成
**目标**：搭建基础开发环境

**完成工作**：
1. ✅ 创建项目目录结构
2. ✅ 初始化Git仓库，配置.gitignore
3. ✅ 设置后端项目
   - package.json配置（包含所有依赖）
   - tsconfig.json TypeScript配置
   - 基础Express服务器代码
   - ESLint + Prettier代码质量配置
4. ✅ 设置前端项目
   - Create React App + TypeScript模板
   - Ant Design UI框架集成
   - 基础布局和路由设置
5. ✅ 配置Docker开发环境
   - PostgreSQL + TimescaleDB容器配置
   - Redis容器配置
   - 数据库初始化脚本
6. ✅ 设置代码质量工具
   - ESLint配置（前后端独立）
   - Prettier代码格式化配置

**生成文件**：
- `backend/` - 后端服务完整结构
- `frontend/` - 前端应用完整结构
- `docker-compose.yml` - 开发环境容器配置
- `scripts/init-db.sql` - 数据库初始化脚本
- `.gitignore` - Git忽略配置

### 阶段2：数据层开发 ✅ 已完成
**目标**：实现A股全市场数据获取和存储

**计划工作**：
1. 集成AKShare API客户端
   - 实现全A股股票列表获取
   - 实现历史K线数据及基本面数据（市盈率、市值等）获取
   - 实现带代理轮换（如青果网络API）的防封禁机制
   - 实现数据验证和清洗
2. 设计数据库模式
   - 股票基本信息与基本面表
   - 日线数据表（TimescaleDB hypertable）
   - 回测结果表
   - 交易记录表
3. 实现数据获取服务
   - 定时数据更新任务与断点续传功能
   - 增量数据同步与全量更新
   - 数据质量监控与队列分布式锁防并发
4. 创建数据管理工具
   - 命令行数据导入工具
   - 数据修复和补全工具
   - 数据统计和报表

**预计时间**：4天

### 阶段3：回测引擎核心 ✅ 已完成
**目标**：实现事件驱动回测引擎

**计划工作**：
1. 设计回测引擎接口
   - 事件循环设计
   - 投资组合管理
   - 订单执行模拟
2. 实现基础策略框架
   - 策略基类定义
   - 信号生成机制
   - 仓位管理
3. 添加常用技术指标
   - 移动平均线（SMA, EMA）
   - RSI, MACD, Bollinger Bands
   - ATR, 波动率计算
4. 性能指标计算
   - 收益率、年化收益率
   - 夏普比率、索提诺比率
   - 最大回撤、波动率
   - 胜率、盈亏比

**预计时间**：5天

### 阶段4：后端API开发 ✅ 已完成
**目标**：提供RESTful API接口

**计划工作**：
1. 设计API规范
   - OpenAPI/Swagger文档
   - 请求/响应格式定义
2. 实现用户认证
   - JWT令牌认证
   - 用户权限管理
3. 核心API端点
   - 股票数据查询API
   - 回测配置和管理API
   - 策略列表和详情API
   - 回测结果获取API
4. 后台任务系统
   - Bull队列集成
   - 回测任务处理
   - 进度跟踪和结果缓存

**预计时间**：3天

### 阶段5：前端基础界面 ✅ 已完成
**目标**：搭建前端应用框架与基础用户中心

**计划工作**：
1. 配置React应用基础
   - 路由设置（React Router）
   - 状态管理（Redux Toolkit）
   - 主题配置（Ant Design）
2. 实现基础布局
   - 导航菜单设计
   - 页面容器组件
   - 响应式设计
3. 创建仪表板页面
   - 数据概览卡片
   - 最近回测列表
   - 快速操作入口
4. **用户中心扩展（新增）**
   - 数据库模型扩展：`User` 表增加 `avatarUrl`, `nickname`, `phone` 等字段。
   - 后端 API 开发：头像上传（基于 multer/OSS）、个人信息修改、邮箱注册与绑定接口。
   - 前端开发：增加“个人中心”页面，支持基本信息编辑与头像上传；完善导航栏用户信息展示。

### 阶段6：回测功能与智能投顾接入 🚧 进行中
**目标**：实现完整的回测工作流，并引入外部多智能体系统提供深度个股分析。

**计划工作**：
1. 回测配置页面
   - 股票选择器组件
   - 日期范围选择器
   - 策略参数配置表单
   - 资金设置面板
2. 回测执行页面
   - 任务提交界面
   - 进度显示组件
   - 实时日志查看器
3. 结果展示页面
   - 资金曲线图表
   - 业绩指标面板
   - 交易列表表格
   - 回撤分析图表
4. **智能投顾（TradingAgents）接入（新增）✅ 已完成**
   - 后端新增 `AIAdvisorService`，封装对外部多智能体系统接口的请求（同步/异步轮询）。
   - 接入 SSE 流式分析接口（`/api/analyze/stream`）。
   - 前端新增“AI深度研报”页面：用户输入股票代码，实时流式展示智能体推演过程与最终交易建议。

### 阶段7：定时调度模块与策略管理 🚧 进行中
**目标**：实现后端定时调度框架与前端可视化配置管理，以及高级策略管理功能。

**计划工作**：
1. **定时调度中心（新增）✅ 已完成**
   - 数据库新增 `ScheduledTask` 模型。
   - 引入 `node-cron` 或 Bull 队列的 `repeat` 机制，支持动态加载定时任务。
   - 开发任务 CRUD 的 REST API。
2. **前端定时配置页面（新增）✅ 已完成**
   - 新增“定时任务管理”页面，支持表格展示、新建/编辑表单（时间选择器/Cron表达式生成器）、一键启停。
3. 策略管理界面
   - 策略编辑器
   - 历史回测对比

### 阶段8：高级功能与A股辅助决策闭环 🚧 进行中
**目标**：结合 AI 与数据，打造高胜率辅助决策闭环，帮助用户获取超额收益，并完善系统高级功能。

**计划工作**：
1. 高级功能（参数优化、多策略组合、风险管理）
2. **多策略每日优选 (Daily Screener)（新增）✅ 已完成基础框架**
   - 数据库新增 `DailyScreener` 模型，支持存储多维度评分与核心理由。
   - 后端提供 RESTful API 支持按日期查询 AI 优选榜单。
   - 前端新增“AI 每日优选”大屏看板，支持查看核心看点和综合得分。
3. **风控告警 (Risk Alert)（新增）✅ 已完成基础框架**
   - 数据库新增 `RiskAlert` 模型，支持按用户和级别（HIGH, MEDIUM, LOW）存储告警信息。
   - 后端提供 RESTful API 查询及标记已读状态。
   - 前端新增“风控告警”消息流页面，高亮未读告警，支持按告警等级可视化渲染。
4. **投资组合模拟盘 (Paper Trading)（新增）✅ 已完成**
   - 数据库新增 `PaperTradingPortfolio` 与 `PaperTradingPosition` 关联模型，支持多账户独立模拟盘。
   - 后端提供 RESTful API 查询当前资产状况、浮动盈亏以及进行买入卖出交易操作。
   - 前端新增“投资组合模拟盘”大屏，实时展示总资产、可用资金、收益率与个股明细，并支持一键快速买卖模拟交易。
5. **AI 复盘日记 (Trading Journal)（新增）✅ 已完成基础框架**
   - 数据库新增 `TradingJournal` 模型，存储每日收盘后 AI 生成的大盘总结和持仓分析。
   - 后端提供 RESTful API 支持按日期查询专属复盘日记。
   - 前端新增“复盘日记”大屏，每日以优美的 UI 展示分析结论与明日操作建议。

**预计时间**：10天

### 阶段9：测试与优化 ⏳ 待开始
- 单元测试 (Jest, React Testing Library)
- 性能优化
- 用户体验优化
- 系统压力测试

### 阶段10：部署和文档 ⏳ 待开始
- 生产环境配置
- 容器化部署 (Docker Compose / Kubernetes)
- 监控日志 (Winston + ELK Stack) 与性能监控 (Prometheus + Grafana)
- 用户文档

## 当前进度

### 已完成
- [x] 项目基础结构搭建（阶段1）
- [x] 开发环境配置（阶段1）
- [x] 代码质量工具配置（阶段1）
- [x] 数据库设计（SQL脚本）（阶段1）
- [x] 数据层开发（阶段2）
  - [x] 集成AKShare API客户端及代理防封机制
  - [x] 设计数据库模型（Sequelize模型扩展基本面字段）
  - [x] 实现全市场数据获取与断点续传服务
  - [x] 创建数据管理命令行工具
  - [x] 数据清洗和验证逻辑
- [x] 回测引擎核心（阶段3）
  - [x] 设计回测引擎接口（事件循环、投资组合、订单执行）
  - [x] 实现基础策略框架（策略基类、信号生成、仓位管理）
  - [x] 添加常用技术指标（SMA、EMA、RSI、MACD、布林带）
  - [x] 实现性能指标计算（夏普比率、最大回撤、胜率等）
- [x] 前端基础框架搭建（阶段5）
  - [x] React + TypeScript + Ant Design项目结构
  - [x] 路由配置（仪表板、回测管理、策略管理、登录页面）
  - [x] Redux Toolkit状态管理配置（auth、backtest切片）
  - [x] API服务层和拦截器
  - [x] 基础页面组件（Dashboard、Backtest、Strategy、Login）
  - [x] 依赖冲突修复（TypeScript降级、ajv模块修复）
  - [x] 前端开发服务器启动成功（端口4000）


### 待开始
- [ ] 高级功能开发（阶段6-7）
- [ ] 测试和部署（阶段8-9）
- [ ] 文档和优化（阶段10）

## 快速开始 (安装与启动指南)

### 1. 环境要求
在开始之前，请确保您的计算机上已安装以下软件：
- **Node.js** (推荐 v18 或更高版本)
- **Docker** & **Docker Compose** (用于运行 PostgreSQL 和 Redis)
- **Git**

### 2. 克隆项目
```bash
git clone <your-repo-url>
cd stocks
```

### 3. 启动基础设施 (数据库与缓存)
项目依赖 PostgreSQL (TimescaleDB) 和 Redis。通过 Docker 可以一键启动：
```bash
docker-compose up -d
```
*提示：这会在后台启动数据库(端口5432)和Redis(端口6379)。首次启动可能需要拉取镜像。*

### 4. 后端配置与启动
```bash
# 进入后端目录
cd backend

# 安装依赖
npm install

# 配置环境变量 (使用默认的开发环境配置即可)
cp .env.example .env

# 启动后端开发服务器 (默认运行在 3000 端口)
npm run dev
```
*提示：后端首次启动时，Sequelize 会自动同步并在 PostgreSQL 中创建所有必需的数据表。*

### 5. 前端配置与启动
打开一个**新的终端窗口**：
```bash
# 从项目根目录进入前端目录
cd frontend

# 安装依赖 (如遇依赖冲突，可加上 --legacy-peer-deps)
npm install

# 配置环境变量
cp .env.example .env

# 启动前端开发服务器 (默认运行在 3001 端口)
PORT=3001 npm start
```

### 6. 访问系统
一切就绪后，在浏览器中访问：
👉 **http://localhost:3001**

- **默认测试账号**：目前系统支持自由注册，您可以直接在登录页点击“注册账号”创建一个新用户进行体验。

---

## 数据初始化说明
系统启动后，大盘指数和股票数据默认为空。您可以按照以下步骤初始化数据：
1. 登录系统后，点击左侧菜单的 **“系统状态 / 数据更新”**。
2. 在“数据同步中心”，首先点击 **“同步基础档案”** 获取股票列表。
3. 随后可以点击 **“触发今日更新”** 或进行指定股票的历史 K 线数据同步。
*(系统已内置代理防封机制，后台会自动通过队列进行下载和入库)*

---

## 数据库字典 (Schema)
如果您在二次开发时需要查阅或者扩充数据库字段，请查看完整的数据库初始化脚本，该脚本包含了所有的表结构和字段定义：
👉 [scripts/init-db-full.sql](./scripts/init-db-full.sql)

## 数据库备份与恢复 (US-071)

PostgreSQL 全量备份/恢复脚本位于 `scripts/`，配合 cron 实现每日全量快照与故障恢复。

### 立即备份
```bash
# 从仓库根目录:
bash scripts/backup-db.sh

# 或通过 backend 的 npm script (从 backend/ 目录):
cd backend && npm run db:backup
```

产物写入 `<repo-root>/backups/YYYY-MM-DD.sql.gz`，超过 30 天的旧备份自动清理（`RETENTION_DAYS=N` 可覆盖；设为 0 关闭清理）。

环境变量（缺失则回退默认）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DB_HOST` | `localhost` | PostgreSQL 主机 |
| `DB_PORT` | `5432` | 端口 |
| `DB_NAME` | `stock_backtest` | 库名 |
| `DB_USER` | `postgres` | 用户名 |
| `DB_PASSWORD` | `postgres` | 密码（通过 `PGPASSWORD` 传给 `pg_dump`） |
| `BACKUP_DIR` | `<repo>/backups` | 备份目录 |
| `RETENTION_DAYS` | `30` | 旧备份保留天数 |

### 恢复指定日期
```bash
# 从仓库根目录:
bash scripts/restore-db.sh --date=2026-06-06

# 或通过 npm script (注意 --, 它把后续参数透传给脚本):
cd backend && npm run db:restore -- --date=2026-06-06

# 自动化场景跳过二次确认:
bash scripts/restore-db.sh --date=2026-06-06 --yes

# 从任意路径恢复 (跳过 BACKUP_DIR 查找):
bash scripts/restore-db.sh --file=/tmp/snapshot.sql.gz --target-db=stock_backtest_test --yes

# 恢复前先 DROP + CREATE database (清空再灌, 适合恢复到全新空库):
bash scripts/restore-db.sh --date=2026-06-06 --drop-create --yes
```

restore 默认要求输入 `YES` 二次确认（覆盖目标库内容前），CI/cron 等场景请加 `--yes`。

### Cron 配置（推荐每日凌晨 03:15 备份）

编辑 crontab：
```bash
crontab -e
```

添加（**绝对路径**避免 cron 找不到 `pg_dump` 与脚本）：
```cron
# 每日 03:15 全量备份, 输出追加到日志
15 3 * * * cd /opt/stocks && /bin/bash scripts/backup-db.sh >> /var/log/stocks-backup.log 2>&1
```

若 `pg_dump` 不在 cron 的默认 `PATH`：
```cron
PATH=/usr/local/bin:/usr/bin:/bin
15 3 * * * cd /opt/stocks && /bin/bash scripts/backup-db.sh >> /var/log/stocks-backup.log 2>&1
```

如需切换备份目标或保留策略，临时在 cron 行前导入环境变量即可：
```cron
15 3 * * * cd /opt/stocks && DB_HOST=db.prod RETENTION_DAYS=60 /bin/bash scripts/backup-db.sh >> /var/log/stocks-backup.log 2>&1
```

### 故障恢复操作指南
1. 停掉 backend 服务（避免恢复中途有写入冲突）：`pm2 stop stock-backend`
2. 选择最近的有效快照：`ls -lh backups/`
3. 恢复：`bash scripts/restore-db.sh --date=<YYYY-MM-DD> --drop-create --yes`
4. 重启 backend：`pm2 restart stock-backend`，Sequelize 会按 `alter:true` 自动对齐 schema

### 注意事项
- 备份文件**未加密**，请保证 `backups/` 目录权限（建议 `chmod 700`），生产环境结合云端对象存储（OSS/S3）做异地副本
- `pg_dump` 与 `psql` 是脚本依赖，需安装 `postgresql-client`（macOS: `brew install libpq`；Ubuntu: `apt install postgresql-client`）
- 备份采用 `--no-owner --no-privileges`，跨机器恢复时不会因 role 不存在报错
- 大型库建议在备份完成后 `df -h backups/` 监控磁盘水位

## xz 沙箱开发（服务器 3021 / 3020）

若在独立沙箱环境开发，请阅读 **[docs/DEV_XZ_ONBOARDING.md](./docs/DEV_XZ_ONBOARDING.md)**（Git 分支 `dev_xz`、仅发布 xz 的 `deploy_xz.sh`、与 lym/main 隔离说明）。

## 项目结构
```
stocks/
├── backend/                 # 后端服务
│   ├── src/                # 源代码
│   │   ├── config/         # 配置文件
│   │   ├── data/           # 数据层
│   │   ├── backtest/       # 回测引擎
│   │   ├── api/            # API层
│   │   ├── models/         # 数据库模型
│   │   ├── services/       # 业务服务
│   │   ├── jobs/           # 后台任务
│   │   └── utils/          # 工具函数
│   ├── tests/              # 测试文件
│   ├── package.json        # 依赖配置
│   └── tsconfig.json       # TypeScript配置
├── frontend/               # 前端应用
│   ├── src/                # 源代码
│   │   ├── components/     # React组件
│   │   ├── pages/          # 页面组件
│   │   ├── store/          # 状态管理
│   │   ├── services/       # API服务
│   │   ├── hooks/          # 自定义Hooks
│   │   └── utils/          # 工具函数
│   ├── public/             # 静态资源
│   ├── package.json        # 依赖配置
│   └── tsconfig.json       # TypeScript配置
├── scripts/                # 工具脚本
│   ├── data_analysis/      # 数据分析与校验脚本
│   ├── deployment/         # 部署与自动化运行脚本
│   ├── setup_and_db/       # 数据库初始化与环境设置脚本
│   └── tests/              # 各种功能验证与测试脚本
├── docs/                   # 项目相关文档
├── docker-compose.yml      # 容器编排配置
├── AGENTS.md               # 核心架构与角色说明文档
└── README.md               # 项目文档
```

## 依赖项

### 后端主要依赖
- `express` - Web框架
- `sequelize` + `sequelize-typescript` - ORM
- `pg` + `timescaledb` - PostgreSQL驱动和时序扩展
- `redis` + `bull` - 缓存和任务队列
- `axios` - HTTP客户端（用于外部请求）
- `ta`/`tulind` - 技术指标计算
- `joi` - 数据验证
- `jsonwebtoken` + `bcrypt` - 认证加密
- `winston` - 日志记录

### 前端主要依赖
- `react` + `react-dom` - React核心
- `react-router-dom` - 路由管理
- `@reduxjs/toolkit` + `react-redux` - 状态管理
- `antd` + `@ant-design/icons` - UI组件库
- `recharts` + `lightweight-charts` - 图表库
- `axios` - HTTP客户端
- `date-fns` - 日期处理
- `monaco-editor` - 代码编辑器

## 下一步行动

1. **继续阶段2（数据层开发）**：
   - 维护和优化AKShare数据同步机制
   - 完成数据库模型定义
   - 创建数据获取服务

2. **环境准备**：
   - 安装Node.js（如未安装）
   - 启动Docker容器：`docker-compose up -d`
   - 安装依赖：`npm install`（前后端分别执行）

3. **验证当前设置**：
   - 检查后端服务器能否启动：`cd backend && npm run dev`
   - 检查前端应用能否启动：`cd frontend && npm start`
   - 验证数据库连接

## 注意事项

1. **Node.js安装**：当前环境未检测到Node.js，需要先安装Node.js 18+
2. **数据源**：AKShare API需要网络连接，如果遇到封禁可能需要配置青果网络代理白名单
3. **数据库**：首次启动需要运行数据库初始化脚本
4. **开发顺序**：建议按阶段顺序开发，确保基础功能完整
5. **测试**：每个阶段完成后应进行基本功能测试

## 贡献指南

1. 遵循代码规范（ESLint + Prettier）
2. 新功能需包含单元测试
3. 提交前运行完整测试套件
4. 更新相关文档

## 当前状态和下一步

### 已完成工作
1. **阶段1-4（后端核心）**：代码结构完整，但存在TypeScript编译错误
   - 数据层：AKShare代理请求、模型扩展基本面字段、防封禁与断点续传同步服务
   - 回测引擎：事件驱动架构、策略框架、技术指标
   - API层：用户认证、股票数据、回测管理、策略管理接口
   - 任务队列：Bull + Redis集成

2. **阶段5（前端基础界面）**：基础框架已搭建
   - React + TypeScript + Ant Design项目结构
   - 路由配置（仪表板、回测管理、策略管理、登录页面）
   - Redux Toolkit状态管理配置（auth、backtest切片）
   - API服务层（axios配置、认证拦截器）
   - 基础页面组件（Dashboard、Backtest、Strategy、Login）

### 遇到的问题和解决方案
1. **后端TypeScript编译错误** - ✅ **已完全修复**
   - 模型装饰器属性重复声明 - ✅ 为所有Sequelize模型属性添加了`declare`修饰符
   - 策略构造函数参数类型错误 - ✅ 已修正，通过类型检查
   - 技术指标类型错误 - ✅ 已修正，通过类型检查
   - 服务器现已完全基于强类型编译通过启动：`npm run dev` 成功，健康端点正常工作

2. **前端依赖冲突** - ✅ **已修复**
   - react-scripts@5.0.1与TypeScript 5.x兼容性问题
   - ajv模块缺失：`Cannot find module 'ajv/dist/compile/codegen'`
   - 解决方案：降级TypeScript到4.9.5版本，使用`npm install --legacy-peer-deps`
   - 前端依赖安装成功，正在启动开发服务器

3. **Docker环境缺失** - ❌ **仍需安装**
   - 当前环境未安装Docker，无法启动PostgreSQL和Redis
   - API端点需要数据库连接才能正常工作

### 已完成工作
✅ **后端核心修复完成**
- 批量添加`declare`修饰符到所有Sequelize模型属性
- 修复`AuthController`中的`Op`导入错误
- 安装缺失依赖：`reflect-metadata`、`ajv@8.12.0`
- 修复后端依赖问题：移除`@types/commander`，降级commander到11.0.0
- 后端服务器已成功启动：`npm run dev` ✅
- 健康端点测试通过：`curl http://localhost:3000/health` ✅

✅ **系统架构与模块设计文档化完成**
- 基于角色/模块抽象机制，生成了 `Agents.md` 文档。
- 梳理了系统的数据流（分析师 -> 研究员 -> 交易员 -> 基金经理）。
- 明确了基于 `Event.ts` 的异步事件驱动架构（BAR, SIGNAL, ORDER, FILL）。

✅ **前端基础框架搭建完成**
- 完整的页面组件：仪表板、回测管理、策略管理、登录
- Redux Toolkit状态管理配置
- API服务层和拦截器
- Ant Design UI组件集成
- 修复前端依赖冲突：降级TypeScript到4.9.5，使用`--legacy-peer-deps`安装成功
- 解决ajv模块缺失：安装ajv@8.12.0和ajv-keywords@5.1.0
- 前端开发服务器成功启动：`npm start` (端口4000) ✅

### 剩余问题
✅ **后端编译错误（已修复）**
- `BacktestController.ts`: 策略构造函数参数类型已修复
- `TechnicalIndicators.ts`: 技术指标类型定义已修复
- `BacktestEngine.ts`: 事件类型系统已优化
- 所有TypeScript类型检查现已通过 (`tsc --noEmit` 零报错)

✅ **前端启动问题** - **已解决**
- 依赖冲突已解决：TypeScript降级到4.9.5，依赖安装成功
- ajv模块缺失：安装ajv@8.12.0和ajv-keywords@5.1.0解决路径问题
- ESLint配置：安装eslint-plugin-prettier和eslint-config-prettier
- 图标修复：将不存在的`StrategyOutlined`替换为`StockOutlined`
- 端口冲突：后端占用3000端口，前端已配置为4000端口
- 前端开发服务器已成功启动：`npm start`（端口4000）✅

❌ **数据库环境缺失**
- Docker未安装，无法启动PostgreSQL和Redis
- API端点需要数据库连接

### 下一步建议
1. **验证前后端运行状态** ✅ **已完成**
   - 前端开发服务器启动验证（端口4000）✅
   - 后端API功能测试（健康端点已通过）✅
   - TypeScript 编译验证 (`tsc --noEmit` 成功通过) ✅

2. **安装Docker环境** ⚠️ **仍需安装**
   - 安装Docker Desktop for Windows
   - 启动数据库容器：`docker-compose up -d`
   - 运行数据库迁移脚本

3. **功能验证测试** ⏳ **待开始**
   - 测试API端点：用户认证、股票数据、回测管理（需要数据库）
   - 连接前后端，实现基础回测工作流
   - 验证状态管理和数据流

4. **系统架构文档化** ✅ **已完成**
   - 编写了 `Agents.md` 文件，使用角色化（Agent/Actor）比喻将回测系统核心模块进行解耦和讲解
   - 明确了数据流和事件驱动架构的流转方向

### 短期目标
- ✅ 修复编译错误，使前后端能够启动（后端已启动，前端正在启动）
- 实现基本的回测创建和列表功能（需要数据库）
- 连接前后端，实现真实数据展示（需要数据库）

### 长期目标
- 完善回测配置界面
- 实现实时回测进度监控
- 添加高级分析图表
- 部署到生产环境

## 许可证
MIT License