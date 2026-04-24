const { Client } = require('ssh2');
const SftpClient = require('ssh2-sftp-client');
const fs = require('fs');
const path = require('path');

const config = {
  host: '103.242.3.87',
  port: 14126,
  username: 'root',
  password: '7tsA0wS62A1e'
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
      await sftp.put(local, remote, { useFastPut: true });
      process.stdout.write(`\r${i + 1}/${filesToSync.length}...`);
    } catch (err) {
      console.error(`\n❌ 同步失败 ${local}:`, err.message);
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
    await syncFiles(sftp, '/Users/bytedance/go/src/github.com/bruinxz/stocks/backend', '/opt/stocks/backend', ignores);

    // 4. 同步前端
    await syncFiles(sftp, '/Users/bytedance/go/src/github.com/bruinxz/stocks/frontend', '/opt/stocks/frontend', ignores);

    // 5. 同步后端环境变量
    await sftp.put('/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/.env', '/opt/stocks/backend/.env');

    sftp.end();

    // 6. 数据库迁移
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
      ssh, 
      `PGPASSWORD='x8Vq$9pL2#mK7@nW1cF5^jY3!bH4*gD' docker exec -i stock_postgres psql -U stock_admin -d stock_backtest << 'EOF'\n${migrateSQL}\nEOF`, 
      '数据库迁移'
    );

    // 7. 构建后端
    await execCommand(ssh, 'cd /opt/stocks/backend && npm run build', '构建后端');

    // 8. 构建前端（临时禁用 CI 模式）
    await execCommand(ssh, 'cd /opt/stocks/frontend && CI=false npm run build', '构建前端');

    // 9. 重启服务
    await execCommand(ssh, 'pm2 restart stock-backend', '重启后端服务');
    await execCommand(ssh, 'pm2 restart stock-frontend', '重启前端服务');

    // 10. 检查服务状态
    await execCommand(ssh, 'pm2 status', '检查 PM2 服务状态');

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
