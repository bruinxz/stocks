import { Op, literal } from 'sequelize';
import { DailyBar } from '../../models/DailyBar';
import { Stock } from '../../models/Stock';
import { FavoriteStock } from '../../models/FavoriteStock';
import { StockFundamentalFactor } from '../../models/StockFundamentalFactor';
import { StockMoneyFlowFactor } from '../../models/StockMoneyFlowFactor';
import { StockValuationFactor } from '../../models/StockValuationFactor';
import { normalizeSymbol } from '../../utils/stockSymbol';
import { logger } from '../../utils/logger';
import { TushareClient } from '../sources/TushareClient';

type FactorScope = 'favorites' | 'market' | 'custom';
type FactorProviderName = 'auto' | 'local_derived' | 'tushare';

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

function percentileRank(values: number[], value: number): number | undefined {
  const filtered = values.filter(item => Number.isFinite(item) && item > 0).sort((a, b) => a - b);
  if (!filtered.length || !Number.isFinite(value) || value <= 0) return undefined;
  const lowerOrEqual = filtered.filter(item => item <= value).length;
  return round((lowerOrEqual / filtered.length) * 100, 4);
}

interface FactorSyncOptions {
  scope?: FactorScope;
  symbols?: string[];
  limit?: number;
  as_of?: string;
  user_id?: number;
  provider?: FactorProviderName;
  prefer_real_provider?: boolean;
  skip_if_coverage_rate_gte?: number;
}

export interface FactorCoverage {
  as_of: string;
  latest_trade_date: string | null;
  latest_factor_date?: string | null;
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
  next_actions: string[];
}

export class StockFactorService {
  private tushareClient = new TushareClient();

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
    } else if (requestedProvider === 'local_derived') {
      providers.push('local_derived');
    } else {
      if (preferRealProvider && tushareEnabled) providers.push('tushare');
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
    if (skipThreshold > 0 && stocks.length > 0) {
      const coverage = await this.getCoverage({
        ...options,
        limit: stocks.length,
        skip_if_coverage_rate_gte: undefined,
      });
      const minCoverageRate = Math.min(
        Number(coverage.coverage_rate.valuation || 0),
        Number(coverage.coverage_rate.money_flow || 0),
        Number(coverage.coverage_rate.fundamental || 0)
      );
      if (coverage.latest_trade_date && minCoverageRate >= skipThreshold) {
        return {
          generated_at: new Date().toISOString(),
          scope: options.scope || (options.symbols?.length ? 'custom' : 'market'),
          skipped: true,
          skip_reason: `因子覆盖率 ${round(
            minCoverageRate,
            2
          )}% 已达到阈值 ${skipThreshold}%，本轮跳过重复落盘。`,
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
          },
          message: '因子覆盖率已达标，跳过重复同步以缩短开盘扫描耗时。',
        };
      }
    }
    const providerResults: Record<string, any> = {};
    if (providerPlan.providers.includes('tushare')) {
      providerResults.tushare = await this.syncTushareFactors(stocks, options);
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
    // 因子是低频/日终特征，实时或当日 K 线补入后不应把昨日有效因子判成 0 覆盖。
    // 覆盖率使用所选股票池内最新因子日期；latest_trade_date 仍返回 K 线最新交易日，便于识别数据时差。
    const coverageFactorDate = latestFactorDate || latestTradeDate;
    const where = stockIds.length
      ? {
          stock_id: { [Op.in]: stockIds },
          ...(coverageFactorDate ? { factor_date: coverageFactorDate } : {}),
        }
      : {};

    const [
      valuationCount,
      moneyFlowCount,
      fundamentalCount,
      valuationRowsAll,
      moneyRowsAll,
      fundamentalRowsAll,
    ] = await Promise.all([
      StockValuationFactor.count({ where }),
      StockMoneyFlowFactor.count({ where }),
      StockFundamentalFactor.count({ where }),
      StockValuationFactor.findAll({
        where,
        attributes: ['source'],
        raw: true,
      }).catch(() => [] as any[]),
      StockMoneyFlowFactor.findAll({
        where,
        attributes: ['source'],
        raw: true,
      }).catch(() => [] as any[]),
      StockFundamentalFactor.findAll({
        where,
        attributes: ['source'],
        raw: true,
      }).catch(() => [] as any[]),
    ]);
    const countBySource = (rows: any[]) =>
      rows.reduce<Record<string, number>>((acc, row) => {
        const source = String(row.source || 'unknown');
        acc[source] = (acc[source] || 0) + 1;
        return acc;
      }, {});

    const samples = coverageFactorDate
      ? await StockValuationFactor.findAll({
          where,
          include: [{ model: Stock, attributes: ['industry'] }],
          order: [['valuation_score', 'DESC']],
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
    const nextActions = [];
    if (!stocks.length) nextActions.push('股票基础表为空，先执行新股同步。');
    if (!latestTradeDate) nextActions.push('历史K线为空，先执行日更同步/批量补数。');
    if (valuationCount / denominator < 0.7) nextActions.push('执行因子落盘任务，补齐估值分位。');
    if (moneyFlowCount / denominator < 0.7)
      nextActions.push('执行因子落盘任务，补齐量价资金流特征。');
    if (fundamentalCount / denominator < 0.7)
      nextActions.push('配置 Tushare Pro 后补齐真实财务质量因子。');
    if (!nextActions.length) nextActions.push('因子覆盖良好，可用于策略打分和样本外验证。');

    return {
      as_of: new Date().toISOString(),
      latest_trade_date: latestTradeDate,
      latest_factor_date: coverageFactorDate,
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
      source_breakdown: {
        valuation: countBySource(valuationRowsAll),
        money_flow: countBySource(moneyRowsAll),
        fundamental: countBySource(fundamentalRowsAll),
      },
      next_actions: nextActions,
    };
  }
}

export const stockFactorService = new StockFactorService();
