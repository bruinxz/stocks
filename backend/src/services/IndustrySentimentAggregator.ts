/**
 * IndustrySentimentAggregator — PR-M3 (2026-06-29)
 *
 * 学术 + 大 V 共识 (PR-I 研究报告第 3 个致命短板):
 *   龙头战法 4 核心因子 = 板块涨停数 + 连板高度 + 封板率 + 炸板率.
 *
 * 当前 ✅:
 *   - LimitUpStock 表 (每日 sync, 含 continuous_days / limit_up_open_times / is_one_word_board)
 *   - Stock.industry (申万一级)
 *   - DailyBar (用于 30 日板块均涨幅 z-score 算 industry_momentum)
 *   - IndustryFlowIntradayService (BK-2 已实现盘中 10min 行业资金流, 本服务不依赖)
 *   - MarketBreadthService (大盘宽度统计, 本服务不依赖)
 *
 * 本服务每日 16:00 (工作日) 跑一次:
 *   1. 拉今日 limit_up_stocks JOIN stocks → 按 stocks.industry 分组聚合
 *   2. 算每个 industry 的 4 大因子 + 30 日动量 z-score
 *   3. weighted sum → composite_score
 *   4. upsert 写 industry_sentiment_indices (一行一行业)
 *
 * fail-OPEN 原则:
 *   - 30 日 daily_bars 拉失败 → industry_momentum_30d = null, composite_score 不 hung
 *   - 整个 industry 算 throw → 单 industry skip, 其它行业继续
 *   - 整次 run 永不 throw — runOnce 内顶层 try/catch 返 { ok: false, errors: [...] }
 *
 * 给推荐 service 消费 (classifyIndustry 纯函数 export):
 *   - composite_score > +2 → 'leader' tag (推荐 +20% 加权)
 *   - composite_score < -1 → 'weak' tag (直接 skip)
 *   - 其它 → 'neutral'
 */

import { logger } from '../utils/logger';
import { ensureModelsRegistered } from '../config/database';

// PR-Q (2026-06-30): cold-path Model not initialized hot-fix (AR-1 范式).
ensureModelsRegistered();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LimitUpStockRow {
  stock_code: string;
  stock_name?: string | null;
  industry?: string | null;
  /** 连板天数, 含当日 (首板 = 1, 二板 = 2) */
  continuous_days: number;
  /** 炸板次数 (当日打开涨停的次数) */
  limit_up_open_times?: number | null;
  /** 是否一字板 (首封 ≤ 09:30:00 且 炸板次数 = 0) */
  is_one_word_board: boolean;
}

export interface IndustrySentimentResult {
  trade_date: string;
  industry: string;
  lim_up_count: number;
  consecutive_max: number;
  /** 封板率 = (一字板 + 收盘封板) / 总涨停数; [0, 1] */
  seal_rate: number;
  /** 炸板率 = 至少炸过一次 / 总涨停数; [0, 1] */
  lim_up_failure_rate: number;
  /** 30 日动量 z-score (相对全市场), null = 数据不足 */
  industry_momentum_30d: number | null;
  /** 综合分 weighted sum, 大约 [-5, +5] */
  composite_score: number;
  constituent_count: number;
  /** 前 3 只按连板从高到低 */
  top_codes: string[];
  raw_payload: Record<string, any>;
}

export type LeaderClassification = 'leader' | 'weak' | 'neutral';

export interface AggregatorRunResult {
  ok: boolean;
  trade_date: string;
  industries_scanned: number;
  industries_written: number;
  errors: Array<{ where: string; reason: string }>;
}

export interface IndustrySentimentDataSource {
  /** 拉指定日期的 limit_up_stocks (含 stocks.industry JOIN) */
  listLimitUpStocks(tradeDate: string): Promise<LimitUpStockRow[]>;
  /** 拉所有股票最近 30 天 daily_bars (用于算每个 industry 30 日平均涨幅 → 全市场 z-score) */
  listRecent30DayBars(tradeDate: string): Promise<
    Array<{ stock_id: number; industry: string | null; close30d_pct: number }>
  >;
  /** upsert 一行 industry_sentiment_index */
  upsertSentiment(result: IndustrySentimentResult): Promise<void>;
}

// ---------------------------------------------------------------------------
// Pure helpers — 全 export 单测
// ---------------------------------------------------------------------------

/** 取数组最大值, 空 / 全非有限 → 0 */
export function maxOr0(values: number[]): number {
  let m = 0;
  for (const v of values || []) {
    if (Number.isFinite(v) && v > m) m = v;
  }
  return m;
}

/** mean of finite values; 空 → 0 */
export function meanFinite(values: number[]): number {
  let s = 0;
  let n = 0;
  for (const v of values || []) {
    if (Number.isFinite(v)) {
      s += v;
      n += 1;
    }
  }
  return n === 0 ? 0 : s / n;
}

/** 总体标准差 of finite values; 空 / 单值 → 0 */
export function stdevFinite(values: number[]): number {
  const finite: number[] = [];
  for (const v of values || []) {
    if (Number.isFinite(v)) finite.push(v);
  }
  if (finite.length === 0) return 0;
  const m = meanFinite(finite);
  let acc = 0;
  for (const v of finite) acc += (v - m) * (v - m);
  return Math.sqrt(acc / finite.length);
}

/**
 * 封板率 = (一字板 + 收盘封板 / 即从未炸板) / 总涨停数.
 * "收盘封板" 启发式: limit_up_open_times === 0 (从未炸过) → 视为锁住.
 * is_one_word_board 是更强信号, 优先归一字板. 二者并集计入分子.
 */
export function computeSealRate(rows: LimitUpStockRow[]): number {
  if (!rows || rows.length === 0) return 0;
  let sealed = 0;
  for (const r of rows) {
    const fail = Number(r.limit_up_open_times ?? 0);
    const isOneWord = r.is_one_word_board === true;
    if (isOneWord || fail === 0) sealed += 1;
  }
  return Math.min(1, sealed / rows.length);
}

/**
 * 炸板率 = 至少炸过一次 (limit_up_open_times > 0) / 总涨停数.
 * 注: 当日入选 zt_pool 的票 = 当日有过涨停 — 炸过仍属涨停统计, 这个比率就是
 * "板块今天涨停后开板比例". 高 = 主力出货 / 板块情绪松动.
 */
export function computeFailureRate(rows: LimitUpStockRow[]): number {
  if (!rows || rows.length === 0) return 0;
  let failed = 0;
  for (const r of rows) {
    const f = Number(r.limit_up_open_times ?? 0);
    if (Number.isFinite(f) && f > 0) failed += 1;
  }
  return Math.min(1, failed / rows.length);
}

/** 当日最高连板数 */
export function computeConsecutiveMax(rows: LimitUpStockRow[]): number {
  return maxOr0((rows || []).map(r => Number(r.continuous_days || 0)));
}

/** 前 3 只代表股 (按连板从高到低) */
export function pickTopCodes(rows: LimitUpStockRow[], n: number = 3): string[] {
  const sorted = (rows || []).slice().sort(
    (a, b) => Number(b.continuous_days || 0) - Number(a.continuous_days || 0)
  );
  return sorted.slice(0, n).map(r => String(r.stock_code));
}

/**
 * Composite score (weighted sum, 放大到约 [-5, +5]):
 *
 *   lim_up_norm = min(lim_up_count / 5, 1)
 *   max_norm    = min(consecutive_max / 5, 1)
 *   raw         = lim_up_norm * 0.3 + max_norm * 0.3 + seal_rate * 0.2
 *               - lim_up_failure_rate * 0.1 + (momentum_zscore || 0) * 0.1
 *   score       = raw * 10
 *
 * 理论范围: 不含 momentum [-1, +9]; 含 momentum z 一般 [-2, +12], 极端 z=5 时 +13.
 * 实战大多落 [-1, +5], > +2 算 leader, < -1 算 weak.
 */
export function computeCompositeScore(input: {
  lim_up_count: number;
  consecutive_max: number;
  seal_rate: number;
  lim_up_failure_rate: number;
  industry_momentum_30d: number | null;
}): number {
  const limUpNorm = Math.min(Math.max(input.lim_up_count, 0) / 5, 1);
  const maxNorm = Math.min(Math.max(input.consecutive_max, 0) / 5, 1);
  const seal = Math.min(Math.max(input.seal_rate, 0), 1);
  const fail = Math.min(Math.max(input.lim_up_failure_rate, 0), 1);
  const mom = Number.isFinite(input.industry_momentum_30d as number)
    ? Number(input.industry_momentum_30d)
    : 0;
  const raw = limUpNorm * 0.3 + maxNorm * 0.3 + seal * 0.2 - fail * 0.1 + mom * 0.1;
  return Math.round(raw * 10 * 10000) / 10000;
}

/**
 * 给定一组 (industry, avg_30d_pct), 算每个 industry 的 z-score (相对全市场).
 * 返回 Map<industry, z-score>; 数据不足 (< 3 industries) → 空 map (caller 应 null).
 */
export function computeIndustryMomentumZScores(
  industryAvgPct: Map<string, number>
): Map<string, number> {
  const out = new Map<string, number>();
  if (!industryAvgPct || industryAvgPct.size < 3) return out;
  const values = Array.from(industryAvgPct.values()).filter(v => Number.isFinite(v));
  if (values.length < 3) return out;
  const m = meanFinite(values);
  const s = stdevFinite(values);
  if (!(s > 0)) return out; // 全相同, z = 0 没意义
  for (const [industry, pct] of industryAvgPct) {
    if (!Number.isFinite(pct)) continue;
    const z = (pct - m) / s;
    out.set(industry, Math.round(z * 10000) / 10000);
  }
  return out;
}

/**
 * 给定一行业的当日涨停 rows + 30 日 z-score, 算 IndustrySentimentResult.
 * 不依赖 DataSource — 纯函数, 单测覆盖.
 */
export function aggregateOneIndustry(
  tradeDate: string,
  industry: string,
  rows: LimitUpStockRow[],
  momentum30dZ: number | null
): IndustrySentimentResult {
  const lim_up_count = rows.length;
  const consecutive_max = computeConsecutiveMax(rows);
  const seal_rate = computeSealRate(rows);
  const lim_up_failure_rate = computeFailureRate(rows);
  const composite_score = computeCompositeScore({
    lim_up_count,
    consecutive_max,
    seal_rate,
    lim_up_failure_rate,
    industry_momentum_30d: momentum30dZ,
  });
  return {
    trade_date: tradeDate,
    industry,
    lim_up_count,
    consecutive_max,
    seal_rate: Math.round(seal_rate * 10000) / 10000,
    lim_up_failure_rate: Math.round(lim_up_failure_rate * 10000) / 10000,
    industry_momentum_30d: momentum30dZ,
    composite_score,
    constituent_count: lim_up_count,
    top_codes: pickTopCodes(rows, 3),
    raw_payload: {
      sample_stocks: rows.slice(0, 5).map(r => ({
        stock_code: r.stock_code,
        stock_name: r.stock_name,
        continuous_days: r.continuous_days,
        limit_up_open_times: r.limit_up_open_times,
        is_one_word_board: r.is_one_word_board,
      })),
    },
  };
}

/**
 * 给定 composite_score, 判定 'leader' / 'weak' / 'neutral'.
 * 推荐 service 消费此函数对当前推荐的票做加权 / skip 决策.
 */
export function classifyIndustry(composite_score: number): LeaderClassification {
  if (Number.isFinite(composite_score)) {
    if (composite_score > 2) return 'leader';
    if (composite_score < -1) return 'weak';
  }
  return 'neutral';
}

/**
 * 按 industry 分组 LimitUpStockRow 数组. industry=null/empty 的 row 归 '__UNKNOWN__' bucket,
 * caller 决定是否 skip (生产路径 skip; 单测路径关心 unclassified 行为).
 */
export function groupByIndustry(rows: LimitUpStockRow[]): Map<string, LimitUpStockRow[]> {
  const out = new Map<string, LimitUpStockRow[]>();
  for (const r of rows || []) {
    const ind = (r.industry || '').trim() || '__UNKNOWN__';
    if (!out.has(ind)) out.set(ind, []);
    out.get(ind)!.push(r);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Production DataSource (lazy require — 避免顶层 import 重量级 model)
// ---------------------------------------------------------------------------

class DefaultIndustrySentimentDataSource implements IndustrySentimentDataSource {
  async listLimitUpStocks(tradeDate: string): Promise<LimitUpStockRow[]> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { LimitUpStock } = require('../models/LimitUpStock');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Stock } = require('../models/Stock');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Op } = require('sequelize');
      // LimitUpStock 自带 industry 列 (limit_up sync 已写); 但部分老数据可能 null,
      // 用 stocks 表里的 industry 作为 fallback (用 stock_code 模糊匹配 sh.600519/sz.000001).
      const luRows: any[] = await LimitUpStock.findAll({
        attributes: [
          'stock_code',
          'stock_name',
          'industry',
          'continuous_days',
          'limit_up_open_times',
          'is_one_word_board',
        ],
        where: { trade_date: tradeDate },
        raw: true,
      });
      if (!luRows || luRows.length === 0) return [];
      // Fallback: 收集 industry 为空的 stock_code, 单独查 stocks 补
      const needsLookup: string[] = [];
      for (const r of luRows) {
        if (!r.industry) needsLookup.push(String(r.stock_code));
      }
      const lookupMap = new Map<string, string>();
      if (needsLookup.length > 0) {
        const patterns = needsLookup.map(c => `%${c}`);
        const stockRows: any[] = await Stock.findAll({
          attributes: ['symbol', 'industry'],
          where: { symbol: { [Op.or]: patterns.map((p: string) => ({ [Op.like]: p })) } },
          raw: true,
        });
        for (const s of stockRows || []) {
          const m = String(s.symbol || '').match(/(\d{6})/);
          if (m && s.industry) lookupMap.set(m[1], String(s.industry));
        }
      }
      return luRows.map((r: any) => ({
        stock_code: String(r.stock_code),
        stock_name: r.stock_name ? String(r.stock_name) : null,
        industry: r.industry
          ? String(r.industry)
          : lookupMap.get(String(r.stock_code)) || null,
        continuous_days: Number(r.continuous_days || 1),
        limit_up_open_times:
          r.limit_up_open_times == null ? 0 : Number(r.limit_up_open_times),
        is_one_word_board: r.is_one_word_board === true,
      }));
    } catch (e: any) {
      logger.warn(`[IndustrySentimentAggregator] listLimitUpStocks failed: ${e?.message || e}`);
      return [];
    }
  }

  async listRecent30DayBars(tradeDate: string): Promise<
    Array<{ stock_id: number; industry: string | null; close30d_pct: number }>
  > {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const sequelizeModule = require('../config/database');
      const sequelize = sequelizeModule.default || sequelizeModule.sequelize;
      // 取 trade_date 前 31 个交易日 (近似为日历 45 天) 的每股最早 + 最晚 close,
      // 算累计涨幅 (close_end - close_start) / close_start, 再按 stocks.industry GROUP BY
      // → SQL 一次完成, 避免 N 次 query.
      const cutoff = new Date(tradeDate + 'T00:00:00');
      cutoff.setDate(cutoff.getDate() - 45);
      const cutoffStr = cutoff.toISOString().slice(0, 10);
      const sql = `
        WITH window_bars AS (
          SELECT db.stock_id, db.time, db.close,
                 ROW_NUMBER() OVER (PARTITION BY db.stock_id ORDER BY db.time ASC) AS asc_rn,
                 ROW_NUMBER() OVER (PARTITION BY db.stock_id ORDER BY db.time DESC) AS desc_rn
          FROM daily_bars db
          WHERE db.time >= :cutoffDate AND db.time <= :tradeDate
        ),
        bounds AS (
          SELECT stock_id,
                 MAX(CASE WHEN asc_rn = 1 THEN close END) AS start_close,
                 MAX(CASE WHEN desc_rn = 1 THEN close END) AS end_close
          FROM window_bars GROUP BY stock_id
        )
        SELECT b.stock_id,
               s.industry,
               CASE WHEN b.start_close > 0 THEN (b.end_close - b.start_close) / b.start_close * 100
                    ELSE NULL END AS close30d_pct
        FROM bounds b
        JOIN stocks s ON s.id = b.stock_id
        WHERE b.start_close IS NOT NULL AND b.end_close IS NOT NULL AND b.start_close > 0;
      `;
      const [rows] = await sequelize.query(sql, {
        replacements: { cutoffDate: cutoffStr, tradeDate },
      });
      return (rows as any[]).map((r: any) => ({
        stock_id: Number(r.stock_id),
        industry: r.industry ? String(r.industry) : null,
        close30d_pct: Number(r.close30d_pct),
      }));
    } catch (e: any) {
      logger.warn(`[IndustrySentimentAggregator] listRecent30DayBars failed: ${e?.message || e}`);
      return [];
    }
  }

  async upsertSentiment(result: IndustrySentimentResult): Promise<void> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { IndustrySentimentIndex } = require('../models/IndustrySentimentIndex');
      await IndustrySentimentIndex.upsert({
        trade_date: result.trade_date,
        industry: result.industry,
        lim_up_count: result.lim_up_count,
        consecutive_max: result.consecutive_max,
        seal_rate: result.seal_rate,
        lim_up_failure_rate: result.lim_up_failure_rate,
        industry_momentum_30d: result.industry_momentum_30d,
        composite_score: result.composite_score,
        constituent_count: result.constituent_count,
        top_codes: result.top_codes,
        raw_payload: result.raw_payload,
      });
    } catch (e: any) {
      logger.warn(
        `[IndustrySentimentAggregator] upsert failed industry=${result.industry}: ${e?.message || e}`
      );
      throw e;
    }
  }
}

export const DEFAULT_INDUSTRY_SENTIMENT_DATA_SOURCE: IndustrySentimentDataSource =
  new DefaultIndustrySentimentDataSource();

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface AggregatorRunOptions {
  /** 测试 — 覆盖 now / tradeDate 决策 */
  now?: Date;
  /** 测试 — 显式指定 tradeDate (跳过 now 自动推算) */
  trade_date?: string;
  /** 测试 / CLI — 不写库 (仅返结果) */
  dry_run?: boolean;
}

export interface IndustrySentimentAggregatorDeps {
  dataSource?: IndustrySentimentDataSource;
}

export class IndustrySentimentAggregator {
  private readonly ds: IndustrySentimentDataSource;

  constructor(deps: IndustrySentimentAggregatorDeps = {}) {
    this.ds = deps.dataSource ?? DEFAULT_INDUSTRY_SENTIMENT_DATA_SOURCE;
  }

  /** 主入口. fail-OPEN — 永不 throw, 整次失败也返 ok=false + errors[]. */
  async runOnce(options: AggregatorRunOptions = {}): Promise<AggregatorRunResult> {
    const dryRun = options.dry_run === true;
    const tradeDate = options.trade_date || this.resolveTradeDate(options.now || new Date());
    const result: AggregatorRunResult = {
      ok: true,
      trade_date: tradeDate,
      industries_scanned: 0,
      industries_written: 0,
      errors: [],
    };

    // Step 1: 拉今日涨停股
    let luRows: LimitUpStockRow[] = [];
    try {
      luRows = await this.ds.listLimitUpStocks(tradeDate);
    } catch (e: any) {
      result.errors.push({ where: 'listLimitUpStocks', reason: e?.message || String(e) });
      result.ok = false;
      return result;
    }

    if (luRows.length === 0) {
      logger.info(`[IndustrySentimentAggregator] trade_date=${tradeDate} no limit_up_stocks rows, nothing to aggregate`);
      return result;
    }

    // Step 2: 拉 30 日 daily_bars 算每个 industry 的均涨幅 → z-score
    let zScores = new Map<string, number>();
    try {
      const barRows = await this.ds.listRecent30DayBars(tradeDate);
      const byIndustry = new Map<string, number[]>();
      for (const b of barRows) {
        if (!b.industry) continue;
        if (!Number.isFinite(b.close30d_pct)) continue;
        if (!byIndustry.has(b.industry)) byIndustry.set(b.industry, []);
        byIndustry.get(b.industry)!.push(b.close30d_pct);
      }
      const industryAvg = new Map<string, number>();
      for (const [ind, arr] of byIndustry) {
        if (arr.length === 0) continue;
        industryAvg.set(ind, meanFinite(arr));
      }
      zScores = computeIndustryMomentumZScores(industryAvg);
    } catch (e: any) {
      result.errors.push({ where: 'listRecent30DayBars', reason: e?.message || String(e) });
      logger.warn(
        `[IndustrySentimentAggregator] momentum z-score load failed; continuing with null momentum: ${e?.message || e}`
      );
    }

    // Step 3: group by industry → aggregate
    const grouped = groupByIndustry(luRows);
    grouped.delete('__UNKNOWN__'); // 未知 industry 不写库
    result.industries_scanned = grouped.size;

    for (const [industry, rows] of grouped) {
      try {
        const z = zScores.has(industry) ? zScores.get(industry)! : null;
        const aggregated = aggregateOneIndustry(tradeDate, industry, rows, z);
        if (!dryRun) {
          await this.ds.upsertSentiment(aggregated);
        }
        result.industries_written += 1;
      } catch (e: any) {
        result.errors.push({
          where: `industry:${industry}`,
          reason: e?.message || String(e),
        });
        // 单 industry 失败不阻塞其它
        logger.warn(
          `[IndustrySentimentAggregator] industry=${industry} failed: ${e?.message || e}`
        );
      }
    }

    if (result.errors.length > 0) result.ok = false;
    return result;
  }

  /** 给定 now (Asia/Shanghai), 取 YYYY-MM-DD. 16:00 cron 触发时 now = 当天. */
  private resolveTradeDate(now: Date): string {
    try {
      const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
      const parts = fmt.formatToParts(now);
      const y = parts.find(p => p.type === 'year')?.value;
      const m = parts.find(p => p.type === 'month')?.value;
      const d = parts.find(p => p.type === 'day')?.value;
      if (y && m && d) return `${y}-${m}-${d}`;
    } catch {
      // ignore
    }
    return now.toISOString().slice(0, 10);
  }
}

export const industrySentimentAggregator = new IndustrySentimentAggregator();
