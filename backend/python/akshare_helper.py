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



def safe_float_value(val):
    """Convert pandas/numpy scalar to float, tolerate '-' and nan."""
    try:
        if pd.isna(val) or val == '-':
            return 0.0
        return float(val)
    except Exception:
        return 0.0

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
            elif code.startswith('8') or code.startswith('4') or code.startswith('9'):
                full_code = f"bj.{code}"
            else:
                # 兜底逻辑：如果实在判断不出，也不应该裸存代码，根据名称或者其他特征猜测，或者至少打印警告
                print(f"Warning: Unknown prefix for code {code}, mapping to sh.{code} as fallback", file=sys.stderr)
                full_code = f"sh.{code}"

            stocks.append({
                "code": full_code,
                "code_name": name,
                "ipoDate": ipo_date,
                "type": 1,  # stock
                "status": 1,  # listed
                "totalMarketCap": safe_float_value(row.get('总市值')),
                "circulatingMarketCap": safe_float_value(row.get('流通市值')),
                "peDynamic": safe_float_value(row.get('市盈率-动态')),
                "pb": safe_float_value(row.get('市净率')),
                "turnoverRate": safe_float_value(row.get('换手率')),
                "price": safe_float_value(row.get('最新价')),
                "changePercent": safe_float_value(row.get('涨跌幅')),
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

        # 方法0: 如果是指数，使用专用指数接口
        index_symbols = ['sh.000001', 'sh.000300', 'sz.399001', 'sz.399006']
        if code in index_symbols:
            try:
                print(f"Fetching index data for {code} using stock_zh_index_daily...", file=sys.stderr)
                # 使用 ak.stock_zh_index_daily 获取指数日线
                stock_df = ak.stock_zh_index_daily(symbol=ak_code)
                
                # 过滤日期范围
                start_dt = pd.to_datetime(parse_date(start_date))
                end_dt = pd.to_datetime(parse_date(end_date))
                
                # 确保有日期列，如果返回的是 datetime index，可以重置
                if 'date' in stock_df.columns:
                    stock_df['date'] = pd.to_datetime(stock_df['date'])
                    stock_df = stock_df[(stock_df['date'] >= start_dt) & (stock_df['date'] <= end_dt)]
                
                # 指数没有换手率、复权等，构造缺少的列以便兼容
                if not stock_df.empty:
                    # 指数的数据结构可能需要对齐
                    if 'volume' in stock_df.columns:
                        # 假装这是成交量
                        pass
                
                method_used = "stock_zh_index_daily"
                print(f"Successfully got index data using {method_used}", file=sys.stderr)
                indicator_dict = {}
                
                # 跳过后面的股票方法尝试
            except Exception as e0:
                print(f"Method stock_zh_index_daily failed for index {code}: {e0}", file=sys.stderr)
                return []
        else:
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
    """Get basic information and valuation snapshot for a stock"""
    try:
        pure_code = code
        if code.startswith('sh.') or code.startswith('sz.') or code.startswith('bj.'):
            pure_code = code.split('.')[1]

        full_code = code
        if not (code.startswith('sh.') or code.startswith('sz.') or code.startswith('bj.')):
            if pure_code.startswith('6'):
                full_code = f"sh.{pure_code}"
            elif pure_code.startswith(('0', '3')):
                full_code = f"sz.{pure_code}"
            elif pure_code.startswith(('8', '4', '9')):
                full_code = f"bj.{pure_code}"
            else:
                full_code = f"sh.{pure_code}"

        # Prefer EastMoney spot snapshot; it contains price, valuation and market cap fields.
        stock_df = ak.stock_zh_a_spot_em()
        stock_row = stock_df[stock_df['代码'].astype(str) == pure_code]
        if stock_row.empty:
            return None

        row = stock_row.iloc[0]
        industry = None
        try:
            info_df = ak.stock_individual_info_em(symbol=pure_code)
            if info_df is not None and not info_df.empty:
                for _, info_row in info_df.iterrows():
                    item = str(info_row.get('item', info_row.get('项目', '')))
                    value = info_row.get('value', info_row.get('值', None))
                    if item in ['行业', '所属行业'] and pd.notna(value):
                        industry = str(value)
                        break
        except Exception as info_err:
            print(f"Warning: stock_individual_info_em failed for {pure_code}: {info_err}", file=sys.stderr)

        return {
            "code": full_code,
            "code_name": str(row.get('名称', '')),
            "ipoDate": "2000-01-01",
            "type": 1,
            "status": 1,
            "industry": industry,
            "totalMarketCap": safe_float_value(row.get('总市值')),
            "circulatingMarketCap": safe_float_value(row.get('流通市值')),
            "peDynamic": safe_float_value(row.get('市盈率-动态')),
            "pb": safe_float_value(row.get('市净率')),
            "turnoverRate": safe_float_value(row.get('换手率')),
            "price": safe_float_value(row.get('最新价')),
            "changePercent": safe_float_value(row.get('涨跌幅')),
        }
    except Exception as e:
        print(f"Error getting stock basic for {code}: {e}", file=sys.stderr)
        return None

def get_realtime_quotes(symbols: str) -> Dict[str, Any]:
    """Get real-time quotes for multiple symbols"""
    try:
        symbol_list = symbols.split(',')
        pure_symbols = []
        for code in symbol_list:
            pure_code = code
            if code.startswith('sh.') or code.startswith('sz.') or code.startswith('bj.'):
                pure_code = code.split('.')[1]
            pure_symbols.append(pure_code)
            
        stock_df = ak.stock_zh_a_spot_em()
        
        result = {}
        for idx, pure_code in enumerate(pure_symbols):
            stock_row = stock_df[stock_df['代码'] == pure_code]
            if not stock_row.empty:
                row = stock_row.iloc[0]
                result[symbol_list[idx]] = {
                    "current_price": float(row['最新价']) if pd.notna(row['最新价']) else 0.0,
                    "change_percent": float(row['涨跌幅']) if pd.notna(row['涨跌幅']) else 0.0,
                    "turnover": float(row['成交额']) if pd.notna(row['成交额']) else 0.0,
                    "high": float(row['最高']) if pd.notna(row['最高']) else 0.0,
                    "low": float(row['最低']) if pd.notna(row['最低']) else 0.0,
                    "open": float(row['今开']) if pd.notna(row['今开']) else 0.0,
                    "volume": float(row['成交量']) if pd.notna(row['成交量']) else 0.0,
                    "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                }
        return result
    except Exception as e:
        print(f"Error getting real-time quotes: {e}", file=sys.stderr)
        return {}

def health_check(code: str, start_date: str, end_date: str) -> Dict[str, Any]:
    """Lightweight health probe for AKShare. Avoids full-market and indicator endpoints."""
    pure_code = code
    if code.startswith('sh.') or code.startswith('sz.') or code.startswith('bj.'):
        pure_code = code.split('.')[1]

    ak_code = code
    if code.startswith('sh.'):
        ak_code = code.replace('sh.', 'sh')
    elif code.startswith('sz.'):
        ak_code = code.replace('sz.', 'sz')
    elif code.startswith('bj.'):
        ak_code = code.replace('bj.', 'bj')

    index_symbols = ['sh.000001', 'sh.000300', 'sz.399001', 'sz.399006']
    if code in index_symbols:
        df = ak.stock_zh_index_daily(symbol=ak_code)
        date_column = 'date' if 'date' in df.columns else None
    else:
        df = ak.stock_zh_a_hist(
            symbol=pure_code,
            period="daily",
            start_date=parse_date(start_date),
            end_date=parse_date(end_date),
            adjust=""
        )
        date_column = '日期' if '日期' in df.columns else ('date' if 'date' in df.columns else None)

    if df is None or df.empty:
        return {
            "ok": False,
            "bar_count": 0,
            "latest_date": None,
            "sample_symbol": code,
            "start_date": start_date,
            "end_date": end_date,
        }

    latest_date = None
    if date_column:
        dates = pd.to_datetime(df[date_column], errors='coerce').dropna()
        if not dates.empty:
            latest_date = dates.max().strftime('%Y-%m-%d')

    return {
        "ok": True,
        "bar_count": int(len(df)),
        "latest_date": latest_date,
        "sample_symbol": code,
        "start_date": start_date,
        "end_date": end_date,
    }

def get_intraday_bars(code: str, period: str = '1', limit: int = 240) -> List[Dict[str, Any]]:
    """Get intraday minute bars"""
    try:
        pure_code = code
        if code.startswith('sh.') or code.startswith('sz.') or code.startswith('bj.'):
            pure_code = code.split('.')[1]
            
        # period mapping: 1, 5, 15, 30, 60
        period_map = {'1m': '1', '5m': '5', '15m': '15', '30m': '30', '60m': '60'}
        mapped_period = period_map.get(period, '1')
        
        df = ak.stock_zh_a_hist_min_em(symbol=pure_code, period=mapped_period, adjust="qfq")
        
        if df.empty:
            return []
            
        # Get the latest N bars
        df = df.tail(limit)
        
        result = []
        for _, row in df.iterrows():
            result.append({
                "time": str(row['时间']),
                "open": float(row['开盘']) if pd.notna(row['开盘']) else 0.0,
                "high": float(row['最高']) if pd.notna(row['最高']) else 0.0,
                "low": float(row['最低']) if pd.notna(row['最低']) else 0.0,
                "close": float(row['收盘']) if pd.notna(row['收盘']) else 0.0,
                "volume": float(row['成交量']) if pd.notna(row['成交量']) else 0.0,
                "turnover": float(row['成交额']) if pd.notna(row['成交额']) else 0.0
            })
        return result
    except Exception as e:
        print(f"Error getting intraday bars for {code}: {e}", file=sys.stderr)
        return []

def get_northbound_holdings(date: str, market: str = "北向") -> List[Dict[str, Any]]:
    """
    Fetch northbound (Stock Connect) holdings for a given trade date.

    Uses AKShare `stock_hsgt_hold_stock_em`, which returns one row per stock
    for the chosen market channel ('沪股通' / '深股通' / '北向').

    Args:
        date: trade date as YYYY-MM-DD or YYYYMMDD.
        market: one of '北向' (combined SH+SZ, default), '沪股通', '深股通'.

    Returns:
        List of dicts with keys: trade_date, stock_code, stock_name,
        hold_volume, hold_amount, hold_ratio, market_type, raw_payload.
        Returns [] on empty / error so caller can checkpoint a "tried" date.
    """
    try:
        # AKShare expects 20250605 form
        pure_date = date.replace('-', '')
        # market parameter values: "沪股通", "深股通", "北向"
        market_param = market if market else "北向"

        print(f"Fetching northbound holdings for {pure_date} ({market_param})...", file=sys.stderr)
        df = ak.stock_hsgt_hold_stock_em(market=market_param, indicator=pure_date)

        if df is None or df.empty:
            print(f"AKShare returned empty dataframe for {pure_date}", file=sys.stderr)
            return []

        # AKShare 列名取决于版本，做一次柔性映射
        col_map = {}
        for col in df.columns:
            col_s = str(col)
            if col_s in ('股票代码', 'stock_code', 'code'):
                col_map['stock_code'] = col_s
            elif col_s in ('股票简称', '股票名称', 'name', 'stock_name'):
                col_map['stock_name'] = col_s
            elif col_s == '持股数量':
                col_map['hold_volume'] = col_s
            elif col_s == '持股市值':
                col_map['hold_amount'] = col_s
            elif col_s in ('持股数量占发行股百分比', '持股市值占A股市值比'):
                # 优先选第一个匹配到的"占比"列
                col_map.setdefault('hold_ratio', col_s)
            elif col_s == '市场':
                col_map['market_label'] = col_s

        result: List[Dict[str, Any]] = []
        for _, row in df.iterrows():
            raw_code = row.get(col_map.get('stock_code', '股票代码'))
            if pd.isna(raw_code):
                continue
            stock_code = str(raw_code).strip()
            if not stock_code or stock_code.lower() == 'nan':
                continue

            # 推断市场类型：根据代码前缀
            if stock_code.startswith('6'):
                market_type = 'SH'
            elif stock_code.startswith(('0', '3')):
                market_type = 'SZ'
            else:
                # 如果有 "市场" 字段则用它来判定
                m_label = row.get(col_map.get('market_label')) if col_map.get('market_label') else None
                if isinstance(m_label, str) and '沪' in m_label:
                    market_type = 'SH'
                elif isinstance(m_label, str) and '深' in m_label:
                    market_type = 'SZ'
                else:
                    # 不属于沪深 A 股直接跳过 (北交所/科创板 8 开头会落在这里)
                    continue

            stock_name_col = col_map.get('stock_name')
            stock_name = str(row.get(stock_name_col)) if stock_name_col and pd.notna(row.get(stock_name_col)) else None

            hold_volume_col = col_map.get('hold_volume')
            hold_amount_col = col_map.get('hold_amount')
            hold_ratio_col = col_map.get('hold_ratio')

            hold_volume = safe_float_value(row.get(hold_volume_col)) if hold_volume_col else None
            hold_amount = safe_float_value(row.get(hold_amount_col)) if hold_amount_col else None
            hold_ratio = safe_float_value(row.get(hold_ratio_col)) if hold_ratio_col else None

            # 原始行作为审计 payload，便于事后回溯字段含义
            raw_payload: Dict[str, Any] = {}
            for col in df.columns:
                val = row.get(col)
                if pd.isna(val):
                    raw_payload[str(col)] = None
                elif isinstance(val, (int, float)):
                    raw_payload[str(col)] = float(val)
                else:
                    raw_payload[str(col)] = str(val)

            result.append({
                "trade_date": _format_iso_date(pure_date),
                "stock_code": stock_code,
                "stock_name": stock_name,
                "hold_volume": int(hold_volume) if hold_volume is not None else None,
                "hold_amount": hold_amount,
                "hold_ratio": hold_ratio,
                "market_type": market_type,
                "raw_payload": raw_payload,
            })

        print(f"Parsed {len(result)} northbound rows for {pure_date}", file=sys.stderr)
        return result
    except Exception as e:
        print(f"Error getting northbound holdings for {date}: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        return []


def get_dragon_tiger_detail(date: str) -> List[Dict[str, Any]]:
    """
    Fetch the Dragon-Tiger Board (龙虎榜) seat-level detail for a given trade date.

    Strategy:
      1. AKShare `stock_lhb_detail_em(start_date, end_date)` gives the list of
         stocks that hit the LHB on that day + the "reason" they hit.
      2. For each stock, AKShare `stock_lhb_stock_detail_em(symbol=<6 位代码>,
         date=YYYYMMDD, flag='买入'/'卖出')` returns the 营业部 list for that
         direction. We do a buyer × seller cartesian fan-out so each row is a
         (buyer_seat, seller_seat) pair, matching the DragonTigerBoard PK.

    Notes:
      - Some days will have buyer-only or seller-only rows; we still emit those
        with the absent side set to "" (empty string) so the PK stays unique.
      - `net_amount` is per-pair: buy_amount - sell_amount (best effort; real
         net is computed by the seat itself, but we keep both sides for audit).
      - Returns [] on error / empty days so caller can checkpoint.

    Args:
        date: trade date as YYYY-MM-DD or YYYYMMDD.
    """
    try:
        pure_date = date.replace('-', '')
        iso_date = _format_iso_date(pure_date)

        print(f"Fetching dragon-tiger detail for {pure_date}...", file=sys.stderr)
        try:
            # AKShare 接口签名：start_date / end_date 都接 YYYYMMDD
            df_list = ak.stock_lhb_detail_em(start_date=pure_date, end_date=pure_date)
        except TypeError:
            # 某些版本签名是 (start_date, end_date) 位置参数
            df_list = ak.stock_lhb_detail_em(pure_date, pure_date)

        if df_list is None or df_list.empty:
            print(f"AKShare returned empty LHB list for {pure_date}", file=sys.stderr)
            return []

        # 列名柔性映射
        list_col_map: Dict[str, str] = {}
        for col in df_list.columns:
            col_s = str(col)
            if col_s in ('代码', '股票代码', 'symbol', 'code'):
                list_col_map['stock_code'] = col_s
            elif col_s in ('名称', '股票简称', '股票名称', 'name'):
                list_col_map['stock_name'] = col_s
            elif col_s in ('上榜原因', '解读', 'reason'):
                list_col_map.setdefault('reason', col_s)

        results: List[Dict[str, Any]] = []
        for _, lrow in df_list.iterrows():
            raw_code = lrow.get(list_col_map.get('stock_code', '代码'))
            if pd.isna(raw_code):
                continue
            stock_code = str(raw_code).strip().zfill(6)
            if not stock_code or stock_code.lower() == 'nan':
                continue

            stock_name_col = list_col_map.get('stock_name')
            stock_name = (
                str(lrow.get(stock_name_col))
                if stock_name_col and pd.notna(lrow.get(stock_name_col))
                else None
            )
            reason_col = list_col_map.get('reason')
            reason = (
                str(lrow.get(reason_col))
                if reason_col and pd.notna(lrow.get(reason_col))
                else None
            )

            # 把上榜信息也拷一份到 raw_payload 顶层，便于审计
            list_raw: Dict[str, Any] = {}
            for col in df_list.columns:
                val = lrow.get(col)
                if pd.isna(val):
                    list_raw[str(col)] = None
                elif isinstance(val, (int, float)):
                    list_raw[str(col)] = float(val)
                else:
                    list_raw[str(col)] = str(val)

            # 抓买卖双方席位明细
            buyers = _fetch_lhb_seat_side(stock_code, pure_date, '买入')
            sellers = _fetch_lhb_seat_side(stock_code, pure_date, '卖出')

            # 笛卡尔展开：买方 N × 卖方 M。
            # 若一侧为空，用占位符保证 PK 仍能唯一。
            buyers_iter = buyers if buyers else [{
                'seat': '', 'buy_amount': None, 'sell_amount': None, 'net_amount': None, 'raw': {}
            }]
            sellers_iter = sellers if sellers else [{
                'seat': '', 'buy_amount': None, 'sell_amount': None, 'net_amount': None, 'raw': {}
            }]

            for b in buyers_iter:
                for s in sellers_iter:
                    # buy_amount 取自买方席位明细，sell_amount 取自卖方席位明细
                    buy_amt = b.get('buy_amount')
                    sell_amt = s.get('sell_amount')
                    if buy_amt is None and sell_amt is None:
                        net = None
                    else:
                        net = (buy_amt or 0.0) - (sell_amt or 0.0)

                    results.append({
                        'trade_date': iso_date,
                        'stock_code': stock_code,
                        'stock_name': stock_name,
                        'reason': reason,
                        'buyer_seat': b.get('seat', ''),
                        'seller_seat': s.get('seat', ''),
                        'buy_amount': buy_amt,
                        'sell_amount': sell_amt,
                        'net_amount': net,
                        'raw_payload': {
                            'list_row': list_raw,
                            'buyer_row': b.get('raw', {}),
                            'seller_row': s.get('raw', {}),
                        },
                    })

        print(
            f"Parsed {len(results)} dragon-tiger seat-pair rows for {pure_date}",
            file=sys.stderr,
        )
        return results
    except Exception as e:
        print(f"Error getting dragon-tiger detail for {date}: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        return []


def _fetch_lhb_seat_side(stock_code: str, pure_date: str, flag: str) -> List[Dict[str, Any]]:
    """
    单只股票单方向（买入 / 卖出）席位明细。
    flag: '买入' | '卖出'
    返回每席位一条记录：{seat, buy_amount, sell_amount, net_amount, raw}
    """
    try:
        df = ak.stock_lhb_stock_detail_em(symbol=stock_code, date=pure_date, flag=flag)
    except TypeError:
        # 旧版本位置参数
        try:
            df = ak.stock_lhb_stock_detail_em(stock_code, pure_date, flag)
        except Exception as e:
            print(
                f"_fetch_lhb_seat_side({stock_code},{pure_date},{flag}) call failed: {e}",
                file=sys.stderr,
            )
            return []
    except Exception as e:
        print(
            f"_fetch_lhb_seat_side({stock_code},{pure_date},{flag}) failed: {e}",
            file=sys.stderr,
        )
        return []

    if df is None or df.empty:
        return []

    # AKShare 席位明细常见列：交易营业部名称 / 买入金额 / 卖出金额 / 净额
    seat_col = None
    buy_amt_col = None
    sell_amt_col = None
    net_col = None
    for col in df.columns:
        col_s = str(col)
        if seat_col is None and ('营业部' in col_s):
            seat_col = col_s
        elif col_s in ('买入金额', '买入金额(元)') and buy_amt_col is None:
            buy_amt_col = col_s
        elif col_s in ('卖出金额', '卖出金额(元)') and sell_amt_col is None:
            sell_amt_col = col_s
        elif col_s in ('净额', '净额(元)', '净买入金额') and net_col is None:
            net_col = col_s

    seats: List[Dict[str, Any]] = []
    for _, row in df.iterrows():
        seat_raw = row.get(seat_col) if seat_col else None
        if pd.isna(seat_raw):
            continue
        seat = str(seat_raw).strip()
        if not seat:
            continue

        buy_amount = safe_float_value(row.get(buy_amt_col)) if buy_amt_col else None
        sell_amount = safe_float_value(row.get(sell_amt_col)) if sell_amt_col else None
        net = safe_float_value(row.get(net_col)) if net_col else None

        # 原始行 → JSON 友好
        raw_row: Dict[str, Any] = {}
        for col in df.columns:
            val = row.get(col)
            if pd.isna(val):
                raw_row[str(col)] = None
            elif isinstance(val, (int, float)):
                raw_row[str(col)] = float(val)
            else:
                raw_row[str(col)] = str(val)

        seats.append({
            'seat': seat,
            'buy_amount': buy_amount,
            'sell_amount': sell_amount,
            'net_amount': net,
            'raw': raw_row,
        })

    return seats


def _format_iso_date(yyyymmdd: str) -> str:
    """20250605 -> 2025-06-05; pass-through if already ISO"""
    if len(yyyymmdd) == 8 and yyyymmdd.isdigit():
        return f"{yyyymmdd[0:4]}-{yyyymmdd[4:6]}-{yyyymmdd[6:8]}"
    return yyyymmdd


def get_earnings_forecast(report_period: str) -> List[Dict[str, Any]]:
    """
    Fetch A-share earnings forecast (业绩预告) for a given REPORT PERIOD.

    Uses AKShare `stock_yjyg_em(date=YYYYMMDD)` where `date` is the report-
    period END date (e.g. '20240930' = Q3 2024), NOT the announcement date.
    The dataframe returned lists every stock that has issued a forecast for
    that report period, with the actual announce_date carried as a column.

    Important: AKShare publishes 4 report periods per year — Q1 (0331), Q2/H1
    (0630), Q3 (0930), 年报 (1231). Callers should pass one of these dates;
    other dates return an empty dataframe.

    Args:
        report_period: report-period end date YYYY-MM-DD or YYYYMMDD.

    Returns:
        List of dicts: {announce_date, stock_code, stock_name, report_period,
        forecast_type, profit_change_low, profit_change_high, profit_low,
        profit_high, forecast_reason, raw_payload}.
        Returns [] on empty / error so caller can checkpoint a "tried" period.
    """
    try:
        pure_period = report_period.replace('-', '')
        iso_period = _format_iso_date(pure_period)

        print(f"Fetching earnings forecasts for report_period={pure_period}...", file=sys.stderr)

        try:
            df = ak.stock_yjyg_em(date=pure_period)
        except TypeError:
            df = ak.stock_yjyg_em(pure_period)
        except Exception as e:
            print(f"stock_yjyg_em failed for {pure_period}: {e}", file=sys.stderr)
            return []

        if df is None or df.empty:
            print(f"AKShare returned empty dataframe for {pure_period}", file=sys.stderr)
            return []

        # ----- 列名柔性映射（AKShare 中文列名常飘移）-----
        col_map: Dict[str, str] = {}
        for col in df.columns:
            col_s = str(col)
            if col_s in ('股票代码', 'stock_code', 'code', '代码'):
                col_map['stock_code'] = col_s
            elif col_s in ('股票简称', '股票名称', '名称', 'name', 'stock_name'):
                col_map['stock_name'] = col_s
            elif col_s in ('公告日期', '最新公告日期'):
                col_map['announce_date'] = col_s
            elif col_s in ('预测指标', '业绩变动'):
                # 历史/未来字段名差异 — 不入主表，但归档到 raw_payload
                col_map.setdefault('indicator', col_s)
            elif col_s in ('预告类型',):
                col_map['forecast_type'] = col_s
            elif col_s in (
                '预测数值',
                '预测净利润-下限',
                '预测净利润下限',
            ):
                col_map['profit_low'] = col_s
            elif col_s in ('预测净利润-上限', '预测净利润上限'):
                col_map['profit_high'] = col_s
            elif col_s in ('预测变动幅度-下限', '预测变动幅度下限', '净利润变动幅度-下限'):
                col_map['profit_change_low'] = col_s
            elif col_s in ('预测变动幅度-上限', '预测变动幅度上限', '净利润变动幅度-上限'):
                col_map['profit_change_high'] = col_s
            elif col_s in ('业绩变动原因', '变动原因'):
                col_map['forecast_reason'] = col_s

        results: List[Dict[str, Any]] = []
        for _, row in df.iterrows():
            raw_code = row.get(col_map.get('stock_code', '股票代码'))
            if pd.isna(raw_code):
                continue
            stock_code = str(raw_code).strip().zfill(6)
            if not stock_code or stock_code.lower() == 'nan':
                continue
            # 北交所 8 / 4 开头不在多数 A 股策略股池里 — 留在数据里，策略自己过滤
            stock_name = _cell_str(row, col_map.get('stock_name'))

            # 公告日期：可能是 datetime / Timestamp / 字符串
            announce_raw = row.get(col_map.get('announce_date')) if col_map.get('announce_date') else None
            announce_iso: Optional[str] = None
            if announce_raw is not None and not pd.isna(announce_raw):
                # pandas Timestamp / datetime / 字符串都先转 str 再 parse
                announce_str = str(announce_raw).strip()
                if len(announce_str) >= 10 and announce_str[4] in ('-', '/'):
                    announce_iso = announce_str[0:10].replace('/', '-')
                elif len(announce_str) >= 8 and announce_str[:8].isdigit():
                    announce_iso = _format_iso_date(announce_str[:8])
                else:
                    # 兜底：用 report_period 当公告日，至少能 upsert（虽然非真实公告日）
                    announce_iso = iso_period
            else:
                # 公告日缺失：用 report_period 当公告日兜底
                announce_iso = iso_period

            forecast_type = _cell_str(row, col_map.get('forecast_type'))
            profit_low = _cell_float(row, col_map.get('profit_low'))
            profit_high = _cell_float(row, col_map.get('profit_high'))
            profit_change_low = _cell_float(row, col_map.get('profit_change_low'))
            profit_change_high = _cell_float(row, col_map.get('profit_change_high'))
            forecast_reason = _cell_str(row, col_map.get('forecast_reason'))

            raw_payload = _row_to_jsonable(row, df.columns)

            results.append({
                'announce_date': announce_iso,
                'stock_code': stock_code,
                'stock_name': stock_name,
                'report_period': iso_period,
                'forecast_type': forecast_type,
                'profit_change_low': profit_change_low,
                'profit_change_high': profit_change_high,
                'profit_low': profit_low,
                'profit_high': profit_high,
                'forecast_reason': forecast_reason,
                'raw_payload': raw_payload,
            })

        print(
            f"Parsed {len(results)} earnings-forecast rows for report_period {pure_period}",
            file=sys.stderr,
        )
        return results
    except Exception as e:
        print(f"Error getting earnings forecast for {report_period}: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        return []


def get_limit_up_pool(date: str) -> List[Dict[str, Any]]:
    """
    Fetch the limit-up (涨停) stock pool for a given trade date, merging both
    AKShare endpoints into one row-per-stock list:

      - `stock_zt_pool_em`        — 当日涨停股池 (16 cols incl. 连板数 / 封板资金 /
                                     首次封板时间 / 最后封板时间 / 炸板次数 / 所属行业)
      - `stock_zt_pool_strong_em` — 当日强势股池 (16 cols incl. 入选理由 / 涨速 /
                                     是否新高 / 量比 / 所属行业)

    Strategy:
      1. Pull both dataframes for `date`.
      2. Index strong-pool by stock_code; treat as a side-car so 入选理由 / 涨速
         enrich the zt rows.
      3. For stocks only in strong-pool (e.g. T 字板 + 当日未涨停但近期强势的样本)
         emit minimal rows with continuous_days defaulting to 1.

    `is_one_word_board` is computed here as a convenience signal:
        首次封板时间 ≤ 09:30:00  AND  炸板次数 == 0
    The TS service may refine this from raw_payload if needed.

    Args:
        date: trade date YYYY-MM-DD or YYYYMMDD.

    Returns:
        List of dicts: {trade_date, stock_code, stock_name, limit_up_time,
        limit_up_amount, limit_up_open_times, continuous_days, reason, industry,
        is_one_word_board, raw_payload{zt_row?, strong_row?}}.
        Returns [] on empty / error so caller can checkpoint a "tried" date.
    """
    try:
        pure_date = date.replace('-', '')
        iso_date = _format_iso_date(pure_date)

        print(f"Fetching limit-up pool for {pure_date}...", file=sys.stderr)

        # ----- 1) 涨停股池 -----
        try:
            df_zt = ak.stock_zt_pool_em(date=pure_date)
        except TypeError:
            df_zt = ak.stock_zt_pool_em(pure_date)
        except Exception as e:
            print(f"stock_zt_pool_em failed for {pure_date}: {e}", file=sys.stderr)
            df_zt = None

        # ----- 2) 强势股池 -----
        try:
            df_strong = ak.stock_zt_pool_strong_em(date=pure_date)
        except TypeError:
            df_strong = ak.stock_zt_pool_strong_em(pure_date)
        except Exception as e:
            print(f"stock_zt_pool_strong_em failed for {pure_date}: {e}", file=sys.stderr)
            df_strong = None

        zt_empty = df_zt is None or df_zt.empty
        strong_empty = df_strong is None or df_strong.empty
        if zt_empty and strong_empty:
            print(f"AKShare returned empty zt/strong pools for {pure_date}", file=sys.stderr)
            return []

        # ----- 3) 列名柔性映射（zt_pool）-----
        zt_col_map: Dict[str, str] = {}
        if not zt_empty:
            for col in df_zt.columns:
                col_s = str(col)
                if col_s in ('代码', '股票代码', 'symbol', 'code'):
                    zt_col_map['stock_code'] = col_s
                elif col_s in ('名称', '股票简称', '股票名称', 'name'):
                    zt_col_map['stock_name'] = col_s
                elif col_s == '首次封板时间':
                    zt_col_map['limit_up_time'] = col_s
                elif col_s == '封板资金':
                    zt_col_map['limit_up_amount'] = col_s
                elif col_s == '炸板次数':
                    zt_col_map['limit_up_open_times'] = col_s
                elif col_s == '连板数':
                    zt_col_map['continuous_days'] = col_s
                elif col_s == '所属行业':
                    zt_col_map['industry'] = col_s

        # ----- 4) 列名柔性映射（strong_pool）-----
        strong_col_map: Dict[str, str] = {}
        if not strong_empty:
            for col in df_strong.columns:
                col_s = str(col)
                if col_s in ('代码', '股票代码', 'symbol', 'code'):
                    strong_col_map['stock_code'] = col_s
                elif col_s in ('名称', '股票简称', '股票名称', 'name'):
                    strong_col_map['stock_name'] = col_s
                elif col_s == '入选理由':
                    strong_col_map['reason'] = col_s
                elif col_s == '所属行业':
                    strong_col_map['industry'] = col_s

        # 把 strong-pool 转成 code → raw 行字典，便于后续合并
        strong_by_code: Dict[str, Dict[str, Any]] = {}
        if not strong_empty:
            for _, srow in df_strong.iterrows():
                raw_code = srow.get(strong_col_map.get('stock_code', '代码'))
                if pd.isna(raw_code):
                    continue
                code = str(raw_code).strip().zfill(6)
                strong_by_code[code] = _row_to_jsonable(srow, df_strong.columns)

        results: List[Dict[str, Any]] = []
        seen_codes: set = set()

        # ----- 5) 以 zt_pool 为主表合并 -----
        if not zt_empty:
            for _, zrow in df_zt.iterrows():
                raw_code = zrow.get(zt_col_map.get('stock_code', '代码'))
                if pd.isna(raw_code):
                    continue
                stock_code = str(raw_code).strip().zfill(6)
                if not stock_code or stock_code.lower() == 'nan':
                    continue
                seen_codes.add(stock_code)

                stock_name = _cell_str(zrow, zt_col_map.get('stock_name'))
                limit_up_time = _cell_str(zrow, zt_col_map.get('limit_up_time'))
                limit_up_amount = _cell_float(zrow, zt_col_map.get('limit_up_amount'))
                limit_up_open_times = _cell_int(zrow, zt_col_map.get('limit_up_open_times'))
                continuous_days_raw = _cell_int(zrow, zt_col_map.get('continuous_days'))
                continuous_days = continuous_days_raw if continuous_days_raw and continuous_days_raw > 0 else 1
                industry = _cell_str(zrow, zt_col_map.get('industry'))

                # 强势池侧车字段：入选理由 / 行业（zt 行业为主，缺则取 strong 的）
                strong_row = strong_by_code.get(stock_code)
                reason: Optional[str] = None
                if strong_row:
                    reason_col = strong_col_map.get('reason')
                    if reason_col and strong_row.get(reason_col) is not None:
                        reason_val = strong_row.get(reason_col)
                        reason = str(reason_val) if reason_val not in (None, 'None', 'nan') else None
                    if not industry:
                        industry_col = strong_col_map.get('industry')
                        if industry_col and strong_row.get(industry_col) is not None:
                            industry = str(strong_row.get(industry_col)) or None

                # 一字板：首次封板时间 ≤ 09:30:00 AND 炸板次数 == 0
                is_one_word = _is_one_word(limit_up_time, limit_up_open_times)

                results.append({
                    'trade_date': iso_date,
                    'stock_code': stock_code,
                    'stock_name': stock_name,
                    'limit_up_time': limit_up_time,
                    'limit_up_amount': limit_up_amount,
                    'limit_up_open_times': limit_up_open_times if limit_up_open_times is not None else 0,
                    'continuous_days': continuous_days,
                    'reason': reason,
                    'industry': industry,
                    'is_one_word_board': is_one_word,
                    'raw_payload': {
                        'zt_row': _row_to_jsonable(zrow, df_zt.columns),
                        'strong_row': strong_row,
                    },
                })

        # ----- 6) 强势池独有的行（zt 中没出现的）-----
        if not strong_empty:
            for code, srow in strong_by_code.items():
                if code in seen_codes:
                    continue
                stock_name_col = strong_col_map.get('stock_name')
                stock_name = (
                    str(srow.get(stock_name_col))
                    if stock_name_col and srow.get(stock_name_col) is not None
                    else None
                )
                reason_col = strong_col_map.get('reason')
                reason = (
                    str(srow.get(reason_col))
                    if reason_col and srow.get(reason_col) is not None
                    else None
                )
                industry_col = strong_col_map.get('industry')
                industry = (
                    str(srow.get(industry_col))
                    if industry_col and srow.get(industry_col) is not None
                    else None
                )

                results.append({
                    'trade_date': iso_date,
                    'stock_code': code,
                    'stock_name': stock_name,
                    'limit_up_time': None,
                    'limit_up_amount': None,
                    'limit_up_open_times': 0,
                    'continuous_days': 1,
                    'reason': reason,
                    'industry': industry,
                    'is_one_word_board': False,
                    'raw_payload': {
                        'zt_row': None,
                        'strong_row': srow,
                    },
                })

        print(
            f"Parsed {len(results)} limit-up rows for {pure_date} "
            f"(zt={0 if zt_empty else len(df_zt)}, strong={0 if strong_empty else len(df_strong)})",
            file=sys.stderr,
        )
        return results
    except Exception as e:
        print(f"Error getting limit-up pool for {date}: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        return []


def get_industry_flow(date: str) -> List[Dict[str, Any]]:
    """
    Fetch daily industry-board fund-flow + board-strength snapshot for all
    Eastmoney 行业板块 (~86 boards) and identify the daily leader stock per
    board (highest pct change among constituents that are NOT one-word boards).

    Combines three AKShare endpoints:

      1. `stock_sector_fund_flow_rank(indicator='今日', sector_type='行业资金流')`
         — board-level fund flow. Provides 名称 / 今日涨跌幅 / 今日主力净流入-净额
         / 今日主力净流入-净占比 / 今日主力净流入最大股 / 今日主力净流入最大股代码.
         **No board code in this dataframe** — must join by 名称 to (2).
      2. `stock_board_industry_name_em()` — board name → board code (BKxxxx)
         + 上涨家数 / 下跌家数 / 领涨股票 / 领涨股票-涨跌幅.
      3. `stock_board_industry_cons_em(symbol=<board_name>)` — board
         constituents (代码 / 名称 / 最新价 / 涨跌幅 / 涨跌额 / 换手率 ...). The
         daily leader is selected as the highest 涨跌幅 row that is NOT a
         one-word board (heuristic: 涨跌幅 < 9.95% OR 振幅 > 0.5%).

    Date semantics: AKShare's fund-flow + name endpoints are **real-time
    snapshots, not historical**. We label every row with the supplied `date`
    (the caller should always sync the day's data after market close). For
    a backfill on a non-today date, the fund-flow + leader stocks are still
    today-snapshot — the caller should accept this limitation and write
    today's snapshot under today's `date`.

    Args:
        date: ISO YYYY-MM-DD or YYYYMMDD; stamped onto every output row.

    Returns:
        List of dicts: {trade_date, industry_code, industry_name, change_pct,
        main_inflow, main_inflow_ratio, leader_stock_code, leader_stock_name,
        leader_stock_change_pct, advancing_count, declining_count,
        raw_payload{fund_flow_row, board_row, leader_row}}.

        `limit_up_count` is intentionally LEFT TO THE TS SERVICE (it requires
        joining LimitUpStock table; Python helper stays a dumb fetcher).
        Returns [] on empty / error so caller can checkpoint a "tried" date.
    """
    try:
        iso_date = _format_iso_date(date.replace('-', ''))

        print(f"Fetching industry fund flow snapshot (stamp={iso_date})...", file=sys.stderr)

        # ----- 1) 板块资金流 (rank) -----
        try:
            df_flow = ak.stock_sector_fund_flow_rank(indicator='今日', sector_type='行业资金流')
        except TypeError:
            df_flow = ak.stock_sector_fund_flow_rank('今日', '行业资金流')
        except Exception as e:
            print(f"stock_sector_fund_flow_rank failed: {e}", file=sys.stderr)
            df_flow = None

        if df_flow is None or df_flow.empty:
            print("AKShare returned empty industry fund-flow", file=sys.stderr)
            return []

        # ----- 2) 板块名称→板块代码 + 上涨/下跌家数 + 领涨股 -----
        try:
            df_name = ak.stock_board_industry_name_em()
        except Exception as e:
            print(f"stock_board_industry_name_em failed: {e}", file=sys.stderr)
            df_name = None

        # 板块名称 → (代码, raw_row) 索引
        name_to_board: Dict[str, Dict[str, Any]] = {}
        if df_name is not None and not df_name.empty:
            for _, brow in df_name.iterrows():
                bname = str(brow.get('板块名称', '')).strip()
                if not bname or bname.lower() == 'nan':
                    continue
                name_to_board[bname] = _row_to_jsonable(brow, df_name.columns)

        # 列名柔性映射（fund_flow）
        flow_col_map: Dict[str, str] = {}
        for col in df_flow.columns:
            col_s = str(col)
            if col_s == '名称':
                flow_col_map['industry_name'] = col_s
            elif col_s == '今日涨跌幅':
                flow_col_map['change_pct'] = col_s
            elif col_s == '今日主力净流入-净额':
                flow_col_map['main_inflow'] = col_s
            elif col_s == '今日主力净流入-净占比':
                flow_col_map['main_inflow_ratio'] = col_s
            elif col_s == '今日主力净流入最大股':
                flow_col_map['inflow_leader_name'] = col_s
            elif col_s == '今日主力净流入最大股代码':
                flow_col_map['inflow_leader_code'] = col_s

        results: List[Dict[str, Any]] = []
        for _, frow in df_flow.iterrows():
            industry_name = _cell_str(frow, flow_col_map.get('industry_name'))
            if not industry_name:
                continue

            board_row = name_to_board.get(industry_name)
            # 找不到代码时构造一个 "FALLBACK-<name>" 兜底；丢弃这条会破坏排名分析的全集
            if board_row and board_row.get('板块代码'):
                industry_code = str(board_row.get('板块代码')).strip()
            else:
                industry_code = f"FALLBACK-{industry_name}"

            change_pct = _cell_float(frow, flow_col_map.get('change_pct'))
            main_inflow = _cell_float(frow, flow_col_map.get('main_inflow'))
            main_inflow_ratio = _cell_float(frow, flow_col_map.get('main_inflow_ratio'))

            advancing_count: Optional[int] = None
            declining_count: Optional[int] = None
            if board_row:
                advancing_count = (
                    int(board_row['上涨家数']) if board_row.get('上涨家数') is not None else None
                )
                declining_count = (
                    int(board_row['下跌家数']) if board_row.get('下跌家数') is not None else None
                )

            # ----- 3) 行业内成份股 → 选龙头（涨幅最大且非一字板）-----
            leader_code: Optional[str] = None
            leader_name: Optional[str] = None
            leader_change_pct: Optional[float] = None
            leader_row_json: Optional[Dict[str, Any]] = None

            try:
                df_cons = ak.stock_board_industry_cons_em(symbol=industry_name)
            except TypeError:
                try:
                    df_cons = ak.stock_board_industry_cons_em(industry_name)
                except Exception as e:
                    print(
                        f"stock_board_industry_cons_em({industry_name}) failed: {e}",
                        file=sys.stderr,
                    )
                    df_cons = None
            except Exception as e:
                print(
                    f"stock_board_industry_cons_em({industry_name}) failed: {e}",
                    file=sys.stderr,
                )
                df_cons = None

            if df_cons is not None and not df_cons.empty:
                # 按 涨跌幅 desc 排序，挑第一个非一字板
                try:
                    df_cons_sorted = df_cons.sort_values('涨跌幅', ascending=False, na_position='last')
                except Exception:
                    df_cons_sorted = df_cons
                for _, crow in df_cons_sorted.iterrows():
                    pct = safe_float_value(crow.get('涨跌幅'))
                    if pct is None:
                        continue
                    # 一字板启发式：涨跌幅 >= 9.95% 且 振幅 <= 0.5%。
                    # 振幅缺失时只要涨跌幅 >= 9.95 就视为一字板（保守跳过）。
                    amplitude = safe_float_value(crow.get('振幅'))
                    is_one_word = pct >= 9.95 and (amplitude is None or amplitude <= 0.5)
                    if is_one_word:
                        continue
                    raw_code = crow.get('代码')
                    if raw_code is None or pd.isna(raw_code):
                        continue
                    leader_code = str(raw_code).strip().zfill(6)
                    raw_name = crow.get('名称')
                    leader_name = (
                        str(raw_name).strip()
                        if raw_name is not None and not pd.isna(raw_name)
                        else None
                    )
                    leader_change_pct = pct
                    leader_row_json = _row_to_jsonable(crow, df_cons.columns)
                    break

                # 全是一字板 / 全部缺数据 → 退而求其次取涨幅最大行（含一字板）
                if leader_code is None:
                    for _, crow in df_cons_sorted.iterrows():
                        raw_code = crow.get('代码')
                        if raw_code is None or pd.isna(raw_code):
                            continue
                        leader_code = str(raw_code).strip().zfill(6)
                        raw_name = crow.get('名称')
                        leader_name = (
                            str(raw_name).strip()
                            if raw_name is not None and not pd.isna(raw_name)
                            else None
                        )
                        leader_change_pct = safe_float_value(crow.get('涨跌幅'))
                        leader_row_json = _row_to_jsonable(crow, df_cons.columns)
                        break

            results.append({
                'trade_date': iso_date,
                'industry_code': industry_code,
                'industry_name': industry_name,
                'change_pct': change_pct,
                'main_inflow': main_inflow,
                'main_inflow_ratio': main_inflow_ratio,
                'leader_stock_code': leader_code,
                'leader_stock_name': leader_name,
                'leader_stock_change_pct': leader_change_pct,
                'advancing_count': advancing_count,
                'declining_count': declining_count,
                'raw_payload': {
                    'fund_flow_row': _row_to_jsonable(frow, df_flow.columns),
                    'board_row': board_row,
                    'leader_row': leader_row_json,
                },
            })

        print(
            f"Parsed {len(results)} industry rows (stamp={iso_date}, "
            f"name_index={len(name_to_board)}, flow_rows={len(df_flow)})",
            file=sys.stderr,
        )
        return results
    except Exception as e:
        print(f"Error getting industry flow for {date}: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        return []


def _cell_str(row, col: Optional[str]) -> Optional[str]:
    """安全读取一格并转字符串；空 / nan 返回 None"""
    if not col:
        return None
    val = row.get(col)
    if val is None or pd.isna(val):
        return None
    s = str(val).strip()
    return s or None


def _cell_float(row, col: Optional[str]) -> Optional[float]:
    """安全读取一格并转 float；空 / nan 返回 None"""
    if not col:
        return None
    return safe_float_value(row.get(col))


def _cell_int(row, col: Optional[str]) -> Optional[int]:
    """安全读取一格并转 int；空 / nan 返回 None"""
    if not col:
        return None
    f = safe_float_value(row.get(col))
    return int(f) if f is not None else None


def _is_one_word(limit_up_time: Optional[str], open_times: Optional[int]) -> bool:
    """一字板判定：首次封板时间 ≤ 09:30:00 且 炸板次数 == 0"""
    if not limit_up_time:
        return False
    # AKShare 返回的时间常见格式 "09:25:03" 或 "92503"
    digits = ''.join(c for c in limit_up_time if c.isdigit())
    if len(digits) >= 6:
        hh, mm = int(digits[0:2]), int(digits[2:4])
    elif len(digits) == 5:
        hh, mm = int(digits[0:1]), int(digits[1:3])
    elif len(digits) == 4:
        hh, mm = int(digits[0:2]), int(digits[2:4])
    else:
        return False
    if (hh, mm) > (9, 30):
        return False
    return (open_times or 0) == 0


def _row_to_jsonable(row, columns) -> Dict[str, Any]:
    """把一行 pandas Series 转成 JSON 友好的 dict（NaN → None, 数字 → float）"""
    raw: Dict[str, Any] = {}
    for col in columns:
        val = row.get(col)
        if pd.isna(val):
            raw[str(col)] = None
        elif isinstance(val, (int, float)):
            raw[str(col)] = float(val)
        else:
            raw[str(col)] = str(val)
    return raw


# 已知 A 股主流指数 → 中文名（用于在 raw_payload 缺名称时兜底）
_KNOWN_INDEX_NAMES: Dict[str, str] = {
    '000016': '上证50',
    '000300': '沪深300',
    '000905': '中证500',
    '000852': '中证1000',
    '000688': '科创50',
    '399006': '创业板指',
    '399330': '深证100',
}


def get_index_components(index_code: str, trade_date: str) -> List[Dict[str, Any]]:
    """
    Fetch the current constituents of an A-share stock index.

    Used by US-020 (CTA100MomentumStrategy reads index_code='000852' = 中证 1000)
    plus future stories US-021 / US-028 that need other indexes. The output is
    stamped with `trade_date` so callers can snapshot the universe daily even
    though AKShare returns the "current" constituents (it has no historical
    constituent endpoint — date is a label, not a filter, same convention as
    industry-flow in US-008).

    Strategy:
      Primary endpoint = `ak.index_stock_cons_sina(symbol=<index_code>)`
        - Returns: 品种代码 / 品种名称 / 纳入日期 (sometimes) / industry classification
        - Most reliable cross-index coverage; works for 000300/000852/000905/000016.
      Fallback endpoint = `ak.index_stock_cons(symbol=<index_code>)`
        - Plain wrapper; called only if sina endpoint dies (rare API outage).
      Weights endpoint (best-effort) = `ak.index_stock_cons_weight_csindex(symbol=...)`
        - 中证指数公司提供权重，但只对 CSI 系列有效 (000300/000852/000905 等)
        - Failing this endpoint is non-fatal — we just emit rows with weight=None.

    Args:
        index_code: 6-digit index code without suffix, e.g. '000852' = 中证 1000.
        trade_date: ISO YYYY-MM-DD or YYYYMMDD. Stamped onto every output row.

    Returns:
        List of dicts: {trade_date, index_code, index_name, stock_code, stock_name,
        weight, raw_payload}. Returns [] on empty / error so caller can
        checkpoint a "tried" date.
    """
    try:
        pure_date = trade_date.replace('-', '')
        iso_date = _format_iso_date(pure_date)

        print(f"Fetching index components for {index_code} (stamp={iso_date})...", file=sys.stderr)

        # ----- 1) Primary: index_stock_cons_sina -----
        df_cons = None
        for fn_name, fn in [
            ('index_stock_cons_sina', getattr(ak, 'index_stock_cons_sina', None)),
            ('index_stock_cons', getattr(ak, 'index_stock_cons', None)),
        ]:
            if fn is None:
                continue
            try:
                df_cons = fn(symbol=index_code)
            except TypeError:
                try:
                    df_cons = fn(index_code)
                except Exception as e:
                    print(f"{fn_name}({index_code}) failed: {e}", file=sys.stderr)
                    df_cons = None
            except Exception as e:
                print(f"{fn_name}({index_code}) failed: {e}", file=sys.stderr)
                df_cons = None

            if df_cons is not None and not df_cons.empty:
                print(f"Got {len(df_cons)} rows from {fn_name}", file=sys.stderr)
                break

        if df_cons is None or df_cons.empty:
            print(f"All AKShare constituent endpoints empty for {index_code}", file=sys.stderr)
            return []

        # ----- 2) Best-effort: 权重表 (CSI 系列) -----
        weights_by_code: Dict[str, float] = {}
        weight_fn = getattr(ak, 'index_stock_cons_weight_csindex', None)
        if weight_fn is not None:
            try:
                df_w = weight_fn(symbol=index_code)
                if df_w is not None and not df_w.empty:
                    # 列名搜索 '成份券代码' / '股票代码' / 'code'，权重列 '权重' / 'weight'
                    code_col = None
                    weight_col = None
                    for col in df_w.columns:
                        col_s = str(col)
                        if col_s in ('成份券代码', '股票代码', '证券代码', 'code') and not code_col:
                            code_col = col_s
                        if col_s in ('权重', '权重(%)', 'weight') and not weight_col:
                            weight_col = col_s
                    if code_col and weight_col:
                        for _, wr in df_w.iterrows():
                            raw_c = wr.get(code_col)
                            if raw_c is None or pd.isna(raw_c):
                                continue
                            c_str = str(raw_c).strip().zfill(6)
                            w_val = safe_float_value(wr.get(weight_col))
                            if w_val is not None:
                                weights_by_code[c_str] = w_val
                        print(f"Loaded {len(weights_by_code)} weights from csindex", file=sys.stderr)
            except Exception as e:
                # 非致命；权重缺失就发 None
                print(f"Weight endpoint failed (non-fatal): {e}", file=sys.stderr)

        # ----- 3) 列名柔性映射 -----
        code_col: Optional[str] = None
        name_col: Optional[str] = None
        for col in df_cons.columns:
            col_s = str(col)
            if col_s in ('品种代码', '股票代码', '证券代码', 'code', 'symbol') and not code_col:
                code_col = col_s
            if col_s in ('品种名称', '股票名称', '证券简称', 'name', '股票简称') and not name_col:
                name_col = col_s

        if not code_col:
            print(f"Cannot locate stock_code column in df_cons. cols={list(df_cons.columns)}", file=sys.stderr)
            return []

        index_name = _KNOWN_INDEX_NAMES.get(index_code)

        result: List[Dict[str, Any]] = []
        seen_codes = set()
        for _, row in df_cons.iterrows():
            raw_code = row.get(code_col)
            if raw_code is None or pd.isna(raw_code):
                continue
            stock_code = str(raw_code).strip().zfill(6)
            # 跳过已重复或非数字代码（部分接口含非 A 股标的）
            if not stock_code.isdigit() or len(stock_code) != 6:
                continue
            if stock_code in seen_codes:
                continue
            seen_codes.add(stock_code)

            stock_name = None
            if name_col:
                raw_n = row.get(name_col)
                if raw_n is not None and not pd.isna(raw_n):
                    stock_name = str(raw_n).strip() or None

            weight = weights_by_code.get(stock_code)

            result.append({
                "trade_date": iso_date,
                "index_code": index_code,
                "index_name": index_name,
                "stock_code": stock_code,
                "stock_name": stock_name,
                "weight": weight,
                "raw_payload": _row_to_jsonable(row, df_cons.columns),
            })

        print(f"Parsed {len(result)} index constituents for {index_code}", file=sys.stderr)
        return result
    except Exception as e:
        print(f"Error getting index components for {index_code}: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        return []


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

        elif command == "get_realtime_quotes":
            if len(sys.argv) < 3:
                print(json.dumps({"error": "Missing symbols for get_realtime_quotes"}), file=sys.stderr)
                sys.exit(1)
            
            symbols = sys.argv[2]
            result = get_realtime_quotes(symbols)
            
        elif command == "get_intraday_bars":
            if len(sys.argv) < 3:
                print(json.dumps({"error": "Missing code for get_intraday_bars"}), file=sys.stderr)
                sys.exit(1)
                
            code = sys.argv[2]
            period = sys.argv[3] if len(sys.argv) > 3 else "1m"
            limit = int(sys.argv[4]) if len(sys.argv) > 4 else 240
            
            result = get_intraday_bars(code, period, limit)

        elif command == "health_check":
            if len(sys.argv) < 5:
                print(json.dumps({"error": "Missing parameters for health_check"}), file=sys.stderr)
                sys.exit(1)

            code = sys.argv[2]
            start_date = sys.argv[3]
            end_date = sys.argv[4]
            result = health_check(code, start_date, end_date)

        elif command == "get_northbound_holdings":
            if len(sys.argv) < 3:
                print(json.dumps({"error": "Missing date for get_northbound_holdings"}), file=sys.stderr)
                sys.exit(1)

            date = sys.argv[2]
            market = sys.argv[3] if len(sys.argv) > 3 else "北向"
            result = get_northbound_holdings(date, market)

        elif command == "get_dragon_tiger_detail":
            if len(sys.argv) < 3:
                print(json.dumps({"error": "Missing date for get_dragon_tiger_detail"}), file=sys.stderr)
                sys.exit(1)

            date = sys.argv[2]
            result = get_dragon_tiger_detail(date)

        elif command == "get_limit_up_pool":
            if len(sys.argv) < 3:
                print(json.dumps({"error": "Missing date for get_limit_up_pool"}), file=sys.stderr)
                sys.exit(1)

            date = sys.argv[2]
            result = get_limit_up_pool(date)

        elif command == "get_industry_flow":
            if len(sys.argv) < 3:
                print(json.dumps({"error": "Missing date for get_industry_flow"}), file=sys.stderr)
                sys.exit(1)

            date = sys.argv[2]
            result = get_industry_flow(date)

        elif command == "get_earnings_forecast":
            if len(sys.argv) < 3:
                print(json.dumps({"error": "Missing report_period for get_earnings_forecast"}), file=sys.stderr)
                sys.exit(1)

            report_period = sys.argv[2]
            result = get_earnings_forecast(report_period)

        elif command == "get_index_components":
            if len(sys.argv) < 4:
                print(json.dumps({"error": "Missing index_code or trade_date for get_index_components"}), file=sys.stderr)
                sys.exit(1)

            index_code = sys.argv[2]
            trade_date = sys.argv[3]
            result = get_index_components(index_code, trade_date)

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
