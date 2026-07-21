import os
from copy import deepcopy
from datetime import datetime

from tradingagents.default_config import DEFAULT_CONFIG
from tradingagents.graph.trading_graph import TradingAgentsGraph


def build_runtime_config() -> dict:
    """Build one runtime configuration from environment-managed settings."""
    config = deepcopy(DEFAULT_CONFIG)
    config["llm_provider"] = os.getenv("TRADINGAGENTS_LLM_PROVIDER", "volcengine")
    config["deep_think_llm"] = os.getenv(
        "TRADINGAGENTS_DEEP_MODEL", "ep-20260106180228-bc8dv"
    )
    config["quick_think_llm"] = os.getenv(
        "TRADINGAGENTS_QUICK_MODEL", config["deep_think_llm"]
    )
    config["backend_url"] = os.getenv(
        "TRADINGAGENTS_LLM_BASE_URL", "https://ark.cn-beijing.volces.com/api/v3"
    )
    config["max_debate_rounds"] = int(os.getenv("TRADINGAGENTS_MAX_DEBATE_ROUNDS", "1"))
    config["max_risk_discuss_rounds"] = int(
        os.getenv("TRADINGAGENTS_MAX_RISK_ROUNDS", "1")
    )
    config["output_language"] = os.getenv("TRADINGAGENTS_OUTPUT_LANGUAGE", "Chinese")
    config["data_vendors"] = {
        "core_stock_apis": "akshare",
        "technical_indicators": "akshare",
        "fundamental_data": "akshare",
        "news_data": "akshare",
    }
    return config


def run_trading_analysis(ticker: str, target_date: str | None = None) -> tuple:
    """Run the complete multi-agent analysis for one stock."""
    target_date = target_date or datetime.today().strftime("%Y-%m-%d")
    graph = TradingAgentsGraph(debug=False, config=build_runtime_config())
    args = graph.propagator.get_graph_args()
    args["stream_mode"] = "values"
    _, decision, rationale, log_path = graph.propagate(ticker, target_date, **args)
    return decision, rationale, log_path


if __name__ == "__main__":
    decision, rationale, log_path = run_trading_analysis("603039")
    print(f"Decision: {decision}\nLog: {log_path}\n{rationale}")
