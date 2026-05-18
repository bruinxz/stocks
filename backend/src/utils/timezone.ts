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
