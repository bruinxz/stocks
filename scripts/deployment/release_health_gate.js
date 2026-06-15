#!/usr/bin/env node

/**
 * Production release health gate.
 *
 * Purpose:
 * - verify current/previous release symlink
 * - restart only the requested backend services
 * - run read-only smoke checks
 * - rollback symlink + restart when health fails
 *
 * This script intentionally does not upload or activate code. It is the
 * post-activation guard that should run after /opt/stocks/current is switched.
 */

const { spawnSync } = require('child_process');
const { resolveTargets } = require('./release_targets');

function readBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseEnvs() {
  if (process.env.RELEASE_TARGET_CONFIG) {
    const keys = String(process.env.RELEASE_TARGETS || 'main')
      .split(',')
      .map(item => item.trim())
      .filter(Boolean);
    const catalog = JSON.parse(process.env.RELEASE_TARGET_CONFIG);
    return keys.map(key => {
      const target = catalog.find(item => item.key === key);
      if (!target) throw new Error(`Unknown release target: ${key}`);
      return target;
    });
  }
  return resolveTargets(process.env.RELEASE_TARGETS);
}

function run(command, options = {}) {
  const result = spawnSync(command, {
    shell: true,
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (options.capture) {
    return {
      status: result.status || 0,
      stdout: (result.stdout || '').trim(),
      stderr: (result.stderr || '').trim(),
    };
  }
  if (result.status !== 0) {
    throw new Error(`Command failed (${result.status}): ${command}`);
  }
  return { status: 0, stdout: '', stderr: '' };
}

function sh(value) {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`;
}

function capture(command) {
  const result = run(command, { capture: true });
  if (result.status !== 0) {
    throw new Error(`${command}\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function currentRelease(target) {
  return capture(`readlink -f ${sh(`${target.root}/current`)}`);
}

function previousRelease(target, current) {
  const out = capture(
    `ls -1dt ${sh(`${target.root}/releases`)}/* 2>/dev/null | grep -v -F ${sh(
      current
    )} | head -1 || true`
  );
  return out || null;
}

function restartServices(targets) {
  const services = targets.map(item => item.service).join(' ');
  run(`systemctl restart ${services}`);
  run('sleep 8');
  run(`systemctl is-active ${services}`);
}

function healthCheck(target) {
  console.log(`\n🔎 health: ${target.key}`);
  run(`curl -fsS ${sh(`${target.backend_url}/health`)}`);
  run(`curl -fsSI ${sh(`${target.frontend_url}/`)} >/dev/null`);

  const smoke = readBool(process.env.RELEASE_RUN_SMOKE, true);
  if (smoke) {
    // Sprint 37: lym/xz sandbox 已关停, 仅 main 的 stock 用户做 smoke 登录测试
    const defaultSmokeUser = 'stock';
    const username =
      process.env.RELEASE_SMOKE_USERNAME || process.env.SMOKE_USERNAME || defaultSmokeUser;
    // P0 launch-helper：禁止 '666' 默认密码
    const password = process.env.RELEASE_SMOKE_PASSWORD || process.env.SMOKE_PASSWORD || '';
    if (!password) {
      throw new Error(
        'RELEASE_SMOKE_PASSWORD (or SMOKE_PASSWORD) is required; "666" fallback removed.'
      );
    }
    run(
      `cd ${sh(`${target.root}/current`)} && SMOKE_BASE_URL=${sh(
        target.backend_url
      )} SMOKE_USERNAME=${sh(username)} SMOKE_PASSWORD=${sh(
        password
      )} SMOKE_TIMEOUT_MS=${sh(process.env.RELEASE_SMOKE_TIMEOUT_MS || '20000')} node scripts/tests/smoke_readonly_core.js`
    );
  }
}

function rollback(target, previous) {
  if (!previous) {
    console.error(`⚠️  ${target.key} 没有可回滚 release，保留当前版本`);
    return;
  }
  console.error(`↩️  rollback ${target.key}: ${previous}`);
  run(`ln -sfn ${sh(previous)} ${sh(`${target.root}/current`)}`);
}

async function main() {
  const targets = parseEnvs();
  const before = targets.map(target => {
    const current = currentRelease(target);
    return { target, current, previous: previousRelease(target, current) };
  });

  console.log('🚦 release health gate');
  for (const item of before) {
    console.log(`- ${item.target.key}: current=${item.current} previous=${item.previous || '-'}`);
  }

  try {
    restartServices(targets);
    for (const { target } of before) healthCheck(target);
    console.log('\n✅ release health gate passed');
  } catch (error) {
    console.error(`\n❌ release health gate failed: ${error.message || error}`);
    if (readBool(process.env.RELEASE_AUTO_ROLLBACK, true)) {
      for (const item of before) rollback(item.target, item.previous);
      restartServices(targets);
      for (const { target } of before) healthCheck(target);
      console.log('\n✅ rollback health gate passed');
    }
    process.exit(1);
  }
}

main().catch(error => {
  console.error(error.message || error);
  process.exit(1);
});
