const { Client } = require('ssh2');
const { runPostDeploySmoke } = require('./post_deploy_smoke');
const { getDeployConfig, renderBackendEnv, shellQuote } = require('./deploy_config');
const { runLocalRegressionGate } = require('./local_regression_gate');
const {
  buildDockerPsqlHealthCommand,
  buildDockerPsqlMigrationCommand,
  buildRuntimeSchemaHealthSQL,
  buildRuntimeSchemaMigrationSQL,
} = require('./runtime_schema_migration');

const deployConfig = getDeployConfig();
const config = deployConfig.ssh;
const paths = deployConfig.paths;
const pm2 = deployConfig.pm2;

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
    console.log('='.repeat(60));
    runLocalRegressionGate();

    await new Promise((resolve, reject) => {
      conn
        .on('ready', () => {
          console.log('✅ SSH 连接成功');
          resolve();
        })
        .on('error', reject)
        .connect(config);
    });

    // 1. 拉取代码
    await execCommand(conn, `cd ${shellQuote(paths.remote_root)} && git pull`, '拉取最新代码');

    await execCommand(
      conn,
      buildDockerPsqlMigrationCommand(
        deployConfig,
        buildRuntimeSchemaMigrationSQL(deployConfig.backend_env.DB_USER || 'stock_admin')
      ),
      '数据库迁移'
    );

    // 3. 覆盖更新 .env 文件
    const newEnv = renderBackendEnv(deployConfig.backend_env);
    await execCommand(
      conn,
      `cat > ${shellQuote(`${paths.remote_backend}/.env`)} << 'ENV_EOF'\n${newEnv}ENV_EOF`,
      '更新后端环境变量'
    );

    // 4. 构建后端
    await execCommand(conn, `cd ${shellQuote(paths.remote_backend)} && npm run build`, '构建后端');

    // 5. 构建前端
    await execCommand(
      conn,
      `cd ${shellQuote(paths.remote_frontend)} && CI=false npm run build`,
      '构建前端'
    );

    // 6. 重启服务
    await execCommand(conn, `pm2 restart ${shellQuote(pm2.backend)}`, '重启后端服务');
    await execCommand(conn, `pm2 restart ${shellQuote(pm2.frontend)}`, '重启前端服务');

    await execCommand(
      conn,
      buildDockerPsqlHealthCommand(
        deployConfig,
        buildRuntimeSchemaHealthSQL(deployConfig.backend_env.DB_USER || 'stock_admin')
      ),
      '数据库权限健康检查'
    );

    // 7. 检查服务状态
    await execCommand(conn, 'pm2 status', '检查 PM2 服务状态');

    // 8. 部署后只读冒烟测试：只验证核心接口，不触发同步/交易/Agent分析
    await runPostDeploySmoke();

    console.log('\n' + '='.repeat(60));
    console.log('🎉 部署完成！');
    console.log('='.repeat(60));

  } catch (err) {
    console.error('\n❌ 部署过程中发生错误:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    conn.end();
  }
}

main();
