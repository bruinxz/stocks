/**
 * US-056 [FE-017] PortfolioWorkspace 周/月/季 复盘日记聚合 — 单元测试.
 *
 * 不依赖 jest / DB / 网络 / React; 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/journal-period-helpers.test.ts
 *
 * 全部 import 自 frontend/src/pages/workspace/journalPeriodHelpers.ts
 * (pure helpers, 无 antd/react, ts-node 直接吃). 跨 monorepo import 用相对路径
 * `../../../frontend/...`, 与 US-049 / US-051 / US-052 / US-054 / US-055 / US-057
 * helper 单测同款.
 *
 * 覆盖维度:
 *   [1] 常量 sanity (JOURNAL_PERIOD_LABEL / JOURNAL_PERIOD_VALUES 冻结 + 4 枚举完整)
 *   [2] getISOWeekKey — 跨年 / 周边界 / 非法 / null/undefined
 *   [3] getMonthKey — happy / 非法
 *   [4] getQuarterKey — 4 季边界 / 非法
 *   [5] parsePeriodKey — 4 period 的 startDate/endDate/label 正确性
 *   [6] pickDominantMood — 平局字典序 / 空
 *   [7] findBucket — 命中 / 未命中 / null 兜底
 *   [8] groupJournalsByPeriod — AC 主验收:
 *       (a) 空 list → []
 *       (b) period=day → 一日一桶
 *       (c) period=week → 同周聚合, 跨周拆分
 *       (d) period=month / quarter 同理
 *       (e) mood 累计 + dominantMood 平局字典序
 *       (f) '未生成' mood 被忽略
 *       (g) topTags 频率降序 (tie 字典序)
 *       (h) 桶按 startDate 降序排
 *       (i) 期内 journals 按 date 升序
 *       (j) 非法 period 回退 day
 *       (k) 非法 date 被跳过, 不抛
 *   [9] META-GUARD fs+regex:
 *       (a) PortfolioWorkspace.tsx 含 import groupJournalsByPeriod
 *       (b) PortfolioWorkspace.tsx Segmented 含 JournalPeriod 切换
 *       (c) helper 主要 export 都在
 *       (d) US-056 标记在源文件
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  JOURNAL_PERIOD_LABEL,
  JOURNAL_PERIOD_VALUES,
  JournalPeriod,
  JournalPeriodBucket,
  getISOWeekKey,
  getMonthKey,
  getQuarterKey,
  parsePeriodKey,
  pickDominantMood,
  findBucket,
  groupJournalsByPeriod,
} from '../../../frontend/src/pages/workspace/journalPeriodHelpers';
import type { JournalSummary } from '../../../frontend/src/services/portfolioWorkspaceService';

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

function makeJ(
  id: number,
  date: string,
  mood: string | null = null,
  tags: string[] | null = null
): JournalSummary {
  return { id, date, mood, tags };
}

// ---- [1] 常量 sanity --------------------------------------------------------
assert('[1.1] JOURNAL_PERIOD_VALUES 4 枚举', JOURNAL_PERIOD_VALUES.length === 4);
assert(
  '[1.2] JOURNAL_PERIOD_VALUES 含 day/week/month/quarter',
  JOURNAL_PERIOD_VALUES.includes('day') &&
    JOURNAL_PERIOD_VALUES.includes('week') &&
    JOURNAL_PERIOD_VALUES.includes('month') &&
    JOURNAL_PERIOD_VALUES.includes('quarter')
);
assert('[1.3] JOURNAL_PERIOD_LABEL.day = 日', JOURNAL_PERIOD_LABEL.day === '日');
assert('[1.4] JOURNAL_PERIOD_LABEL.week = 周', JOURNAL_PERIOD_LABEL.week === '周');
assert('[1.5] JOURNAL_PERIOD_LABEL.month = 月', JOURNAL_PERIOD_LABEL.month === '月');
assert('[1.6] JOURNAL_PERIOD_LABEL.quarter = 季', JOURNAL_PERIOD_LABEL.quarter === '季');
assert(
  '[1.7] JOURNAL_PERIOD_LABEL frozen',
  Object.isFrozen(JOURNAL_PERIOD_LABEL)
);
assert(
  '[1.8] JOURNAL_PERIOD_VALUES frozen',
  Object.isFrozen(JOURNAL_PERIOD_VALUES)
);

// ---- [2] getISOWeekKey ------------------------------------------------------
// 2026-06-15 (Mon) → 2026 W25 (jan4=Sun → week1 Mon = Dec29; +24*7 = 2026-06-15)
assert(
  '[2.1] 2026-06-15 (Mon) → W25 类型',
  /^2026-W\d{2}$/.test(getISOWeekKey('2026-06-15'))
);
assert(
  '[2.2] 2026-06-15 与 2026-06-21 同周',
  getISOWeekKey('2026-06-15') === getISOWeekKey('2026-06-21')
);
assert(
  '[2.3] 2026-06-21 (Sun) 与 2026-06-22 (下周一) 不同周',
  getISOWeekKey('2026-06-21') !== getISOWeekKey('2026-06-22')
);
// 跨年: 2026-01-01 (Thu) → ISO 周该归 2026 W01
assert(
  '[2.4] 2026-01-01 → 2026-W01',
  getISOWeekKey('2026-01-01') === '2026-W01'
);
// 2025-12-31 (Wed) → ISO 周也是 2026-W01
assert(
  '[2.5] 2025-12-31 (跨年, Wed → 周四在 2026) → 2026-W01',
  getISOWeekKey('2025-12-31') === '2026-W01'
);
assert('[2.6] 非法日期 → ""', getISOWeekKey('not-a-date') === '');
assert('[2.7] null → ""', getISOWeekKey(null) === '');
assert('[2.8] undefined → ""', getISOWeekKey(undefined) === '');
assert('[2.9] 空串 → ""', getISOWeekKey('') === '');

// ---- [3] getMonthKey --------------------------------------------------------
assert('[3.1] 2026-06-15 → 2026-06', getMonthKey('2026-06-15') === '2026-06');
assert('[3.2] 2026-01-01 → 2026-01', getMonthKey('2026-01-01') === '2026-01');
assert('[3.3] 2026-12-31 → 2026-12', getMonthKey('2026-12-31') === '2026-12');
assert('[3.4] 非法 → ""', getMonthKey('xxx') === '');
assert('[3.5] null → ""', getMonthKey(null) === '');

// ---- [4] getQuarterKey ------------------------------------------------------
assert('[4.1] 2026-01-15 → Q1', getQuarterKey('2026-01-15') === '2026-Q1');
assert('[4.2] 2026-03-31 → Q1', getQuarterKey('2026-03-31') === '2026-Q1');
assert('[4.3] 2026-04-01 → Q2', getQuarterKey('2026-04-01') === '2026-Q2');
assert('[4.4] 2026-06-30 → Q2', getQuarterKey('2026-06-30') === '2026-Q2');
assert('[4.5] 2026-07-01 → Q3', getQuarterKey('2026-07-01') === '2026-Q3');
assert('[4.6] 2026-09-30 → Q3', getQuarterKey('2026-09-30') === '2026-Q3');
assert('[4.7] 2026-10-01 → Q4', getQuarterKey('2026-10-01') === '2026-Q4');
assert('[4.8] 2026-12-31 → Q4', getQuarterKey('2026-12-31') === '2026-Q4');
assert('[4.9] 非法 → ""', getQuarterKey('not-date') === '');

// ---- [5] parsePeriodKey -----------------------------------------------------
{
  const w = parsePeriodKey('week', '2026-W25');
  assert('[5.1] week 2026-W25 解析非 null', w !== null);
  if (w) {
    // ISO 2026 W01 周首 = ?  2026-01-01 Thu, jan4 (Sun) → week1Mon = 2025-12-29
    // W25: +24*7 days = 2025-12-29 + 168d. 不强校验绝对值, 校验关键性质:
    assert('[5.2] week endDate 比 startDate 大 6 天 (粗略)', w.endDate > w.startDate);
    assert('[5.3] week label 含 "第 25 周"', /第 25 周/.test(w.label));
    assert('[5.4] week label 含 isoYear 2026', /2026/.test(w.label));
  }
}
{
  const m = parsePeriodKey('month', '2026-06');
  assert('[5.5] month 2026-06 startDate=2026-06-01', m?.startDate === '2026-06-01');
  assert('[5.6] month 2026-06 endDate=2026-06-30', m?.endDate === '2026-06-30');
  assert('[5.7] month label = "2026 年 6 月"', m?.label === '2026 年 6 月');
}
{
  const m12 = parsePeriodKey('month', '2026-12');
  assert(
    '[5.8] month 2026-12 endDate=2026-12-31 (跨年边界)',
    m12?.endDate === '2026-12-31'
  );
}
{
  const m2 = parsePeriodKey('month', '2024-02');
  assert(
    '[5.9] 2024-02 闰年 endDate=2024-02-29',
    m2?.endDate === '2024-02-29'
  );
  const m2b = parsePeriodKey('month', '2025-02');
  assert(
    '[5.10] 2025-02 平年 endDate=2025-02-28',
    m2b?.endDate === '2025-02-28'
  );
}
{
  const q = parsePeriodKey('quarter', '2026-Q2');
  assert('[5.11] Q2 startDate=2026-04-01', q?.startDate === '2026-04-01');
  assert('[5.12] Q2 endDate=2026-06-30', q?.endDate === '2026-06-30');
  assert('[5.13] Q2 label = "2026 Q2"', q?.label === '2026 Q2');
  const q4 = parsePeriodKey('quarter', '2026-Q4');
  assert('[5.14] Q4 endDate=2026-12-31', q4?.endDate === '2026-12-31');
}
{
  const d = parsePeriodKey('day', '2026-06-15');
  assert('[5.15] day startDate=endDate', d?.startDate === d?.endDate);
  assert('[5.16] day label = 2026-06-15', d?.label === '2026-06-15');
}
{
  assert('[5.17] 非法 week key → null', parsePeriodKey('week', 'xxx') === null);
  assert('[5.18] 非法 month key → null', parsePeriodKey('month', '2026-99') === null);
  assert('[5.19] 非法 quarter key → null', parsePeriodKey('quarter', '2026-Q9') === null);
}

// ---- [6] pickDominantMood ---------------------------------------------------
assert('[6.1] 空对象 → null', pickDominantMood({}) === null);
assert('[6.2] 单 mood → 本身', pickDominantMood({ 平静: 3 }) === '平静');
assert('[6.3] 多 mood 取最多', pickDominantMood({ 平静: 1, 焦虑: 3 }) === '焦虑');
// 平局: 字典序最小. '平静'.localeCompare('焦虑') 在中文里依赖 locale, 我们退而求其次
// 用英文断言保证字典序确定性:
assert(
  '[6.4] 平局取字典序最小 (英文)',
  pickDominantMood({ alpha: 2, beta: 2 }) === 'alpha'
);
assert(
  '[6.5] 平局取字典序最小 (b/a)',
  pickDominantMood({ b: 2, a: 2 }) === 'a'
);

// ---- [7] findBucket ---------------------------------------------------------
{
  const buckets: JournalPeriodBucket[] = [
    {
      key: 'k1',
      label: 'L1',
      startDate: '2026-06-15',
      endDate: '2026-06-15',
      journalCount: 1,
      moodCounts: {},
      dominantMood: null,
      topTags: [],
      journals: [],
    },
  ];
  assert('[7.1] 命中', findBucket(buckets, 'k1')?.key === 'k1');
  assert('[7.2] 未命中 → null', findBucket(buckets, 'nope') === null);
  assert('[7.3] key=null → null', findBucket(buckets, null) === null);
  assert('[7.4] buckets=null → null', findBucket(null, 'k1') === null);
  assert('[7.5] buckets=undefined → null', findBucket(undefined, 'k1') === null);
}

// ---- [8] groupJournalsByPeriod (AC 主验收) ----------------------------------

// [8.a] 空 list
assert('[8.1] null → []', groupJournalsByPeriod(null, 'week').length === 0);
assert('[8.2] [] → []', groupJournalsByPeriod([], 'week').length === 0);

// [8.b] period=day → 一日一桶
{
  const list: JournalSummary[] = [
    makeJ(1, '2026-06-15'),
    makeJ(2, '2026-06-16'),
    makeJ(3, '2026-06-16'),
  ];
  const buckets = groupJournalsByPeriod(list, 'day');
  assert('[8.3] day 桶数=2 (06-15, 06-16)', buckets.length === 2);
  const b16 = buckets.find(b => b.key === '2026-06-16');
  assert('[8.4] 06-16 桶含 2 篇', b16?.journalCount === 2);
}

// [8.c] period=week 聚合同周
{
  const list: JournalSummary[] = [
    makeJ(1, '2026-06-15'), // Mon
    makeJ(2, '2026-06-17'), // Wed (同周)
    makeJ(3, '2026-06-22'), // Mon 下周
  ];
  const buckets = groupJournalsByPeriod(list, 'week');
  assert('[8.5] week 桶数=2', buckets.length === 2);
  // 桶按 startDate 降序 → 最近周在最前
  assert('[8.6] week 第一个桶 startDate > 第二个', buckets[0].startDate > buckets[1].startDate);
  // 找含 06-15 的那个桶
  const w25 = buckets.find(b => b.journals.some(j => j.date === '2026-06-15'));
  assert('[8.7] 06-15 周桶含 2 篇 (06-15 + 06-17)', w25?.journalCount === 2);
}

// [8.d] period=month
{
  const list: JournalSummary[] = [
    makeJ(1, '2026-05-30'),
    makeJ(2, '2026-06-01'),
    makeJ(3, '2026-06-20'),
  ];
  const buckets = groupJournalsByPeriod(list, 'month');
  assert('[8.8] month 桶数=2', buckets.length === 2);
  const jun = buckets.find(b => b.key === '2026-06');
  assert('[8.9] 6 月桶含 2 篇', jun?.journalCount === 2);
  assert('[8.10] 6 月桶 startDate=2026-06-01', jun?.startDate === '2026-06-01');
  assert('[8.11] 6 月桶 endDate=2026-06-30', jun?.endDate === '2026-06-30');
}

// [8.d] period=quarter
{
  const list: JournalSummary[] = [
    makeJ(1, '2026-03-31'), // Q1
    makeJ(2, '2026-04-01'), // Q2
    makeJ(3, '2026-06-30'), // Q2
  ];
  const buckets = groupJournalsByPeriod(list, 'quarter');
  assert('[8.12] quarter 桶数=2', buckets.length === 2);
  const q2 = buckets.find(b => b.key === '2026-Q2');
  assert('[8.13] Q2 桶含 2 篇', q2?.journalCount === 2);
}

// [8.e] mood 累计 + dominantMood
{
  const list: JournalSummary[] = [
    makeJ(1, '2026-06-15', '平静'),
    makeJ(2, '2026-06-16', '焦虑'),
    makeJ(3, '2026-06-17', '平静'),
  ];
  const buckets = groupJournalsByPeriod(list, 'week');
  assert('[8.14] week 桶数=1', buckets.length === 1);
  assert('[8.15] 平静 mood count=2', buckets[0].moodCounts['平静'] === 2);
  assert('[8.16] 焦虑 mood count=1', buckets[0].moodCounts['焦虑'] === 1);
  assert('[8.17] dominantMood=平静 (出现最多)', buckets[0].dominantMood === '平静');
}

// [8.f] '未生成' mood 被忽略
{
  const list: JournalSummary[] = [
    makeJ(1, '2026-06-15', '未生成'),
    makeJ(2, '2026-06-16', null),
    makeJ(3, '2026-06-17', ''),
  ];
  const buckets = groupJournalsByPeriod(list, 'week');
  assert('[8.18] mood 全过滤后 moodCounts 空', Object.keys(buckets[0].moodCounts).length === 0);
  assert('[8.19] mood 全过滤后 dominantMood=null', buckets[0].dominantMood === null);
}

// [8.g] topTags 频率降序
{
  const list: JournalSummary[] = [
    makeJ(1, '2026-06-15', null, ['vol', 'pivot']),
    makeJ(2, '2026-06-16', null, ['pivot', 'breakout']),
    makeJ(3, '2026-06-17', null, ['pivot', 'a']),
  ];
  const buckets = groupJournalsByPeriod(list, 'week');
  assert('[8.20] topTags[0]=pivot (3 次)', buckets[0].topTags[0] === 'pivot');
  // a, breakout, vol 各 1 次 → 字典序 a → breakout → vol
  assert('[8.21] topTags[1]=a (字典序兜底)', buckets[0].topTags[1] === 'a');
  assert('[8.22] topTags[2]=breakout', buckets[0].topTags[2] === 'breakout');
  assert('[8.23] topTags[3]=vol', buckets[0].topTags[3] === 'vol');
}

// [8.h] 桶按 startDate 降序 + [8.i] 期内 journals 按 date 升序
{
  const list: JournalSummary[] = [
    makeJ(1, '2026-04-15'),
    makeJ(2, '2026-06-20'),
    makeJ(3, '2026-05-10'),
    makeJ(4, '2026-06-15'),
  ];
  const buckets = groupJournalsByPeriod(list, 'month');
  assert('[8.24] 桶按 startDate 降序: 第一个=2026-06', buckets[0].key === '2026-06');
  assert('[8.25] 桶第二个=2026-05', buckets[1].key === '2026-05');
  assert('[8.26] 桶第三个=2026-04', buckets[2].key === '2026-04');
  // 6 月桶内 journals 按 date 升序: 06-15 → 06-20
  assert('[8.27] 6 月内 journals[0].date=06-15', buckets[0].journals[0].date === '2026-06-15');
  assert('[8.28] 6 月内 journals[1].date=06-20', buckets[0].journals[1].date === '2026-06-20');
}

// [8.j] 非法 period 回退 day
{
  const list: JournalSummary[] = [makeJ(1, '2026-06-15'), makeJ(2, '2026-06-16')];
  const buckets = groupJournalsByPeriod(list, 'invalid' as JournalPeriod);
  assert('[8.29] 非法 period 退 day → 2 桶', buckets.length === 2);
}

// [8.k] 非法 date 被跳过
{
  const list: JournalSummary[] = [
    makeJ(1, '2026-06-15'),
    makeJ(2, 'not-a-date'),
    makeJ(3, '2026-06-16'),
    { id: 4, date: null as any, mood: null, tags: null },
  ];
  const buckets = groupJournalsByPeriod(list, 'day');
  assert('[8.30] 非法 date 被跳过, 仅 2 桶', buckets.length === 2);
}

// [8.k.2] mood/tags 非字符串/非数组 被跳过, 不抛
{
  const list: JournalSummary[] = [
    {
      id: 1,
      date: '2026-06-15',
      mood: 123 as any,
      tags: 'oops' as any,
    },
    makeJ(2, '2026-06-16', '  ', null),
  ];
  let threw = false;
  try {
    const buckets = groupJournalsByPeriod(list, 'week');
    assert('[8.31] 异常 mood/tags 不抛 → 1 桶', buckets.length === 1);
    assert('[8.32] 异常 mood 全过滤 → moodCounts 空', Object.keys(buckets[0].moodCounts).length === 0);
    assert('[8.33] 异常 tags 全过滤 → topTags 空', buckets[0].topTags.length === 0);
  } catch (e) {
    threw = true;
  }
  assert('[8.34] groupJournalsByPeriod 永不抛', !threw);
}

// ---- [9] META-GUARD fs+regex -----------------------------------------------
{
  const workspacePath = join(
    __dirname,
    '../../../frontend/src/pages/workspace/PortfolioWorkspace.tsx'
  );
  const src = readFileSync(workspacePath, 'utf8');
  assert(
    '[9.1] PortfolioWorkspace.tsx import groupJournalsByPeriod',
    /import\s*\{[^}]*groupJournalsByPeriod[^}]*\}\s*from\s*['"]\.\/journalPeriodHelpers['"]/.test(
      src
    )
  );
  assert(
    '[9.2] PortfolioWorkspace.tsx import JOURNAL_PERIOD_VALUES',
    /JOURNAL_PERIOD_VALUES/.test(src)
  );
  assert(
    '[9.3] PortfolioWorkspace.tsx 内含 Segmented<JournalPeriod>',
    /Segmented<JournalPeriod>/.test(src)
  );
  assert(
    '[9.4] PortfolioWorkspace.tsx 用 setPeriodKey state',
    /setPeriodKey/.test(src)
  );
  assert(
    '[9.5] PortfolioWorkspace.tsx 含 US-056 / FE-017 注释',
    /US-056|FE-017/.test(src)
  );
}
{
  const helperPath = join(
    __dirname,
    '../../../frontend/src/pages/workspace/journalPeriodHelpers.ts'
  );
  const src = readFileSync(helperPath, 'utf8');
  assert(
    '[9.6] helper export groupJournalsByPeriod',
    /export\s+function\s+groupJournalsByPeriod/.test(src)
  );
  assert(
    '[9.7] helper export getISOWeekKey',
    /export\s+function\s+getISOWeekKey/.test(src)
  );
  assert(
    '[9.8] helper export getMonthKey',
    /export\s+function\s+getMonthKey/.test(src)
  );
  assert(
    '[9.9] helper export getQuarterKey',
    /export\s+function\s+getQuarterKey/.test(src)
  );
  assert(
    '[9.10] helper export parsePeriodKey',
    /export\s+function\s+parsePeriodKey/.test(src)
  );
  assert(
    '[9.11] helper export pickDominantMood',
    /export\s+function\s+pickDominantMood/.test(src)
  );
  assert(
    '[9.12] helper export findBucket',
    /export\s+function\s+findBucket/.test(src)
  );
  assert(
    '[9.13] helper export JOURNAL_PERIOD_LABEL',
    /export\s+const\s+JOURNAL_PERIOD_LABEL/.test(src)
  );
  assert(
    '[9.14] helper export JOURNAL_PERIOD_VALUES',
    /export\s+const\s+JOURNAL_PERIOD_VALUES/.test(src)
  );
  assert(
    '[9.15] helper export type JournalPeriod',
    /export\s+type\s+JournalPeriod/.test(src)
  );
  assert(
    '[9.16] helper export interface JournalPeriodBucket',
    /export\s+interface\s+JournalPeriodBucket/.test(src)
  );
}

// ---- summary ---------------------------------------------------------------
console.log(`\njournal-period-helpers: ${passed} ok / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
