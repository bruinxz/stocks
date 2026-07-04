import logging
import pandas as pd
import akshare as ak
from .akshare_common import format_ak_symbol, format_em_symbol, run_with_fallback

logger = logging.getLogger(__name__)

def get_fundamentals(symbol: str, curr_date: str) -> str:
    """
    Get company fundamentals (PE, PB, Market Cap)
    Fallback: 
    1. stock_zh_a_spot_em (realtime/spot info, includes PE/PB etc)
    2. stock_a_indicator_lg (Legu indicators)
    Note: Spot data is current, not strictly historical for `curr_date`, 
    but it's standard for quick fundamental overviews.
    """
    clean_sym = format_ak_symbol(symbol)
    
    # Try Eastmoney spot first
    df = run_with_fallback(
        [
            (ak.stock_zh_a_spot_em, [], {}),
        ],
        service_prefix="AKShare_Spot_EM"
    )
    if isinstance(df, pd.DataFrame) and not df.empty:
        stock_row = df[df["代码"] == clean_sym]
        if not stock_row.empty:
            return stock_row.to_csv(index=False)
            
    # Try Legu Indicator fallback
    # Not all AKShare versions have stock_a_indicator_lg. Use getattr to avoid AttributeError
    lg_func = getattr(ak, "stock_a_indicator_lg", getattr(ak, "stock_a_pe_and_pb", None))
    
    df_lg = run_with_fallback(
        [
            (lg_func, [], {"symbol": clean_sym}) if lg_func else (None, [], {}),
        ],
        service_prefix="AKShare_Indicator_LG"
    )
    if isinstance(df_lg, pd.DataFrame) and not df_lg.empty:
        # Sort by date and get latest up to curr_date
        df_lg["trade_date"] = pd.to_datetime(df_lg["trade_date"])
        df_lg = df_lg[df_lg["trade_date"] <= pd.to_datetime(curr_date)]
        if not df_lg.empty:
            return df_lg.tail(1).to_csv(index=False)

    return f"No fundamental data available for {symbol}"

def get_balance_sheet(symbol: str, freq: str, curr_date: str) -> str:
    """
    Get Balance Sheet.
    Fallback:
    1. stock_balance_sheet_by_report_em (Eastmoney)
    2. stock_financial_report_sina (Sina)
    """
    clean_sym = format_ak_symbol(symbol)
    em_sym = format_em_symbol(symbol)
    
    df = run_with_fallback(
        [
            (ak.stock_balance_sheet_by_report_em, [], {"symbol": em_sym}),
            (ak.stock_financial_report_sina, [], {"stock": clean_sym, "symbol": "资产负债表"}),
        ],
        service_prefix="AKShare_BalanceSheet"
    )
    
    if isinstance(df, pd.DataFrame) and not df.empty:
        # Just return the top 3 latest reports as CSV
        return df.head(3).to_csv(index=False)
    return f"No balance sheet data for {symbol}"

def get_cashflow(symbol: str, freq: str, curr_date: str) -> str:
    """
    Get Cash Flow Statement.
    Fallback:
    1. stock_cash_flow_sheet_by_report_em (Eastmoney)
    2. stock_financial_report_sina (Sina)
    """
    clean_sym = format_ak_symbol(symbol)
    em_sym = format_em_symbol(symbol)
    
    df = run_with_fallback(
        [
            (ak.stock_cash_flow_sheet_by_report_em, [], {"symbol": em_sym}),
            (ak.stock_financial_report_sina, [], {"stock": clean_sym, "symbol": "现金流量表"}),
        ],
        service_prefix="AKShare_CashFlow"
    )
    
    if isinstance(df, pd.DataFrame) and not df.empty:
        return df.head(3).to_csv(index=False)
    return f"No cash flow data for {symbol}"

def get_income_statement(symbol: str, freq: str, curr_date: str) -> str:
    """
    Get Income Statement.
    Fallback:
    1. stock_profit_sheet_by_report_em (Eastmoney)
    2. stock_financial_report_sina (Sina)
    """
    clean_sym = format_ak_symbol(symbol)
    em_sym = format_em_symbol(symbol)
    
    df = run_with_fallback(
        [
            (ak.stock_profit_sheet_by_report_em, [], {"symbol": em_sym}),
            (ak.stock_financial_report_sina, [], {"stock": clean_sym, "symbol": "利润表"}),
        ],
        service_prefix="AKShare_IncomeStatement"
    )
    
    if isinstance(df, pd.DataFrame) and not df.empty:
        return df.head(3).to_csv(index=False)
    return f"No income statement data for {symbol}"
