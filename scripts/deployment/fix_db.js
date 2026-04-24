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
    console.log('🔧 修复数据库列');
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

    // 先看一下 docker 环境变量里的 PG 密码
    const commands = `
cd /opt/stocks

echo "=============================================="
echo "检查当前 users 表结构"
echo "=============================================="
docker exec stock_postgres psql -U stock_admin -d stock_backtest -c "\\d users"

echo ""
echo "=============================================="
echo "检查数据库容器的环境变量"
echo "=============================================="
docker exec stock_postgres printenv | grep POSTGRES

echo ""
echo "=============================================="
echo "执行 SQL 修改"
echo "=============================================="
docker exec stock_postgres psql -U stock_admin -d stock_backtest -c "DO \\\$\\\$
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
echo "删除旧的 wxpusher_uid 列（如果存在）"
echo "=============================================="
docker exec stock_postgres psql -U stock_admin -d stock_backtest -c "DO \\\$\\\$
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
echo "验证最终表结构"
echo "=============================================="
docker exec stock_postgres psql -U stock_admin -d stock_backtest -c "\\d users"

echo ""
echo "✅ 数据库修复完成！重启后端服务..."
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
        console.log('\n🎉 完成！现在可以尝试登录了');
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
