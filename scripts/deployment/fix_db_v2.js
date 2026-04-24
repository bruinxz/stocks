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
    console.log('🔧 修复数据库 (修正用户名)');
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

echo "=============================================="
echo "添加 pushplus_token 列"
echo "=============================================="
docker exec stock_postgres psql -U postgres -d stock_backtest -c "DO \\\$\\\$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'pushplus_token'
  ) THEN
    ALTER TABLE users ADD COLUMN pushplus_token VARCHAR(100);
    RAISE NOTICE '✅ 新增 pushplus_token 列成功';
  ELSE
    RAISE NOTICE '✅ pushplus_token 列已存在';
  END IF;
END \\\$\\\$;"

echo ""
echo "=============================================="
echo "删除 wxpusher_uid 列"
echo "=============================================="
docker exec stock_postgres psql -U postgres -d stock_backtest -c "DO \\\$\\\$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'wxpusher_uid'
  ) THEN
    ALTER TABLE users DROP COLUMN wxpusher_uid;
    RAISE NOTICE '✅ 删除 wxpusher_uid 列成功';
  ELSE
    RAISE NOTICE '✅ wxpusher_uid 列不存在';
  END IF;
END \\\$\\\$;"

echo ""
echo "=============================================="
echo "验证"
echo "=============================================="
docker exec stock_postgres psql -U postgres -d stock_backtest -c "\\d users"

echo ""
echo "✅ 完成！重启后端..."
pm2 restart stock-backend
sleep 2
pm2 status
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
        console.log('\n🎉 完成！现在应该可以登录了！');
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
