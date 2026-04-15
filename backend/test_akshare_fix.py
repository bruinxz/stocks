#!/usr/bin/env python3
"""
测试修复后的AKShare helper
"""
import sys
import os
import json

# 添加当前目录到路径
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

# 导入akshare_helper模块
from python.akshare_helper import get_daily_data

def test_get_daily_data():
    """测试get_daily_data函数"""
    print("=== 测试get_daily_data函数 ===")

    test_cases = [
        ("sz.000001", "平安银行（深圳）"),
        ("sh.600000", "浦发银行（上海）"),
    ]

    for code, desc in test_cases:
        print(f"\n测试 {desc} ({code}):")
        try:
            data = get_daily_data(
                code=code,
                start_date="2024-03-01",
                end_date="2024-03-05",
                adjust="2"  # qfq
            )

            print(f"  成功获取 {len(data)} 条数据")
            if data:
                print(f"  示例数据:")
                for i in range(min(2, len(data))):
                    d = data[i]
                    print(f"    日期: {d['date']}, 开盘: {d['open']}, 收盘: {d['close']}, 成交量: {d['volume']}")
        except Exception as e:
            print(f"  失败: {e}")
            import traceback
            traceback.print_exc()

def test_command_line():
    """测试命令行调用"""
    print("\n\n=== 测试命令行调用 ===")

    # 模拟命令行参数
    test_args = [
        ["get_daily_data", "sz.000001", "2024-03-01", "2024-03-05", "2"],
        ["get_daily_data", "sh.600000", "2024-03-01", "2024-03-05", "2"],
    ]

    for args in test_args:
        print(f"\n测试: python akshare_helper.py {' '.join(args)}")

        # 保存原始sys.argv
        original_argv = sys.argv
        try:
            sys.argv = ["akshare_helper.py"] + args

            # 直接调用main函数
            from python.akshare_helper import main
            main()
        except SystemExit as e:
            print(f"  退出代码: {e.code}")
        except Exception as e:
            print(f"  失败: {e}")
        finally:
            sys.argv = original_argv

if __name__ == "__main__":
    test_get_daily_data()
    # test_command_line()  # 这个会退出进程，暂时注释