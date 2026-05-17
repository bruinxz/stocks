import { Op } from 'sequelize';
import { createHash } from 'crypto';
import moment from 'moment-timezone';
import { DailyBar } from '../../models/DailyBar';
import { QuantSignal } from '../../models/QuantSignal';
import { QuantStrategyParamValidation } from '../../models/QuantStrategyParamValidation';
import { QuantStrategyParamVersion } from '../../models/QuantStrategyParamVersion';
import { Stock } from '../../models/Stock';
import { benchmarkIndexService } from '../../services/BenchmarkIndexService';
import { normalizeSymbol } from '../../utils/stockSymbol';
import { logger } from '../../utils/logger';
import { round } from '../engine/QuantMath';
import { strategyRegistry } from '../engine/StrategyRegistry';
import { quantStrategyExperimentService } from './QuantStrategyExperimentService';

type ParamSuggestionPayload = Awaited<
  ReturnType<typeof quantStrategyExperimentService.getParamsByStrategySuggestion>
>;

type ParamVersionPlain = {
  version_key: string;
  strategy_key: string;
  strategy_name?: string;
  version_type: string;
  status: string;
  params_json: Record<string, any>;
  source_experiment_id?: number;
  source_experiment_key?: string;
  source_rank_score?: number;
  source_excess_return_pct?: number;
  source_max_drawdown_pct?: number;
  source_trade_count?: number;
  adoption_reason?: string;
  active_from?: string;
  active_to?: string;
  metadata?: Record<string, any>;
};

function asPlainObject(value: any): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function toNumber(value: any, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toPositiveInt(value: any, fallback: number, max?: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  const normalized = Math.floor(parsed);
  return max ? Math.min(normalized, max) : normalized;
}

function dateOnly(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function stableStringify(value: any): string {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item)).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function shortHash(value: any, length = 10): string {
  return createHash('sha1').update(stableStringify(value)).digest('hex').slice(0, length);
}

function modelToPlain<T = any>(record: any): T {
  if (!record) return record;
  if (typeof record.toJSON === 'function') return record.toJSON();
  return record;
}

function buildDefaultVersionKey(strategy_key: string) {
  return `qparam_${strategy_key}_default`;
}

function buildExperimentVersionKey(strategy_key: string, sourceKey: string | undefined, params: any) {
  const suffix = sourceKey ? sourceKey.replace(/^qexp_/, '') : shortHash(params);
  return `qparam_${strategy_key}_exp_${suffix}`.slice(0, 120);
}

function buildManualVersionKey(strategy_key: string, params: any) {
  return `qparam_${strategy_key}_manual_${shortHash(params)}`.slice(0, 120);
}

function addCalendarDays(date: string, days: number) {
  return moment(date).add(days, 'days').format('YYYY-MM-DD');
}

function summarizeValidationRows(rows: any[], versionByKey: Map<string, any>) {
  const total = rows.length;
  const completed = rows.filter(row => row.status === 'completed');
  const pending = rows.filter(row => row.status === 'pending');
  const noData = rows.filter(row => row.status === 'no_data');
  const wins = completed.filter(row => toNumber(row.return_pct) > 0);
  const excessWins = completed.filter(row => toNumber(row.excess_return_pct) > 0);
  const avgReturn = completed.length
    ? completed.reduce((sum, row) => sum + toNumber(row.return_pct), 0) / completed.length
    : 0;
  const avgExcess = completed.length
    ? completed.reduce((sum, row) => sum + toNumber(row.excess_return_pct), 0) / completed.length
    : 0;
  const winRate = completed.length ? (wins.length / completed.length) * 100 : 0;
  const excessWinRate = completed.length ? (excessWins.length / completed.length) * 100 : 0;
  const avgBenchmark = completed.length
    ? completed.reduce((sum, row) => sum + toNumber(row.benchmark_return_pct), 0) /
      completed.length
    : 0;
  const version = versionByKey.get(rows[0]?.version_key);
  const sampleConfidence = Math.min(1, completed.length / 20);
  const rankScore = round(
    avgExcess * 1.35 + (winRate - 50) * 0.08 + sampleConfidence * 6 - noData.length * 0.15,
    4
  );
  const best = [...completed].sort((a, b) => toNumber(b.return_pct) - toNumber(a.return_pct))[0];
  const worst = [...completed].sort((a, b) => toNumber(a.return_pct) - toNumber(b.return_pct))[0];
  return {
    version_key: rows[0]?.version_key,
    strategy_key: rows[0]?.strategy_key || version?.strategy_key,
    strategy_name: version?.strategy_name,
    version_type: version?.version_type,
    status: version?.status,
    total_count: total,
    completed_count: completed.length,
    pending_count: pending.length,
    no_data_count: noData.length,
    avg_return_pct: round(avgReturn, 4),
    avg_benchmark_return_pct: round(avgBenchmark, 4),
    avg_excess_return_pct: round(avgExcess, 4),
    win_rate: round(winRate, 2),
    excess_win_rate: round(excessWinRate, 2),
    rank_score: rankScore,
    best_symbol: best?.symbol,
    best_name: best?.name,
    best_return_pct: best ? round(toNumber(best.return_pct), 4) : undefined,
    worst_symbol: worst?.symbol,
    worst_name: worst?.name,
    worst_return_pct: worst ? round(toNumber(worst.return_pct), 4) : undefined,
  };
}

export class QuantStrategyParamVersionService {
  async refreshVersionsFromExperiments(
    options: {
      suggestions?: ParamSuggestionPayload | null;
      suggestion_options?: Record<string, any>;
      manual_params_by_strategy?: Record<string, Record<string, any>>;
      use_experiment_params?: boolean;
    } = {}
  ) {
    const today = moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
    const definitions = strategyRegistry.list();
    const manualParamsByStrategy = asPlainObject(options.manual_params_by_strategy);
    const suggestions =
      options.suggestions !== undefined
        ? options.suggestions
        : options.use_experiment_params === false
          ? null
          : await quantStrategyExperimentService.getParamsByStrategySuggestion(
              options.suggestion_options || {}
            );
    const suggestionByStrategy = new Map(
      ((suggestions as any)?.suggestions || []).map((item: any) => [item.strategy_key, item])
    );
    const recommendedParamsByStrategy = asPlainObject(
      (suggestions as any)?.recommended_params_by_strategy
    );

    const versions: QuantStrategyParamVersion[] = [];
    const adoptedByStrategy: Record<string, ParamVersionPlain> = {};
    const recommendedParamsForScan: Record<string, Record<string, any>> = {};

    for (const definition of definitions) {
      const defaultPayload = {
        version_key: buildDefaultVersionKey(definition.strategy_key),
        strategy_key: definition.strategy_key,
        strategy_name: definition.name,
        version_type: 'default',
        status: 'baseline',
        params_json: definition.default_params || {},
        active_from: today,
        metadata: {
          ab_group: 'default',
          source: 'strategy_default',
          risk_level: definition.risk_level,
          tags: definition.tags || [],
        },
      };
      const defaultVersion = await this.upsertVersion(defaultPayload);
      versions.push(defaultVersion);
      adoptedByStrategy[definition.strategy_key] = modelToPlain(defaultVersion);

      const suggestion = suggestionByStrategy.get(definition.strategy_key) as any;
      if (suggestion?.source_experiment) {
        const experimentParams = {
          ...(definition.default_params || {}),
          ...asPlainObject(suggestion.recommended_params),
        };
        const experimentPayload = {
          version_key: buildExperimentVersionKey(
            definition.strategy_key,
            suggestion.source_experiment?.experiment_key,
            experimentParams
          ),
          strategy_key: definition.strategy_key,
          strategy_name: definition.name,
          version_type: 'experiment',
          status: suggestion.action === 'use' ? 'active_candidate' : 'observing',
          params_json: experimentParams,
          source_experiment_id: suggestion.source_experiment?.id,
          source_experiment_key: suggestion.source_experiment?.experiment_key,
          source_rank_score: suggestion.source_experiment?.rank_score,
          source_excess_return_pct: suggestion.source_experiment?.excess_return_pct,
          source_max_drawdown_pct: suggestion.source_experiment?.max_drawdown_pct,
          source_trade_count: suggestion.source_experiment?.trade_count || 0,
          adoption_reason: suggestion.reason,
          active_from: today,
          metadata: {
            ab_group: suggestion.action === 'use' ? 'experiment_candidate' : 'experiment_observe',
            action: suggestion.action,
            confidence: suggestion.confidence,
            stable_count: suggestion.stable_count,
            experiment_count: suggestion.experiment_count,
            policy: (suggestions as any)?.policy,
          },
        };
        const experimentVersion = await this.upsertVersion(experimentPayload);
        versions.push(experimentVersion);
        if (options.use_experiment_params !== false && suggestion.action === 'use') {
          adoptedByStrategy[definition.strategy_key] = modelToPlain(experimentVersion);
          recommendedParamsForScan[definition.strategy_key] = experimentPayload.params_json;
        }
      }

      const manualParams = asPlainObject(manualParamsByStrategy[definition.strategy_key]);
      if (Object.keys(manualParams).length > 0) {
        const manualFullParams = {
          ...(definition.default_params || {}),
          ...manualParams,
        };
        const manualVersion = await this.upsertVersion({
          version_key: buildManualVersionKey(definition.strategy_key, manualFullParams),
          strategy_key: definition.strategy_key,
          strategy_name: definition.name,
          version_type: 'manual',
          status: 'manual_override',
          params_json: manualFullParams,
          active_from: today,
          adoption_reason: '任务参数手工覆盖，优先级高于实验建议。',
          metadata: {
            ab_group: 'manual_override',
            source: 'task_params_by_strategy',
          },
        });
        versions.push(manualVersion);
        adoptedByStrategy[definition.strategy_key] = modelToPlain(manualVersion);
        recommendedParamsForScan[definition.strategy_key] = manualFullParams;
      } else if (recommendedParamsByStrategy[definition.strategy_key]) {
        recommendedParamsForScan[definition.strategy_key] = asPlainObject(
          recommendedParamsByStrategy[definition.strategy_key]
        );
      }
    }

    const uniqueVersions = [...new Map(versions.map(item => [item.version_key, item])).values()];
    const activeCandidateCount = uniqueVersions.filter(
      item => item.status === 'active_candidate'
    ).length;
    const manualOverrideCount = uniqueVersions.filter(
      item => item.status === 'manual_override'
    ).length;

    return {
      generated_at: new Date().toISOString(),
      versions: uniqueVersions.map(item => modelToPlain(item)),
      adopted_param_version_by_strategy: adoptedByStrategy,
      recommended_params_by_strategy: recommendedParamsForScan,
      summary: {
        strategy_count: definitions.length,
        version_count: uniqueVersions.length,
        active_candidate_count: activeCandidateCount,
        manual_override_count: manualOverrideCount,
        conclusion:
          activeCandidateCount > 0
            ? `已生成 ${activeCandidateCount} 个实验候选参数版本，开盘扫描将按 A/B 验证持续跟踪。`
            : '暂无达到自动采用门槛的实验参数版本，继续以默认参数为基准验证。',
      },
    };
  }

  async createPendingValidationsFromSignals(
    options: {
      trade_date?: string;
      start_date?: string;
      end_date?: string;
      strategy_keys?: string[];
      horizons?: number[];
      limit?: number;
      signal?: string[];
    } = {}
  ) {
    const where: any = {};
    if (options.trade_date) where.trade_date = options.trade_date;
    if (options.start_date || options.end_date) {
      where.trade_date = {};
      if (options.start_date) where.trade_date[Op.gte] = options.start_date;
      if (options.end_date) where.trade_date[Op.lte] = options.end_date;
    }
    if (options.strategy_keys?.length) where.strategy_key = { [Op.in]: options.strategy_keys };
    where.signal = { [Op.in]: options.signal?.length ? options.signal : ['buy', 'watch'] };

    const signals = await QuantSignal.findAll({
      where,
      order: [
        ['trade_date', 'DESC'],
        ['score', 'DESC'],
      ],
      limit: toPositiveInt(options.limit, 500, 5000),
    });
    if (!signals.length) {
      return { created: 0, updated: 0, scanned: 0, horizons: options.horizons || [1, 3, 5, 10] };
    }

    const versions = await QuantStrategyParamVersion.findAll();
    const latestVersionByStrategy = new Map<string, QuantStrategyParamVersion>();
    for (const version of versions) {
      const existing = latestVersionByStrategy.get(version.strategy_key);
      const priority = this.versionPriority(version);
      const existingPriority = existing ? this.versionPriority(existing) : -1;
      if (!existing || priority > existingPriority) {
        latestVersionByStrategy.set(version.strategy_key, version);
      }
    }

    const horizons = (options.horizons?.length ? options.horizons : [1, 3, 5, 10])
      .map(item => toPositiveInt(item, 1, 60))
      .filter(Boolean);
    let created = 0;
    let updated = 0;

    for (const signal of signals) {
      const raw = asPlainObject(signal.raw_factors);
      const inferredVersion =
        raw.param_version_key ||
        latestVersionByStrategy.get(signal.strategy_key)?.version_key ||
        buildDefaultVersionKey(signal.strategy_key);
      for (const horizon of horizons) {
        const payload = {
          version_key: inferredVersion,
          strategy_key: signal.strategy_key,
          quant_signal_id: signal.id,
          symbol: normalizeSymbol(signal.symbol),
          name: signal.name,
          signal_date: signal.trade_date,
          entry_price: signal.entry_price,
          horizon_days: horizon,
          evaluation_date: addCalendarDays(signal.trade_date, horizon),
          status: 'pending',
          metadata: {
            source: 'quant_signal',
            quant_signal_score: signal.score,
            quant_signal: signal.signal,
            param_version_type: raw.param_version_type,
            param_version_status: raw.param_version_status,
          },
        };
        const [row, isCreated] = await QuantStrategyParamValidation.findOrCreate({
          where: {
            version_key: payload.version_key,
            symbol: payload.symbol,
            signal_date: payload.signal_date,
            horizon_days: payload.horizon_days,
          },
          defaults: payload as any,
        });
        if (isCreated) {
          created++;
        } else if (row.status === 'pending') {
          await row.update({
            quant_signal_id: payload.quant_signal_id,
            entry_price: row.entry_price || payload.entry_price,
            metadata: {
              ...(row.metadata || {}),
              ...payload.metadata,
            },
          } as any);
          updated++;
        }
      }
    }

    return { created, updated, scanned: signals.length, horizons };
  }

  async refreshValidationReturns(
    options: {
      limit?: number;
      status?: string[];
      include_completed?: boolean;
      auto_sync_benchmark?: boolean;
    } = {}
  ) {
    const statuses = options.status?.length
      ? options.status
      : options.include_completed
        ? ['pending', 'completed']
        : ['pending'];
    const rows = await QuantStrategyParamValidation.findAll({
      where: { status: { [Op.in]: statuses } },
      order: [
        ['signal_date', 'DESC'],
        ['id', 'ASC'],
      ],
      limit: toPositiveInt(options.limit, 1000, 10000),
    });

    let completed = 0;
    let pending = 0;
    let noData = 0;
    const touched: QuantStrategyParamValidation[] = [];
    const stockCache = new Map<string, Stock | null>();
    const barsCache = new Map<number, DailyBar[]>();

    for (const row of rows) {
      const symbol = normalizeSymbol(row.symbol);
      if (!stockCache.has(symbol)) {
        stockCache.set(symbol, await Stock.findOne({ where: { symbol } }));
      }
      const stock = stockCache.get(symbol);
      if (!stock) {
        await row.update({
          status: 'no_data',
          metadata: { ...(row.metadata || {}), no_data_reason: 'stock_not_found' },
        } as any);
        noData++;
        touched.push(row);
        continue;
      }

      if (!barsCache.has(stock.id)) {
        barsCache.set(
          stock.id,
          await DailyBar.findAll({
            where: {
              stock_id: stock.id,
              time: { [Op.gte]: new Date(`${row.signal_date}T00:00:00.000Z`) },
            },
            order: [['time', 'ASC']],
            limit: 160,
          })
        );
      }
      const bars = barsCache.get(stock.id) || [];
      const entryIndex = bars.findIndex(bar => dateOnly(bar.time) >= row.signal_date);
      if (entryIndex < 0) {
        await row.update({
          status: 'no_data',
          metadata: { ...(row.metadata || {}), no_data_reason: 'entry_bar_not_found' },
        } as any);
        noData++;
        touched.push(row);
        continue;
      }

      const entryBar = bars[entryIndex];
      const entryPrice = toNumber(row.entry_price, toNumber(entryBar.close));
      const exitIndex = entryIndex + toPositiveInt(row.horizon_days, 1, 60);
      const latestBar = bars[bars.length - 1];
      if (bars.length <= exitIndex) {
        const latestPrice = toNumber(latestBar?.close, entryPrice);
        const partialReturn = entryPrice > 0 ? ((latestPrice - entryPrice) / entryPrice) * 100 : 0;
        await row.update({
          entry_price: entryPrice,
          latest_price: latestPrice,
          return_pct: round(partialReturn, 4),
          status: 'pending',
          metadata: {
            ...(row.metadata || {}),
            partial: true,
            latest_bar_date: latestBar ? dateOnly(latestBar.time) : undefined,
            needed_trading_bars: row.horizon_days,
          },
        } as any);
        pending++;
        touched.push(row);
        continue;
      }

      const exitBar = bars[exitIndex];
      const exitDate = dateOnly(exitBar.time);
      const exitPrice = toNumber(exitBar.close);
      const returnPct = entryPrice > 0 ? ((exitPrice - entryPrice) / entryPrice) * 100 : 0;
      let benchmarkReturnPct = 0;
      let benchmark: any = null;
      try {
        benchmark = await benchmarkIndexService.getBenchmarkReturnForStock(
          symbol,
          row.signal_date,
          exitDate,
          { stock, auto_sync: Boolean(options.auto_sync_benchmark) }
        );
        benchmarkReturnPct = toNumber(benchmark?.benchmark_return_pct, 0);
      } catch (error: any) {
        logger.warn(`参数版本收益验证读取基准失败 ${symbol}: ${error?.message || error}`);
      }

      await row.update({
        entry_price: entryPrice,
        evaluation_date: exitDate,
        latest_price: exitPrice,
        return_pct: round(returnPct, 4),
        benchmark_return_pct: round(benchmarkReturnPct, 4),
        excess_return_pct: round(returnPct - benchmarkReturnPct, 4),
        status: 'completed',
        metadata: {
          ...(row.metadata || {}),
          partial: false,
          exit_bar_date: exitDate,
          benchmark,
        },
      } as any);
      completed++;
      touched.push(row);
    }

    return {
      refreshed: touched.length,
      completed,
      pending,
      no_data: noData,
      rows: touched.map(item => modelToPlain(item)),
    };
  }

  async getDashboard(options: { limit?: number; strategy_key?: string } = {}) {
    const versionWhere: any = {};
    const validationWhere: any = {};
    if (options.strategy_key) {
      versionWhere.strategy_key = options.strategy_key;
      validationWhere.strategy_key = options.strategy_key;
    }
    const [versions, validations] = await Promise.all([
      QuantStrategyParamVersion.findAll({
        where: versionWhere,
        order: [
          ['strategy_key', 'ASC'],
          ['status', 'ASC'],
          ['updated_at', 'DESC'],
        ],
        limit: toPositiveInt(options.limit, 200, 1000),
      }),
      QuantStrategyParamValidation.findAll({
        where: validationWhere,
        order: [
          ['signal_date', 'DESC'],
          ['horizon_days', 'ASC'],
        ],
        limit: toPositiveInt(options.limit, 1000, 5000),
      }),
    ]);
    const plainVersions = versions.map(item => modelToPlain<any>(item));
    const plainValidations = validations.map(item => modelToPlain<any>(item));
    const versionByKey = new Map(plainVersions.map(item => [item.version_key, item]));
    const groupedByVersion = new Map<string, any[]>();
    for (const row of plainValidations) {
      if (!groupedByVersion.has(row.version_key)) groupedByVersion.set(row.version_key, []);
      groupedByVersion.get(row.version_key)!.push(row);
    }
    const summaryByVersion = [...groupedByVersion.values()]
      .map(rows => summarizeValidationRows(rows, versionByKey))
      .sort((a, b) => toNumber(b.rank_score) - toNumber(a.rank_score));
    const groupedByStrategy = new Map<string, any[]>();
    for (const item of summaryByVersion) {
      if (!groupedByStrategy.has(item.strategy_key)) groupedByStrategy.set(item.strategy_key, []);
      groupedByStrategy.get(item.strategy_key)!.push(item);
    }
    const summaryByStrategy = [...groupedByStrategy.entries()].map(([strategy_key, rows]) => {
      const champion = [...rows].sort((a, b) => toNumber(b.rank_score) - toNumber(a.rank_score))[0];
      return {
        strategy_key,
        strategy_name: champion?.strategy_name,
        version_count: rows.length,
        champion,
        avg_excess_return_pct: round(
          rows.reduce((sum, item) => sum + toNumber(item.avg_excess_return_pct), 0) /
            Math.max(rows.length, 1),
          4
        ),
      };
    });
    const champion = summaryByVersion.find(item => item.completed_count > 0) || null;
    const completedCount = plainValidations.filter(item => item.status === 'completed').length;
    const pendingCount = plainValidations.filter(item => item.status === 'pending').length;
    const activeCandidateCount = plainVersions.filter(
      item => item.status === 'active_candidate'
    ).length;

    return {
      generated_at: new Date().toISOString(),
      versions: plainVersions,
      validations: plainValidations,
      summary_by_version: summaryByVersion,
      summary_by_strategy: summaryByStrategy,
      champion,
      summary: {
        version_count: plainVersions.length,
        active_candidate_count: activeCandidateCount,
        validation_count: plainValidations.length,
        completed_count: completedCount,
        pending_count: pendingCount,
        conclusion: champion
          ? `当前参数 A/B 冠军为 ${champion.strategy_name || champion.strategy_key} / ${
              champion.version_key
            }，平均超额 ${champion.avg_excess_return_pct}%（样本 ${
              champion.completed_count
            }）。`
          : pendingCount > 0
            ? '参数版本已开始留痕，等待 1/3/5/10 日收益样本完成。'
            : '参数版本验证尚未产生样本；下一次量化扫描后会自动创建待验证记录。',
      },
    };
  }

  private async upsertVersion(payload: Record<string, any>) {
    const [record, created] = await QuantStrategyParamVersion.findOrCreate({
      where: { version_key: payload.version_key },
      defaults: payload as any,
    });
    if (!created) {
      await record.update({
        ...payload,
        active_from: record.active_from || payload.active_from,
      } as any);
    }
    return record;
  }

  private versionPriority(version: QuantStrategyParamVersion) {
    const status = String(version.status || '').toLowerCase();
    const type = String(version.version_type || '').toLowerCase();
    if (status === 'manual_override' || type === 'manual') return 40;
    if (status === 'active_candidate') return 30;
    if (status === 'observing') return 20;
    if (status === 'baseline') return 10;
    return 0;
  }
}

export const quantStrategyParamVersionService = new QuantStrategyParamVersionService();
