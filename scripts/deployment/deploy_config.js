const fs = require('fs');
const os = require('os');
const path = require('path');

function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const result = {};
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    const value = line
      .slice(index + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '');
    result[key] = value;
  }
  return result;
}

const repoRoot = path.resolve(__dirname, '..', '..');
const backendEnv = readEnvFile(path.join(repoRoot, 'backend', '.env'));

function pick(...values) {
  return values.find(value => value !== undefined && value !== null && value !== '');
}


function expandHome(filePath) {
  if (!filePath) return '';
  return String(filePath).replace(/^~(?=$|\/|\\)/, os.homedir());
}

function readPrivateKey(filePath) {
  const expanded = expandHome(filePath);
  if (!expanded) return undefined;
  return fs.existsSync(expanded) ? fs.readFileSync(expanded) : undefined;
}

function required(value, name) {
  if (!value) {
    throw new Error(
      `${name} is required. Set it in environment variables or backend/.env before deployment.`
    );
  }
  return value;
}

function getDeployConfig(options = {}) {
  const requirePostgres = options.requirePostgres === true;
  // 生产容器的本地 TCP pg_hba 通常为 trust；维护脚本优先使用 postgres 角色走
  // `docker exec ... psql -h 127.0.0.1`，仅在显式配置 DEPLOY_PG_PASSWORD 时传入密码。
  const postgresPassword = pick(process.env.DEPLOY_PG_PASSWORD, process.env.PGPASSWORD, '');
  const remoteRoot = pick(process.env.DEPLOY_REMOTE_ROOT, '/opt/stocks');
  const frontendBaseUrl = pick(
    process.env.DEPLOY_FRONTEND_BASE_URL,
    backendEnv.FRONTEND_BASE_URL,
    'http://<legacy-prod-host>:3001'
  );
  return {
    paths: {
      repo_root: repoRoot,
      local_backend: pick(process.env.DEPLOY_LOCAL_BACKEND, path.join(repoRoot, 'backend')),
      local_frontend: pick(process.env.DEPLOY_LOCAL_FRONTEND, path.join(repoRoot, 'frontend')),
      remote_root: remoteRoot,
      remote_backend: pick(process.env.DEPLOY_REMOTE_BACKEND, `${remoteRoot}/backend`),
      remote_frontend: pick(process.env.DEPLOY_REMOTE_FRONTEND, `${remoteRoot}/frontend`),
    },
    pm2: {
      backend: pick(process.env.DEPLOY_PM2_BACKEND, 'stock-backend'),
      frontend: pick(process.env.DEPLOY_PM2_FRONTEND, 'stock-frontend'),
    },
    frontend_env: {
      REACT_APP_API_BASE_URL: pick(
        process.env.DEPLOY_REACT_APP_API_BASE_URL,
        process.env.REACT_APP_API_BASE_URL,
        '/api'
      ),
      REACT_APP_WS_URL: pick(
        process.env.DEPLOY_REACT_APP_WS_URL,
        process.env.REACT_APP_WS_URL,
        ''
      ),
      REACT_APP_ENV: pick(process.env.DEPLOY_REACT_APP_ENV, process.env.REACT_APP_ENV, 'production'),
      REACT_APP_PUSHPLUS_QRCODE_URL: pick(process.env.LEGACY_PUSHPLUS_QRCODE_URL, ''),
    },
    ssh: {
      host: pick(process.env.DEPLOY_HOST, process.env.SSH_HOST, '<legacy-prod-host>'),
      port: Number(pick(process.env.DEPLOY_PORT, process.env.SSH_PORT, 14126)),
      username: pick(process.env.DEPLOY_USER, process.env.SSH_USER, 'deploy'),
      password: pick(process.env.DEPLOY_PASSWORD, process.env.SSH_PASSWORD, ''),
      privateKey: readPrivateKey(pick(process.env.DEPLOY_KEY_PATH, process.env.SSH_KEY_PATH, '')),
      passphrase: pick(process.env.DEPLOY_KEY_PASSPHRASE, process.env.SSH_KEY_PASSPHRASE, ''),
    },
    postgres: {
      user: pick(process.env.DEPLOY_PG_USER, process.env.PGUSER, 'pgg_superadmins'),
      database: pick(process.env.DEPLOY_PG_DATABASE, backendEnv.DB_NAME, 'stock_backtest'),
      password: requirePostgres ? required(postgresPassword, 'DEPLOY_PG_PASSWORD') : postgresPassword,
      docker_container: pick(process.env.DEPLOY_PG_CONTAINER, 'stocks-postgres'),
    },
    backend_env: {
      ...backendEnv,
      DB_HOST: pick(process.env.DEPLOY_DB_HOST, backendEnv.DB_HOST, '127.0.0.1'),
      DB_PORT: pick(process.env.DEPLOY_DB_PORT, backendEnv.DB_PORT, '5432'),
      DB_NAME: pick(process.env.DEPLOY_DB_NAME, backendEnv.DB_NAME, 'stock_backtest'),
      DB_USER: pick(process.env.DEPLOY_DB_USER, backendEnv.DB_USER, 'stock_admin'),
      DB_PASSWORD: pick(process.env.DEPLOY_DB_PASSWORD, backendEnv.DB_PASSWORD),
      FRONTEND_BASE_URL: frontendBaseUrl,
    },
  };
}

function shellQuote(value) {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`;
}

function renderBackendEnv(env) {
  const retiredFeishuKeys = new Set([
    'FEISHU_APP_ID',
    'FEISHU_APP_SECRET',
    'FEISHU_BASE_APP_TOKEN',
    'FEISHU_BASE_TABLE_ID',
    'FEISHU_BITABLE_APP_TOKEN',
    'FEISHU_BITABLE_TABLE_ID',
    'FEISHU_BITABLE_URL',
    'FEISHU_DAILY_DIGEST_WEBHOOK',
    'FEISHU_MESSAGE_MAX_LENGTH',
    'OPS_ALERT_FEISHU_TIMEOUT_MS',
    'LIVE_ALERT_WEBHOOK_TIMEOUT_MS',
  ]);
  const preferredKeys = [
    'DB_HOST',
    'DB_PORT',
    'DB_NAME',
    'DB_USER',
    'DB_PASSWORD',
    'DB_SSL',
    'REDIS_HOST',
    'REDIS_PORT',
    'REDIS_PASSWORD',
    'REDIS_DB',
    'JWT_SECRET',
    'JWT_REFRESH_SECRET',
    'NODE_ENV',
    'PORT',
    'INTERNAL_API_KEY',
    'FEISHU_RECOMMENDATION_BOT_WEBHOOK',
    'FEISHU_BOT_WEBHOOK',
    'OPS_ALERT_FEISHU_WEBHOOK',
    'LIVE_ALERT_FEISHU_WEBHOOK',
    'FEISHU_BOT_WEBHOOK_TIMEOUT_MS',
    'FRONTEND_BASE_URL',
  ];
  const keys = [...new Set([...preferredKeys, ...Object.keys(env || {})])];
  return `${keys
    .filter(
      key =>
        !retiredFeishuKeys.has(key) && env[key] !== undefined && env[key] !== null
    )
    .map(key => `${key}=${shellQuote(env[key])}`)
    .join('\n')}\n`;
}

function renderFrontendEnv(env) {
  const keys = [
    'REACT_APP_API_BASE_URL',
    'REACT_APP_WS_URL',
    'REACT_APP_ENV',
    'REACT_APP_PUSHPLUS_QRCODE_URL',
  ];
  return `${keys
    .filter(key => env[key] !== undefined && env[key] !== null)
    .map(key => `${key}=${env[key]}`)
    .join('\n')}\n`;
}

module.exports = {
  getDeployConfig,
  renderBackendEnv,
  renderFrontendEnv,
  shellQuote,
};
