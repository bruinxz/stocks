/**
 * 时区工具函数
 */

/**
 * 获取东八区时间字符串（UTC+8）
 * @param date 可选，默认为当前时间
 * @returns ISO格式的东八区时间字符串，如 '2026-04-11T12:00:00+08:00'
 */
export function getEast8TimeString(date?: Date): string {
  const now = date || new Date();

  // 方法1：使用toLocaleString转换为东八区时间
  const localTime = new Date(now.getTime() + 8 * 60 * 60 * 1000); // UTC+8
  const isoString = localTime.toISOString().replace('Z', '+08:00');

  return isoString;
}

/**
 * 获取东八区日期字符串（仅日期部分）
 * @param date 可选，默认为当前时间
 * @returns 日期字符串，如 '2026-04-11'
 */
export function getEast8DateString(date?: Date): string {
  const now = date || new Date();
  const localTime = new Date(now.getTime() + 8 * 60 * 60 * 1000); // UTC+8
  return localTime.toISOString().split('T')[0];
}

/**
 * 获取当前东八区时间对象
 * @returns Date对象（东八区时间）
 */
export function getEast8Time(): Date {
  return new Date(Date.now() + 8 * 60 * 60 * 1000);
}

/**
 * 将UTC时间转换为东八区时间字符串
 * @param utcDate UTC时间字符串或Date对象
 * @returns 东八区时间字符串
 */
export function convertUTCToEast8(utcDate: string | Date): string {
  const date = typeof utcDate === 'string' ? new Date(utcDate) : utcDate;
  const localTime = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return localTime.toISOString().replace('Z', '+08:00');
}

/**
 * 获取易读的东八区时间字符串 (用于告警 / 通知 / UI 展示).
 *
 * 与 `getEast8TimeString` (返 ISO 形态 `+08:00` 后缀) 的区别:
 * 本函数返回 `YYYY-MM-DD HH:mm:ss (UTC+8)` 形态, 便于人眼一眼看出"这是北京时间, 不是 UTC".
 *
 * Bug 修复背景 (Batch CC, 2026-06-25):
 * 风控告警飞书 card 此前用 `instance.created_at.toISOString()` 输出 Z 后缀
 * (如 `2026-06-25T08:09:00.597Z`), 用户读到 "08:09" 以为系统时间错了 (实际是 16:09 北京).
 * 改用本函数后, 时区上下文显式标注 (UTC+8), 不可能再误读.
 *
 * CE-C (2026-06-25): IntradayOpportunityPusher 卡片"触发时间" footer 同款使用本 helper.
 *
 * @param date 可选, 默认为当前时间; 也接受 string (ISO) / Date.
 * @returns 形如 `2026-06-25 16:09:00 (UTC+8)`
 */
export function formatEast8Readable(date?: Date | string): string {
  // 显式区分: undefined → 当前时间 / "" / "garbage" / 非法 Date → "—" 兜底
  let d: Date;
  if (date === undefined || date === null) {
    d = new Date();
  } else if (typeof date === 'string') {
    if (date.trim() === '') return '—';
    d = new Date(date);
  } else {
    d = date;
  }
  if (!d || Number.isNaN(d.getTime())) return '—';
  const local = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  const yyyy = local.getUTCFullYear();
  const mm = String(local.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(local.getUTCDate()).padStart(2, '0');
  const hh = String(local.getUTCHours()).padStart(2, '0');
  const mi = String(local.getUTCMinutes()).padStart(2, '0');
  const ss = String(local.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss} (UTC+8)`;
}

/**
 * 获取东八区时间的年月日时分秒
 * @param date 可选，默认为当前时间
 * @returns 对象包含年月日时分秒
 */
export function getEast8TimeComponents(date?: Date): {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
  second: number;
} {
  const now = date || new Date();
  const localTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);

  return {
    year: localTime.getUTCFullYear(),
    month: localTime.getUTCMonth() + 1,
    day: localTime.getUTCDate(),
    hour: localTime.getUTCHours(),
    minute: localTime.getUTCMinutes(),
    second: localTime.getUTCSeconds(),
  };
}
