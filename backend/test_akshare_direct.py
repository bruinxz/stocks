#!/usr/bin/env python3
"""
直接测试AKShare API，验证股票代码格式和参数
"""
import sys
import json
import akshare as ak
import pandas as pd
from datetime import datetime

def test_stock_zh_a_daily():
    """测试stock_zh_a_daily方法"""
    print("=== 测试 stock_zh_a_daily ===")

    # 测试不同的股票代码格式
    test_cases = [
        ("sz000001", "深圳平安银行"),
        ("sh000001", "上证指数"),
        ("000001", "纯代码（无前缀）"),
    ]

    for symbol, desc in test_cases:
        print(f"\n测试 {desc} ({symbol}):")
        try:
            df = ak.stock_zh_a_daily(
                symbol=symbol,
                start_date="20240301",
                end_date="20240305",
                adjust="qfq"
            )
            print(f"  成功: 获取到 {len(df)} 行数据")
            if not df.empty:
                print(f"  列名: {list(df.columns)}")
                print(f"  示例行:")
                print(f"    日期: {df.iloc[0]['date']}")
                print(f"    开盘: {df.iloc[0]['open']}")
                print(f"    收盘: {df.iloc[0]['close']}")
        except Exception as e:
            print(f"  失败: {e}")

def test_stock_zh_a_hist():
    """测试stock_zh_a_hist方法"""
    print("\n\n=== 测试 stock_zh_a_hist ===")

    test_cases = [
        ("000001", "纯代码"),
        ("600000", "上海股票"),
    ]

    for symbol, desc in test_cases:
        print(f"\n测试 {desc} ({symbol}):")
        try:
            df = ak.stock_zh_a_hist(
                symbol=symbol,
                period="daily",
                start_date="20240301",
                end_date="20240305",
                adjust="qfq"
            )
            print(f"  成功: 获取到 {len(df)} 行数据")
            if not df.empty:
                print(f"  列名: {list(df.columns)}")
        except Exception as e:
            print(f"  失败: {e}")

def test_parse_date():
    """测试日期解析函数"""
    print("\n\n=== 测试日期解析 ===")

    test_dates = [
        "2024-03-01",
        "2024-12-31",
        "2023-01-15"
    ]

    for date_str in test_dates:
        parsed = date_str.replace("-", "")
        print(f"  {date_str} -> {parsed}")

def test_helper_logic():
    """测试akshare_helper.py中的逻辑"""
    print("\n\n=== 测试helper逻辑 ===")

    # 模拟akshare_helper.py中的代码
    code = "sh.000001"

    # 提取纯代码
    pure_code = code
    if code.startswith('sh.') or code.startswith('sz.') or code.startswith('bj.'):
        pure_code = code.split('.')[1]

    print(f"原始代码: {code}")
    print(f"纯代码: {pure_code}")

    # 测试两种格式
    print("\n测试带前缀的代码:")
    try:
        df1 = ak.stock_zh_a_daily(
            symbol="sz000001",  # 带前缀
            start_date="20240301",
            end_date="20240305",
            adjust="qfq"
        )
        print(f"  成功: {len(df1)} 行")
    except Exception as e:
        print(f"  失败: {e}")

    print("\n测试纯代码:")
    try:
        df2 = ak.stock_zh_a_daily(
            symbol="000001",  # 纯代码
            start_date="20240301",
            end_date="20240305",
            adjust="qfq"
        )
        print(f"  成功: {len(df2)} 行")
    except Exception as e:
        print(f"  失败: {e}")

if __name__ == "__main__":
    print("AKShare版本:", ak.__version__)

    test_stock_zh_a_daily()
    test_stock_zh_a_hist()
    test_parse_date()
    test_helper_logic()