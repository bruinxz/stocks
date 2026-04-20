#!/bin/bash
set -e

# 1. Install Node.js if missing
if ! command -v node &> /dev/null; then
    echo "Installing Node.js v18..."
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
    apt-get install -y nodejs
fi

# 2. Install Docker if missing
if ! command -v docker &> /dev/null; then
    echo "Installing Docker..."
    curl -fsSL https://get.docker.com -o get-docker.sh
    sh get-docker.sh
fi

# 3. Install Docker Compose if missing
if ! command -v docker-compose &> /dev/null; then
    echo "Installing Docker Compose..."
    apt-get install -y docker-compose
fi

# 4. Install PM2
if ! command -v pm2 &> /dev/null; then
    echo "Installing PM2..."
    npm install -g pm2
fi

echo "Starting Docker containers..."
cd /opt/stocks
docker-compose up -d

echo "Setting up Backend..."
cd /opt/stocks/backend
npm install
if [ ! -f .env ]; then
    cp .env.example .env
fi
npm run build
NODE_ENV=production pm2 start dist/index.js --name stock-backend || pm2 restart stock-backend

echo "Setting up Frontend..."
cd /opt/stocks/frontend
npm install --legacy-peer-deps
npm run build
pm2 serve build 3001 --name stock-frontend --spa

echo "Deployment complete."
