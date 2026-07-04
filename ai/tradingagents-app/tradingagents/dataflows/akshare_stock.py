import logging
import pandas as pd
from datetime import datetime, timedelta
import akshare as ak
from .akshare_common import format_ak_symbol, run_with_fallback
from .stockstats_utils import StockstatsUtils
from .local_db_handler import get_local_db_data, normalize_local_ohlcv_columns
from tradingagents.utils.symbol_converter import SymbolConverter

logger = logging.getLogger(__name__)

def _prepare_stockstats_ohlcv(df: pd.DataFrame) -> pd.DataFrame:
    """Return clean Date/Open/High/Low/Close/Volume data for stockstats only."""
    if df is None or df.empty:
        return pd.DataFrame()

    normalized = normalize_local_ohlcv_columns(df)
    rename_map = {
        "日期": "Date",
        "开盘": "Open",
        "最高": "High",
        "最低": "Low",
        "收盘": "Close",
        "成交量": "Volume",
    }
    normalized = normalized.rename(columns={k: v for k, v in rename_map.items() if k in normalized.columns})
    core_columns = ["Date", "Open", "High", "Low", "Close", "Volume"]
    if not all(column in normalized.columns for column in core_columns):
        return pd.DataFrame()

    ohlcv = normalized[core_columns].copy()
    ohlcv = ohlcv.loc[:, ~ohlcv.columns.duplicated()]
    ohlcv["Date"] = pd.to_datetime(ohlcv["Date"], errors="coerce")
    for column in ["Open", "High", "Low", "Close", "Volume"]:
        ohlcv[column] = pd.to_numeric(ohlcv[column], errors="coerce")
    ohlcv = ohlcv.dropna(subset=["Date", "Close"])
    ohlcv[["Open", "High", "Low", "Close", "Volume"]] = (
        ohlcv[["Open", "High", "Low", "Close", "Volume"]].ffill().bfill()
    )
    return ohlcv.sort_values("Date")

def _get_akshare_kline(symbol: str, start_date: str, end_date: str) -> pd.DataFrame:
    clean_symbol = format_ak_symbol(symbol)
    
    # === 优先使用本地高维数据库 ===
    pure_symbol = SymbolConverter.to_pure_number(symbol)
    df_local = get_local_db_data(pure_symbol, start_date, end_date)
    
    if not df_local.empty:
        df_local = normalize_local_ohlcv_columns(df_local)
        # 兼容性重命名，让上层代码依然能识别 Date, Open, High, Low, Close, Volume
        # 同时保留其它高维特征如"主力净流入"供大模型分析
        rename_map = {
            "日期": "Date",
            "开盘": "Open",
            "最高": "High",
            "最低": "Low",
            "收盘": "Close",
            "成交量": "Volume"
        }
        # 仅对存在的列进行重命名
        rename_map = {k: v for k, v in rename_map.items() if k in df_local.columns}
        df_local = df_local.rename(columns=rename_map)
        return df_local

    # === 原有降级回退逻辑 (防兜底) ===
    start_ak = start_date.replace("-", "")
    end_ak = end_date.replace("-", "")
    
    # Try multiple historical data interfaces. 
    # stock_zh_a_daily requires prefix (e.g. sh603039)
    prefix_symbol = SymbolConverter.to_akshare_prefix_format(clean_symbol)
    
    df = run_with_fallback(
        [
            (ak.stock_zh_a_hist, [], {"symbol": clean_symbol, "period": "daily", "start_date": start_ak, "end_date": end_ak, "adjust": "qfq"}),
            (ak.stock_zh_a_daily, [], {"symbol": prefix_symbol, "start_date": start_ak, "end_date": end_ak, "adjust": "qfq"}),
        ],
        service_prefix="AKShare_KLine"
    )
    
    if isinstance(df, str) or df is None or df.empty:
        return pd.DataFrame()
        
    df = normalize_local_ohlcv_columns(df)

    # Check column names depending on which API succeeded
    if "日期" in df.columns:
        rename_map = {
            "日期": "Date",
            "开盘": "Open",
            "最高": "High",
            "最低": "Low",
            "收盘": "Close",
            "成交量": "Volume"
        }
        df = df.rename(columns=rename_map)
    elif "date" in df.columns:
        rename_map = {
            "date": "Date",
            "open": "Open",
            "high": "High",
            "low": "Low",
            "close": "Close",
            "volume": "Volume"
        }
        df = df.rename(columns=rename_map)
        
    # Ensure core columns exist, but DO NOT drop extra columns
    expected_cols = ["Date", "Open", "High", "Low", "Close", "Volume"]
    if all(col in df.columns for col in expected_cols):
        # We keep all columns, just ensure expected ones are there
        pass
    
    return df

def get_stock_data(symbol: str, start_date: str, end_date: str) -> str:
    """
    Get historical stock data using akshare.
    """
    df = _get_akshare_kline(symbol, start_date, end_date)
    if df.empty:
        return f"No data found for symbol {symbol}"
    return df.to_csv(index=False)

def get_indicators(symbol: str, indicators: str, curr_date: str, look_back_days: int = 30) -> str:
    """
    Calculate technical indicators for A-shares.
    Since stockstats works on standard OHLCV data, we can leverage it directly 
    by fetching the K-Line data up to curr_date.
    """
    # Convert string single indicator to list for compatibility with our internal logic
    if isinstance(indicators, str):
        indicators_list = [indicators]
    else:
        indicators_list = indicators
        
    # Fetch enough historical data (e.g. 2 years) to calculate indicators like 200 SMA
    start_date = (pd.to_datetime(curr_date) - pd.DateOffset(years=2)).strftime("%Y-%m-%d")
    df = _get_akshare_kline(symbol, start_date, curr_date)
    
    if df.empty:
        return f"Cannot calculate indicators for {symbol}, missing historical data."
        
    try:
        from stockstats import wrap
        ohlcv = _prepare_stockstats_ohlcv(df)
        if ohlcv.empty:
            return f"Cannot calculate indicators for {symbol}, missing valid OHLCV data."

        sdf = wrap(ohlcv)
        sdf["Date"] = pd.to_datetime(sdf["Date"]).dt.strftime("%Y-%m-%d")
        
        # Compute requested indicators
        computed_indicators = []
        for ind in indicators_list:
            normalized_ind = str(ind).strip().lower()
            if not normalized_ind:
                continue
            try:
                sdf[normalized_ind]
                computed_indicators.append(normalized_ind)
            except Exception as indicator_error:
                logger.warning(
                    "Unsupported or failed technical indicator %s for %s: %s",
                    normalized_ind,
                    symbol,
                    indicator_error,
                )

        if not computed_indicators:
            return (
                f"Cannot calculate requested indicators for {symbol}. "
                f"Unsupported indicators: {', '.join(map(str, indicators_list))}"
            )
            
        curr_date_str = pd.to_datetime(curr_date).strftime("%Y-%m-%d")
        # Fetch the most recent look_back_days data
        df_target = sdf[sdf["Date"] <= curr_date_str].tail(look_back_days)
        
        if not df_target.empty:
            result = df_target[["Date"] + computed_indicators]
            return f"Technical indicators (last {look_back_days} days up to {curr_date}):\n" + result.to_csv(index=False)
        else:
            return "N/A: Not enough historical data"
    except Exception as e:
        logger.error(f"Error calculating indicators: {e}")
        return f"Error calculating indicators: {e}"
