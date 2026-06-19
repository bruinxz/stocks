/**
 * US-049 [FE-010] FactorWorkspace picks inline 理由 单元测试.
 *
 * 不依赖 jest / DB / 网络 / React; 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/factor-pick-reason.test.ts
 *
 * 全部 import 自 frontend/src/pages/workspace/factorPickReasonHelpers.ts
 * (pure helpers, 无 antd/react, ts-node 直接吃). 跨 monorepo import 用相对
 * 路径 `../../../frontend/...`, 与 US-046/US-047 helper 单测同款.
 *
 * 覆盖维度:
 *   [1] 常量 sanity (PICK_REASON_MAX_CHARS / FALLBACK / FACTOR_NAME_LABELS / ACTION_PREFIX)
 *   [2] pickTopFactorContributors — 空 / null / 全 0 / NaN / k=0 / |z| 降序 / tie-break name 升序
 *   [3] formatFactorContrib — 正/负/0 数 / 未知 name fallback
 *   [4] truncatePickReason — ≤cap 不截 / =cap+1 截到 cap-1+'…' / 中文 codepoint
 *   [5] buildShortPickReason —
 *       (a) signal=buy + 完整 factor_z_scores → "新进 · 动量 +1.84 / 价值 +1.20"
 *       (b) signal=sell → "剔除 · ..."
 *       (c) signal=hold → "保留 · ..."
 *       (d) factor_z_scores 全空 + 有 composite → "新进 · composite +0.785"
 *       (e) factor_z_scores + composite 都空 → "新进 · 无理由数据" → 截断后仍含 fallback
 *       (f) null/undefined/非对象 → 兜底 fallback
 *       (g) 超长 reason 截断到 PICK_REASON_MAX_CHARS
 *   [6] META-GUARD fs+regex:
 *       (a) FactorWorkspace.tsx 含 import buildShortPickReason + key='inline_reason' 列
 *       (b) factorPickReasonHelpers.ts 主要 export 都在
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  PICK_REASON_MAX_CHARS,
  PICK_REASON_FALLBACK,
  FACTOR_NAME_LABELS,
  ACTION_PREFIX,
  pickTopFactorContributors,
  formatFactorContrib,
  truncatePickReason,
  buildShortPickReason,
} from '../../../frontend/src/pages/workspace/factorPickReasonHelpers';

let failed = 0;
let passed = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`❌ ${name}${detail ? '  detail=' + detail : ''}`);
  }
}

// ---- [1] 常量 sanity --------------------------------------------------------
assert('[1.1] PICK_REASON_MAX_CHARS 在合理范围', PICK_REASON_MAX_CHARS >= 30 && PICK_REASON_MAX_CHARS <= 200);
assert('[1.2] PICK_REASON_FALLBACK 非空', typeof PICK_REASON_FALLBACK === 'string' && PICK_REASON_FALLBACK.length > 0);
assert('[1.3] FACTOR_NAME_LABELS 含 8 个标准因子', [
  'value',
  'quality',
  'growth',
  'momentum',
  'low_vol',
  'northbound',
  'money_flow',
  'dragon_tiger',
].every(k => typeof FACTOR_NAME_LABELS[k] === 'string' && FACTOR_NAME_LABELS[k].length > 0));
assert('[1.4] ACTION_PREFIX 含 buy/sell/hold', !!ACTION_PREFIX.buy && !!ACTION_PREFIX.sell && !!ACTION_PREFIX.hold);

// ---- [2] pickTopFactorContributors -----------------------------------------
assert('[2.1] null → []', pickTopFactorContributors(null, 2).length === 0);
assert('[2.2] undefined → []', pickTopFactorContributors(undefined, 2).length === 0);
assert('[2.3] {} → []', pickTopFactorContributors({}, 2).length === 0);
assert('[2.4] 全 0 → []', pickTopFactorContributors({ value: 0, quality: 0 }, 2).length === 0);
assert('[2.5] NaN 排除', pickTopFactorContributors({ value: Number.NaN, quality: 1.5 }, 2).length === 1);
assert('[2.6] Infinity 排除', pickTopFactorContributors({ value: Number.POSITIVE_INFINITY, quality: 1.5 }, 2).length === 1);
assert('[2.7] k=0 → []', pickTopFactorContributors({ value: 1.5 }, 0).length === 0);
assert('[2.8] k<0 → []', pickTopFactorContributors({ value: 1.5 }, -1).length === 0);

{
  // |z| 降序: 动量 1.8 > 价值 -1.5 > 质量 0.3
  const tops = pickTopFactorContributors({ momentum: 1.8, value: -1.5, quality: 0.3 }, 2);
  assert('[2.9a] top-2 第一个是 momentum', tops[0]?.name === 'momentum' && tops[0]?.z === 1.8);
  assert('[2.9b] top-2 第二个是 value', tops[1]?.name === 'value' && tops[1]?.z === -1.5);
  assert('[2.9c] quality 被切掉', tops.length === 2);
}

{
  // |z| 相等 → name 升序
  const tops = pickTopFactorContributors({ value: 1.5, momentum: 1.5, quality: -1.5 }, 3);
  assert('[2.10a] tie-break 第一个是 momentum (字母序)', tops[0]?.name === 'momentum');
  assert('[2.10b] tie-break 第二个是 quality', tops[1]?.name === 'quality');
  assert('[2.10c] tie-break 第三个是 value', tops[2]?.name === 'value');
}

// ---- [3] formatFactorContrib -----------------------------------------------
assert('[3.1] 正数带 +', formatFactorContrib('momentum', 1.84) === '动量 +1.84');
assert('[3.2] 负数带 -', formatFactorContrib('value', -1.2) === '价值 -1.20');
assert('[3.3] 0 视为正', formatFactorContrib('value', 0) === '价值 +0.00');
assert('[3.4] 未知 factor 用原名', formatFactorContrib('unknown_factor', 0.5) === 'unknown_factor +0.50');

// ---- [4] truncatePickReason ------------------------------------------------
assert('[4.1] null → fallback', truncatePickReason(null) === PICK_REASON_FALLBACK);
assert('[4.2] 空串 → fallback', truncatePickReason('') === PICK_REASON_FALLBACK);
assert('[4.3] 非 string → fallback', truncatePickReason(123 as unknown as string) === PICK_REASON_FALLBACK);
{
  const exact = 'a'.repeat(PICK_REASON_MAX_CHARS);
  assert('[4.4] 恰好 cap → 原样', truncatePickReason(exact) === exact);
}
{
  const over = 'a'.repeat(PICK_REASON_MAX_CHARS + 1);
  const got = truncatePickReason(over);
  assert('[4.5a] cap+1 截到 cap', Array.from(got).length === PICK_REASON_MAX_CHARS);
  assert('[4.5b] 截尾带 …', got.endsWith('…'));
}
{
  // 中文 codepoint 按字符算
  const chinese = '你好世界'.repeat(20); // 80 个 codepoint
  const got = truncatePickReason(chinese);
  assert('[4.6] 中文截到 cap codepoint', Array.from(got).length === PICK_REASON_MAX_CHARS);
}

// ---- [5] buildShortPickReason ----------------------------------------------
type Signal = Parameters<typeof buildShortPickReason>[0];

{
  // (a) signal=buy 有完整 factor_z
  const sig = {
    stock_code: '000001',
    name: '平安银行',
    industry: '银行',
    signal: 'buy' as const,
    composite_score: 0.78,
    factor_z_scores: { momentum: 1.84, value: 1.2, quality: 0.5 },
    reason: '新进入选：composite=0.780',
  };
  const r = buildShortPickReason(sig);
  assert('[5a.1] 含动作前缀 "新进"', r.startsWith('新进 · '));
  assert('[5a.2] 含 "动量 +1.84"', r.includes('动量 +1.84'));
  assert('[5a.3] 含 "价值 +1.20"', r.includes('价值 +1.20'));
  assert('[5a.4] 不含 "质量" (top-2 之外)', !r.includes('质量'));
  assert('[5a.5] 长度不超过 cap', Array.from(r).length <= PICK_REASON_MAX_CHARS);
}

{
  // (b) signal=sell
  const sig = {
    stock_code: '000002',
    name: '万科',
    industry: '房地产',
    signal: 'sell' as const,
    composite_score: -0.5,
    factor_z_scores: { momentum: -1.5, value: 0.2 },
    reason: '跌出 top-30',
  };
  const r = buildShortPickReason(sig);
  assert('[5b.1] sell 动作前缀 "剔除"', r.startsWith('剔除 · '));
  assert('[5b.2] 含 "动量 -1.50"', r.includes('动量 -1.50'));
}

{
  // (c) signal=hold
  const sig = {
    stock_code: '600519',
    name: '茅台',
    industry: '食品饮料',
    signal: 'hold' as const,
    composite_score: 0.6,
    factor_z_scores: { quality: 2.0 },
    reason: '保留',
  };
  const r = buildShortPickReason(sig);
  assert('[5c.1] hold 动作前缀 "保留"', r.startsWith('保留 · '));
  assert('[5c.2] 含 "质量 +2.00"', r.includes('质量 +2.00'));
}

{
  // (d) factor_z_scores 全空 + 有 composite → 降级 composite
  const sig: Signal = {
    stock_code: '000003',
    name: 'X',
    industry: null,
    signal: 'buy',
    composite_score: 0.785,
    factor_z_scores: {},
    reason: '',
  };
  const r = buildShortPickReason(sig);
  assert('[5d.1] 有动作前缀 "新进"', r.startsWith('新进 · '));
  assert('[5d.2] 含 "composite +0.785"', r.includes('composite +0.785'));
}

{
  // (e) factor_z + composite 都空 → fallback
  const sig: Signal = {
    stock_code: '000004',
    name: 'Y',
    industry: null,
    signal: 'buy',
    composite_score: Number.NaN,
    factor_z_scores: {},
    reason: '',
  };
  const r = buildShortPickReason(sig);
  assert('[5e.1] 退化到 fallback', r.includes(PICK_REASON_FALLBACK));
  // fallback 路径不该有 ' · ' 拼接 (动作前缀对 fallback 没意义)
  assert('[5e.2] 不带 · 拼接', !r.includes(' · '));
}

{
  // (f) 非法输入: null / undefined / 字符串 / 数字
  assert('[5f.1] null 兜底', buildShortPickReason(null) === PICK_REASON_FALLBACK);
  assert('[5f.2] undefined 兜底', buildShortPickReason(undefined) === PICK_REASON_FALLBACK);
  assert('[5f.3] string 兜底', buildShortPickReason('xxx' as unknown as Signal) === PICK_REASON_FALLBACK);
  assert('[5f.4] number 兜底', buildShortPickReason(42 as unknown as Signal) === PICK_REASON_FALLBACK);
}

{
  // (g) 超长 reason: 8 个高 z 因子 → 拼出来超过 cap → 必须被截
  const sig = {
    stock_code: '000005',
    name: '超长测试',
    industry: '银行',
    signal: 'buy' as const,
    composite_score: 0.5,
    factor_z_scores: {
      momentum: 10.123,
      value: 9.876,
      quality: 8.5,
      growth: 7.5,
      low_vol: 6.5,
      northbound: 5.5,
      money_flow: 4.5,
      dragon_tiger: 3.5,
    },
    reason: '',
  };
  const r = buildShortPickReason(sig);
  assert('[5g.1] 超长被截', Array.from(r).length <= PICK_REASON_MAX_CHARS);
  // top-2 是 momentum 和 value, 应该都在 (top-2 不会被截掉, 因为 cap=60 容得下 2 项)
  assert('[5g.2] top-2 至少 momentum 进', r.includes('动量'));
}

// ---- [6] META-GUARD fs+regex -----------------------------------------------
{
  const workspacePath = join(__dirname, '../../../frontend/src/pages/workspace/FactorWorkspace.tsx');
  const src = readFileSync(workspacePath, 'utf8');
  assert(
    '[6.1] FactorWorkspace.tsx 含 import buildShortPickReason',
    /import\s*\{\s*buildShortPickReason\s*\}\s*from\s*['"]\.\/factorPickReasonHelpers['"]/.test(src)
  );
  assert(
    '[6.2] FactorWorkspace.tsx 含 inline_reason 列 key',
    /key:\s*['"]inline_reason['"]/.test(src)
  );
  assert(
    '[6.3] FactorWorkspace.tsx inline_reason 列调 buildShortPickReason',
    /buildShortPickReason\(record\)/.test(src)
  );
  assert(
    '[6.4] FactorWorkspace.tsx 列标题含 "理由"',
    /title:\s*['"]理由['"]/.test(src)
  );
}

{
  const helperPath = join(__dirname, '../../../frontend/src/pages/workspace/factorPickReasonHelpers.ts');
  const src = readFileSync(helperPath, 'utf8');
  assert('[6.5] helper export PICK_REASON_MAX_CHARS', /export\s+const\s+PICK_REASON_MAX_CHARS/.test(src));
  assert('[6.6] helper export PICK_REASON_FALLBACK', /export\s+const\s+PICK_REASON_FALLBACK/.test(src));
  assert('[6.7] helper export FACTOR_NAME_LABELS', /export\s+const\s+FACTOR_NAME_LABELS/.test(src));
  assert('[6.8] helper export ACTION_PREFIX', /export\s+const\s+ACTION_PREFIX/.test(src));
  assert('[6.9] helper export pickTopFactorContributors', /export\s+function\s+pickTopFactorContributors/.test(src));
  assert('[6.10] helper export buildShortPickReason', /export\s+function\s+buildShortPickReason/.test(src));
  assert('[6.11] helper export truncatePickReason', /export\s+function\s+truncatePickReason/.test(src));
}

// ---- summary ---------------------------------------------------------------
console.log(`\nfactor-pick-reason: ${passed} ok / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
