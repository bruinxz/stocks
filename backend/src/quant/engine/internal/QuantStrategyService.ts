import { Op } from 'sequelize';
import { QuantBacktestTask } from '../../../models/QuantBacktestTask';
import { QuantBacktestResult } from '../../../models/QuantBacktestResult';
import { FactorICResult } from '../../../models/FactorICResult';
import { strategyRegistry } from '../../engine/StrategyRegistry';

// ⚠️ DEPRECATED STUB — 以下"模型"是 批8 (2026-07-03 物理删表 D7) 已删除的 Sequelize
// model 的占位替身,仅为让依赖它们的历史代码路径继续编译。方法恒返回空/惰性对象,
// 即该数据维度已永久下线、优雅降级为"无数据"。请勿基于此新增业务逻辑。
const QuantStrategyModel = {
  findOrCreate: async (_opts: any) => [{ update: async () => {}, enabled: true, default_params: {}, execution_policy: {}, environment_policy: {}, lifecycle_policy: {}, edge_hypothesis: {}, strategy_key: '', name: '', description: '', category: '', risk_level: 'medium', tags: [], toJSON: () => ({}) }, false] as [any, boolean],
  findAll: async (_opts?: any): Promise<any[]> => [],
  findOne: async (_opts?: any): Promise<any> => null,
};
// ⚠️ DEPRECATED STUB (同上, QuantSignal 表已于 批8 删除) — 恒返回空。
const QuantSignal = {
  count: async (_opts?: any): Promise<number> => 0,
  findOne: async (_opts?: any): Promise<any> => null,
};

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

/**
 * US-083: 纯函数从一组 strategy 记录中筛选 dry-run 策略的 strategy_key。
 *
 * 单测可直接用此函数验证 lifecycle_policy.dry_run 的解析规则：
 *   - dry_run === true              → 入选
 *   - dry_run === 'true' (字符串)   → 入选（JSONB 旧记录可能存字符串）
 *   - dry_run === false / undefined → 不入选
 *   - lifecycle_policy 非对象        → 不入选
 *
 * 不调用 DB，是 getDryRunStrategyKeys() 的纯函数核心，便于覆盖边界。
 */
export function pickDryRunStrategyKeysFromRecords(
  records: Array<{ strategy_key: string; lifecycle_policy?: any }>
): string[] {
  const keys: string[] = [];
  for (const record of records || []) {
    const lifecycle = asObject(record.lifecycle_policy);
    if (lifecycle.dry_run === true || lifecycle.dry_run === 'true') {
      const key = String(record.strategy_key || '').trim();
      if (key) keys.push(key);
    }
  }
  // dedupe preserving order
  return Array.from(new Set(keys));
}

export class QuantStrategyService {
  private registrySyncPromise: Promise<any[]> | null = null;
  private registrySyncedAt = 0;
  private readonly registrySyncTtlMs = (() => {
    const value = Number(process.env.QUANT_STRATEGY_REGISTRY_SYNC_TTL_MS);
    return Number.isFinite(value) ? Math.max(30_000, value) : 5 * 60 * 1000;
  })();

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

  private async runRegistrySync(): Promise<any[]> {
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
          // Phase 4: 内置 edge_hypothesis 默认值 (用户后续可通过 PATCH 替换)
          edge_hypothesis: definition.edge_hypothesis || {},
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
      // Phase 4: 仅在 record 上 edge_hypothesis 为空 (用户没改过) 时才用 definition 兜底
      // 避免覆盖用户已经 PATCH 编辑过的 hypothesis
      const existingHypo = asObject(record.edge_hypothesis) || {};
      if (Object.keys(existingHypo).length === 0 && definition.edge_hypothesis) {
        patch.edge_hypothesis = definition.edge_hypothesis;
      }
      if (record.enabled === null || record.enabled === undefined)
        patch.enabled = definition.enabled;
      await record.update(patch);
      records.push(record);
    }
    this.registrySyncedAt = Date.now();
    return records;
  }

  async syncRegistry() {
    if (this.registrySyncPromise) {
      return this.registrySyncPromise;
    }

    this.registrySyncPromise = this.runRegistrySync().finally(() => {
      this.registrySyncPromise = null;
    });
    return this.registrySyncPromise;
  }

  private async ensureRegistrySynced() {
    if (Date.now() - this.registrySyncedAt < this.registrySyncTtlMs) {
      return [];
    }
    return this.syncRegistry();
  }

  async listStrategies() {
    await this.ensureRegistrySynced();
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
      edge_hypothesis?: Record<string, any>;
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
    // Phase 4: edge_hypothesis 用 replace-not-merge 语义
    // —— hypothesis 是一个完整说法的整体，merge 字段会产生半旧半新的不一致版本
    if (patch.edge_hypothesis !== undefined) {
      nextPatch.edge_hypothesis = asObject(patch.edge_hypothesis) || {};
    }
    if (patch.notes !== undefined) nextPatch.notes = patch.notes;
    if (patch.display_order !== undefined) nextPatch.display_order = patch.display_order;

    if (Object.keys(nextPatch).length > 0) await record.update(nextPatch);
    return QuantStrategyModel.findOne({ where: { strategy_key } });
  }

  async resolveStrategyKeys(strategy_keys?: string[] | string): Promise<string[]> {
    const requested = normalizeStrategyKeys(strategy_keys);
    if (requested.length > 0) return requested;

    await this.ensureRegistrySynced();
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

  /**
   * US-083: 返回所有 `lifecycle_policy.dry_run === true` 的策略 key 集合。
   *
   * 由 PaperTradingFacade.applyAutomation 调用，把结果传给
   * `paperTradingAutomationService.autoBuyFromSignals({ dry_run_strategy_keys })`
   * 让这些策略的信号走 planned-only 路径（信号仍写 QuantSignal 表，不实际下单）。
   *
   * Batch N (2026-06-17): 改成 fail-CLOSED — DB 查询失败时 throw, 让 caller 决定
   * 跳过本轮 / 走兜底 / 报警, 而不是静默"所有策略都真实下单"(用户最害怕的事).
   * 旧 fail-OPEN 注释 "宁可让 dry-run 策略真实下单"违反用户 dry_run=true 语义,
   * 是反向的安全选择. 同款 fail-CLOSED 在 PositionLimitGuard / 硬风控已是默认.
   *
   * 返回值是 string[]，调用方可以直接传给 `dry_run_strategy_keys` 参数。
   */
  async getDryRunStrategyKeys(): Promise<string[]> {
    await this.ensureRegistrySynced();
    const records = await QuantStrategyModel.findAll({});
    return pickDryRunStrategyKeysFromRecords(records);
  }

  async getDefaultParamsByStrategy(strategy_keys?: string[] | string) {
    await this.ensureRegistrySynced();
    const explicitKeys = normalizeStrategyKeys(strategy_keys);
    const keys = explicitKeys.length ? explicitKeys : await this.resolveStrategyKeys(strategy_keys);
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
    await this.ensureRegistrySynced();
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
    await this.ensureRegistrySynced();
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
      const recentCount = 0;
      live_binding = {
        enabled: strategy.enabled !== false,
        recent_signal_count: recentCount,
        last_signal_date: null,
      };
    } catch {
      // keep defaults
    }

    // Phase 4: 实时计算 edge_hypothesis 门禁状态（让 UI 直接显示"还差哪些字段"）
    // 与 QuantStrategyParamVersionService 的硬门禁规则 1:1 镜像
    const edgeHypo =
      strategy.edge_hypothesis && typeof strategy.edge_hypothesis === 'object'
        ? (strategy.edge_hypothesis as Record<string, any>)
        : {};
    const edgeHypoCheck = {
      thesis_ok: typeof edgeHypo.thesis === 'string' && edgeHypo.thesis.trim().length >= 10,
      category_ok: typeof edgeHypo.category === 'string' && edgeHypo.category.trim().length > 0,
      kill_switch_ok:
        typeof edgeHypo.kill_switch_metric === 'string' &&
        edgeHypo.kill_switch_metric.trim().length > 0,
    };
    const promotion_gate = {
      edge_hypothesis: {
        ...edgeHypoCheck,
        all_satisfied:
          edgeHypoCheck.thesis_ok && edgeHypoCheck.category_ok && edgeHypoCheck.kill_switch_ok,
        missing: [
          ...(edgeHypoCheck.thesis_ok ? [] : ['thesis ≥10 字']),
          ...(edgeHypoCheck.category_ok ? [] : ['category']),
          ...(edgeHypoCheck.kill_switch_ok ? [] : ['kill_switch_metric']),
        ],
      },
    };

    return {
      strategy: strategy.toJSON(),
      backtests,
      latest_ic,
      live_binding,
      promotion_gate,
    };
  }
}

export const quantStrategyService = new QuantStrategyService();
