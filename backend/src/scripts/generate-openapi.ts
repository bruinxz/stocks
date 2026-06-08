#!/usr/bin/env ts-node
/**
 * generate-openapi.ts — US-070 CLI 入口 `npm run docs:openapi`
 *
 * 不启动 Express 服务，直接调用 buildOpenApiSpec()，把 OpenAPI 3.0 JSON 输出到
 * `docs/openapi.json` 让前端 / 第三方 codegen 工具消费。
 *
 * 使用方式：
 *   npm run docs:openapi                 # 默认输出到 docs/openapi.json
 *   npm run docs:openapi -- --out=x.json # 自定义输出路径
 */

import fs from 'fs';
import path from 'path';
import { buildOpenApiSpec } from '../config/swagger';

function parseArgs(argv: string[]): { out: string } {
  const out = argv.find(a => a.startsWith('--out='))?.split('=')[1];
  return {
    out: out || path.resolve(__dirname, '../../../docs/openapi.json'),
  };
}

function main() {
  const { out } = parseArgs(process.argv.slice(2));
  console.log(`[docs:openapi] Building OpenAPI spec...`);
  const spec = buildOpenApiSpec();
  const json = JSON.stringify(spec, null, 2);

  const dir = path.dirname(out);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`[docs:openapi] Created directory: ${dir}`);
  }

  fs.writeFileSync(out, json, 'utf-8');
  const sizeKB = (json.length / 1024).toFixed(1);

  // 简单统计：path 数量 / tag 数量 / schema 数量
  const specAny = spec as any;
  const pathCount = Object.keys(specAny.paths || {}).length;
  const opCount = Object.values(specAny.paths || {}).reduce<number>((acc, p: any) => {
    return (
      acc +
      Object.keys(p).filter(k =>
        ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'].includes(k.toLowerCase())
      ).length
    );
  }, 0);
  const tagCount = (specAny.tags || []).length;
  const schemaCount = Object.keys(specAny.components?.schemas || {}).length;

  console.log(`[docs:openapi] ✅ Wrote ${out} (${sizeKB} KB)`);
  console.log(
    `[docs:openapi]    paths: ${pathCount} | operations: ${opCount} | tags: ${tagCount} | schemas: ${schemaCount}`
  );
  if (opCount === 0) {
    console.warn(
      `[docs:openapi] ⚠️  0 operations found —— 请确认 routes/*.ts 中已添加 @openapi JSDoc 注释`
    );
  }
}

main();
