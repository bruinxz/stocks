/**
 * Batch CC (2026-06-25): formatEast8Readable 单测.
 *
 * 修复风控告警飞书 card 触发时间显示成 UTC Z 后缀的 bug — 把
 * `instance.created_at.toISOString()` (= "2026-06-25T08:09:00.597Z") 换成
 * `formatEast8Readable(instance.created_at)` (= "2026-06-25 16:09:00 (UTC+8)") 后,
 * 用户读到的时间就是北京本地, 不会再误以为系统时间错了.
 */

import { formatEast8Readable, getEast8TimeString } from '../../src/utils/timezone';

let passed = 0;
let failed = 0;

function assertEqual<T>(label: string, actual: T, expected: T): void {
  if (actual === expected) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}\n    expected: ${expected}\n    actual:   ${actual}`);
    failed++;
  }
}

function assert(label: string, cond: boolean): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

console.log('=== formatEast8Readable ===\n');

console.log('[1] ISO UTC string → 北京本地 + UTC+8 后缀');
assertEqual(
  '截图原始时间 2026-06-25T08:09:00.597Z → 16:09 北京',
  formatEast8Readable('2026-06-25T08:09:00.597Z'),
  '2026-06-25 16:09:00 (UTC+8)'
);
assertEqual(
  '凌晨 0:0:0 UTC → 上海 8:0:0',
  formatEast8Readable('2026-06-25T00:00:00.000Z'),
  '2026-06-25 08:00:00 (UTC+8)'
);

console.log('\n[2] 跨日 / 跨月边界');
assertEqual(
  '23:30 UTC → 第二天 7:30 北京',
  formatEast8Readable('2026-06-25T23:30:00.000Z'),
  '2026-06-26 07:30:00 (UTC+8)'
);
assertEqual(
  '月末跨月 (5月31日 17:0:0 UTC → 6月1日 1:0:0 上海)',
  formatEast8Readable('2026-05-31T17:00:00.000Z'),
  '2026-06-01 01:00:00 (UTC+8)'
);

console.log('\n[3] Date 对象输入');
const d = new Date('2026-06-25T08:09:00.597Z');
assertEqual(
  'Date 对象与同 ISO 字符串结果一致',
  formatEast8Readable(d),
  '2026-06-25 16:09:00 (UTC+8)'
);

console.log('\n[4] 兜底路径');
assertEqual('无参数 → 当前时间, 含 (UTC+8) 后缀', formatEast8Readable().endsWith(' (UTC+8)'), true);
assertEqual('空字符串 → 兜底 —', formatEast8Readable(''), '—');
assertEqual('非法字符串 → 兜底 —', formatEast8Readable('garbage'), '—');
assertEqual(
  '非法 Date → 兜底 —',
  formatEast8Readable(new Date('not-a-date')),
  '—'
);

console.log('\n[5] 单填 0 / 单位 padding');
assertEqual(
  '个位数月日时分秒补 0',
  formatEast8Readable('2026-01-02T00:01:02.000Z'),
  '2026-01-02 08:01:02 (UTC+8)'
);

console.log('\n[6] 与既有 getEast8TimeString 对比');
const isoForm = getEast8TimeString(d);
// 例如 '2026-06-25T16:09:00.597+08:00'
assert(
  'getEast8TimeString 走 ISO 形态 (+08:00 后缀, 不易读)',
  isoForm.includes('+08:00') && isoForm.includes('T')
);
assert(
  'formatEast8Readable 走人类可读形态 (空格分隔日期/时间 + UTC+8 后缀)',
  formatEast8Readable(d).includes('(UTC+8)') &&
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(formatEast8Readable(d))
);

console.log('\n[7] META-GUARD: 当告警 hook 把本助手输出传给 dispatcher / pusher 时,');
console.log('    下游模板 "${triggered_at}" 直接拼接, 渲染结果含 UTC+8 上下文.');
const triggered_at = formatEast8Readable('2026-06-25T08:09:00.597Z');
const feishu_note_content = `触发时间: ${triggered_at}`;
assert(
  '飞书 note 区显示含 UTC+8',
  /UTC\+8/.test(feishu_note_content)
);
assert(
  '飞书 note 区不再含 Z 后缀',
  !/Z(\b|$)/.test(feishu_note_content)
);
assert(
  '飞书 note 区时间是北京 16:09 不是 UTC 08:09',
  feishu_note_content.includes('16:09')
);

console.log('\n--------------------------------------------------------------');
console.log(`Total: ${passed} ok, ${failed} failed`);
console.log('--------------------------------------------------------------');
if (failed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
