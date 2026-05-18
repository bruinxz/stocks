const { requireLegacyDeploymentUnlock } = require('./legacy_guard');
requireLegacyDeploymentUnlock(__filename);

const { Client } = require('ssh2');
const { getDeployConfig, renderBackendEnv, shellQuote } = require('./deploy_config');

const deployConfig = getDeployConfig();

const config = {
  ...deployConfig.ssh
};

async function main() {
  const conn = new Client();

  try {
    console.log('🚀 开始 PushPlus 迁移部署');
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

    // 一次性发送所有部署命令
    const commands = `
cd /opt/stocks

# 1. 拉取代码
echo "📌 拉取代码..."
git pull

# 2. 数据库迁移
echo "📌 数据库迁移..."
PGPASSWORD=${shellQuote(deployConfig.postgres.password)} docker exec -i ${deployConfig.postgres.docker_container} psql -U ${deployConfig.postgres.user} -d ${deployConfig.postgres.database} << 'END_SQL'
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'pushplus_token'
  ) THEN
    ALTER TABLE users ADD COLUMN pushplus_token VARCHAR(100) DEFAULT NULL;
    RAISE NOTICE '新增 pushplus_token 列成功';
  ELSE
    RAISE NOTICE 'pushplus_token 列已存在，跳过';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'wxpusher_uid'
  ) THEN
    ALTER TABLE users DROP COLUMN wxpusher_uid;
    RAISE NOTICE '移除 wxpusher_uid 列成功';
  ELSE
    RAISE NOTICE 'wxpusher_uid 列不存在，跳过';
  END IF;
END $$;
END_SQL

echo "✅ 数据库迁移完成"

# 3. 更新 .env 文件
cat > /opt/stocks/backend/.env << 'ENV_EOF'
${renderBackendEnv(deployConfig.backend_env)}
ENV_EOF

echo "✅ 环境变量更新完成"

# 4. 构建后端
echo "📌 构建后端..."
cd /opt/stocks/backend && npm run build
echo "✅ 后端构建完成"

# 5. 构建前端
echo "📌 构建前端..."
cd /opt/stocks/frontend && CI=false npm run build
echo "✅ 前端构建完成"

# 6. 重启服务
echo "📌 重启服务..."
pm2 restart stock-backend
pm2 restart stock-frontend
echo "✅ 服务重启完成"

# 7. 检查服务状态
pm2 status

echo ''
echo '================================================================================'
echo '🎉 部署完成！'
echo '================================================================================'
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
        resolve(code);
      });
    });

  } catch (err) {
    console.error('\n❌ 部署过程中发生错误:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    conn.end();
  }
}

main();
