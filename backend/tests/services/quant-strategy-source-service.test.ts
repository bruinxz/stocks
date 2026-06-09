/**
 * QuantStrategySourceService 单元测试 (US-093)
 *
 * 不依赖 jest; node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/quant-strategy-source-service.test.ts
 *
 * 范围:
 *   - isValidStrategyKey 校验逻辑（snake_case 合法 / 大写非法 / path traversal 非法 / 数字开头非法）
 *   - buildSourceMap 扫描 strategies/ 真实目录，断言已注册策略可被读取
 *   - getStrategySource happy path（多个真实 strategy_key 都能拿到内容）
 *   - getStrategySource invalid_strategy_key 抛错
 *   - getStrategySource strategy_not_found 抛错（白名单查不到）
 *   - listAvailableStrategyKeys 排序 + 字段
 *   - 缓存：第二次调用不再扫盘（通过 process timing 间接断言）
 */

import {
  QuantStrategySourceService,
  isValidStrategyKey,
  buildSourceMap,
  resetSourceMapCache,
} from '../../src/quant/engine/internal/QuantStrategySourceService';
import path from 'path';

let passed = 0;
let failed = 0;

function assert(name: string, cond: boolean, details?: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${details ? `\n    ${details}` : ''}`);
  }
}

async function main() {
  console.log('--- isValidStrategyKey ---');
  assert("合法 'multi_factor_alpha'", isValidStrategyKey('multi_factor_alpha'));
  assert("合法 'a'", isValidStrategyKey('a'));
  assert("合法 'abc_123'", isValidStrategyKey('abc_123'));
  assert("非法 'MultiFactorAlpha'（大写）", !isValidStrategyKey('MultiFactorAlpha'));
  assert("非法 '../etc/passwd'（path traversal）", !isValidStrategyKey('../etc/passwd'));
  assert("非法 '1abc'（数字开头）", !isValidStrategyKey('1abc'));
  assert("非法 ''（空字符串）", !isValidStrategyKey(''));
  assert('非法 null', !isValidStrategyKey(null));
  assert('非法 undefined', !isValidStrategyKey(undefined));
  assert('非法 number', !isValidStrategyKey(123));
  assert("非法 'abc.ts'（带后缀）", !isValidStrategyKey('abc.ts'));
  assert("非法 'a-b'（连字符）", !isValidStrategyKey('a-b'));

  console.log('--- buildSourceMap 扫描真实 strategies 目录 ---');
  const strategiesDir = path.resolve(process.cwd(), 'src/quant/strategies');
  const sourceMap = buildSourceMap(strategiesDir);
  assert(
    `扫描到至少 25 个 strategy_key (实际 ${sourceMap.size})`,
    sourceMap.size >= 25,
    `expected >=25, got ${sourceMap.size}`
  );

  console.log('--- 关键已知 strategy_key 都在 map 内 ---');
  const knownKeys = [
    'multi_factor_alpha',
    'dragon_head_momentum',
    'earnings_surprise',
    'high_dividend_value',
    'breakout_strategy',
    'ensemble_strategy',
    'garp_strategy',
    'ma_trend',
  ];
  for (const k of knownKeys) {
    assert(`map 含 ${k}`, sourceMap.has(k));
  }

  console.log('--- 文件名 / 路径合理 ---');
  const mfa = sourceMap.get('multi_factor_alpha');
  if (mfa) {
    assert(
      `multi_factor_alpha → MultiFactorAlphaStrategy.ts (实际 ${mfa.filename})`,
      mfa.filename === 'MultiFactorAlphaStrategy.ts'
    );
    assert(
      `relative_path 形如 src/quant/strategies/* (实际 ${mfa.relative_path})`,
      mfa.relative_path.includes('quant/strategies') &&
        mfa.relative_path.endsWith('MultiFactorAlphaStrategy.ts')
    );
    assert(
      `absolute_path 是绝对路径 (实际 ${mfa.absolute_path})`,
      path.isAbsolute(mfa.absolute_path) && mfa.absolute_path.endsWith('.ts')
    );
  } else {
    failed += 1;
    console.log('  ✗ multi_factor_alpha 不在 map 内（前面断言已捕获）');
  }

  console.log('--- getStrategySource happy path ---');
  resetSourceMapCache();
  const service = new QuantStrategySourceService();

  const r1 = await service.getStrategySource('multi_factor_alpha');
  assert('返回 strategy_key 一致', r1.strategy_key === 'multi_factor_alpha');
  assert(
    `返回 filename === MultiFactorAlphaStrategy.ts (实际 ${r1.filename})`,
    r1.filename === 'MultiFactorAlphaStrategy.ts'
  );
  assert(`content 非空（实际长度 ${r1.content.length}）`, r1.content.length > 100);
  assert(
    `content 含 'strategy_key' 字符串（基本完整性检查）`,
    r1.content.includes('strategy_key')
  );
  assert(`byte_size > 0 (${r1.byte_size})`, r1.byte_size > 0);
  // content.length 是 utf-16 code unit 数（JS String），byte_size 是 utf-8 字节数
  // —— 中文文档 byte_size 会显著大于 content.length（每个汉字 3 字节 vs 1 code unit）。
  // 仅断言 byte_size ≥ content.length（utf-8 ≥ utf-16 单字符 for ascii，> for 多字节字符）。
  assert(
    `byte_size (${r1.byte_size}) >= content.length (${r1.content.length})`,
    r1.byte_size >= r1.content.length
  );

  console.log('--- getStrategySource 错误路径 ---');
  let invalidErr: any = null;
  try {
    await service.getStrategySource('../etc/passwd');
  } catch (e: any) {
    invalidErr = e;
  }
  assert('invalid_strategy_key 抛错', invalidErr !== null);
  assert(
    `error.code === INVALID_STRATEGY_KEY (实际 ${invalidErr?.code})`,
    invalidErr?.code === 'INVALID_STRATEGY_KEY'
  );

  let invalidUpperErr: any = null;
  try {
    await service.getStrategySource('Foo');
  } catch (e: any) {
    invalidUpperErr = e;
  }
  assert('大写也抛 INVALID_STRATEGY_KEY', invalidUpperErr?.code === 'INVALID_STRATEGY_KEY');

  let notFoundErr: any = null;
  try {
    await service.getStrategySource('definitely_does_not_exist_strategy_xyz');
  } catch (e: any) {
    notFoundErr = e;
  }
  assert('strategy_not_found 抛错', notFoundErr !== null);
  assert(
    `error.code === STRATEGY_NOT_FOUND (实际 ${notFoundErr?.code})`,
    notFoundErr?.code === 'STRATEGY_NOT_FOUND'
  );

  console.log('--- listAvailableStrategyKeys ---');
  const list = service.listAvailableStrategyKeys();
  assert(`返回数组 (实际 ${list.length})`, Array.isArray(list) && list.length >= 25);
  assert(
    '按 strategy_key 升序',
    list.every((entry, i) => i === 0 || list[i - 1].strategy_key <= entry.strategy_key)
  );
  assert(
    '每条都含 strategy_key / filename / file_path 三字段',
    list.every(
      e =>
        typeof e.strategy_key === 'string' &&
        typeof e.filename === 'string' &&
        typeof e.file_path === 'string'
    )
  );

  console.log('--- 缓存命中：第二次调用更快 ---');
  // 第一次调用已经触发缓存生成；第二次应该不再扫盘
  const t1 = Date.now();
  await service.getStrategySource('multi_factor_alpha');
  const t2 = Date.now();
  // 不做严格 timing 断言（CI 抖动大），仅断言 < 200ms（足够检测出"如果没缓存就重新扫盘"的回归）
  assert(`第二次调用 < 200ms (实际 ${t2 - t1}ms)`, t2 - t1 < 200);

  console.log('--- resetSourceMapCache 后重新扫描仍可用 ---');
  resetSourceMapCache();
  const r2 = await service.getStrategySource('dragon_head_momentum');
  assert('reset 后仍能拿到 dragon_head_momentum', r2.strategy_key === 'dragon_head_momentum');

  console.log('\n----------------------------------------');
  console.log(`Tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Test suite crashed:', err);
  process.exit(2);
});
