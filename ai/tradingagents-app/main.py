from tradingagents.graph.trading_graph import TradingAgentsGraph
from tradingagents.default_config import DEFAULT_CONFIG

from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

# Create a custom config
config = DEFAULT_CONFIG.copy()
config["llm_provider"] = "volcengine"  # Use volcengine provider
config["deep_think_llm"] = "ep-20260106180228-bc8dv"  # Specified EP
config["quick_think_llm"] = "ep-20260106180228-bc8dv"  # Specified EP
config["backend_url"] = "https://ark.cn-beijing.volces.com/api/v3" # Specified EP URL
config["max_debate_rounds"] = 1  # Increase debate rounds
config["output_language"] = "Chinese"  # Set output language to Chinese

# Configure data vendors (default uses yfinance, no extra API keys needed)
config["data_vendors"] = {
    "core_stock_apis": "akshare",           # Options: alpha_vantage, yfinance, akshare
    "technical_indicators": "akshare",      # Options: alpha_vantage, yfinance, akshare
    "fundamental_data": "akshare",          # Options: alpha_vantage, yfinance, akshare
    "news_data": "akshare",                 # Options: alpha_vantage, yfinance, akshare
}

# Clear existing env vars that might interfere before initialization
import os
# Ensure no empty API keys from .env are leaking into Langchain-OpenAI
for key in list(os.environ.keys()):
    if key.startswith("OPENAI_"):
        del os.environ[key]

# Some langchain versions fallback to api.openai.com if OPENAI_API_KEY is empty string 
# which might be loaded from .env. Let's explicitly set the fallback env vars for Volcano
import json
try:
    with open("config.json") as f:
        cfg = json.load(f)
        if "ARK_API_KEY" in cfg:
            os.environ["OPENAI_API_KEY"] = cfg["ARK_API_KEY"]
            os.environ["OPENAI_API_BASE"] = "https://ark.cn-beijing.volces.com/api/v3"
            os.environ["OPENAI_BASE_URL"] = "https://ark.cn-beijing.volces.com/api/v3"
except Exception:
    pass

from datetime import datetime

def run_trading_analysis(ticker: str, target_date: str = None) -> tuple:
    """
    Run the multi-agent trading analysis for a specific stock ticker.
    
    Args:
        ticker (str): The stock symbol (e.g., '000001', '603039' for A-shares).
        target_date (str, optional): The specific date for analysis in 'YYYY-MM-DD' format. 
                                     Defaults to current date if None.
        
    Returns:
        tuple: (decision (str), rationale (str), log_file_path (str))
    """
    # Initialize with custom config
    ta = TradingAgentsGraph(debug=True, config=config)

    # Get target date or fallback to current date
    if target_date is None:
        target_date = datetime.today().strftime("%Y-%m-%d")

    print(f"Starting analysis for {ticker} on {target_date}...")
    
    # forward propagate
    try:
        # 由于流式接口修改了 stream_mode="updates"，我们需要在非流式调用中覆盖它
        # 否则最后的 trace[-1] 只会包含增量更新，导致 KeyError: 'company_of_interest'
        args = ta.propagator.get_graph_args()
        args["stream_mode"] = "values"
        
        # 原有的 propagate 返回了 4 个值，但我们只需要后面的
        _, decision, rationale, log_path = ta.propagate(ticker, target_date, **args)
        
        print(f"\nFinal Decision for {ticker}: {decision}")
        print(f"Detailed log saved to: {log_path}")
        
        # Memorize mistakes and reflect (optional)
        # ta.reflect_and_remember(1000) # parameter is the position returns
        
        return decision, rationale, log_path
    except Exception as e:
        print(f"分析执行失败: {e}")
        import traceback
        traceback.print_exc()
        raise e

if __name__ == "__main__":
    # Example usage: A-share Weaver Network "603039"
    decision, rationale, log_path = run_trading_analysis("603039")
    print(f"\n================ 最终执行结果 ================")
    print(f"Decision: {decision}")
    print(f"Log Path: {log_path}")
    print(f"Rationale:\n{rationale}")
    print(f"=============================================")
