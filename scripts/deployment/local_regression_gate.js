const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function runLocalRegressionGate(options = {}) {
  const skip =
    String(process.env.DEPLOY_SKIP_LOCAL_REGRESSION || '').toLowerCase() === 'true' ||
    options.skip === true;
  if (skip) {
    console.log('⏭️  已跳过本地只读回归检查：DEPLOY_SKIP_LOCAL_REGRESSION=true');
    return;
  }

  const repoRoot = path.resolve(__dirname, '../..');
  const script = path.join(repoRoot, 'scripts/tests/local_readonly_regression.js');
  const outputPath =
    process.env.DEPLOY_LOCAL_REGRESSION_JSON_OUT ||
    path.join(repoRoot, '.bridge-state/local_readonly_regression_latest.json');
  console.log('\n📌 部署前本地只读回归检查...');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const result = spawnSync(process.execPath, [script], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      LOCAL_REGRESSION_JSON_OUT: outputPath,
    },
  });
  if (result.status !== 0) {
    throw new Error(
      '部署前本地只读回归检查失败；如需紧急跳过，请显式设置 DEPLOY_SKIP_LOCAL_REGRESSION=true'
    );
  }
  console.log(`✅ 部署前本地只读回归检查通过，结果文件：${outputPath}`);
}

module.exports = { runLocalRegressionGate };
