import { Factor } from '../types';
import { factorRegistry } from '../FactorRegistry';
import { FundTopHolding } from '../../../models/FundTopHolding';
import { Op } from 'sequelize';

/**
 * FundConsensusFactor — 公募基金重仓抱团度
 *
 * 经济意义：被多个公募基金重仓的股票 → 机构资金共识，往往代表"白马股"
 *   - 高分: 多家头部主动权益基金 top10 持仓 → 机构持续买入 → 通常 alpha
 *   - 低分: 无机构关注 → 散户票
 *
 * raw_value = (该股票在最新季报中被多少个 universe 内基金重仓) × log(总持仓占净值比例)
 *
 * 横截面 z-score 标准化由 FactorPipeline 自动做。
 *
 * 数据源：fund_top_holdings (来自 AKShare 公募季报披露)
 * 触发：季度调仓时 alpha 信号 (季报披露后 1-2 周内 IC 最强)
 *
 * 注意：因为只覆盖 12 个代表性基金，所以信号偏稀疏；
 *   raw_value=0 表示该股不被任一基金重仓 → 中性 (pipeline 会 fill z=0)。
 */
export const fundConsensusFactor: Factor = {
  name: 'fund_consensus',
  description: '公募基金抱团度：(重仓基金数 × log(累计占净值比例))，反映机构共识',
  category: 'flow',
  async compute(ctx) {
    const universe = ctx.universe || [];
    if (universe.length === 0) return new Map();

    // 取最新季报 (任何在 [as_of_date - 180d, as_of_date] 内的)
    const asOf = ctx.as_of_date;
    const latestReportRow = (await FundTopHolding.findOne({
      where: {
        report_date: { [Op.lte]: asOf },
      },
      order: [['report_date', 'DESC']],
      attributes: ['report_date'],
      raw: true,
    })) as any;
    if (!latestReportRow?.report_date) return new Map();
    const latestReport = latestReportRow.report_date;

    // 拉所有该季报的持仓
    const rows = (await FundTopHolding.findAll({
      where: { report_date: latestReport },
      attributes: ['fund_code', 'stock_code', 'ratio_pct'],
      raw: true,
    })) as any[];

    // 按 stock_code 聚合
    const aggMap = new Map<string, { fund_count: number; total_ratio: number }>();
    for (const r of rows) {
      const code = String(r.stock_code).trim();
      if (!code) continue;
      const entry = aggMap.get(code) || { fund_count: 0, total_ratio: 0 };
      entry.fund_count += 1;
      entry.total_ratio += Number(r.ratio_pct || 0);
      aggMap.set(code, entry);
    }

    // 映射回 universe 内的股票
    const out = new Map<string, number>();
    for (const stockCode of universe) {
      const entry = aggMap.get(stockCode);
      if (!entry || entry.fund_count === 0) continue;
      // 公式: fund_count × log(1 + total_ratio)
      // log 防止"单只基金持仓 30%"占主导，鼓励多基金共识
      const raw = entry.fund_count * Math.log1p(entry.total_ratio);
      if (Number.isFinite(raw) && raw > 0) {
        out.set(stockCode, raw);
      }
    }

    return out;
  },
};

factorRegistry.register(fundConsensusFactor);
