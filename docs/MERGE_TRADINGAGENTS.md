# TradingAgents 迁移合并说明

> 迁移日朗: 2026-07-04 · 分支: `feat/merge-tradingagents`

将独立的 [TradingAgents](https://github.com/TauricResearch/TradingAgents) 多智能体分析框架
以**单仓多服务 (monorepo multi-service)** 形态并入 stocks 项目,并把数据源在配置层收敛为
**以 stocks Node 后端为 A 股唯一真源**。

## 1. 为什么是"多服务并存"而不是重写

- stocks 后端是 Node.js / TypeScript(`backend/`),TradingAgents 是纯 Python
  (LangChain / LangGraph + FastAPI)。两者语言异构,无法也不应互相重写。
- 二者此前已"半耦合":TradingAgents 通过 `InternalStockAPI` 调用 stocks 的
  `/api/internal/*`,并共用同一个 Postgres 库 `stock_backtest`。
- 因此正确的合并形态是:把 Python 服务物理搬进 `stocks/ai/tradingagents-app/`,
  与 TS 后端在同一仓库中共存,共享一套 `.env` 与数据库。

## 2. 目录落位

```
stocks/
├── backend/                 # Node/TS 主后端 (A 股行情/基本面真源)
├── frontend/                # React SPA
└── ai/
    └── tradingagents-app/   # 【新增】vendored 的 TradingAgents Python 服务
        ├── api.py           # FastAPI 入口
        ├── main.py          # CLI 入口
        ├── tradingagents/   # 核心包 (agents/dataflows/db/graph/...)
        ├── requirements.txt
        ├── .env.example     # 【新增】合并后共享环境变量样例
        └── config.json      # (gitignored) ARK key 已清空
```

vendoring 时排除了独立 `.git`、生成产物 (results / data_cache / local_db 缓存)、
`__pycache__` 与虚拟环境。

## 3. 数据源合并(配置层收敛)

"合并数据源" = 让 A 股行情/指标/基本面/新闻默认走 stocks 后端,akshare 作兜底。

- `tradingagents/default_config.py` 的 `data_vendors` 四类默认值由 `yfinance` 改为
  `akshare`:
  - `core_stock_apis` / `technical_indicators` / `fundamental_data` / `news_data` → `akshare`
- 关键点:`akshare_stock.py` 的底层读取路径本身已**首选** `InternalStockAPI`
  (`get_stock_data → _get_akshare_kline → get_local_db_data → fetch_and_merge_stock_data`,
  其中 `InternalStockAPI.get_historical_data` 排第一,akshare 仅在无数据时兜底)。
  故 vendor 设为 `akshare` 即等价于"**走 stocks 后端优先,直连数据源兜底**"。
- `route_to_vendor()` 支持逗号分隔的 fallback 链,保留了后续显式扩展的空间。

## 4. 去硬编码密钥(提交前清理)

被 git 跟踪的两个配置文件,原先内联了真实密钥,已改为纯 env 注入、无默认值:

| 文件 | 原状态 | 现状态 |
|---|---|---|
| `tradingagents/dataflows/internal_api_config.py` | 硬编码 `INTERNAL_API_KEY` | `os.getenv("INTERNAL_API_KEY", "")`,base URL 默认 `http://127.0.0.1:3000` |
| `tradingagents/db/config.py` | 硬编码 Postgres 密码 | `os.getenv("POSTGRES_PASSWORD", "")` |

未被跟踪(gitignored)的密钥载体:

- `config.json` — `ARK_API_KEY` 已清空为 `""`(结构保留)。
- `.env` — 不入库;运行时从此文件注入真实值。

## 5. 共享环境变量 `.env.example`

新增 `ai/tradingagents-app/.env.example`,声明合并后两端共用的变量(均无真实值):

- **内部数据 API**:`INTERNAL_API_BASE_URL`、`INTERNAL_API_KEY`
  (与 stocks `backend/.env` 的 `INTERNAL_API_KEY` 同值)
- **共享 Postgres**:`POSTGRES_*`(同库 `stock_backtest`)
- **共享 Redis**:`REDIS_*`
- **LLM**:`ARK_API_KEY`(火山方舟)/ `OPENAI_API_KEY` / `GOOGLE_API_KEY` / `ANTHROPIC_API_KEY`

部署时复制为 `.env` 并填入真实值即可。

## 6. 验证记录

- Python:`compileall tradingagents` 通过;`from tradingagents.default_config import DEFAULT_CONFIG`
  成功,`data_vendors.core_stock_apis == "akshare"`。
- TypeScript:`backend/` 下 `tsc --noEmit` 退出码 0,vendoring 未破坏 Node 构建。
- 安全:提交集不含 `__pycache__` / `.pyc`,无残留密钥,`.env.example` 占位为空。

## 7. 尚未做的事(部署前需人工确认)

- 未部署上线。生产环境需在服务器上按 `.env.example` 配置真实 `.env`。
- Python 依赖 (`requirements.txt`) 的生产安装与进程编排(与 Node 后端如何共存启动)
  留待部署阶段落地。
