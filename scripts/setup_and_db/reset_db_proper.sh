#!/bin/bash
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
