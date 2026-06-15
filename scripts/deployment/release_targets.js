/**
 * Release deployment target — main only.
 *
 * Sprint 37: lym + xz sandbox 已关停, 只保留 main 生产环境.
 *
 * 历史 schema 保留: 单元素 RELEASE_TARGETS map + parseTargetKeys / resolveTargets
 * 接口形态不变, 让 release_health_gate.js / deploy_release_package.js 等下游
 * 调用方零修改即可继续工作. 但只接受 'main' 一个 key, 其他 key (lym/xz/...) 报错.
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
};

/** Sprint 37: 只剩 main 单 target */
const DEFAULT_DEPLOY_TARGET_KEYS = ['main'];

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
      throw new Error(
        `Unsupported deploy target "${key}". Supported: ${supported} (lym/xz sandbox 已关停, 仅保留 main)`
      );
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
