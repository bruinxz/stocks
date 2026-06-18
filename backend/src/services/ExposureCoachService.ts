/**
 * ExposureCoachService — Phase 8 总仓位/暴露追踪
 *
 * 用户的 portfolio 不止"几只持仓"，还有"多少 equity 投出去了" / "杠杆度" /
 * "对市场的 beta 暴露"。本服务把这些都算出来给 dashboard 一眼看清。
 *
 * 4 维 exposure:
 *   1. gross_exposure = Σ |market_value| / total_equity
 *      (做空时 |value| 用 abs；当前 A 股纯多头，gross = 持仓 mv / equity)
 *   2. net_exposure = (long_mv - short_mv) / total_equity
 *      (纯多头时 = gross；将来支持融券时拆开)
 *   3. leverage_ratio = gross_exposure
 *      (融资时 > 1.0；当前 A 股纯现金时 ≤ 1.0)
 *   4. beta_exposure = Σ (weight_i × beta_i_to_hs300)
 *      (组合相对沪深 300 的 β；β=1 完全跟大盘，β<1 防御)
 *
 * 设计:
 *   - 纯函数 helper 全 export 单测脱 DB
 *   - DataSource 注入 (PRODUCTION DailyBar + Stock + PaperTradingPortfolio/Position)
 *   - beta 缺数据 fallback to 1.0 (假设跟大盘走)
 */

import { Op } from 'sequelize';
import { DailyBar } from '../models/DailyBar';
import { PaperTradingPortfolio } from '../models/PaperTradingPortfolio';
import { PaperTradingPosition } from '../models/PaperTradingPosition';
import { Stock } from '../models/Stock';
import { logger } from '../utils/logger';

// ============================================================
// Types
// ============================================================

export interface ExposureContext {
  total_equity: number;
  current_cash: number;
  positions: Array<{
    symbol: string;
    market_value: number;
    beta_to_hs300?: number | null;
  }>;
}

export interface ExposureReport {
  generated_at: string;
  portfolio_id: number;
  user_id: number;
  total_equity: number;
  current_cash: number;
  cash_pct: number;
  position_count: number;
  /** gross_exposure = Σ |mv| / equity；纯多头时 = 持仓 mv 占比 */
  gross_exposure: number;
  /** net_exposure = (long - short) / equity；纯多头时 = gross */
  net_exposure: number;
  /** leverage = gross；> 1 时表示融资 */
  leverage_ratio: number;
  /** beta_exposure = Σ (w_i × β_i) 相对沪深 300 */
  beta_exposure: number;
  /** beta 数据缺失的持仓数（fallback to 1.0 假设） */
  beta_missing_count: number;
  /** 警告标签 */
  warnings: string[];
}

// ============================================================
// 纯函数 helpers (export 单测脱 DB)
// ============================================================

/**
 * 计算 gross_exposure（纯多头视角下 = sum(mv)/equity）。
 * 负 mv（短仓）按绝对值计入 gross。
 */
export function computeGrossExposure(
  positions: Array<{ market_value: number }>,
  total_equity: number
): number {
  if (total_equity <= 0) return 0;
  const grossMV = positions.reduce((s, p) => s + Math.abs(Number(p.market_value || 0)), 0);
  return grossMV / total_equity;
}

/**
 * 计算 net_exposure = (long - short) / equity。
 * 纯多头时 = gross_exposure。
 */
export function computeNetExposure(
  positions: Array<{ market_value: number }>,
  total_equity: number
): number {
  if (total_equity <= 0) return 0;
  const longMV = positions
    .filter(p => Number(p.market_value || 0) > 0)
    .reduce((s, p) => s + Number(p.market_value), 0);
  const shortMV = positions
    .filter(p => Number(p.market_value || 0) < 0)
    .reduce((s, p) => s + Math.abs(Number(p.market_value)), 0);
  return (longMV - shortMV) / total_equity;
}

/**
 * 计算 beta_exposure = Σ (weight_i × beta_i)
 *
 * weight_i = market_value_i / sum(market_value) (按 mv 权重)
 * beta_i: 缺失时假设 = 1.0 (跟大盘走)
 *
 * 返回 { beta_exposure, missing_count } —— missing_count 让 UI 提示数据缺失程度
 */
export function computeBetaExposure(
  positions: Array<{ market_value: number; beta_to_hs300?: number | null }>
): { beta_exposure: number; missing_count: number } {
  const totalMV = positions.reduce((s, p) => s + Math.abs(Number(p.market_value || 0)), 0);
  if (totalMV <= 0) return { beta_exposure: 0, missing_count: 0 };
  let weightedBeta = 0;
  let missingCount = 0;
  for (const p of positions) {
    const mv = Math.abs(Number(p.market_value || 0));
    const w = mv / totalMV;
    const beta = Number.isFinite(p.beta_to_hs300 as number) ? (p.beta_to_hs300 as number) : 1.0;
    if (p.beta_to_hs300 === undefined || p.beta_to_hs300 === null) missingCount++;
    weightedBeta += w * beta;
  }
  return { beta_exposure: weightedBeta, missing_count: missingCount };
}

/**
 * 计算 60 日 stock vs hs300 的 beta（OLS 斜率）。
 *
 * 公式: β = Cov(stock_return, hs300_return) / Var(hs300_return)
 *
 * 边界:
 *   - 数据 < MIN_OBS (30) → null
 *   - hs300 方差 0 → null (理论不会发生)
 *   - 全相等 → null
 *
 * 这是 export 纯函数，单测可独立调用。
 */
export const BETA_MIN_OBS = 30;

export function computeBeta(
  stockReturns: number[],
  benchmarkReturns: number[]
): number | null {
  if (stockReturns.length !== benchmarkReturns.length) return null;
  if (stockReturns.length < BETA_MIN_OBS) return null;
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < stockReturns.length; i++) {
    if (Number.isFinite(stockReturns[i]) && Number.isFinite(benchmarkReturns[i])) {
      pairs.push([stockReturns[i], benchmarkReturns[i]]);
    }
  }
  if (pairs.length < BETA_MIN_OBS) return null;
  const n = pairs.length;
  const meanS = pairs.reduce((s, [a]) => s + a, 0) / n;
  const meanB = pairs.reduce((s, [_, b]) => s + b, 0) / n;
  let cov = 0;
  let varB = 0;
  for (const [s, b] of pairs) {
    cov += (s - meanS) * (b - meanB);
    varB += (b - meanB) * (b - meanB);
  }
  if (varB <= 1e-12) return null;
  return cov / varB;
}

/**
 * 把 closes 转 daily returns；与 PortfolioCorrelationService 同款公式。
 */
export function closeToReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    const curr = closes[i];
    if (!Number.isFinite(prev) || prev <= 0 || !Number.isFinite(curr)) {
      out.push(NaN);
    } else {
      out.push((curr - prev) / prev);
    }
  }
  return out;
}

/**
 * 生成 warnings 列表（基于阈值）。
 */
export function buildWarnings(
  gross: number,
  net: number,
  leverage: number,
  beta: number,
  cashPct: number,
  missingBeta: number
): string[] {
  const warnings: string[] = [];
  if (leverage > 1.0) warnings.push(`⚠ 杠杆 ${(leverage * 100).toFixed(0)}% — 持仓总额超 equity，融资仓位较高`);
  if (gross > 0.95) warnings.push(`⚠ gross_exposure ${(gross * 100).toFixed(0)}% — 近满仓，无应急 buffer`);
  if (cashPct < 0.05 && gross > 0.9) warnings.push(`⚠ 现金 < 5% — 黑天鹅来临无加仓子弹`);
  if (beta > 1.3) warnings.push(`⚠ β=${beta.toFixed(2)} — 组合对大盘高敏感，下跌时跌幅 > 指数`);
  if (beta < 0.5) warnings.push(`ℹ β=${beta.toFixed(2)} — 低 β 防御组合（跑不过指数也跌得少）`);
  if (missingBeta > 0) warnings.push(`ℹ ${missingBeta} 只持仓 β 数据缺失，已 fallback to 1.0`);
  return warnings;
}

// ============================================================
// DataSource 注入
// ============================================================

export interface ExposureCoachDataSource {
  loadPortfolioHeader(portfolio_id: number): Promise<{
    user_id: number;
    total_value: number;
    current_cash: number;
  } | null>;
  loadPositionsWithMV(portfolio_id: number): Promise<
    Array<{ symbol: string; market_value: number; quantity: number }>
  >;
  loadStockBetas(symbols: string[]): Promise<Map<string, number | null>>;
}

/**
 * PRODUCTION: 实时算每个持仓的 60 日 β to hs300。
 * - DailyBar 用 stock_id 索引；要先 Stock 找 id
 * - hs300 用 'sh.000300' 的 stock_id
 * 数据不足或缺 → null (caller fallback to 1.0)
 */
export const PRODUCTION_EXPOSURE_DATA_SOURCE: ExposureCoachDataSource = {
  async loadPortfolioHeader(portfolio_id) {
    const p = await PaperTradingPortfolio.findByPk(portfolio_id, {
      attributes: ['user_id', 'total_value', 'current_cash'],
    });
    return p
      ? {
          user_id: p.user_id,
          total_value: Number(p.total_value || 0),
          current_cash: Number(p.current_cash || 0),
        }
      : null;
  },
  async loadPositionsWithMV(portfolio_id) {
    const positions = await PaperTradingPosition.findAll({
      where: { portfolio_id, quantity: { [Op.gt]: 0 } },
      attributes: ['symbol', 'market_value', 'quantity'],
    });
    return positions.map(p => ({
      symbol: p.symbol,
      market_value: Number(p.market_value || 0),
      quantity: Number(p.quantity || 0),
    }));
  },
  async loadStockBetas(symbols) {
    const map = new Map<string, number | null>();
    if (symbols.length === 0) return map;
    try {
      // 1. 拿 stock ids
      const stocks = await Stock.findAll({
        where: { symbol: { [Op.in]: [...symbols, 'sh.000300'] } },
        attributes: ['id', 'symbol'],
      });
      const symToId = new Map(stocks.map(s => [s.symbol, s.id]));
      const idToSym = new Map(stocks.map(s => [s.id, s.symbol]));
      const hs300Id = symToId.get('sh.000300');
      if (!hs300Id) {
        // 沪深 300 数据缺失 → 全部 null
        for (const s of symbols) map.set(s, null);
        return map;
      }

      // 2. 拿 90 日 bars (60 个交易日 + 假期 buffer)
      const since = new Date();
      since.setDate(since.getDate() - 120);
      const allIds = [...Array.from(symToId.values())];
      const bars = await DailyBar.findAll({
        where: {
          stock_id: { [Op.in]: allIds },
          time: { [Op.gte]: since },
        },
        attributes: ['stock_id', 'time', 'close'],
        order: [['time', 'ASC']],
      });

      // 3. 按 stock_id 分组. Batch Y (2026-06-17, fact-3 fix): 保留 date 让后面
      // β 计算可以按日期对齐. 之前 closes 只是数组, 停牌/上市晚的股票 stockReturns[i]
      // 与 hs300Returns[i] 不是同日 → cov() 错算 → β 系统性偏差.
      const closesByStock = new Map<number, Array<{ date: string; close: number }>>();
      for (const b of bars) {
        if (!closesByStock.has(b.stock_id)) closesByStock.set(b.stock_id, []);
        const dateKey = (b.time as any) instanceof Date
          ? (b.time as Date).toISOString().slice(0, 10)
          : String(b.time).slice(0, 10);
        closesByStock.get(b.stock_id)!.push({ date: dateKey, close: Number(b.close) });
      }
      const hs300Series = closesByStock.get(hs300Id) || [];
      // 按 date asc 排序确保 closeToReturns 不错位
      hs300Series.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      // 计算 hs300 returns 同时保留 date (return 的 date 用后一天 = 该收益所属交易日)
      const hs300ReturnsByDate = new Map<string, number>();
      for (let i = 1; i < hs300Series.length; i++) {
        const prev = hs300Series[i - 1].close;
        const cur = hs300Series[i].close;
        if (prev > 0 && Number.isFinite(prev) && Number.isFinite(cur)) {
          hs300ReturnsByDate.set(hs300Series[i].date, cur / prev - 1);
        }
      }

      // 4. 算每个 stock 的 β
      for (const sym of symbols) {
        const sid = symToId.get(sym);
        if (!sid) {
          map.set(sym, null);
          continue;
        }
        const stockSeries = closesByStock.get(sid) || [];
        stockSeries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
        // Batch Y (fact-3): 按 date 求交集对齐再算 β. 之前 slice(-len) 取尾部相同长度但
        // 不保证同日, 停牌断点导致 stock[i] 与 hs300[i] 错日, cov 严重失真.
        const alignedStockRet: number[] = [];
        const alignedHs300Ret: number[] = [];
        for (let i = 1; i < stockSeries.length; i++) {
          const prev = stockSeries[i - 1].close;
          const cur = stockSeries[i].close;
          if (!(prev > 0) || !Number.isFinite(prev) || !Number.isFinite(cur)) continue;
          const r = cur / prev - 1;
          const date = stockSeries[i].date;
          const hsRet = hs300ReturnsByDate.get(date);
          if (hsRet === undefined) continue; // 该日 hs300 缺数据 → 跳过
          alignedStockRet.push(r);
          alignedHs300Ret.push(hsRet);
        }
        if (alignedStockRet.length < BETA_MIN_OBS) {
          map.set(sym, null);
          continue;
        }
        const beta = computeBeta(alignedStockRet, alignedHs300Ret);
        map.set(sym, beta);
      }
      return map;
    } catch (err: any) {
      logger.warn(`[ExposureCoach] loadStockBetas failed: ${err?.message || err}`);
      for (const s of symbols) map.set(s, null);
      return map;
    }
  },
};

// ============================================================
// Service
// ============================================================

export class ExposureCoachService {
  constructor(private dataSource: ExposureCoachDataSource = PRODUCTION_EXPOSURE_DATA_SOURCE) {}

  /**
   * 算 portfolio 的 4 维 exposure 报告。
   */
  async getReport(portfolio_id: number): Promise<ExposureReport | null> {
    const header = await this.dataSource.loadPortfolioHeader(portfolio_id);
    if (!header) return null;
    const positions = await this.dataSource.loadPositionsWithMV(portfolio_id);
    const symbols = positions.map(p => p.symbol);
    const betas = await this.dataSource.loadStockBetas(symbols).catch(() => new Map());

    const positionsWithBeta = positions.map(p => ({
      ...p,
      beta_to_hs300: betas.get(p.symbol) ?? null,
    }));

    const gross = computeGrossExposure(positionsWithBeta, header.total_value);
    const net = computeNetExposure(positionsWithBeta, header.total_value);
    const leverage = gross; // 纯多头时 = gross
    const { beta_exposure, missing_count } = computeBetaExposure(positionsWithBeta);
    const cashPct = header.total_value > 0 ? header.current_cash / header.total_value : 0;
    const warnings = buildWarnings(gross, net, leverage, beta_exposure, cashPct, missing_count);

    return {
      generated_at: new Date().toISOString(),
      portfolio_id,
      user_id: header.user_id,
      total_equity: header.total_value,
      current_cash: header.current_cash,
      cash_pct: round(cashPct, 4),
      position_count: positions.length,
      gross_exposure: round(gross, 4),
      net_exposure: round(net, 4),
      leverage_ratio: round(leverage, 4),
      beta_exposure: round(beta_exposure, 4),
      beta_missing_count: missing_count,
      warnings,
    };
  }
}

function round(n: number, d: number): number {
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

export const exposureCoachService = new ExposureCoachService();
