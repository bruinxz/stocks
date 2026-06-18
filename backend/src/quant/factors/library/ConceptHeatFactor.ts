/**
 * ConceptHeatFactor — Batch AC (2026-06-18)
 *
 * 题材/概念热度因子. 对每只股票, 统计其在近 7 个交易日的"热门话题/概念"
 * 关联次数 + 热度得分总和.
 *
 * 数据源:
 *   - SnowballHotKeyword.related_stocks_json (Array<{stock_code, ...}>)
 *     每条热门话题挂着一组关联股, 累计这些股票的"被热门话题命中次数 × 该话题
 *     heat_score" 作为该股的"题材热度"
 *
 * 公式: raw_value = sum(heat_score × hit_count for each keyword that contains this stock)
 *   - 一只股出现在 N 个热门话题里 → N 次贡献
 *   - 题材越热 (heat_score 越大) → 该股贡献越大
 *
 * 用途:
 *   - 与 IndustryMomentumFactor 互补: 行业 = 申万一级 (硬分类),
 *     概念 = 跨行业主题 (e.g. "AI 算力" 同时包含半导体 + 光通信 + PCB)
 *   - MFA 权重纳入 → 让"今天该买 AI 算力概念股"成为可计算信号
 *
 * 失效:
 *   - 7 日窗口内 SnowballHotKeyword 无关联该股 → null (走中性补全)
 *   - related_stocks_json 缺失 / 非法 → 跳过
 */

import { Op } from 'sequelize';
import { Factor } from '../types';
import { factorRegistry } from '../FactorRegistry';
import { SnowballHotKeyword } from '../../../models/SnowballHotKeyword';
import { isFiniteNumber, lookbackStartDate } from './_helpers';

const WINDOW_DAYS = 7;

export const conceptHeatFactor: Factor = {
  name: 'concept_heat',
  description: '近 7 日个股关联热门话题的累计热度 (跨行业主题信号)',
  category: 'sentiment',

  async compute(ctx) {
    const out = new Map<string, number | null>();
    if (!ctx.universe.length) return out;

    // 1) 拉窗口内的 SnowballHotKeyword
    const startDate = lookbackStartDate(ctx.as_of_date, WINDOW_DAYS);
    const rows = (await SnowballHotKeyword.findAll({
      attributes: ['trade_date', 'keyword', 'heat_score', 'related_stocks_json'],
      where: {
        trade_date: { [Op.gte]: startDate, [Op.lte]: ctx.as_of_date },
      },
      raw: true,
    })) as unknown as Array<{
      trade_date: string;
      keyword: string;
      heat_score: any;
      related_stocks_json: any;
    }>;

    if (!rows.length) return out;

    // 2) 聚合: 每个 stock_code 累计 (heat_score × 1) 即 sum of heat_score
    const heatByCode = new Map<string, number>();
    const universeSet = new Set(ctx.universe);
    for (const r of rows) {
      const heat = Number(r.heat_score);
      if (!isFiniteNumber(heat) || heat <= 0) continue;
      const related = Array.isArray(r.related_stocks_json) ? r.related_stocks_json : [];
      for (const item of related) {
        const code = String(item?.stock_code || '').trim();
        if (!code) continue;
        // universeSet 是 6 位无后缀; related_stocks_json 也是无后缀 (按 SnowballHotKeywordSyncService 写入约定)
        if (!universeSet.has(code)) continue;
        heatByCode.set(code, (heatByCode.get(code) || 0) + heat);
      }
    }

    // 3) 输出
    for (const [code, heat] of heatByCode.entries()) {
      out.set(code, heat);
    }

    return out;
  },
};

factorRegistry.register(conceptHeatFactor);
