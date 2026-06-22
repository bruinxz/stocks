/**
 * GrowthFactor (成长因子) — US-010
 *
 * 公式：raw_value = 0.6 * net_profit_yoy + 0.4 * revenue_yoy
 *   - 净利润同比增长权重 0.6（利润是成长性核心）
 *   - 营收同比增长权重 0.4（营收增长支撑利润，避免单纯利润操纵）
 *
 * 数据源：FinancialReport 表 (年报/半年报/一季报/三季报)
 *   - 字段：stock_code、report_date、net_profit_yoy、revenue_yoy
 *   - 取每只股票"最近一份" report_date 的 yoy 数据
 *
 * 失效：net_profit_yoy 与 revenue_yoy 都缺 → 跳过；只缺一项时用 0 代入。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Batch BA (2026-06-22) — 切换数据源 StockFundamentalFactor → FinancialReport：
 *
 * 历史背景：原实现读 StockFundamentalFactor.net_profit_growth / revenue_growth，
 * 但 prod 这两列**永远 NULL**（15184 行 0 个有效值）。本仓库的 sync 服务
 * `local_derived` 源只填 roe / gross_margin / quality_score，从未填 growth 字段。
 * 导致 GrowthFactor.compute() 拿到全 null → Map 永远 size=0 → 横截面 std=0
 * → factor 完全无信号（prod 22 因子里 6 个 std=0 之一）。
 *
 * Batch AN (2026-06-21) 修过 `Number(null) === 0` 大坑（避免 null 静默变 0
 * 通过 isFiniteNumber 校验），但只是治标 — 真正的源头是数据源选错。
 *
 * FinancialReport 同时段有 1113 行、24 只 A 股 龙头 / 蓝筹 的 45 份历史季报，
 * net_profit_yoy / revenue_yoy 全部填充，与本因子完全契合：
 *   - 与 QualityHighFactor (US-031) / GARPStrategy (US-024) 同数据源，
 *     避免一个因子读 A 源 / 另一个读 B 源的口径漂移
 *   - net_profit_yoy / revenue_yoy 直接是同比 % 形式，无需再算
 *   - stock_code 无后缀，与 ctx.universe 直接 join 不需 stripSuffix
 *
 * 升级路径：未来如果 stock_fundamental_factors.net_profit_growth /
 * revenue_growth 真有数据填进来（sync_fundamental 路径修复后），考虑做"两源
 * fallback" — 先尝试 FinancialReport，缺数据时再 fallback 到 StockFundamentalFactor。
 *
 * **注意单位**：FinancialReport.{net_profit_yoy, revenue_yoy} 都是 "%" 形式
 * （如 23.5 表示 +23.5%），不是 0..1 小数。直接用即可。
 */

import { Op } from 'sequelize';
import { Factor } from '../types';
import { factorRegistry } from '../FactorRegistry';
import { FinancialReport } from '../../../models/FinancialReport';
import { isFiniteNumber, lookbackStartDate } from './_helpers';

/**
 * 财报回看窗口（自然日）。
 * 季报披露最长延迟 ~75 天（一季报 4 月底前，年报 4 月底前）；取 200 天 buffer
 * 兜底跨年 + 节假日。
 */
export const REPORT_LOOKBACK_DAYS = 200;

/** 给定 FinancialReport 行集合，按 stock_code 取最新一份的 (np_yoy, rev_yoy) 快照 */
export interface YoySnap {
  np_yoy: number | null;
  rev_yoy: number | null;
  report_date: string;
}

/**
 * 纯函数：从 raw 行集合按 stock_code 分组 + 取 report_date 最大的快照。
 *
 * 规则：
 *   - 同股票多行 → 取 report_date 最大者
 *   - 该行两字段都 null → 当前行不更新 latest（避免新空行覆盖旧有效行）
 *
 * Batch AN 同款 `Number(null) === 0` 防御：必须先 null 检查再 Number 转换。
 */
export function pickLatestYoyByStock(
  rows: Array<{
    stock_code: string;
    report_date: string;
    net_profit_yoy: any;
    revenue_yoy: any;
  }>
): Map<string, YoySnap> {
  const out = new Map<string, YoySnap>();
  for (const r of rows) {
    const npRaw = r.net_profit_yoy;
    const revRaw = r.revenue_yoy;
    const npNum = npRaw == null ? NaN : Number(npRaw);
    const revNum = revRaw == null ? NaN : Number(revRaw);
    const npVal = isFiniteNumber(npNum) ? npNum : null;
    const revVal = isFiniteNumber(revNum) ? revNum : null;
    if (npVal === null && revVal === null) continue;
    const cur = out.get(r.stock_code);
    if (!cur || r.report_date > cur.report_date) {
      out.set(r.stock_code, {
        np_yoy: npVal,
        rev_yoy: revVal,
        report_date: r.report_date,
      });
    }
  }
  return out;
}

/** 纯函数：0.6*np + 0.4*rev 加权 (单缺项以 0 代入) */
export function combineGrowth(snap: YoySnap): number | null {
  if (snap.np_yoy === null && snap.rev_yoy === null) return null;
  const np = snap.np_yoy ?? 0;
  const rev = snap.rev_yoy ?? 0;
  return 0.6 * np + 0.4 * rev;
}

export const growthFactor: Factor = {
  name: 'growth',
  description: '0.6*净利润同比 + 0.4*营收同比；最新一期财报数据 (FinancialReport)',
  category: 'growth',

  async compute(ctx) {
    const out = new Map<string, number | null>();
    if (!ctx.universe.length) return out;

    const startDate = lookbackStartDate(ctx.as_of_date, REPORT_LOOKBACK_DAYS);

    const rows = (await FinancialReport.findAll({
      attributes: ['stock_code', 'report_date', 'net_profit_yoy', 'revenue_yoy'],
      where: {
        stock_code: { [Op.in]: ctx.universe },
        report_date: { [Op.gte]: startDate, [Op.lte]: ctx.as_of_date },
      },
      raw: true,
    })) as unknown as Array<{
      stock_code: string;
      report_date: string;
      net_profit_yoy: any;
      revenue_yoy: any;
    }>;

    const latestByStock = pickLatestYoyByStock(rows);
    const universeSet = new Set(ctx.universe);
    for (const [code, snap] of latestByStock.entries()) {
      if (!universeSet.has(code)) continue;
      const v = combineGrowth(snap);
      if (v === null) continue;
      out.set(code, v);
    }

    return out;
  },
};

factorRegistry.register(growthFactor);
