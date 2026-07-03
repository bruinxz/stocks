/**
 * MacroController — 宏观环境数据 API
 *
 * 暴露 4 个新数据维度的查询接口：
 *   - GET /api/macro/indicators        最新 PMI/CPI/M2/SHIBOR/国债/GDP
 *   - GET /api/macro/qvix              QVIX 时间序列 (4 个标的)
 *   - GET /api/macro/regime-snapshot   完整 market_environment (含 macro+qvix)
 *   - GET /api/macro/fund-holdings/:stock_code 某只股票被哪些公募重仓
 *
 * 给 FactorWorkspace 的"宏观环境"tab 用.
 */

import { Request, Response } from 'express';
import { Op } from 'sequelize';
import { MacroIndicator } from '../../models/MacroIndicator';
import { OptionQvix } from '../../models/OptionQvix';
import { FundTopHolding } from '../../models/FundTopHolding';
import { marketEnvironmentService } from '../../services/MarketEnvironmentService';
import { logger } from '../../utils/logger';

export class MacroController {
  /**
   * GET /api/macro/indicators
   * 返回各 indicator 的时间序列（默认近 36 个月 + 60 个交易日）
   */
  getIndicators = async (req: Request, res: Response) => {
    try {
      const days = Math.min(Number(req.query.days) || 365, 3650);
      const sinceDate = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
      const all = await MacroIndicator.findAll({
        where: { observation_date: { [Op.gte]: sinceDate } },
        order: [
          ['indicator_key', 'ASC'],
          ['observation_date', 'ASC'],
        ],
        raw: true,
      });
      // 按 indicator_key 分组
      const grouped: Record<string, any[]> = {};
      for (const r of all as any[]) {
        const key = r.indicator_key;
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push({
          date: r.observation_date,
          value: Number(r.value),
          yoy_pct: r.yoy_pct != null ? Number(r.yoy_pct) : null,
        });
      }
      // 也返回每个 indicator 的 latest 单独便于 KPI 卡片
      const latest: Record<string, { date: string; value: number; yoy_pct: number | null }> = {};
      for (const [k, list] of Object.entries(grouped)) {
        latest[k] = list[list.length - 1];
      }
      res.json({ success: true, data: { latest, series: grouped, days } });
    } catch (e: any) {
      logger.error('macro getIndicators failed:', e);
      res.status(500).json({ success: false, message: e?.message });
    }
  };

  /**
   * GET /api/macro/qvix
   * 4 个 QVIX 的时间序列 (default last 90 days)
   */
  getQvix = async (req: Request, res: Response) => {
    try {
      const days = Math.min(Number(req.query.days) || 90, 365);
      const sinceDate = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
      const all = await OptionQvix.findAll({
        where: { observation_date: { [Op.gte]: sinceDate } },
        order: [
          ['underlying', 'ASC'],
          ['observation_date', 'ASC'],
        ],
        raw: true,
      });
      const grouped: Record<string, any[]> = {};
      for (const r of all as any[]) {
        if (!grouped[r.underlying]) grouped[r.underlying] = [];
        grouped[r.underlying].push({
          date: r.observation_date,
          open: Number(r.open),
          high: Number(r.high),
          low: Number(r.low),
          close: Number(r.close),
        });
      }
      // latest
      const latest: Record<string, any> = {};
      for (const [k, list] of Object.entries(grouped)) {
        const last = list[list.length - 1];
        const prev5 = list[list.length - 6];
        latest[k] = {
          ...last,
          change_5d_pct: prev5
            ? (((last.close - prev5.close) / prev5.close) * 100).toFixed(2)
            : null,
        };
      }
      res.json({ success: true, data: { latest, series: grouped, days } });
    } catch (e: any) {
      logger.error('macro getQvix failed:', e);
      res.status(500).json({ success: false, message: e?.message });
    }
  };

  /**
   * GET /api/macro/regime-snapshot
   * 完整市场环境快照（沪深 300 base）— breadth + macro + qvix + industry
   */
  getRegimeSnapshot = async (req: Request, res: Response) => {
    try {
      const symbol = (req.query.symbol as string) || 'sh.000300';
      const snap = await marketEnvironmentService.getEnvironmentForStock(symbol, {
        use_cache: req.query.use_cache !== 'false',
        as_of: (req.query.as_of as string) || undefined,
      });
      res.json({ success: true, data: snap });
    } catch (e: any) {
      logger.error('macro getRegimeSnapshot failed:', e);
      res.status(500).json({ success: false, message: e?.message });
    }
  };

  /**
   * GET /api/macro/fund-holdings/:stock_code
   * 某只股票被哪些公募基金重仓
   */
  getFundHoldingsByStock = async (req: Request, res: Response) => {
    try {
      const stockCode = String(req.params.stock_code || '').trim();
      if (!/^\d{6}$/.test(stockCode)) {
        return res.status(400).json({ success: false, message: 'stock_code 必须是 6 位数字' });
      }
      const rows = await FundTopHolding.findAll({
        where: { stock_code: stockCode },
        order: [
          ['report_date', 'DESC'],
          ['ratio_pct', 'DESC'],
        ],
        limit: 30,
        raw: true,
      });
      res.json({ success: true, data: { items: rows, count: rows.length } });
    } catch (e: any) {
      logger.error('macro getFundHoldingsByStock failed:', e);
      res.status(500).json({ success: false, message: e?.message });
    }
  };
}
