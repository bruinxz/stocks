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
    console.log('🔍 检查服务状态和日志');
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
echo "PM2 服务状态"
echo "=============================================="
pm2 status

echo ""
echo "=============================================="
echo "后端最后 50 行日志"
echo "=============================================="
pm2 logs stock-backend --nostream --lines 50 --err

echo ""
echo "=============================================="
echo "检查 API 端口是否正常"
echo "=============================================="
netstat -tlnp | grep 3000

echo ""
echo "=============================================="
echo "简单测试后端是否响应"
echo "=============================================="
curl -s http://127.0.0.1:3000/health || echo "health endpoint 可能不存在"
curl -s -X POST http://127.0.0.1:3000/api/auth/login -H "Content-Type: application/json" -d '{"username":"lym","password":"666"}'
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

    stream.stderr.on('data', (data) => {
      process.stderr.write(data.toString());
    });

    await new Promise((resolve) => {
      stream.on('close', (code, signal) => {
        console.log('\n✅ 检查完成');
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
