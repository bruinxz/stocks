# TradingAgents 迁移合并方案 (Monorepo Vendoring)

> 迁移日期: 2026-07-04 · 分支: `feat/merge-tradingagents`
> 目标: 将 `TauricResearch/TradingAgents` (下称 **TA**) 直接并入 `bruinxz/stocks` 单仓, 数据源统一收敛为以 stocks 后端为 A 股唯一真源。

## 1. 背景与动机

两个项目此前已"半集成":

- **stocks** — Node.js/TypeScript 后端 (端口 3000) + React 前端, 负责 A 股行情/因子/基本面的采集、入库 (Postgres `stock_backtest`)、对外 REST。
- **TA** — 纯 Python 的 LangChain/LangGraph 多智能体研究框架 + FastAPI 服务, 负责多角色分析与交易决策。

关键点: TA 的 `InternalStockAPI` (`tradingagents/dataflows/internal_api.py`) **早已**通过 `http://127.0.0.1:3000/api/internal/*` 调用 stocks 后端取数, 且 TA 的 `db/config.py` 连接的就是 **同一个** Postgres 库 `stock_backtest`。因此本次"迁移合并"本质是:**物理并仓 + 配置收敛 + 去除重复/硬编码密钥**, 而非跨语言重写。

## 2. 架构决策

TA 是 Python、stocks 是 TS/Node, 无法归一为单一语言进程。采用 **vendoring(子服务)** 模式:

```
stocks/
├── backend/            # 既有 Node/TS 后端 (数据真源, /api/internal/*)
├── frontend/           # 既有 React 前端
└── ai/
    └── tradingagents-app/   # ← TA 整体并入, 作为独立 Python 服务
        ├── api.py / main.py / cli/
        ├── tradingagents/       # 核心多智能体 + dataflows + db
        ├── requirements.txt / pyproject.toml
        ├── Dockerfile / docker-compose*.yml
        └── .env.example         # 共享环境变量样例(本次新增)
```

搬迁用 `rsync` 完成, 排除 `.git/`、虚拟环境、缓存、`results/`、`local_db/`、`.env` 等运行时/密钥产物。

## 3. 数据源合并(核心)

统一原则:**A 股行情/指标/基本面 以 stocks Node 后端为唯一真源, akshare 仅作兜底。**

### 3.1 取数链路(既有, 无需改代码)

`get_stock_data → _get_akshare_kline → get_local_db_data → fetch_and_merge_stock_data`
该链路底层**首选** `InternalStockAPI.get_historical_data`, akshare 只在后端无数据时兜底。
`get_realtime_quotes` / `get_intraday_data` 本就硬连 `internal_api`。

### 3.2 配置收敛(本次改动)

`tradingagents/default_config.py` 的 `data_vendors` 由全 `yfinance` 改为全 `akshare`:

```python
"data_vendors": {
    "core_stock_apis":      "akshare",   # 底层 local_db 首选 internal_api, akshare 兜底
    "technical_indicators": "akshare",   # 同上, 基于 internal_api 行情算指标
    "fundamental_data":     "akshare",   # A 股基本面(内部 pe/pb 已入库)
    "news_data":            "akshare",   # A 股新闻
},
```

`route_to_vendor` 支持逗号分隔的 fallback 链, 因此 `akshare` 项等价于"走后端优先、直连兜底"。

## 4. 密钥与环境收敛

去掉 TA 侧所有硬编码密钥, 统一从共享 `.env` 注入:

| 文件 | 改动 |
|---|---|
| `tradingagents/dataflows/internal_api_config.py` | 删除硬编码 `INTERNAL_API_KEY`, 改 `os.getenv(..., "")` |
| `tradingagents/db/config.py` | 删除硬编码库密码, `POSTGRES_PASSWORD` 默认空、`POSTGRES_DB` 默认 `stock_backtest`; 打印时对密码做掩码 |
| 旧 `config.json` | 运行时读取逻辑已删除；密钥仅由 systemd EnvironmentFile 注入 |
| `docker-compose.db.yml` | `POSTGRES_PASSWORD` 改为 `${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}` |
| `.env.example` (新增) | 汇总 INTERNAL_API_*, POSTGRES_*, REDIS_*, LLM keys 的样例(无真实值) |

单一真源: AI 服务的 `INTERNAL_API_KEY`、Redis 参数与 stocks `backend.env` 保持同值；
LLM 密钥和模型只从 `/opt/stocks/shared/tradingagents.env` 读取。配置优先级为
`环境变量 > 无密钥默认值`。

## 5. 部署方案

- AI 服务与 stocks 同机, 通过 `127.0.0.1:3000` 访问后端 `/api/internal/*`, 共用 Postgres `stock_backtest` 与 Redis。
- 生产密钥写入 `/opt/stocks/shared/tradingagents.env`，权限限制为服务用户可读。
- 沿用 stocks 现有发布约定(releases 时间戳目录 + `current` 符号链接 + nginx reload)；
  AI 子服务由 `stocks-tradingagents.service` 管理并固定监听 `127.0.0.1:8000`。

## 6. 验证清单

- [ ] Python 侧关键模块可导入(`tradingagents.default_config`、`dataflows.internal_api_config`、`db.config`)。
- [ ] 全树无硬编码密钥(rescan 通过)。
- [ ] TS 后端仍可编译(`tsc` 绿)、前端构建通过。
- [ ] AI 服务能连通后端 `/api/internal/*` 与 Postgres。

## 7. 回滚

改动集中在 `feat/merge-tradingagents` 分支且 `ai/` 为全新目录, 未触碰既有 `backend/`、`frontend/`。回滚只需不合并该分支或 `git revert` 对应提交。
