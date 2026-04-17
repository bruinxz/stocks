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
- **API客户端 (`AKShareClient.ts` / `BaostockClient`)**: 扮演数据采集员的角色，负责从不同数据源获取股票历史和实时行情。
- **数据同步服务 (`DataSyncService.ts`)**: 扮演数据工程师的角色，负责增量同步、清洗以及处理数据入库持久化。
- **指标计算器 (`TechnicalIndicators.ts`)**: 提供 SMA、EMA、MACD、RSI 等专业技术指标计算服务，为策略生成提供量化的特征数据。

### 3.2 策略生成器/“研究员”团队 (Researchers) - `backtest/strategies/`
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
  - 采用 **PostgreSQL + TimescaleDB** (需Docker环境支持) 处理海量时序K线数据。
  - 使用 **Redis + Bull** 队列处理耗时较长的异步回测任务，保证主线程的响应速度。
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
- 后端强制使用 TypeScript，新增的数据结构或事件模型必须在相应的 `.ts` 文件中定义完整的 Interface。
