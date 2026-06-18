import { Op } from 'sequelize';
import { FactorScore } from '../../models/FactorScore';
import { Stock } from '../../models/Stock';
import { logger } from '../../utils/logger';
import { factorRegistry, FactorRegistry } from './FactorRegistry';
import { stripSuffix } from './library/_helpers';
import { Factor, FactorComputeOutput, FactorContext } from './types';
import { winsorize, zscore, percentileRanks } from './normalization';

/**
 * FactorPipeline — 按交易日批量计算并入库因子得分（US-009）
 *
 * 高层流程（runForDate）：
 *   1. 解析股票池（universe）：默认全 A 股活跃股（剔除停牌、退市；新股
 *      过滤交由调用方传 options.excludeNewerThanDays）。
 *   2. 对每个 factorName 串行调度（避免 DB 连接洪峰，单个因子内部自然
 *      会做 batch 查询）：
 *        a. 调 factor.compute(context) → Map<stock_code, raw_value | null>
 *        b. 过滤掉 raw_value = null / NaN / Infinity 的样本，得到可标准化样本
 *        c. winsorize(1%-99%) → zscore → percentileRanks
 *        d. 构造 (stock_code, raw_value, z_score, percentile) 记录列表
 *        e. 对 universe 中没出现在 compute 输出的 stock_code 补 "中性行"
 *           （raw_value = null, z_score = 0, percentile = 0.5）
 *        f. bulkCreate + updateOnDuplicate 写入 factor_scores
 *   3. 汇总每个因子的 stats 返回，便于 CLI / 监控判断是否有空集 / 异常
 *
 * 为什么按 (date, factor) 串行而不并行：
 *   - 因子之间无依赖，并行只在 DB 是瓶颈时才有显著收益；当前 DB 通常
 *     不是瓶颈（一只股票一行 200B，全市场 5000 只 = 1MB/因子）。
 *   - 串行让日志可读、易调试、单因子失败可继续；并行后任何一个因子
 *     抛错都会导致整批回滚或 Promise.all 抛弃其它结果——得不偿失。
 *
 * 调用方契约：
 *   - 出错的因子记到 result.factor_results[i].error 但不影响别的因子
 *     与不影响整次 runForDate 的成功标志（除非全部失败）。
 *   - runForDate 是幂等的：相同 (date, factorNames, universe) 重跑会覆盖。
 */
export interface FactorPipelineRunOptions {
  /** 自定义股票池（无市场前缀的 stock_code 数组）。不传则用全 A 股 active */
  universe?: string[];
  /** 透传给每个 Factor.compute(ctx.options)，不参与 universe 解析 */
  factorOptions?: Record<string, any>;
  /** 透传给 FactorContext.lookbackDays，因子可以读 */
  lookbackDays?: number;
  /** 跳过指定因子（黑名单），便于临时下线某个失效因子 */
  skipFactors?: string[];
}

export interface FactorRunSingleResult {
  factor_name: string;
  fetched: number;
  /** 实际有效（非 null / 非 NaN）参与了 winsorize+zscore 的样本数 */
  effective: number;
  /** 写入 factor_scores 的总行数 = universe.length（含中性补全） */
  upserted: number;
  /** 因子计算失败时填 */
  error?: string;
  /** 是否被显式 skip */
  skipped?: boolean;
}

export interface FactorRunResult {
  trade_date: string;
  universe_size: number;
  factor_results: FactorRunSingleResult[];
  total_upserted: number;
  total_failed: number;
}

export class FactorPipeline {
  private registry: FactorRegistry;

  constructor(registry: FactorRegistry = factorRegistry) {
    this.registry = registry;
  }

  /**
   * 按交易日批量计算 + 入库一组因子。
   *
   * @param tradeDate ISO YYYY-MM-DD（被写入 FactorScore.trade_date 字段）
   * @param factorNames 待计算的因子名列表；空数组 = 跑注册表中的全部因子
   * @param options 见 FactorPipelineRunOptions
   */
  async runForDate(
    tradeDate: string,
    factorNames: string[] = [],
    options: FactorPipelineRunOptions = {}
  ): Promise<FactorRunResult> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) {
      throw new Error(`runForDate: invalid trade_date (expected YYYY-MM-DD): ${tradeDate}`);
    }

    const universe = options.universe?.length
      ? options.universe.slice()
      : await this.loadDefaultUniverse();

    if (universe.length === 0) {
      logger.warn(`FactorPipeline.runForDate(${tradeDate}): empty universe, nothing to do`);
      return {
        trade_date: tradeDate,
        universe_size: 0,
        factor_results: [],
        total_upserted: 0,
        total_failed: 0,
      };
    }

    const targets: Factor[] =
      factorNames.length === 0
        ? this.registry.list()
        : factorNames.map(name => this.registry.get(name));

    const skip = new Set(options.skipFactors ?? []);

    const factorResults: FactorRunSingleResult[] = [];
    let totalUpserted = 0;
    let totalFailed = 0;

    for (const factor of targets) {
      if (skip.has(factor.name)) {
        factorResults.push({
          factor_name: factor.name,
          fetched: 0,
          effective: 0,
          upserted: 0,
          skipped: true,
        });
        continue;
      }

      const ctx: FactorContext = {
        as_of_date: tradeDate,
        universe,
        lookbackDays: options.lookbackDays ?? 250,
        options: options.factorOptions ?? {},
      };

      try {
        const result = await this.computeAndPersistFactor(factor, ctx);
        factorResults.push(result);
        totalUpserted += result.upserted;
        if (result.error) totalFailed += 1;
      } catch (error) {
        const message = (error as Error).message;
        logger.error(`FactorPipeline: factor "${factor.name}" failed on ${tradeDate}: ${message}`);
        factorResults.push({
          factor_name: factor.name,
          fetched: 0,
          effective: 0,
          upserted: 0,
          error: message,
        });
        totalFailed += 1;
      }
    }

    logger.info(
      `FactorPipeline: trade_date=${tradeDate} universe=${universe.length} ` +
        `factors=${factorResults.length} upserted=${totalUpserted} failed=${totalFailed}`
    );

    return {
      trade_date: tradeDate,
      universe_size: universe.length,
      factor_results: factorResults,
      total_upserted: totalUpserted,
      total_failed: totalFailed,
    };
  }

  /**
   * 跑一个因子的完整闭环：compute → 横截面标准化 → bulkCreate upsert。
   *
   * 暴露 protected 是为了单元测试可以 mock 单一因子的流水；生产代码
   * 应当走 runForDate。
   */
  protected async computeAndPersistFactor(
    factor: Factor,
    ctx: FactorContext
  ): Promise<FactorRunSingleResult> {
    const raw: FactorComputeOutput = await factor.compute(ctx);

    // 1) 过滤可标准化样本（finite number 且非 null）
    const cleanedPairs: Array<{ code: string; v: number }> = [];
    for (const [code, value] of raw.entries()) {
      if (value === null || value === undefined) continue;
      if (!Number.isFinite(value)) continue;
      cleanedPairs.push({ code, v: value });
    }

    // 2) winsorize + zscore + percentile（横截面）
    // Batch Y (2026-06-17, fact-1 fix): zscore + percentile 必须基于同一份数据
    // (winsorized), 之前 zScore 用 winsorized 而 percentile 用 raw → 同一 stock 的
    // z_score 排序 ≠ percentile 排序, 下游 MFA 用 z_score 选股 / FactorWorkspace 用
    // percentile 排序时两套 top-30 不一致.
    let zScores: number[] = [];
    let percentiles: number[] = [];
    if (cleanedPairs.length >= 2) {
      const winsorized = winsorize(
        cleanedPairs.map(p => p.v),
        { lowerQuantile: 0.01, upperQuantile: 0.99 }
      );
      zScores = zscore(winsorized);
      percentiles = percentileRanks(winsorized);
    } else if (cleanedPairs.length === 1) {
      zScores = [0];
      percentiles = [0.5];
    }

    // 3) 构造 effective 行 + 用 universe 做中性补全
    const effectiveByCode = new Map<
      string,
      { raw_value: number; z_score: number; percentile: number }
    >();
    for (let i = 0; i < cleanedPairs.length; i += 1) {
      const p = cleanedPairs[i];
      effectiveByCode.set(p.code, {
        raw_value: p.v,
        z_score: zScores[i] ?? 0,
        percentile: percentiles[i] ?? 0.5,
      });
    }

    const records: Array<{
      trade_date: string;
      stock_code: string;
      factor_name: string;
      raw_value: number | null;
      z_score: number;
      percentile: number;
      source: string;
    }> = [];

    for (const code of ctx.universe) {
      const eff = effectiveByCode.get(code);
      if (eff) {
        records.push({
          trade_date: ctx.as_of_date,
          stock_code: code,
          factor_name: factor.name,
          raw_value: eff.raw_value,
          z_score: eff.z_score,
          percentile: eff.percentile,
          source: 'pipeline',
        });
      } else {
        // 中性补全：raw_value = null，z=0，percentile=0.5
        records.push({
          trade_date: ctx.as_of_date,
          stock_code: code,
          factor_name: factor.name,
          raw_value: null,
          z_score: 0,
          percentile: 0.5,
          source: 'pipeline',
        });
      }
    }

    // 4) bulkCreate + updateOnDuplicate
    await FactorScore.bulkCreate(records, {
      updateOnDuplicate: ['raw_value', 'z_score', 'percentile', 'source', 'updated_at'],
    });

    logger.info(
      `FactorPipeline: ${factor.name} ${ctx.as_of_date} fetched=${raw.size} ` +
        `effective=${cleanedPairs.length} upserted=${records.length}`
    );

    return {
      factor_name: factor.name,
      fetched: raw.size,
      effective: cleanedPairs.length,
      upserted: records.length,
    };
  }

  /**
   * 默认股票池 = stocks 表中 is_listed=true 的全部股票（无市场前缀的 symbol）。
   *
   * Stock.symbol 在该 codebase 里是 "600519.SH" / "000001.SZ" 形式，截掉 .SH/.SZ
   * 得到本表用的 stock_code 形式（与 NorthboundHolding / LimitUpStock / IndustryFlow
   * 的 stock_code 字段口径一致）。
   */
  private async loadDefaultUniverse(): Promise<string[]> {
    const rows = (await Stock.findAll({
      attributes: ['symbol'],
      where: {
        // Stock 表只有 is_listed 字段（无 is_active）；用 Op.or 兜底 null = 已上市
        // （旧数据该字段默认 NULL 但实际都在交易），与 sync-* 脚本的 --all 过滤一致
        [Op.or]: [{ is_listed: true }, { is_listed: null }],
      },
      raw: true,
    })) as unknown as Array<{ symbol: string }>;

    const codes = new Set<string>();
    for (const row of rows) {
      const symbol = row.symbol?.trim();
      if (!symbol) continue;
      // stripSuffix 处理双格式: "600519.SH" 截后缀 + "sh.600519" 截前缀
      const code = stripSuffix(symbol);
      if (code) codes.add(code);
    }
    return Array.from(codes).sort();
  }
}

/** 默认单例 */
export const factorPipeline = new FactorPipeline();
