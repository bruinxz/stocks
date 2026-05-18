# 股票回测系统: 核心模块与角色架构

## 1. 项目简介 (Project Overview)
本项目是一个受专业量化交易流程启发的**A股股票事件驱动回测与收益模拟系统**。不同于传统的过程式回测代码，本系统通过将回测流程中的各个核心功能解耦，分配为不同的“专业角色”（如数据分析师、策略研究员、交易执行员、风控与基金经理），以模块化的协作方式完成复杂的交易模拟。这些核心模块通过事件流（Event Stream）进行结构化的通信，从而高保真地模拟真实市场环境下的交易行为，并提供直观的网页端操作体验。

## 2. 核心架构与工作流 (Core Architecture & Workflow)
项目核心基于**事件驱动架构 (Event-Driven Architecture)** 构建（主要逻辑见 `backend/src/backtest/engine/BacktestEngine.ts`），通过事件队列（Event Queue）管理信息流。完整的交易决策与执行工作流如下：

1. **数据拉取 (Information Gathering)**：数据服务模块调用外部API获取市场历史K线数据，并在回测启动后依次生成市场事件 (Bar Event)。
2. **策略分析 (Strategy Analysis)**：策略模块监听市场事件，基于预设逻辑和技术指标对收集的数据进行计算与研判。
3. **初步决策 (Signal Generation)**：策略模块根据分析结果，输出具体的交易信号 (Signal Event)，明确表达投资立场（买入 BUY / 卖出 SELL）。
4. **风控评估与交易执行 (Risk & Execution)**：订单管理器 (Order Manager) 结合滑点和手续费模型，对交易信号进行成本评估，并生成订单事件 (Order Event) 与最终的成交事件 (Fill Event)。
5. **资金清算 (Portfolio Management)**：投资组合管理器 (Portfolio) 接收成交结果，更新持仓市值、计算盈亏并实时更新资金曲线。

---

## 3. 系统角色(模块)详解 (Core Roles & Modules in Detail)

代码库中的核心模块按职能划分在 `backend/src/backtest/` 和 `backend/src/data/` 目录下，模块高度独立且可复用。

### 3.1 数据服务/“分析师”团队 (Data Analysts) - `data/`
负责调用工具获取并清洗数据，不直接参与交易决策：
- **API客户端 (`AKShareClient.ts`等)**: 扮演数据采集员的角色，负责从不同数据源获取股票历史和实时行情。
- **数据同步服务 (`DataSyncService.ts`)**: 扮演数据工程师的角色，负责增量同步、清洗以及处理数据入库持久化。
- **指标计算器 (`TechnicalIndicators.ts`)**: 提供 SMA、EMA、MACD、RSI 等专业技术指标计算服务，为策略生成提供量化的特征数据。

### 3.2 智能投顾与外部多智能体系统 (AI Advisors)
本系统计划深度集成外部的 **TradingAgents** 多智能体分析系统，用于提供深度的个股基本面、情绪面、技术面和新闻面分析，以及买卖建议。
- **TradingAgents 项目地址**: `/Users/bytedance/go/src/github.com/TauricResearch/TradingAgents/api.py` (运行于 `http://47.93.224.109:8000`)
- **核心接口**: `/api/analyze` (同步/异步分析), `/api/analyze/stream` (SSE流式分析)
- **职责**: 在每日收盘后，由定时任务调度，为用户的自选股池或全市场筛选出的候选股生成《多智能体投资决策报告》，为“研究员”和“交易员”提供高维度的决策依据。

### 3.3 策略生成器/“研究员”团队 (Researchers) - `backtest/strategies/`
负责对分析师的数据和指标进行逻辑评估：
- **基础策略基类 (`Strategy.ts`)**: 定义了所有策略模块的通用接口和状态更新机制。
- **具体策略 (`MovingAverageCrossoverStrategy.ts`)**: 例如双均线交叉策略，根据短期和长期均线的交叉情况，生成具体的买卖交易信号。

### 3.3 交易执行器/“交易员” (Trader) - `backtest/engine/OrderManager.ts`
- **核心职责**: 综合策略发出的信号，制定实际的交易委托。
- **成本与滑点模型**: 内部包含了 `FixedSlippageModel` (固定滑点模型) 和 `FixedCommissionModel` (固定手续费模型)，确保回测结果贴近真实交易环境，有效过滤虚假的套利机会。

### 3.4 投资组合/“基金经理” (Portfolio Manager) - `backtest/engine/Portfolio.ts`
- **核心职责**: 最终的资金和仓位管理者。记录每笔交易 (Trades) 和当前持仓 (Positions)，执行可用资金校验和每日盈亏重置。
- **绩效评估 (`PerformanceMetrics.ts`)**: 负责在回测结束时输出专业维度的绩效指标（如夏普比率、索提诺比率、最大回撤、胜率、盈亏比等）。

---

## 4. 关键技术组件 (Key Technical Components)

- **事件驱动引擎 (`BacktestEngine.ts`)**: 
  - 支持 `BAR` (K线), `SIGNAL` (信号), `ORDER` (订单), `FILL` (成交), `TIMER` (定时) 等标准事件生命周期管理。
- **数据层与持久化 (`backend/src/models/`)**:
  - 采用 **PostgreSQL** 处理海量时序K线数据、股票档案和回测记录。
  - 使用 **Redis + Bull** 队列处理耗时较长的数据同步和异步回测任务，保证主线程的响应速度。
- **安全与鉴权机制 (`backend/src/middlewares/auth.ts`)**:
  - 采用 **双令牌 (Access + Refresh Token)** 机制，结合 HttpOnly Cookie 防止 XSS 窃取。
  - 前端 Axios 拦截器实现无感刷新，CORS 动态匹配实现跨设备访问支持。
- **前后端交互 (RESTful API & React)**:
  - 后端通过 Express 框架提供 `/api/backtest`、`/api/market` 等接口。
  - 前端使用 React + Redux Toolkit + Ant Design + Recharts，支持策略的可视化配置及收益曲线的实时渲染。

---

## 5. 开发规范与扩展指南 (Development Guidelines)

为了保证代码库的结构兼容性和可维护性，新成员在进行二次开发时请遵循以下规范：

### 5.1 状态管理与事件流 (State & Event Management)
- 整个回测流程严格依赖 `Event.ts` 中定义的事件类型进行数据单向流转。
- 增加新模块时，需确保其通过 `BacktestEngine.on()` 监听正确的事件，并通过 `emit()` 分发结果，**避免直接的强耦合函数调用**。

### 5.2 如何添加新的策略 (Adding a New Strategy)
1. **继承基类**: 在 `strategies/` 目录下创建新文件，必须继承自 `Strategy` 抽象类。
2. **实现事件钩子**: 重写 `onBar(event: BarEvent)` 方法，处理每期数据更新和内部指标计算。
3. **生成信号**: 实现 `generateSignals()` 方法，返回 `Signal` 对象数组（必须包含 symbol, direction, price 等核心要素）。
4. **注册策略**: 修改 `api/controllers/BacktestController.ts` 中的 `createBacktest` 路由逻辑，将新策略类型加入到策略实例化的工厂选择流中。

### 5.3 模块独立性与类型安全
- 所有的外部API调用必须封装在 `data/sources/` 中，策略模块仅通过 `DataService` 暴露的纯函数获取数据。

### 5.4 命名规范：全局强制使用下划线命名法 (Snake Case)
- **数据库字段**：所有数据表的列名必须使用 `snake_case`（如 `user_id`, `created_at`）。
- **Sequelize 模型**：所有 Model 的类属性声明也必须强制使用 `snake_case`，以保持与数据库字段的完全一致（如 `declare user_id: number;`）。
- **代码交互**：在所有前后端接口交互、控制器逻辑、服务层代码中，凡是涉及到上述数据库字段的数据传递和处理，都必须统一使用 `snake_case`，严禁使用 `camelCase`（驼峰命名法）。
---

## 6. 开发环境备忘录 (Agent Context)

### 6.1 项目基础架构状态
*   **技术栈**: 
    *   前端: React (基于 `react-scripts` / Webpack)
    *   后端: Node.js, Express, TypeScript, Sequelize (ORM)
    *   数据库: PostgreSQL 14 (`stock_backtest` 数据库)
    *   缓存: Redis (默认监听本地 6379)
    *   量化依赖: Python 3 + `akshare`
*   **本地开发运行端口**:
    *   前端: `3001` (使用 `PORT=3001 npm start` 启动)
    *   后端: `3000` (使用 `npm run dev` 启动)

### 6.2 关键路径与环境配置
*   **前端环境变量**: [frontend/.env.development.local](frontend/.env.development.local) 必须配置 `REACT_APP_API_BASE_URL=http://localhost:3000/api`，否则会请求到远端的 `103.242.3.87:3000`。
*   **后端环境变量**: [backend/.env](backend/.env) 包含 PG 数据库连接信息 (`postgres:postgres`)、Redis 端口 (`6379`)，以及 JWT_SECRET。

### 6.3 核心机制排查与修复记录
#### 数据库同步与初始化 ( Sequelize )
*   开发模式下 (`NODE_ENV=development`)，后端启动时 ([backend/src/index.ts](backend/src/index.ts)) 会通过 `sequelize.sync({ alter: true })` 自动同步表结构。
*   **初始管理员账号注入**: 在 `index.ts` 启动时，如果 `users` 表为空，会自动插入两个初始管理员账号：
    *   `xz` (密码 `666`)
    *   `lym` (密码 `666`)
    *   **避坑注意**: `User.ts` 模型中有 `@BeforeCreate` 钩子会自动对密码进行 bcrypt hash，所以在 `index.ts` 中直接插入明文 `666` 即可，绝对不能在插入前手动进行 `bcrypt.hash`，否则会导致双重哈希引起登录时始终报 `401 Unauthorized` 密码错误。

#### TypeScript / Sequelize 模型定义 ( Models )
*   **避坑注意**: Sequelize 模型中使用 `!:` 声明公共类字段（如 `declare role: string;` 或 `role!: string;`）时，**必须加上 `declare` 关键字**，例如 `declare direction: TradeDirection;`，否则这些类字段会屏蔽（shadow）Sequelize 底层的 `getters & setters`，导致插入数据库时该字段为 `null`。
    *   *历史操作记录*: 已经使用 `perl -pi -e 's/([a-zA-Z0-9_]+)!: ([a-zA-Z0-9_\[\]]+);/declare $1: $2;/g'` 批量修复了 `src/models/` 目录下所有遗漏 `declare` 的 `!:` 声明。

#### 身份认证 ( Authentication )
*   认证中间件位于 [backend/src/middlewares/auth.ts](backend/src/middlewares/auth.ts)，最终调用 `AuthController.authenticate` ([backend/src/api/controllers/AuthController.ts](backend/src/api/controllers/AuthController.ts))。
*   所有的受保护路由（如 `/api/market/favorites`、`/api/backtests` 等）必须显式在路由层引入并调用 `authController.authenticate`。
*   移除了开发环境中的“无感后门”，当前环境必须携带合法的 `Bearer Token` 才能访问。

### 6.4 下一步开发/排查建议
*   如果遇到数据库相关报错（如表不存在、字段不存在），可以尝试在后端执行 `DROP DATABASE stock_backtest; CREATE DATABASE stock_backtest;` 后重启后端触发 `alter: true` 同步。
*   如果启动端口冲突，使用 `lsof -i :3000` / `lsof -i :3001` 找出 PID 并 `kill -9`。

### 6.5 脚本与辅助文档目录 (Scripts & Docs)
为保持根目录整洁，所有运维与测试脚本及非核心文档均已归档：
*   **`scripts/`**: 包含所有辅助脚本
    *   `data_analysis/`: 数据分析与一致性校验脚本 (如同步主板、检查股票数据完整性等)
    *   `deployment/`: 自动化部署与服务器运维脚本 (如 `run_remote.sh`, `deploy.js` 等)
    *   `setup_and_db/`: 数据库初始化与环境配置脚本 (包含完整建表SQL `init-db-full.sql` 和注入初始用户脚本等)
    *   `tests/`: 各类功能模块的测试与验证脚本
*   **`docs/`**: 包含所有相关的项目说明与文档 (如端口配置、重构记录等)
