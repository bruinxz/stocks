#!/bin/bash

if [ "${ALLOW_LEGACY_DEPLOYMENT_SCRIPT:-}" != "true" ]; then
  echo "[SAFE-GUARD] $0 is a legacy deployment script and is disabled by default." >&2
  echo "[SAFE-GUARD] Use scripts/deployment/sync_and_deploy.js or scripts/deployment/simple_deploy.js instead." >&2
  echo "[SAFE-GUARD] If you must run it after source review, set ALLOW_LEGACY_DEPLOYMENT_SCRIPT=true explicitly." >&2
  exit 1
fi

set -e

SSH_HOST="<legacy-prod-host>"
SSH_PORT="14126"
SSH_USER="${DEPLOY_USER:-${SSH_USER:-deploy}}"
SSH_PASS="${DEPLOY_PASSWORD:-${SSH_PASSWORD:-}}"
PG_PASS="${DEPLOY_PG_PASSWORD:-${DB_PASSWORD:-}}"

if [ -z "$SSH_PASS" ] || [ -z "$PG_PASS" ]; then
  echo "DEPLOY_PASSWORD/SSH_PASSWORD and DEPLOY_PG_PASSWORD/DB_PASSWORD are required." >&2
  exit 1
fi

export SSH_PASS PG_PASS

echo "🚀 开始 PushPlus 迁移部署"
echo "="

# 1. 创建临时部署包
echo "📦 准备部署文件..."
mkdir -p /tmp/stocks_deploy/backend
mkdir -p /tmp/stocks_deploy/frontend

cp -r backend/src /tmp/stocks_deploy/backend/
cp backend/package.json /tmp/stocks_deploy/backend/
cp backend/package-lock.json /tmp/stocks_deploy/backend/
cp backend/tsconfig.json /tmp/stocks_deploy/backend/
cp backend/.env /tmp/stocks_deploy/backend/

cp -r frontend/src /tmp/stocks_deploy/frontend/
cp frontend/package.json /tmp/stocks_deploy/frontend/
cp frontend/package-lock.json /tmp/stocks_deploy/frontend/
cp frontend/tsconfig.json /tmp/stocks_deploy/frontend/
cp -r frontend/public /tmp/stocks_deploy/frontend/ 2>/dev/null || true

# 2. 删除不需要同步的旧文件
rm -f /tmp/stocks_deploy/backend/src/services/WxPusherService.ts
rm -f /tmp/stocks_deploy/backend/src/services/WechatSceneStore.ts
rm -f /tmp/stocks_deploy/backend/src/api/routes/wechat.routes.ts

# 3. SFTP 上传
echo "📤 上传文件到服务器..."
expect << EOF
set timeout 600
spawn sftp -o Port=$SSH_PORT $SSH_USER@$SSH_HOST
expect "password:"
send "$SSH_PASS\r"
expect "sftp>"
send "cd /opt/stocks\r"
expect "sftp>"
send "put -r /tmp/stocks_deploy/backend/* /opt/stocks/backend/\r"
expect "sftp>"
send "put -r /tmp/stocks_deploy/frontend/* /opt/stocks/frontend/\r"
expect "sftp>"
send "quit\r"
expect eof
EOF

# 4. SSH 执行部署
echo "🔧 在服务器执行部署..."
expect << 'EOF'
set timeout 1200
spawn ssh -p $SSH_PORT $SSH_USER@$SSH_HOST
expect "password:"
send "$env(SSH_PASS)\r"
expect "#"

# 数据库迁移
send "PGPASSWORD='$env(PG_PASS)' docker exec -i stock_postgres psql -U stock_admin -d stock_backtest << 'END_SQL'\r"
send "DO $$\r"
send "BEGIN\r"
send "  IF NOT EXISTS (\r"
send "    SELECT 1 FROM information_schema.columns\r"
send "    WHERE table_name = 'users' AND column_name = 'pushplus_token'\r"
send "  ) THEN\r"
send "    ALTER TABLE users ADD COLUMN pushplus_token VARCHAR(100) DEFAULT NULL;\r"
send "    RAISE NOTICE '新增 pushplus_token 列成功';\r"
send "  ELSE\r"
send "    RAISE NOTICE 'pushplus_token 列已存在，跳过';\r"
send "  END IF;\r"
send "END $$;\r"
send "\r"
send "DO $$\r"
send "BEGIN\r"
send "  IF EXISTS (\r"
send "    SELECT 1 FROM information_schema.columns\r"
send "    WHERE table_name = 'users' AND column_name = 'wxpusher_uid'\r"
send "  ) THEN\r"
send "    ALTER TABLE users DROP COLUMN wxpusher_uid;\r"
send "    RAISE NOTICE '移除 wxpusher_uid 列成功';\r"
send "  ELSE\r"
send "    RAISE NOTICE 'wxpusher_uid 列不存在，跳过';\r"
send "  END IF;\r"
send "END $$;\r"
send "END_SQL\r"
expect "#"

send "echo '✅ 数据库迁移完成'\r"
expect "#"

# 构建后端
send "cd /opt/stocks/backend && npm run build\r"
expect "#"

# 构建前端
send "cd /opt/stocks/frontend && CI=false npm run build\r"
expect "#"

# 重启服务
send "pm2 restart stock-backend && pm2 restart stock-frontend\r"
expect "#"

# 检查状态
send "pm2 status\r"
expect "#"

send "echo '' && echo '================================================================================' && echo '🎉 部署完成！' && echo '================================================================================'\r"

send "exit\r"
expect eof
EOF

# 清理
rm -rf /tmp/stocks_deploy
echo "🗑️ 清理临时文件完成"
