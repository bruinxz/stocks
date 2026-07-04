from tradingagents.default_config import DEFAULT_CONFIG
import os
import json
from datetime import datetime, timedelta
from tradingagents.graph.trading_graph import TradingAgentsGraph
import concurrent.futures

# 修改默认配置，将数据源切换为 yfinance 规避 akshare 报错
config = DEFAULT_CONFIG.copy()
config["llm_provider"] = "volcengine"
config["deep_think_llm"] = "ep-20260106180228-bc8dv"
config["quick_think_llm"] = "ep-20260106180228-bc8dv"
config["backend_url"] = "https://ark.cn-beijing.volces.com/api/v3"
config["max_debate_rounds"] = 1
config["output_language"] = "Chinese"

# ⚠️ 将数据源从 akshare 切换到 yfinance
config["data_vendors"] = {
    "core_stock_apis": "yfinance",
    "technical_indicators": "yfinance",
    "fundamental_data": "yfinance",
    "news_data": "yfinance",
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

def run_analysis(task_info):
    name, ticker, target_date = task_info
    # 针对 yfinance，A股代码需要加后缀，如 603039.SS
    if ticker.startswith("6"):
        yf_ticker = f"{ticker}.SS"
    else:
        yf_ticker = f"{ticker}.SZ"
        
    ta = TradingAgentsGraph(debug=True, config=config)
    print(f"[{name}] 开始分析 {yf_ticker} (目标日期: {target_date})...")
    
    # forward propagate
    _, decision, rationale, log_path = ta.propagate(yf_ticker, target_date)
    return name, yf_ticker, decision, rationale, log_path

if __name__ == "__main__":
    yesterday = (datetime.today() - timedelta(days=1)).strftime("%Y-%m-%d")
    
    # 泛微网络 (603039), 华夏幸福 (600340)
    tasks = [
        ("泛微网络", "603039", yesterday),
        ("华夏幸福", "600340", yesterday)
    ]
    
    print("🚀 开始并发执行多智能体分析任务...")
    
    results = []
    # 使用 ThreadPoolExecutor 进行并发执行，最大线程数为 2
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        future_to_task = {executor.submit(run_analysis, task): task for task in tasks}
        
        for future in concurrent.futures.as_completed(future_to_task):
            task = future_to_task[future]
            try:
                res = future.result()
                results.append(res)
                print(f"✅ [{task[0]}] 分析完成！")
            except Exception as exc:
                print(f"❌ [{task[0]}] 运行过程中产生异常: {exc}")
                import traceback
                traceback.print_exc()

    print("\n" + "="*50)
    print("🎉 所有任务执行完成！以下是最终汇总：")
    print("="*50)
    
    for name, yf_ticker, decision, rationale, log_path in results:
        print(f"\n【{name} ({yf_ticker})】")
        print(f"🎯 最终决策: {decision}")
        print(f"📄 日志路径: {log_path}")
        print(f"📝 简要依据:\n{rationale}")
        print("-" * 50)
