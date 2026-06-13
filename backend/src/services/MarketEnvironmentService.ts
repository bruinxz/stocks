import { Op } from 'sequelize';
import moment from 'moment-timezone';
import { Stock } from '../models/Stock';
import { DailyBar } from '../models/DailyBar';
import { MacroIndicator } from '../models/MacroIndicator';
import { OptionQvix } from '../models/OptionQvix';
import { DEFAULT_BENCHMARK_INDICES, benchmarkIndexService } from './BenchmarkIndexService';
import { logger } from '../utils/logger';

function toNumber(value: any, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function roundNumber(value: any, digits = 2): number {
  const num = toNumber(value, 0);
  const base = 10 ** digits;
  return Math.round(num * base) / base;
}

function average(values: number[]): number {
  const valid = values.filter(Number.isFinite);
  if (valid.length === 0) return 0;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function pct(current: number, previous: number): number {
  if (!previous || !Number.isFinite(current) || !Number.isFinite(previous)) return 0;
  return ((current - previous) / previous) * 100;
}

function maxDrawdown(closes: number[]): number {
  let peak = closes[0] || 0;
  let maxDd = 0;
  for (const close of closes) {
    if (close > peak) peak = close;
    if (peak > 0) maxDd = Math.min(maxDd, ((close - peak) / peak) * 100);
  }
  return maxDd;
}

export interface MarketEnvironmentSnapshot {
  as_of: string;
  market_regime: 'bull' | 'bear' | 'range' | 'rebound' | 'stress' | 'unknown';
  market_regime_label: string;
  benchmark_code: string;
  benchmark_name: string;
  benchmark_return_5d_pct: number;
  benchmark_return_20d_pct: number;
  benchmark_return_60d_pct: number;
  benchmark_drawdown_60d_pct: number;
  benchmark_price_vs_ma20_pct: number;
  benchmark_price_vs_ma60_pct: number;
  breadth: {
    sample_count: number;
    up_20d_ratio: number;
    above_ma20_ratio: number;
    strong_industry_count: number;
    weak_industry_count: number;
  };
  /** 新增：宏观经济指标快照 — PMI / M2 增速 / 10Y 国债 / SHIBOR */
  macro?: {
    pmi_latest: number | null;          // 最新 PMI 值 (50 是荣枯线)
    pmi_change_3m: number | null;        // 近 3 个月 PMI 变化 (+/-)
    m2_yoy: number | null;               // M2 同比 (%)
    treasury_10y: number | null;         // 10Y 国债收益率 (%)
    shibor_overnight: number | null;     // 隔夜 shibor (%)
    cpi_yoy: number | null;              // CPI 同比 (%)
  };
  /** 新增：QVIX 期权波动率指数 — 300ETF QVIX 是 A 股"恐慌指数" */
  qvix?: {
    qvix_300etf_latest: number | null;       // 最新 300ETF QVIX
    qvix_300etf_change_5d_pct: number | null; // 近 5 日变化 %
    qvix_300etf_percentile_60d: number | null; // 近 60 日分位 (0-100)
    is_panic: boolean;                        // QVIX 显著上行 → 恐慌信号
  };
  industry?: {
    name?: string;
    regime: 'hot' | 'warm' | 'cold' | 'unknown';
    label: string;
    sample_count: number;
    avg_return_20d_pct: number;
    relative_return_20d_pct: number;
    above_ma20_ratio: number;
  };
}

class MarketEnvironmentService {
  private cache = new Map<string, { expires_at: number; value: MarketEnvironmentSnapshot }>();

  async getEnvironmentForStock(
    symbol: string,
    options: { stock?: Stock | null; as_of?: string; industry?: string; use_cache?: boolean } = {}
  ): Promise<MarketEnvironmentSnapshot> {
    const stock = options.stock || (await Stock.findOne({ where: { symbol } }));
    const benchmark = await benchmarkIndexService.resolveBenchmarkForStock(symbol, stock);
    const industry = options.industry || stock?.industry || undefined;
    const asOf = options.as_of || moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
    const cacheKey = `${benchmark.symbol}|${industry || 'all'}|${asOf}`;
    const cached = this.cache.get(cacheKey);
    if (options.use_cache !== false && cached && cached.expires_at > Date.now()) {
      return cached.value;
    }

    const [market, industryState] = await Promise.all([
      this.resolveMarketRegime(benchmark.symbol, benchmark.name, asOf),
      industry ? this.resolveIndustryState(industry, asOf, benchmark.symbol) : null,
    ]);
    const snapshot: MarketEnvironmentSnapshot = {
      ...market,
      industry: industryState || undefined,
    };
    this.cache.set(cacheKey, { expires_at: Date.now() + 15 * 60 * 1000, value: snapshot });
    return snapshot;
  }

  private async resolveMarketRegime(
    benchmarkSymbol: string,
    benchmarkName: string,
    asOf: string
  ): Promise<Omit<MarketEnvironmentSnapshot, 'industry'>> {
    const endDate = moment(asOf).format('YYYY-MM-DD');
    const startDate = moment(asOf).subtract(140, 'days').format('YYYY-MM-DD');
    try {
      await benchmarkIndexService.ensureBenchmarkCoverage(startDate, endDate, {
        symbols: [benchmarkSymbol],
        concurrency: 1,
      });
    } catch (error: any) {
      logger.warn(`市场环境基准数据同步失败 ${benchmarkSymbol}: ${error?.message || error}`);
    }

    const indexStock = await Stock.findOne({ where: { symbol: benchmarkSymbol } });
    const bars = indexStock
      ? ((await DailyBar.findAll({
          where: {
            stock_id: indexStock.id,
            time: {
              [Op.gte]: new Date(`${startDate}T00:00:00.000Z`),
              [Op.lte]: new Date(`${endDate}T23:59:59.999Z`),
            },
          },
          order: [['time', 'ASC']],
          raw: true,
        })) as any[])
      : [];
    const closes = bars.map(bar => Number(bar.close)).filter(value => value > 0);
    const latest = closes[closes.length - 1] || 0;
    const ret5 = closes.length > 5 ? pct(latest, closes[closes.length - 6]) : 0;
    const ret20 = closes.length > 20 ? pct(latest, closes[closes.length - 21]) : 0;
    const ret60 = closes.length > 60 ? pct(latest, closes[closes.length - 61]) : 0;
    const ma20 = average(closes.slice(-20));
    const ma60 = average(closes.slice(-60));
    const vsMa20 = ma20 > 0 ? pct(latest, ma20) : 0;
    const vsMa60 = ma60 > 0 ? pct(latest, ma60) : 0;
    const drawdown = maxDrawdown(closes.slice(-60));
    const [breadth, macro, qvix] = await Promise.all([
      this.resolveBreadth(endDate, ret20),
      this.resolveMacroFeatures(endDate),
      this.resolveQvixFeatures(endDate),
    ]);

    let regime: MarketEnvironmentSnapshot['market_regime'] = 'range';
    if (!latest || closes.length < 20) regime = 'unknown';
    // === stress 触发条件升级 ===
    // 原有: ret20 ≤ -6% 或 drawdown ≤ -12% 触发
    // 新增: QVIX 飙升 → 隐含波动率提升 → 市场恐慌（先行指标，比 ret20 更早）
    else if (
      ret20 <= -6 ||
      drawdown <= -12 ||
      (qvix?.is_panic && ret20 <= -2) // QVIX 恐慌 + 已经有 2% 跌幅，确认 stress
    )
      regime = 'stress';
    else if (ret60 < -8 && vsMa60 < -3) regime = 'bear';
    // === bull 触发条件保守化 ===
    // PMI < 50（经济收缩）时即使指数涨也别 bull
    else if (
      ret20 > 5 &&
      vsMa20 > 1.5 &&
      breadth.up_20d_ratio >= 48 &&
      !(macro?.pmi_latest != null && macro.pmi_latest < 49)
    )
      regime = 'bull';
    else if (ret20 > 2 && ret60 < 0) regime = 'rebound';

    // === v5 集成: HMM regime detection (data-driven alternative to hard rules) ===
    // 当 HMM_REGIME_ENABLED 环境变量打开 + 历史 closes 足够长时，用 HMM 替代上述硬规则
    if (process.env.HMM_REGIME_ENABLED === 'true' && closes.length >= 60) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const hmm = require('./research/hmm-regime');
        // 转 close 为日收益序列
        const returns: number[] = [];
        for (let i = 1; i < closes.length; i += 1) {
          if (closes[i - 1] > 0) returns.push(closes[i] / closes[i - 1] - 1);
        }
        if (returns.length >= 50) {
          // 用 4-state HMM (匹配 4 regime: bear, range, bull, volatile)
          const initial = hmm.initializeHMMParams(returns, 4);
          const trained = hmm.hmmBaumWelch(returns, initial, { max_iter: 30, tolerance: 1e-4 });
          const labels = hmm.decodeRegimeLabels(trained.params);
          // Viterbi 解码最近 state
          const vit = hmm.hmmViterbi(trained.params, returns);
          const lastState = vit.states[vit.states.length - 1];
          const hmmRegime = labels[lastState];
          // HMM 输出映射回 service 的 regime enum
          const regimeMap: Record<string, MarketEnvironmentSnapshot['market_regime']> = {
            bull: 'bull',
            bear: 'bear',
            range: 'range',
            volatile: 'stress', // volatile → stress (语义对齐)
          };
          if (regimeMap[hmmRegime]) regime = regimeMap[hmmRegime];
        }
      } catch (err) {
        // HMM 失败回退到原硬规则
      }
    }

    return {
      as_of: endDate,
      market_regime: regime,
      market_regime_label: this.marketRegimeLabel(regime),
      benchmark_code: benchmarkSymbol,
      benchmark_name: benchmarkName,
      benchmark_return_5d_pct: roundNumber(ret5, 4),
      benchmark_return_20d_pct: roundNumber(ret20, 4),
      benchmark_return_60d_pct: roundNumber(ret60, 4),
      benchmark_drawdown_60d_pct: roundNumber(drawdown, 4),
      benchmark_price_vs_ma20_pct: roundNumber(vsMa20, 4),
      benchmark_price_vs_ma60_pct: roundNumber(vsMa60, 4),
      breadth,
      macro: macro || undefined,
      qvix: qvix || undefined,
    };
  }

  /**
   * 拉宏观指标快照（PMI / M2 / 10Y国债 / SHIBOR / CPI）
   * 容错：任一指标缺失 → null，不阻塞其他.
   * 数据来源：MacroIndicator 表（npm run sync:extra-dims --dim=macro 同步）.
   */
  private async resolveMacroFeatures(asOf: string): Promise<{
    pmi_latest: number | null;
    pmi_change_3m: number | null;
    m2_yoy: number | null;
    treasury_10y: number | null;
    shibor_overnight: number | null;
    cpi_yoy: number | null;
  } | null> {
    try {
      const fetchLatest = async (key: string) => {
        const row = (await MacroIndicator.findOne({
          where: { indicator_key: key, observation_date: { [Op.lte]: asOf } },
          order: [['observation_date', 'DESC']],
          raw: true,
        })) as any;
        return row ? { value: Number(row.value), date: row.observation_date, yoy: row.yoy_pct } : null;
      };
      const fetchNthBefore = async (key: string, n: number) => {
        const rows = (await MacroIndicator.findAll({
          where: { indicator_key: key, observation_date: { [Op.lte]: asOf } },
          order: [['observation_date', 'DESC']],
          limit: n + 1,
          raw: true,
        })) as any[];
        return rows[n] ? Number(rows[n].value) : null;
      };

      const [pmi, pmi3m, m2, treas10y, shibor, cpi] = await Promise.all([
        fetchLatest('pmi'),
        fetchNthBefore('pmi', 3),
        fetchLatest('m2'),
        fetchLatest('treasury_10y_china'),
        fetchLatest('shibor_overnight'),
        fetchLatest('cpi'),
      ]);

      return {
        pmi_latest: pmi ? roundNumber(pmi.value, 2) : null,
        pmi_change_3m:
          pmi && pmi3m != null ? roundNumber(pmi.value - pmi3m, 2) : null,
        m2_yoy: m2 && m2.yoy != null ? roundNumber(Number(m2.yoy), 2) : null,
        treasury_10y: treas10y ? roundNumber(treas10y.value, 4) : null,
        shibor_overnight: shibor ? roundNumber(shibor.value, 4) : null,
        cpi_yoy: cpi ? roundNumber(cpi.value, 2) : null,
      };
    } catch (err: any) {
      logger.debug(`resolveMacroFeatures failed: ${err?.message || err}`);
      return null;
    }
  }

  /**
   * QVIX 期权波动率指数 — 300ETF QVIX 作为 A 股恐慌指数
   * - latest：最新一日
   * - change_5d_pct：近 5 日 QVIX 变化
   * - percentile_60d：近 60 日分位 (0-100)
   * - is_panic：QVIX 处于 60 日内 80% 分位 + 近 5 日上升 > 10%
   */
  private async resolveQvixFeatures(asOf: string): Promise<{
    qvix_300etf_latest: number | null;
    qvix_300etf_change_5d_pct: number | null;
    qvix_300etf_percentile_60d: number | null;
    is_panic: boolean;
  } | null> {
    try {
      const rows = (await OptionQvix.findAll({
        where: { underlying: '300etf', observation_date: { [Op.lte]: asOf } },
        order: [['observation_date', 'DESC']],
        limit: 60,
        raw: true,
      })) as any[];
      if (rows.length === 0) return null;
      const closes = rows.map(r => Number(r.close)).filter(Number.isFinite);
      if (closes.length === 0) return null;

      const latest = closes[0];
      const fiveDayAgo = closes[5];
      const change5dPct =
        fiveDayAgo && fiveDayAgo > 0 ? ((latest - fiveDayAgo) / fiveDayAgo) * 100 : null;

      // 60日分位
      const sortedAsc = [...closes].sort((a, b) => a - b);
      const idx = sortedAsc.findIndex(v => v >= latest);
      const percentile60d = idx >= 0 ? (idx / sortedAsc.length) * 100 : 100;

      const isPanic = percentile60d >= 80 && (change5dPct ?? 0) >= 10;

      return {
        qvix_300etf_latest: roundNumber(latest, 2),
        qvix_300etf_change_5d_pct: change5dPct != null ? roundNumber(change5dPct, 2) : null,
        qvix_300etf_percentile_60d: roundNumber(percentile60d, 1),
        is_panic: isPanic,
      };
    } catch (err: any) {
      logger.debug(`resolveQvixFeatures failed: ${err?.message || err}`);
      return null;
    }
  }

  private async resolveIndustryState(
    industry: string,
    asOf: string,
    benchmarkSymbol: string
  ): Promise<MarketEnvironmentSnapshot['industry']> {
    const stocks = await Stock.findAll({
      where: {
        industry,
        is_listed: true,
        [Op.or]: [{ type: 'stock' }, { type: null }],
      },
      attributes: ['id', 'symbol', 'name', 'industry'],
      order: [['total_market_cap', 'DESC NULLS LAST']] as any,
      limit: 80,
    });
    if (!stocks.length) {
      return {
        name: industry,
        regime: 'unknown',
        label: `${industry} · 样本不足`,
        sample_count: 0,
        avg_return_20d_pct: 0,
        relative_return_20d_pct: 0,
        above_ma20_ratio: 0,
      };
    }

    const startDate = moment(asOf).subtract(90, 'days').format('YYYY-MM-DD');
    const endDate = moment(asOf).format('YYYY-MM-DD');
    const bars = (await DailyBar.findAll({
      where: {
        stock_id: { [Op.in]: stocks.map(stock => stock.id) },
        time: {
          [Op.gte]: new Date(`${startDate}T00:00:00.000Z`),
          [Op.lte]: new Date(`${endDate}T23:59:59.999Z`),
        },
      },
      order: [
        ['stock_id', 'ASC'],
        ['time', 'ASC'],
      ],
      raw: true,
    })) as any[];
    const grouped = new Map<number, any[]>();
    for (const bar of bars) {
      const stockId = Number(bar.stock_id);
      if (!grouped.has(stockId)) grouped.set(stockId, []);
      grouped.get(stockId)!.push(bar);
    }

    const returns: number[] = [];
    let aboveMa20Count = 0;
    for (const stock of stocks) {
      const stockBars = grouped.get(stock.id) || [];
      const closes = stockBars.map(bar => Number(bar.close)).filter(value => value > 0);
      if (closes.length < 20) continue;
      const latest = closes[closes.length - 1];
      returns.push(pct(latest, closes[Math.max(0, closes.length - 21)]));
      const ma20 = average(closes.slice(-20));
      if (latest > ma20) aboveMa20Count++;
    }

    let benchmark20 = 0;
    try {
      const benchmark = DEFAULT_BENCHMARK_INDICES.find(item => item.symbol === benchmarkSymbol);
      const market = await this.resolveMarketRegime(
        benchmarkSymbol,
        benchmark?.name || benchmarkSymbol,
        endDate
      );
      benchmark20 = market.benchmark_return_20d_pct;
    } catch {
      benchmark20 = 0;
    }
    const avgReturn = average(returns);
    const aboveMa20Ratio = returns.length ? (aboveMa20Count / returns.length) * 100 : 0;
    const relative = avgReturn - benchmark20;
    const regime =
      returns.length < 5
        ? 'unknown'
        : relative > 3 && aboveMa20Ratio >= 55
        ? 'hot'
        : relative < -3 || aboveMa20Ratio < 35
        ? 'cold'
        : 'warm';

    return {
      name: industry,
      regime,
      label: `${industry} · ${this.industryRegimeLabel(regime)}`,
      sample_count: returns.length,
      avg_return_20d_pct: roundNumber(avgReturn, 4),
      relative_return_20d_pct: roundNumber(relative, 4),
      above_ma20_ratio: roundNumber(aboveMa20Ratio, 2),
    };
  }

  private async resolveBreadth(asOf: string, benchmarkReturn20d: number) {
    const stocks = await Stock.findAll({
      where: {
        is_listed: true,
        [Op.or]: [{ type: 'stock' }, { type: null }],
      },
      attributes: ['id', 'industry'],
      order: [['total_market_cap', 'DESC NULLS LAST']] as any,
      limit: 400,
    });
    const startDate = moment(asOf).subtract(60, 'days').format('YYYY-MM-DD');
    const bars = (await DailyBar.findAll({
      where: {
        stock_id: { [Op.in]: stocks.map(stock => stock.id) },
        time: {
          [Op.gte]: new Date(`${startDate}T00:00:00.000Z`),
          [Op.lte]: new Date(`${asOf}T23:59:59.999Z`),
        },
      },
      order: [
        ['stock_id', 'ASC'],
        ['time', 'ASC'],
      ],
      raw: true,
    })) as any[];
    const grouped = new Map<number, any[]>();
    for (const bar of bars) {
      const stockId = Number(bar.stock_id);
      if (!grouped.has(stockId)) grouped.set(stockId, []);
      grouped.get(stockId)!.push(bar);
    }
    let sample = 0;
    let up20 = 0;
    let aboveMa20 = 0;
    const industryReturns = new Map<string, number[]>();
    for (const stock of stocks) {
      const closes = (grouped.get(stock.id) || [])
        .map(bar => Number(bar.close))
        .filter(value => value > 0);
      if (closes.length < 20) continue;
      const latest = closes[closes.length - 1];
      const ret20 = pct(latest, closes[Math.max(0, closes.length - 21)]);
      const ma20 = average(closes.slice(-20));
      sample++;
      if (ret20 > 0) up20++;
      if (latest > ma20) aboveMa20++;
      const industry = stock.industry || '未分类';
      if (!industryReturns.has(industry)) industryReturns.set(industry, []);
      industryReturns.get(industry)!.push(ret20);
    }

    const industryAvgs = [...industryReturns.values()].map(values => average(values));
    return {
      sample_count: sample,
      up_20d_ratio: sample ? roundNumber((up20 / sample) * 100, 2) : 0,
      above_ma20_ratio: sample ? roundNumber((aboveMa20 / sample) * 100, 2) : 0,
      strong_industry_count: industryAvgs.filter(value => value - benchmarkReturn20d > 3).length,
      weak_industry_count: industryAvgs.filter(value => value - benchmarkReturn20d < -3).length,
    };
  }

  private marketRegimeLabel(regime: MarketEnvironmentSnapshot['market_regime']): string {
    const labels: Record<string, string> = {
      bull: '趋势强势',
      bear: '下行弱势',
      range: '震荡均衡',
      rebound: '超跌反弹',
      stress: '压力/回撤',
      unknown: '未知环境',
    };
    return labels[regime] || regime;
  }

  private industryRegimeLabel(
    regime: NonNullable<MarketEnvironmentSnapshot['industry']>['regime']
  ) {
    const labels: Record<string, string> = {
      hot: '行业强势',
      warm: '行业中性',
      cold: '行业弱势',
      unknown: '行业未知',
    };
    return labels[regime] || regime;
  }
}

export const marketEnvironmentService = new MarketEnvironmentService();
