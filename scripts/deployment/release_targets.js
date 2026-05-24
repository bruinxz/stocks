/**
 * Release deployment targets (main / lym / xz).
 *
 * Isolation principles:
 * - Default deploy set is main + lym only; xz is opt-in via DEPLOY_TARGETS=xz.
 * - Each target has its own /opt/stocks* root, ports, and systemd unit.
 * - Shared Postgres is OK for dev; enable queue workers on at most one sandbox
 *   (lym or xz) and prefer distinct REDIS_DB in shared/backend.env when both run workers.
 */

const RELEASE_TARGETS = {
  main: {
    key: 'main',
    root: '/opt/stocks',
    label: 'main',
    service: 'stocks-backend.service',
    backend_url: 'http://127.0.0.1:3000',
    frontend_url: 'http://127.0.0.1:3001',
  },
  lym: {
    key: 'lym',
    root: '/opt/stocks-lym',
    label: 'lym',
    service: 'stocks-backend-lym.service',
    backend_url: 'http://127.0.0.1:3010',
    frontend_url: 'http://127.0.0.1:3011',
  },
  xz: {
    key: 'xz',
    root: '/opt/stocks-xz',
    label: 'xz',
    service: 'stocks-backend-xz.service',
    backend_url: 'http://127.0.0.1:3020',
    frontend_url: 'http://127.0.0.1:3021',
  },
};

/** Default: production main + lym sandbox. Does not include xz. */
const DEFAULT_DEPLOY_TARGET_KEYS = ['main', 'lym'];

function parseTargetKeys(raw, fallbackKeys = DEFAULT_DEPLOY_TARGET_KEYS) {
  const keys = String(raw ?? fallbackKeys.join(','))
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);

  if (keys.length === 0) {
    throw new Error('At least one deploy target is required');
  }

  for (const key of keys) {
    if (!RELEASE_TARGETS[key]) {
      const supported = Object.keys(RELEASE_TARGETS).join(', ');
      throw new Error(`Unsupported deploy target "${key}". Supported: ${supported}`);
    }
  }

  return keys;
}

function resolveTargets(raw, fallbackKeys = DEFAULT_DEPLOY_TARGET_KEYS) {
  return parseTargetKeys(raw, fallbackKeys).map(key => RELEASE_TARGETS[key]);
}

function healthGateScriptForTarget(target) {
  return `${target.root}/current/scripts/deployment/release_health_gate.js`;
}

module.exports = {
  RELEASE_TARGETS,
  DEFAULT_DEPLOY_TARGET_KEYS,
  parseTargetKeys,
  resolveTargets,
  healthGateScriptForTarget,
};
