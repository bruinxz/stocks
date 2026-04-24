const { Client } = require('ssh2');

const config = {
  host: '103.242.3.87',
  port: 14126,
  username: 'root',
  password: '7tsA0wS62A1e'
};

async function main() {
  const conn = new Client();

  try {
    console.log('🔧 修复数据库 (简化版)');
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

# 直接执行 ALTER，即使出错也继续
docker exec stock_postgres psql -U postgres -d stock_backtest -c "ALTER TABLE users ADD COLUMN IF NOT EXISTS pushplus_token VARCHAR(100);"

docker exec stock_postgres psql -U postgres -d stock_backtest -c "ALTER TABLE users DROP COLUMN IF EXISTS wxpusher_uid;"

# 验证
docker exec stock_postgres psql -U postgres -d stock_backtest -c "\\d users"

# 重启
pm2 restart stock-backend
sleep 2
pm2 status

# 简单测试登录
echo ""
echo "测试后端登录接口..."
curl -X POST http://127.0.0.1:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"lym","password":"666"}'
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
