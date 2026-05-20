import { QuantStrategyModel } from '../../models/QuantStrategyModel';
import { strategyRegistry } from '../engine/StrategyRegistry';

function asPlainObject<T = any>(value: any): T {
  if (!value || typeof value !== 'object') return {} as T;
  if (typeof value.toJSON === 'function') return value.toJSON();
  return value as T;
}

function normalizeStrategyKeys(strategy_keys?: string[] | string): string[] {
  const raw = Array.isArray(strategy_keys)
    ? strategy_keys
    : strategy_keys
      ? String(strategy_keys).split(',')
      : [];
  return Array.from(
    new Set(raw.map(key => String(key || '').trim()).filter(key => key.length > 0))
  );
}

function normalizeParamValue(value: any): any {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed !== '' && /^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return value;
}

function normalizeParams(params: Record<string, any> = {}) {
  return Object.fromEntries(
    Object.entries(params).map(([key, value]) => [key, normalizeParamValue(value)])
  );
}

function asObject(value: any): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

export class QuantStrategyService {
  private defaultExecutionPolicy(definition: any) {
    return {
      max_position_pct: definition.risk_level === 'high' ? 4 : definition.risk_level === 'low' ? 8 : 6,
      default_position_pct: definition.risk_level === 'high' ? 2 : 3,
      candidate_limit: 180,
      min_score: definition.risk_level === 'high' ? 76 : definition.category === 'multi_factor' ? 68 : 70,
      allowed_risk_levels:
        definition.risk_level === 'low' ? ['low', 'medium'] : ['low', 'medium'],
    };
  }

  private defaultEnvironmentPolicy(definition: any) {
    return {
      preferred_market_regimes:
        definition.category === 'trend' || definition.category === 'momentum'
          ? ['bull', 'rebound']
          : definition.category === 'mean_reversion'
          ? ['range', 'stress']
          : ['bull', 'range', 'rebound'],
      blocked_market_regimes: definition.risk_level === 'high' ? ['stress'] : [],
      allow_same_industry_overlap: definition.category === 'multi_factor',
    };
  }

  private defaultLifecyclePolicy(definition: any) {
    return {
      auto_promote: true,
      auto_degrade: true,
      auto_rollback: true,
      promotion_min_completed_samples: definition.risk_level === 'high' ? 18 : 12,
      rollback_min_completed_samples: definition.risk_level === 'high' ? 10 : 8,
      cooldown_days: definition.risk_level === 'high' ? 20 : definition.risk_level === 'low' ? 10 : 15,
    };
  }

  async syncRegistry() {
    const definitions = strategyRegistry.list();
    const records = [];
    for (const definition of definitions) {
      const [record] = await QuantStrategyModel.findOrCreate({
        where: { strategy_key: definition.strategy_key },
        defaults: {
          strategy_key: definition.strategy_key,
          name: definition.name,
          description: definition.description,
          category: definition.category,
          default_params: definition.default_params,
          execution_policy: this.defaultExecutionPolicy(definition),
          environment_policy: this.defaultEnvironmentPolicy(definition),
          lifecycle_policy: this.defaultLifecyclePolicy(definition),
          enabled: definition.enabled,
          risk_level: definition.risk_level,
          tags: definition.tags,
          latest_metrics: {},
        },
      });
      const patch: any = {
        name: definition.name,
        description: definition.description,
        category: definition.category,
        default_params: {
          ...(definition.default_params || {}),
          ...(asPlainObject(record.default_params) || {}),
        },
        execution_policy: {
          ...this.defaultExecutionPolicy(definition),
          ...asObject(record.execution_policy),
        },
        environment_policy: {
          ...this.defaultEnvironmentPolicy(definition),
          ...asObject(record.environment_policy),
        },
        lifecycle_policy: {
          ...this.defaultLifecyclePolicy(definition),
          ...asObject(record.lifecycle_policy),
        },
        risk_level: definition.risk_level,
        tags: definition.tags,
      };
      if (record.enabled === null || record.enabled === undefined)
        patch.enabled = definition.enabled;
      await record.update(patch);
      records.push(record);
    }
    return records;
  }

  async listStrategies() {
    await this.syncRegistry();
    return QuantStrategyModel.findAll({
      order: [
        ['display_order', 'ASC NULLS LAST'],
        ['category', 'ASC'],
        ['strategy_key', 'ASC'],
      ] as any,
    });
  }

  async updateStrategyConfig(
    strategy_key: string,
    patch: {
      enabled?: boolean;
      default_params?: Record<string, any>;
      execution_policy?: Record<string, any>;
      environment_policy?: Record<string, any>;
      lifecycle_policy?: Record<string, any>;
      notes?: string;
      display_order?: number;
    }
  ) {
    await this.syncRegistry();
    const record = await QuantStrategyModel.findOne({ where: { strategy_key } });
    if (!record) throw new Error(`量化策略不存在: ${strategy_key}`);

    const nextPatch: any = {};
    if (typeof patch.enabled === 'boolean') nextPatch.enabled = patch.enabled;
    if (patch.default_params && typeof patch.default_params === 'object') {
      nextPatch.default_params = {
        ...(asPlainObject(record.default_params) || {}),
        ...normalizeParams(patch.default_params),
      };
    }
    if (patch.execution_policy && typeof patch.execution_policy === 'object') {
      nextPatch.execution_policy = {
        ...(asObject(record.execution_policy) || {}),
        ...normalizeParams(patch.execution_policy),
      };
    }
    if (patch.environment_policy && typeof patch.environment_policy === 'object') {
      nextPatch.environment_policy = {
        ...(asObject(record.environment_policy) || {}),
        ...patch.environment_policy,
      };
    }
    if (patch.lifecycle_policy && typeof patch.lifecycle_policy === 'object') {
      nextPatch.lifecycle_policy = {
        ...(asObject(record.lifecycle_policy) || {}),
        ...normalizeParams(patch.lifecycle_policy),
      };
    }
    if (patch.notes !== undefined) nextPatch.notes = patch.notes;
    if (patch.display_order !== undefined) nextPatch.display_order = patch.display_order;

    if (Object.keys(nextPatch).length > 0) await record.update(nextPatch);
    return QuantStrategyModel.findOne({ where: { strategy_key } });
  }

  async resolveStrategyKeys(strategy_keys?: string[] | string): Promise<string[]> {
    await this.syncRegistry();
    const requested = normalizeStrategyKeys(strategy_keys);
    if (requested.length > 0) return requested;

    const enabledRecords = await QuantStrategyModel.findAll({
      where: { enabled: true },
      order: [
        ['category', 'ASC'],
        ['strategy_key', 'ASC'],
      ],
    });
    const enabledKeys = enabledRecords.map(item => item.strategy_key).filter(Boolean);
    return enabledKeys.length > 0
      ? enabledKeys
      : strategyRegistry.enabled().map(strategy => strategy.definition.strategy_key);
  }

  async getDefaultParamsByStrategy(strategy_keys?: string[] | string) {
    await this.syncRegistry();
    const keys = await this.resolveStrategyKeys(strategy_keys);
    if (!keys.length) return {};

    const records = await QuantStrategyModel.findAll({ where: { strategy_key: keys } });
    const byKey = new Map(records.map(record => [record.strategy_key, record]));
    return keys.reduce<Record<string, Record<string, any>>>((paramsByStrategy, key) => {
      const registryDefinition = strategyRegistry.get(key)?.definition;
      const record = byKey.get(key);
      paramsByStrategy[key] = {
        ...(registryDefinition?.default_params || {}),
        ...(asPlainObject(record?.default_params) || {}),
      };
      return paramsByStrategy;
    }, {});
  }

  async getRuntimePoliciesByStrategy(strategy_keys?: string[] | string) {
    await this.syncRegistry();
    const keys = await this.resolveStrategyKeys(strategy_keys);
    if (!keys.length) return {};

    const records = await QuantStrategyModel.findAll({ where: { strategy_key: keys } });
    const byKey = new Map(records.map(record => [record.strategy_key, record]));
    return keys.reduce<Record<string, Record<string, any>>>((policiesByStrategy, key) => {
      const registryDefinition = strategyRegistry.get(key)?.definition;
      const record = byKey.get(key);
      policiesByStrategy[key] = {
        strategy_key: key,
        strategy_name: record?.name || registryDefinition?.name || key,
        category: record?.category || registryDefinition?.category,
        risk_level: record?.risk_level || registryDefinition?.risk_level || 'medium',
        enabled: record?.enabled !== false,
        execution_policy: {
          ...(registryDefinition ? this.defaultExecutionPolicy(registryDefinition) : {}),
          ...asObject(record?.execution_policy),
        },
        environment_policy: {
          ...(registryDefinition ? this.defaultEnvironmentPolicy(registryDefinition) : {}),
          ...asObject(record?.environment_policy),
        },
        lifecycle_policy: {
          ...(registryDefinition ? this.defaultLifecyclePolicy(registryDefinition) : {}),
          ...asObject(record?.lifecycle_policy),
        },
      };
      return policiesByStrategy;
    }, {});
  }
}

export const quantStrategyService = new QuantStrategyService();
