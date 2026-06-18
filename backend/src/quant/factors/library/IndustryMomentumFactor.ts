/**
 * IndustryMomentumFactor — Batch AC (2026-06-18)
 *
 * 行业动量因子. 对每只股票, 看其所在行业 (Stock.industry) 近 5 个交易日的
 * 累计涨幅 + 主力净流入率, z-score 化后作为该股的"今日所在行业热度"信号.
 *
 * 公式: raw_value = mean(industry_change_pct[last 5 days]) +
 *                   mean(industry_main_inflow_ratio[last 5 days]) × 100
 *   - 两项都是百分点单位, 直接相加 (横截面 z-score 自动归一)
 *   - 5 日窗口 + main_inflow_ratio 双信号防"今日单点偶然爆发但资金未跟进"
 *
 * 数据源:
 *   - IndustryFlow (trade_date, industry_name, change_pct, main_inflow_ratio)
 *   - Stock.industry → 行业归属
 *
 * 用途:
 *   - MFA 用 z_score 加权选股 → 让"今天买半导体 vs 消费"成为信号
 *   - 配合 ConceptHeatFactor 形成"行业热 + 题材热"组合信号
 *
 * 失效:
 *   - Stock.industry 缺失 → 跳过
 *   - 行业近 5 日 industry_flows 缺数据 → 跳过
 */

import { Op } from 'sequelize';
import { Factor } from '../types';
import { factorRegistry } from '../FactorRegistry';
import { IndustryFlow } from '../../../models/IndustryFlow';
import { loadStocksByCodes, stripSuffix, isFiniteNumber } from './_helpers';
import { tradingDayLookbackStartDate } from './_tradingDayWindow';

/** 业务窗口: 近 5 个交易日 (audit M-9: 从 7 自然日改成精确 5 交易日) */
const WINDOW_TRADING_DAYS = 5;

export const industryMomentumFactor: Factor = {
  name: 'industry_momentum',
  description: '行业近 5 日累计涨幅 + 主力净流入率 (z-score)',
  category: 'flow',

  async compute(ctx) {
    const out = new Map<string, number | null>();
    if (!ctx.universe.length) return out;

    // 1) 拉 Stock.industry
    const stockByCode = await loadStocksByCodes(ctx.universe, ['id', 'symbol', 'industry']);
    if (!stockByCode.size) return out;

    // 2) 拉窗口内的 IndustryFlow (audit M-9: 交易日窗口而非自然日)
    const startDate = await tradingDayLookbackStartDate(ctx.as_of_date, WINDOW_TRADING_DAYS);
    const rows = (await IndustryFlow.findAll({
      attributes: ['trade_date', 'industry_name', 'change_pct', 'main_inflow_ratio'],
      where: {
        trade_date: { [Op.gte]: startDate, [Op.lte]: ctx.as_of_date },
      },
      raw: true,
    })) as unknown as Array<{
      trade_date: string;
      industry_name: string;
      change_pct: any;
      main_inflow_ratio: any;
    }>;

    if (!rows.length) return out;

    // 3) 按 industry_name 聚合 mean(change_pct) + mean(main_inflow_ratio × 100)
    const groupByIndustry = new Map<string, { changes: number[]; inflowRatios: number[] }>();
    for (const r of rows) {
      const name = String(r.industry_name || '').trim();
      if (!name) continue;
      if (!groupByIndustry.has(name)) {
        groupByIndustry.set(name, { changes: [], inflowRatios: [] });
      }
      const g = groupByIndustry.get(name)!;
      const change = Number(r.change_pct);
      const ratio = Number(r.main_inflow_ratio);
      if (isFiniteNumber(change)) g.changes.push(change);
      if (isFiniteNumber(ratio)) g.inflowRatios.push(ratio);
    }

    // 4) 计算每行业的 industry score
    const scoreByIndustry = new Map<string, number>();
    for (const [name, g] of groupByIndustry.entries()) {
      if (!g.changes.length && !g.inflowRatios.length) continue;
      const meanChange = g.changes.length
        ? g.changes.reduce((s, v) => s + v, 0) / g.changes.length
        : 0;
      const meanInflowRatio = g.inflowRatios.length
        ? g.inflowRatios.reduce((s, v) => s + v, 0) / g.inflowRatios.length
        : 0;
      // change_pct 是 % (0.5 = 0.5%), main_inflow_ratio 是 fraction (0.005 = 0.5%)
      // × 100 让两项量级一致
      scoreByIndustry.set(name, meanChange + meanInflowRatio * 100);
    }

    // 5) 按 universe 映射回 stock
    for (const [code, stock] of stockByCode.entries()) {
      const industry = String((stock as any).industry || '').trim();
      if (!industry) continue;
      const score = scoreByIndustry.get(industry);
      if (typeof score === 'number' && isFiniteNumber(score)) {
        out.set(stripSuffix(stock.symbol), score);
      }
    }

    return out;
  },
};

factorRegistry.register(industryMomentumFactor);
