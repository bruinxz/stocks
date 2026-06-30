/**
 * 全站金额统一格式化 (Phase 13 — 用户原话: 单位统一为 "元", 不换算 "万元"/"亿元").
 *
 * 为什么:
 *  - Phase 12 之前 PortfolioWorkspace hero 在 >= 10000 时自动切换 "万元" 单位,
 *    导致 "0.50 万元" 这种数字看起来很小且 "万元" 灰字与紫色背景对比度极低 (用户截图反馈).
 *  - 千分位 (Intl.NumberFormat('zh-CN')) + tabular-nums (Inter font-feature-settings)
 *    已经能很清楚展示 50,000,000.00 这种 8 位整数 + 2 位小数, 不需要再压一档单位.
 *  - 同时也避免 5000 vs 50000 跨段的 "数字突然变小" 视觉错位.
 *
 * 用法:
 *   formatMoney(123456.78)     → "¥123,456.78"
 *   formatMoney(-1234.5)       → "-¥1,234.50"
 *   formatMoney(null)          → "—"
 *   formatMoney(0)             → "¥0.00"
 *   formatMoneyNumber(...)     同上但不带 ¥ 前缀, 给 hero `value` (单独控制 ¥ 颜色) 用.
 */

const CNY = new Intl.NumberFormat('zh-CN', {
  style: 'currency',
  currency: 'CNY',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  // 关闭 narrow symbol, 让 ¥ 维持单字符
  currencyDisplay: 'symbol',
});

const NUMBER_2 = new Intl.NumberFormat('zh-CN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const NUMBER_INT = new Intl.NumberFormat('zh-CN', {
  maximumFractionDigits: 0,
});

/** 带 ¥ 前缀的金额 (最常用). 负数 → "-¥1,234.50". */
export function formatMoney(v: number | string | null | undefined): string {
  if (v === null || v === undefined) return '—';
  const n = typeof v === 'string' ? Number(v) : v;
  if (!Number.isFinite(n)) return '—';
  // Intl.NumberFormat 在 currency 模式下会输出 "￥" 全角 — 强制用 ¥ 半角统一视觉
  return CNY.format(n).replace(/￥/g, '¥');
}

/**
 * 不带 ¥ 前缀的金额数字 — 让调用方控制 ¥ 的颜色 / 字号 (hero 大数 + 紫色 ¥).
 * 仍带千分位 + 2 位小数.
 */
export function formatMoneyNumber(v: number | string | null | undefined): string {
  if (v === null || v === undefined) return '—';
  const n = typeof v === 'string' ? Number(v) : v;
  if (!Number.isFinite(n)) return '—';
  return NUMBER_2.format(n);
}

/** 带符号 + ¥ 前缀的 P&L. +¥123.45 / -¥123.45 / ¥0.00 (零无符号). */
export function formatMoneySigned(v: number | string | null | undefined): string {
  if (v === null || v === undefined) return '—';
  const n = typeof v === 'string' ? Number(v) : v;
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '¥0.00';
  const sign = n > 0 ? '+' : '-';
  return `${sign}¥${NUMBER_2.format(Math.abs(n))}`;
}

/** 数量 / 笔数 / 持仓数等非金额数值. 千分位 + 可指定小数位. */
export function formatNumber(
  v: number | string | null | undefined,
  decimals = 0
): string {
  if (v === null || v === undefined) return '—';
  const n = typeof v === 'string' ? Number(v) : v;
  if (!Number.isFinite(n)) return '—';
  if (decimals === 0) return NUMBER_INT.format(n);
  return new Intl.NumberFormat('zh-CN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(n);
}

/** 百分比. +X.XX% / -X.XX% / 0.00% (零无符号). */
export function formatPercent(
  v: number | string | null | undefined,
  decimals = 2
): string {
  if (v === null || v === undefined) return '—';
  const n = typeof v === 'string' ? Number(v) : v;
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return `0.${'0'.repeat(decimals)}%`;
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(decimals)}%`;
}
