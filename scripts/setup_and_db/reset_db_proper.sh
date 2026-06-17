#!/bin/bash
# Batch W (2026-06-17): 加 ALLOW_RESET_DB guard + --i-know-what-im-doing.
set -euo pipefail

if [ "${ALLOW_RESET_DB:-}" != "true" ]; then
  echo "[SAFE-GUARD] reset_db_proper.sh 是 prod 数据销毁脚本. 如确认请: ALLOW_RESET_DB=true bash reset_db_proper.sh --i-know-what-im-doing" >&2
  exit 1
fi

if [ "${1:-}" != "--i-know-what-im-doing" ]; then
  echo "[SAFE-GUARD] 缺少 --i-know-what-im-doing flag." >&2
  exit 1
fi

echo "[RESET-DB-PROPER] hostname=$(hostname), date=$(date)"
read -r -p "[RESET-DB-PROPER] 输入 'RESET-PROD-DB' 确认: " CONFIRM
if [ "$CONFIRM" != "RESET-PROD-DB" ]; then
  echo "[SAFE-GUARD] abort." >&2
  exit 1
fi

cd /opt/stocks

echo "Resetting database completely..."
docker-compose down
docker volume rm stocks_postgres_data || true
docker-compose up -d
echo "Waiting for postgres to start..."
sleep 15

# Manually create tables using the full schema since Sequelize alter fails on enum types
cat /opt/stocks/scripts/init-db-full.sql | docker-compose exec -T postgres psql -U postgres -d stock_backtest

# Now run the script to insert the two users
cd /opt/stocks/backend
node insert_users_docker.js

# Restart backend
NODE_ENV=production pm2 restart stock-backend
