/**
 * ValueFactor (价值因子) — US-010
 *
 * 公式：raw_value = 1 / PE-TTM + 1 / PB
 *   - PE-TTM 越低 → 1/PE 越大 → 越价值
 *   - PB 越低 → 1/PB 越大 → 越价值
 *   - 两者等权相加（两个比率本身已经是 "便宜度"，无量纲一致）
 *
 * 数据源：StockValuationFactor 表
 *   - 字段：symbol（带 .SH/.SZ 后缀）、factor_date、pe_ttm、pb
 *   - 选 (symbol, factor_date <= as_of_date) 的最新一条
 *
 * 失效条件（返回 raw_value=null 让 Pipeline 补中性，或干脆不返回这只股票）：
 *   - PE-TTM ≤ 0（亏损股，价值因子无意义）
 *   - PB ≤ 0
 *   - 两者任一缺失
 *
 * 不在因子内做 winsorize / z-score —— FactorPipeline 统一做横截面标准化。
 */

import { Op } from 'sequelize';
import { Factor } from '../types';
import { factorRegistry } from '../FactorRegistry';
import { stripSuffix, isFiniteNumber, lookbackStartDate } from './_helpers';

const StockValuationFactor = { findAll: async (_?: any): Promise<any[]> => [] };

export const valueFactor: Factor = {
  name: 'value',
  description: 'PE-TTM 倒数 + PB 倒数 合成的价值因子（越大越便宜）',
  category: 'value',

  async compute(ctx) {
    const out = new Map<string, number | null>();
    if (!ctx.universe.length) return out;

    // StockValuationFactor.symbol 带后缀；universe 是无后缀的。
    // 用 factor_date 时间窗口反查，再按 symbol 取最新一条。
    const lookbackStart = lookbackStartDate(ctx.as_of_date, 60); // 估值数据通常季度更新；60 天足以拿到最新一条

    const rows = (await StockValuationFactor.findAll({
      attributes: ['symbol', 'factor_date', 'pe_ttm', 'pb'],
      where: {
        factor_date: { [Op.gte]: lookbackStart, [Op.lte]: ctx.as_of_date },
      },
      raw: true,
    })) as unknown as Array<{
      symbol: string;
      factor_date: string;
      pe_ttm: any;
      pb: any;
    }>;

    // 每个 stock 取 factor_date 最大的一行（最新估值）
    const latestBySymbol = new Map<string, { pe_ttm: any; pb: any; date: string }>();
    for (const r of rows) {
      const cur = latestBySymbol.get(r.symbol);
      if (!cur || r.factor_date > cur.date) {
        latestBySymbol.set(r.symbol, { pe_ttm: r.pe_ttm, pb: r.pb, date: r.factor_date });
      }
    }

    // 按 universe 输出
    const universeSet = new Set(ctx.universe);
    for (const [symbol, snap] of latestBySymbol.entries()) {
      const code = stripSuffix(symbol);
      if (!universeSet.has(code)) continue;

      const pe = Number(snap.pe_ttm);
      const pb = Number(snap.pb);
      if (!isFiniteNumber(pe) || !isFiniteNumber(pb)) continue;
      if (pe <= 0 || pb <= 0) continue; // 亏损 / 异常负值 → 价值不可计算，留稀疏

      out.set(code, 1 / pe + 1 / pb);
    }

    return out;
  },
};

factorRegistry.register(valueFactor);
