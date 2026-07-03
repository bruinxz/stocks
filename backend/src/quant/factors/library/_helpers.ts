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

/**
 * 把任意格式的 stock symbol 归一为无前后缀的纯 6 位 code:
 *   - "600519.SH"  → "600519"  (老 suffix 格式)
 *   - "sh.600519"  → "600519"  (新 prefix 格式 - akshare/tushare)
 *   - "bj.920003"  → "920003"  (北交所)
 *   - "600519"     → "600519"  (已无后缀直接返回)
 *
 * 这里同时兼容两种格式是因为 stocks 表里历史上既存过 .SH/.SZ 后缀也存过
 * sh./sz./bj. 前缀（取决于哪个时期的 ingest 脚本入的）。FactorScore.stock_code
 * 统一是纯 6 位 code，与 NorthboundHolding / LimitUpStock 等同款。
 */
export function stripSuffix(symbol: string | null | undefined): string {
  if (!symbol) return '';
  const s = symbol.trim();
  if (!s) return '';
  const i = s.indexOf('.');
  if (i < 0) return s;
  const before = s.slice(0, i);
  const after = s.slice(i + 1);
  // 前缀格式: prefix 是 "sh"/"sz"/"bj" (2 char alpha)，code 在 after
  if (/^[a-zA-Z]{2}$/.test(before)) return after;
  // 后缀格式: code 在 before
  return before;
}

/** 反向：把 "600519" 还原为 Stock.symbol 形式
 *
 * 当前 stocks 表里全部 5500+ 行用的是 `sh.600519` / `sz.000001` / `bj.920003`
 * 前缀格式（AKShare ingest 留下的），所以 inferStockSymbol 也用前缀格式输出。
 * 老的后缀格式 `600519.SH` 已不存在于表里，但 stripSuffix 仍兼容它以防回滚。
 */
export function inferStockSymbol(code: string): string {
  if (!code) return '';
  // 已带前缀或后缀直接返回
  if (code.includes('.')) return code;
  const head = code[0];
  if (head === '6') return `sh.${code}`;
  if (head === '0' || head === '3') return `sz.${code}`;
  if (head === '4' || head === '8' || head === '9') return `bj.${code}`;
  // [fix 2026-07-03] ETF/基金代码: 5 开头(50/51/52/56/58...)为沪市 → sh.,
  // 1 开头(15/16/18...)为深市 → sz.。旧逻辑无此分支, 5 开头 ETF 落到 sz. 兜底
  // → 查不到 Stock → ETF close 序列为空 → LowVol 恒为 null → 整只 ETF data_incomplete。
  if (head === '5') return `sh.${code}`;
  if (head === '1') return `sz.${code}`;
  // 兜底 .sz 保证 Stock 查询不空
  return `sz.${code}`;
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
  attributes: string[] = ['id', 'symbol', 'industry', 'circulating_market_cap'],
  options?: {
    /**
     * audit S-7 修复: 历史时点日; 不传则不做时点过滤 (因子 / 策略默认使用全集
     * 已知股票数据, 行为兼容旧)。需要按"当时上市但今天已退市"截断时传入。
     */
    as_of_date?: string;
  }
): Promise<Map<string, any>> {
  if (!codes.length) return new Map();
  const symbols = Array.from(new Set(codes.map(inferStockSymbol).filter(Boolean)));
  const where: any = { symbol: { [Op.in]: symbols } };
  if (options?.as_of_date) {
    where[Op.or as any] = [
      { is_listed: true },
      { delisting_date: { [Op.ne]: null, [Op.gt]: options.as_of_date } as any },
    ];
  }
  const rows = (await Stock.findAll({
    attributes,
    where,
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
