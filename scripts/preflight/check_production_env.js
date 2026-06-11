#!/usr/bin/env node
/**
 * production preflight CLI 包装。
 *
 * 用法：直接读 process.env 跑校验，缺关键 env 即 exit 1。
 *   NODE_ENV=production JWT_SECRET=... ... node scripts/preflight/check_production_env.js
 *
 * 在 CI / 部署链 / 一键 preflight 里调用；与 backend/src/index.ts 启动时跑的是同一份逻辑。
 */

const path = require('path');

// 优先读 backend/dist 编译版本（与运行时同源）；fallback 读 src（通过 ts-node 或编译后路径）
function loadPreflight() {
  const distPath = path.resolve(__dirname, '../../backend/dist/utils/productionPreflight.js');
  try {
    return require(distPath).runProductionPreflight;
  } catch (e) {
    console.error('未找到 backend/dist/utils/productionPreflight.js');
    console.error('请先 `cd backend && npm run build`，再跑本脚本。');
    process.exit(2);
  }
}

const run = loadPreflight();

// 强制 NODE_ENV=production，否则 preflight 内部直接 return true
if (process.env.NODE_ENV !== 'production') {
  console.warn('[preflight CLI] 自动设置 NODE_ENV=production 跑校验');
  process.env.NODE_ENV = 'production';
}

const ok = run(process.env);
process.exit(ok ? 0 : 1);
