#!/usr/bin/env node
/**
 * check-env CLI (US-068)
 *
 * 校验 backend/.env 是否完整可启动。手动运行：
 *   cd backend && npm run check-env
 *
 * 退出码：
 *   0 = 校验通过（可能有 warning，但不阻塞 production 启动）
 *   1 = 校验失败（缺必填 / 占位符 / 部分填写的 channel group），production 必须先修复
 *
 * 与 index.ts 启动时的检查走同一份 EnvValidator，所以"启动失败"和"check-env 失败"
 * 一定输出相同的 errors 列表。
 */

import dotenv from 'dotenv';
dotenv.config();

import { validateEnv, formatErrorReport, formatWarningReport } from '../config/EnvValidator';

const result = validateEnv();

console.log('Environment validation report');
console.log('================================================');
console.log(`NODE_ENV: ${result.node_env}`);
console.log(`Errors: ${result.errors.length}`);
console.log(`Warnings: ${result.warnings.length}`);
console.log('------------------------------------------------');

if (result.errors.length > 0) {
  console.error(formatErrorReport(result));
}
if (result.warnings.length > 0) {
  console.warn(formatWarningReport(result));
}
if (result.ok && result.warnings.length === 0) {
  console.log('✓ All checks passed');
}

console.log('================================================');
process.exit(result.ok ? 0 : 1);
