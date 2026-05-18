const { requireLegacyDeploymentUnlock } = require('./legacy_guard');
requireLegacyDeploymentUnlock(__filename);

const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');
const { getDeployConfig } = require('./deploy_config');

const deployConfig = getDeployConfig();

const config = {
  ...deployConfig.ssh
};

async function main() {
  const conn = new Client();

  try {
    console.log('🔧 修复数据库 (通过临时文件)');
    console.log('='.repeat(60));

    await new Promise((resolve, reject) => {
      conn
        .on('ready', () => {
        console.log('✅ SSH 连接成功');
        resolve();
      })
        .on('error', reject)
        .connect(config);
    });

    const sqlContent = `ALTER TABLE users ADD COLUMN IF NOT EXISTS pushplus_token VARCHAR(100);
ALTER TABLE users DROP COLUMN IF EXISTS wxpusher_uid;
`;

    const commands = `
cd /opt/stocks

# 创建临时 SQL 文件
cat > /tmp/migrate.sql << 'EOF'
${sqlContent}
EOF

echo "✅ 临时文件创建成功，执行 SQL..."

# 执行
docker exec -i stock_postgres psql -U postgres -d stock_backtest < /tmp/migrate.sql

# 验证表结构
echo ""
echo "验证表结构:"
docker exec stock_postgres psql -U postgres -d stock_backtest -c "\\d users"

# 重启后端
echo ""
echo "重启后端服务..."
pm2 restart stock-backend
sleep 2
pm2 status

# 测试登录
echo ""
echo "测试登录..."
curl -s -X POST http://127.0.0.1:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"lym","password":"666"}'

# 清理临时文件
rm -f /tmp/migrate.sql

echo ""
echo "✅ 全部完成！"
`;

    const stream = await new Promise((resolve, reject) => {
      conn.exec(commands, (err, stream) => {
        if (err) reject(err);
        else resolve(stream);
      });
    });

    stream.on('data', (data) => {
      process.stdout.write(data.toString());
    });

    await new Promise((resolve) => {
      stream.on('close', (code, signal) => {
        console.log('\n🎉 完成！现在尝试登录！');
        resolve(code);
      });
    });

  } catch (err) {
    console.error('\n❌ 出错:', err.message);
  } finally {
    conn.end();
  }
}

main();
