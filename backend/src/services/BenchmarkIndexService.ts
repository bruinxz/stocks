import { Op } from 'sequelize';
import moment from 'moment-timezone';
import { Stock } from '../models/Stock';
import { DailyBar } from '../models/DailyBar';
import { DataSyncService } from '../data/services/DataSyncService';
import { normalizeSymbol } from '../utils/stockSymbol';
import { logger } from '../utils/logger';

export interface BenchmarkIndexDefinition {
  symbol: string;
  name: string;
  market: 'SH' | 'SZ' | 'BJ' | 'UNKNOWN';
  type: 'index';
}

export interface BenchmarkReturn {
  benchmark_code: string;
  benchmark_name: string;
  benchmark_entry_date: string;
  benchmark_exit_date: string;
  benchmark_entry_price: number;
  benchmark_exit_price: number;
  benchmark_return_pct: number;
}

export const DEFAULT_BENCHMARK_INDICES: BenchmarkIndexDefinition[] = [
  { symbol: 'sh.000300', name: '沪深300', market: 'SH', type: 'index' },
  { symbol: 'sh.000001', name: '上证指数', market: 'SH', type: 'index' },
  { symbol: 'sz.399001', name: '深证成指', market: 'SZ', type: 'index' },
  { symbol: 'sz.399006', name: '创业板指', market: 'SZ', type: 'index' },
  { symbol: 'sh.000905', name: '中证500', market: 'SH', type: 'index' },
  { symbol: 'sh.000852', name: '中证1000', market: 'SH', type: 'index' },
  { symbol: 'sh.000688', name: '科创50', market: 'SH', type: 'index' },
];

function dateOnly(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return date.toISOString().split('T')[0];
}

function roundNumber(value: number, digits = 4): number {
  const base = 10 ** digits;
  return Math.round(value * base) / base;
}

const MIN_PLAUSIBLE_BENCHMARK_LEVEL = 100;
const MAX_PLAUSIBLE_BENCHMARK_LEVEL = 100000;

export function isPlausibleBenchmarkLevel(value: unknown): boolean {
  const level = Number(value);
  return (
    Number.isFinite(level) &&
    level >= MIN_PLAUSIBLE_BENCHMARK_LEVEL &&
    level <= MAX_PLAUSIBLE_BENCHMARK_LEVEL
  );
}

class BenchmarkIndexService {
  private readonly coverageCache = new Set<string>();

  getDefaultIndices(): BenchmarkIndexDefinition[] {
    return DEFAULT_BENCHMARK_INDICES.map(item => ({ ...item }));
  }

  async ensureBenchmarkIndices(): Promise<void> {
    for (const index of DEFAULT_BENCHMARK_INDICES) {
      await Stock.upsert(
        {
          symbol: index.symbol,
          name: index.name,
          market: index.market,
          type: index.type,
          is_listed: true,
        },
        { conflictFields: ['symbol'] }
      );
    }
  }

  async resolveBenchmarkForStock(
    symbolInput: string,
    stockInput?: Stock | null
  ): Promise<BenchmarkIndexDefinition> {
    const symbol = normalizeSymbol(symbolInput);
    const indexSelf = DEFAULT_BENCHMARK_INDICES.find(item => item.symbol === symbol);
    if (indexSelf) return indexSelf;

    const stock = stockInput || (await Stock.findOne({ where: { symbol } }));
    const marketCapYi =
      Number(stock?.total_market_cap || stock?.circulating_market_cap || 0) / 100000000;

    let benchmarkSymbol = 'sh.000300';
    if (symbol.startsWith('sh.688')) {
      benchmarkSymbol = 'sh.000688';
    } else if (symbol.startsWith('sz.300')) {
      benchmarkSymbol = 'sz.399006';
    } else if (symbol.startsWith('bj.')) {
      benchmarkSymbol = 'sh.000852';
    } else if (marketCapYi > 0 && marketCapYi < 100) {
      benchmarkSymbol = 'sh.000852';
    } else if (marketCapYi > 0 && marketCapYi < 300) {
      benchmarkSymbol = 'sh.000905';
    } else if (symbol.startsWith('sz.')) {
      benchmarkSymbol = 'sz.399001';
    } else if (symbol.startsWith('sh.60')) {
      benchmarkSymbol = 'sh.000300';
    }

    return (
      DEFAULT_BENCHMARK_INDICES.find(item => item.symbol === benchmarkSymbol) ||
      DEFAULT_BENCHMARK_INDICES[0]
    );
  }

  async syncBenchmarkIndices(
    start_date: string,
    end_date: string,
    options: {
      symbols?: string[];
      data_source?: string;
      concurrency?: number;
    } = {}
  ): Promise<Record<string, number>> {
    await this.ensureBenchmarkIndices();
    const requestedSymbols = options.symbols?.length
      ? [...new Set(options.symbols.map(symbol => normalizeSymbol(symbol)).filter(Boolean))]
      : DEFAULT_BENCHMARK_INDICES.map(item => item.symbol);
    const symbols = requestedSymbols.filter(symbol =>
      DEFAULT_BENCHMARK_INDICES.some(index => index.symbol === symbol)
    );
    if (symbols.length === 0) return {};

    const dataSyncService = new DataSyncService();
    const startDate = moment(start_date).format('YYYY-MM-DD');
    const endDate = moment(end_date).format('YYYY-MM-DD');

    const result = await dataSyncService.syncMultipleStocksHistory(
      symbols,
      startDate,
      endDate,
      Math.min(Math.max(Number(options.concurrency || 2), 1), 5),
      undefined,
      options.data_source || 'tencent_only',
      'repair'
    );

    for (const symbol of symbols) {
      const stock = await Stock.findOne({ where: { symbol } });
      const [firstBar, latestBar] = stock
        ? await Promise.all([
            DailyBar.findOne({
              where: {
                stock_id: stock.id,
                time: {
                  [Op.gte]: new Date(`${startDate}T00:00:00.000Z`),
                  [Op.lte]: new Date(`${endDate}T23:59:59.999Z`),
                },
              },
              order: [['time', 'ASC']],
            }),
            DailyBar.findOne({
              where: {
                stock_id: stock.id,
                time: {
                  [Op.gte]: new Date(`${startDate}T00:00:00.000Z`),
                  [Op.lte]: new Date(`${endDate}T23:59:59.999Z`),
                },
              },
              order: [['time', 'DESC']],
            }),
          ])
        : [null, null];
      const valid = Boolean(
        firstBar &&
          latestBar &&
          isPlausibleBenchmarkLevel(firstBar.close) &&
          isPlausibleBenchmarkLevel(latestBar.close)
      );
      if (stock) {
        await stock.update({ data_status: valid ? 'complete' : 'conflict' });
      }
      if (valid) {
        this.coverageCache.add(this.cacheKey(symbol, startDate, endDate));
      } else {
        result[symbol] = -1;
        logger.error(
          `基准指数 ${symbol} 同步后仍未通过点位校验，已标记 conflict，禁止用于收益比较`
        );
      }
    }

    return result;
  }

  async ensureBenchmarkCoverage(
    start_date: string,
    end_date: string,
    options: {
      symbols?: string[];
      data_source?: string;
      concurrency?: number;
      force_sync?: boolean;
    } = {}
  ): Promise<Record<string, number>> {
    await this.ensureBenchmarkIndices();
    const startDate = moment(start_date).format('YYYY-MM-DD');
    const endDate = moment(end_date).format('YYYY-MM-DD');
    const symbols = (
      options.symbols?.length ? options.symbols : DEFAULT_BENCHMARK_INDICES.map(item => item.symbol)
    )
      .map(symbol => normalizeSymbol(symbol))
      .filter(Boolean);

    const symbolsNeedSync: string[] = [];
    for (const symbol of [...new Set(symbols)]) {
      const key = this.cacheKey(symbol, startDate, endDate);
      if (!options.force_sync && this.coverageCache.has(key)) continue;

      const stock = await Stock.findOne({ where: { symbol } });
      if (!stock) {
        symbolsNeedSync.push(symbol);
        continue;
      }

      const count = await DailyBar.count({
        where: {
          stock_id: stock.id,
          time: {
            [Op.gte]: new Date(`${startDate}T00:00:00.000Z`),
            [Op.lte]: new Date(`${endDate}T23:59:59.999Z`),
          },
        },
      });
      const [firstBar, latestBar] = await Promise.all([
        DailyBar.findOne({
          where: {
            stock_id: stock.id,
            time: {
              [Op.gte]: new Date(`${startDate}T00:00:00.000Z`),
              [Op.lte]: new Date(`${endDate}T23:59:59.999Z`),
            },
          },
          order: [['time', 'ASC']],
        }),
        DailyBar.findOne({
          where: {
            stock_id: stock.id,
            time: {
              [Op.gte]: new Date(`${startDate}T00:00:00.000Z`),
              [Op.lte]: new Date(`${endDate}T23:59:59.999Z`),
            },
          },
          order: [['time', 'DESC']],
        }),
      ]);

      const hasRangeCoverage =
        count > 0 &&
        firstBar &&
        latestBar &&
        isPlausibleBenchmarkLevel(firstBar.close) &&
        isPlausibleBenchmarkLevel(latestBar.close) &&
        dateOnly(firstBar.time) <= startDate &&
        dateOnly(latestBar.time) >= endDate;

      if (options.force_sync || !hasRangeCoverage) {
        symbolsNeedSync.push(symbol);
      } else {
        this.coverageCache.add(key);
      }
    }

    if (symbolsNeedSync.length === 0) return {};

    try {
      return await this.syncBenchmarkIndices(startDate, endDate, {
        symbols: symbolsNeedSync,
        data_source: options.data_source || 'tencent_only',
        concurrency: options.concurrency || 2,
      });
    } catch (error: any) {
      logger.warn(`基准指数行情同步失败，收益验证将降级为绝对收益: ${error.message}`);
      return Object.fromEntries(symbolsNeedSync.map(symbol => [symbol, -1]));
    }
  }

  async getBenchmarkReturnForStock(
    stockSymbol: string,
    entryDate: string,
    exitDate: string,
    options: {
      stock?: Stock | null;
      data_source?: string;
      auto_sync?: boolean;
    } = {}
  ): Promise<BenchmarkReturn | null> {
    const benchmark = await this.resolveBenchmarkForStock(stockSymbol, options.stock);
    const startDate = moment(entryDate).format('YYYY-MM-DD');
    const endDate = moment(exitDate).format('YYYY-MM-DD');

    if (options.auto_sync !== false) {
      await this.ensureBenchmarkCoverage(startDate, endDate, {
        symbols: [benchmark.symbol],
        data_source: options.data_source || 'tencent_only',
      });
    } else {
      await this.ensureBenchmarkIndices();
    }

    const indexStock = await Stock.findOne({ where: { symbol: benchmark.symbol } });
    if (!indexStock) return null;

    const bars = await DailyBar.findAll({
      where: {
        stock_id: indexStock.id,
        time: {
          [Op.gte]: new Date(`${startDate}T00:00:00.000Z`),
          [Op.lte]: new Date(`${endDate}T23:59:59.999Z`),
        },
      },
      order: [['time', 'ASC']],
    });

    if (bars.length === 0) return null;

    const entryBar = bars.find(bar => dateOnly(bar.time) >= startDate) || bars[0];
    const exitBar =
      [...bars].reverse().find(bar => dateOnly(bar.time) <= endDate) || bars[bars.length - 1];
    const entryPrice = Number(entryBar.close);
    const exitPrice = Number(exitBar.close);
    if (!isPlausibleBenchmarkLevel(entryPrice) || !isPlausibleBenchmarkLevel(exitPrice)) {
      await indexStock.update({ data_status: 'conflict' });
      logger.error(
        `基准指数 ${benchmark.symbol} 收益区间存在异常点位，已拒绝生成相对收益并标记 conflict`
      );
      return null;
    }

    return {
      benchmark_code: benchmark.symbol,
      benchmark_name: benchmark.name,
      benchmark_entry_date: dateOnly(entryBar.time),
      benchmark_exit_date: dateOnly(exitBar.time),
      benchmark_entry_price: roundNumber(entryPrice),
      benchmark_exit_price: roundNumber(exitPrice),
      benchmark_return_pct: roundNumber(((exitPrice - entryPrice) / entryPrice) * 100),
    };
  }

  private cacheKey(symbol: string, startDate: string, endDate: string): string {
    return `${normalizeSymbol(symbol)}:${startDate}:${endDate}`;
  }
}

export const benchmarkIndexService = new BenchmarkIndexService();
