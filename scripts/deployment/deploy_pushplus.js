const { requireLegacyDeploymentUnlock } = require('./legacy_guard');
requireLegacyDeploymentUnlock(__filename);

const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');
const { getDeployConfig, shellQuote } = require('./deploy_config');

const deployConfig = getDeployConfig();

const config = {
  ...deployConfig.ssh
};

async function execCommand(conn, command, description) {
  return new Promise((resolve, reject) => {
    console.log(`\n📌 ${description}...`);
    conn.exec(command, (err, stream) => {
      if (err) {
        console.error(`❌ ${description} 失败:`, err.message);
        reject(err);
        return;
      }
      let stdout = '';
      let stderr = '';
      stream
        .on('close', (code, signal) => {
          if (code === 0) {
            console.log(`✅ ${description} 成功完成！`);
            resolve(stdout);
          } else {
            console.error(`❌ ${description} 失败，退出码:`, code);
            console.error('stderr:', stderr);
            reject(new Error(`${description} 失败`));
          }
        })
        .on('data', (data) => {
          stdout += data.toString();
          process.stdout.write(data.toString());
        })
        .stderr.on('data', (data) => {
          stderr += data.toString();
          process.stderr.write(data.toString());
        });
    });
  });
}

async function main() {
  const conn = new Client();

  try {
    console.log('🚀 开始 PushPlus 迁移部署');
    console.log('='.repeat(50));

    await new Promise((resolve, reject) => {
      conn
        .on('ready', () => {
          console.log('✅ SSH 连接成功');
          resolve();
        })
        .on('error', reject)
        .connect(config);
    });

    // 1. 数据库迁移
    const migrateSQL = `
      -- 新增 pushplus_token 列
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

      -- 移除 wxpusher_uid 列（如果存在）
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
    `;
    await execCommand(
      conn, 
      `PGPASSWORD=${shellQuote(deployConfig.postgres.password)} docker exec -i ${deployConfig.postgres.docker_container} psql -U ${deployConfig.postgres.user} -d ${deployConfig.postgres.database} << 'EOF'\n${migrateSQL}\nEOF`,
      '数据库迁移'
    );

    // 2. 拉取代码
    await execCommand(conn, 'cd /opt/stocks && git pull', '拉取最新代码');

    // 3. 构建后端
    await execCommand(conn, 'cd /opt/stocks/backend && npm run build', '构建后端');

    // 4. 构建前端（临时禁用 CI 模式）
    await execCommand(conn, 'cd /opt/stocks/frontend && CI=false npm run build', '构建前端');

    // 5. 重启服务
    await execCommand(conn, 'pm2 restart stock-backend', '重启后端服务');
    await execCommand(conn, 'pm2 restart stock-frontend', '重启前端服务');

    // 6. 检查服务状态
    await execCommand(conn, 'pm2 status', '检查 PM2 服务状态');

    console.log('\n' + '='.repeat(50));
    console.log('🎉 部署完成！');
    console.log('='.repeat(50));

  } catch (err) {
    console.error('\n❌ 部署过程中发生错误:', err.message);
    process.exit(1);
  } finally {
    conn.end();
  }
}

main();
