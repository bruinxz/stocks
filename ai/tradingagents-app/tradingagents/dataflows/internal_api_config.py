import os

# 迁移合并 (2026-07-04): TradingAgents 已 vendored 进 bruinxz/stocks 单仓 (ai/tradingagents-app).
# 数据源统一以 stocks Node 后端 (/api/internal/*) 为 A 股行情/基本面唯一真源;
# 本文件仅保留地址/密钥的读取入口, 不再内联任何默认密钥 —— 一律从共享 .env 注入.
#   · INTERNAL_API_BASE_URL: 本机开发默认 http://127.0.0.1:3000; 线上经 env 覆盖.
#   · INTERNAL_API_KEY:      与 stocks backend/.env 的 INTERNAL_API_KEY 同值, 必填, 无默认.
INTERNAL_API_BASE_URL = os.getenv("INTERNAL_API_BASE_URL", "http://127.0.0.1:3000")
INTERNAL_API_KEY = os.getenv("INTERNAL_API_KEY", "")


def get_internal_api_headers():
    return {
        "X-API-Key": INTERNAL_API_KEY,
        "Content-Type": "application/json",
    }
