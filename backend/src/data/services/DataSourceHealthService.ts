import { DataSourceHealth, DataSourceStatus } from '../../models/DataSourceHealth';
import { logger } from '../../utils/logger';
import axios from 'axios';
import { MarketDataProviderDefinition, MarketDataFeature } from '../sources/MarketDataProvider';
import { AKShareClient } from '../sources/AKShareClient';
import { EastMoneyClient } from '../sources/EastMoneyClient';
import { SinaFinanceClient } from '../sources/SinaFinanceClient';
import { BaostockClient } from '../sources/BaostockClient';
import { TushareClient } from '../sources/TushareClient';
import { TencentFinanceClient } from '../sources/TencentFinanceClient';

const hasTushareToken = Boolean(process.env.TUSHARE_TOKEN || process.env.TUSHARE_PRO_TOKEN);
const tushareEnabled = process.env.TUSHARE_ENABLED === 'true' && hasTushareToken;
const baostockEnabled = process.env.BAOSTOCK_ENABLED === 'true';

export const DEFAULT_DATA_PROVIDERS: MarketDataProviderDefinition[] = [
  {
    provider_name: 'tushare',
    provider_label: 'Tushare Pro',
    provider_type: 'api',
    priority: 10,
    is_enabled: tushareEnabled,
    supported_features: ['stock_list', 'history_k', 'stock_basic'],
    metadata: {
      requires_token: true,
      env_token: 'TUSHARE_TOKEN',
      enable_env: 'TUSHARE_ENABLED=true',
    },
  },
  {
    provider_name: 'baostock',
    provider_label: 'Baostock',
    provider_type: 'python',
    priority: 20,
    is_enabled: baostockEnabled,
    supported_features: ['stock_list', 'history_k', 'stock_basic', 'trade_calendar'],
    metadata: {
      python_package: 'baostock',
      enable_env: 'BAOSTOCK_ENABLED=true',
    },
  },
  {
    provider_name: 'akshare',
    provider_label: 'AKShare',
    provider_type: 'python',
    priority: 30,
    is_enabled: true,
    supported_features: [
      'stock_list',
      'history_k',
      'stock_basic',
      'realtime_quote',
      'intraday_bar',
    ],
    metadata: {
      python_package: 'akshare',
      role: 'primary_free_source',
    },
  },
  {
    provider_name: 'eastmoney',
    provider_label: '东方财富',
    provider_type: 'api',
    priority: 40,
    is_enabled: true,
    supported_features: ['stock_list', 'history_k', 'stock_basic'],
    metadata: {
      role: 'fast_http_fallback',
    },
  },
  {
    provider_name: 'tencent',
    provider_label: '腾讯行情',
    provider_type: 'api',
    priority: 45,
    is_enabled: true,
    supported_features: ['history_k'],
    metadata: {
      role: 'fast_incremental_history_source',
    },
  },
  {
    provider_name: 'sina',
    provider_label: '新浪财经',
    provider_type: 'api',
    priority: 50,
    is_enabled: true,
    supported_features: ['stock_list', 'history_k'],
    metadata: {
      role: 'last_resort_fallback',
    },
  },
  {
    provider_name: 'tradingagents',
    provider_label: 'TradingAgents',
    provider_type: 'analysis',
    priority: 80,
    is_enabled: true,
    supported_features: ['health_probe'],
    metadata: {
      base_url: process.env.TRADING_AGENTS_URL || 'http://47.93.224.109:8000',
      role: 'multi_agent_research',
    },
  },
];

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Number(score.toFixed(2))));
}

function toPlainRecord(record: DataSourceHealth): any {
  const json = record.toJSON() as any;
  return {
    ...json,
    health_score: Number(json.health_score ?? 0),
    success_count: Number(json.success_count ?? 0),
    failure_count: Number(json.failure_count ?? 0),
    consecutive_failures: Number(json.consecutive_failures ?? 0),
    priority: Number(json.priority ?? 100),
    last_latency_ms:
      json.last_latency_ms === null || json.last_latency_ms === undefined
        ? null
        : Number(json.last_latency_ms),
  };
}

function toNumber(value: any, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function parsePreference(value?: string): string[] {
  return String(value || '')
    .split(',')
    .map(item => item.trim().toLowerCase())
    .filter(item => item && item !== 'auto');
}

function statusScore(status?: string): number {
  switch (status) {
    case DataSourceStatus.HEALTHY:
      return 40;
    case DataSourceStatus.UNKNOWN:
      return 8;
    case DataSourceStatus.DEGRADED:
      return -18;
    case DataSourceStatus.UNHEALTHY:
      return -70;
    case DataSourceStatus.DISABLED:
      return -999;
    default:
      return 0;
  }
}

function latencyScore(latency_ms?: number | null): number {
  if (latency_ms === null || latency_ms === undefined) return 0;
  if (latency_ms <= 1000) return 6;
  if (latency_ms <= 5000) return 3;
  if (latency_ms <= 15000) return -2;
  if (latency_ms <= 30000) return -8;
  return -15;
}

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

function getProbeDateRange(): { start_date: string; end_date: string } {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 45);
  return {
    start_date: formatDate(start),
    end_date: formatDate(end),
  };
}

export class DataSourceHealthService {
  private static ensurePromise: Promise<void> | null = null;

  static async ensureTable(): Promise<void> {
    if (!this.ensurePromise) {
      this.ensurePromise = (async () => {
        await DataSourceHealth.sync();
        await this.seedDefaultProviders();
      })().catch(error => {
        this.ensurePromise = null;
        throw error;
      });
    }

    await this.ensurePromise;
  }

  static getDefaultProviders(): MarketDataProviderDefinition[] {
    return DEFAULT_DATA_PROVIDERS.map(provider => ({
      ...provider,
      metadata: { ...(provider.metadata || {}) },
      supported_features: [...provider.supported_features],
    }));
  }

  static async seedDefaultProviders(): Promise<void> {
    for (const provider of DEFAULT_DATA_PROVIDERS) {
      const defaults = {
        provider_name: provider.provider_name,
        provider_label: provider.provider_label,
        provider_type: provider.provider_type,
        status: provider.is_enabled ? DataSourceStatus.UNKNOWN : DataSourceStatus.DISABLED,
        priority: provider.priority,
        is_enabled: provider.is_enabled,
        supported_features: provider.supported_features,
        health_score: provider.is_enabled ? 60 : 0,
        success_count: 0,
        failure_count: 0,
        consecutive_failures: 0,
        metadata: provider.metadata || {},
      };

      const [record, created] = await DataSourceHealth.findOrCreate({
        where: { provider_name: provider.provider_name },
        defaults,
      });

      if (!created) {
        const existingMetadata = (record.metadata || {}) as Record<string, any>;
        await record.update({
          provider_label: provider.provider_label,
          provider_type: provider.provider_type,
          priority: provider.priority,
          is_enabled: provider.is_enabled,
          supported_features: provider.supported_features,
          status: provider.is_enabled
            ? record.status === DataSourceStatus.DISABLED
              ? DataSourceStatus.UNKNOWN
              : record.status
            : DataSourceStatus.DISABLED,
          metadata: {
            ...existingMetadata,
            ...(provider.metadata || {}),
          },
        });
      }
    }
  }

  private static async getOrCreateProvider(
    provider: MarketDataProviderDefinition
  ): Promise<DataSourceHealth> {
    await this.ensureTable();

    const [record] = await DataSourceHealth.findOrCreate({
      where: { provider_name: provider.provider_name },
      defaults: {
        provider_name: provider.provider_name,
        provider_label: provider.provider_label,
        provider_type: provider.provider_type,
        status: provider.is_enabled ? DataSourceStatus.UNKNOWN : DataSourceStatus.DISABLED,
        priority: provider.priority,
        is_enabled: provider.is_enabled,
        supported_features: provider.supported_features,
        health_score: provider.is_enabled ? 60 : 0,
        success_count: 0,
        failure_count: 0,
        consecutive_failures: 0,
        metadata: provider.metadata || {},
      },
    });

    return record;
  }

  static async recordSuccess(
    provider: MarketDataProviderDefinition,
    feature: MarketDataFeature,
    latency_ms: number,
    metadata: Record<string, any> = {}
  ): Promise<void> {
    try {
      const record = await this.getOrCreateProvider(provider);
      const currentScore = Number(record.health_score ?? 60);
      const latencyPenalty = latency_ms > 15000 ? 5 : latency_ms > 5000 ? 2 : 0;
      const nextScore = clampScore(currentScore + 4 - latencyPenalty);
      const existingMetadata = (record.metadata || {}) as Record<string, any>;

      await record.update({
        provider_label: provider.provider_label,
        provider_type: provider.provider_type,
        priority: provider.priority,
        is_enabled: provider.is_enabled,
        supported_features: provider.supported_features,
        status: provider.is_enabled ? DataSourceStatus.HEALTHY : DataSourceStatus.DISABLED,
        health_score: nextScore,
        success_count: Number(record.success_count || 0) + 1,
        consecutive_failures: 0,
        last_success_at: new Date(),
        last_checked_at: new Date(),
        last_latency_ms: Math.max(0, Math.round(latency_ms)),
        last_error: null,
        metadata: {
          ...existingMetadata,
          ...(provider.metadata || {}),
          ...metadata,
          last_feature: feature,
        },
      });
    } catch (error: any) {
      logger.warn(`记录数据源 ${provider.provider_name} 成功状态失败: ${error.message}`);
    }
  }

  static async recordEmptyResult(
    provider: MarketDataProviderDefinition,
    feature: MarketDataFeature,
    latency_ms: number,
    metadata: Record<string, any> = {}
  ): Promise<void> {
    try {
      const record = await this.getOrCreateProvider(provider);
      const currentScore = Number(record.health_score ?? 60);
      const existingMetadata = (record.metadata || {}) as Record<string, any>;

      await record.update({
        provider_label: provider.provider_label,
        provider_type: provider.provider_type,
        priority: provider.priority,
        is_enabled: provider.is_enabled,
        supported_features: provider.supported_features,
        status: provider.is_enabled ? DataSourceStatus.DEGRADED : DataSourceStatus.DISABLED,
        health_score: clampScore(currentScore - 2),
        last_checked_at: new Date(),
        last_latency_ms: Math.max(0, Math.round(latency_ms)),
        metadata: {
          ...existingMetadata,
          ...(provider.metadata || {}),
          ...metadata,
          last_feature: feature,
          last_empty_at: new Date().toISOString(),
        },
      });
    } catch (error: any) {
      logger.warn(`记录数据源 ${provider.provider_name} 空结果状态失败: ${error.message}`);
    }
  }

  static async recordFailure(
    provider: MarketDataProviderDefinition,
    feature: MarketDataFeature,
    error: Error | string,
    latency_ms = 0,
    metadata: Record<string, any> = {}
  ): Promise<void> {
    try {
      const record = await this.getOrCreateProvider(provider);
      const currentScore = Number(record.health_score ?? 60);
      const consecutiveFailures = Number(record.consecutive_failures || 0) + 1;
      const nextStatus =
        consecutiveFailures >= 3 ? DataSourceStatus.UNHEALTHY : DataSourceStatus.DEGRADED;
      const errorMessage = typeof error === 'string' ? error : error.message;
      const existingMetadata = (record.metadata || {}) as Record<string, any>;

      await record.update({
        provider_label: provider.provider_label,
        provider_type: provider.provider_type,
        priority: provider.priority,
        is_enabled: provider.is_enabled,
        supported_features: provider.supported_features,
        status: provider.is_enabled ? nextStatus : DataSourceStatus.DISABLED,
        health_score: clampScore(currentScore - (consecutiveFailures >= 3 ? 18 : 10)),
        failure_count: Number(record.failure_count || 0) + 1,
        consecutive_failures: consecutiveFailures,
        last_failure_at: new Date(),
        last_checked_at: new Date(),
        last_latency_ms: Math.max(0, Math.round(latency_ms)),
        last_error: errorMessage.slice(0, 2000),
        metadata: {
          ...existingMetadata,
          ...(provider.metadata || {}),
          ...metadata,
          last_feature: feature,
        },
      });
    } catch (recordError: any) {
      logger.warn(`记录数据源 ${provider.provider_name} 失败状态失败: ${recordError.message}`);
    }
  }

  static async recordDisabled(
    provider: MarketDataProviderDefinition,
    feature: MarketDataFeature,
    reason: string
  ): Promise<void> {
    try {
      const record = await this.getOrCreateProvider({ ...provider, is_enabled: false });
      const existingMetadata = (record.metadata || {}) as Record<string, any>;
      await record.update({
        provider_label: provider.provider_label,
        provider_type: provider.provider_type,
        priority: provider.priority,
        is_enabled: false,
        supported_features: provider.supported_features,
        status: DataSourceStatus.DISABLED,
        health_score: 0,
        last_checked_at: new Date(),
        last_error: reason,
        metadata: {
          ...existingMetadata,
          ...(provider.metadata || {}),
          last_feature: feature,
          disabled_reason: reason,
        },
      });
    } catch (error: any) {
      logger.warn(`记录数据源 ${provider.provider_name} 禁用状态失败: ${error.message}`);
    }
  }

  private static async withTimeout<T>(
    promise: Promise<T>,
    timeout_ms: number,
    label: string
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${label} timeout after ${timeout_ms}ms`)),
            timeout_ms
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  static async probeTradingAgents(): Promise<Record<string, any>> {
    const provider = DEFAULT_DATA_PROVIDERS.find(item => item.provider_name === 'tradingagents');
    if (!provider) {
      return { provider_name: 'tradingagents', status: DataSourceStatus.DISABLED };
    }

    const startedAt = Date.now();
    const baseUrl = provider.metadata?.base_url || 'http://47.93.224.109:8000';

    try {
      const response = await axios.get(`${baseUrl}/openapi.json`, { timeout: 5000 });
      const paths = Object.keys(response.data?.paths || {});
      await this.recordSuccess(provider, 'health_probe', Date.now() - startedAt, {
        base_url: baseUrl,
        exposed_paths: paths.slice(0, 20),
        api_title: response.data?.info?.title,
        api_version: response.data?.info?.version,
      });
      return {
        provider_name: provider.provider_name,
        status: DataSourceStatus.HEALTHY,
        latency_ms: Date.now() - startedAt,
        exposed_paths: paths.slice(0, 20),
      };
    } catch (error: any) {
      await this.recordFailure(provider, 'health_probe', error, Date.now() - startedAt, {
        base_url: baseUrl,
      });
      return {
        provider_name: provider.provider_name,
        status: DataSourceStatus.UNHEALTHY,
        latency_ms: Date.now() - startedAt,
        error: error.message,
      };
    }
  }

  private static async probeSingleMarketProvider(
    provider: MarketDataProviderDefinition,
    options: { sample_symbol: string; timeout_ms: number; start_date: string; end_date: string }
  ): Promise<Record<string, any>> {
    const startedAt = Date.now();
    const feature: MarketDataFeature = provider.supported_features.includes('history_k')
      ? 'history_k'
      : provider.supported_features[0];

    if (!provider.is_enabled) {
      const reason = `${provider.provider_label} 未启用或缺少配置`;
      await this.recordDisabled(provider, feature, reason);
      return {
        provider_name: provider.provider_name,
        provider_label: provider.provider_label,
        status: DataSourceStatus.DISABLED,
        sample_symbol: options.sample_symbol,
        error: reason,
      };
    }

    try {
      let sampleSize = 0;
      let latestDate: string | undefined;
      let probeDetail: Record<string, any> = {};

      if (provider.provider_name === 'akshare') {
        const result = await this.withTimeout(
          new AKShareClient().healthCheck(
            options.sample_symbol,
            options.start_date,
            options.end_date
          ),
          options.timeout_ms,
          'AKShare health probe'
        );
        sampleSize = Number(result?.bar_count || 0);
        latestDate = result?.latest_date;
        probeDetail = result || {};
      } else if (provider.provider_name === 'eastmoney') {
        const bars = await this.withTimeout(
          new EastMoneyClient(undefined, options.timeout_ms).queryHistoryKData(
            options.sample_symbol,
            options.start_date,
            options.end_date,
            'd',
            '3'
          ),
          options.timeout_ms,
          'EastMoney health probe'
        );
        sampleSize = Array.isArray(bars) ? bars.length : 0;
        latestDate = bars?.[bars.length - 1]?.date;
      } else if (provider.provider_name === 'sina') {
        const bars = await this.withTimeout(
          new SinaFinanceClient(undefined, options.timeout_ms).queryHistoryKData(
            options.sample_symbol,
            options.start_date,
            options.end_date,
            'd',
            '3'
          ),
          options.timeout_ms,
          'Sina health probe'
        );
        sampleSize = Array.isArray(bars) ? bars.length : 0;
        latestDate = bars?.[bars.length - 1]?.date;
      } else if (provider.provider_name === 'tencent') {
        const bars = await this.withTimeout(
          new TencentFinanceClient(options.timeout_ms).queryHistoryKData(
            options.sample_symbol,
            options.start_date,
            options.end_date,
            'd',
            '3'
          ),
          options.timeout_ms,
          'Tencent Finance health probe'
        );
        sampleSize = Array.isArray(bars) ? bars.length : 0;
        latestDate = bars?.[bars.length - 1]?.date;
      } else if (provider.provider_name === 'baostock') {
        const bars = await this.withTimeout(
          new BaostockClient().queryHistoryKData(
            options.sample_symbol,
            options.start_date,
            options.end_date,
            'd',
            '3'
          ),
          options.timeout_ms,
          'Baostock health probe'
        );
        sampleSize = Array.isArray(bars) ? bars.length : 0;
        latestDate = bars?.[bars.length - 1]?.date;
      } else if (provider.provider_name === 'tushare') {
        const bars = await this.withTimeout(
          new TushareClient().queryHistoryKData(
            options.sample_symbol,
            options.start_date,
            options.end_date,
            'd',
            '3'
          ),
          options.timeout_ms,
          'Tushare health probe'
        );
        sampleSize = Array.isArray(bars) ? bars.length : 0;
        latestDate = bars?.[bars.length - 1]?.date;
      } else {
        throw new Error(`Unsupported market provider probe: ${provider.provider_name}`);
      }

      const latencyMs = Date.now() - startedAt;
      const metadata = {
        probe_kind: 'active_history_probe',
        sample_symbol: options.sample_symbol,
        probe_start_date: options.start_date,
        probe_end_date: options.end_date,
        sample_size: sampleSize,
        latest_date: latestDate,
        ...probeDetail,
      };

      if (sampleSize > 0) {
        await this.recordSuccess(provider, feature, latencyMs, metadata);
        return {
          provider_name: provider.provider_name,
          provider_label: provider.provider_label,
          status: DataSourceStatus.HEALTHY,
          latency_ms: latencyMs,
          sample_symbol: options.sample_symbol,
          sample_size: sampleSize,
          latest_date: latestDate,
        };
      }

      await this.recordEmptyResult(provider, feature, latencyMs, metadata);
      return {
        provider_name: provider.provider_name,
        provider_label: provider.provider_label,
        status: DataSourceStatus.DEGRADED,
        latency_ms: latencyMs,
        sample_symbol: options.sample_symbol,
        sample_size: 0,
        error: '探测样本返回空结果',
      };
    } catch (error: any) {
      const latencyMs = Date.now() - startedAt;
      await this.recordFailure(provider, feature, error, latencyMs, {
        probe_kind: 'active_history_probe',
        sample_symbol: options.sample_symbol,
        probe_start_date: options.start_date,
        probe_end_date: options.end_date,
      });
      return {
        provider_name: provider.provider_name,
        provider_label: provider.provider_label,
        status: DataSourceStatus.UNHEALTHY,
        latency_ms: latencyMs,
        sample_symbol: options.sample_symbol,
        error: error.message,
      };
    }
  }

  static async probeMarketDataProviders(
    options: { sample_symbol?: string; timeout_ms?: number } = {}
  ): Promise<Record<string, any>[]> {
    const { start_date, end_date } = getProbeDateRange();
    const sample_symbol =
      options.sample_symbol || process.env.DATA_SOURCE_PROBE_SYMBOL || 'sh.600000';
    const timeout_ms = Math.min(Math.max(options.timeout_ms || 12000, 3000), 30000);
    const marketProviders = DEFAULT_DATA_PROVIDERS.filter(
      provider => provider.provider_type !== 'analysis'
    );

    const results = await Promise.allSettled(
      marketProviders.map(provider =>
        this.probeSingleMarketProvider(provider, {
          sample_symbol,
          timeout_ms,
          start_date,
          end_date,
        })
      )
    );

    return results.map((result, index) => {
      if (result.status === 'fulfilled') return result.value;
      const provider = marketProviders[index];
      return {
        provider_name: provider.provider_name,
        provider_label: provider.provider_label,
        status: DataSourceStatus.UNHEALTHY,
        error: result.reason?.message || '探测失败',
      };
    });
  }

  static async refreshExternalProviderHealth(): Promise<Record<string, any>> {
    const [marketProviders, tradingAgents] = await Promise.allSettled([
      this.probeMarketDataProviders(),
      this.probeTradingAgents(),
    ]);

    return {
      market_providers:
        marketProviders.status === 'fulfilled'
          ? marketProviders.value
          : [{ status: DataSourceStatus.UNHEALTHY, error: marketProviders.reason?.message }],
      analysis_providers:
        tradingAgents.status === 'fulfilled'
          ? [tradingAgents.value]
          : [
              {
                provider_name: 'tradingagents',
                status: DataSourceStatus.UNHEALTHY,
                error: tradingAgents.reason?.message,
              },
            ],
    };
  }

  /**
   * 根据健康分、近期错误、延迟和显式偏好为某个数据能力生成动态路由计划。
   * 该方法不会禁用任何 fallback，只是将近期成功率更高的源前置，将异常源后置。
   */
  static async getRankedProviders(
    feature: MarketDataFeature,
    provider_names?: string[],
    options: {
      preferred_provider?: string;
      configured_preference?: string[];
      include_disabled?: boolean;
    } = {}
  ): Promise<any[]> {
    const snapshots = await this.getHealthSnapshots();
    const snapshotMap = new Map<string, any>(
      snapshots.map(item => [String(item.provider_name).toLowerCase(), item])
    );
    const defaultMap = new Map<string, MarketDataProviderDefinition>(
      DEFAULT_DATA_PROVIDERS.map(provider => [provider.provider_name, provider])
    );
    const candidateNames =
      provider_names && provider_names.length > 0
        ? provider_names.map(item => item.toLowerCase())
        : DEFAULT_DATA_PROVIDERS.filter(provider =>
            provider.supported_features.includes(feature)
          ).map(provider => provider.provider_name);

    const envPreference = parsePreference(process.env.DATA_SOURCE_PREFERENCE);
    const configuredPreference = options.configured_preference?.length
      ? options.configured_preference.map(item => item.toLowerCase())
      : envPreference;
    const preferredProvider =
      options.preferred_provider && options.preferred_provider !== 'auto'
        ? options.preferred_provider.toLowerCase()
        : '';

    const ranked = candidateNames
      .map(provider_name => {
        const defaultProvider = defaultMap.get(provider_name);
        const snapshot = snapshotMap.get(provider_name);
        const supported_features =
          snapshot?.supported_features || defaultProvider?.supported_features || [];
        const is_supported = supported_features.includes(feature);
        const is_enabled = snapshot?.is_enabled ?? defaultProvider?.is_enabled ?? false;
        const status =
          snapshot?.status || (is_enabled ? DataSourceStatus.UNKNOWN : DataSourceStatus.DISABLED);
        const priority = toNumber(snapshot?.priority ?? defaultProvider?.priority, 100);
        const health_score = toNumber(snapshot?.health_score, is_enabled ? 60 : 0);
        const consecutive_failures = toNumber(snapshot?.consecutive_failures, 0);
        const success_count = toNumber(snapshot?.success_count, 0);
        const failure_count = toNumber(snapshot?.failure_count, 0);
        const last_latency_ms =
          snapshot?.last_latency_ms === null || snapshot?.last_latency_ms === undefined
            ? null
            : toNumber(snapshot.last_latency_ms, 0);
        const preferenceIndex = configuredPreference.indexOf(provider_name);
        const manualPreferenceScore = preferredProvider === provider_name ? 500 : 0;
        const envPreferenceScore =
          preferenceIndex >= 0 ? Math.max(20, 90 - preferenceIndex * 12) : 0;
        const priorityScore = Math.max(0, 70 - priority) * 0.25;
        const recentReliabilityScore = Math.min(success_count, 20) * 0.8 - failure_count * 0.6;
        const route_score = Number(
          (
            health_score +
            statusScore(status) +
            latencyScore(last_latency_ms) +
            priorityScore +
            recentReliabilityScore +
            manualPreferenceScore +
            envPreferenceScore -
            consecutive_failures * 8
          ).toFixed(2)
        );

        return {
          provider_name,
          provider_label:
            snapshot?.provider_label || defaultProvider?.provider_label || provider_name,
          provider_type: snapshot?.provider_type || defaultProvider?.provider_type || 'api',
          feature,
          status,
          priority,
          is_enabled,
          is_supported,
          health_score,
          route_score,
          success_count,
          failure_count,
          consecutive_failures,
          last_latency_ms,
          last_checked_at: snapshot?.last_checked_at || null,
          last_error: snapshot?.last_error || null,
          preference_rank: preferenceIndex >= 0 ? preferenceIndex + 1 : null,
          is_preferred: preferredProvider === provider_name,
        };
      })
      .filter(item => item.is_supported)
      .filter(item => options.include_disabled || item.is_enabled);

    ranked.sort((a, b) => {
      if (a.is_enabled !== b.is_enabled) return a.is_enabled ? -1 : 1;
      if (a.status === DataSourceStatus.DISABLED && b.status !== DataSourceStatus.DISABLED)
        return 1;
      if (b.status === DataSourceStatus.DISABLED && a.status !== DataSourceStatus.DISABLED)
        return -1;
      if (a.route_score !== b.route_score) return b.route_score - a.route_score;
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.provider_name.localeCompare(b.provider_name);
    });

    return ranked.map((item, index) => ({
      ...item,
      rank: index + 1,
      route_reason: this.buildRoutingReason(item),
    }));
  }

  static buildRoutingReason(item: any): string {
    if (!item.is_enabled) return '数据源未启用，仅保留为可配置备选';
    if (item.is_preferred) return '用户显式指定优先源，失败后仍会自动 fallback';
    if (item.status === DataSourceStatus.HEALTHY) {
      return item.last_latency_ms
        ? `近期成功且延迟 ${item.last_latency_ms}ms，优先使用`
        : '近期成功，优先使用';
    }
    if (item.status === DataSourceStatus.UNKNOWN) return '尚无近期探测结果，作为中性备选';
    if (item.status === DataSourceStatus.DEGRADED) return '近期存在空结果或失败，降级为后备';
    if (item.status === DataSourceStatus.UNHEALTHY) return '连续失败较多，仅在其他源不可用时兜底';
    return '按默认优先级参与 fallback';
  }

  static async getRoutingPlans(
    features: MarketDataFeature[] = ['stock_list', 'history_k', 'stock_basic']
  ): Promise<Record<string, any[]>> {
    const plans: Record<string, any[]> = {};
    for (const feature of features) {
      plans[feature] = await this.getRankedProviders(feature, undefined, {
        include_disabled: true,
      });
    }
    return plans;
  }

  static async getHealthSnapshots(): Promise<any[]> {
    try {
      await this.ensureTable();
      const records = await DataSourceHealth.findAll({
        order: [
          ['priority', 'ASC'],
          ['provider_name', 'ASC'],
        ],
      });
      return records.map(toPlainRecord);
    } catch (error: any) {
      logger.warn(`获取数据源健康状态失败: ${error.message}`);
      return DEFAULT_DATA_PROVIDERS.map(provider => ({
        ...provider,
        id: null,
        status: provider.is_enabled ? DataSourceStatus.UNKNOWN : DataSourceStatus.DISABLED,
        health_score: provider.is_enabled ? 60 : 0,
        success_count: 0,
        failure_count: 0,
        consecutive_failures: 0,
        last_success_at: null,
        last_failure_at: null,
        last_latency_ms: null,
        last_checked_at: null,
        last_error: error.message,
        created_at: null,
        updated_at: null,
      }));
    }
  }
}
