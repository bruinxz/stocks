import { Op, literal, QueryTypes } from 'sequelize';
import { DailyBar } from '../../models/DailyBar';
import { Stock } from '../../models/Stock';
import { FavoriteStock } from '../../models/FavoriteStock';
import { StockFundamentalFactor } from '../../models/StockFundamentalFactor';
import { StockMoneyFlowFactor } from '../../models/StockMoneyFlowFactor';
import { StockValuationFactor } from '../../models/StockValuationFactor';
import { normalizeSymbol } from '../../utils/stockSymbol';
import { logger } from '../../utils/logger';
import { TushareClient } from '../sources/TushareClient';
import { EastMoneyClient } from '../sources/EastMoneyClient';
import sequelize from '../../config/database';

type FactorScope = 'favorites' | 'market' | 'custom';
type FactorProviderName = 'auto' | 'local_derived' | 'tushare' | 'eastmoney';

function dateOnly(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

function toNumber(value: any, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value: number, precision = 4): number {
  const factor = 10 ** precision;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

function daysBetween(from?: string | null, to?: string | null): number | null {
  if (!from || !to) return null;
  const start = new Date(`${String(from).slice(0, 10)}T00:00:00+08:00`);
  const end = new Date(`${String(to).slice(0, 10)}T00:00:00+08:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return Math.round((end.getTime() - start.getTime()) / 86400000);
}

function isRealFactorSource(source: string): boolean {
  const normalized = String(source || '').trim().toLowerCase();
  if (!normalized) return false;
  return ![
    'local',
    'local_derived',
    'derived',
    'fallback',
    'mock',
    'unknown',
    'n/a',
  ].includes(normalized);
}

function percentileRank(values: number[], value: number): number | undefined {
  const filtered = values.filter(item => Number.isFinite(item) && item > 0).sort((a, b) => a - b);
  if (!filtered.length || !Number.isFinite(value) || value <= 0) return undefined;
  const lowerOrEqual = filtered.filter(item => item <= value).length;
  return round((lowerOrEqual / filtered.length) * 100, 4);
}

type FactorCoverageRow = {
  count: string | number;
  source_breakdown: Record<string, number> | string | null;
  latest_factor_date: string | null;
};

interface FactorSyncOptions {
  scope?: FactorScope;
  symbols?: string[];
  limit?: number;
  as_of?: string;
  user_id?: number;
  provider?: FactorProviderName;
  prefer_real_provider?: boolean;
  skip_if_coverage_rate_gte?: number;
  skip_if_real_provider_rate_gte?: number;
}

export interface FactorCoverage {
  as_of: string;
  latest_trade_date: string | null;
  latest_factor_date?: string | null;
  latest_landed_factor_date?: string | null;
  effective_factor_date?: string | null;
  factor_lag_days?: number | null;
  coverage_status?: 'real_ready' | 'derived_ready' | 'limited' | 'missing';
  universe_stock_count: number;
  coverage: {
    valuation: number;
    money_flow: number;
    fundamental: number;
  };
  coverage_rate: {
    valuation: number;
    money_flow: number;
    fundamental: number;
  };
  latest_counts: {
    valuation: number;
    money_flow: number;
    fundamental: number;
  };
  samples: Array<{
    symbol: string;
    name: string;
    industry?: string | null;
    valuation_score?: number | null;
    money_flow_score?: number | null;
    quality_score?: number | null;
    factor_date?: string | null;
  }>;
  source_breakdown: {
    valuation: Record<string, number>;
    money_flow: Record<string, number>;
    fundamental: Record<string, number>;
  };
  source_quality?: {
    total_source_records: number;
    real_provider_records: number;
    derived_records: number;
    real_provider_rate: number;
    primary_source: string | null;
    provider_status?: Record<string, any>;
  };
  next_actions: string[];
}

export class StockFactorService {
  private tushareClient = new TushareClient();
  private eastMoneyClient = new EastMoneyClient(undefined, Number(process.env.EASTMONEY_FACTOR_TIMEOUT_MS || 12000));

  async runProviderSmokeTest(options: { provider?: FactorProviderName; symbol?: string; as_of?: string } = {}) {
    const provider = options.provider || 'auto';
    const plan = this.getProviderPlan({
      provider,
      prefer_real_provider: true,
    });
    const symbol = normalizeSymbol(options.symbol || 'sh.600000');

    if (plan.providers.includes('tushare') && plan.provider_status.tushare.enabled) {
      try {
        const result = await this.tushareClient.smokeTest({ symbol, as_of: options.as_of });
        return {
          provider: 'tushare',
          requested_provider: provider,
          symbol,
          ok: result.snapshot_found || result.checks.daily_basic || result.checks.moneyflow || result.checks.fina_indicator,
          plan,
          ...result,
        };
      } catch (error: any) {
        return {
          provider: 'tushare',
          requested_provider: provider,
          symbol,
          ok: false,
          enabled: true,
          has_token: Boolean(process.env.TUSHARE_TOKEN || process.env.TUSHARE_PRO_TOKEN),
          plan,
          error: error?.message || String(error),
          conclusion: `Tushare 烟测失败：${error?.message || error}`,
        };
      }
    }

    if (plan.providers.includes('eastmoney')) {
      try {
        const snapshots = await this.eastMoneyClient.getQuoteSnapshots([symbol], {
          preferBatch: true,
          chunkSize: Number(process.env.EASTMONEY_FACTOR_BATCH_SIZE || 80),
        });
        const snapshot =
          snapshots.find(item => normalizeSymbol(item.symbol) === symbol) ||
          (await this.eastMoneyClient.getQuoteSnapshot(symbol));
        return {
          provider: 'eastmoney',
          requested_provider: provider,
          symbol,
          ok: Boolean(snapshot?.current_price || snapshot?.pe_ttm || snapshot?.pb),
          enabled: true,
          snapshot,
          plan,
          checks: {
            quote: Boolean(snapshot?.current_price),
            valuation: Boolean(snapshot?.pe_ttm || snapshot?.pb || snapshot?.total_market_cap),
            money_flow: Boolean(snapshot?.turnover_rate || snapshot?.main_net_inflow),
          },
          conclusion: snapshot
            ? `东方财富免费源烟测成功，${symbol} 返回价格/估值/换手率快照，可作为 Tushare 未配置时的真实因子增强。`
            : `东方财富免费源未返回 ${symbol} 的有效快照。`,
        };
      } catch (error: any) {
        return {
          provider: 'eastmoney',
          requested_provider: provider,
          symbol,
          ok: false,
          enabled: true,
          plan,
          error: error?.message || String(error),
          conclusion: `东方财富免费源烟测失败：${error?.message || error}`,
        };
      }
    }

    return {
      provider: 'local_derived',
      requested_provider: provider,
      symbol,
      ok: false,
      enabled: false,
      plan,
      conclusion: '当前未启用 Tushare；系统将继续使用 local_derived 免费因子兜底。',
    };
  }

  private getProviderPlan(options: FactorSyncOptions = {}) {
    const requestedProvider = options.provider || 'auto';
    const tushareEnabled = this.tushareClient.isEnabled();
    const preferRealProvider = options.prefer_real_provider !== false;
    const providers: FactorProviderName[] = [];
    if (requestedProvider === 'tushare') {
      providers.push('tushare');
    } else if (requestedProvider === 'eastmoney') {
      providers.push('eastmoney');
    } else if (requestedProvider === 'local_derived') {
      providers.push('local_derived');
    } else {
      if (preferRealProvider && tushareEnabled) providers.push('tushare');
      if (preferRealProvider) providers.push('eastmoney');
      providers.push('local_derived');
    }
    return {
      requested_provider: requestedProvider,
      providers: [...new Set(providers)],
      provider_status: {
        tushare: {
          enabled: tushareEnabled,
          has_token: Boolean(process.env.TUSHARE_TOKEN || process.env.TUSHARE_PRO_TOKEN),
          required_env: ['TUSHARE_ENABLED=true', 'TUSHARE_TOKEN 或 TUSHARE_PRO_TOKEN'],
          note: tushareEnabled
            ? 'Tushare 已启用，可用于真实 daily_basic / moneyflow / fina_indicator 增强。'
            : 'Tushare 未启用，当前使用 local_derived 免费因子兜底。',
        },
        eastmoney: {
          enabled: true,
          has_token: false,
          required_env: [],
          note:
            '东方财富免费实时源已启用，用于补充价格、PE/PB、市值、换手率与弱资金流代理；无需 token，但需控制并发。',
        },
        local_derived: {
          enabled: true,
          note: '使用 daily_bars/stocks 派生估值、量价资金流、质量代理分。',
        },
      },
    };
  }

  private buildMarketOrder(): any[] {
    return [
      [
        literal(`CASE
          WHEN "Stock"."symbol" LIKE 'sh.60%' THEN 1
          WHEN "Stock"."symbol" LIKE 'sz.00%' THEN 2
          WHEN "Stock"."symbol" LIKE 'sz.30%' THEN 3
          WHEN "Stock"."symbol" LIKE 'sh.68%' THEN 4
          WHEN "Stock"."symbol" LIKE 'bj.%' THEN 5
          ELSE 9
        END`),
        'ASC',
      ],
      ['symbol', 'ASC'],
    ] as any;
  }

  private async resolveStocks(options: FactorSyncOptions = {}): Promise<Stock[]> {
    const limit = Math.min(Math.max(Number(options.limit || 120), 1), 1000);
    if (options.symbols?.length) {
      const symbols = [...new Set(options.symbols.map(normalizeSymbol).filter(Boolean))];
      return Stock.findAll({
        where: { symbol: { [Op.in]: symbols } },
        order: [['symbol', 'ASC']],
        limit,
      });
    }

    if (options.scope === 'favorites' && options.user_id) {
      const favorites = await FavoriteStock.findAll({
        where: { user_id: options.user_id },
        include: [{ model: Stock }],
        order: [['sort_order', 'DESC']],
        limit,
      });
      return favorites.map(item => item.stock).filter(Boolean) as Stock[];
    }

    // 当前先以数据库内已上市 A 股作为因子落盘范围；也支持 scope=favorites 取用户收藏。
    // 冷启动时 total_market_cap/change_percent 往往为空，不能让 BJ/新股或最后更新时间主导样本。
    // 固定按主板/创业板/科创/北交所顺序取样，保证开盘预检与日扫候选覆盖主流可交易池。
    return Stock.findAll({
      where: { is_listed: true, type: { [Op.or]: ['stock', null as any] } },
      order: this.buildMarketOrder(),
      limit,
    });
  }

  private async getBarsByStock(stocks: Stock[], as_of?: string) {
    if (!stocks.length) return new Map<number, DailyBar[]>();
    const stockIds = stocks.map(stock => stock.id);
    const endDate = as_of ? new Date(as_of) : new Date();
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - 420);
    const bars = await DailyBar.findAll({
      where: {
        stock_id: { [Op.in]: stockIds },
        time: { [Op.between]: [startDate, endDate] },
      },
      order: [
        ['stock_id', 'ASC'],
        ['time', 'ASC'],
      ],
    });
    const byStock = new Map<number, DailyBar[]>();
    for (const bar of bars) {
      const list = byStock.get(bar.stock_id) || [];
      list.push(bar);
      byStock.set(bar.stock_id, list);
    }
    return byStock;
  }

  private async getEffectiveFactorCoverageRows(options: {
    table: string;
    stock_ids: number[];
    latest_trade_date?: string | null;
    max_lag_days?: number;
  }): Promise<FactorCoverageRow> {
    if (!options.stock_ids.length) {
      return { count: 0, source_breakdown: {}, latest_factor_date: null };
    }
    const maxLagDays = Math.max(Number(options.max_lag_days ?? 7), 0);
    const freshnessPredicate = options.latest_trade_date
      ? `AND factor_date >= (:latest_trade_date::date - (:max_lag_days::int * interval '1 day'))`
      : '';
    const [row] = await sequelize.query<FactorCoverageRow>(
      `
      WITH ranked AS (
        SELECT stock_id, source, factor_date,
               ROW_NUMBER() OVER (
                 PARTITION BY stock_id
                 ORDER BY factor_date DESC,
                          CASE
                            WHEN source = 'tushare' THEN 1
                            WHEN source = 'eastmoney' THEN 2
                            WHEN source = 'akshare' THEN 3
                            WHEN source = 'local_derived' THEN 9
                            ELSE 6
                          END ASC,
                          updated_at DESC
               ) AS rn
        FROM ${options.table}
        WHERE stock_id IN (:stock_ids)
          ${freshnessPredicate}
      )
      SELECT COALESCE(SUM(source_count), 0)::int AS count,
             COALESCE(jsonb_object_agg(source, source_count), '{}'::jsonb) AS source_breakdown,
             MAX(latest_factor_date)::text AS latest_factor_date
      FROM (
        SELECT source, COUNT(*)::int AS source_count, MAX(factor_date) AS latest_factor_date
        FROM ranked
        WHERE rn = 1
        GROUP BY source
      ) grouped
      `,
      {
        replacements: {
          stock_ids: options.stock_ids,
          latest_trade_date: options.latest_trade_date || null,
          max_lag_days: maxLagDays,
        },
        type: QueryTypes.SELECT,
      }
    );
    return row || { count: 0, source_breakdown: {}, latest_factor_date: null };
  }

  private parseSourceBreakdown(value: FactorCoverageRow['source_breakdown']): Record<string, number> {
    if (!value) return {};
    const parsed = typeof value === 'string' ? JSON.parse(value || '{}') : value;
    return Object.entries(parsed || {}).reduce<Record<string, number>>((acc, [source, count]) => {
      acc[source] = toNumber(count);
      return acc;
    }, {});
  }

  private scoreValuation(latest: DailyBar, pePercentile?: number, pbPercentile?: number): number {
    const pe = toNumber(latest.pe);
    const pb = toNumber(latest.pb);
    const peScore = pe > 0 ? clamp(100 - (pePercentile ?? Math.min(pe * 2, 95))) : 50;
    const pbScore = pb > 0 ? clamp(100 - (pbPercentile ?? Math.min(pb * 15, 95))) : 50;
    const cap = toNumber(latest.market_cap);
    const capScore = cap > 0 ? clamp(Math.log10(cap) * 8 - 45, 20, 88) : 55;
    return round(peScore * 0.45 + pbScore * 0.35 + capScore * 0.2, 4);
  }

  private scoreMoneyFlow(bars: DailyBar[]): {
    score: number;
    momentum_5d: number;
    momentum_20d: number;
    volume_ratio: number;
  } {
    const latest = bars[bars.length - 1];
    const close = toNumber(latest?.close);
    const close5 = bars.length > 5 ? toNumber(bars[bars.length - 6]?.close) : close;
    const close20 = bars.length > 20 ? toNumber(bars[bars.length - 21]?.close) : close;
    const momentum5 = close5 > 0 ? ((close - close5) / close5) * 100 : 0;
    const momentum20 = close20 > 0 ? ((close - close20) / close20) * 100 : 0;
    const recentVolume = bars.slice(-5).reduce((sum, bar) => sum + toNumber(bar.volume), 0) / 5;
    const baseVolume =
      bars.slice(-30).reduce((sum, bar) => sum + toNumber(bar.volume), 0) /
      Math.max(1, Math.min(30, bars.length));
    const volumeRatio = baseVolume > 0 ? recentVolume / baseVolume : 1;
    const score = clamp(50 + momentum5 * 1.6 + momentum20 * 0.6 + (volumeRatio - 1) * 18, 0, 100);
    return {
      score: round(score, 4),
      momentum_5d: round(momentum5, 4),
      momentum_20d: round(momentum20, 4),
      volume_ratio: round(volumeRatio, 4),
    };
  }

  private scoreFundamental(stock: Stock, latest: DailyBar): number {
    const pe = toNumber(latest.pe || stock.pe_dynamic);
    const pb = toNumber(latest.pb || stock.pb);
    const turnover = toNumber(latest.turnover_rate || stock.turnover_rate);
    const valuationComponent = pe > 0 ? clamp(80 - pe * 0.8, 15, 85) : 55;
    const pbComponent = pb > 0 ? clamp(75 - pb * 8, 15, 85) : 55;
    const liquidityComponent = clamp(45 + turnover * 5, 20, 85);
    return round(valuationComponent * 0.4 + pbComponent * 0.25 + liquidityComponent * 0.35, 4);
  }

  private scoreTushareQuality(indicator: Record<string, any>): number {
    const roe = toNumber(indicator.roe);
    const grossMargin = toNumber(indicator.gross_margin);
    const profitGrowth = toNumber(indicator.net_profit_growth);
    const revenueGrowth = toNumber(indicator.revenue_growth);
    const debtRatio = toNumber(indicator.debt_asset_ratio);
    return round(
      clamp(
        45 +
          Math.min(24, Math.max(-18, roe * 1.1)) +
          Math.min(14, Math.max(-10, grossMargin * 0.16)) +
          Math.min(12, Math.max(-12, profitGrowth * 0.12)) +
          Math.min(8, Math.max(-8, revenueGrowth * 0.08)) -
          Math.min(18, Math.max(0, debtRatio - 55) * 0.35)
      ),
      4
    );
  }

  private scoreTushareMoneyFlow(snapshot: Record<string, any>): number {
    const dailyBasic = snapshot.daily_basic || {};
    const moneyflow = snapshot.moneyflow || {};
    const volumeRatio = toNumber(dailyBasic.volume_ratio, 1);
    const turnover = toNumber(dailyBasic.turnover_rate);
    const mainNet = toNumber(moneyflow.main_net_inflow);
    const netAmount = toNumber(moneyflow.net_mf_amount);
    return round(
      clamp(
        50 +
          (volumeRatio - 1) * 18 +
          Math.min(12, turnover * 1.4) +
          Math.max(-18, Math.min(18, mainNet / 8000)) +
          Math.max(-10, Math.min(10, netAmount / 6000))
      ),
      4
    );
  }

  private scoreEastMoneyQuality(snapshot: Record<string, any>): number {
    const roe = toNumber(snapshot.roe);
    const grossMargin = toNumber(snapshot.gross_margin);
    const pb = toNumber(snapshot.pb);
    const pe = toNumber(snapshot.pe_ttm);
    return round(
      clamp(
        50 +
          Math.min(20, Math.max(-12, roe * 1.4)) +
          Math.min(10, Math.max(-8, grossMargin * 0.12)) +
          (pb > 0 ? Math.max(-12, Math.min(10, 6 - pb * 1.8)) : 0) +
          (pe > 0 ? Math.max(-10, Math.min(8, 18 - pe * 0.28)) : 0)
      ),
      4
    );
  }

  private scoreEastMoneyMoneyFlow(snapshot: Record<string, any>): number {
    const changePercent = toNumber(snapshot.change_percent);
    const turnoverRate = toNumber(snapshot.turnover_rate);
    const turnover = toNumber(snapshot.turnover);
    const mainNet = toNumber(snapshot.main_net_inflow);
    const totalMarketCap = toNumber(snapshot.total_market_cap);
    const mainNetPct = totalMarketCap > 0 ? (mainNet / totalMarketCap) * 100 : 0;
    const turnoverBoost = turnover > 0 ? Math.min(10, Math.log10(turnover) - 6) : 0;
    return round(
      clamp(
        50 +
          Math.max(-16, Math.min(16, changePercent * 1.4)) +
          Math.min(14, turnoverRate * 1.35) +
          Math.max(-12, Math.min(12, mainNetPct * 120)) +
          turnoverBoost
      ),
      4
    );
  }

  private async syncEastMoneyFactors(stocks: Stock[], options: FactorSyncOptions = {}) {
    if (!stocks.length) {
      return {
        requested: 0,
        processed: 0,
        upserts: { valuation: 0, money_flow: 0, fundamental: 0 },
        errors: [],
      };
    }

    const snapshots = await this.eastMoneyClient
      .getQuoteSnapshots(
        stocks.map(stock => stock.symbol),
        {
          concurrency: Number(process.env.EASTMONEY_FACTOR_CONCURRENCY || 5),
          limit: stocks.length,
          chunkSize: Number(process.env.EASTMONEY_FACTOR_BATCH_SIZE || 80),
          preferBatch: process.env.EASTMONEY_FACTOR_BATCH_ENABLED !== 'false',
        }
      )
      .catch(error => {
        logger.warn(`东方财富免费因子快照读取失败，降级 local_derived: ${error?.message || error}`);
        return [] as any[];
      });
    const stockBySymbol = new Map(stocks.map(stock => [normalizeSymbol(stock.symbol), stock]));
    let processed = 0;
    let valuation = 0;
    let moneyFlow = 0;
    let fundamental = 0;
    const errors: string[] = [];

    for (const snapshot of snapshots) {
      const symbol = normalizeSymbol(snapshot.symbol);
      const stock = stockBySymbol.get(symbol);
      if (!stock) continue;
      const factorDate = options.as_of || snapshot.quote_date || new Date().toISOString().slice(0, 10);
      const pe = toNumber(snapshot.pe_ttm);
      const pb = toNumber(snapshot.pb);
      const cap = toNumber(snapshot.total_market_cap);
      const valuationScore = clamp(
        (pe > 0 ? clamp(100 - Math.min(pe * 1.85, 95)) : 50) * 0.42 +
          (pb > 0 ? clamp(100 - Math.min(pb * 14, 95)) : 50) * 0.34 +
          (cap > 0 ? clamp(Math.log10(cap) * 7 - 42, 20, 88) : 55) * 0.24
      );
      const rawPayload = {
        provider: 'eastmoney',
        source_note:
          'EastMoney free quote snapshot: price/valuation/turnover fields are real-time public data; fundamental metrics are weak proxies and should be superseded by Tushare/JQ when available.',
        snapshot,
      };

      if (pe > 0 || pb > 0 || cap > 0) {
        await StockValuationFactor.upsert({
          stock_id: stock.id,
          symbol: stock.symbol,
          name: snapshot.name || stock.name,
          factor_date: factorDate,
          pe_ttm: pe || undefined,
          pb: pb || undefined,
          total_market_cap: cap || undefined,
          circulating_market_cap: toNumber(snapshot.circulating_market_cap) || undefined,
          valuation_score: round(valuationScore, 4),
          source: 'eastmoney',
          raw_payload: rawPayload,
        } as any);
        valuation++;
      }

      if (
        snapshot.current_price !== undefined ||
        snapshot.turnover_rate !== undefined ||
        snapshot.main_net_inflow !== undefined
      ) {
        const previousClose = toNumber(snapshot.previous_close);
        const currentPrice = toNumber(snapshot.current_price);
        const changePercent = toNumber(snapshot.change_percent);
        await StockMoneyFlowFactor.upsert({
          stock_id: stock.id,
          symbol: stock.symbol,
          name: snapshot.name || stock.name,
          factor_date: factorDate,
          net_inflow_amount: toNumber(snapshot.main_net_inflow) || undefined,
          main_net_inflow: toNumber(snapshot.main_net_inflow) || undefined,
          main_net_inflow_pct:
            cap > 0 ? round((toNumber(snapshot.main_net_inflow) / cap) * 100, 4) : undefined,
          turnover_rate: toNumber(snapshot.turnover_rate) || undefined,
          momentum_5d: undefined,
          momentum_20d:
            previousClose > 0 && currentPrice > 0
              ? round(((currentPrice - previousClose) / previousClose) * 100, 4)
              : changePercent || undefined,
          money_flow_score: this.scoreEastMoneyMoneyFlow(snapshot),
          source: 'eastmoney',
          raw_payload: rawPayload,
        } as any);
        moneyFlow++;
      }

      if (snapshot.roe !== undefined || snapshot.gross_margin !== undefined || pe > 0 || pb > 0) {
        await StockFundamentalFactor.upsert({
          stock_id: stock.id,
          symbol: stock.symbol,
          name: snapshot.name || stock.name,
          factor_date: factorDate,
          report_period: factorDate.slice(0, 7),
          roe: toNumber(snapshot.roe) || undefined,
          gross_margin: toNumber(snapshot.gross_margin) || undefined,
          quality_score: this.scoreEastMoneyQuality(snapshot),
          source: 'eastmoney',
          raw_payload: rawPayload,
        } as any);
        fundamental++;
      }
      processed++;
    }

    if (!processed && stocks.length) {
      errors.push('eastmoney_no_snapshot_returned');
    }

    return {
      requested: stocks.length,
      processed,
      upserts: { valuation, money_flow: moneyFlow, fundamental },
      errors: errors.slice(0, 20),
    };
  }

  private async syncTushareFactors(stocks: Stock[], options: FactorSyncOptions = {}) {
    if (!stocks.length || !this.tushareClient.isEnabled()) {
      return {
        requested: stocks.length,
        processed: 0,
        upserts: { valuation: 0, money_flow: 0, fundamental: 0 },
        errors: this.tushareClient.isEnabled() ? [] : ['tushare_disabled'],
      };
    }

    const snapshots = await this.tushareClient
      .getFactorSnapshots(
        stocks.map(stock => stock.symbol),
        options.as_of
      )
      .catch(error => {
        logger.warn(`Tushare 因子快照读取失败，降级 local_derived: ${error?.message || error}`);
        return [] as any[];
      });
    const stockBySymbol = new Map(stocks.map(stock => [normalizeSymbol(stock.symbol), stock]));
    let processed = 0;
    let valuation = 0;
    let moneyFlow = 0;
    let fundamental = 0;
    const errors: string[] = [];

    for (const snapshot of snapshots) {
      const symbol = normalizeSymbol(snapshot.symbol);
      const stock = stockBySymbol.get(symbol);
      if (!stock) continue;
      const dailyBasic = snapshot.daily_basic || {};
      const moneyflow = snapshot.moneyflow || {};
      const indicator = snapshot.fina_indicator || {};
      const factorDate =
        dailyBasic.trade_date || moneyflow.trade_date || indicator.ann_date || options.as_of;
      if (!factorDate) continue;
      const rawPayload = {
        provider: 'tushare',
        snapshot,
        errors: snapshot.errors || [],
      };
      if (Array.isArray(snapshot.errors) && snapshot.errors.length) {
        errors.push(`${symbol}: ${snapshot.errors.join(' | ')}`.slice(0, 240));
      }

      if (dailyBasic.trade_date) {
        const pe = toNumber(dailyBasic.pe_ttm || dailyBasic.pe);
        const pb = toNumber(dailyBasic.pb);
        const valuationScore = clamp(
          (pe > 0 ? clamp(100 - Math.min(pe * 1.8, 95)) : 50) * 0.48 +
            (pb > 0 ? clamp(100 - Math.min(pb * 14, 95)) : 50) * 0.34 +
            (toNumber(dailyBasic.total_mv) > 0
              ? clamp(Math.log10(toNumber(dailyBasic.total_mv) * 10000) * 7 - 42, 20, 88)
              : 55) *
              0.18
        );
        await StockValuationFactor.upsert({
          stock_id: stock.id,
          symbol: stock.symbol,
          name: stock.name,
          factor_date: dailyBasic.trade_date,
          pe_ttm: pe || undefined,
          pb: pb || undefined,
          ps_ttm: toNumber(dailyBasic.ps_ttm || dailyBasic.ps) || undefined,
          total_market_cap: toNumber(dailyBasic.total_mv) * 10000 || undefined,
          circulating_market_cap: toNumber(dailyBasic.circ_mv) * 10000 || undefined,
          valuation_score: round(valuationScore, 4),
          source: 'tushare',
          raw_payload: rawPayload,
        } as any);
        valuation++;
      }

      if (dailyBasic.trade_date || moneyflow.trade_date) {
        await StockMoneyFlowFactor.upsert({
          stock_id: stock.id,
          symbol: stock.symbol,
          name: stock.name,
          factor_date: moneyflow.trade_date || dailyBasic.trade_date,
          net_inflow_amount: toNumber(moneyflow.net_mf_amount) || undefined,
          main_net_inflow: toNumber(moneyflow.main_net_inflow) || undefined,
          volume_ratio: toNumber(dailyBasic.volume_ratio) || undefined,
          turnover_rate: toNumber(dailyBasic.turnover_rate) || undefined,
          money_flow_score: this.scoreTushareMoneyFlow(snapshot),
          source: 'tushare',
          raw_payload: rawPayload,
        } as any);
        moneyFlow++;
      }

      if (indicator.end_date || indicator.ann_date) {
        await StockFundamentalFactor.upsert({
          stock_id: stock.id,
          symbol: stock.symbol,
          name: stock.name,
          factor_date: dailyBasic.trade_date || options.as_of || factorDate,
          report_period: indicator.end_date || indicator.ann_date,
          roe: toNumber(indicator.roe) || undefined,
          gross_margin: toNumber(indicator.gross_margin) || undefined,
          net_profit_growth: toNumber(indicator.net_profit_growth) || undefined,
          revenue_growth: toNumber(indicator.revenue_growth) || undefined,
          debt_asset_ratio: toNumber(indicator.debt_asset_ratio) || undefined,
          eps: toNumber(indicator.eps) || undefined,
          book_value_per_share: toNumber(indicator.book_value_per_share) || undefined,
          quality_score: this.scoreTushareQuality(indicator),
          source: 'tushare',
          raw_payload: rawPayload,
        } as any);
        fundamental++;
      }
      processed++;
    }

    return {
      requested: stocks.length,
      processed,
      upserts: { valuation, money_flow: moneyFlow, fundamental },
      errors: errors.slice(0, 20),
    };
  }

  async syncDerivedFactors(options: FactorSyncOptions = {}) {
    const startedAt = Date.now();
    const stocks = await this.resolveStocks(options);
    const providerPlan = this.getProviderPlan(options);
    const skipThreshold = Number(options.skip_if_coverage_rate_gte || 0);
    const skipRealProviderThreshold = Number(options.skip_if_real_provider_rate_gte ?? 65);
    if ((skipThreshold > 0 || skipRealProviderThreshold > 0) && stocks.length > 0) {
      const coverage = await this.getCoverage({
        ...options,
        limit: stocks.length,
        skip_if_coverage_rate_gte: undefined,
        skip_if_real_provider_rate_gte: undefined,
      });
      const minCoverageRate = Math.min(
        Number(coverage.coverage_rate.valuation || 0),
        Number(coverage.coverage_rate.money_flow || 0),
        Number(coverage.coverage_rate.fundamental || 0)
      );
      const realProviderRate = Number(coverage.source_quality?.real_provider_rate || 0);
      const requiresRealProvider = providerPlan.providers.some(provider =>
        ['tushare', 'eastmoney'].includes(provider)
      );
      const shouldSkip =
        coverage.latest_trade_date &&
        minCoverageRate >= skipThreshold &&
        (!requiresRealProvider ||
          skipRealProviderThreshold <= 0 ||
          realProviderRate >= skipRealProviderThreshold);
      if (shouldSkip) {
        return {
          generated_at: new Date().toISOString(),
          scope: options.scope || (options.symbols?.length ? 'custom' : 'market'),
          skipped: true,
          skip_reason: `因子覆盖率 ${round(
            minCoverageRate,
            2
          )}% 已达到阈值 ${skipThreshold}%${
            requiresRealProvider
              ? `，真实源占比 ${round(realProviderRate, 2)}% 已达到阈值 ${skipRealProviderThreshold}%`
              : ''
          }，本轮跳过重复落盘。`,
          provider_plan: providerPlan,
          requested_stock_count: stocks.length,
          processed_stock_count: 0,
          skipped_stock_count: stocks.length,
          upserts: { valuation: 0, money_flow: 0, fundamental: 0 },
          duration_ms: Date.now() - startedAt,
          coverage_snapshot: {
            latest_trade_date: coverage.latest_trade_date,
            coverage_rate: coverage.coverage_rate,
            source_breakdown: coverage.source_breakdown,
            real_provider_rate: coverage.source_quality?.real_provider_rate,
          },
          message: '因子覆盖率已达标，跳过重复同步以缩短开盘扫描耗时。',
        };
      }
    }
    const providerResults: Record<string, any> = {};
    if (providerPlan.providers.includes('tushare')) {
      providerResults.tushare = await this.syncTushareFactors(stocks, options);
    }
    if (providerPlan.providers.includes('eastmoney')) {
      providerResults.eastmoney = await this.syncEastMoneyFactors(stocks, options);
    }
    let processed = 0;
    let skipped = 0;
    let valuationUpserts = 0;
    let moneyFlowUpserts = 0;
    let fundamentalUpserts = 0;

    if (providerPlan.providers.includes('local_derived')) {
      const barsByStock = await this.getBarsByStock(stocks, options.as_of);
      for (const stock of stocks) {
        const bars = barsByStock.get(stock.id) || [];
        if (!bars.length) {
          skipped++;
          continue;
        }
        const latest = bars[bars.length - 1];
        const factorDate = dateOnly(latest.time);
        const peValues = bars.map(bar => toNumber(bar.pe)).filter(value => value > 0);
        const pbValues = bars.map(bar => toNumber(bar.pb)).filter(value => value > 0);
        const pe = toNumber(latest.pe || stock.pe_dynamic);
        const pb = toNumber(latest.pb || stock.pb);
        const pePercentile = percentileRank(peValues, pe);
        const pbPercentile = percentileRank(pbValues, pb);
        const valuationScore = this.scoreValuation(latest, pePercentile, pbPercentile);
        const moneyFlow = this.scoreMoneyFlow(bars);
        const qualityScore = this.scoreFundamental(stock, latest);
        const rawPayload = {
          source_note:
            'local_derived uses persisted daily_bars/stocks as a free-data baseline; Tushare/JQ/Gm factor connectors can replace or enrich these rows later.',
          bar_count: bars.length,
          latest_bar: {
            close: toNumber(latest.close),
            turnover: toNumber(latest.turnover),
            turnover_rate: toNumber(latest.turnover_rate),
            change_percent: toNumber(latest.change_percent),
          },
        };

        await StockValuationFactor.upsert({
          stock_id: stock.id,
          symbol: stock.symbol,
          name: stock.name,
          factor_date: factorDate,
          pe_ttm: pe || undefined,
          pb: pb || undefined,
          ps_ttm: toNumber(latest.ps) || undefined,
          total_market_cap:
            toNumber(latest.market_cap || stock.total_market_cap) ||
            (toNumber((latest as any).total_mv)
              ? toNumber((latest as any).total_mv) * 10000
              : undefined),
          circulating_market_cap: toNumber(stock.circulating_market_cap) || undefined,
          pe_percentile_250: pePercentile,
          pb_percentile_250: pbPercentile,
          valuation_score: valuationScore,
          source: 'local_derived',
          raw_payload: rawPayload,
        } as any);
        valuationUpserts++;

        await StockMoneyFlowFactor.upsert({
          stock_id: stock.id,
          symbol: stock.symbol,
          name: stock.name,
          factor_date: factorDate,
          net_inflow_amount: undefined,
          main_net_inflow: undefined,
          main_net_inflow_pct: undefined,
          volume_ratio: moneyFlow.volume_ratio,
          turnover_rate: toNumber(latest.turnover_rate || stock.turnover_rate) || undefined,
          momentum_5d: moneyFlow.momentum_5d,
          momentum_20d: moneyFlow.momentum_20d,
          money_flow_score: moneyFlow.score,
          source: 'local_derived',
          raw_payload: rawPayload,
        } as any);
        moneyFlowUpserts++;

        await StockFundamentalFactor.upsert({
          stock_id: stock.id,
          symbol: stock.symbol,
          name: stock.name,
          factor_date: factorDate,
          report_period: factorDate.slice(0, 7),
          roe: undefined,
          gross_margin: undefined,
          net_profit_growth: undefined,
          revenue_growth: undefined,
          debt_asset_ratio: undefined,
          eps: undefined,
          book_value_per_share: undefined,
          quality_score: qualityScore,
          source: 'local_derived',
          raw_payload: rawPayload,
        } as any);
        fundamentalUpserts++;
        processed++;
      }
      providerResults.local_derived = {
        requested: stocks.length,
        processed,
        skipped,
        upserts: {
          valuation: valuationUpserts,
          money_flow: moneyFlowUpserts,
          fundamental: fundamentalUpserts,
        },
      };
    }

    const durationMs = Date.now() - startedAt;
    logger.info(
      `因子落盘完成: processed=${processed}, skipped=${skipped}, duration=${durationMs}ms`
    );
    return {
      generated_at: new Date().toISOString(),
      scope: options.scope || (options.symbols?.length ? 'custom' : 'market'),
      provider_plan: providerPlan,
      provider_results: providerResults,
      requested_stock_count: stocks.length,
      processed_stock_count: processed,
      skipped_stock_count: skipped,
      upserts: {
        valuation: valuationUpserts,
        money_flow: moneyFlowUpserts,
        fundamental: fundamentalUpserts,
      },
      duration_ms: durationMs,
      message:
        providerPlan.providers.includes('tushare') && providerPlan.provider_status.tushare.enabled
          ? '已按 provider plan 完成因子落盘；Tushare 增强通道已启用，local_derived 仍作为兜底。'
          : providerPlan.providers.includes('eastmoney')
          ? '已按 provider plan 完成因子落盘；东方财富免费真实快照已补充价格/估值/换手率，local_derived 继续兜底。'
          : '已基于本地日线/股票快照生成免费版估值、资金流、质量因子；配置 Tushare 后可自动优先使用真实财务和资金流增强。',
    };
  }

  async getCoverage(options: FactorSyncOptions = {}): Promise<FactorCoverage> {
    const stocks = await this.resolveStocks(options);
    const stockIds = stocks.map(stock => stock.id);
    const latestBar = stockIds.length
      ? await DailyBar.findOne({
          where: { stock_id: { [Op.in]: stockIds } },
          order: [['time', 'DESC']],
        })
      : null;
    const latestTradeDate = latestBar ? dateOnly(latestBar.time) : null;
    const latestFactorDate = stockIds.length
      ? (
          await StockValuationFactor.findOne({
            where: { stock_id: { [Op.in]: stockIds } },
            order: [['factor_date', 'DESC']],
          }).catch(() => null)
        )?.factor_date || null
      : null;
    const [
      valuationCoverage,
      moneyCoverage,
      fundamentalCoverage,
    ] = await Promise.all([
      this.getEffectiveFactorCoverageRows({
        table: 'stock_valuation_factors',
        stock_ids: stockIds,
        latest_trade_date: latestTradeDate,
      }),
      this.getEffectiveFactorCoverageRows({
        table: 'stock_money_flow_factors',
        stock_ids: stockIds,
        latest_trade_date: latestTradeDate,
      }),
      this.getEffectiveFactorCoverageRows({
        table: 'stock_fundamental_factors',
        stock_ids: stockIds,
        latest_trade_date: latestTradeDate,
      }),
    ]);
    const valuationCount = toNumber(valuationCoverage.count);
    const moneyFlowCount = toNumber(moneyCoverage.count);
    const fundamentalCount = toNumber(fundamentalCoverage.count);
    const effectiveLatestFactorDates = [
      valuationCoverage.latest_factor_date,
      moneyCoverage.latest_factor_date,
      fundamentalCoverage.latest_factor_date,
    ].filter(Boolean) as string[];
    const coverageFactorDate =
      effectiveLatestFactorDates.sort((a, b) => b.localeCompare(a))[0] ||
      latestFactorDate ||
      latestTradeDate;
    const sampleWhere = stockIds.length
      ? {
          stock_id: { [Op.in]: stockIds },
          ...(coverageFactorDate ? { factor_date: { [Op.lte]: coverageFactorDate } } : {}),
        }
      : {};

    const samples = stockIds.length
      ? await StockValuationFactor.findAll({
          where: sampleWhere,
          include: [{ model: Stock, attributes: ['industry'] }],
          order: [
            ['valuation_score', 'DESC'],
            ['factor_date', 'DESC'],
          ],
          limit: 10,
        }).catch(() => [])
      : [];
    const sampleSymbols = samples.map(item => item.symbol);
    const moneyRows = await StockMoneyFlowFactor.findAll({
      where: coverageFactorDate
        ? { symbol: { [Op.in]: sampleSymbols }, factor_date: coverageFactorDate }
        : { symbol: { [Op.in]: sampleSymbols } },
    }).catch(() => [] as StockMoneyFlowFactor[]);
    const fundamentalRows = await StockFundamentalFactor.findAll({
      where: coverageFactorDate
        ? { symbol: { [Op.in]: sampleSymbols }, factor_date: coverageFactorDate }
        : { symbol: { [Op.in]: sampleSymbols } },
    }).catch(() => [] as StockFundamentalFactor[]);
    const moneyBySymbol = new Map<string, StockMoneyFlowFactor>(
      moneyRows.map(item => [item.symbol, item] as [string, StockMoneyFlowFactor])
    );
    const fundamentalBySymbol = new Map<string, StockFundamentalFactor>(
      fundamentalRows.map(item => [item.symbol, item] as [string, StockFundamentalFactor])
    );
    const denominator = Math.max(stocks.length, 1);
    const sourceBreakdown = {
      valuation: this.parseSourceBreakdown(valuationCoverage.source_breakdown),
      money_flow: this.parseSourceBreakdown(moneyCoverage.source_breakdown),
      fundamental: this.parseSourceBreakdown(fundamentalCoverage.source_breakdown),
    };
    const sourcePairs = Object.values(sourceBreakdown).flatMap(group => Object.entries(group));
    const totalSourceRecords = sourcePairs.reduce((sum, [, count]) => sum + toNumber(count), 0);
    const realProviderRecords = sourcePairs.reduce(
      (sum, [source, count]) => sum + (isRealFactorSource(source) ? toNumber(count) : 0),
      0
    );
    const minCoverageRate = Math.min(
      round((valuationCount / denominator) * 100, 2),
      round((moneyFlowCount / denominator) * 100, 2),
      round((fundamentalCount / denominator) * 100, 2)
    );
    const providerStatus = this.getProviderPlan({ provider: 'auto', prefer_real_provider: true })
      .provider_status;
    const sourceQuality = {
      total_source_records: totalSourceRecords,
      real_provider_records: realProviderRecords,
      derived_records: Math.max(totalSourceRecords - realProviderRecords, 0),
      real_provider_rate:
        totalSourceRecords > 0 ? round((realProviderRecords / totalSourceRecords) * 100, 2) : 0,
      primary_source:
        [...sourcePairs]
          .sort((a, b) => toNumber(b[1]) - toNumber(a[1]))
          .map(([source]) => source)[0] || null,
      provider_status: providerStatus,
    };
    const factorLagDays = daysBetween(coverageFactorDate, latestTradeDate);
    const coverageStatus: FactorCoverage['coverage_status'] =
      minCoverageRate >= 70 && sourceQuality.real_provider_rate >= 10
        ? 'real_ready'
        : minCoverageRate >= 70
        ? 'derived_ready'
        : minCoverageRate >= 45
        ? 'limited'
        : 'missing';
    const nextActions = [];
    if (!stocks.length) nextActions.push('股票基础表为空，先执行新股同步。');
    if (!latestTradeDate) nextActions.push('历史K线为空，先执行日更同步/批量补数。');
    if (valuationCount / denominator < 0.7) nextActions.push('执行因子落盘任务，补齐估值分位。');
    if (moneyFlowCount / denominator < 0.7)
      nextActions.push('执行因子落盘任务，补齐量价资金流特征。');
    if (fundamentalCount / denominator < 0.7)
      nextActions.push('配置 Tushare Pro 后补齐真实财务质量因子。');
    if (sourceQuality.real_provider_rate < 10 && minCoverageRate >= 70)
      nextActions.push('当前因子主要来自本地派生，建议配置 Tushare Pro 提升财务/资金流真实性。');
    if (factorLagDays !== null && factorLagDays > 3)
      nextActions.push(`因子快照滞后 ${factorLagDays} 天，建议先执行因子同步后再开盘扫描。`);
    if (!nextActions.length) nextActions.push('因子覆盖良好，可用于策略打分和样本外验证。');

    return {
      as_of: new Date().toISOString(),
      latest_trade_date: latestTradeDate,
      latest_factor_date: coverageFactorDate,
      latest_landed_factor_date: latestFactorDate,
      effective_factor_date: coverageFactorDate,
      factor_lag_days: factorLagDays,
      coverage_status: coverageStatus,
      universe_stock_count: stocks.length,
      coverage: {
        valuation: valuationCount,
        money_flow: moneyFlowCount,
        fundamental: fundamentalCount,
      },
      coverage_rate: {
        valuation: round((valuationCount / denominator) * 100, 2),
        money_flow: round((moneyFlowCount / denominator) * 100, 2),
        fundamental: round((fundamentalCount / denominator) * 100, 2),
      },
      latest_counts: {
        valuation: valuationCount,
        money_flow: moneyFlowCount,
        fundamental: fundamentalCount,
      },
      samples: samples.map(item => {
        const moneyFlow = moneyBySymbol.get(item.symbol);
        const fundamental = fundamentalBySymbol.get(item.symbol);
        return {
          symbol: item.symbol,
          name: item.name,
          industry: item.stock?.industry || null,
          valuation_score: item.valuation_score,
          money_flow_score: moneyFlow?.money_flow_score ?? null,
          quality_score: fundamental?.quality_score ?? null,
          factor_date: item.factor_date,
        };
      }),
      source_breakdown: sourceBreakdown,
      source_quality: sourceQuality,
      next_actions: nextActions,
    };
  }
}

export const stockFactorService = new StockFactorService();
