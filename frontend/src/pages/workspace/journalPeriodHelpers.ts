/**
 * US-056 [FE-017] PortfolioWorkspace 复盘日记 周/月/季 聚合 — 纯函数 helper.
 *
 * 把 JournalTab 的 "按期聚合" 渲染逻辑抽到独立 module 让它真可单测 —
 * 与 [[前端 pure helper 模板]] (US-055 dailyAttributionHelpers / US-051
 * shadowRunHelpers / US-057 industryConcentrationKpiHelpers) 同款思路.
 *
 * 设计取舍 (US-056 [FE-017]):
 *   - **不再 fetch 新接口**: backend 没有 "周/月/季" 维度日记表; 复用
 *     `PortfolioWorkspace` 顶层已加载的 `journalList: JournalSummary[]`
 *     做客户端聚合即可. 与 [[US-055 dailyAttributionHelpers]] 同款
 *     "复用 snapshots/trades 不打新 API" 决策.
 *   - **ISO-8601 周 (周一起始)**: 与 backend `live_shadow_weekly_review`
 *     cron / 金融周报普遍口径一致. 不引入 `dayjs/plugin/isoWeek`
 *     (项目内 grep `dayjs/plugin` 无任何启用), 用纯算法计算保零依赖.
 *   - **季度**: 1-3 月=Q1, 4-6=Q2, 7-9=Q3, 10-12=Q4. 与 GARPStrategy
 *     `quarterly` rebalancePeriod 同语义. 4 季覆盖, 无半年/年.
 *   - **dominantMood 平局**: 字典序最小的胜出 — 与 [[前端 pure helper
 *     模板]] 排序兜底 (entity key 字母序) 同款, 让 UI tie 可预期.
 *   - **空集 / 非法 → 返 [] 不抛**: list=null/[] → []; 非法 period →
 *     fallback 'day' (一日一桶). 永远不向 component 抛, 让组件零
 *     try/catch — 与 dailyAttributionHelpers `hidden=true` 兜底同思想.
 *   - **桶按 startDate 降序排**: 最近期在列表顶部, 与现有 JournalTab
 *     左列 "今天在最上" 直觉一致.
 *
 * 纯函数, 不依赖 React / antd / fetch, 单测在
 * backend/tests/services/journal-period-helpers.test.ts (跨 monorepo
 * import, 与 US-051/US-055/US-057 同款模式).
 */

import type { JournalSummary } from '../../services/portfolioWorkspaceService';

// ---------- 公共枚举 + label ----------

export type JournalPeriod = 'day' | 'week' | 'month' | 'quarter';

/** Segmented 显示文案 (前端) — frozen 避免 component 误改 */
export const JOURNAL_PERIOD_LABEL: Readonly<Record<JournalPeriod, string>> = Object.freeze({
  day: '日',
  week: '周',
  month: '月',
  quarter: '季',
});

/** 合法 period 集合, 用于 component 渲染 Segmented options */
export const JOURNAL_PERIOD_VALUES: ReadonlyArray<JournalPeriod> = Object.freeze([
  'day',
  'week',
  'month',
  'quarter',
]);

// ---------- 日期工具 ----------

/** 'YYYY-MM-DD' → {y,m,d} 数字; 非法返 null. */
function parseYmd(date: string | null | undefined): { y: number; m: number; d: number } | null {
  if (!date || typeof date !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, m: mo, d };
}

/** {y,m,d} → 'YYYY-MM-DD' (零填充) */
function fmtYmd(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(
    2,
    '0'
  )}`;
}

/** 给定 ymd, 用 UTC Date 创建避开 tz drift, 返 Date 对象 */
function toUtcDate(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d));
}

/** Date → 'YYYY-MM-DD' (UTC) */
function utcDateToYmd(date: Date): string {
  return fmtYmd(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

// ---------- period key 算子 ----------

/**
 * ISO-8601 周 key: "YYYY-Www" (周一为周首, ww 从 01 起 2 位).
 *
 * 算法 (经典 ISO week 计算, 无 dayjs/plugin 依赖):
 *  1. 把 date 移到本周四 (target = date + (4 - dayOfWeek))
 *     ISO 周编号取决于该周四所在的年份 (跨年时归属本周四所在年).
 *  2. 找该年 1 月 4 日 (必属 W01) 所在的周首周一.
 *  3. (target - 周首周一) / 7 + 1 = ISO 周序数.
 *
 * 非法日期返 ''.
 */
export function getISOWeekKey(date: string | null | undefined): string {
  const ymd = parseYmd(date);
  if (!ymd) return '';
  const d = toUtcDate(ymd.y, ymd.m, ymd.d);
  // getUTCDay: 0=Sun, 1=Mon, ... 6=Sat. ISO 把 Sun 视为 7
  const day = d.getUTCDay() || 7;
  // 移到本周四
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const isoYear = d.getUTCFullYear();
  const jan4 = toUtcDate(isoYear, 1, 4);
  const jan4Day = jan4.getUTCDay() || 7;
  // jan4 所在周的周一
  const week1Mon = new Date(jan4.getTime());
  week1Mon.setUTCDate(jan4.getUTCDate() - (jan4Day - 1));
  const diffMs = d.getTime() - week1Mon.getTime();
  const week = Math.round(diffMs / (7 * 24 * 60 * 60 * 1000)) + 1;
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

/** 月 key: "YYYY-MM"; 非法返 '' */
export function getMonthKey(date: string | null | undefined): string {
  const ymd = parseYmd(date);
  if (!ymd) return '';
  return `${ymd.y}-${String(ymd.m).padStart(2, '0')}`;
}

/** 季 key: "YYYY-Qn" (n ∈ 1..4); 非法返 '' */
export function getQuarterKey(date: string | null | undefined): string {
  const ymd = parseYmd(date);
  if (!ymd) return '';
  const q = Math.floor((ymd.m - 1) / 3) + 1;
  return `${ymd.y}-Q${q}`;
}

/**
 * 给定 ISO 周 key 'YYYY-Www', 返该周的周一 (startDate, YYYY-MM-DD).
 * 非法返 null.
 */
function parseWeekKey(key: string): { startDate: string; endDate: string; label: string } | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(key);
  if (!m) return null;
  const isoYear = Number(m[1]);
  const week = Number(m[2]);
  if (!Number.isFinite(isoYear) || !Number.isFinite(week) || week < 1 || week > 53) return null;
  // 该年 jan4 → 周首周一 → +7*(week-1)
  const jan4 = toUtcDate(isoYear, 1, 4);
  const jan4Day = jan4.getUTCDay() || 7;
  const week1Mon = new Date(jan4.getTime());
  week1Mon.setUTCDate(jan4.getUTCDate() - (jan4Day - 1));
  const start = new Date(week1Mon.getTime());
  start.setUTCDate(week1Mon.getUTCDate() + (week - 1) * 7);
  const end = new Date(start.getTime());
  end.setUTCDate(start.getUTCDate() + 6);
  const startStr = utcDateToYmd(start);
  const endStr = utcDateToYmd(end);
  // label: "2026 第 25 周 (06-15 ~ 06-21)"
  const sMonth = String(start.getUTCMonth() + 1).padStart(2, '0');
  const sDay = String(start.getUTCDate()).padStart(2, '0');
  const eMonth = String(end.getUTCMonth() + 1).padStart(2, '0');
  const eDay = String(end.getUTCDate()).padStart(2, '0');
  const label = `${isoYear} 第 ${week} 周 (${sMonth}-${sDay} ~ ${eMonth}-${eDay})`;
  return { startDate: startStr, endDate: endStr, label };
}

/** 给定月 key 'YYYY-MM', 返该月 start/end. 非法返 null. */
function parseMonthKey(key: string): { startDate: string; endDate: string; label: string } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (!Number.isFinite(y) || mo < 1 || mo > 12) return null;
  const start = toUtcDate(y, mo, 1);
  // 下月 1 日 - 1 = 本月末日
  const nextMonth = toUtcDate(mo === 12 ? y + 1 : y, mo === 12 ? 1 : mo + 1, 1);
  const end = new Date(nextMonth.getTime() - 24 * 60 * 60 * 1000);
  return {
    startDate: utcDateToYmd(start),
    endDate: utcDateToYmd(end),
    label: `${y} 年 ${mo} 月`,
  };
}

/** 给定季 key 'YYYY-Qn', 返该季 start/end. 非法返 null. */
function parseQuarterKey(
  key: string
): { startDate: string; endDate: string; label: string } | null {
  const m = /^(\d{4})-Q([1-4])$/.exec(key);
  if (!m) return null;
  const y = Number(m[1]);
  const q = Number(m[2]);
  const startMonth = (q - 1) * 3 + 1;
  const endMonth = startMonth + 2;
  const start = toUtcDate(y, startMonth, 1);
  const nextQStartY = endMonth === 12 ? y + 1 : y;
  const nextQStartM = endMonth === 12 ? 1 : endMonth + 1;
  const end = new Date(toUtcDate(nextQStartY, nextQStartM, 1).getTime() - 24 * 60 * 60 * 1000);
  return {
    startDate: utcDateToYmd(start),
    endDate: utcDateToYmd(end),
    label: `${y} Q${q}`,
  };
}

/** 给定 day key 'YYYY-MM-DD', 返该日 start=end. */
function parseDayKey(key: string): { startDate: string; endDate: string; label: string } | null {
  const ymd = parseYmd(key);
  if (!ymd) return null;
  const norm = fmtYmd(ymd.y, ymd.m, ymd.d);
  return { startDate: norm, endDate: norm, label: norm };
}

/**
 * 反解 period key → startDate/endDate (含端点) + 人类可读 label.
 *
 * 非法 key 返 null (component 自行兜底显示 '—').
 */
export function parsePeriodKey(
  period: JournalPeriod,
  key: string
): { startDate: string; endDate: string; label: string } | null {
  if (period === 'week') return parseWeekKey(key);
  if (period === 'month') return parseMonthKey(key);
  if (period === 'quarter') return parseQuarterKey(key);
  return parseDayKey(key);
}

// ---------- View model ----------

export interface JournalPeriodBucket {
  /** 期 key (按 period 类型不同格式) */
  key: string;
  /** 人类可读 label (来自 parsePeriodKey) */
  label: string;
  /** 该期 startDate, 'YYYY-MM-DD' */
  startDate: string;
  /** 该期 endDate (含当期最后一日), 'YYYY-MM-DD' */
  endDate: string;
  /** 该期内有复盘记录的日期数 (即 bucket.journals.length) */
  journalCount: number;
  /** 该期内所有 mood 累计, 例如 {"平静":3,"焦虑":1} (空 mood 不计) */
  moodCounts: Record<string, number>;
  /** 该期最常出现的 mood (平局取字典序最小); 无任何 mood → null */
  dominantMood: string | null;
  /** 该期内 unique tag, 按出现频率降序 (tie 字典序) */
  topTags: string[];
  /** 该期内的 raw journals (按 date 升序) */
  journals: JournalSummary[];
}

// ---------- 主入口: groupJournalsByPeriod ----------

function periodKeyOf(period: JournalPeriod, date: string): string {
  if (period === 'week') return getISOWeekKey(date);
  if (period === 'month') return getMonthKey(date);
  if (period === 'quarter') return getQuarterKey(date);
  // day 默认 — 直接用日期本身
  const ymd = parseYmd(date);
  return ymd ? fmtYmd(ymd.y, ymd.m, ymd.d) : '';
}

/**
 * 把日记列表按 period 分组. period 非法 → fallback 'day' (一日一桶).
 *
 * 排序: 桶按 startDate 降序 (最近期在最上, 与 JournalTab 左列直觉一致).
 * 期内 journals 按 date 升序 (timeline 从早到晚阅读).
 */
export function groupJournalsByPeriod(
  list: JournalSummary[] | null | undefined,
  period: JournalPeriod
): JournalPeriodBucket[] {
  if (!Array.isArray(list) || list.length === 0) return [];
  const safePeriod: JournalPeriod = JOURNAL_PERIOD_VALUES.includes(period) ? period : 'day';

  // 按 key 分组
  const byKey = new Map<string, JournalSummary[]>();
  for (const j of list) {
    if (!j || typeof j.date !== 'string') continue;
    const key = periodKeyOf(safePeriod, j.date);
    if (!key) continue;
    const arr = byKey.get(key) || [];
    arr.push(j);
    byKey.set(key, arr);
  }

  const buckets: JournalPeriodBucket[] = [];
  byKey.forEach((journals, key) => {
    const parsed = parsePeriodKey(safePeriod, key);
    if (!parsed) return;
    const sortedJournals = [...journals].sort((a, b) =>
      String(a.date).localeCompare(String(b.date))
    );
    // mood 累计
    const moodCounts: Record<string, number> = {};
    for (const j of sortedJournals) {
      const m = j.mood;
      if (!m || typeof m !== 'string' || !m.trim()) continue;
      const trimmed = m.trim();
      // '未生成' 视为无 mood (与现有 JournalTab 渲染规则一致, line 1809)
      if (trimmed === '未生成') continue;
      moodCounts[trimmed] = (moodCounts[trimmed] || 0) + 1;
    }
    const dominantMood = pickDominantMood(moodCounts);
    // tag 累计 → 频率排序
    const tagCounts: Record<string, number> = {};
    for (const j of sortedJournals) {
      const tags = j.tags;
      if (!Array.isArray(tags)) continue;
      for (const t of tags) {
        if (typeof t !== 'string' || !t.trim()) continue;
        const trimmed = t.trim();
        tagCounts[trimmed] = (tagCounts[trimmed] || 0) + 1;
      }
    }
    const topTags = Object.keys(tagCounts).sort((a, b) => {
      const diff = tagCounts[b] - tagCounts[a];
      if (diff !== 0) return diff;
      return a.localeCompare(b);
    });
    buckets.push({
      key,
      label: parsed.label,
      startDate: parsed.startDate,
      endDate: parsed.endDate,
      journalCount: sortedJournals.length,
      moodCounts,
      dominantMood,
      topTags,
      journals: sortedJournals,
    });
  });

  // 按 startDate 降序
  buckets.sort((a, b) => b.startDate.localeCompare(a.startDate));
  return buckets;
}

/**
 * 给定一组 mood 计数, 返出现最多的 (平局字典序最小); 空 → null.
 * 与 [[多维健康度三档分级]] 同款 "字典序兜底" 让 UI tie 可预期.
 */
export function pickDominantMood(counts: Record<string, number>): string | null {
  const keys = Object.keys(counts);
  if (keys.length === 0) return null;
  let bestKey = keys[0];
  let bestCount = counts[bestKey];
  for (let i = 1; i < keys.length; i++) {
    const k = keys[i];
    const c = counts[k];
    if (c > bestCount || (c === bestCount && k.localeCompare(bestKey) < 0)) {
      bestKey = k;
      bestCount = c;
    }
  }
  return bestKey;
}

/** 按 key 查桶, 没有返 null. */
export function findBucket(
  buckets: JournalPeriodBucket[] | null | undefined,
  key: string | null | undefined
): JournalPeriodBucket | null {
  if (!Array.isArray(buckets) || !key) return null;
  return buckets.find(b => b.key === key) || null;
}
