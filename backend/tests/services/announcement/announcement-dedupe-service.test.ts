/**
 * AnnouncementDedupeService 单元测试 (US-118 [ANN-010]).
 *
 * 不依赖 jest / DB / 网络; node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/announcement/announcement-dedupe-service.test.ts
 *
 * 覆盖维度:
 *   - pure: parseAnnounceDate / daysBetween / buildClusterKey
 *   - pure: clusterAnnouncements (单 cluster / 多 cluster / 窗口 split / event_type=null 退化)
 *   - pure: buildDedupeRecords (canonical / duplicate_of)
 *   - pure: dedupeAnnouncements (一站式 + fail-OPEN trivial)
 *   - service.dedupe / service.runBatch (persist=false / persist=true / 异常 fail-OPEN)
 *   - **AC 验收: 20 条人工标注样本 dedupe_ratio ≥ 70%**
 */

import {
  AnnouncementDedupeInput,
  AnnouncementDedupeRecord,
  AnnouncementDedupeService,
  buildClusterKey,
  buildDedupeRecords,
  clusterAnnouncements,
  daysBetween,
  dedupeAnnouncements,
  DEDUPE_WINDOW_DAYS,
  DEDUPE_SERVICE_VERSION,
  MAX_ROWS_PER_DEDUPE,
  parseAnnounceDate,
  AnnouncementDedupeDataSource,
} from '../../../src/services/announcement/AnnouncementDedupeService';

let passed = 0;
let failed = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`❌ ${name}${detail ? '  detail=' + detail : ''}`);
  }
}

// ---- [1] 常量 ---------------------------------------------------------------
assert('[1.1] DEDUPE_WINDOW_DAYS = 7', DEDUPE_WINDOW_DAYS === 7);
assert(
  '[1.2] DEDUPE_SERVICE_VERSION 含 v 字串',
  typeof DEDUPE_SERVICE_VERSION === 'string' && /v\d+/i.test(DEDUPE_SERVICE_VERSION)
);
assert('[1.3] MAX_ROWS_PER_DEDUPE = 5000', MAX_ROWS_PER_DEDUPE === 5000);

// ---- [2] parseAnnounceDate / daysBetween / buildClusterKey ------------------
assert('[2.1] parse 合法日期', parseAnnounceDate('2026-06-19')?.toISOString().slice(0, 10) === '2026-06-19');
assert('[2.2] parse 非法格式返 null', parseAnnounceDate('2026/06/19') === null);
assert('[2.3] parse 空串返 null', parseAnnounceDate('') === null);
assert('[2.4] parse null 返 null', parseAnnounceDate(null) === null);
assert('[2.5] parse 月超界返 null', parseAnnounceDate('2026-13-01') === null);

const d1 = parseAnnounceDate('2026-06-19')!;
const d2 = parseAnnounceDate('2026-06-25')!;
assert('[2.6] daysBetween 6 天', daysBetween(d1, d2) === 6);
assert('[2.7] daysBetween 自己 = 0', daysBetween(d1, d1) === 0);
assert('[2.8] daysBetween null 返 Infinity', !Number.isFinite(daysBetween(null, d2)));

assert('[2.9] buildClusterKey 含 event_type', buildClusterKey('600519', '业绩') === '600519|业绩');
assert('[2.10] buildClusterKey event_type=null 退化 *', buildClusterKey('600519', null) === '600519|*');
assert('[2.11] buildClusterKey event_type=空串 退化 *', buildClusterKey('600519', '   ') === '600519|*');

// ---- [3] clusterAnnouncements -----------------------------------------------
{
  // 同公司 + 同事件 + 同窗口 → 1 cluster
  const rows: AnnouncementDedupeInput[] = [
    { id: 1, announce_date: '2026-06-19', stock_code: '600519', event_type: '业绩', original_title: '茅台业绩预告' },
    { id: 2, announce_date: '2026-06-20', stock_code: '600519', event_type: '业绩', original_title: '茅台业绩快报' },
    { id: 3, announce_date: '2026-06-21', stock_code: '600519', event_type: '业绩', original_title: '茅台业绩公告' },
  ];
  const c = clusterAnnouncements(rows);
  assert('[3.1] 3 行同 cluster', c.size === 1);
  const arr = Array.from(c.values())[0];
  assert('[3.2] cluster 含 3 行', arr.length === 3);
  assert('[3.3] cluster 内按 announce_date+id 排序', arr[0].id === 1 && arr[1].id === 2 && arr[2].id === 3);
}
{
  // 同公司 + 同事件 + 超窗口 → 2 cluster
  const rows: AnnouncementDedupeInput[] = [
    { id: 1, announce_date: '2026-06-01', stock_code: '600519', event_type: '业绩', original_title: 'Q1' },
    { id: 2, announce_date: '2026-06-15', stock_code: '600519', event_type: '业绩', original_title: 'Q2-跨窗口' },
  ];
  const c = clusterAnnouncements(rows);
  assert('[3.4] 超窗口 split 成 2 cluster', c.size === 2);
}
{
  // 不同公司或不同事件 → 不同 cluster
  const rows: AnnouncementDedupeInput[] = [
    { id: 1, announce_date: '2026-06-19', stock_code: '600519', event_type: '业绩', original_title: 'A' },
    { id: 2, announce_date: '2026-06-19', stock_code: '000858', event_type: '业绩', original_title: 'B' },
    { id: 3, announce_date: '2026-06-19', stock_code: '600519', event_type: '减持', original_title: 'C' },
  ];
  const c = clusterAnnouncements(rows);
  assert('[3.5] 3 cluster', c.size === 3);
}
{
  // event_type=null 退化按公司聚簇
  const rows: AnnouncementDedupeInput[] = [
    { id: 1, announce_date: '2026-06-19', stock_code: '600519', event_type: null, original_title: 'A' },
    { id: 2, announce_date: '2026-06-20', stock_code: '600519', event_type: null, original_title: 'B' },
  ];
  const c = clusterAnnouncements(rows);
  assert('[3.6] event_type=null 按公司聚簇 1 cluster', c.size === 1);
  assert('[3.7] cluster_key 含 |*', Array.from(c.keys())[0].endsWith('|*'));
}
{
  // 空输入 / 非数组
  assert('[3.8] 空数组返 size=0', clusterAnnouncements([]).size === 0);
  assert('[3.9] null 返 size=0', clusterAnnouncements(null).size === 0);
}
{
  // 边界: 恰好窗口 7 天 = 同 cluster
  const rows: AnnouncementDedupeInput[] = [
    { id: 1, announce_date: '2026-06-01', stock_code: '600519', event_type: '业绩', original_title: 'A' },
    { id: 2, announce_date: '2026-06-08', stock_code: '600519', event_type: '业绩', original_title: 'B' },
  ];
  const c = clusterAnnouncements(rows);
  assert('[3.10] 恰好 7 天差 = 同 cluster', c.size === 1);
}
{
  // 边界: 窗口+1=8 天 = 不同 cluster
  const rows: AnnouncementDedupeInput[] = [
    { id: 1, announce_date: '2026-06-01', stock_code: '600519', event_type: '业绩', original_title: 'A' },
    { id: 2, announce_date: '2026-06-09', stock_code: '600519', event_type: '业绩', original_title: 'B' },
  ];
  const c = clusterAnnouncements(rows);
  assert('[3.11] 8 天差 = 不同 cluster', c.size === 2);
}

// ---- [4] buildDedupeRecords -------------------------------------------------
{
  const c = clusterAnnouncements([
    { id: 1, announce_date: '2026-06-19', stock_code: '600519', event_type: '业绩', original_title: 'A' },
    { id: 2, announce_date: '2026-06-20', stock_code: '600519', event_type: '业绩', original_title: 'B' },
    { id: 3, announce_date: '2026-06-21', stock_code: '600519', event_type: '业绩', original_title: 'C' },
  ]);
  const recs = buildDedupeRecords(c);
  assert('[4.1] 3 records', recs.length === 3);
  const r1 = recs.find((r) => r.id === 1)!;
  const r2 = recs.find((r) => r.id === 2)!;
  const r3 = recs.find((r) => r.id === 3)!;
  assert('[4.2] id=1 canonical', r1.is_canonical && r1.duplicate_of === null);
  assert('[4.3] id=2 duplicate', !r2.is_canonical && r2.duplicate_of === 1);
  assert('[4.4] id=3 duplicate', !r3.is_canonical && r3.duplicate_of === 1);
  assert('[4.5] cluster_id 共享', r1.cluster_id === 1 && r2.cluster_id === 1 && r3.cluster_id === 1);
}

// ---- [5] dedupeAnnouncements 一站式 ----------------------------------------
{
  const res = dedupeAnnouncements([
    { id: 1, announce_date: '2026-06-19', stock_code: '600519', event_type: '业绩', original_title: 'A' },
    { id: 2, announce_date: '2026-06-20', stock_code: '600519', event_type: '业绩', original_title: 'B' },
    { id: 3, announce_date: '2026-06-19', stock_code: '000858', event_type: '业绩', original_title: 'C' },
  ]);
  assert('[5.1] total=3', res.total === 3);
  assert('[5.2] canonical_count=2', res.canonical_count === 2);
  assert('[5.3] duplicate_count=1', res.duplicate_count === 1);
  assert('[5.4] ratio ≈ 0.333', Math.abs(res.dedupe_ratio - 1 / 3) < 1e-6);
  assert('[5.5] clusters size=2', res.clusters.size === 2);
}
{
  const res = dedupeAnnouncements([]);
  assert('[5.6] empty: total=0 ratio=0', res.total === 0 && res.dedupe_ratio === 0);
}
{
  const res = dedupeAnnouncements(null);
  assert('[5.7] null: total=0', res.total === 0);
}

// ---- [6] service: dedupe / runBatch ----------------------------------------
const service = new AnnouncementDedupeService();
{
  const res = service.dedupe([
    { id: 1, announce_date: '2026-06-19', stock_code: '600519', event_type: '业绩', original_title: 'A' },
    { id: 2, announce_date: '2026-06-20', stock_code: '600519', event_type: '业绩', original_title: 'B' },
  ]);
  assert('[6.1] service.dedupe 直转 pure', res.total === 2 && res.canonical_count === 1);
}

// runBatch with fake DataSource
(async () => {
  const fakeRows: AnnouncementDedupeInput[] = [
    { id: 10, announce_date: '2026-06-19', stock_code: '600519', event_type: '业绩', original_title: 'A' },
    { id: 11, announce_date: '2026-06-20', stock_code: '600519', event_type: '业绩', original_title: 'B' },
    { id: 12, announce_date: '2026-06-19', stock_code: '000858', event_type: '减持', original_title: 'C' },
  ];
  let listCalls = 0;
  let persistedRecords: AnnouncementDedupeRecord[] = [];
  const fake: AnnouncementDedupeDataSource = {
    async listAnnouncements() {
      listCalls += 1;
      return fakeRows;
    },
    async persistDedupeMetadata(records) {
      persistedRecords = records;
      return records.length;
    },
  };
  const svc = new AnnouncementDedupeService(fake);
  const r1 = await svc.runBatch({ persist: false });
  assert('[6.2] runBatch persist=false 不调 persist', r1.persisted === 0 && persistedRecords.length === 0);
  assert('[6.3] runBatch 拉了一次 list', listCalls === 1);
  assert('[6.4] runBatch 返 total=3 canonical=2', r1.total === 3 && r1.canonical_count === 2);

  const r2 = await svc.runBatch({ persist: true });
  assert('[6.5] runBatch persist=true 调 persist', r2.persisted === 3 && persistedRecords.length === 3);
})();

// persistDedupeMetadata 异常 fail-OPEN
(async () => {
  const fake: AnnouncementDedupeDataSource = {
    async listAnnouncements() {
      return [
        { id: 1, announce_date: '2026-06-19', stock_code: '600519', event_type: '业绩', original_title: 'A' },
      ];
    },
    async persistDedupeMetadata() {
      throw new Error('boom');
    },
  };
  const svc = new AnnouncementDedupeService(fake);
  const r = await svc.runBatch({ persist: true });
  assert('[6.6] persist throw → persisted=0 不抛', r.persisted === 0 && r.total === 1);
})();

// list 失败 fail-OPEN
(async () => {
  const fake: AnnouncementDedupeDataSource = {
    async listAnnouncements() {
      return [];
    },
    async persistDedupeMetadata() {
      return 0;
    },
  };
  const svc = new AnnouncementDedupeService(fake);
  const r = await svc.runBatch({ persist: true });
  assert('[6.7] list 空 → total=0 ratio=0', r.total === 0 && r.dedupe_ratio === 0);
})();

// ---- [7] AC 验收: 20 条人工标注 dedupe_ratio ≥ 70% --------------------------
// 设计: 6 个 cluster, 共 20 行 — A(4) B(3) C(3) D(3) E(3) F(4) = 6 canonical, 14 duplicates.
// dedupe_ratio = 14/20 = 70%.
const AC_SAMPLES: AnnouncementDedupeInput[] = [
  // Cluster A: 茅台业绩 (4 行)
  { id: 101, announce_date: '2026-04-10', stock_code: '600519', event_type: '业绩', original_title: '茅台 2025 年报' },
  { id: 102, announce_date: '2026-04-12', stock_code: '600519', event_type: '业绩', original_title: '茅台业绩说明会' },
  { id: 103, announce_date: '2026-04-14', stock_code: '600519', event_type: '业绩', original_title: '茅台业绩问答' },
  { id: 104, announce_date: '2026-04-16', stock_code: '600519', event_type: '业绩', original_title: '茅台业绩补充' },
  // Cluster B: 宁德减持 (3 行)
  { id: 105, announce_date: '2026-05-01', stock_code: '300750', event_type: '减持', original_title: '宁德股东减持预披露' },
  { id: 106, announce_date: '2026-05-03', stock_code: '300750', event_type: '减持', original_title: '宁德减持进展 1' },
  { id: 107, announce_date: '2026-05-06', stock_code: '300750', event_type: '减持', original_title: '宁德减持进展 2' },
  // Cluster C: 平安担保 (3 行)
  { id: 108, announce_date: '2026-05-10', stock_code: '601318', event_type: '担保', original_title: '平安对外担保 1' },
  { id: 109, announce_date: '2026-05-11', stock_code: '601318', event_type: '担保', original_title: '平安担保进展' },
  { id: 110, announce_date: '2026-05-12', stock_code: '601318', event_type: '担保', original_title: '平安担保补充' },
  // Cluster D: 比亚迪重组 (3 行)
  { id: 111, announce_date: '2026-05-20', stock_code: '002594', event_type: '重组', original_title: '比亚迪资产重组草案' },
  { id: 112, announce_date: '2026-05-22', stock_code: '002594', event_type: '重组', original_title: '比亚迪重组进展' },
  { id: 113, announce_date: '2026-05-25', stock_code: '002594', event_type: '重组', original_title: '比亚迪重组答记者问' },
  // Cluster E: 五粮液处罚 (3 行)
  { id: 114, announce_date: '2026-06-01', stock_code: '000858', event_type: '处罚', original_title: '五粮液受证监会立案调查' },
  { id: 115, announce_date: '2026-06-02', stock_code: '000858', event_type: '处罚', original_title: '五粮液行政处罚预告' },
  { id: 116, announce_date: '2026-06-05', stock_code: '000858', event_type: '处罚', original_title: '五粮液行政处罚决定' },
  // Cluster F: 中信解禁 (4 行)
  { id: 117, announce_date: '2026-06-10', stock_code: '600030', event_type: '解禁', original_title: '中信限售股解禁公告' },
  { id: 118, announce_date: '2026-06-11', stock_code: '600030', event_type: '解禁', original_title: '中信解禁更新' },
  { id: 119, announce_date: '2026-06-12', stock_code: '600030', event_type: '解禁', original_title: '中信解禁进展' },
  { id: 120, announce_date: '2026-06-13', stock_code: '600030', event_type: '解禁', original_title: '中信解禁完成' },
];
{
  const res = dedupeAnnouncements(AC_SAMPLES);
  assert(
    `[7.AC] dedupe_ratio ≥ 70% (实测 ${(res.dedupe_ratio * 100).toFixed(1)}% canonical=${res.canonical_count}/${res.total})`,
    res.dedupe_ratio >= 0.7,
    `total=${res.total} canonical=${res.canonical_count} ratio=${res.dedupe_ratio}`
  );
  assert(
    '[7.1] 20 行总数对齐',
    res.total === 20,
    `total=${res.total}`
  );
  // 6 cluster, 无独立 = 6 canonical, 14 duplicate
  assert('[7.2] canonical_count = 6', res.canonical_count === 6, `canonical=${res.canonical_count}`);
  assert('[7.3] duplicate_count = 14', res.duplicate_count === 14);
  // 每 cluster canonical 取 id 最小 (sort 后)
  const cA = res.records.find((r) => r.id === 101)!;
  assert('[7.4] cluster A canonical=101', cA.is_canonical && cA.cluster_id === 101);
  const cB = res.records.find((r) => r.id === 106)!;
  assert('[7.5] cluster B id=106 duplicate_of=105', !cB.is_canonical && cB.duplicate_of === 105);
}

// ---- summary ---------------------------------------------------------------
setTimeout(() => {
  console.log(`\nannouncement-dedupe-service: ${passed} ok / ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}, 100);
