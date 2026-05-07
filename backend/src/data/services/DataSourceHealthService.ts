import { DataSourceHealth, DataSourceStatus } from '../../models/DataSourceHealth';
import { logger } from '../../utils/logger';
import axios from 'axios';
import { MarketDataProviderDefinition, MarketDataFeature } from '../sources/MarketDataProvider';

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
    supported_features: ['stock_list', 'history_k', 'stock_basic', 'realtime_quote', 'intraday_bar'],
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
      const nextStatus = consecutiveFailures >= 3 ? DataSourceStatus.UNHEALTHY : DataSourceStatus.DEGRADED;
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

  static async probeTradingAgents(): Promise<void> {
    const provider = DEFAULT_DATA_PROVIDERS.find(item => item.provider_name === 'tradingagents');
    if (!provider) {
      return;
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
    } catch (error: any) {
      await this.recordFailure(provider, 'health_probe', error, Date.now() - startedAt, {
        base_url: baseUrl,
      });
    }
  }

  static async refreshExternalProviderHealth(): Promise<void> {
    await Promise.allSettled([this.probeTradingAgents()]);
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
