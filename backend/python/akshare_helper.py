#!/usr/bin/env python3
"""
AKShare Python helper for Node.js integration
Provides A-share stock data through AKShare library
"""

import sys
import json
import traceback
import time
import akshare as ak
import pandas as pd
from datetime import datetime
from typing import Dict, List, Any, Optional

def parse_date(date_str: str) -> str:
    """Parse date from YYYY-MM-DD to YYYYMMDD for AKShare"""
    try:
        # AKShare usually accepts YYYYMMDD format
        return date_str.replace("-", "")
    except:
        return date_str

def get_all_stocks() -> List[Dict[str, Any]]:
    """Get all A-share stock list"""
    try:
        # Get stock list from AKShare
        stock_df = ak.stock_zh_a_spot()

        # For basic info, we need more details from another API
        stock_info_df = ak.stock_info_a_code_name()

        stocks = []
        for _, row in stock_df.iterrows():
            code = str(row['代码']) if pd.notna(row['代码']) else ''
            name = str(row['名称']) if pd.notna(row['名称']) else ''

            # 跳过无效的代码或名称
            if not code or not name or code.lower() == 'nan' or name.lower() == 'nan':
                continue

            # Try to get listing date from other sources
            # AKShare doesn't provide listing date directly in spot data
            # We'll use a default date for now
            ipo_date = "2000-01-01"

            # Map market prefix
            if code.startswith('6'):
                full_code = f"sh.{code}"
            elif code.startswith('0') or code.startswith('3'):
                full_code = f"sz.{code}"
            elif code.startswith('8') or code.startswith('4'):
                full_code = f"bj.{code}"
            else:
                full_code = code

            stocks.append({
                "code": full_code,
                "code_name": name,
                "ipoDate": ipo_date,
                "type": 1,  # stock
                "status": 1  # listed
            })

        return stocks
    except Exception as e:
        print(f"Error getting all stocks: {e}", file=sys.stderr)
        return []

def get_daily_data(code: str, start_date: str, end_date: str, adjust: str = "qfq") -> List[Dict[str, Any]]:
    """Get daily K-line data for a stock with fallback methods and retry"""
    try:
        # Convert code format: sh.000001 -> sh000001, sz.000001 -> sz000001
        # AKShare需要不带点的前缀格式
        ak_code = code
        if code.startswith('sh.'):
            ak_code = code.replace('sh.', 'sh')
        elif code.startswith('sz.'):
            ak_code = code.replace('sz.', 'sz')
        elif code.startswith('bj.'):
            ak_code = code.replace('bj.', 'bj')

        # 同时保留纯代码用于其他可能的方法
        pure_code = code
        if code.startswith('sh.') or code.startswith('sz.') or code.startswith('bj.'):
            pure_code = code.split('.')[1]

        # Convert adjust flag
        # AKShare: "qfq"=前复权, "hfq"=后复权, ""=不复权
        adjust_map = {"1": "hfq", "2": "qfq", "3": ""}
        adjust_flag = adjust_map.get(adjust, "")

        stock_df = None
        method_used = "unknown"

        # 重试配置
        max_retries = 3
        retry_delay = 5  # 秒

        # 方法1: 首先尝试 stock_zh_a_hist (主要方法)
        try:
            print(f"Trying stock_zh_a_hist for {code} (pure_code: {pure_code})...", file=sys.stderr)
            stock_df = ak.stock_zh_a_hist(
                symbol=pure_code,
                period="daily",
                start_date=parse_date(start_date),
                end_date=parse_date(end_date),
                adjust=adjust_flag
            )
            method_used = "stock_zh_a_hist"
            print(f"Successfully got data using {method_used}", file=sys.stderr)
        except Exception as e1:
            print(f"Method stock_zh_a_hist failed for {code}: {e1}", file=sys.stderr)
            # 添加延迟再尝试下一个方法
            time.sleep(2)

            # 方法2: 尝试 stock_zh_a_daily 作为兜底
            try:
                print(f"Trying stock_zh_a_daily for {code} (ak_code: {ak_code})...", file=sys.stderr)
                # stock_zh_a_daily 需要 adjust 参数: "qfq"=前复权, "hfq"=后复权, ""=不复权
                # 映射我们的 adjust 参数
                adjust_map_daily = {"1": "hfq", "2": "qfq", "3": ""}
                adjust_flag_daily = adjust_map_daily.get(adjust, "")

                stock_df = ak.stock_zh_a_daily(
                    symbol=ak_code,  # 使用转换后的代码格式
                    start_date=parse_date(start_date),
                    end_date=parse_date(end_date),
                    adjust=adjust_flag_daily
                )
                method_used = "stock_zh_a_daily"
                print(f"Successfully got data using {method_used}", file=sys.stderr)
            except Exception as e2:
                print(f"Method stock_zh_a_daily also failed for {code}: {e2}", file=sys.stderr)
                # 添加延迟再尝试下一个方法
                time.sleep(2)

                # 方法3: 尝试 stock_zh_a_hist 不带 adjust 参数
                try:
                    print(f"Trying stock_zh_a_hist without adjust for {code}...", file=sys.stderr)
                    stock_df = ak.stock_zh_a_hist(
                        symbol=pure_code,
                        period="daily",
                        start_date=parse_date(start_date),
                        end_date=parse_date(end_date)
                        # 不传 adjust 参数
                    )
                    method_used = "stock_zh_a_hist_no_adjust"
                    print(f"Successfully got data using {method_used}", file=sys.stderr)
                except Exception as e3:
                    print(f"All methods failed for {code}. Last error: {e3}", file=sys.stderr)
                    traceback.print_exc(file=sys.stderr)
                    return []

        if stock_df is None or stock_df.empty:
            print(f"No data returned for {code} using {method_used}", file=sys.stderr)
            return []

        # 处理返回的数据
        bars = []
        for _, row in stock_df.iterrows():
            try:
                # 不同的方法可能有不同的列名，尝试多种可能
                open_price = 0
                close_price = 0
                high_price = 0
                low_price = 0
                volume_shou = 0
                amount = 0
                turn_rate = 0

                # 尝试不同的列名（兼容多种AKShare接口）
                # 开盘价
                for col in ['开盘', 'open', 'Open', 'OPEN']:
                    if col in row:
                        try:
                            open_price = float(row[col])
                            break
                        except:
                            continue

                # 收盘价
                for col in ['收盘', 'close', 'Close', 'CLOSE']:
                    if col in row:
                        try:
                            close_price = float(row[col])
                            break
                        except:
                            continue

                # 最高价
                for col in ['最高', 'high', 'High', 'HIGH']:
                    if col in row:
                        try:
                            high_price = float(row[col])
                            break
                        except:
                            continue

                # 最低价
                for col in ['最低', 'low', 'Low', 'LOW']:
                    if col in row:
                        try:
                            low_price = float(row[col])
                            break
                        except:
                            continue

                # 成交量（手）
                for col in ['成交量', 'volume', 'Volume', 'VOLUME', '成交额', 'amount', 'Amount', 'AMOUNT']:
                    if col in row:
                        try:
                            val = float(row[col])
                            # 如果列名是成交额相关，可能是金额不是成交量
                            if col in ['成交额', 'amount', 'Amount', 'AMOUNT']:
                                amount = val
                            else:
                                volume_shou = val
                            break
                        except:
                            continue

                # 成交额（如果还没找到）
                if amount == 0:
                    for col in ['成交额', 'amount', 'Amount', 'AMOUNT']:
                        if col in row:
                            try:
                                amount = float(row[col])
                                break
                            except:
                                continue

                # 换手率
                for col in ['换手率', 'turn', 'Turn', 'TURN', 'turnover_rate']:
                    if col in row:
                        try:
                            turn_rate = float(row[col]) if not pd.isna(row[col]) else 0
                            break
                        except:
                            continue

                # 计算涨跌幅
                pct_chg = ((close_price - open_price) / open_price * 100) if open_price != 0 else 0

                # 转换成交量: 手 -> 股 (1手 = 100股)
                # 注意：有些接口返回的已经是股，但AKShare通常返回手
                volume_gu = volume_shou * 100

                # 获取日期
                date_str = ""
                date_val = None
                for col in ['日期', 'date', 'Date', 'DATE', 'trade_date', 'Trade_date', 'TRADE_DATE', '时间', 'time', 'Time', 'TIME']:
                    if col in row:
                        date_val = row[col]
                        break

                if date_val is None:
                    # 如果没有日期列，跳过
                    continue

                if hasattr(date_val, 'strftime'):
                    date_str = date_val.strftime("%Y-%m-%d")
                elif hasattr(date_val, 'date'):  # 可能是datetime对象
                    date_str = date_val.date().strftime("%Y-%m-%d")
                else:
                    date_str = str(date_val)
                    # 尝试清理日期字符串
                    date_str = date_str.split(' ')[0]  # 去掉时间部分

                bars.append({
                    "date": date_str,
                    "code": code,
                    "open": open_price,
                    "high": high_price,
                    "low": low_price,
                    "close": close_price,
                    "volume": volume_gu,
                    "amount": amount,
                    "adjustflag": 1 if adjust == "1" else (2 if adjust == "2" else 3),
                    "turn": turn_rate,
                    "tradestatus": 1,  # Assume normal trading
                    "pctChg": pct_chg,
                    "peTTM": 0,  # AKShare daily doesn't provide PE
                    "psTTM": 0,
                    "pcfNcfTTM": 0,
                    "pbMRQ": 0
                })
            except Exception as row_error:
                print(f"Error processing row for {code}: {row_error}", file=sys.stderr)
                continue

        print(f"Successfully processed {len(bars)} bars for {code} using {method_used}", file=sys.stderr)
        return bars
    except Exception as e:
        print(f"Error getting daily data for {code}: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        return []

def get_stock_basic(code: str) -> Optional[Dict[str, Any]]:
    """Get basic information for a stock"""
    try:
        # Extract pure code
        pure_code = code
        if code.startswith('sh.') or code.startswith('sz.') or code.startswith('bj.'):
            pure_code = code.split('.')[1]

        # Get stock basic info
        # AKShare doesn't have a direct basic info API for single stock
        # We'll use spot data as fallback
        stock_df = ak.stock_zh_a_spot()

        # Find the stock
        stock_row = stock_df[stock_df['代码'] == pure_code]
        if stock_row.empty:
            return None

        row = stock_row.iloc[0]

        return {
            "code": code,
            "code_name": row['名称'],
            "ipoDate": "2000-01-01",  # Default
            "type": 1,
            "status": 1
        }
    except Exception as e:
        print(f"Error getting stock basic for {code}: {e}", file=sys.stderr)
        return None

def main():
    """Main entry point for command line calls"""
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No command provided"}), file=sys.stderr)
        sys.exit(1)

    command = sys.argv[1]
    result = None

    try:
        if command == "get_all_stocks":
            result = get_all_stocks()

        elif command == "get_daily_data":
            if len(sys.argv) < 5:
                print(json.dumps({"error": "Missing parameters for get_daily_data"}), file=sys.stderr)
                sys.exit(1)

            code = sys.argv[2]
            start_date = sys.argv[3]
            end_date = sys.argv[4]
            adjust = sys.argv[5] if len(sys.argv) > 5 else "3"

            result = get_daily_data(code, start_date, end_date, adjust)

        elif command == "get_stock_basic":
            if len(sys.argv) < 3:
                print(json.dumps({"error": "Missing code for get_stock_basic"}), file=sys.stderr)
                sys.exit(1)

            code = sys.argv[2]
            result = get_stock_basic(code)

        else:
            print(json.dumps({"error": f"Unknown command: {command}"}), file=sys.stderr)
            sys.exit(1)

        # Output result as JSON
        print(json.dumps({"success": True, "data": result}))

    except Exception as e:
        error_msg = str(e)
        print(json.dumps({"success": False, "error": error_msg}), file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    # pandas already imported at the top
    try:
        main()
    except ImportError as e:
        print(json.dumps({"success": False, "error": f"Missing required library: {e}"}), file=sys.stderr)
        sys.exit(1)