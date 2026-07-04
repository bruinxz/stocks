# TradingAgents/graph/trading_graph.py

import os
from pathlib import Path
import json
from datetime import date
from typing import Dict, Any, Tuple, List, Optional

from langgraph.prebuilt import ToolNode

from tradingagents.llm_clients import create_llm_client

from tradingagents.agents import *
from tradingagents.default_config import DEFAULT_CONFIG
from tradingagents.agents.utils.memory import FinancialSituationMemory
from tradingagents.agents.utils.agent_states import (
    AgentState,
    InvestDebateState,
    RiskDebateState,
)
from tradingagents.dataflows.config import set_config

# Import the new abstract tool methods from agent_utils
from tradingagents.agents.utils.agent_utils import (
    get_stock_data,
    get_indicators,
    get_fundamentals,
    get_balance_sheet,
    get_cashflow,
    get_income_statement,
    get_news,
    get_insider_transactions,
    get_global_news
)

from .conditional_logic import ConditionalLogic
from .setup import GraphSetup
from .propagation import Propagator
from .reflection import Reflector
from .signal_processing import SignalProcessor


class TradingAgentsGraph:
    """Main class that orchestrates the trading agents framework."""

    def __init__(
        self,
        selected_analysts=["market", "social", "news", "fundamentals"],
        debug=False,
        config: Dict[str, Any] = None,
        callbacks: Optional[List] = None,
    ):
        """Initialize the trading agents graph and components.

        Args:
            selected_analysts: List of analyst types to include
            debug: Whether to run in debug mode
            config: Configuration dictionary. If None, uses default config
            callbacks: Optional list of callback handlers (e.g., for tracking LLM/tool stats)
        """
        self.debug = debug
        self.config = config or DEFAULT_CONFIG
        self.callbacks = callbacks or []

        # Update the interface's config
        set_config(self.config)

        # Create necessary directories
        os.makedirs(
            os.path.join(self.config["project_dir"], "dataflows/data_cache"),
            exist_ok=True,
        )

        # Initialize LLMs with provider-specific thinking configuration
        llm_kwargs = self._get_provider_kwargs()

        # Add callbacks to kwargs if provided (passed to LLM constructor)
        if self.callbacks:
            llm_kwargs["callbacks"] = self.callbacks

        deep_client = create_llm_client(
            provider=self.config["llm_provider"],
            model=self.config["deep_think_llm"],
            base_url=self.config.get("backend_url"),
            **llm_kwargs,
        )
        quick_client = create_llm_client(
            provider=self.config["llm_provider"],
            model=self.config["quick_think_llm"],
            base_url=self.config.get("backend_url"),
            **llm_kwargs,
        )

        self.deep_thinking_llm = deep_client.get_llm()
        self.quick_thinking_llm = quick_client.get_llm()
        
        # Initialize memories
        self.bull_memory = FinancialSituationMemory("bull_memory", self.config)
        self.bear_memory = FinancialSituationMemory("bear_memory", self.config)
        self.trader_memory = FinancialSituationMemory("trader_memory", self.config)
        self.invest_judge_memory = FinancialSituationMemory("invest_judge_memory", self.config)
        self.portfolio_manager_memory = FinancialSituationMemory("portfolio_manager_memory", self.config)

        # Create tool nodes
        self.tool_nodes = self._create_tool_nodes()

        # Initialize components
        self.conditional_logic = ConditionalLogic(
            max_debate_rounds=self.config["max_debate_rounds"],
            max_risk_discuss_rounds=self.config["max_risk_discuss_rounds"],
        )
        self.graph_setup = GraphSetup(
            self.quick_thinking_llm,
            self.deep_thinking_llm,
            self.tool_nodes,
            self.bull_memory,
            self.bear_memory,
            self.trader_memory,
            self.invest_judge_memory,
            self.portfolio_manager_memory,
            self.conditional_logic,
        )

        self.propagator = Propagator()
        self.reflector = Reflector(self.quick_thinking_llm)
        self.signal_processor = SignalProcessor(self.quick_thinking_llm)

        # State tracking
        self.curr_state = None
        self.ticker = None
        self.log_states_dict = {}  # date to full state dict

        # Set up the graph
        self.analyst_graphs = self.graph_setup.setup_analyst_graphs(selected_analysts)
        self.main_graph = self.graph_setup.setup_main_graph()
        self.selected_analysts = selected_analysts

    def _get_provider_kwargs(self) -> Dict[str, Any]:
        """Get provider-specific kwargs for LLM client creation."""
        kwargs = {}
        provider = self.config.get("llm_provider", "").lower()

        if provider == "google":
            thinking_level = self.config.get("google_thinking_level")
            if thinking_level:
                kwargs["thinking_level"] = thinking_level

        elif provider == "openai":
            reasoning_effort = self.config.get("openai_reasoning_effort")
            if reasoning_effort:
                kwargs["reasoning_effort"] = reasoning_effort

        elif provider == "anthropic":
            effort = self.config.get("anthropic_effort")
            if effort:
                kwargs["effort"] = effort

        return kwargs

    def _create_tool_nodes(self) -> Dict[str, ToolNode]:
        """Create tool nodes for different data sources using abstract methods."""
        return {
            "market": ToolNode(
                [
                    # Core stock data tools
                    get_stock_data,
                    # Technical indicators
                    get_indicators,
                ]
            ),
            "social": ToolNode(
                [
                    # News tools for social media analysis
                    get_news,
                ]
            ),
            "news": ToolNode(
                [
                    # News and insider information
                    get_news,
                    get_global_news,
                    get_insider_transactions,
                ]
            ),
            "fundamentals": ToolNode(
                [
                    # Fundamental analysis tools
                    get_fundamentals,
                    get_balance_sheet,
                    get_cashflow,
                    get_income_statement,
                ]
            ),
        }

    def propagate(self, company_name, trade_date, **kwargs):
        """Run the trading agents graph for a company on a specific date."""

        self.ticker = company_name

        # Initialize state
        init_agent_state = self.propagator.create_initial_state(
            company_name, trade_date
        )
        args = kwargs if kwargs else self.propagator.get_graph_args()

        # 强制非流式调用使用 values 模式，以保证 final_state 包含所有初始键
        if "stream_mode" not in args or args.get("stream_mode") != "values":
            args["stream_mode"] = "values"

        log_file_path = None
        if self.debug:
            # Debug mode with tracing
            trace = []
            
            # Prepare to persist the log to disk
            import os
            from datetime import datetime
            
            directory = Path(self.config["results_dir"]) / self.ticker / "TradingAgentsStrategy_logs"
            directory.mkdir(parents=True, exist_ok=True)
            
            # Generate a timestamped log file name
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            log_file_path_obj = directory / f"execution_trace_{trade_date}_{timestamp}.md"
            log_file_path = str(log_file_path_obj)
            
            # Helper to print and write to file
            def log_and_print(text):
                print(text)
                with open(log_file_path_obj, "a", encoding="utf-8") as lf:
                    lf.write(text + "\n")
            
            log_and_print(f"# 交易代理执行日志 - {company_name} ({trade_date})\n")
            
            step_count = 1
            last_msg_id = None
            
            def process_chunk(chunk):
                nonlocal step_count, last_msg_id
                if len(chunk["messages"]) == 0:
                    return
                
                msg = chunk["messages"][-1]
                
                # Deduplicate messages by their unique ID to prevent repeated printing
                # when nodes just pass the message state forward without appending
                msg_id = getattr(msg, "id", None)
                if msg_id and msg_id == last_msg_id:
                    trace.append(chunk)
                    return
                last_msg_id = msg_id
                
                # Format message type to Chinese
                msg_type = type(msg).__name__
                
                # Generate a nicer Markdown representation
                log_and_print(f"\n## 步骤 {step_count}")
                
                if "HumanMessage" in msg_type:
                    log_and_print("### 👤 人类/系统调度指令\n")
                elif "AIMessage" in msg_type:
                    log_and_print("### 🤖 AI 智能体分析与辩论\n")
                elif "ToolMessage" in msg_type:
                    log_and_print("### 🛠️ 工具返回结果\n")
                elif "SystemMessage" in msg_type:
                    log_and_print("### ⚙️ 系统初始化信息\n")
                else:
                    log_and_print(f"### 📄 {msg_type}\n")
                
                if hasattr(msg, "tool_calls") and msg.tool_calls:
                    log_and_print("<details><summary><b>展开查看工具调用详情</b></summary>\n")
                    log_and_print("```json")
                    for tc in msg.tool_calls:
                        log_and_print(f"[{tc['name']}] (Call ID: {tc['id']})")
                        for k, v in tc['args'].items():
                            log_and_print(f"  - {k}: {v}")
                    log_and_print("```\n</details>\n")
                    
                if msg.content:
                    if "ToolMessage" in msg_type:
                        log_and_print("<details><summary><b>展开查看完整工具数据</b></summary>\n")
                        log_and_print("```csv\n" + str(msg.content) + "\n```")
                        log_and_print("</details>\n")
                    else:
                        log_and_print(str(msg.content) + "\n")
                    
                trace.append(chunk)
                step_count += 1

            # 1. Run analysts in parallel
            import concurrent.futures
            
            def run_analyst(a_type):
                graph = self.analyst_graphs[a_type]
                # Pass a fresh copy of the initial state
                chunks = list(graph.stream(init_agent_state.copy(), **args))
                # For langgraph > 0.1, stream returns dicts mapping node name to state
                # Wait, we need the final state to extract the report
                # chunk format: {node_name: state_update}
                # But trace needs to append the full state or updates?
                return a_type, chunks

            analyst_results = {}
            with concurrent.futures.ThreadPoolExecutor(max_workers=len(self.selected_analysts)) as executor:
                futures = {executor.submit(run_analyst, a_type): a_type for a_type in self.selected_analysts}
                for future in concurrent.futures.as_completed(futures):
                    a_type, chunks = future.result()
                    analyst_results[a_type] = chunks

            # Merge results into a new state for the main graph
            merged_state = init_agent_state.copy()
            
            # 2. Print analyst logs sequentially and merge reports
            for a_type in self.selected_analysts:
                chunks = analyst_results[a_type]
                for chunk in chunks:
                    # In LangGraph stream, chunk is a dict {node_name: state_update}
                    # We need to format it to match what process_chunk expects.
                    # Wait, process_chunk expects a state dict with "messages" key?
                    # No, graph.stream(stream_mode="values") yields state dicts.
                    # By default stream_mode="values", which yields the full state.
                    # Let's assume chunk is the state dict, but if it's a node update, we need the values.
                    # Let's just pass the chunk's inner state if it's a node update.
                    # Actually, stream() default in LangGraph is stream_mode="values".
                    # So chunk IS the full state dict.
                    if isinstance(chunk, dict) and "messages" in chunk:
                        process_chunk(chunk)
                    else:
                        # If stream_mode is "updates", it returns {node: state_update}
                        # We extract the state update
                        for node_name, state_update in chunk.items():
                            if isinstance(state_update, dict) and "messages" in state_update:
                                process_chunk(state_update)
                
                # The last chunk from an analyst graph should contain the final report
                final_chunk = chunks[-1]
                if not ("messages" in final_chunk and isinstance(final_chunk, dict)):
                    # Extract from node update
                    final_chunk = list(final_chunk.values())[0]

                def get_val(state_dict, key):
                    return state_dict.get(key, "")

                if a_type == "market":
                    merged_state["market_report"] = get_val(final_chunk, "market_report")
                elif a_type == "social":
                    merged_state["sentiment_report"] = get_val(final_chunk, "sentiment_report")
                elif a_type == "news":
                    merged_state["news_report"] = get_val(final_chunk, "news_report")
                elif a_type == "fundamentals":
                    merged_state["fundamentals_report"] = get_val(final_chunk, "fundamentals_report")
                    
            # 3. Clear messages placeholder for main graph
            from langchain_core.messages import HumanMessage
            merged_state["messages"] = [HumanMessage(content="继续")]
            
            # 4. Run the main graph
            for chunk in self.main_graph.stream(merged_state, **args):
                if isinstance(chunk, dict) and "messages" in chunk:
                    process_chunk(chunk)
                else:
                    for node_name, state_update in chunk.items():
                        if isinstance(state_update, dict) and "messages" in state_update:
                            process_chunk(state_update)

            # In LangGraph stream mode="values", the chunk is the full state.
            final_state = trace[-1] if trace else merged_state
            
            log_and_print(f"\n---\n**✅ 执行结束，最终日志保存在: {log_file_path}**\n")
        else:
            # Standard mode without tracing
            import concurrent.futures
            
            def run_analyst_standard(a_type):
                graph = self.analyst_graphs[a_type]
                return a_type, graph.invoke(init_agent_state.copy(), **args)

            analyst_results = {}
            with concurrent.futures.ThreadPoolExecutor(max_workers=len(self.selected_analysts)) as executor:
                futures = {executor.submit(run_analyst_standard, a_type): a_type for a_type in self.selected_analysts}
                for future in concurrent.futures.as_completed(futures):
                    a_type, final_analyst_state = future.result()
                    analyst_results[a_type] = final_analyst_state

            merged_state = init_agent_state.copy()
            for a_type in self.selected_analysts:
                final_analyst_state = analyst_results[a_type]
                if a_type == "market":
                    merged_state["market_report"] = final_analyst_state.get("market_report", "")
                elif a_type == "social":
                    merged_state["sentiment_report"] = final_analyst_state.get("sentiment_report", "")
                elif a_type == "news":
                    merged_state["news_report"] = final_analyst_state.get("news_report", "")
                elif a_type == "fundamentals":
                    merged_state["fundamentals_report"] = final_analyst_state.get("fundamentals_report", "")

            from langchain_core.messages import HumanMessage
            merged_state["messages"] = [HumanMessage(content="继续")]
            
            final_state = self.main_graph.invoke(merged_state, **args)

        # Store current state for reflection
        self.curr_state = final_state

        # Log state
        self._log_state(trade_date, final_state)

        # Return final state, processed decision, full rationale, and log path
        return final_state, self.process_signal(final_state["final_trade_decision"]), final_state["final_trade_decision"], log_file_path

    def _log_state(self, trade_date, final_state):
        """Log the final state to a JSON file."""
        self.log_states_dict[str(trade_date)] = {
            "company_of_interest": final_state["company_of_interest"],
            "trade_date": final_state["trade_date"],
            "market_report": final_state["market_report"],
            "sentiment_report": final_state["sentiment_report"],
            "news_report": final_state["news_report"],
            "fundamentals_report": final_state["fundamentals_report"],
            "investment_debate_state": {
                "bull_history": final_state["investment_debate_state"]["bull_history"],
                "bear_history": final_state["investment_debate_state"]["bear_history"],
                "history": final_state["investment_debate_state"]["history"],
                "current_response": final_state["investment_debate_state"][
                    "current_response"
                ],
                "judge_decision": final_state["investment_debate_state"][
                    "judge_decision"
                ],
            },
            "trader_investment_decision": final_state["trader_investment_plan"],
            "risk_debate_state": {
                "aggressive_history": final_state["risk_debate_state"]["aggressive_history"],
                "conservative_history": final_state["risk_debate_state"]["conservative_history"],
                "neutral_history": final_state["risk_debate_state"]["neutral_history"],
                "history": final_state["risk_debate_state"]["history"],
                "judge_decision": final_state["risk_debate_state"]["judge_decision"],
            },
            "investment_plan": final_state["investment_plan"],
            "final_trade_decision": final_state["final_trade_decision"],
        }

        # Save to file
        directory = Path(self.config["results_dir"]) / self.ticker / "TradingAgentsStrategy_logs"
        directory.mkdir(parents=True, exist_ok=True)

        log_path = directory / f"full_states_log_{trade_date}.json"
        with open(log_path, "w", encoding="utf-8") as f:
            json.dump(self.log_states_dict[str(trade_date)], f, indent=4)

    def reflect_and_remember(self, returns_losses):
        """Reflect on decisions and update memory based on returns."""
        self.reflector.reflect_bull_researcher(
            self.curr_state, returns_losses, self.bull_memory
        )
        self.reflector.reflect_bear_researcher(
            self.curr_state, returns_losses, self.bear_memory
        )
        self.reflector.reflect_trader(
            self.curr_state, returns_losses, self.trader_memory
        )
        self.reflector.reflect_invest_judge(
            self.curr_state, returns_losses, self.invest_judge_memory
        )
        self.reflector.reflect_portfolio_manager(
            self.curr_state, returns_losses, self.portfolio_manager_memory
        )

    def process_signal(self, full_signal):
        """Process a signal to extract the core decision."""
        return self.signal_processor.process_signal(full_signal)
