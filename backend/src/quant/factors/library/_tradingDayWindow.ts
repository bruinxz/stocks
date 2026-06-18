/**
 * 交易日窗口 helper (audit M-9 修复, 2026-06-18).
 *
 * 为什么需要这个 helper:
 *   - 既有 `lookbackStartDate(asOf, N)` 是按 **自然日** 减 N, 在春节 / 国庆等
 *     长假窗口会让"近 N 个交易日"实际只覆盖 N - 7 个交易日 (10 个有效观测变 3 个),
 *     因子值系统性偏小;
 *   - 改用 `previousNTradingDays(asOf, N)` 从 `daily_bars.is_trading_day=true`
 *     反查真实交易日历, 把 "近 N 个交易日" 的起始日作为 SQL where 下限,
 *     消除节假日对窗口宽度的污染.
 *
 * 实现策略:
 *   - 用 `DataService.getTradingDays(start, end)` (基于 daily_bars 的现有 API);
 *   - 拉取 `as_of - 60 天 ~ as_of` 作为缓冲 (60 天足够覆盖 N ≤ 30 + 春节 7 天 + 一周冗余);
 *   - 倒序排序, 取倒数第 N 个交易日作为窗口起始日 (含端点, 即"近 N 个交易日");
 *   - 不足 N 个 → 取最早可得的交易日 (与 NorthboundFactor "窗口内最早一条做基线" 同款兜底).
 *
 * 性能:
 *   - 单次 SQL `SELECT DISTINCT time FROM daily_bars WHERE time BETWEEN ... AND is_trading_day=true`;
 *   - 因子 compute() 通常每 trade_date 只调一次, 缓存意义不大, 直接每次拉新.
 *
 * 用法:
 *   const dates = await previousNTradingDays('2026-06-18', 5);
 *   // dates = ['2026-06-12', '2026-06-13', '2026-06-16', '2026-06-17', '2026-06-18'] (含端点)
 *   const startDate = dates[0];  // SQL where lower bound
 */

import { DataService } from '../../../data/services/DataService';

/** 默认缓冲天数: 拉 60 自然日已含 30+ 交易日, 充足. */
const DEFAULT_CALENDAR_BUFFER_DAYS = 60;

let _sharedDataService: DataService | null = null;

/** 共享单例 (lazy 避免循环 import). */
function getDataService(): DataService {
  if (!_sharedDataService) _sharedDataService = new DataService();
  return _sharedDataService;
}

/** Test seam: allow injection of fake data service for unit tests without DB. */
export function _setDataServiceForTest(svc: DataService | null): void {
  _sharedDataService = svc;
}

/**
 * 取 as_of 当日(含)往前数 N 个交易日的列表 (ISO YYYY-MM-DD, 升序).
 *
 * @param asOf  截面日期, ISO 'YYYY-MM-DD'
 * @param n     近 N 个交易日 (含 as_of 当日, 即 N >= 1; n=5 = T-4..T)
 * @param bufferDays  自然日缓冲, 默认 60. 不足 N 时取最早可得.
 * @returns 升序的交易日 ISO 日期数组, 长度 ≤ N. **空数组** 当数据完全缺失.
 */
export async function previousNTradingDays(
  asOf: string,
  n: number,
  bufferDays: number = DEFAULT_CALENDAR_BUFFER_DAYS
): Promise<string[]> {
  if (!asOf || typeof asOf !== 'string') return [];
  if (!Number.isFinite(n) || n < 1) return [];

  const endDate = new Date(`${asOf}T00:00:00Z`);
  if (isNaN(endDate.getTime())) return [];
  const startDate = new Date(endDate);
  startDate.setUTCDate(startDate.getUTCDate() - Math.max(bufferDays, n * 2 + 7));

  const svc = getDataService();
  const rawDays = await svc.getTradingDays(startDate, endDate);
  if (!rawDays.length) return [];

  // 转 ISO 日期, 去重, 升序排
  const isoSet = new Set<string>();
  for (const d of rawDays) {
    const iso = d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
    if (iso && iso <= asOf) isoSet.add(iso);
  }
  const sorted = Array.from(isoSet).sort();

  // 取最后 N 个; 不足 N 取全部 (兜底).
  return sorted.slice(-n);
}

/**
 * 取 as_of 往前数 N 个交易日的 **窗口起始日** (即 dates[0]).
 *
 * 常用于因子 SQL where: `factor_date >= startDate AND factor_date <= as_of`.
 * 与 `lookbackStartDate` 自然日版同款返回类型, 让因子改造时 diff 最小.
 *
 * @returns 起始日 ISO 'YYYY-MM-DD'; 数据完全缺失 → as_of 自身 (退化到单日窗口).
 */
export async function tradingDayLookbackStartDate(
  asOf: string,
  n: number,
  bufferDays?: number
): Promise<string> {
  const dates = await previousNTradingDays(asOf, n, bufferDays);
  if (!dates.length) return asOf;
  return dates[0];
}
