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
    supported_features: [
      'stock_list',
      'history_k',
      'stock_basic',
      'index_constituents',
      'fundamental_factor',
      'money_flow',
      'valuation',
    ],
    metadata: {
      requires_token: true,
      env_token: 'TUSHARE_TOKEN',
      enable_env: 'TUSHARE_ENABLED=true',
      commercial_tier: 'freemium_paid',
      quant_role: '稳定日线/复权/财务因子增强源',
      quant_usage_notes: '适合作为量化中长期研究的主增强源，尤其是复权行情、财务因子、指数成分。',
      recommendation: hasTushareToken
        ? '已检测到 Token，可优先用于复权行情和财务因子。'
        : '建议优先配置 Tushare Pro Token，性价比高，能显著提升多因子策略稳定性。',
      configuration_hint: 'TUSHARE_ENABLED=true 且配置 TUSHARE_TOKEN 或 TUSHARE_PRO_TOKEN',
      strengths: ['复权行情稳定', '财务/估值因子丰富', '适合中长期回测'],
      limitations: ['免费积分有调用限制', '分钟级与实时能力有限'],
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
      commercial_tier: 'free',
      quant_role: '免费历史日线兜底源',
      quant_usage_notes: '适合补齐历史日线和交易日历，作为 AKShare/Tushare 异常时的兜底。',
      recommendation: baostockEnabled
        ? '已启用，可作为历史K线和交易日历兜底。'
        : '可按需开启 BAOSTOCK_ENABLED=true，增强免费历史数据兜底能力。',
      configuration_hint: 'BAOSTOCK_ENABLED=true 并安装 Python baostock',
      strengths: ['免费', '历史日线稳定', '交易日历可用'],
      limitations: ['实时行情弱', '财务因子覆盖有限'],
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
      'fundamental_factor',
      'money_flow',
    ],
    metadata: {
      python_package: 'akshare',
      role: 'primary_free_source',
      commercial_tier: 'free',
      quant_role: '免费主力行情源',
      quant_usage_notes:
        '当前免费栈主力，覆盖历史行情、实时行情和部分基础数据；适合日常扫描和 MVP 策略。',
      recommendation: '保持启用；关键任务建议配合 Tushare/Baostock 做交叉校验。',
      configuration_hint: '安装 Python akshare',
      strengths: ['覆盖广', '免费', '实时/历史能力较全面', '部分财务/资金流接口可扩展'],
      limitations: ['接口稳定性受上游页面影响', '字段口径偶有变化', '专业财务口径需交叉校验'],
    },
  },
  {
    provider_name: 'eastmoney',
    provider_label: '东方财富',
    provider_type: 'api',
    priority: 40,
    is_enabled: true,
    supported_features: ['stock_list', 'history_k', 'stock_basic', 'money_flow', 'valuation'],
    metadata: {
      role: 'fast_http_fallback',
      commercial_tier: 'free',
      quant_role: 'HTTP 快速兜底源',
      quant_usage_notes:
        '适合快速补充股票列表、历史K线与基础资料，作为 Python 数据源异常时的兜底。',
      recommendation: '保持启用，用于同步任务 fallback。',
      configuration_hint: '无需额外配置',
      strengths: ['HTTP 调用快', '无需 Token', '适合作为 fallback'],
      limitations: ['字段口径非专业量化标准', '调用频率需控制'],
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
      commercial_tier: 'free',
      quant_role: '增量历史行情源',
      quant_usage_notes: '适合日线增量同步和快速补洞，当前用于全量日线同步的轻量源。',
      recommendation: '保持启用，用于日线增量同步。',
      configuration_hint: '无需额外配置',
      strengths: ['速度快', '适合增量日线', '无需 Token'],
      limitations: ['基础资料/财务因子不足', '不是专业回测数据源'],
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
      commercial_tier: 'free',
      quant_role: '最后兜底源',
      quant_usage_notes: '适合作为兜底链路，避免单一数据源异常导致同步任务中断。',
      recommendation: '保持为低优先级兜底。',
      configuration_hint: '无需额外配置',
      strengths: ['无需 Token', '可兜底历史数据'],
      limitations: ['能力覆盖较窄', '稳定性不适合作为主源'],
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
      commercial_tier: 'internal_service',
      quant_role: '外部信息/多智能体深研源',
      quant_usage_notes:
        '不直接提供行情数据，用于对量化 Top 候选做基本面、新闻面、情绪面和技术面二次研判。',
      recommendation: '保持健康探测；只对高分候选调用，控制成本和延迟。',
      configuration_hint: 'TRADING_AGENTS_URL 指向已部署服务',
      strengths: ['外部信息补充', '解释性强', '适合二次确认'],
      limitations: ['非行情源', '耗时较长，应队列化调用'],
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

function isProviderUsable(provider: any): boolean {
  if (!provider || !provider.is_enabled) return false;
  return ![DataSourceStatus.DISABLED, DataSourceStatus.UNHEALTHY].includes(provider.status);
}

function firstUsableRoute(routes: any[] = []): any | null {
  return routes.find(route => isProviderUsable(route)) || null;
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

  static buildQuantReadiness(
    providers: any[],
    routingPlans: Record<string, any[]> = {}
  ): Record<string, any> {
    const providerByName = new Map(
      providers.map(provider => [String(provider.provider_name).toLowerCase(), provider])
    );
    const missingConfigs: string[] = [];
    const recommendations: string[] = [];
    const capabilityNotes: string[] = [];
    const historyPrimary = firstUsableRoute(routingPlans.history_k || []);
    const stockListPrimary = firstUsableRoute(routingPlans.stock_list || []);
    const stockBasicPrimary = firstUsableRoute(routingPlans.stock_basic || []);
    const realtimeProviders = providers.filter(
      provider =>
        isProviderUsable(provider) && (provider.supported_features || []).includes('realtime_quote')
    );
    const intradayProviders = providers.filter(
      provider =>
        isProviderUsable(provider) && (provider.supported_features || []).includes('intraday_bar')
    );
    const tushare = providerByName.get('tushare');
    const baostock = providerByName.get('baostock');
    const akshare = providerByName.get('akshare');
    const tradingAgents = providerByName.get('tradingagents');
    const hasTushareTokenNow = Boolean(process.env.TUSHARE_TOKEN || process.env.TUSHARE_PRO_TOKEN);

    if (!hasTushareTokenNow) {
      missingConfigs.push('TUSHARE_TOKEN');
      recommendations.push('优先配置 Tushare Pro：提升复权行情、财务因子和指数成分的稳定性。');
    }
    if (!tushare?.is_enabled) {
      missingConfigs.push('TUSHARE_ENABLED=true');
    }
    if (!baostock?.is_enabled) {
      recommendations.push('可开启 Baostock 作为免费历史日线和交易日历兜底。');
    }
    if (!historyPrimary) {
      recommendations.push(
        '历史K线当前无可用主链路，请先修复 AKShare/腾讯/东方财富/Tushare 任一数据源。'
      );
    }
    if (!realtimeProviders.length) {
      recommendations.push('实时行情能力不足，建议检查 AKShare 实时接口或接入付费行情源。');
    }
    if (!isProviderUsable(tradingAgents)) {
      recommendations.push('TradingAgents 健康状态异常，高分候选的二次研判可能延迟或缺失。');
    }

    if (isProviderUsable(akshare)) capabilityNotes.push('AKShare 可承担免费主力行情。');
    if (isProviderUsable(tushare)) capabilityNotes.push('Tushare 可承担复权/财务因子增强。');
    if (isProviderUsable(baostock)) capabilityNotes.push('Baostock 可承担历史日线兜底。');

    const historyReady = Boolean(historyPrimary);
    const realtimeReady = realtimeProviders.length > 0;
    const fundamentalsRoutes = routingPlans.fundamental_factor || [];
    const moneyFlowRoutes = routingPlans.money_flow || [];
    const valuationRoutes = routingPlans.valuation || [];
    const fundamentalsReady = Boolean(firstUsableRoute(fundamentalsRoutes));
    const moneyFlowReady = Boolean(firstUsableRoute(moneyFlowRoutes));
    const valuationReady = Boolean(firstUsableRoute(valuationRoutes));
    const intradayReady = intradayProviders.length > 0;
    const agentReady = Boolean(isProviderUsable(tradingAgents));
    const score = clampScore(
      (historyReady ? 26 : 0) +
        (stockListPrimary ? 14 : 0) +
        (stockBasicPrimary ? 14 : 0) +
        (realtimeReady ? 14 : 0) +
        (fundamentalsReady ? 10 : 0) +
        (moneyFlowReady ? 4 : 0) +
        (valuationReady ? 2 : 0) +
        (intradayReady ? 6 : 0) +
        (agentReady ? 10 : 0)
    );

    return {
      score,
      status:
        score >= 82
          ? 'production_ready'
          : score >= 62
          ? 'usable'
          : score >= 42
          ? 'limited'
          : 'blocked',
      summary:
        score >= 82
          ? '量化扫描链路较完整，可支撑每日自动荐股闭环。'
          : score >= 62
          ? '量化扫描可用，但建议补齐 Tushare/兜底源提升稳定性。'
          : score >= 42
          ? '仅适合小规模验证，自动化荐股需要先修复关键数据源。'
          : '关键行情链路不足，暂不建议运行自动闭环。',
      history_ready: historyReady,
      realtime_ready: realtimeReady,
      fundamentals_ready: fundamentalsReady,
      money_flow_ready: moneyFlowReady,
      valuation_ready: valuationReady,
      intraday_ready: intradayReady,
      agent_ready: agentReady,
      primary_history_provider: historyPrimary?.provider_label || null,
      primary_stock_list_provider: stockListPrimary?.provider_label || null,
      primary_stock_basic_provider: stockBasicPrimary?.provider_label || null,
      primary_fundamental_provider: firstUsableRoute(fundamentalsRoutes)?.provider_label || null,
      primary_money_flow_provider: firstUsableRoute(moneyFlowRoutes)?.provider_label || null,
      primary_valuation_provider: firstUsableRoute(valuationRoutes)?.provider_label || null,
      realtime_providers: realtimeProviders.map(provider => provider.provider_label),
      factor_landing_plan: {
        phase: 'P4',
        status:
          fundamentalsReady || moneyFlowReady || valuationReady
            ? 'ready_to_land'
            : 'needs_provider',
        tables: [
          'stock_fundamental_factors',
          'stock_money_flow_factors',
          'stock_valuation_factors',
        ],
        recommended_provider_order: ['tushare', 'akshare', 'eastmoney'],
        next_step:
          fundamentalsReady || moneyFlowReady || valuationReady
            ? '建立因子落库表与同步任务，先覆盖估值、ROE/营收增速、主力资金流、换手率等可解释因子。'
            : '先配置 Tushare 或确认 AKShare/东方财富因子接口稳定，再落库。',
      },
      recommended_paid_source: {
        provider_name: 'tushare',
        provider_label: 'Tushare Pro',
        priority: 1,
        reason: '性价比高，最适合先补齐 A 股日线、复权、财务因子、指数成分和估值口径。',
        required_env: ['TUSHARE_ENABLED=true', 'TUSHARE_TOKEN'],
      },
      future_paid_sources: [
        {
          provider_name: 'jqdata',
          provider_label: '聚宽 JQData',
          use_case: '分钟级行情、指数成分、财务因子与研究环境一体化。',
        },
        {
          provider_name: 'gm',
          provider_label: '掘金量化',
          use_case: '更接近实盘的数据、回测和后续交易接口探索。',
        },
      ],
      missing_configs: [...new Set(missingConfigs)],
      recommendations: [...new Set(recommendations)],
      capability_notes: capabilityNotes,
    };
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
