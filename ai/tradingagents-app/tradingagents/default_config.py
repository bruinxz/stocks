import os
from tradingagents.utils.env_config import get_env_or_config

DEFAULT_CONFIG = {
    "project_dir": os.path.abspath(os.path.join(os.path.dirname(__file__), ".")),
    "results_dir": get_env_or_config("TRADINGAGENTS_RESULTS_DIR", "./results"),
    "storage_dir": get_env_or_config("TRADINGAGENTS_STORAGE_DIR", os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "local_storage"))),
    "data_cache_dir": get_env_or_config(
        "TRADINGAGENTS_DATA_CACHE_DIR",
        os.path.join(
            os.path.abspath(os.path.join(os.path.dirname(__file__), ".")),
            "dataflows/data_cache",
        ),
    ),
    # LLM settings
    "llm_provider": "openai",
    "deep_think_llm": "gpt-5.4",
    "quick_think_llm": "gpt-5.4-mini",
    "backend_url": "https://api.openai.com/v1",
    # Provider-specific thinking configuration
    "google_thinking_level": None,      # "high", "minimal", etc.
    "openai_reasoning_effort": None,    # "medium", "high", "low"
    "anthropic_effort": None,           # "high", "medium", "low"
    # Output language for analyst reports and final decision
    # Internal agent debate stays in English for reasoning quality
    "output_language": "English",
    # Debate and discussion settings
    "max_debate_rounds": 1,
    "max_risk_discuss_rounds": 1,
    "max_recur_limit": 100,
    # Data vendor configuration
    # Category-level configuration (default for all tools in category)
    "data_vendors": {
        # 迁移合并 (2026-07-04): 默认以 stocks 后端 (internal_api) 为 A 股唯一真源,
        # akshare 作兜底. route_to_vendor 支持逗号分隔的 fallback 链.
        # 注: get_stock_data/get_indicators 的底层 (akshare_stock -> local_db)
        #     本身已首选 InternalStockAPI, 故 akshare 项即等价于"走后端优先, 直连兜底".
        "core_stock_apis": "akshare",           # 底层 local_db 首选 internal_api, akshare 兜底
        "technical_indicators": "akshare",      # 同上, 基于 internal_api 行情算指标
        "fundamental_data": "akshare",          # A 股基本面: akshare (内部 pe/pb 已入库)
        "news_data": "akshare",                 # A 股新闻: akshare
    },
    # Tool-level configuration (takes precedence over category-level)
    "tool_vendors": {
        # Example: "get_stock_data": "alpha_vantage",  # Override category default
    },
}
