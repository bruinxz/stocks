import { Op } from 'sequelize';
import { QuantStrategyModel } from '../../../models/QuantStrategyModel';
import { QuantBacktestTask } from '../../../models/QuantBacktestTask';
import { QuantBacktestResult } from '../../../models/QuantBacktestResult';
import { QuantSignal } from '../../../models/QuantSignal';
import { FactorICResult } from '../../../models/FactorICResult';
import { strategyRegistry } from '../../engine/StrategyRegistry';

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
      max_position_pct:
        definition.risk_level === 'high' ? 4 : definition.risk_level === 'low' ? 8 : 6,
      default_position_pct: definition.risk_level === 'high' ? 2 : 3,
      candidate_limit: 180,
      min_score:
        definition.risk_level === 'high' ? 76 : definition.category === 'multi_factor' ? 68 : 70,
      allowed_risk_levels: definition.risk_level === 'low' ? ['low', 'medium'] : ['low', 'medium'],
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
      cooldown_days:
        definition.risk_level === 'high' ? 20 : definition.risk_level === 'low' ? 10 : 15,
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

  /**
   * US-078：策略详情聚合查询。
   *
   * 返回一只策略的元数据 + 近 10 次包含该策略的回测（含该策略自己的 KPI，不取冠军） +
   * 最新 IC 摘要 + 简化版"实盘绑定"状态（enabled flag + 近 7 日是否有 QuantSignal）。
   *
   * 4 类子查询各自 try/catch，任一失败用 fallback 值，不阻塞页面渲染 —— 复用 US-018
   * 同款 per-block error 范式。
   *
   * `recent_signal_count` 用 `signal_date >= today - 7d` 是"近 7 日是否在跑实盘"的
   * 启发式判断（A 股系统在跑实盘时每个交易日都会写信号到 QuantSignal）；> 0 即视为
   * 当前绑定到实盘。这是简化判断，避免引入新的 portfolio-strategy mapping 表。
   */
  async getStrategyDetail(strategy_key: string) {
    await this.syncRegistry();
    const strategy = await QuantStrategyModel.findOne({ where: { strategy_key } });
    if (!strategy) return null;

    // ---- 子查询 A：近 50 条回测，in-memory 过滤 strategy_keys 含该 key 后取前 10
    // 不用 JSONB @> 查询是因为 PG/MySQL 跨方言行为不同；总量 < 几百，in-memory 走得通。
    let backtests: any[] = [];
    try {
      const tasks = await QuantBacktestTask.findAll({
        order: [['created_at', 'DESC']],
        limit: 200,
      });
      const matched = tasks
        .filter(t => Array.isArray(t.strategy_keys) && t.strategy_keys.includes(strategy_key))
        .slice(0, 10);
      const taskIds = matched.map(t => t.id);
      // 仅取这只 strategy 在每个 task 内的结果（不是冠军，是 strategy_key 匹配的那行）
      const results = taskIds.length
        ? await QuantBacktestResult.findAll({
            where: { task_id: { [Op.in]: taskIds }, strategy_key },
          })
        : [];
      // 同 task 内拿同名所有结果（理论上唯一），按 task_id 分组
      const myResultByTask = new Map<number, QuantBacktestResult>();
      for (const r of results) {
        // 已存在则保留 total_return_pct 更高的（防理论上的重复行）
        const existing = myResultByTask.get(r.task_id);
        if (!existing || Number(r.total_return_pct || 0) > Number(existing.total_return_pct || 0)) {
          myResultByTask.set(r.task_id, r);
        }
      }
      // 也要 task 自身的"冠军 KPI"，需要 task_id 下所有结果做 buildTaskRunSummary 等价
      // 简化版：只取该任务下所有结果中 total_return_pct 最高的，inline 处理
      const allResultsForTasks = taskIds.length
        ? await QuantBacktestResult.findAll({ where: { task_id: { [Op.in]: taskIds } } })
        : [];
      const championByTask = new Map<number, QuantBacktestResult>();
      for (const r of allResultsForTasks) {
        const existing = championByTask.get(r.task_id);
        if (!existing || Number(r.total_return_pct || 0) > Number(existing.total_return_pct || 0)) {
          championByTask.set(r.task_id, r);
        }
      }
      backtests = matched.map(t => {
        const mine = myResultByTask.get(t.id);
        const champion = championByTask.get(t.id);
        return {
          id: t.id,
          task_name: t.task_name,
          status: t.status,
          created_at: t.created_at,
          start_date: t.start_date,
          end_date: t.end_date,
          strategy_keys: t.strategy_keys,
          initial_capital: Number(t.initial_capital || 0),
          run_summary: champion
            ? {
                best_strategy_key: champion.strategy_key,
                best_strategy_name: champion.strategy_name,
                best_return_pct: Number(champion.total_return_pct || 0),
                best_max_drawdown_pct: Number(champion.max_drawdown_pct || 0),
                best_sharpe_ratio: Number(champion.sharpe_ratio || 0),
                best_trade_count: Number(champion.trade_count || 0),
              }
            : null,
          strategy_metrics: mine
            ? {
                present: true,
                total_return_pct: Number(mine.total_return_pct || 0),
                annual_return_pct: Number(mine.annual_return_pct || 0),
                excess_return_pct: Number(mine.excess_return_pct || 0),
                sharpe_ratio: Number(mine.sharpe_ratio || 0),
                max_drawdown_pct: Number(mine.max_drawdown_pct || 0),
                win_rate: Number(mine.win_rate || 0),
                trade_count: Number(mine.trade_count || 0),
                is_champion: champion?.strategy_key === strategy_key,
              }
            : { present: false },
        };
      });
    } catch {
      backtests = [];
    }

    // ---- 子查询 B：最新 IC 摘要（按 factor_name = strategy_key）
    let latest_ic: any = null;
    try {
      const ic = await FactorICResult.findOne({
        where: { factor_name: strategy_key },
        order: [['computed_at', 'DESC']],
      });
      if (ic) {
        latest_ic = {
          factor_name: ic.factor_name,
          look_forward_days: ic.look_forward_days,
          ic_mean: ic.ic_mean === null || ic.ic_mean === undefined ? null : Number(ic.ic_mean),
          ic_ir: ic.ic_ir === null || ic.ic_ir === undefined ? null : Number(ic.ic_ir),
          ic_positive_ratio:
            ic.ic_positive_ratio === null || ic.ic_positive_ratio === undefined
              ? null
              : Number(ic.ic_positive_ratio),
          sample_count: ic.sample_count,
          computed_at: ic.computed_at,
          period_start: ic.period_start,
          period_end: ic.period_end,
        };
      }
    } catch {
      latest_ic = null;
    }

    // ---- 子查询 C：实盘绑定（启发式）—— enabled + 近 7 日 QuantSignal 计数
    let live_binding = {
      enabled: strategy.enabled !== false,
      recent_signal_count: 0,
      last_signal_date: null as string | null,
    };
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
      const recentCount = await QuantSignal.count({
        where: { strategy_key, trade_date: { [Op.gte]: sevenDaysAgo } },
      });
      const lastSignal = await QuantSignal.findOne({
        where: { strategy_key },
        order: [['trade_date', 'DESC']],
        attributes: ['trade_date'],
      });
      live_binding = {
        enabled: strategy.enabled !== false,
        recent_signal_count: recentCount,
        last_signal_date: lastSignal?.trade_date || null,
      };
    } catch {
      // keep defaults
    }

    return {
      strategy: strategy.toJSON(),
      backtests,
      latest_ic,
      live_binding,
    };
  }
}

export const quantStrategyService = new QuantStrategyService();
