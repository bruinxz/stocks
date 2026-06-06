import { Factor } from './types';

/**
 * FactorRegistry — 全局因子注册中心（US-009）
 *
 * 作为单例使用：因子模块 import-time 调用 `factorRegistry.register(…)`
 * 自我登记，后续 FactorPipeline / API / 报告统一从这里取因子实例。
 *
 * 规则：
 *   - 同名因子重复 register 会抛出（避免静默覆盖语义）。要演化语义，请
 *     改名（e.g. value → value_v2）。
 *   - register / get / list 全为同步操作；register 在 import-time 完成。
 *   - 不持有任何 mutable state（只是个 Map），单例安全。
 *
 * 使用示例：
 * ```ts
 * import { factorRegistry } from '../quant/factors/FactorRegistry';
 * import './library';  // import-time 副作用：每个 library/*.ts register 自己
 *
 * const value = factorRegistry.get('value');
 * const names = factorRegistry.list().map(f => f.name);
 * ```
 */
export class FactorRegistry {
  private factors = new Map<string, Factor>();

  /**
   * 注册一个因子。
   * @throws 当 name 重复时（防止静默覆盖）。
   */
  register(factor: Factor): void {
    if (!factor || !factor.name) {
      throw new Error('FactorRegistry.register: factor.name is required');
    }
    if (typeof factor.compute !== 'function') {
      throw new Error(`FactorRegistry.register: factor "${factor.name}" must implement compute()`);
    }
    if (this.factors.has(factor.name)) {
      throw new Error(
        `FactorRegistry.register: factor "${factor.name}" already registered. ` +
          `Use a new name (e.g. "${factor.name}_v2") to evolve semantics.`
      );
    }
    this.factors.set(factor.name, factor);
  }

  /**
   * 按名取因子；不存在则抛出（便于早暴露配置错）。
   * @throws 当 name 未注册时。
   */
  get(name: string): Factor {
    const f = this.factors.get(name);
    if (!f) {
      const known = Array.from(this.factors.keys()).sort().join(', ') || '(empty)';
      throw new Error(`FactorRegistry.get: factor "${name}" not registered. ` + `Known: ${known}`);
    }
    return f;
  }

  /** 是否已注册（不抛出版本，便于 UI 列表 / 条件分支） */
  has(name: string): boolean {
    return this.factors.has(name);
  }

  /** 全量列出（按注册顺序） */
  list(): Factor[] {
    return Array.from(this.factors.values());
  }

  /** 仅返回名字列表（按字典序） */
  listNames(): string[] {
    return Array.from(this.factors.keys()).sort();
  }

  /**
   * 仅在测试中使用：清空注册。
   * 生产代码不要调用——一旦清空，后续 import 因子文件不会重新自我登记。
   */
  _clearForTesting(): void {
    this.factors.clear();
  }
}

/** 全局单例。所有 library/*.ts 在 import-time register 到这里 */
export const factorRegistry = new FactorRegistry();
