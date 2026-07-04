import pandas as pd
import json
import os
import time
from datetime import datetime, timedelta
import concurrent.futures
from tradingagents.dataflows.internal_api import InternalStockAPI

# 1. 确保本地数据库目录存在
DB_DIR = "local_db/historical_data"
os.makedirs(DB_DIR, exist_ok=True)

# 2. 设置要拉取的时间范围：最近一年
end_date = datetime.today()
start_date = end_date - timedelta(days=365)
start_date_str = start_date.strftime("%Y-%m-%d")
end_date_str = end_date.strftime("%Y-%m-%d")

def process_batch(batch_stocks):
    """批量拉取股票数据并落库"""
    if not batch_stocks:
        return
        
    symbols = [s["code"] for s in batch_stocks]
    names_dict = {s["code"]: s["name"] for s in batch_stocks}
    
    print(f"🚀 开始并发拉取批次 ({len(symbols)}只): {symbols[0]} ... {symbols[-1]}")
    
    # 调用高性能内部接口进行批量查询
    batch_results = InternalStockAPI.get_batch_historical_data(
        symbols=symbols,
        start_date=start_date_str,
        end_date=end_date_str
    )
    
    for code, df_price in batch_results.items():
        name = names_dict.get(code, "Unknown")
        if df_price is None or df_price.empty:
            print(f"⚠️ {name} ({code}) 内部API未返回数据")
            continue
            
        # 整理字段以适配原系统格式
        df_final = df_price.reset_index()
        if "trade_date" in df_final.columns:
            df_final = df_final.rename(columns={"trade_date": "日期"})
            
        rename_map = {
            "open": "开盘", "close": "收盘", "high": "最高", "low": "最低",
            "vol": "成交量", "amount": "成交额", "pct_chg": "涨跌幅"
        }
        df_final = df_final.rename(columns=rename_map)
        
        # 格式化日期
        df_final['日期'] = pd.to_datetime(df_final['日期']).dt.strftime('%Y-%m-%d')
        
        # 插入基础信息
        df_final.insert(0, '股票代码', code)
        df_final.insert(1, '股票名称', name)
        
        # 保存为 CSV
        file_path = os.path.join(DB_DIR, f"{code}_{name}.csv")
        df_final.to_csv(file_path, index=False, encoding='utf-8-sig')
        print(f"✅ 成功! {name} ({code}) 极速保存 -> {file_path} (共 {len(df_final)} 条记录)")

if __name__ == "__main__":
    stocks_to_fetch = []
    
    # 读取持仓股票和关注股票
    try:
        with open("local_db/holdings.json", "r", encoding="utf-8") as f:
            stocks_to_fetch.extend(json.load(f))
        with open("local_db/watchlist.json", "r", encoding="utf-8") as f:
            stocks_to_fetch.extend(json.load(f))
    except Exception as e:
        print(f"读取配置文件失败: {e}")
        exit(1)
        
    print(f"🎯 共加载了 {len(stocks_to_fetch)} 只目标股票/ETF，准备使用 InternalStockAPI 批量拉取最近一年的行情数据...")
    
    # 使用 chunking 进行批处理，每批最多 50 只（内部 API 支持单次 50 只）
    batch_size = 50
    batches = [stocks_to_fetch[i:i + batch_size] for i in range(0, len(stocks_to_fetch), batch_size)]
    
    # 也可以使用多线程加快批次之间的处理速度
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
        futures = [executor.submit(process_batch, batch) for batch in batches]
        concurrent.futures.wait(futures)

    print("\n🎉 所有股票数据极速落库完毕！请前往 local_db/historical_data/ 目录查看。")