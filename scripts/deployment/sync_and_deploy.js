const { Client } = require('ssh2');
const SftpClient = require('ssh2-sftp-client');
const fs = require('fs');
const path = require('path');
const { runPostDeploySmoke } = require('./post_deploy_smoke');
const { getDeployConfig, shellQuote } = require('./deploy_config');
const { runLocalRegressionGate } = require('./local_regression_gate');
const { buildEnsureRuntimePathsCommand } = require('./ensure_runtime_paths');
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

async function ensureRemoteDir(sftp, remoteDir) {
  const normalized = remoteDir.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  let current = normalized.startsWith('/') ? '/' : '';
  for (const part of parts) {
    current = current === '/' ? `/${part}` : `${current}/${part}`;
    try {
      await sftp.mkdir(current);
    } catch (error) {
      if (!String(error?.message || '').includes('Failure') && !String(error?.message || '').includes('exists')) {
        // ssh2-sftp-client often reports existing directories as generic Failure; ignore and continue.
      }
    }
  }
}

async function syncFiles(sftp, localDir, remoteDir, ignores) {
  console.log(`\n📂 同步 ${localDir} -> ${remoteDir}...`);
  
  const filesToSync = [];
  
  function walkSync(dir, prefix = '') {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.join(prefix, entry.name);
      let shouldIgnore = false;
      for (const ignore of ignores) {
        if (relPath.includes(ignore)) {
          shouldIgnore = true;
          break;
        }
      }
      if (shouldIgnore) continue;
      
      if (entry.isDirectory()) {
        walkSync(fullPath, relPath);
      } else {
        filesToSync.push({ local: fullPath, remote: path.join(remoteDir, relPath) });
      }
    }
  }
  
  walkSync(localDir);
  
  console.log(`📋 准备同步 ${filesToSync.length} 个文件`);
  
  for (let i = 0; i < filesToSync.length; i++) {
    const { local, remote } = filesToSync[i];
    try {
      await ensureRemoteDir(sftp, path.dirname(remote));
      await sftp.put(local, remote, { useFastPut: true });
      process.stdout.write(`\r${i + 1}/${filesToSync.length}...`);
    } catch (err) {
      console.error(`\n❌ 同步失败 ${local}:`, err.message);
      throw err;
    }
  }
  console.log(`\n✅ 同步完成！`);
}

async function main() {
  const ssh = new Client();
  const sftp = new SftpClient();

  try {
    console.log('🚀 开始 PushPlus 迁移部署');
    console.log('='.repeat(60));
    runLocalRegressionGate();

    // 1. SSH 连接
    await new Promise((resolve, reject) => {
      ssh
        .on('ready', () => {
          console.log('✅ SSH 连接成功');
          resolve();
        })
        .on('error', reject)
        .connect(config);
    });

    // 2. SFTP 连接
    await sftp.connect({
      host: config.host,
      port: config.port,
      username: config.username,
      password: config.password
    });
    console.log('✅ SFTP 连接成功');

    // 3. 同步后端
    const ignores = ['node_modules', '.git', '.DS_Store', 'dist', 'uploads', '.env'];
    await syncFiles(sftp, paths.local_backend, paths.remote_backend, ignores);

    // 4. 同步前端
    await syncFiles(sftp, paths.local_frontend, paths.remote_frontend, ignores);

    // 5. 同步后端环境变量
    await sftp.put(path.join(paths.local_backend, '.env'), `${paths.remote_backend}/.env`);

    sftp.end();

    await execCommand(
      ssh,
      buildEnsureRuntimePathsCommand(paths.remote_root),
      '初始化运行时目录'
    );

    await execCommand(
      ssh,
      buildDockerPsqlMigrationCommand(
        deployConfig,
        buildRuntimeSchemaMigrationSQL(deployConfig.backend_env.DB_USER || 'stock_admin')
      ),
      '数据库迁移'
    );

    // 7. 构建后端
    await execCommand(ssh, `cd ${shellQuote(paths.remote_backend)} && npm run build`, '构建后端');

    // 8. 构建前端（临时禁用 CI 模式）
    await execCommand(
      ssh,
      `cd ${shellQuote(paths.remote_frontend)} && CI=false npm run build`,
      '构建前端'
    );

    // 9. 重启服务
    await execCommand(ssh, `pm2 restart ${shellQuote(pm2.backend)}`, '重启后端服务');
    await execCommand(ssh, `pm2 restart ${shellQuote(pm2.frontend)}`, '重启前端服务');

    await execCommand(
      ssh,
      buildDockerPsqlHealthCommand(
        deployConfig,
        buildRuntimeSchemaHealthSQL(deployConfig.backend_env.DB_USER || 'stock_admin')
      ),
      '数据库权限健康检查'
    );

    // 10. 检查服务状态
    await execCommand(ssh, 'pm2 status', '检查 PM2 服务状态');

    // 11. 部署后只读冒烟测试：只验证核心接口，不触发同步/交易/Agent分析
    await runPostDeploySmoke();

    console.log('\n' + '='.repeat(60));
    console.log('🎉 部署完成！');
    console.log('='.repeat(60));

  } catch (err) {
    console.error('\n❌ 部署过程中发生错误:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    ssh.end();
  }
}

main();
