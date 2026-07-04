from tradingagents.default_config import DEFAULT_CONFIG
import os
import json

# 修改默认配置，将数据源切换为 yfinance 规避 akshare 报错
config = DEFAULT_CONFIG.copy()
config["llm_provider"] = "volcengine"
config["deep_think_llm"] = "ep-20260106180228-bc8dv"
config["quick_think_llm"] = "ep-20260106180228-bc8dv"
config["backend_url"] = "https://ark.cn-beijing.volces.com/api/v3"
config["max_debate_rounds"] = 1
config["output_language"] = "Chinese"

# 将数据源恢复为 akshare，以利用我们刚刚做好的本地数据库提速！
config["data_vendors"] = {
    "core_stock_apis": "akshare",
    "technical_indicators": "akshare",
    "fundamental_data": "akshare",
    "news_data": "akshare",
}

for key in list(os.environ.keys()):
    if key.startswith("OPENAI_"):
        del os.environ[key]

try:
    with open("config.json") as f:
        cfg = json.load(f)
        if "ARK_API_KEY" in cfg:
            os.environ["OPENAI_API_KEY"] = cfg["ARK_API_KEY"]
            os.environ["OPENAI_API_BASE"] = "https://ark.cn-beijing.volces.com/api/v3"
            os.environ["OPENAI_BASE_URL"] = "https://ark.cn-beijing.volces.com/api/v3"
except Exception:
    pass

import time
from datetime import datetime, timedelta
from tradingagents.graph.trading_graph import TradingAgentsGraph

def run_trading_analysis_ak(ticker: str, target_date: str) -> tuple:
    # 针对 akshare，不需要加后缀，直接使用6位代码
    ta = TradingAgentsGraph(debug=True, config=config)
    print(f"Starting analysis for {ticker} on {target_date} using akshare (local DB enabled)...")
    _, decision, rationale, log_path = ta.propagate(ticker, target_date)
    return decision, rationale, log_path

if __name__ == "__main__":
    today = datetime.today().strftime("%Y-%m-%d")
    ticker = "588200"
    
    print(f"正在本地启动针对 {ticker} 在 {today} 的多智能体分析...")
    
    start_time = time.time()
    decision, rationale, log_path = run_trading_analysis_ak(ticker, today)
    end_time = time.time()

    elapsed_time = end_time - start_time
    
    print("\n" + "="*50)
    print(f"⏱️ 总耗时: {elapsed_time:.2f} 秒")
    print("="*50)
    print(f"🎯 最终决策: {decision}")
    print("="*50)
    print(f"📝 决策依据:\n{rationale}")
    print("="*50)
    print(f"📄 详细日志保存在: {log_path}")
