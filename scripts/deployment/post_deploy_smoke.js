const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');

function booleanEnv(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function runPostDeploySmoke(options = {}) {
  const skipSmoke = booleanEnv(process.env.DEPLOY_SKIP_SMOKE, false);
  const baseUrl =
    options.baseUrl ||
    process.env.DEPLOY_SMOKE_BASE_URL ||
    process.env.SMOKE_BASE_URL ||
    'http://<legacy-prod-host>:3000';
  const timeoutMs =
    options.timeoutMs || process.env.DEPLOY_SMOKE_TIMEOUT_MS || process.env.SMOKE_TIMEOUT_MS || '20000';
  const deploymentId = options.deploymentId || process.env.DEPLOYMENT_ID || `deploy_${Date.now()}`;
  const localRegressionSummary = readLocalRegressionSummary(options.localRegressionJsonPath);

  if (skipSmoke) {
    console.log('\n⏭️  已设置 DEPLOY_SKIP_SMOKE=true，跳过部署后只读冒烟测试');
    const payload = {
      summary: {
        success: true,
        base_url: baseUrl,
        passed: 0,
        failed: 0,
        critical_failed: 0,
        optional_failed: 0,
        skipped: true,
        skip_reason: 'DEPLOY_SKIP_SMOKE=true',
        timeout_ms: Number(timeoutMs || 0),
      },
      local_regression: localRegressionSummary,
      results: [],
    };
    return uploadSmokeSummary(baseUrl, payload, deploymentId)
      .catch(error => {
        console.warn('⚠️  部署冒烟跳过结果上报失败:', error.message || error);
      })
      .then(() => ({ skipped: true, payload }));
  }

  const repoRoot = path.resolve(__dirname, '..', '..');
  const smokeScript = path.join(repoRoot, 'scripts', 'tests', 'smoke_readonly_core.js');
  const summaryPath = path.join(os.tmpdir(), `stocks_smoke_${deploymentId}.json`);

  console.log('\n📌 部署后只读冒烟测试...');
  console.log(`   base=${baseUrl}`);

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [smokeScript], {
      cwd: repoRoot,
      stdio: 'inherit',
      env: {
        ...process.env,
        SMOKE_BASE_URL: baseUrl,
        SMOKE_USERNAME: process.env.DEPLOY_SMOKE_USERNAME || process.env.SMOKE_USERNAME || 'stock',
        SMOKE_PASSWORD: process.env.DEPLOY_SMOKE_PASSWORD || process.env.SMOKE_PASSWORD || '666',
        SMOKE_TOKEN: process.env.DEPLOY_SMOKE_TOKEN || process.env.SMOKE_TOKEN || '',
        SMOKE_TIMEOUT_MS: String(timeoutMs),
        SMOKE_JSON_OUT: summaryPath,
        SMOKE_INCLUDE_EXTERNAL:
          process.env.DEPLOY_SMOKE_INCLUDE_EXTERNAL || process.env.SMOKE_INCLUDE_EXTERNAL || 'false',
      },
    });

    child.on('error', error => {
      console.error('❌ 启动部署后冒烟测试失败:', error.message);
      reject(error);
    });

    child.on('close', code => {
      const payload = readSmokeSummary(summaryPath, baseUrl, code);
      payload.local_regression = localRegressionSummary;
      uploadSmokeSummary(baseUrl, payload, deploymentId).catch(error => {
        console.warn('⚠️  部署冒烟结果上报失败:', error.message || error);
      });

      if (code === 0) {
        console.log('✅ 部署后只读冒烟测试通过');
        resolve({ skipped: false, payload });
      } else {
        reject(new Error(`部署后只读冒烟测试失败，退出码: ${code}`));
      }
    });
  });
}

function readLocalRegressionSummary(customPath) {
  const candidatePath =
    customPath ||
    process.env.DEPLOY_LOCAL_REGRESSION_JSON_OUT ||
    path.resolve(__dirname, '..', '..', '.bridge-state', 'local_readonly_regression_latest.json');
  try {
    if (!candidatePath || !fs.existsSync(candidatePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
    const summary = parsed?.summary || null;
    if (!summary) return null;
    return {
      success: Boolean(summary.success),
      passed: Number(summary.passed || 0),
      failed: Number(summary.failed || 0),
      total: Number(summary.total || 0),
      generated_at: summary.generated_at,
    };
  } catch (error) {
    console.warn('⚠️  读取本地只读回归摘要失败:', error.message || error);
    return null;
  }
}

function readSmokeSummary(summaryPath, baseUrl, code) {
  try {
    if (fs.existsSync(summaryPath)) {
      return JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    }
  } catch (error) {
    console.warn('⚠️  读取冒烟摘要失败:', error.message || error);
  }
  return {
    summary: {
      success: code === 0,
      base_url: baseUrl,
      passed: 0,
      failed: code === 0 ? 0 : 1,
      critical_failed: code === 0 ? 0 : 1,
      optional_failed: 0,
      skipped: 0,
    },
    results: [],
  };
}

async function uploadSmokeSummary(baseUrl, payload, deploymentId) {
  const token = process.env.DEPLOY_SMOKE_TOKEN || process.env.SMOKE_TOKEN || '';
  const apiKey =
    process.env.DEPLOY_INTERNAL_API_KEY ||
    process.env.INTERNAL_API_KEY ||
    readEnvValue(path.resolve(__dirname, '..', '..', 'backend', '.env'), 'INTERNAL_API_KEY');
  if ((!token && !apiKey) || typeof fetch !== 'function') {
    console.log('ℹ️  未配置 DEPLOY_SMOKE_TOKEN/DEPLOY_INTERNAL_API_KEY，跳过冒烟结果上报');
    return;
  }

  const url = new URL('/api/tasks/deployment-smoke-report', baseUrl).toString();
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : { 'X-API-Key': apiKey }),
    },
    body: JSON.stringify({
      ...payload,
      deployment_id: deploymentId,
      source: 'post_deploy_smoke',
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  console.log('🧾 部署冒烟结果已上报后端审计');
}

function readEnvValue(envPath, key) {
  try {
    if (!fs.existsSync(envPath)) return '';
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    const prefix = `${key}=`;
    const line = lines.find(item => item.trim().startsWith(prefix));
    if (!line) return '';
    return line
      .trim()
      .slice(prefix.length)
      .replace(/^['"]|['"]$/g, '');
  } catch {
    return '';
  }
}

module.exports = {
  runPostDeploySmoke,
};

if (require.main === module) {
  runPostDeploySmoke().catch(error => {
    console.error(error.message || error);
    process.exit(1);
  });
}
