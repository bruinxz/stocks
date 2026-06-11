#!/usr/bin/env node

/**
 * Release-package deployment helper for the current production layout.
 *
 * Default deploy set is main + lym (see release_targets.js). The xz sandbox is opt-in:
 *   DEPLOY_TARGETS=xz
 * or:
 *   bash scripts/deployment/deploy_xz.sh
 *
 * Required env:
 *   DEPLOY_PASSWORD / SSH_PASSWORD     deploy user password
 *   OPS_PASSWORD                       ops sudo password
 *
 * Optional env:
 *   DEPLOY_TARGETS=main,lym            default; add xz only when intended
 *   DEPLOY_SKIP_BUILD=true
 *   RELEASE_RUN_SMOKE=true
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { getDeployConfig, shellQuote } = require('./deploy_config');
const {
  resolveTargets,
  healthGateScriptForTarget,
} = require('./release_targets');

const repoRoot = path.resolve(__dirname, '..', '..');
const deployConfig = getDeployConfig();
const sshHost = deployConfig.ssh.host || '103.242.3.87';
const sshPort = Number(deployConfig.ssh.port || 14126);
const deployUser = process.env.DEPLOY_USER || deployConfig.ssh.username || 'deploy';
const deployPassword =
  process.env.DEPLOY_PASSWORD || process.env.SSH_PASSWORD || deployConfig.ssh.password || '';
const opsUser = process.env.OPS_USER || 'ops';
const opsPassword = process.env.OPS_PASSWORD || '';
const commandTimeoutMs = Number(process.env.DEPLOY_COMMAND_TIMEOUT_MS || 15 * 60 * 1000);
const remoteTimeoutSec = Number(process.env.DEPLOY_REMOTE_TIMEOUT_SEC || 300);
const rsyncTimeoutSec = Number(process.env.DEPLOY_RSYNC_TIMEOUT_SEC || 240);
const rsyncRetries = Math.max(Number(process.env.DEPLOY_RSYNC_RETRIES || 3), 1);
const sshConnectTimeoutSec = Number(process.env.DEPLOY_SSH_CONNECT_TIMEOUT_SEC || 15);
const targetList = resolveTargets(process.env.DEPLOY_TARGETS);
const targetKeys = targetList.map(item => item.key);

function run(command, options = {}) {
  console.log(`\n$ ${command}`);
  const result = spawnSync(command, {
    cwd: options.cwd || repoRoot,
    shell: true,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
    env: { ...process.env, ...(options.env || {}) },
    timeout: options.timeoutMs || commandTimeoutMs,
  });
  if (result.error) {
    throw new Error(`Command failed (${result.error.code || result.error.name}): ${command}`);
  }
  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join('\n');
    const status = result.status === null ? result.signal || 'unknown' : result.status;
    throw new Error(`Command failed (${status}): ${command}\n${details}`);
  }
  return result.stdout || '';
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function runWithRetry(label, fn, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      if (attempt > 1) console.log(`\n↻ retry ${label}: attempt ${attempt}/${attempts}`);
      return fn();
    } catch (error) {
      lastError = error;
      console.warn(`⚠️ ${label} failed on attempt ${attempt}/${attempts}: ${error.message || error}`);
      if (attempt < attempts) sleepSync(Math.min(3000 * attempt, 10000));
    }
  }
  throw lastError;
}

function requireExpectPassword(value, name) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function writeExpectScript(name, body) {
  const filePath = path.join(os.tmpdir(), `${name}_${Date.now()}.expect`);
  fs.writeFileSync(filePath, body, { mode: 0o700 });
  return filePath;
}

function runRemoteAsDeploy(command) {
  requireExpectPassword(deployPassword, 'DEPLOY_PASSWORD');
  const script = writeExpectScript(
    'stocks_deploy_remote',
    `#!/usr/bin/expect -f
set timeout ${remoteTimeoutSec}
set password {${deployPassword}}
spawn ssh -o StrictHostKeyChecking=no -o ConnectTimeout=${sshConnectTimeoutSec} -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -p ${sshPort} ${deployUser}@${sshHost} ${command}
expect {
  "*yes/no*" { send "yes\\r"; exp_continue }
  "*assword:*" { send "$password\\r"; exp_continue }
  timeout { puts stderr "ERROR: deploy remote command timed out after $timeout seconds"; exit 124 }
  eof
}
catch wait result
exit [lindex $result 3]
`
  );
  run(script);
  fs.unlinkSync(script);
}

function runRemoteAsOpsWithSudo(command) {
  requireExpectPassword(opsPassword, 'OPS_PASSWORD');
  const script = writeExpectScript(
    'stocks_ops_remote',
    `#!/usr/bin/expect -f
set timeout ${remoteTimeoutSec}
set password {${opsPassword}}
set remote_cmd {printf "%s\\n" '${opsPassword.replace(/'/g, `'\\''`)}' | sudo -S ${command}}
spawn ssh -tt -o StrictHostKeyChecking=no -o ConnectTimeout=${sshConnectTimeoutSec} -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -p ${sshPort} ${opsUser}@${sshHost} $remote_cmd
expect {
  "*yes/no*" { send "yes\\r"; exp_continue }
  "*assword:*" { send "$password\\r"; exp_continue }
  timeout { puts stderr "ERROR: ops remote command timed out after $timeout seconds"; exit 124 }
  eof
}
catch wait result
exit [lindex $result 3]
`
  );
  run(script);
  fs.unlinkSync(script);
}

function rsyncPackage(packagePath) {
  requireExpectPassword(deployPassword, 'DEPLOY_PASSWORD');
  runWithRetry(
    'release package upload',
    () =>
      run(
        `${shellQuote(path.join(repoRoot, 'scripts/deployment/rsync_expect.sh'))} ${shellQuote(
          deployPassword
        )} ${shellQuote(
          packagePath
        )} ${deployUser}@${sshHost}:/tmp/stocks-upload/stocks_release_root.tgz ${sshPort} ${rsyncTimeoutSec} ${sshConnectTimeoutSec}`,
        { timeoutMs: (rsyncTimeoutSec + 45) * 1000 }
      ),
    rsyncRetries
  );
}

function buildPackage() {
  if (String(process.env.DEPLOY_SKIP_BUILD || '').toLowerCase() !== 'true') {
    // 走 PATH 里的 node + 仓内 typescript / react-scripts
    // 之前硬编码了 /Applications/Codex.app/... 路径，导致 Ubuntu / 其它 macOS 都跑不了
    // DEPLOY_NODE_BIN 可在特殊环境显式覆盖（默认 "node"）
    const nodeBin = process.env.DEPLOY_NODE_BIN || 'node';
    run(
      `${nodeBin} backend/node_modules/typescript/bin/tsc -p backend/tsconfig.json --pretty false`
    );
    run(
      `cd frontend && CI=false ${nodeBin} node_modules/react-scripts/bin/react-scripts.js build`
    );
  }

  const buildDir = '/tmp/stocks_release_build';
  const packagePath = '/tmp/stocks_release_root.tgz';
  run(`rm -rf ${shellQuote(buildDir)} ${shellQuote(packagePath)} && mkdir -p ${shellQuote(buildDir)}`);
  run(
    [
      'rsync -a --delete',
      "--exclude '.git'",
      "--exclude 'node_modules'",
      "--exclude 'backend/node_modules'",
      "--exclude 'frontend/node_modules'",
      "--exclude 'backend/logs'",
      "--exclude 'backend/uploads'",
      "--exclude '.artifacts'",
      "--exclude 'frontend/build'",
      './',
      `${shellQuote(buildDir)}/`,
    ].join(' ')
  );
  run(`mkdir -p ${shellQuote(`${buildDir}/backend`)} ${shellQuote(`${buildDir}/frontend`)}`);
  run(`rsync -a --delete backend/dist/ ${shellQuote(`${buildDir}/backend/dist`)}/`);
  run(`rsync -a --delete frontend/build/ ${shellQuote(`${buildDir}/frontend/build`)}/`);
  run(
    `rm -f ${shellQuote(`${buildDir}/backend/.env`)} ${shellQuote(
      `${buildDir}/frontend/.env`
    )} ${shellQuote(`${buildDir}/frontend/.env.production.local`)} ${shellQuote(
      `${buildDir}/frontend/.env.development.local`
    )}`
  );
  run(`COPYFILE_DISABLE=1 tar --no-xattrs -C ${shellQuote(buildDir)} -czf ${shellQuote(packagePath)} .`);
  return packagePath;
}

function main() {
  const packagePath = buildPackage();
  runRemoteAsDeploy('mkdir -p /tmp/stocks-upload && rm -f /tmp/stocks-upload/stocks_release_root.tgz');
  rsyncPackage(packagePath);
  const activateCommand = targetList
    .map(target =>
      `bash /tmp/activate_stocks_release.sh ${shellQuote(target.root)} ${shellQuote(target.label)}`
    )
    .join(' && ');
  const readlinkCommand = targetList
    .map(target => `readlink -f ${shellQuote(`${target.root}/current`)}`)
    .join(' && ');
  runRemoteAsDeploy(`${activateCommand} && ${readlinkCommand}`);

  const healthGateTarget = targetList[0];
  const smokeUsername =
    process.env.RELEASE_SMOKE_USERNAME ||
    (healthGateTarget.key === 'xz' ? 'xz' : 'lym');
  // P0 launch-helper：禁止再用 '666' 默认密码做 smoke。
  // 必须显式 RELEASE_SMOKE_PASSWORD 注入；缺失即拒绝部署。
  const smokePassword = process.env.RELEASE_SMOKE_PASSWORD || '';
  if (!smokePassword) {
    throw new Error(
      'RELEASE_SMOKE_PASSWORD is required for deploy (no more "666" fallback). 上线 admin 密码已收紧，' +
        '请在部署环境注入 smoke 专用账号密码。'
    );
  }
  runRemoteAsOpsWithSudo(
    `env RELEASE_TARGETS=${shellQuote(targetKeys.join(','))} RELEASE_RUN_SMOKE=${shellQuote(
      process.env.RELEASE_RUN_SMOKE || 'true'
    )} RELEASE_AUTO_ROLLBACK=${shellQuote(
      process.env.RELEASE_AUTO_ROLLBACK || 'true'
    )} RELEASE_SMOKE_USERNAME=${shellQuote(smokeUsername)} RELEASE_SMOKE_PASSWORD=${shellQuote(
      smokePassword
    )} node ${shellQuote(healthGateScriptForTarget(healthGateTarget))}`
  );
  console.log('\n✅ release package deployment completed');
}

try {
  main();
} catch (error) {
  console.error(`\n❌ release package deployment failed: ${error.message || error}`);
  process.exit(1);
}
