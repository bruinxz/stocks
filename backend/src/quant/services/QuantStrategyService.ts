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

export class QuantStrategyService {
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
        ['category', 'ASC'],
        ['strategy_key', 'ASC'],
      ],
    });
  }

  async updateStrategyConfig(
    strategy_key: string,
    patch: { enabled?: boolean; default_params?: Record<string, any> }
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
}

export const quantStrategyService = new QuantStrategyService();
