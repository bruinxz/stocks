const { requireLegacyDeploymentUnlock } = require('./legacy_guard');
requireLegacyDeploymentUnlock(__filename);

const { Client } = require('ssh2');
const { getDeployConfig, shellQuote } = require('./deploy_config');

const deployConfig = getDeployConfig();

const config = {
  ...deployConfig.ssh
};

async function main() {
  const conn = new Client();

  try {
    console.log('🔧 终极修复数据库！');
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

    const commands = `
cd /opt/stocks

# 直接在容器内创建并执行
docker exec stock_postgres sh -c "
cat > /tmp/migrate.sql << 'ENDOF'
ALTER TABLE users ADD COLUMN IF NOT EXISTS pushplus_token VARCHAR(100);
ALTER TABLE users DROP COLUMN IF EXISTS wxpusher_uid;
ENDOF

# 执行 SQL
PGPASSWORD=${shellQuote(deployConfig.postgres.password)} psql -U ${deployConfig.postgres.user} -d ${deployConfig.postgres.database} < /tmp/migrate.sql

# 验证
PGPASSWORD=${shellQuote(deployConfig.postgres.password)} psql -U ${deployConfig.postgres.user} -d ${deployConfig.postgres.database} -c '\\d users'

# 清理
rm /tmp/migrate.sql
"

echo ""
echo "✅ SQL 执行完成！"
echo ""

# 重启后端
echo "重启后端..."
pm2 restart stock-backend
sleep 3

echo "检查 PM2 状态"
pm2 status

echo ""
echo "✅ 完成！"
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
        console.log('\n🎉 搞定！');
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
