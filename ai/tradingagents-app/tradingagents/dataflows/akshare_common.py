import logging
import pandas as pd
from tradingagents.utils.retry_utils import execute_with_retry

logger = logging.getLogger(__name__)

def format_ak_symbol(symbol: str) -> str:
    """Format symbol to basic digits, e.g., 'sh600000' -> '600000'"""
    symbol = symbol.lower().strip()
    for prefix in ['sh', 'sz', 'bj']:
        if symbol.startswith(prefix):
            return symbol[2:]
    return symbol

def format_em_symbol(symbol: str) -> str:
    """Format symbol for Eastmoney interfaces, e.g., '600000' -> 'SH600000'"""
    s = format_ak_symbol(symbol)
    if s.startswith('6'):
        return f"SH{s}"
    elif s.startswith('0') or s.startswith('3'):
        return f"SZ{s}"
    elif s.startswith('8') or s.startswith('4'):
        return f"BJ{s}"
    return s

def run_with_fallback(funcs_with_args: list, service_prefix: str = "AKShare"):
    """
    Try a list of (func, args, kwargs) tuples sequentially until one succeeds and returns valid data.
    Implements the pluggable/downgrade requirement.
    """
    last_err = None
    for func_tuple in funcs_with_args:
        try:
            # Safely unpack the tuple even if it contains 2 or 3 elements
            if len(func_tuple) == 3:
                func, args, kwargs = func_tuple
            else:
                func, args = func_tuple
                kwargs = {}
                
            # If func is None or doesn't exist, skip
            if not func or not callable(func):
                continue

            # We wrap the underlying call with execute_with_retry to handle network instability
            def _call():
                res = func(*args, **kwargs)
                if res is None:
                    raise ValueError(f"{func.__name__} returned None")
                if isinstance(res, pd.DataFrame) and res.empty:
                    raise ValueError(f"{func.__name__} returned empty DataFrame")
                return res

            result = execute_with_retry(
                func=_call,
                exceptions=(Exception,),  # Catch all exceptions (network, JSON decode, etc.)
                max_retries=3,  # Fewer retries per endpoint so we can fallback quickly
                base_delay=2.0,
                max_delay=10.0,
                service_name=f"{service_prefix}_{func.__name__}"
            )
            return result
        except Exception as e:
            last_err = e
            logger.warning(f"Fallback triggered: {func.__name__} failed with error: {e}")
            continue
            
    # If all fallbacks fail, log the error but don't crash the pipeline, return empty string
    logger.error(f"All fallback methods failed for {service_prefix}. Last error: {last_err}")
    return f"Data unavailable due to network issues. Last error: {last_err}"
