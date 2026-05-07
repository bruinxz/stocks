#!/usr/bin/env python3
"""Optional market data providers for Node.js integration.

The script keeps Baostock/Tushare optional: if a package or token is missing it
returns a structured JSON error instead of crashing the Node.js process.
"""

import json
import sys
import traceback
from datetime import datetime
from typing import Any, Dict, List, Optional


def output_success(data: Any) -> None:
    print(json.dumps({"success": True, "data": data}, ensure_ascii=False, default=str))


def output_error(error: str) -> None:
    print(json.dumps({"success": False, "error": error}, ensure_ascii=False))


def normalize_symbol(symbol: str) -> str:
    if not symbol:
        return ""
    symbol = symbol.strip()
    lower = symbol.lower()
    if lower.startswith(("sh.", "sz.", "bj.")):
        return f"{lower[:2]}.{symbol.split('.')[-1]}"
    if "." in symbol and symbol.split(".")[-1].upper() in ["SH", "SZ", "BJ"]:
        code, market = symbol.split(".")
        return f"{market.lower()}.{code}"
    if lower.startswith(("sh", "sz", "bj")) and len(symbol) >= 8:
        return f"{lower[:2]}.{symbol[2:]}"
    if symbol.isdigit():
        if symbol.startswith("6"):
            return f"sh.{symbol}"
        if symbol.startswith(("0", "3")):
            return f"sz.{symbol}"
        if symbol.startswith(("8", "4", "9")):
            return f"bj.{symbol}"
        return f"sh.{symbol}"
    return symbol


def to_baostock_code(symbol: str) -> str:
    return normalize_symbol(symbol)


def to_tushare_code(symbol: str) -> str:
    normalized = normalize_symbol(symbol)
    if "." not in normalized:
        normalized = normalize_symbol(normalized)
    market, code = normalized.split(".")
    return f"{code}.{market.upper()}"


def safe_float(value: Any, default: float = 0.0) -> float:
    try:
        if value is None or value == "" or str(value).lower() in ["nan", "none", "null"]:
            return default
        return float(value)
    except Exception:
        return default


def safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(float(value))
    except Exception:
        return default


def adjust_to_baostock(adjustflag: str) -> str:
    # baostock: 1 后复权, 2 前复权, 3 不复权
    return {"1": "1", "2": "2", "3": "3"}.get(str(adjustflag), "3")


def adjust_to_tushare(adjustflag: str) -> str:
    # tushare adj: qfq 前复权, hfq 后复权, None 不复权
    return {"1": "hfq", "2": "qfq", "3": ""}.get(str(adjustflag), "")


def frequency_to_baostock(frequency: str) -> str:
    return {"d": "d", "w": "w", "m": "m"}.get(frequency, "d")


def frequency_to_tushare(frequency: str) -> str:
    # TuShare pro_bar supports D/W/M.
    return {"d": "D", "w": "W", "m": "M"}.get(frequency, "D")


def baostock_login():
    try:
        import baostock as bs  # type: ignore
    except Exception as exc:
        raise RuntimeError(f"baostock package is not installed: {exc}")

    login_result = bs.login()
    if getattr(login_result, "error_code", "0") != "0":
        raise RuntimeError(f"baostock login failed: {getattr(login_result, 'error_msg', '')}")
    return bs


def baostock_get_all_stocks() -> List[Dict[str, Any]]:
    bs = baostock_login()
    try:
        rs = bs.query_stock_basic()
        if getattr(rs, "error_code", "0") != "0":
            raise RuntimeError(f"query_stock_basic failed: {getattr(rs, 'error_msg', '')}")
        stocks: List[Dict[str, Any]] = []
        while rs.next():
            row = rs.get_row_data()
            fields = getattr(rs, "fields", [])
            item = dict(zip(fields, row))
            code = normalize_symbol(item.get("code", ""))
            if not code:
                continue
            stocks.append(
                {
                    "code": code,
                    "code_name": item.get("code_name", ""),
                    "ipoDate": item.get("ipoDate", ""),
                    "outDate": item.get("outDate", ""),
                    "type": 1 if item.get("type") == "1" else 3,
                    "status": 1 if item.get("status") == "1" else 0,
                }
            )
        return stocks
    finally:
        bs.logout()


def baostock_get_daily_data(
    code: str, start_date: str, end_date: str, frequency: str = "d", adjustflag: str = "3"
) -> List[Dict[str, Any]]:
    bs = baostock_login()
    try:
        normalized = to_baostock_code(code)
        fields = "date,code,open,high,low,close,preclose,volume,amount,adjustflag,turn,tradestatus,pctChg,peTTM,psTTM,pcfNcfTTM,pbMRQ,isST"
        rs = bs.query_history_k_data_plus(
            normalized,
            fields,
            start_date=start_date,
            end_date=end_date,
            frequency=frequency_to_baostock(frequency),
            adjustflag=adjust_to_baostock(adjustflag),
        )
        if getattr(rs, "error_code", "0") != "0":
            raise RuntimeError(f"query_history_k_data_plus failed: {getattr(rs, 'error_msg', '')}")

        bars: List[Dict[str, Any]] = []
        while rs.next():
            item = dict(zip(getattr(rs, "fields", []), rs.get_row_data()))
            bar_date = item.get("date")
            if not bar_date:
                continue
            bars.append(
                {
                    "date": bar_date,
                    "code": normalized,
                    "open": safe_float(item.get("open")),
                    "high": safe_float(item.get("high")),
                    "low": safe_float(item.get("low")),
                    "close": safe_float(item.get("close")),
                    "volume": safe_int(item.get("volume")),
                    "amount": safe_float(item.get("amount")),
                    "adjustflag": safe_int(item.get("adjustflag"), safe_int(adjustflag, 3)),
                    "turn": safe_float(item.get("turn")),
                    "tradestatus": safe_int(item.get("tradestatus"), 1),
                    "pctChg": safe_float(item.get("pctChg")),
                    "peTTM": safe_float(item.get("peTTM")),
                    "psTTM": safe_float(item.get("psTTM")),
                    "pcfNcfTTM": safe_float(item.get("pcfNcfTTM")),
                    "pbMRQ": safe_float(item.get("pbMRQ")),
                }
            )
        bars.sort(key=lambda item: item["date"])
        return bars
    finally:
        bs.logout()


def baostock_get_stock_basic(code: str) -> Optional[Dict[str, Any]]:
    bs = baostock_login()
    try:
        normalized = to_baostock_code(code)
        rs = bs.query_stock_basic(code=normalized)
        if getattr(rs, "error_code", "0") != "0":
            raise RuntimeError(f"query_stock_basic failed: {getattr(rs, 'error_msg', '')}")
        if rs.next():
            item = dict(zip(getattr(rs, "fields", []), rs.get_row_data()))
            return {
                "code": normalize_symbol(item.get("code", normalized)),
                "code_name": item.get("code_name", ""),
                "ipoDate": item.get("ipoDate", ""),
                "outDate": item.get("outDate", ""),
                "type": 1 if item.get("type") == "1" else 3,
                "status": 1 if item.get("status") == "1" else 0,
            }
        return None
    finally:
        bs.logout()


def baostock_get_trade_dates(start_date: str, end_date: str) -> List[str]:
    bs = baostock_login()
    try:
        rs = bs.query_trade_dates(start_date=start_date, end_date=end_date)
        if getattr(rs, "error_code", "0") != "0":
            raise RuntimeError(f"query_trade_dates failed: {getattr(rs, 'error_msg', '')}")
        dates: List[str] = []
        while rs.next():
            item = dict(zip(getattr(rs, "fields", []), rs.get_row_data()))
            if item.get("is_trading_day") == "1" and item.get("calendar_date"):
                dates.append(item["calendar_date"])
        return dates
    finally:
        bs.logout()


def tushare_client(token: str):
    if not token:
        raise RuntimeError("Tushare token is empty")
    try:
        import tushare as ts  # type: ignore
    except Exception as exc:
        raise RuntimeError(f"tushare package is not installed: {exc}")
    ts.set_token(token)
    return ts.pro_api(token)


def tushare_get_all_stocks(token: str) -> List[Dict[str, Any]]:
    pro = tushare_client(token)
    df = pro.stock_basic(exchange="", list_status="L", fields="ts_code,symbol,name,area,industry,list_date")
    stocks: List[Dict[str, Any]] = []
    for _, row in df.iterrows():
        ts_code = str(row.get("ts_code", ""))
        if not ts_code:
            continue
        list_date = str(row.get("list_date", ""))
        ipo_date = ""
        if len(list_date) == 8:
            ipo_date = f"{list_date[:4]}-{list_date[4:6]}-{list_date[6:]}"
        stocks.append(
            {
                "code": normalize_symbol(ts_code),
                "code_name": str(row.get("name", "")),
                "ipoDate": ipo_date,
                "type": 1,
                "status": 1,
            }
        )
    return stocks


def tushare_get_daily_data(
    token: str, code: str, start_date: str, end_date: str, frequency: str = "d", adjustflag: str = "3"
) -> List[Dict[str, Any]]:
    try:
        import tushare as ts  # type: ignore
    except Exception as exc:
        raise RuntimeError(f"tushare package is not installed: {exc}")
    if not token:
        raise RuntimeError("Tushare token is empty")

    ts_code = to_tushare_code(code)
    adj = adjust_to_tushare(adjustflag) or None
    df = ts.pro_bar(
        ts_code=ts_code,
        adj=adj,
        freq=frequency_to_tushare(frequency),
        start_date=start_date.replace("-", ""),
        end_date=end_date.replace("-", ""),
        token=token,
    )
    if df is None or df.empty:
        return []

    bars: List[Dict[str, Any]] = []
    df = df.sort_values("trade_date")
    for _, row in df.iterrows():
        trade_date = str(row.get("trade_date", ""))
        if len(trade_date) == 8:
            date = f"{trade_date[:4]}-{trade_date[4:6]}-{trade_date[6:]}"
        else:
            date = trade_date
        close = safe_float(row.get("close"))
        pre_close = safe_float(row.get("pre_close"))
        pct_chg = safe_float(row.get("pct_chg"))
        if pct_chg == 0 and pre_close:
            pct_chg = (close - pre_close) / pre_close * 100
        bars.append(
            {
                "date": date,
                "code": normalize_symbol(ts_code),
                "open": safe_float(row.get("open")),
                "high": safe_float(row.get("high")),
                "low": safe_float(row.get("low")),
                "close": close,
                "volume": safe_float(row.get("vol")) * 100,
                "amount": safe_float(row.get("amount")) * 1000,
                "adjustflag": safe_int(adjustflag, 3),
                "turn": 0,
                "tradestatus": 1,
                "pctChg": pct_chg,
                "peTTM": 0,
                "psTTM": 0,
                "pcfNcfTTM": 0,
                "pbMRQ": 0,
            }
        )
    return bars


def tushare_get_stock_basic(token: str, code: str) -> Optional[Dict[str, Any]]:
    pro = tushare_client(token)
    ts_code = to_tushare_code(code)
    df = pro.stock_basic(ts_code=ts_code, fields="ts_code,name,list_date,industry")
    if df is None or df.empty:
        return None
    row = df.iloc[0]
    list_date = str(row.get("list_date", ""))
    ipo_date = ""
    if len(list_date) == 8:
        ipo_date = f"{list_date[:4]}-{list_date[4:6]}-{list_date[6:]}"
    return {
        "code": normalize_symbol(ts_code),
        "code_name": str(row.get("name", "")),
        "ipoDate": ipo_date,
        "type": 1,
        "status": 1,
    }


def main() -> None:
    if len(sys.argv) < 2:
        output_error("No command provided")
        return

    command = sys.argv[1]
    args = sys.argv[2:]

    try:
        if command == "baostock_get_all_stocks":
            output_success(baostock_get_all_stocks())
        elif command == "baostock_get_daily_data":
            output_success(baostock_get_daily_data(args[0], args[1], args[2], args[3], args[4]))
        elif command == "baostock_get_stock_basic":
            output_success(baostock_get_stock_basic(args[0]))
        elif command == "baostock_get_trade_dates":
            output_success(baostock_get_trade_dates(args[0], args[1]))
        elif command == "tushare_get_all_stocks":
            output_success(tushare_get_all_stocks(args[0]))
        elif command == "tushare_get_daily_data":
            output_success(tushare_get_daily_data(args[0], args[1], args[2], args[3], args[4], args[5]))
        elif command == "tushare_get_stock_basic":
            output_success(tushare_get_stock_basic(args[0], args[1]))
        else:
            output_error(f"Unknown command: {command}")
    except Exception as exc:
        traceback.print_exc(file=sys.stderr)
        output_error(str(exc))


if __name__ == "__main__":
    main()
