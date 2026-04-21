#!/usr/bin/env python3
"""
AKShare Python helper for Node.js integration
Provides A-share stock data through AKShare library
"""

import sys
import json
import traceback
import time
import os
import random
import requests
import threading
import urllib.request
import akshare as ak
import pandas as pd
from datetime import datetime
from typing import Dict, List, Any, Optional

class QingguoProxyManager:
    """青果网络 API 代理管理器"""
    def __init__(self, api_url: str):
        self.api_url = api_url
        self.proxies: List[str] = []
        self.lock = threading.Lock()
        self.last_fetch_time = 0
        self.min_interval = 10  # 限制请求频率，防止 API 被封

    def fetch_proxies(self):
        """从青果网络 API 提取新的 IP 列表"""
        now = time.time()
        if now - self.last_fetch_time < self.min_interval:
            print("Skipping proxy fetch due to rate limit.", file=sys.stderr)
            return

        try:
            print(f"Fetching proxies from Qingguo API...", file=sys.stderr)
            req = urllib.request.Request(self.api_url)
            with urllib.request.urlopen(req, timeout=10) as resp:
                status_code = resp.getcode()
                text = resp.read().decode('utf-8').strip()
                
            if status_code == 200:
                # 如果返回了错误信息，例如包含 FAILED_OPERATION 或 code:
                if "提取失败" in text or "FAILED" in text.upper():
                    print(f"Qingguo API returned error: {text}", file=sys.stderr)
                    return
                
                # 青果网络通常返回每行一个 IP:Port
                lines = text.split('\n')
                new_proxies = []
                for line in lines:
                    line = line.strip()
                    if line and ':' in line:
                        new_proxies.append(f"http://{line}")
                
                with self.lock:
                    self.proxies.extend(new_proxies)
                    # 去重并限制池大小
                    self.proxies = list(set(self.proxies))[-50:]
                    self.last_fetch_time = now
                
                print(f"Successfully fetched {len(new_proxies)} proxies from Qingguo. Pool size: {len(self.proxies)}", file=sys.stderr)
            else:
                print(f"Qingguo API request failed with status {status_code}", file=sys.stderr)
        except Exception as e:
            print(f"Failed to fetch proxies from Qingguo API: {e}", file=sys.stderr)

    def get_proxy(self) -> Optional[str]:
        """获取一个随机代理"""
        with self.lock:
            if not self.proxies:
                pass # 释放锁去抓取
                
        if not self.proxies:
            self.fetch_proxies()

        with self.lock:
            if self.proxies:
                return random.choice(self.proxies)
            return None

    def remove_proxy(self, proxy: str):
        """移除失效的代理"""
        with self.lock:
            if proxy in self.proxies:
                self.proxies.remove(proxy)
                print(f"Removed dead proxy: {proxy}. Remaining: {len(self.proxies)}", file=sys.stderr)

# 初始化青果代理管理器
QINGGUO_API_URL = "https://share.proxy.qg.net/get?key=AB85550D&num=15&area=&isp=0&format=txt&seq=\\r\\n&distinct=false"
proxy_manager = QingguoProxyManager(QINGGUO_API_URL)

# 当前正在使用的代理
_current_proxy = None

def update_proxy(force_new=False):
    """更新代理，优先使用青果网络"""
    global _current_proxy
    
    # 优先从青果网络获取
    new_proxy = proxy_manager.get_proxy()
    
    if new_proxy:
        _current_proxy = new_proxy
        os.environ["http_proxy"] = new_proxy
        os.environ["https_proxy"] = new_proxy
        print(f"Using Qingguo proxy: {new_proxy}", file=sys.stderr)
        return True
        
    return False

def clear_proxy():
    """清除代理设置，回退到直连"""
    global _current_proxy
    if "http_proxy" in os.environ:
        del os.environ["http_proxy"]
    if "https_proxy" in os.environ:
        del os.environ["https_proxy"]
    _current_proxy = None
    print("Cleared proxy settings, using direct connection.", file=sys.stderr)

def report_proxy_failure():
    """当代理请求失败时，剔除失效IP"""
    global _current_proxy
    if _current_proxy:
        proxy_manager.remove_proxy(_current_proxy)
    clear_proxy()

# --- Requests 全局猴子补丁，实现代理透明重试 ---
_original_request = requests.Session.request

def _patched_request(self, method, url, **kwargs):
    max_retries = 3
    last_err = None
    for attempt in range(max_retries):
        try:
            # 确保每次请求都有较合理的超时时间，防止死锁
            if 'timeout' not in kwargs:
                kwargs['timeout'] = 10
            
            resp = _original_request(self, method, url, **kwargs)
            # 如果请求成功，直接返回
            if resp.status_code == 200:
                return resp
            # 如果是4xx/5xx错误，可能也是被封禁，当做异常处理
            if resp.status_code in [403, 429, 502, 503, 504]:
                raise requests.exceptions.HTTPError(f"HTTP {resp.status_code}")
            return resp
        except (requests.exceptions.ConnectionError, requests.exceptions.Timeout, requests.exceptions.HTTPError) as e:
            last_err = e
            print(f"[Requests Patch] Request to {url} failed: {e}. Attempt {attempt+1}/{max_retries}", file=sys.stderr)
            # 如果是代理问题，触发更换代理
            report_proxy_failure()
            has_proxy = update_proxy()
            if not has_proxy:
                clear_proxy()
            # 设置新的 proxies 给当前的请求
            if "http_proxy" in os.environ:
                kwargs['proxies'] = {
                    'http': os.environ["http_proxy"],
                    'https': os.environ["https_proxy"]
                }
            elif 'proxies' in kwargs:
                del kwargs['proxies']
                
            time.sleep(1)
            
    # 如果所有重试都失败了，抛出最后的异常
    raise last_err

requests.Session.request = _patched_request
# --------------------------------------------------

def parse_date(date_str: str) -> str:
    """Parse date from YYYY-MM-DD to YYYYMMDD for AKShare"""
    try:
        # AKShare usually accepts YYYYMMDD format
        return date_str.replace("-", "")
    except:
        return date_str

def get_all_stocks() -> List[Dict[str, Any]]:
    """Get all A-share stock list with valuation snapshot"""
    try:
        # Get stock list from AKShare
        # stock_zh_a_spot_em returns real-time market data
        
        # 增加重试机制，防止 socket hang up
        max_retries = 3
        retry_count = 0
        stock_df = None
        
        while retry_count < max_retries:
            try:
                # 在第2次及以后的重试中，尝试换个免费代理
                if retry_count > 0:
                    print("Connection failed, trying to switch proxy...", file=sys.stderr)
                    has_proxy = update_proxy()
                    if not has_proxy:
                        print("No proxy available, using direct connection...", file=sys.stderr)
                        clear_proxy()
                else:
                    # 第一次请求优先直连，最快最稳定
                    clear_proxy()

                print(f"Fetching stock_zh_a_spot_em... (Attempt {retry_count + 1}/{max_retries})", file=sys.stderr)
                stock_df = ak.stock_zh_a_spot_em()
                if stock_df is not None and not stock_df.empty:
                    print("Successfully fetched stock list.", file=sys.stderr)
                    break
            except Exception as req_err:
                print(f"Request failed: {req_err}", file=sys.stderr)
                report_proxy_failure()
                retry_count += 1
                if retry_count < max_retries:
                    time.sleep(2)  # 等待 2 秒后重试
                else:
                    # 最后一次如果代理也失败了，抛出异常
                    raise Exception(f"Failed after {max_retries} attempts. Last error: {req_err}")

        if stock_df is None or stock_df.empty:
            raise Exception("Received empty dataframe from AKShare")

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

            # 提取实时维度 (可能存在 '-' 或 nan，需要做安全转换)
            def safe_float(val):
                try:
                    if pd.isna(val) or val == '-':
                        return 0.0
                    return float(val)
                except:
                    return 0.0

            stocks.append({
                "code": full_code,
                "code_name": name,
                "ipoDate": ipo_date,
                "type": 1,  # stock
                "status": 1,  # listed
                "totalMarketCap": safe_float(row.get('总市值')),
                "circulatingMarketCap": safe_float(row.get('流通市值')),
                "peDynamic": safe_float(row.get('市盈率-动态')),
                "pb": safe_float(row.get('市净率')),
                "turnoverRate": safe_float(row.get('换手率')),
                "price": safe_float(row.get('最新价')),
                "changePercent": safe_float(row.get('涨跌幅')),
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

        # 方法0: 如果是北交所股票，优先使用 stock_zh_a_hist 兼容性较好，但有时也需要使用北交所特定接口
        # 目前北交所大部分股票已经整合到 stock_zh_a_hist，如果失败，后面会自动 fallback

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
            
            # 尝试获取历史估值指标 (市盈率、市净率、总市值、流通市值)
            try:
                print(f"Trying to fetch historical indicators for {code}...", file=sys.stderr)
                indicator_df = ak.stock_a_indicator_lg(symbol=pure_code)
                if indicator_df is not None and not indicator_df.empty:
                    # 确保日期列类型一致以便合并
                    if 'trade_date' in indicator_df.columns:
                        indicator_df['trade_date'] = pd.to_datetime(indicator_df['trade_date'])
                        # 重命名以便稍后使用
                        indicator_dict = indicator_df.set_index('trade_date').to_dict('index')
                        print(f"Successfully got indicators for {code}", file=sys.stderr)
                    else:
                        indicator_dict = {}
                else:
                    indicator_dict = {}
            except Exception as ind_err:
                print(f"Warning: Failed to fetch indicators for {code}: {ind_err}", file=sys.stderr)
                indicator_dict = {}
                
        except Exception as e1:
            print(f"Method stock_zh_a_hist failed for {code}: {e1}", file=sys.stderr)
            report_proxy_failure()
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
                report_proxy_failure()
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
                    print(f"Method stock_zh_a_hist without adjust failed for {code}: {e3}", file=sys.stderr)
                    
                    # 方法4: 针对北交所的特别兜底 (AKShare 中有 stock_bj_a_hist 或使用腾讯接口)
                    if code.startswith('bj.'):
                        try:
                            print(f"Trying stock_zh_a_hist using bj_a for {code}...", file=sys.stderr)
                            # 北交所历史数据在某些版本中可能使用不同接口，或者通过腾讯/新浪接口拉取
                            stock_df = ak.stock_zh_a_hist(
                                symbol=pure_code,
                                period="daily",
                                start_date=parse_date(start_date),
                                end_date=parse_date(end_date),
                                adjust="" # 默认不复权
                            )
                            method_used = "bj_fallback"
                        except Exception as e4:
                            print(f"All methods failed for {code}. Last error: {e4}", file=sys.stderr)
                            traceback.print_exc(file=sys.stderr)
                            return []
                    else:
                        print(f"All methods failed for {code}. Last error: {e3}", file=sys.stderr)
                        traceback.print_exc(file=sys.stderr)
                        return []

        if stock_df is None or stock_df.empty:
            print(f"No data returned for {code} using {method_used}", file=sys.stderr)
            return []

        # 确保 indicator_dict 已定义
        if 'indicator_dict' not in locals():
            indicator_dict = {}

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

                # 从 indicator_dict 中查找估值数据
                pe_ttm, pb_mrq, ps_ttm, total_mv, circ_mv = 0.0, 0.0, 0.0, 0.0, 0.0
                try:
                    # 尝试将字符串日期转为 pandas Timestamp 去匹配
                    dt_key = pd.to_datetime(date_str)
                    if dt_key in indicator_dict:
                        ind_row = indicator_dict[dt_key]
                        # ak.stock_a_indicator_lg 返回列：pe, pe_ttm, pb, ps, ps_ttm, dv_ratio, dv_ttm, total_mv
                        pe_ttm = float(ind_row.get('pe_ttm', ind_row.get('pe', 0)))
                        pb_mrq = float(ind_row.get('pb', 0))
                        ps_ttm = float(ind_row.get('ps_ttm', ind_row.get('ps', 0)))
                        total_mv = float(ind_row.get('total_mv', 0)) * 10000  # API 返回单位是万元，我们存储为元
                except:
                    pass

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
                    "peTTM": pe_ttm,
                    "psTTM": ps_ttm,
                    "pbMRQ": pb_mrq,
                    "totalMarketCap": total_mv
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