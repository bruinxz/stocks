#!/usr/bin/env node

/**
 * Release-package deployment helper for the current production layout.
 *
 * It intentionally targets only main + lym by default:
 * - build local backend dist + frontend build
 * - package repo without node_modules/env/runtime dirs
 * - upload to /tmp/stocks-upload/stocks_release_root.tgz
 * - call the server-side /tmp/activate_stocks_release.sh for /opt/stocks and /opt/stocks-lym
 * - run release_health_gate.js with automatic rollback
 *
 * Required env:
 *   DEPLOY_PASSWORD / SSH_PASSWORD     deploy user password
 *   OPS_PASSWORD                       ops sudo password
 *
 * Optional env:
 *   DEPLOY_TARGETS=main,lym            do not include xxz unless explicitly requested
 *   DEPLOY_SKIP_BUILD=true
 *   RELEASE_RUN_SMOKE=true
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { getDeployConfig, shellQuote } = require('./deploy_config');

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
const targets = String(process.env.DEPLOY_TARGETS || 'main,lym')
  .split(',')
  .map(item => item.trim())
  .filter(Boolean);

const targetConfig = {
  main: { root: '/opt/stocks', label: 'main' },
  lym: { root: '/opt/stocks-lym', label: 'lym' },
};

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
    run(
      `/Applications/Codex.app/Contents/Resources/node backend/node_modules/typescript/bin/tsc -p backend/tsconfig.json --pretty false`
    );
    run(
      `cd frontend && CI=false /Applications/Codex.app/Contents/Resources/node node_modules/react-scripts/bin/react-scripts.js build`
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
  for (const target of targets) {
    if (!targetConfig[target]) throw new Error(`Unsupported target: ${target}`);
  }

  const packagePath = buildPackage();
  runRemoteAsDeploy('mkdir -p /tmp/stocks-upload && rm -f /tmp/stocks-upload/stocks_release_root.tgz');
  rsyncPackage(packagePath);
  const activateCommand = targets
    .map(target => {
      const config = targetConfig[target];
      return `bash /tmp/activate_stocks_release.sh ${shellQuote(config.root)} ${shellQuote(
        config.label
      )}`;
    })
    .join(' && ');
  runRemoteAsDeploy(`${activateCommand} && readlink -f /opt/stocks/current && readlink -f /opt/stocks-lym/current`);
  runRemoteAsOpsWithSudo(
    `env RELEASE_TARGETS=${shellQuote(targets.join(','))} RELEASE_RUN_SMOKE=${shellQuote(
      process.env.RELEASE_RUN_SMOKE || 'true'
    )} RELEASE_AUTO_ROLLBACK=${shellQuote(
      process.env.RELEASE_AUTO_ROLLBACK || 'true'
    )} RELEASE_SMOKE_USERNAME=${shellQuote(
      process.env.RELEASE_SMOKE_USERNAME || 'lym'
    )} RELEASE_SMOKE_PASSWORD=${shellQuote(
      process.env.RELEASE_SMOKE_PASSWORD || '666'
    )} node /opt/stocks/current/scripts/deployment/release_health_gate.js`
  );
  console.log('\n✅ release package deployment completed');
}

try {
  main();
} catch (error) {
  console.error(`\n❌ release package deployment failed: ${error.message || error}`);
  process.exit(1);
}
