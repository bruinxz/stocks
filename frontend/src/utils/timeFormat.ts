/**
 * Phase 10 (2026-06-28) — 时间格式化统一工具.
 *
 * 用户原话: "推荐现在应该是在每天的任何时间段都有可能触发吧, 跟随时机来的, 所以
 * 页面上是不是要加入时间的间隔, 能更好看到每个时间段都推荐了哪些. 不只这个地方,
 * 考虑下其他地方是不是也需要时间, 时间是个很重要的参考."
 *
 * 设计目标:
 *   - 全 frontend 不再散落 `toLocaleString` / `dayjs().format()` 七零八落
 *   - A 股语境: 时区固定 Asia/Shanghai (日内推荐按上海交易日时段分组)
 *   - 接受 `string | Date | null | undefined` —— null/invalid 兜底返 '—'
 *   - 不引入新依赖 (Intl + Date 已够, dayjs 仅在工具内部用一次时区转换;
 *     这里直接走 Intl.DateTimeFormat 避免新增 dayjs/timezone plugin)
 */

const SHANGHAI_TZ = 'Asia/Shanghai';

/** 安全把任意输入转 Date; null / invalid → null. */
function toDate(input?: string | Date | null): Date | null {
  if (input == null) return null;
  if (input instanceof Date) {
    return Number.isFinite(input.getTime()) ? input : null;
  }
  const d = new Date(input);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** 把 Date 在 Asia/Shanghai 时区拆出 {y,m,d,h,min,sec}. */
function partsInShanghai(d: Date): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  // Intl.DateTimeFormat 输出 "2026/06/28 14:32:15" 这类, 用 formatToParts 拿稳定结构
  const fmt = new Intl.DateTimeFormat('zh-CN', {
    timeZone: SHANGHAI_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value ?? '0');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** "14:32:15" — 时:分:秒, 上海时区, hh24. */
export function formatClock(iso?: string | Date | null): string {
  const d = toDate(iso);
  if (!d) return '—';
  const p = partsInShanghai(d);
  return `${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}`;
}

/** "14:32" — 时:分, 上海时区, hh24. */
export function formatHourMin(iso?: string | Date | null): string {
  const d = toDate(iso);
  if (!d) return '—';
  const p = partsInShanghai(d);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

/**
 * "5 分钟前" / "1 小时前" / "今天" / "昨天" / "MM-DD".
 * 阈值: <60s "刚刚" / <60min "N 分钟前" / <24h "N 小时前" / 今日 "今天 HH:mm" /
 *       昨日 "昨天 HH:mm" / 当年 "MM-DD HH:mm" / 跨年 "YYYY-MM-DD"
 */
export function formatRelative(iso?: string | Date | null): string {
  const d = toDate(iso);
  if (!d) return '—';
  const now = new Date();
  const diffSec = Math.floor((now.getTime() - d.getTime()) / 1000);
  if (diffSec < 0) return formatHourMin(d); // 未来时间, 不强行 "X 后", 直接显时间
  if (diffSec < 60) return '刚刚';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;

  const todayP = partsInShanghai(now);
  const tP = partsInShanghai(d);
  if (tP.year === todayP.year && tP.month === todayP.month && tP.day === todayP.day) {
    return `今天 ${pad2(tP.hour)}:${pad2(tP.minute)}`;
  }
  // 昨天判定: now - 1 day
  const yest = new Date(now.getTime() - 86400_000);
  const yP = partsInShanghai(yest);
  if (tP.year === yP.year && tP.month === yP.month && tP.day === yP.day) {
    return `昨天 ${pad2(tP.hour)}:${pad2(tP.minute)}`;
  }
  if (tP.year === todayP.year) {
    return `${pad2(tP.month)}-${pad2(tP.day)} ${pad2(tP.hour)}:${pad2(tP.minute)}`;
  }
  return `${tP.year}-${pad2(tP.month)}-${pad2(tP.day)}`;
}

/** "2026-06-28" — 日期部分, 上海时区. */
export function formatDate(iso?: string | Date | null): string {
  const d = toDate(iso);
  if (!d) return '—';
  const p = partsInShanghai(d);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** "2026-06-28 14:32" — 日期 + 时分, 上海时区. */
export function formatDateTime(iso?: string | Date | null): string {
  const d = toDate(iso);
  if (!d) return '—';
  const p = partsInShanghai(d);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)} ${pad2(p.hour)}:${pad2(p.minute)}`;
}

/**
 * 聚合到最近的 30min 桶: 09:00 / 09:30 / 10:00 / ...
 * 用于推荐时段分组的 key. 上海时区.
 *
 * 例: 09:17 → "09:00", 09:45 → "09:30", 14:32 → "14:30"
 */
export function bucketToHalfHour(iso?: string | Date | null): string {
  const d = toDate(iso);
  if (!d) return '—';
  const p = partsInShanghai(d);
  const bucketMin = p.minute < 30 ? 0 : 30;
  return `${pad2(p.hour)}:${pad2(bucketMin)}`;
}

/**
 * 上海交易时段标签 (新手语言).
 *   < 09:30           → 盘前
 *   09:30 - 11:30     → 上午盘
 *   11:30 - 13:00     → 午间
 *   13:00 - 14:30     → 下午盘
 *   14:30 - 15:00     → 尾盘
 *   > 15:00           → 盘后
 */
export function tradingSessionLabel(iso?: string | Date | null): string {
  const d = toDate(iso);
  if (!d) return '—';
  const p = partsInShanghai(d);
  const minutes = p.hour * 60 + p.minute;
  if (minutes < 9 * 60 + 30) return '盘前';
  if (minutes < 11 * 60 + 30) return '上午盘';
  if (minutes < 13 * 60) return '午间';
  if (minutes < 14 * 60 + 30) return '下午盘';
  if (minutes < 15 * 60) return '尾盘';
  return '盘后';
}

// ---------------------------------------------------------------------------
// internal
// ---------------------------------------------------------------------------

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
