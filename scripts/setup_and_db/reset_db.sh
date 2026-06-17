#!/bin/bash
# Batch W (2026-06-17): 加 --confirm + ALLOW_RESET_DB guard.
# 之前任何人 bash reset_db.sh 直接炸 prod 库 (docker volume rm postgres_data).
# 现在必须显式 ALLOW_RESET_DB=true bash reset_db.sh --i-know-what-im-doing.
set -euo pipefail

if [ "${ALLOW_RESET_DB:-}" != "true" ]; then
  echo "[SAFE-GUARD] reset_db.sh 会 docker-compose down + 删 postgres volume + 重置全库." >&2
  echo "[SAFE-GUARD] 这是不可逆的破坏性操作. 如确认请: ALLOW_RESET_DB=true bash reset_db.sh --i-know-what-im-doing" >&2
  exit 1
fi

if [ "${1:-}" != "--i-know-what-im-doing" ]; then
  echo "[SAFE-GUARD] 缺少 --i-know-what-im-doing flag. 这是 prod 数据销毁脚本." >&2
  exit 1
fi

# 提示 host 信息让运维确认是否真的在 prod
echo "[RESET-DB] hostname=$(hostname), date=$(date)"
read -r -p "[RESET-DB] 输入 'RESET-PROD-DB' 确认: " CONFIRM
if [ "$CONFIRM" != "RESET-PROD-DB" ]; then
  echo "[SAFE-GUARD] 确认字符串不匹配, abort." >&2
  exit 1
fi

cd /opt/stocks

# Stop containers
docker-compose down

# Remove old volumes to reset postgres password
docker volume rm stocks_postgres_data || true

# Start containers again
docker-compose up -d

echo "Waiting for postgres to be ready..."
sleep 10

# Restart backend to trigger Sequelize sync
cd /opt/stocks/backend
NODE_ENV=production pm2 restart stock-backend
sleep 5

# Run the user insertion script
node insert_users_docker.js
