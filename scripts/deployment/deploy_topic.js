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
    console.log('🚀 开始部署群组推送更新...');
    
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

echo "1. 更新代码..."
git pull

echo "2. 更新后端 .env..."
cat > /opt/stocks/backend/.env << 'ENV_EOF'
DB_HOST=127.0.0.1
DB_PORT=5432
DB_NAME=stock_backtest
DB_USER=postgres
DB_PASSWORD='x8Vq\$9pL2#mK7@nW1cF5^jY3!bH4*gD'
DB_SSL=false

REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=0

JWT_SECRET=your-secret-key-change-in-production
JWT_REFRESH_SECRET=your-refresh-secret-key-change-in-production

NODE_ENV=development
PORT=3000
INTERNAL_API_KEY=tr_agent_k8s_x9a1!b2c3d4e5f6g7h8i9j0

# PushPlus 微信群组推送配置
PUSHPLUS_TOKEN=261ae301eaf34c8ba4e0c67c8cd5ca78
PUSHPLUS_TOPIC=stock_alerts
FRONTEND_BASE_URL=http://103.242.3.87:3001
ENV_EOF

echo "3. 更新前端环境变量..."
cat > /opt/stocks/frontend/.env.production << 'ENV_EOF'
REACT_APP_API_BASE_URL=http://103.242.3.87:3000/api
REACT_APP_WS_URL=ws://103.242.3.87:3000
REACT_APP_ENV=production
REACT_APP_PUSHPLUS_QRCODE_URL=https://www.pushplus.plus/api/common/qrcode/group/261ae301eaf34c8ba4e0c67c8cd5ca78
ENV_EOF

echo "4. 重新构建后端..."
cd /opt/stocks/backend && npm run build

echo "5. 重新构建前端..."
cd /opt/stocks/frontend && CI=false npm run build

echo "6. 重启服务..."
pm2 restart stock-backend
pm2 restart stock-frontend

echo "部署完成！"
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
