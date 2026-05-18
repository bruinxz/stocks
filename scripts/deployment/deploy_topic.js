const { requireLegacyDeploymentUnlock } = require('./legacy_guard');
requireLegacyDeploymentUnlock(__filename);

const { Client } = require('ssh2');
const { getDeployConfig, renderBackendEnv, renderFrontendEnv } = require('./deploy_config');

const deployConfig = getDeployConfig();

const config = {
  ...deployConfig.ssh
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
${renderBackendEnv(deployConfig.backend_env)}
ENV_EOF

echo "3. 更新前端环境变量..."
cat > /opt/stocks/frontend/.env.production << 'ENV_EOF'
${renderFrontendEnv(deployConfig.frontend_env)}
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
