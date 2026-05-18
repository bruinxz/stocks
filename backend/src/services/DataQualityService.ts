import { Op } from 'sequelize';
import { DailyBar } from '../models/DailyBar';
import { Stock } from '../models/Stock';
import { sequelize } from '../config/database';
import { logger } from '../utils/logger';

export type DataQualityGrade = 'excellent' | 'good' | 'fair' | 'poor' | 'empty';
export type DataQualityScope = 'favorites' | 'market' | 'all';

export interface DataQualityScanOptions {
  symbols?: string[];
  scope?: DataQualityScope;
  user_id?: number;
  lookback_days?: number;
  limit?: number;
}

interface StockScanInput {
  id: number;
  symbol: string;
  name: string;
  market?: string;
  industry?: string;
  data_status?: string;
}

interface BarScanInput {
  time: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  turnover?: number;
  change_percent?: number;
}

function round(value: number | undefined | null, digits = 2): number {
  if (value === undefined || value === null || !Number.isFinite(value)) return 0;
  const base = 10 ** digits;
  return Math.round(value * base) / base;
}

function toDateString(date: Date): string {
  return date.toISOString().split('T')[0];
}

function normalizeDate(date: Date): Date {
  const normalized = new Date(date);
  normalized.setHours(0, 0, 0, 0);
  return normalized;
}

function businessDaysBetween(start: Date, end: Date): number {
  const cursor = normalizeDate(start);
  const stop = normalizeDate(end);
  let count = 0;
  while (cursor <= stop) {
    const day = cursor.getDay();
    if (day !== 0 && day !== 6) count++;
    cursor.setDate(cursor.getDate() + 1);
  }
  return Math.max(count, 1);
}

function businessDaysStrictlyBetween(start: Date, end: Date): number {
  const cursor = normalizeDate(start);
  const stop = normalizeDate(end);
  cursor.setDate(cursor.getDate() + 1);

  let count = 0;
  while (cursor < stop) {
    const day = cursor.getDay();
    if (day !== 0 && day !== 6) count++;
    cursor.setDate(cursor.getDate() + 1);
  }
  return count;
}

function gradeFromScore(score: number, barCount: number): DataQualityGrade {
  if (barCount === 0) return 'empty';
  if (score >= 90) return 'excellent';
  if (score >= 75) return 'good';
  if (score >= 55) return 'fair';
  return 'poor';
}

function statusFromGrade(grade: DataQualityGrade): string {
  if (grade === 'empty') return 'no_data';
  if (grade === 'poor') return 'conflict';
  if (grade === 'fair') return 'incomplete';
  return 'complete';
}

function buildRecommendation(
  grade: DataQualityGrade,
  issues: Record<string, number>,
  latestDate?: string
): string {
  if (grade === 'empty') return '优先补全历史K线，可使用自动 fallback 批量同步近一年数据';
  if ((issues.ohlc_anomaly || 0) > 0 || (issues.extreme_return || 0) > 0) {
    return '存在价格逻辑或异常涨跌幅，建议换源重拉该股票并复核复权口径';
  }
  if ((issues.stale_days || 0) > 3) {
    return `最新数据停留在 ${latestDate || '--'}，建议执行近30日增量补数`;
  }
  if ((issues.duplicate_day || 0) > 0 || (issues.missing_business_day || 0) > 3) {
    return '存在重复交易日或近期缺口，建议按缺失区间执行批量补数';
  }
  return '数据质量良好，可直接用于回测与推荐评分';
}

export class DataQualityService {
  async scanMarketDataQuality(options: DataQualityScanOptions = {}) {
    const lookback_days = Math.min(Math.max(options.lookback_days || 180, 30), 720);
    const limit = Math.min(Math.max(options.limit || 80, 1), 500);
    const scope = options.scope || 'market';
    const stocks = await this.resolveStocks({ ...options, scope, limit });
    const since = new Date();
    since.setDate(since.getDate() - Math.ceil(lookback_days * 1.45));

    const items = [];
    for (const stock of stocks) {
      try {
        items.push(await this.scanSingleStock(stock, since, lookback_days));
      } catch (error: any) {
        logger.warn(`数据质量扫描失败 ${stock.symbol}: ${error.message}`);
      }
    }

    items.sort((a, b) => a.quality_score - b.quality_score);

    const issueTotals = items.reduce<Record<string, number>>((acc, item) => {
      Object.entries(item.issues).forEach(([key, value]) => {
        acc[key] = (acc[key] || 0) + Number(value || 0);
      });
      return acc;
    }, {});

    const gradeDistribution = items.reduce<Record<string, number>>((acc, item) => {
      acc[item.grade] = (acc[item.grade] || 0) + 1;
      return acc;
    }, {});

    const avgScore =
      items.length > 0
        ? round(items.reduce((sum, item) => sum + item.quality_score, 0) / items.length, 2)
        : 0;
    const lowQualityCount = items.filter(item => ['poor', 'empty'].includes(item.grade)).length;
    const staleCount = items.filter(item => item.issues.stale_days > 3).length;

    return {
      as_of: new Date().toISOString(),
      scope,
      lookback_days,
      summary: {
        scanned_stocks: items.length,
        avg_quality_score: avgScore,
        low_quality_count: lowQualityCount,
        low_quality_rate: items.length > 0 ? round((lowQualityCount / items.length) * 100, 2) : 0,
        stale_count: staleCount,
        issue_totals: issueTotals,
        grade_distribution: gradeDistribution,
      },
      repair_suggestions: this.buildRepairSuggestions(items),
      items: items.slice(0, limit),
    };
  }

  private async resolveStocks(
    options: Required<Pick<DataQualityScanOptions, 'scope' | 'limit'>> & DataQualityScanOptions
  ): Promise<StockScanInput[]> {
    if (options.symbols && options.symbols.length > 0) {
      const stocks = await Stock.findAll({
        where: { symbol: { [Op.in]: options.symbols } },
        attributes: ['id', 'symbol', 'name', 'market', 'industry', 'data_status'],
        raw: true,
      });
      return stocks as any[];
    }

    const where: any = {
      is_listed: true,
      [Op.or]: [{ type: 'stock' }, { type: null }],
    };

    if (options.scope === 'favorites') {
      const [rows] = await sequelize.query(
        `
          SELECT DISTINCT s.id, s.symbol, s.name, s.market, s.industry, s.data_status
          FROM favorite_stocks f
          JOIN stocks s ON s.id = f.stock_id
          ${options.user_id ? 'WHERE f.user_id = :user_id' : ''}
          ORDER BY s.symbol ASC
          LIMIT :limit
        `,
        {
          replacements: { user_id: options.user_id, limit: options.limit },
        }
      );
      if ((rows as any[]).length > 0) return rows as StockScanInput[];
    }

    const stocks = await Stock.findAll({
      where,
      attributes: ['id', 'symbol', 'name', 'market', 'industry', 'data_status'],
      order: [
        ['data_status', 'ASC'],
        ['updated_at', 'DESC'],
      ] as any,
      limit: options.limit,
      raw: true,
    });
    return stocks as any[];
  }

  private async scanSingleStock(stock: StockScanInput, since: Date, lookback_days: number) {
    const bars = (await DailyBar.findAll({
      where: {
        stock_id: stock.id,
        time: { [Op.gte]: since },
      },
      order: [['time', 'ASC']],
      limit: lookback_days + 80,
      raw: true,
    })) as any[];

    const normalizedBars: BarScanInput[] = bars
      .map(bar => {
        const turnover =
          bar.turnover === null || bar.turnover === undefined ? undefined : Number(bar.turnover);
        const change_percent =
          bar.change_percent === null || bar.change_percent === undefined
            ? undefined
            : Number(bar.change_percent);
        return {
          time: new Date(bar.time),
          open: Number(bar.open),
          high: Number(bar.high),
          low: Number(bar.low),
          close: Number(bar.close),
          volume: Number(bar.volume || 0),
          turnover,
          change_percent,
        };
      })
      .filter(bar => Number.isFinite(bar.close));

    const issues: Record<string, number> = {
      ohlc_anomaly: 0,
      extreme_return: 0,
      duplicate_day: 0,
      missing_business_day: 0,
      stale_days: 0,
      zero_volume: 0,
    };
    const sampleIssues: Array<{ date: string; type: string; detail: string }> = [];
    const dateSeen = new Set<string>();
    let previousClose: number | undefined;
    let firstDate: string | undefined;
    let latestDate: string | undefined;

    for (const bar of normalizedBars) {
      const date = toDateString(bar.time);
      if (!firstDate) firstDate = date;
      latestDate = date;

      if (dateSeen.has(date)) {
        issues.duplicate_day++;
        sampleIssues.push({ date, type: 'duplicate_day', detail: '同一交易日存在多条K线' });
      }
      dateSeen.add(date);

      if (
        bar.high < Math.max(bar.open, bar.close, bar.low) ||
        bar.low > Math.min(bar.open, bar.close, bar.high) ||
        bar.open <= 0 ||
        bar.close <= 0
      ) {
        issues.ohlc_anomaly++;
        sampleIssues.push({ date, type: 'ohlc_anomaly', detail: 'OHLC 价格关系异常或价格非正' });
      }

      const returnPct =
        previousClose && previousClose > 0
          ? ((bar.close - previousClose) / previousClose) * 100
          : undefined;
      const changePercent = bar.change_percent ?? returnPct;
      if (changePercent !== undefined && Math.abs(changePercent) > 40) {
        issues.extreme_return++;
        sampleIssues.push({
          date,
          type: 'extreme_return',
          detail: `单日涨跌幅 ${round(changePercent, 2)}%，疑似复权或源异常`,
        });
      }

      if (bar.volume <= 0) {
        issues.zero_volume++;
      }

      previousClose = bar.close;
    }

    if (normalizedBars.length > 1) {
      for (let index = 1; index < normalizedBars.length; index++) {
        const missingDays = businessDaysStrictlyBetween(
          normalizedBars[index - 1].time,
          normalizedBars[index].time
        );
        if (missingDays > 0) {
          issues.missing_business_day += missingDays;
          if (sampleIssues.length < 5) {
            sampleIssues.push({
              date: toDateString(normalizedBars[index].time),
              type: 'missing_business_day',
              detail: `与上一条K线之间缺少约 ${missingDays} 个工作日`,
            });
          }
        }
      }
    }

    if (latestDate) {
      issues.stale_days = Math.max(
        businessDaysBetween(new Date(`${latestDate}T00:00:00.000Z`), new Date()) - 1,
        0
      );
    }

    const expectedBars =
      normalizedBars.length > 0 && firstDate && latestDate
        ? Math.min(
            businessDaysBetween(
              new Date(`${firstDate}T00:00:00.000Z`),
              new Date(`${latestDate}T00:00:00.000Z`)
            ),
            lookback_days
          )
        : lookback_days;
    const coverageRate =
      expectedBars > 0
        ? Math.min(
            100,
            (new Set(normalizedBars.map(bar => toDateString(bar.time))).size / expectedBars) * 100
          )
        : 0;

    const penalty =
      issues.ohlc_anomaly * 8 +
      issues.extreme_return * 6 +
      issues.duplicate_day * 4 +
      Math.min(issues.missing_business_day, 30) * 1.5 +
      Math.min(issues.stale_days, 30) * 1.2 +
      Math.min(issues.zero_volume, 20) * 0.8;
    const qualityScore =
      normalizedBars.length === 0 ? 0 : Math.max(0, Math.min(100, coverageRate - penalty));
    const grade = gradeFromScore(qualityScore, normalizedBars.length);

    return {
      symbol: stock.symbol,
      name: stock.name,
      market: stock.market,
      industry: stock.industry,
      data_status: stock.data_status,
      quality_score: round(qualityScore, 2),
      grade,
      bar_count: normalizedBars.length,
      coverage_rate: round(coverageRate, 2),
      first_date: firstDate,
      latest_date: latestDate,
      issues,
      sample_issues: sampleIssues.slice(0, 5),
      recommended_action: buildRecommendation(grade, issues, latestDate),
    };
  }

  private buildRepairSuggestions(items: any[]) {
    const targets = items.filter(
      item => item.grade === 'empty' || item.grade === 'poor' || item.issues.stale_days > 3
    );
    const topTargets = targets.slice(0, 20);
    return {
      target_count: targets.length,
      top_symbols: topTargets.map(item => item.symbol),
      recommended_payload:
        topTargets.length > 0
          ? {
              symbols: topTargets.map(item => item.symbol),
              start_date: topTargets.some(item => item.grade === 'empty')
                ? '2020-01-01'
                : undefined,
              dataSource: 'auto',
              concurrency: 2,
            }
          : null,
    };
  }

  async updateStockQualityStatuses(options: DataQualityScanOptions = {}) {
    const report = await this.scanMarketDataQuality(options);
    let updated = 0;

    for (const item of report.items) {
      try {
        await Stock.update(
          { data_status: statusFromGrade(item.grade) },
          { where: { symbol: item.symbol } }
        );
        updated++;
      } catch (error: any) {
        logger.warn(`更新股票数据质量状态失败 ${item.symbol}: ${error.message}`);
      }
    }

    return {
      updated,
      scanned: report.items.length,
      summary: report.summary,
    };
  }
}

export const dataQualityService = new DataQualityService();
