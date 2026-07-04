import requests
import pandas as pd
import logging
from typing import List, Dict, Optional, Union, Any
from tradingagents.dataflows.internal_api_config import INTERNAL_API_BASE_URL, get_internal_api_headers
from tradingagents.utils.symbol_converter import SymbolConverter

logger = logging.getLogger(__name__)


def _normalize_history_dataframe(rows: List[Dict[str, Any]]) -> pd.DataFrame:
    """Normalize backend history rows and avoid duplicate date columns.

    The stocks backend returns both ``trade_date`` and ``date`` for compatibility.
    TradingAgents uses ``trade_date`` as the index; if we keep ``date`` as a
    normal column, later ``reset_index`` + rename flows can create duplicate
    Chinese ``日期`` columns and pandas raises ``cannot assemble with duplicate
    keys`` during ``to_datetime``. Drop duplicate date aliases here while keeping
    the index name for downstream code that expects ``trade_date``.
    """
    df = pd.DataFrame(rows)
    if df.empty:
        return df

    if "trade_date" in df.columns:
        date_aliases = [col for col in ["date", "日期"] if col in df.columns]
        if date_aliases:
            df = df.drop(columns=date_aliases)
        df.set_index("trade_date", inplace=True)
        df.index = pd.to_datetime(df.index)
        df.index.name = "trade_date"

    return df

class InternalStockAPI:
    """
    Client for interacting with the internal bruinxz/stocks backend API.
    Designed for high-performance and batch operations required by TradingAgents.
    """
    
    @staticmethod
    def get_all_stocks() -> Optional[pd.DataFrame]:
        """
        Fetch the basic information of all listed stocks.
        Endpoint: GET /api/internal/stocks
        
        Returns:
            pd.DataFrame containing stock metadata (symbol, name, industry, etc.)
        """
        url = f"{INTERNAL_API_BASE_URL}/api/internal/stocks"
        try:
            response = requests.get(url, headers=get_internal_api_headers(), timeout=30)
            response.raise_for_status()
            data = response.json()
            if data.get("success") and "data" in data:
                return pd.DataFrame(data["data"])
            else:
                logger.error(f"Internal API returned failure for get_all_stocks: {data}")
                return None
        except Exception as e:
            logger.error(f"Failed to fetch all stocks from internal API: {e}")
            return None

    @staticmethod
    def get_historical_data(symbol: str, start_date: str = None, end_date: str = None) -> Optional[pd.DataFrame]:
        """
        Fetch historical daily bar data for a single stock.
        Endpoint: GET /api/internal/data/history
        
        Args:
            symbol (str): Stock code (e.g. 'sh.600000', or '600000')
            start_date (str, optional): Start date in YYYY-MM-DD
            end_date (str, optional): End date in YYYY-MM-DD
            
        Returns:
            pd.DataFrame with 'trade_date' as index, or None on failure.
        """
        formatted_symbol = SymbolConverter.to_internal_api_format(symbol)
        
        url = f"{INTERNAL_API_BASE_URL}/api/internal/data/history"
        params = {"symbol": formatted_symbol}
        if start_date:
            params["start_date"] = start_date
        if end_date:
            params["end_date"] = end_date
            
        try:
            response = requests.get(url, headers=get_internal_api_headers(), params=params, timeout=30)
            response.raise_for_status()
            data = response.json()
            
            if data.get("success") and "data" in data and len(data["data"]) > 0:
                return _normalize_history_dataframe(data["data"])
            else:
                logger.warning(f"Internal API returned empty or failure for get_historical_data({symbol}): {data.get('message', 'No data')}")
                return None
        except Exception as e:
            logger.error(f"Failed to fetch historical data from internal API for {symbol}: {e}")
            return None

    @staticmethod
    def get_realtime_quotes(symbols: Union[str, List[str]]) -> Dict[str, Any]:
        """
        批量极速切片接口，获取股票的实时盘口数据。
        Endpoint: GET /api/internal/data/quotes
        
        Args:
            symbols: 单个股票代码或股票代码列表（最多 50 只）
            
        Returns:
            包含各股票实时行情数据的字典
        """
        if not symbols:
            return {}
            
        if isinstance(symbols, str):
            symbols = [symbols]
            
        if len(symbols) > 50:
            logger.warning(f"Requested {len(symbols)} symbols for realtime quotes. Limiting to 50.")
            symbols = symbols[:50]
            
        formatted_symbols = [SymbolConverter.to_internal_api_format(s) for s in symbols]
        symbols_str = ",".join(formatted_symbols)
        
        url = f"{INTERNAL_API_BASE_URL}/api/internal/data/quotes"
        params = {"symbols": symbols_str}
        
        try:
            response = requests.get(url, headers=get_internal_api_headers(), params=params, timeout=10)
            response.raise_for_status()
            data = response.json()
            
            if data.get("success") and "data" in data:
                # 把带有前缀的 key 换回原始纯数字，方便系统其他部分使用
                result = {}
                for orig_sym, fmt_sym in zip(symbols, formatted_symbols):
                    if fmt_sym in data["data"]:
                        result[orig_sym] = data["data"][fmt_sym]
                return result
            else:
                logger.warning(f"Internal API returned failure for realtime quotes: {data}")
                return {}
        except Exception as e:
            logger.error(f"Failed to fetch realtime quotes from internal API: {e}")
            return {}

    @staticmethod
    def get_batch_historical_data(symbols: List[str], start_date: str = None, end_date: str = None) -> Dict[str, pd.DataFrame]:
        """
        Fetch historical daily bar data for multiple stocks in a single request.
        Endpoint: POST /api/internal/data/batch-history
        Maximum 50 symbols per batch request.
        
        Args:
            symbols (List[str]): List of stock codes
            start_date (str, optional): Start date in YYYY-MM-DD
            end_date (str, optional): End date in YYYY-MM-DD
            
        Returns:
            Dict mapping each original symbol to its pd.DataFrame
        """
        if not symbols:
            return {}
            
        if len(symbols) > 50:
            logger.warning(f"Requested {len(symbols)} symbols. Internal API limits to 50. Batching requests.")
            result_dict = {}
            for i in range(0, len(symbols), 50):
                batch_symbols = symbols[i:i+50]
                batch_result = InternalStockAPI.get_batch_historical_data(batch_symbols, start_date, end_date)
                result_dict.update(batch_result)
            return result_dict
            
        formatted_symbols = [SymbolConverter.to_internal_api_format(s) for s in symbols]
        
        url = f"{INTERNAL_API_BASE_URL}/api/internal/data/batch-history"
        payload = {"symbols": formatted_symbols}
        if start_date:
            payload["start_date"] = start_date
        if end_date:
            payload["end_date"] = end_date
            
        try:
            response = requests.post(url, headers=get_internal_api_headers(), json=payload, timeout=60)
            response.raise_for_status()
            data = response.json()
            
            result_dfs = {}
            if data.get("success") and "data" in data:
                grouped_data = data["data"]
                for orig_sym, fmt_sym in zip(symbols, formatted_symbols):
                    if fmt_sym in grouped_data and len(grouped_data[fmt_sym]) > 0:
                        result_dfs[orig_sym] = _normalize_history_dataframe(grouped_data[fmt_sym])
            return result_dfs
        except Exception as e:
            logger.error(f"Failed to fetch batch historical data from internal API: {e}")
            return {}

    @staticmethod
    def get_realtime_quotes(symbols: Union[str, List[str]]) -> Dict[str, Any]:
        """
        批量极速切片接口，获取股票的实时盘口数据。
        Endpoint: GET /api/internal/data/quotes
        
        Args:
            symbols: 单个股票代码或股票代码列表（最多 50 只）
            
        Returns:
            包含各股票实时行情数据的字典
        """
        if not symbols:
            return {}
            
        if isinstance(symbols, str):
            symbols = [symbols]
            
        if len(symbols) > 50:
            logger.warning(f"Requested {len(symbols)} symbols for realtime quotes. Limiting to 50.")
            symbols = symbols[:50]
            
        formatted_symbols = [SymbolConverter.to_internal_api_format(s) for s in symbols]
        symbols_str = ",".join(formatted_symbols)
        
        url = f"{INTERNAL_API_BASE_URL}/api/internal/data/quotes"
        params = {"symbols": symbols_str}
        
        try:
            response = requests.get(url, headers=get_internal_api_headers(), params=params, timeout=10)
            response.raise_for_status()
            data = response.json()
            
            if data.get("success") and "data" in data:
                result = {}
                for orig_sym, fmt_sym in zip(symbols, formatted_symbols):
                    if fmt_sym in data["data"]:
                        result[orig_sym] = data["data"][fmt_sym]
                return result
            else:
                logger.warning(f"Internal API returned failure for realtime quotes: {data}")
                return {}
        except Exception as e:
            logger.error(f"Failed to fetch realtime quotes from internal API: {e}")
            return {}

    @staticmethod
    def get_intraday_data(symbol: str, period: str = "1m", limit: int = 240) -> Optional[pd.DataFrame]:
        """
        获取日内分时 K 线数据。
        Endpoint: GET /api/internal/data/intraday
        
        Args:
            symbol: 股票代码
            period: K线周期，可选: 1m, 5m, 15m, 30m, 60m
            limit: 返回最近的N根K线，默认 240
            
        Returns:
            包含分时数据的 pd.DataFrame
        """
        formatted_symbol = SymbolConverter.to_internal_api_format(symbol)
        
        url = f"{INTERNAL_API_BASE_URL}/api/internal/data/intraday"
        params = {
            "symbol": formatted_symbol,
            "period": period,
            "limit": limit
        }
        
        try:
            response = requests.get(url, headers=get_internal_api_headers(), params=params, timeout=15)
            response.raise_for_status()
            data = response.json()
            
            if data.get("success") and "data" in data and len(data["data"]) > 0:
                df = pd.DataFrame(data["data"])
                if "time" in df.columns:
                    df.set_index("time", inplace=True)
                    df.index = pd.to_datetime(df.index)
                return df
            else:
                logger.warning(f"Internal API returned empty or failure for intraday({symbol}): {data}")
                return None
        except Exception as e:
            logger.error(f"Failed to fetch intraday data from internal API for {symbol}: {e}")
            return None
