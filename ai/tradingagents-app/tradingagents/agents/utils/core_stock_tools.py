from typing import Annotated, Dict, Any, Optional
import pandas as pd
from langchain_core.tools import tool
from tradingagents.dataflows.interface import route_to_vendor


@tool
def get_stock_data(
    ticker: Annotated[str, "ticker symbol of the company"],
    start_date: Annotated[str, "start date for historical data"],
    end_date: Annotated[str, "end date for historical data"],
) -> str:
    """
    Retrieve historical OHLCV (Open, High, Low, Close, Volume) data for a given ticker symbol.
    """
    return route_to_vendor("get_stock_data", ticker, start_date, end_date)

@tool
def get_realtime_quotes(
    ticker: Annotated[str, "ticker symbol of the company"],
) -> str:
    """
    Retrieve real-time intraday quotes (current price, change percent, turnover, today's high/low) for a given ticker symbol.
    Use this tool to understand the stock's performance TODAY, which helps in making immediate trading decisions.
    """
    result = route_to_vendor("get_realtime_quotes", ticker)
    if result and ticker in result:
        data = result[ticker]
        return (f"Real-time Quote for {ticker}:\n"
                f"- Current Price: {data.get('current_price')}\n"
                f"- Change Percent: {data.get('change_percent')}%\n"
                f"- Turnover: {data.get('turnover')}\n"
                f"- Today's Open: {data.get('open')}\n"
                f"- Today's High: {data.get('high')}\n"
                f"- Today's Low: {data.get('low')}\n"
                f"- Time: {data.get('timestamp')}")
    return f"Failed to get real-time quote for {ticker}."

@tool
def get_intraday_data(
    ticker: Annotated[str, "ticker symbol of the company"],
    period: Annotated[str, "time period for bars, e.g. '1m', '5m', '15m', '30m', '60m'"] = "5m",
) -> str:
    """
    Retrieve intraday minute-level K-line data for a given ticker symbol.
    Use this tool to analyze short-term intraday trends.
    """
    df = route_to_vendor("get_intraday_data", ticker, period=period)
    if df is not None and not df.empty:
        # Return the last 10 intraday bars to avoid token limit overflow
        last_bars = df.tail(10)
        return f"Intraday {period} bars for {ticker} (Last 10 bars):\n" + last_bars.to_string()
    return f"Failed to get intraday data for {ticker}."
