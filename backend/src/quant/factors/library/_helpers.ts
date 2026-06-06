/**
 * 因子库共享内部 helper —— 仅供 library/ 下的因子文件 import。
 *
 * 抽出原因：
 *   - 多个因子都要做 "Stock.symbol → stock_code（无后缀）" 的转换，
 *     直接 inline 会重复 8 次同样的 5 行。
 *   - 多个因子都要按 universe（无后缀）反查 Stock（带后缀）/ 拿到 stock_id，
 *     这层映射如果分散在各因子里很容易写不一致。
 *
 * 这些 helper 故意不放在 `quant/factors/normalization.ts` 或顶层 `index.ts`
 * 出口里 —— 它们是 **library 内部实现细节**，不属于因子基础设施对外契约。
 *
 * （命名约定：文件名前缀 `_` = "library 内部"。CLAUDE.md 已说明此约定。）
 */

import { Op } from 'sequelize';
import { Stock } from '../../../models/Stock';

/** 把 "600519.SH" → "600519"；输入若已无后缀直接返回 */
export function stripSuffix(symbol: string | null | undefined): string {
  if (!symbol) return '';
  const i = symbol.indexOf('.');
  return i < 0 ? symbol : symbol.slice(0, i);
}

/** 反向：把 "600519" 还原为 Stock.symbol 形式（6 → SH，0/3 → SZ，4/8 → BJ） */
export function inferStockSymbol(code: string): string {
  if (!code) return '';
  if (code.includes('.')) return code; // 已带后缀直接返回
  const head = code[0];
  if (head === '6') return `${code}.SH`;
  if (head === '0' || head === '3') return `${code}.SZ`;
  if (head === '4' || head === '8') return `${code}.BJ`;
  // 北交所新股 92x、退市 9 开头也并入 BJ；兜底 .SZ 保证 Stock 查询不空
  return `${code}.SZ`;
}

/**
 * 按 universe（无后缀 stock_code 列表）批量取 Stock 实例。
 *
 * Stock.symbol 在该 codebase 是 "600519.SH" 形式；因子的 universe 是无后缀的
 * "600519"。本 helper 把无后缀 universe 反推成 Stock.symbol 全集后用 `Op.in`
 * 一次查回，返回 Map<stock_code(无后缀), Stock>。
 *
 * 为什么不让因子自己 `Stock.findAll`：
 *   - 每个因子都要做 stripSuffix(symbol) 反向查 stock_id；散在 8 个因子里
 *     就有 8 份不同的 `.includes('.')` 处理。
 *   - 集中之后 .raw 与 attributes 优化也能 1 处生效。
 *
 * 注意：返回值的 key 是**无后缀** stock_code，与 FactorContext.universe
 * 的口径一致。
 */
export async function loadStocksByCodes(
  codes: string[],
  attributes: string[] = ['id', 'symbol', 'industry', 'circulating_market_cap']
): Promise<Map<string, any>> {
  if (!codes.length) return new Map();
  const symbols = Array.from(new Set(codes.map(inferStockSymbol).filter(Boolean)));
  const rows = (await Stock.findAll({
    attributes,
    where: { symbol: { [Op.in]: symbols } },
    raw: true,
  })) as unknown as Array<Record<string, any>>;
  const out = new Map<string, any>();
  for (const r of rows) {
    const code = stripSuffix(r.symbol);
    if (code) out.set(code, r);
  }
  return out;
}

/** 数值断言：true 当且仅当 finite number；用在过滤 Map<stock, value> 时 */
export function isFiniteNumber(v: any): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * 把 "今日" ISO 日期 + 自然日 lookback 转回 lookback 起始 ISO 日期，
 * 用于因子内 `factor_date >= startDate AND factor_date <= asOfDate` 查询。
 *
 * 用自然日窗口（而不是交易日）的原因是各表的 *_date 字段大多是 DATEONLY，
 * 周末缺数据天然就不出现；多发几天没行 = OK，无副作用。
 */
export function lookbackStartDate(asOfDate: string, lookbackDays: number): string {
  const d = new Date(`${asOfDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - Math.max(0, lookbackDays));
  return d.toISOString().slice(0, 10);
}
