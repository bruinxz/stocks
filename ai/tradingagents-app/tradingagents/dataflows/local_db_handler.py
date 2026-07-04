import os
import glob
import pandas as pd
from datetime import datetime
import akshare as ak
import time
import threading
from tradingagents.dataflows.internal_api import InternalStockAPI
from tradingagents.utils.symbol_converter import SymbolConverter

DB_DIR = "local_db/historical_data"
os.makedirs(DB_DIR, exist_ok=True)

_SYMBOL_FILE_LOCKS = {}
_SYMBOL_FILE_LOCKS_GUARD = threading.Lock()

LOCAL_CANONICAL_ALIAS_GROUPS = {
    "日期": ["日期", "Date", "date", "trade_date"],
    "开盘": ["开盘", "Open", "open"],
    "最高": ["最高", "High", "high"],
    "最低": ["最低", "Low", "low"],
    "收盘": ["收盘", "Close", "close"],
    "成交量": ["成交量", "Volume", "volume", "vol"],
    "成交额": ["成交额", "Amount", "amount"],
    "涨跌幅": ["涨跌幅", "pct_chg", "change_percent"],
}

def normalize_local_ohlcv_columns(df: pd.DataFrame) -> pd.DataFrame:
    """Coalesce duplicated OHLCV/date aliases into local Chinese canonical columns.

    Internal API, AKShare and historical cache files may contain both English
    aliases (open/close/volume) and Chinese columns (开盘/收盘/成交量). Keeping both
    later leaks duplicate lowercase columns into stockstats, causing errors such
    as "Expected a single column, got 2". This normalizer preserves high
    dimensional non-price features while ensuring each core OHLCV field exists
    only once.
    """
    if df is None or df.empty:
        return df

    normalized = df.copy()
    normalized.columns = [str(column).strip().lstrip("\ufeff") for column in normalized.columns]
    normalized = normalized.loc[:, ~normalized.columns.duplicated()]

    for canonical, aliases in LOCAL_CANONICAL_ALIAS_GROUPS.items():
        merged = None
        for column in aliases:
            if column not in normalized.columns:
                continue
            values = normalized[column]
            if isinstance(values, pd.DataFrame):
                values = values.bfill(axis=1).iloc[:, 0]
            merged = values if merged is None else merged.combine_first(values)

        if merged is not None:
            normalized[canonical] = merged

        drop_columns = [
            column
            for column in aliases
            if column != canonical and column in normalized.columns
        ]
        if drop_columns:
            normalized = normalized.drop(columns=drop_columns)

    preferred_order = [
        "股票代码", "股票名称", "日期", "开盘", "最高", "最低", "收盘", "成交量", "成交额", "涨跌幅"
    ]
    ordered_columns = [column for column in preferred_order if column in normalized.columns]
    ordered_columns += [column for column in normalized.columns if column not in ordered_columns]
    return normalized[ordered_columns]

def _get_symbol_file_lock(symbol: str) -> threading.RLock:
    """Return a process-local per-symbol lock for CSV cache reads/writes.

    LangGraph can execute multiple tool calls for the same ticker in parallel.
    Without a per-symbol lock, one thread may read a CSV while another thread is
    writing it and end up with a partially parsed dataframe that does not contain
    ``日期``. That intermittent state previously bubbled up as ``KeyError:
    '日期'`` and failed the whole TradingAgents task.
    """
    with _SYMBOL_FILE_LOCKS_GUARD:
        lock = _SYMBOL_FILE_LOCKS.get(symbol)
        if lock is None:
            lock = threading.RLock()
            _SYMBOL_FILE_LOCKS[symbol] = lock
        return lock

def _atomic_to_csv(df: pd.DataFrame, file_path: str):
    os.makedirs(os.path.dirname(file_path), exist_ok=True)
    tmp_path = f"{file_path}.tmp.{os.getpid()}.{threading.get_ident()}"
    try:
        df.to_csv(tmp_path, index=False, encoding='utf-8-sig')
        os.replace(tmp_path, file_path)
    finally:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass

def _ensure_date_column(df: pd.DataFrame, context: str = "") -> pd.DataFrame:
    """Normalize and validate local OHLCV-like data with a canonical 日期 column."""
    if df is None or df.empty:
        return pd.DataFrame()

    normalized = normalize_local_ohlcv_columns(df)
    if normalized is None or normalized.empty or "日期" not in normalized.columns:
        prefix = f"{context} " if context else ""
        try:
            columns = list(df.columns)
        except Exception:
            columns = []
        print(f"⚠️ {prefix}缺少日期字段，已忽略该数据片段。columns={columns[:12]}")
        return pd.DataFrame()

    normalized["日期"] = pd.to_datetime(normalized["日期"], errors="coerce").dt.strftime('%Y-%m-%d')
    normalized = normalized.dropna(subset=["日期"])
    return normalized

def fetch_with_retry(func, *args, **kwargs):
    for attempt in range(3):
        try:
            time.sleep(1)
            df = func(*args, **kwargs)
            return df
        except Exception as e:
            time.sleep(3)
    return pd.DataFrame()

def fetch_and_merge_stock_data(code, name, start_date_str, end_date_str):
    """
    拉取指定日期范围的多维度数据，用于补充本地数据库。
    """
    prefixed_code = SymbolConverter.to_akshare_prefix_format(code)
    
    # ---------- [维度 A]: 基础历史行情 ----------
    df_price = pd.DataFrame()
    
    # 1. 优先尝试 InternalStockAPI
    start_dt_fmt = pd.to_datetime(start_date_str).strftime('%Y-%m-%d')
    end_dt_fmt = pd.to_datetime(end_date_str).strftime('%Y-%m-%d')
    
    df_internal = InternalStockAPI.get_historical_data(code, start_date=start_dt_fmt, end_date=end_dt_fmt)
    if df_internal is not None and not df_internal.empty:
        df_price = df_internal.reset_index()
        # Internal API 默认把 index 设为 trade_date
        if "trade_date" in df_price.columns:
            df_price = df_price.rename(columns={"trade_date": "日期"})
            
        # 兼容处理字段名，将 internal API 的字段名映射到中文，以匹配后续代码
        rename_map = {
            "open": "开盘", "close": "收盘", "high": "最高", "low": "最低",
            "volume": "成交量", "vol": "成交量", "amount": "成交额", "pct_chg": "涨跌幅"
        }
        df_price = df_price.rename(columns=rename_map)
        df_price = normalize_local_ohlcv_columns(df_price)
        print(f"⚡ {name} ({code}) 成功通过 InternalStockAPI 极速获取行情数据")
    else:
        # 2. 如果 Internal API 没有数据（比如是特殊的 ETF 或者接口没开），降级到 akshare
        print(f"⚠️ {name} ({code}) InternalStockAPI 未返回数据，降级使用 akshare...")
        df_price = fetch_with_retry(ak.stock_zh_a_hist, symbol=code, period="daily", start_date=start_date_str, end_date=end_date_str, adjust="qfq")
        if df_price.empty:
            df_price = fetch_with_retry(ak.stock_zh_a_daily, symbol=prefixed_code, start_date=start_date_str, end_date=end_date_str, adjust="qfq")
            if df_price.empty:
                df_price = fetch_with_retry(ak.fund_etf_hist_em, symbol=code, period="daily", start_date=start_date_str, end_date=end_date_str, adjust="qfq")
                if df_price.empty:
                    df_price = fetch_with_retry(ak.fund_etf_hist_sina, symbol=prefixed_code)
                    if df_price.empty:
                        return pd.DataFrame()

    if "date" in df_price.columns:
        df_price = df_price.rename(columns={"date": "日期"})
    df_price = _ensure_date_column(df_price, f"{code} 基础行情")
    if df_price.empty:
        return pd.DataFrame()
    
    # ---------- [维度 B]: 资金流向 ----------
    df_fund = pd.DataFrame()
    if hasattr(ak, 'stock_individual_fund_flow_hist'):
        df_fund = fetch_with_retry(ak.stock_individual_fund_flow_hist, symbol=code)
        if not df_fund.empty:
            df_fund = _ensure_date_column(df_fund, f"{code} 资金流")
        if not df_fund.empty and '日期' in df_fund.columns:
            df_fund = df_fund[(df_fund['日期'] >= start_dt_fmt) & (df_fund['日期'] <= end_dt_fmt)]
            cols_to_drop = [col for col in ['收盘价', '涨跌幅'] if col in df_fund.columns]
            df_fund = df_fund.drop(columns=cols_to_drop)
            
    # ---------- [维度 C]: 估值指标 ----------
    df_val = pd.DataFrame()
    if hasattr(ak, 'stock_a_indicator_lg'):
        df_val = fetch_with_retry(ak.stock_a_indicator_lg, symbol=prefixed_code)
        if not df_val.empty:
            if 'trade_date' in df_val.columns:
                df_val['日期'] = df_val['trade_date']
            df_val = _ensure_date_column(df_val, f"{code} 估值指标")
        if not df_val.empty and '日期' in df_val.columns:
            df_val = df_val[(df_val['日期'] >= start_dt_fmt) & (df_val['日期'] <= end_dt_fmt)]
            df_val = df_val.drop(columns=['trade_date'], errors='ignore')
            
    # ---------- 数据组装 ----------
    df_final = df_price
    if not df_fund.empty and len(df_fund.columns) > 1:
        df_final = pd.merge(df_final, df_fund, on='日期', how='left')
    if not df_val.empty and len(df_val.columns) > 1:
        df_final = pd.merge(df_final, df_val, on='日期', how='left')
        
    df_final = _ensure_date_column(df_final, f"{code} 合并结果")
    if df_final.empty:
        return pd.DataFrame()
    df_final = df_final.drop(columns=[col for col in ['股票代码', '股票名称'] if col in df_final.columns])
    df_final.insert(0, '股票代码', code)
    df_final.insert(1, '股票名称', name)
    return df_final

def get_local_db_data(symbol: str, start_date: str, end_date: str) -> pd.DataFrame:
    """
    优先从本地数据库获取数据，如果日期不满足，则调用接口拉取补充并保存。
    """
    with _get_symbol_file_lock(symbol):
        return _get_local_db_data_locked(symbol, start_date, end_date)

def _get_local_db_data_locked(symbol: str, start_date: str, end_date: str) -> pd.DataFrame:
    files = glob.glob(os.path.join(DB_DIR, f"{symbol}_*.csv"))
    name = "Unknown"
    df_local = pd.DataFrame()
    file_path = ""
    
    if files:
        file_path = files[0]
        # 提取文件名中的股票名称（假设格式是 603039_泛微网络.csv）
        try:
            name = os.path.basename(file_path).split('_')[1].replace('.csv', '')
        except IndexError:
            pass
        try:
            df_local = pd.read_csv(file_path)
            original_columns = list(df_local.columns)
            df_local = _ensure_date_column(df_local, f"{symbol} 本地缓存")
            if not df_local.empty:
                df_local = df_local.sort_values('日期')
                if original_columns != list(df_local.columns):
                    _atomic_to_csv(df_local, file_path)
        except Exception as e:
            print(f"⚠️ 读取 {symbol} 本地缓存失败，转为接口重建: {e}")
            df_local = pd.DataFrame()
    else:
        file_path = os.path.join(DB_DIR, f"{symbol}_Unknown.csv")
        
    start_dt_str = pd.to_datetime(start_date).strftime('%Y-%m-%d')
    end_dt_str = pd.to_datetime(end_date).strftime('%Y-%m-%d')
    
    needs_fetch = False
    
    if df_local.empty or "日期" not in df_local.columns:
        needs_fetch = True
    else:
        db_start = df_local['日期'].min()
        db_end = df_local['日期'].max()
        
        if start_dt_str < db_start:
            needs_fetch = True
        elif end_dt_str > db_end:
            end_gap_days = (pd.to_datetime(end_dt_str) - pd.to_datetime(db_end)).days
            today_str = pd.Timestamp.now(tz='Asia/Shanghai').strftime('%Y-%m-%d')
            # For live analysis the requested end date is often today, while the
            # latest daily bar is the previous trading day (weekend/holiday/not
            # closed yet). Re-fetching the same range for every indicator/news
            # tool call does not create new bars and slows the multi-agent run.
            # If the cache already reaches a recent trading day, reuse it.
            if end_dt_str >= today_str and end_gap_days <= 7:
                print(
                    f"ℹ️ {symbol} 本地数据最新至 {db_end}，请求结束日 {end_dt_str} 尚无更新K线，复用最近交易日缓存。"
                )
            else:
                needs_fetch = True
            
    if needs_fetch:
        print(f"🔄 发现本地数据库 {symbol} 缺失 {start_dt_str} 到 {end_dt_str} 的数据，正在调用接口拉取补充...")
        # 扩大拉取范围：如果本地有数据，则结合本地极值和请求范围，一次性拉取缺失时间段
        fetch_start_dt = min(start_dt_str, db_start) if not df_local.empty else start_dt_str
        fetch_end_dt = max(end_dt_str, db_end) if not df_local.empty else end_dt_str
        
        df_new = fetch_and_merge_stock_data(
            code=symbol, 
            name=name, 
            start_date_str=pd.to_datetime(fetch_start_dt).strftime('%Y%m%d'), 
            end_date_str=pd.to_datetime(fetch_end_dt).strftime('%Y%m%d')
        )
        if not df_new.empty:
            df_new = _ensure_date_column(df_new, f"{symbol} 接口补充")
        if not df_new.empty:
            if not df_local.empty:
                df_local = pd.concat([df_local, df_new], ignore_index=True)
                df_local = _ensure_date_column(df_local, f"{symbol} 合并缓存")
                df_local = df_local.drop_duplicates(subset=['日期'], keep='last')
                df_local = df_local.sort_values('日期')
            else:
                df_local = _ensure_date_column(df_new, f"{symbol} 新缓存")
                
            # 保存回本地
            _atomic_to_csv(df_local, file_path)
            print(f"✅ {symbol} 数据库已补充更新！")
        else:
            print(f"❌ {symbol} 接口拉取补充失败。")
            
    # 最后过滤所需日期并返回
    if not df_local.empty and "日期" in df_local.columns:
        mask = (df_local['日期'] >= start_dt_str) & (df_local['日期'] <= end_dt_str)
        df_result = df_local[mask].copy()
        return df_result
        
    return pd.DataFrame()
