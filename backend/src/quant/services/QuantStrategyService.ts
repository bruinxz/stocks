import { QuantStrategyModel } from '../../models/QuantStrategyModel';
import { strategyRegistry } from '../engine/StrategyRegistry';

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
        default_params: definition.default_params,
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
}

export const quantStrategyService = new QuantStrategyService();
