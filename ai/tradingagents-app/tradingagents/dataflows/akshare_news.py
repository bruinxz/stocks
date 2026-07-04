import logging
import pandas as pd
import akshare as ak
from .akshare_common import format_ak_symbol, run_with_fallback

logger = logging.getLogger(__name__)

def get_news(symbol: str, start_date: str, end_date: str) -> str:
    """
    Get company specific news from Eastmoney.
    Fallback: stock_news_em
    """
    clean_sym = format_ak_symbol(symbol)
    
    df = run_with_fallback(
        [
            (ak.stock_news_em, [], {"symbol": clean_sym}),
        ],
        service_prefix="AKShare_News"
    )
    
    if isinstance(df, pd.DataFrame) and not df.empty:
        # Limit to the most recent 10 news items to avoid huge token usage
        # You could also filter by start_date / end_date here if `发布时间` is available
        if "发布时间" in df.columns:
            df["发布时间"] = pd.to_datetime(df["发布时间"], errors='coerce')
            mask = (df["发布时间"] >= pd.to_datetime(start_date)) & (df["发布时间"] <= pd.to_datetime(end_date) + pd.Timedelta(days=1))
            df = df.loc[mask]
            
        if not df.empty:
            return df.head(10).to_csv(index=False)
            
    return f"No news found for {symbol} between {start_date} and {end_date}."

def get_global_news(curr_date: str, look_back_days: int, limit: int) -> str:
    """
    Get macro/global news.
    Since some news APIs fail or require specific params, we fallback between 
    multiple macroeconomic news providers in AKShare.
    Fallback:
    1. news_cctv (Xinwen Lianbo)
    2. js_news (Jinshi) - if exists
    3. article_ept_feng (Dongfang Caifu macro)
    """
    # Attempt Xinwen Lianbo for the curr_date
    date_str = pd.to_datetime(curr_date).strftime("%Y%m%d")
    df = run_with_fallback(
        [
            (ak.news_cctv, [], {"date": date_str}),
        ],
        service_prefix="AKShare_GlobalNews"
    )
    
    if isinstance(df, pd.DataFrame) and not df.empty:
        return df.head(limit).to_csv(index=False)
        
    return f"No global/macro news found for {curr_date}."

def get_insider_transactions(symbol: str) -> str:
    """
    Get insider transactions (Shareholder changes).
    Fallback: stock_cgqnb_em (Eastmoney Shareholder) - though tested missing in some versions.
    Fallback to stock_zh_a_gdhs (Shareholder accounts count) as an alternative representation of insider/shareholder movement.
    """
    clean_sym = format_ak_symbol(symbol)
    
    # Not all AKShare versions have stock_cgqnb_em. 
    # Try multiple shareholder related interfaces
    df = run_with_fallback(
        [
            # Try to get major shareholders or shareholder count trends
            (ak.stock_zh_a_gdhs, [], {"symbol": clean_sym}),
        ],
        service_prefix="AKShare_Insider"
    )
    
    if isinstance(df, pd.DataFrame) and not df.empty:
        return df.head(5).to_csv(index=False)
        
    return f"No insider transactions or shareholder data found for {symbol}."
