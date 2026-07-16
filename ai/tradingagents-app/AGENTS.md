# TradingAgents: Multi-Agents LLM Financial Trading Framework

## 1. 项目简介 (Project Overview)
TradingAgents 是一个受专业量化交易公司启发的**多智能体大语言模型（LLM）金融交易框架**。该项目通过分配不同的专业角色（如基本面分析师、情绪分析师、技术分析师、研究员、交易员和风控经理）将复杂的交易目标分解为可管理的任务。各个智能体通过结构化的通信和辩论进行协作，从而优化交易策略并提升投资回报表现。

## 2. 核心架构与工作流 (Core Architecture & Workflow)
项目核心基于 **LangGraph** 构建（主要逻辑见 `tradingagents/graph/trading_graph.py`），通过状态机（State Graph）管理信息流。完整的交易决策流如下：

1. **信息收集 (Information Gathering)**：四位分析师并发调用外部 API 获取市场数据。
2. **投资辩论 (Investment Debate)**：牛方（Bull）和熊方（Bear）研究员基于收集的数据进行多轮辩论。
3. **初步决策 (Initial Decision)**：交易员（Trader）结合数据和辩论结果，输出初步的投资计划。
4. **风控评估 (Risk Evaluation)**：激进、保守和中立的风控人员对初步计划进行风险辩论。
5. **最终决策 (Final Execution)**：基金经理（Portfolio Manager）审核风控意见，下达最终的交易指令（BUY/HOLD/SELL），并将结果写入记忆库。

---

## 2.1 近期架构优化 (Recent Architecture Upgrades)
- **并行数据拉取 (Parallel Execution)**：重构了 LangGraph 工作流，将四位分析师（Market, Social, News, Fundamentals）的数据拉取与报告生成从串行改为**并发执行 (ThreadPoolExecutor)**，显著缩短了前期信息收集阶段的耗时。
- **本地高维数据库缓存 (Local DB Caching)**：接入了自定义的 `local_db_handler`。在分析师调用 `akshare` 或 `yfinance` 之前，系统会优先查询 `local_db/historical_data` 目录下的 CSV 缓存。若数据缺失，则自动调用接口补充，大幅降低了网络 I/O 延迟并丰富了 LLM 分析的数据维度（如主力资金流向、市盈率等）。
- **SSE 流式输出 (Server-Sent Events)**：在 API 层新增了 `/api/analyze/stream` 接口，支持通过 LangGraph 的 `astream` 异步迭代器，向前端实时推送各个智能体的分析进度与辩论实况。

---

## 3. 智能体角色详解 (Agent Roles in Detail)

代码库中的智能体按职能划分在 `tradingagents/agents/` 目录下，模块高度独立且可复用。

### 3.1 分析师团队 (Analyst Team) - `agents/analysts/`
分析师主要负责调用工具获取并汇总数据，不直接做交易决策：
- **基本面分析师 (`fundamentals_analyst.py`)**: 调用 `get_fundamentals`, `get_balance_sheet` 等工具，分析公司的财务健康状况、资产负债表和现金流。
- **技术分析师 (`market_analyst.py`)**: 关注股票价格走势，调用 `get_indicators` 获取技术指标。
- **新闻分析师 (`news_analyst.py`)**: 评估宏观经济指标、公司新闻以及内部交易信息（`get_insider_transactions`）。
- **情绪分析师 (`social_media_analyst.py`)**: 收集社交媒体和公众情绪，衡量市场热度。

### 3.2 研究员团队 (Researcher Team) - `agents/researchers/`
研究员负责对分析师的数据进行批判性评估：
- **牛方研究员 (`bull_researcher.py`)**: 强调公司的增长潜力、竞争优势和积极的市场指标。
- **熊方研究员 (`bear_researcher.py`)**: 重点关注潜在风险、负面市场信号及行业下行压力。
*(注：研究员在 Prompt 中被强制要求结合历史记忆 `past_memory_str` 进行发言，以体现“经验教训”)*

### 3.3 交易员 (Trader Agent) - `agents/trader/trader.py`
- **核心职责**: 综合分析师的报告和研究员的辩论，制定初步的投资策略。
- **输出规范**: 必须在回答末尾以 `FINAL TRANSACTION PROPOSAL: **BUY/HOLD/SELL**` 明确表达立场。

### 3.4 风控团队 (Risk Management Team) - `agents/risk_mgmt/`
负责控制风险敞口，确保交易活动在预定限制内：
- 包含 **激进型 (`aggressive_debator.py`)**、**保守型 (`conservative_debator.py`)** 和 **中立型 (`neutral_debator.py`)** 风控员。
- 他们会对交易员的计划进行多维度的风险审查。

### 3.5 基金经理 (Managers) - `agents/managers/`
- **Portfolio Manager (`portfolio_manager.py`)**: 最终的决策者，负责批准或否决交易，并执行操作。

---

## 4. 关键技术组件 (Key Technical Components)

- **LLM 客户端集成 (`tradingagents/llm_clients/`)**: 
  - 支持 OpenAI, Anthropic, Google 等多家模型。
  - 区分了 `deep_think_llm`（用于复杂推理，如研究员辩论）和 `quick_think_llm`（用于简单汇总或反射机制）。
- **数据流与工具 (`tradingagents/dataflows/` & `agents/utils/`)**:
  - 接入了 Alpha Vantage 和 yfinance 等金融数据源。
  - `agent_utils.py` 中封装了标准的 Tool 函数（如 `get_stock_data`, `get_news`），通过 `llm.bind_tools(tools)` 绑定给智能体使用。
- **记忆与反思机制 (`agents/utils/memory.py`)**:
  - 使用 `FinancialSituationMemory` 组件。每次交易后，系统会计算盈亏（Returns/Losses），并通过 `Reflector`（反思者）将成功或失败的经验写入记忆。下一次遇到相似的市场环境时，智能体会提取历史教训指导决策。

---

## 5. 开发规范与扩展指南 (Development Guidelines)

为了保证代码库的结构兼容性和可维护性，新成员在进行二次开发时请遵循以下偏好：

### 5.1 状态管理 (State Management)
- 整个流程依赖 `tradingagents/agents/utils/agent_states.py` 中定义的 `AgentState` 字典进行数据流转。
- 增加新 Agent 时，需确保其输入和输出能够正确读取和更新 State 中的对应字段（例如 `news_report` 或 `investment_debate_state`）。

### 5.2 如何添加新的 Agent
1. **定义 Node 函数**: 在 `agents/` 下对应的子目录创建文件。遵循闭包工厂模式，例如 `def create_custom_agent(llm, memory=None): def node(state): ... return node`。
2. **构建 Prompt**: 使用 `langchain_core.prompts.ChatPromptTemplate`。确保 Prompt 明确角色的输入（Context）和输出格式要求。
3. **绑定 Tools**: 如果 Agent 需要外部数据，从 `agent_utils.py` 引入工具，并使用 `llm.bind_tools(tools)`。
4. **注册到 Graph**: 修改 `tradingagents/graph/trading_graph.py`，将新的 Node 加入到 `GraphSetup` 流程中。

### 5.3 提示词 (Prompt Engineering) 最佳实践
- **强制输出格式**: 对于需要做最终决策的 Agent，必须在 Prompt 中写明固定后缀（如 `FINAL TRANSACTION PROPOSAL: ...`），以便系统解析。
- **上下文注入**: 使用 `build_instrument_context` 获取资产的背景信息，并始终注入当前时间 `current_date` 以防模型产生幻觉。
- **记忆增强**: 涉及分析和决策的 Agent，应在 Prompt 中加入 `past_memory_str`，使模型具备 Few-Shot 和历史经验反思能力。

### 5.4 模块独立性
- 所有的外部 API 调用必须封装在 `dataflows/` 中，Agent 仅通过 `agent_utils.py` 暴露的纯函数进行交互。
- 配置项统一在 `tradingagents/default_config.py` 中管理（如 LLM 提供商、数据源选择），**避免在 Agent 代码中硬编码**。
- **内部高频数据接口**：对于拉取全市场数据或批量股票历史数据，已接入 `bruinxz/stocks` 项目提供的高性能本地 API（接口地址代码在：`/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/api/controllers`，目前默认服务地址 `http://<legacy-prod-host>:3000`）。通过 `tradingagents/dataflows/internal_api.py` 中封装的 `InternalStockAPI` 类进行调用，支持 `GET /api/internal/stocks` 获取股票池和 `POST /api/internal/data/batch-history` 进行批量获取，极大地减少了全市场扫描时的网络 I/O。使用时需在 `.env` 中配置 `INTERNAL_API_KEY`。
