# 牛牛研究台：A 股事件驱动研究与回测系统

[![CI](https://github.com/bruinxz/stocks/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/bruinxz/stocks/actions/workflows/ci.yml)
[![Security Lint](https://github.com/bruinxz/stocks/actions/workflows/security-lint.yml/badge.svg?branch=main)](https://github.com/bruinxz/stocks/actions/workflows/security-lint.yml)

当前产品以 **A 股研究为主线**：行情、早报、推荐、回测证据、每日日报与报告历史都围绕 A 股展开；美股、日本和韩国市场只提供板块级趋势与催化映射，不抢占 A 股主报告篇幅。

默认入口是 `/catdesk`。页面采用暖纸风与牛牛主题，打开后自动建立管理员浏览会话，不要求用户先经过登录页。

## 当前页面

| 页面 | 作用 | 主要数据水位 |
|---|---|---|
| A 股市场 | 股票、指数、ETF 行情与 K 线 | `daily_bars`、`realtime_quotes` |
| A 股早报 | 催化、确信度、风险门禁 | A 股推荐快照、公告、涨停与因子 |
| 美股优选 | 海外科技与风险偏好催化 | 美股推荐快照 |
| 日韩市场 | 日本、韩国指数与板块趋势 | `jpkr_daily_kline`、FX 快照 |
| 高倍潜力 | 长周期候选研究 | multibagger PIT 快照 |
| 回测证据 | 收益、回撤、持仓与 PIT 证据 | backtest PIT 快照 |
| 每日日报 | A 股详细主报告 + 海外三块大势 | A 股推荐快照与海外摘要 |
| 报告历史 | A 股优先的快照档案与差异对比 | 推荐快照历史 |

每个页面顶部都会显示该页真实依赖数据的最新日期、写入时间与延迟状态，接口为 `GET /api/data/page-freshness`。

## 架构

- 前端：React + TypeScript + Ant Design + ECharts/Recharts
- 后端：Node.js + TypeScript + Express + Sequelize
- 数据：PostgreSQL/TimescaleDB + Redis/Bull
- A 股源：AKShare、腾讯行情及经过封装的公开数据源
- 海外源：JPX、BOJ、Naver、Nasdaq 等公开来源
- 回测：事件队列驱动的 BAR → SIGNAL → ORDER → FILL → PORTFOLIO 流程
- 报告：版本化推荐快照、证据引用、指纹与 PIT 数据

## 本地启动

要求 Node.js 18+、Python 3.9+、PostgreSQL 14+、Redis。

```bash
docker compose up -d

cd backend
npm ci
cp .env.example .env
npm run check-env
npm run dev
```

另开终端：

```bash
cd frontend
npm ci --legacy-peer-deps
PORT=3001 npm start
```

访问 <http://localhost:3001/catdesk>。本地前端应在 `frontend/.env.development.local` 配置：

```dotenv
REACT_APP_API_BASE_URL=http://localhost:3000/api
```

真实密码、令牌、数据库连接和服务器地址只允许放在被 Git 忽略的环境文件或服务器 `shared/backend.env`，禁止提交到仓库。

## 数据同步基线

生产环境的目标节奏：

| 时段 | 任务 |
|---|---|
| A 股连续竞价 | 每 5 分钟刷新一次全市场实时行情；集合竞价与午休由处理器跳过 |
| 工作日 09:00 | 更新 A 股日报快照、日/韩市场水位及美股、日本催化摘要 |
| 工作日盘后 | 日 K、因子、公告、涨停、行业资金流、报告与归因增量同步 |
| 每日 18:30 | 全链路数据陈旧度检查 |
| 每日 23:00 | 数据质量深度扫描 |

只读审计命令：

```bash
cd backend
npm run data:status

cd ..
EXPECTED_DATA_DATE=2026-07-16 node scripts/tests/quant_data_freshness_check.js
```

详细口径与运维处理见 [数据水位与定时同步](docs/DATA_FRESHNESS_AND_SCHEDULING.md)。

## 常用质量门

```bash
cd backend
npm run build
npm run lint
npm test
npm run docs:openapi:check

cd ../frontend
CI=true npm test -- --runInBand --watch=false
npm run build
```

安全检查：

```bash
gitleaks git --redact --log-opts='origin/main..HEAD' .
bash scripts/ci/check_weak_secrets.sh
```

## 生产发布

生产只保留 `main` 环境，目录为 `/opt/stocks`，后端由 `stocks-backend.service` 管理。发布必须走不可变 release + `current` 软链切换，并在健康检查通过后才算完成：

```bash
bash scripts/ops/deploy_main_release.sh
```

不要手工覆盖 `current` 内文件，也不要在生产服务器提交 `.env`、密钥或数据库导出。

## 文档入口

- [用户手册](docs/USER_GUIDE.md)
- [前端架构与页面信息架构](docs/FRONTEND_ARCHITECTURE.md)
- [数据水位与定时同步](docs/DATA_FRESHNESS_AND_SCHEDULING.md)
- [部署环境](docs/DEPLOY_ENVIRONMENTS.md)
- [测试指南](docs/TESTING.md)
- [灾备与恢复](docs/operations/disaster-recovery.md)
- [简易版视觉规范](docs/EASY_QUANT_UI_DESIGN_GUIDELINES.md)
- [OpenAPI](docs/openapi.json)

## 命名与安全约束

- 数据库字段、Sequelize 属性及接口持久化字段统一使用 `snake_case`。
- 所有外部数据调用封装在数据源/服务层，不允许策略直接耦合供应商 API。
- A 股报告可以详细到板块与个股；海外报告只输出可映射到 A 股的整体趋势。
- 页面不得只显示“今天”，必须显示后端返回的实际数据时间。
