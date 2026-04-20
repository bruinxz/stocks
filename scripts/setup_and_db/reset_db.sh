#!/bin/bash
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
