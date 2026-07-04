import os
from urllib.parse import quote_plus

# 迁移合并 (2026-07-04): 与 stocks 单仓共用同一 Postgres 库 (stock_backtest).
# 不再内联真实库密码默认值 —— 从共享 .env 注入 (POSTGRES_PASSWORD 必填).
# 本机开发若未设, 空密码仅用于本地起库调试, 线上一律经 env 覆盖.
POSTGRES_USER = os.getenv("POSTGRES_USER", "postgres")
POSTGRES_PASSWORD = os.getenv("POSTGRES_PASSWORD", "")
POSTGRES_HOST = os.getenv("POSTGRES_HOST", "127.0.0.1")
POSTGRES_PORT = os.getenv("POSTGRES_PORT", "5432")
POSTGRES_DB = os.getenv("POSTGRES_DB", "stock_backtest")

# Safely construct the DATABASE_URL
_password = quote_plus(POSTGRES_PASSWORD)
DATABASE_URL = f"postgresql://{POSTGRES_USER}:{_password}@{POSTGRES_HOST}:{POSTGRES_PORT}/{POSTGRES_DB}"
print("Using DATABASE_URL:", f"postgresql://{POSTGRES_USER}:***@{POSTGRES_HOST}:{POSTGRES_PORT}/{POSTGRES_DB}")

REDIS_HOST = os.getenv("REDIS_HOST", "127.0.0.1")
REDIS_PORT = os.getenv("REDIS_PORT", "6379")
REDIS_DB = os.getenv("REDIS_DB", "0")
REDIS_URL = f"redis://{REDIS_HOST}:{REDIS_PORT}/{REDIS_DB}"
