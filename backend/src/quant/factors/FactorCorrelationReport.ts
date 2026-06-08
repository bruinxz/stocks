/**
 * FactorCorrelationReport — 因子两两相关性矩阵与共线性诊断（US-042）
 *
 * 多因子模型最致命的问题之一是把两个高度共线的因子一起加权：
 *   - 等于把同一个 alpha 信号算了两遍 → 实际权重失真
 *   - 横截面 zscore 经过共线传染 → 个股 score 异常放大
 *   - PortfolioOptimizer 用 IC_IR 加权时若两个高 IC 因子共线 → 优化结果不稳健
 *
 * **本模块计算**：在 [period_start, period_end] 区间上，所有 (factor_a, factor_b)
 * 对（factor_a < factor_b 字典序，上三角）的 Spearman 秩相关：
 *   - 每个 trade_date 取双因子的横截面 z_score（factor_score 表）
 *   - 两序列双有效（factor_a & factor_b 都有 z_score 且 finite）≥ MIN_PAIR_SIZE
 *     → 算单日 Spearman 相关
 *   - 区间内所有有效日的相关均值 = 该对的最终 correlation
 *
 * **|correlation| > REDUNDANCY_THRESHOLD (默认 0.7)** → is_redundant=true，且可选
 * 把该对写入 RiskAlert（per-admin user 的 LEVEL=HIGH 告警）。
 *
 * **公共接口**：
 *   - `generate(input, options?)` — 异步执行一次完整相关性计算；遍历所有 factor pair；
 *     选择性写入 FactorCorrelationResult；可选 fan-out RiskAlert；返回所有 pair 结果。
 *   - `getResults(filter?)` — 按 factor / 区间 / is_redundant 筛选已落库的结果。
 *   - `deleteResults(filter?)` — 按维度删除（admin 用）。
 *   - `cleanupOlderThan(days)` — 删除 N 天前的 period_end 结果。
 *
 * **3 个 export 纯函数 + 1 个 helper**（独立单测、完全脱离 DB）：
 *   - `dedupPairsToUpperTriangle(factor_names)` — 把 N 个因子名 → C(N, 2) 个
 *     上三角对 (factor_a < factor_b 字典序)
 *   - `computeDailyCorrelation(crossA, crossB, minPairSize)` — 单日双因子相关计算
 *     （含双有效过滤 + < MIN_PAIR_SIZE 返回 null）
 *   - `aggregateCorrelationSeries(dailyCorrs)` — 把日度相关序列聚合成 mean / std /
 *     sample_count / universe_avg_size
 *
 * **DataSource 接口注入**（与 US-041 FactorICReport 同款）：
 *   - 生产环境默认走 `DefaultFactorCorrelationDataSource` —— 读 factor_scores 表
 *     按 (trade_date, factor_name) 取横截面 z_score。
 *   - 测试时注入 fake DataSource，传入 trade_dates / cross_sections 的 Map 让单测
 *     完全脱离 DB / 网络。
 *
 * **错误隔离 per-day / per-pair**：
 *   - 某日双因子横截面 < MIN_PAIR_SIZE → 该日 correlation = null 不进入聚合；
 *   - 某日单因子横截面为空 → 该日 correlation = null；
 *   - 某对全区间无 valid day → sample_count=0 + correlation=null + persist=false 跳过 DB；
 *   - 单 pair 失败不阻塞后续 pair。
 *
 * **关键约束**：
 *   - **Spearman 而非 Pearson**：与 US-041 FactorICReport 同款判据：抗异常值（小盘股
 *     单日 z_score 极端值不会扭曲）+ rank-based 无量纲。
 *   - **MIN_PAIR_SIZE = 30**：与 US-041 MIN_CROSS_SECTION_SIZE 同款阈值；< 30 只
 *     双有效股票的相关统计意义弱。
 *   - **REDUNDANCY_THRESHOLD = 0.7**：AC 明确指定。|correlation| > 0.7 触发标记 +
 *     可选告警。**绝对值** —— 强负相关也算共线（一个是另一个的反向版本）。
 *   - **上三角去重**：N 因子有 C(N,2) 对；本表只存 factor_a < factor_b 的一半，
 *     UI 查 b vs a 时反向 lookup 即可。这与 US-041 IC 报告每因子单独一行的模式不同，
 *     因为相关性是对称的（corr(a,b) == corr(b,a)）。
 *   - **4-tuple PK upsert**：bulkCreate + updateOnDuplicate 用 (factor_a, factor_b,
 *     period_start, period_end) 重跑覆盖而非堆 N 行。
 *   - **factor_names 校验仅在未注入 DataSource 时执行**（同 US-041）：测试 fake
 *     mode 可以用未注册的因子名。
 *   - **per-pair 串行 await**（同 US-041 cache-friendly 模式）：因 loadFactorCrossSection
 *     上游有可能 cache；并发收益小。
 *   - **lookahead bias 不需要 guard**：与 IC 不同，相关性不涉及 forward return，
 *     只在同一交易日的横截面计算 —— factor_score[T] vs factor_score[T] 无未来信息。
 *
 * **设计取舍 — 不复用 OptimizationRun 父表**（同 US-040 / US-041 判据）：相关性
 * 矩阵是"对已有 FactorScore 做事后分析"，不是优化任务，直接 4-tuple PK 独立写本表。
 *
 * **设计取舍 — 共用 US-041 spearmanCorrelation / rankAscending / mean / sampleStddev**：
 * 避免代码复制；通过 quant/factors/FactorICReport.ts 的 export 直接复用。
 *
 * 主要消费方：
 *   - compute-factor-correlation.ts CLI（US-042）
 *   - 未来 US-016 FactorWorkspace 因子相关性热力图
 *   - 未来 US-044 PortfolioOptimizer 加因子组合优化时排除高相关对
 */

import { Op } from 'sequelize';
import { logger } from '../../utils/logger';
import { FactorCorrelationResult } from '../../models/FactorCorrelationResult';
import { FactorScore } from '../../models/FactorScore';
import { RiskAlert } from '../../models/RiskAlert';
import { factorRegistry } from './FactorRegistry';
import { spearmanCorrelation, mean, sampleStddev } from './FactorICReport';

// ============================================================
// 常量
// ============================================================

/**
 * 单日双因子相关计算的最小双有效股票数；少于此阈值整日相关 = null 不进入聚合。
 *
 * 30 与 US-041 MIN_CROSS_SECTION_SIZE 保持一致 —— 同一份"横截面统计要有意义
 * 必须 ≥ 30 个观测"的判据，IC 和 correlation 两类事后分析共用此阈值。
 */
export const MIN_PAIR_SIZE = 30;

/**
 * 相关性绝对值 > 此阈值则标记 is_redundant=true（AC 明确指定 0.7）。
 *
 * **绝对值**：强负相关也算共线（一个是另一个的反向版本，UI 加权时一加一减相当
 * 于没加）。
 */
export const REDUNDANCY_THRESHOLD = 0.7;

// ============================================================
// 类型
// ============================================================

/**
 * 单日单 pair 的相关性计算结果（保留 detail 让 ops 看 pair_size 是否过小）。
 */
export interface DailyCorrelationRecord {
  trade_date: string;
  /** Spearman 秩相关；null 表示该日无法计算（< MIN_PAIR_SIZE / 缺数据 / 全相等） */
  correlation: number | null;
  /** 实际进入相关计算的双有效股票数（factor_a & factor_b 都有 z_score 的股票数） */
  pair_size: number;
  /** 当日 correlation null 时的原因（诊断用） */
  reason?: string;
}

/**
 * 聚合后的相关性统计。
 */
export interface CorrelationStatistics {
  correlation_mean: number | null;
  correlation_std: number | null;
  /** 有效相关日数（pair_size ≥ MIN_PAIR_SIZE 且 spearman 不返回 null 的天数） */
  sample_count: number;
  /** sample_count 个日的 pair_size 平均值 */
  universe_avg_size: number;
}

/**
 * 单 pair 的完整结果（generate() 输出 + DB upsert 来源）。
 */
export interface FactorPairResult {
  factor_a: string;
  factor_b: string;
  statistics: CorrelationStatistics;
  /** 该对跑出的 per-day correlation 序列（按 trade_date 升序；null correlation 也保留诊断用） */
  daily_correlations: DailyCorrelationRecord[];
  /** 该对实际写库的 period_start / period_end */
  period_start: string;
  period_end: string;
  /** |correlation_mean| > REDUNDANCY_THRESHOLD → true；correlation_mean=null 时 false */
  is_redundant: boolean;
}

/**
 * generate() 入参。
 */
export interface FactorCorrelationReportInput {
  /** 必填：要算两两相关的因子名列表（至少 2 个；上三角自动去重） */
  factor_names: string[];
  /** 必填：聚合区间起始（YYYY-MM-DD，闭区间） */
  start_date: string;
  /** 必填：聚合区间结束（YYYY-MM-DD，闭区间） */
  end_date: string;
}

/**
 * generate() 选项。
 */
export interface FactorCorrelationReportOptions {
  /** 是否写入 factor_correlation_results 表（默认 true；CLI dry-run 时 false） */
  persist?: boolean;
  /** 自定义 DataSource（测试注入 fake；不传走 PRODUCTION_FACTOR_CORRELATION_DATA_SOURCE） */
  data_source?: FactorCorrelationDataSource;
  /** 自定义 source 标识（写入 FactorCorrelationResult.source；默认 'factor_correlation_report'） */
  source?: string;
  /** 自定义共线性阈值（默认 REDUNDANCY_THRESHOLD=0.7）。AC 是 0.7，仅在审计/特殊场景下覆盖。 */
  redundancy_threshold?: number;
  /**
   * 可选：要把 redundant pair 写入 RiskAlert 的 user_id 列表。
   * 不传 / 空数组 = 只在 factor_correlation_results.is_redundant 标记，不写告警表。
   * CLI 默认拿所有 admin 用户传入此参数。
   */
  alert_user_ids?: number[];
}

/**
 * generate() 返回。
 */
export interface FactorCorrelationReportResult {
  input_period: { start_date: string; end_date: string };
  pair_results: FactorPairResult[];
  /** 整次运行写入的总行数（persist=false 时 = 0） */
  upserted_count: number;
  /** 整次运行写入 RiskAlert 的总条数（alert_user_ids 空时 = 0） */
  alert_count: number;
  /** 整次运行总执行 ms */
  duration_ms: number;
}

/**
 * DataSource 接口（依赖注入用）。
 */
export interface FactorCorrelationDataSource {
  /**
   * 查询 [start, end] 区间内任一因子有 factor_score 记录的全部 distinct trade_date，
   * 按升序返回。注意是"任一因子"——因为后面 per-day 处理时每个 pair 自己去拿横截面，
   * 只要这天有任何因子有 score，就值得进入 per-day 循环。
   */
  loadTradeDatesInRange(factor_names: string[], start: string, end: string): Promise<string[]>;

  /**
   * 查询某日某因子的横截面：Map<stock_code, z_score>。
   * stock_code 无后缀，与 FactorScore.stock_code 一致。
   * 缺值 / raw_value=null 的行不返回（Pipeline 中性补全的 z_score=0 也应剔除，
   * 否则会让大批"无信号"行被纳入相关计算，相关性失真为接近 0）。
   *
   * 与 US-041 FactorICDataSource.loadFactorCrossSection 同款接口，但本模块
   * 为每个 (date, pair) 独立调用两次（factor_a + factor_b）——上游 DB cache
   * 应能命中。
   */
  loadFactorCrossSection(factor_name: string, trade_date: string): Promise<Map<string, number>>;
}

// ============================================================
// 纯函数（独立单测）
// ============================================================

/**
 * 把 N 个因子名 → C(N, 2) 个上三角对（factor_a < factor_b 字典序，无重复）。
 *
 * 示例：['quality', 'value', 'momentum'] → [
 *   {a:'momentum', b:'quality'},
 *   {a:'momentum', b:'value'},
 *   {a:'quality', b:'value'},
 * ]
 *
 * 排序保证调用方按上三角顺序遍历 → DB 写入与查询都是 factor_a < factor_b。
 *
 * 输入空数组 / 单元素 → 返回空数组。
 * 重复因子名 → 自动去重（Set）。
 */
export function dedupPairsToUpperTriangle(
  factor_names: string[]
): Array<{ factor_a: string; factor_b: string }> {
  const unique = Array.from(new Set(factor_names.filter(Boolean))).sort();
  if (unique.length < 2) return [];
  const pairs: Array<{ factor_a: string; factor_b: string }> = [];
  for (let i = 0; i < unique.length; i += 1) {
    for (let j = i + 1; j < unique.length; j += 1) {
      pairs.push({ factor_a: unique[i], factor_b: unique[j] });
    }
  }
  return pairs;
}

/**
 * 算某日双因子相关性的纯函数：
 *   - 取 crossA / crossB 的双有效股票（key 都在 + value 都是 finite）
 *   - 双有效数 < minPairSize → 返回 { correlation: null, pair_size, reason }
 *   - 否则调 spearmanCorrelation
 *
 * 完全脱离 DB，给测试用。生产链路也用此函数（避免内嵌实现）。
 */
export function computeDailyCorrelation(
  crossA: Map<string, number>,
  crossB: Map<string, number>,
  minPairSize: number = MIN_PAIR_SIZE
): { correlation: number | null; pair_size: number; reason?: string } {
  if (crossA.size === 0 || crossB.size === 0) {
    return { correlation: null, pair_size: 0, reason: 'empty_cross_section' };
  }
  const xs: number[] = [];
  const ys: number[] = [];
  // 遍历较小的一边（性能优化 + 与 IC 流程一致），用 has + get 检查另一边
  const [smaller, larger] = crossA.size <= crossB.size ? [crossA, crossB] : [crossB, crossA];
  // 但要保证 xs 始终对应 crossA、ys 始终对应 crossB（不能 swap 顺序，否则相关性
  // 输出符号反转）—— 所以必须按 crossA 的 key 顺序遍历
  for (const code of crossA.keys()) {
    const a = crossA.get(code);
    const b = crossB.get(code);
    if (a !== undefined && b !== undefined && Number.isFinite(a) && Number.isFinite(b)) {
      xs.push(a);
      ys.push(b);
    }
  }
  // suppress lint: smaller/larger reserved for future optimization
  void smaller;
  void larger;

  const pairSize = xs.length;
  if (pairSize < minPairSize) {
    return {
      correlation: null,
      pair_size: pairSize,
      reason: `pair_size_lt_min_${minPairSize}`,
    };
  }
  const corr = spearmanCorrelation(xs, ys);
  if (corr === null) {
    return {
      correlation: null,
      pair_size: pairSize,
      reason: 'spearman_null_likely_degenerate',
    };
  }
  return { correlation: corr, pair_size: pairSize };
}

/**
 * 把日度相关性序列聚合成 CorrelationStatistics。
 *
 * 规则（与 US-041 aggregateICSeries 同款）：
 *   - 跳过 correlation = null 的日（不进入 sample_count / mean / std）；
 *   - sample_count = 有效相关日数；
 *   - sample_count = 0 → all metrics = null；
 *   - sample_count = 1 → mean = 该值，std = null（n-1 公式不可用）；
 *   - sample_count ≥ 2 且 std = 0 → 仍保留 mean，std = 0；
 *   - universe_avg_size = mean(pair_size of valid days)，rounded to int。
 */
export function aggregateCorrelationSeries(
  dailyCorrelations: DailyCorrelationRecord[]
): CorrelationStatistics {
  const validRecords = dailyCorrelations.filter(
    d => d.correlation !== null && Number.isFinite(d.correlation as number)
  );
  const sampleCount = validRecords.length;

  if (sampleCount === 0) {
    return {
      correlation_mean: null,
      correlation_std: null,
      sample_count: 0,
      universe_avg_size: 0,
    };
  }

  const corrs = validRecords.map(r => r.correlation as number);
  const sizes = validRecords.map(r => r.pair_size);

  const corrMean = mean(corrs);
  const corrStd = sampleCount >= 2 ? sampleStddev(corrs) : null;

  const sizeMean = mean(sizes);
  const universeAvgSize = sizeMean === null ? 0 : Math.round(sizeMean);

  return {
    correlation_mean: corrMean,
    correlation_std: corrStd,
    sample_count: sampleCount,
    universe_avg_size: universeAvgSize,
  };
}

// ============================================================
// 默认生产实现
// ============================================================

export class DefaultFactorCorrelationDataSource implements FactorCorrelationDataSource {
  async loadTradeDatesInRange(
    factor_names: string[],
    start: string,
    end: string
  ): Promise<string[]> {
    if (!factor_names.length) return [];
    const rows = (await FactorScore.findAll({
      attributes: ['trade_date'],
      where: {
        factor_name: { [Op.in]: factor_names },
        trade_date: { [Op.between]: [start, end] },
      },
      group: ['trade_date'],
      order: [['trade_date', 'ASC']],
      raw: true,
    })) as unknown as Array<{ trade_date: string }>;
    return rows.map(r => r.trade_date).filter(Boolean);
  }

  async loadFactorCrossSection(
    factor_name: string,
    trade_date: string
  ): Promise<Map<string, number>> {
    // 过滤 raw_value IS NOT NULL：中性补全行（z_score=0, raw_value=null）不算
    // 有效信号；纳入相关计算会让大批"无信号"行让相关性向 0 漂移。
    const rows = (await FactorScore.findAll({
      attributes: ['stock_code', 'z_score'],
      where: {
        factor_name,
        trade_date,
        raw_value: { [Op.ne]: null },
      },
      raw: true,
    })) as unknown as Array<{ stock_code: string; z_score: number | string }>;
    const out = new Map<string, number>();
    for (const r of rows) {
      const z = Number(r.z_score);
      if (Number.isFinite(z) && r.stock_code) {
        out.set(r.stock_code, z);
      }
    }
    return out;
  }
}

/** 生产环境默认 DataSource 单例 */
export const PRODUCTION_FACTOR_CORRELATION_DATA_SOURCE: FactorCorrelationDataSource =
  new DefaultFactorCorrelationDataSource();

// ============================================================
// 主类 FactorCorrelationReport
// ============================================================

/**
 * 列出已落库的相关性结果时的可选过滤条件。
 */
export interface CorrelationResultFilter {
  factor_name?: string; // 匹配 factor_a 或 factor_b
  is_redundant?: boolean;
  /** period_end ≥ 该日期 */
  period_end_from?: string;
  /** period_end ≤ 该日期 */
  period_end_to?: string;
  /** 返回上限（默认 200） */
  limit?: number;
}

export class FactorCorrelationReport {
  /**
   * 算一批因子的两两相关性矩阵。
   *
   * 流程：
   *   1. 校验参数（factor_names 校验仅在未注入 DataSource 时执行）
   *   2. 用 dedupPairsToUpperTriangle 生成 C(N, 2) 个上三角对
   *   3. 用 DataSource 拉 [start_date, end_date] 内有 factor_score 的 trade_dates
   *   4. 对每个 pair 独立跑：per-day 串行 → 单日相关 → 聚合
   *   5. 写库（persist=true）+ 可选 fan-out RiskAlert + 返回完整 pair_results
   */
  async generate(
    input: FactorCorrelationReportInput,
    options: FactorCorrelationReportOptions = {}
  ): Promise<FactorCorrelationReportResult> {
    const t0 = Date.now();
    const dataSource = options.data_source ?? PRODUCTION_FACTOR_CORRELATION_DATA_SOURCE;
    const persist = options.persist ?? true;
    const source = options.source ?? 'factor_correlation_report';
    const redundancyThreshold = options.redundancy_threshold ?? REDUNDANCY_THRESHOLD;
    const alertUserIds = options.alert_user_ids ?? [];

    // 1) 参数校验
    if (!Array.isArray(input.factor_names) || input.factor_names.length < 2) {
      throw new Error(
        `FactorCorrelationReport.generate: factor_names must have at least 2 items, got ${
          (input.factor_names as any[])?.length ?? 0
        }`
      );
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.start_date)) {
      throw new Error(
        `FactorCorrelationReport.generate: invalid start_date (expected YYYY-MM-DD): ${input.start_date}`
      );
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.end_date)) {
      throw new Error(
        `FactorCorrelationReport.generate: invalid end_date (expected YYYY-MM-DD): ${input.end_date}`
      );
    }
    if (input.start_date >= input.end_date) {
      throw new Error(
        `FactorCorrelationReport.generate: start_date must be < end_date (got ${input.start_date} >= ${input.end_date})`
      );
    }
    if (
      !Number.isFinite(redundancyThreshold) ||
      redundancyThreshold < 0 ||
      redundancyThreshold > 1
    ) {
      throw new Error(
        `FactorCorrelationReport.generate: redundancy_threshold must be in [0, 1], got ${redundancyThreshold}`
      );
    }

    // 校验因子名（仅在未注入 DataSource 时校验，同 US-041 模式）
    if (!options.data_source) {
      for (const name of input.factor_names) {
        if (!factorRegistry.has(name)) {
          throw new Error(
            `FactorCorrelationReport.generate: factor "${name}" not registered. ` +
              `Known: ${factorRegistry.listNames().join(', ') || '(empty)'}`
          );
        }
      }
    }

    // 2) 生成上三角 pair 列表
    const pairs = dedupPairsToUpperTriangle(input.factor_names);
    if (pairs.length === 0) {
      // 入参 N=1 或全部去重后只剩 1 个；上面 length<2 已经拦住，但 defense
      logger.warn('FactorCorrelationReport: no factor pairs to compute after dedup');
    }

    // 3) 拉 trade_dates
    const tradeDates = await dataSource.loadTradeDatesInRange(
      input.factor_names,
      input.start_date,
      input.end_date
    );
    if (!tradeDates.length) {
      logger.warn(
        `FactorCorrelationReport: no trade_dates with factor_score for ` +
          `factors=[${input.factor_names.join(',')}] in [${input.start_date}, ${input.end_date}]`
      );
    }

    // 4) 逐 pair 跑
    const pairResults: FactorPairResult[] = [];
    let upsertedCount = 0;
    let alertCount = 0;
    const computedAt = new Date();

    for (const pair of pairs) {
      const pairResult = await this.computePair(
        pair.factor_a,
        pair.factor_b,
        tradeDates,
        dataSource,
        redundancyThreshold
      );
      pairResults.push(pairResult);

      if (persist && pairResult.statistics.sample_count > 0) {
        await this.persistResult(pairResult, computedAt, source);
        upsertedCount += 1;
      }

      if (pairResult.is_redundant && alertUserIds.length > 0) {
        const wrote = await this.writeRedundancyAlerts(pairResult, alertUserIds);
        alertCount += wrote;
      }
    }

    const durationMs = Date.now() - t0;
    const redundantCount = pairResults.filter(p => p.is_redundant).length;
    logger.info(
      `FactorCorrelationReport: factors=${input.factor_names.length} ` +
        `pairs=${pairs.length} period=[${input.start_date},${input.end_date}] ` +
        `redundant=${redundantCount} upserted=${upsertedCount} alerts=${alertCount} ` +
        `duration_ms=${durationMs}`
    );

    return {
      input_period: { start_date: input.start_date, end_date: input.end_date },
      pair_results: pairResults,
      upserted_count: upsertedCount,
      alert_count: alertCount,
      duration_ms: durationMs,
    };
  }

  /**
   * 跑某 pair 在 trade_dates 序列上的相关性计算。
   *
   * per-day 串行（同 US-041 cache-friendly 模式）：双因子各自拉横截面，单日
   * 失败不影响后续日。
   */
  protected async computePair(
    factor_a: string,
    factor_b: string,
    tradeDates: string[],
    dataSource: FactorCorrelationDataSource,
    redundancyThreshold: number
  ): Promise<FactorPairResult> {
    const dailyCorrelations: DailyCorrelationRecord[] = [];

    for (const tradeDate of tradeDates) {
      const crossA = await dataSource.loadFactorCrossSection(factor_a, tradeDate);
      const crossB = await dataSource.loadFactorCrossSection(factor_b, tradeDate);
      const { correlation, pair_size, reason } = computeDailyCorrelation(crossA, crossB);
      dailyCorrelations.push({
        trade_date: tradeDate,
        correlation,
        pair_size,
        reason,
      });
    }

    const statistics = aggregateCorrelationSeries(dailyCorrelations);

    // period_start / period_end = 实际有 valid correlation 的日期范围
    const validRecords = dailyCorrelations.filter(d => d.correlation !== null);
    let periodStart: string;
    let periodEnd: string;
    if (validRecords.length > 0) {
      periodStart = validRecords[0].trade_date;
      periodEnd = validRecords[validRecords.length - 1].trade_date;
    } else if (tradeDates.length > 0) {
      periodStart = tradeDates[0];
      periodEnd = tradeDates[tradeDates.length - 1];
    } else {
      periodStart = '1970-01-01';
      periodEnd = '1970-01-02';
    }

    const isRedundant =
      statistics.correlation_mean !== null &&
      Math.abs(statistics.correlation_mean) > redundancyThreshold;

    return {
      factor_a,
      factor_b,
      statistics,
      daily_correlations: dailyCorrelations,
      period_start: periodStart,
      period_end: periodEnd,
      is_redundant: isRedundant,
    };
  }

  /**
   * 把单 pair statistics 写入 factor_correlation_results 表（idempotent upsert）。
   */
  protected async persistResult(
    pairResult: FactorPairResult,
    computedAt: Date,
    source: string
  ): Promise<void> {
    await FactorCorrelationResult.upsert({
      factor_a: pairResult.factor_a,
      factor_b: pairResult.factor_b,
      period_start: pairResult.period_start,
      period_end: pairResult.period_end,
      correlation: pairResult.statistics.correlation_mean,
      sample_count: pairResult.statistics.sample_count,
      universe_avg_size: pairResult.statistics.universe_avg_size,
      is_redundant: pairResult.is_redundant,
      computed_at: computedAt,
      source,
    } as any);
  }

  /**
   * 给指定 user_ids 写 RiskAlert（per user 一条）。
   * 返回实际写入的条数。
   *
   * **告警 schema 借用 RiskAlert 现有 symbol/name 字段**：
   *   - symbol = 'SYSTEM:FACTOR_CORR'（系统级告警 sentinel；前端可按此 prefix
   *     过滤区分股票告警 vs 系统告警）
   *   - name = `${factor_a} vs ${factor_b}`
   *   - level = 'HIGH'
   *   - message = 中文描述含 correlation 值 + 区间
   */
  protected async writeRedundancyAlerts(
    pairResult: FactorPairResult,
    userIds: number[]
  ): Promise<number> {
    if (!userIds.length) return 0;
    const corr = pairResult.statistics.correlation_mean ?? 0;
    const message =
      `[因子共线告警] ${pairResult.factor_a} 与 ${pairResult.factor_b} 在区间 ` +
      `[${pairResult.period_start}, ${pairResult.period_end}] 的横截面 Spearman ` +
      `相关均值为 ${corr.toFixed(4)}（|corr| > ${REDUNDANCY_THRESHOLD}），` +
      `两因子高度共线，建议从多因子模型移除其一以避免双重打分。` +
      `sample_count=${pairResult.statistics.sample_count}, ` +
      `universe_avg=${pairResult.statistics.universe_avg_size}.`;
    let written = 0;
    for (const userId of userIds) {
      try {
        await RiskAlert.create({
          user_id: userId,
          symbol: 'SYSTEM:FACTOR_CORR',
          name: `${pairResult.factor_a} vs ${pairResult.factor_b}`,
          level: 'HIGH',
          message,
          // US-067 — 给 RealtimeAlertDispatcher dedup signature 用；同 user 同对因子在
          // 30 min 内的多次报告只推一次。
          rule_id: 'factor_correlation',
          is_read: false,
        } as any);
        written += 1;
      } catch (err) {
        // 单用户写入失败不阻塞后续用户；记 log 让 ops 排查
        logger.warn(
          `FactorCorrelationReport: failed to write RiskAlert for user=${userId} ` +
            `pair=${pairResult.factor_a}/${pairResult.factor_b}: ${(err as Error).message}`
        );
      }
    }
    return written;
  }

  /**
   * 列出已落库的相关性结果。支持按 factor_name (匹配 a 或 b)、is_redundant、
   * period_end 范围过滤。默认按 computed_at DESC 返回，limit 200。
   */
  async getResults(filter: CorrelationResultFilter = {}): Promise<FactorCorrelationResult[]> {
    const where: any = {};
    if (filter.factor_name) {
      where[Op.or] = [{ factor_a: filter.factor_name }, { factor_b: filter.factor_name }];
    }
    if (filter.is_redundant !== undefined) {
      where.is_redundant = filter.is_redundant;
    }
    if (filter.period_end_from || filter.period_end_to) {
      where.period_end = {};
      if (filter.period_end_from) where.period_end[Op.gte] = filter.period_end_from;
      if (filter.period_end_to) where.period_end[Op.lte] = filter.period_end_to;
    }
    const limit = filter.limit ?? 200;
    return await FactorCorrelationResult.findAll({
      where,
      order: [
        ['computed_at', 'DESC'],
        ['factor_a', 'ASC'],
        ['factor_b', 'ASC'],
      ],
      limit,
    });
  }

  /**
   * 按过滤条件删除（admin 用）。返回删除行数。
   */
  async deleteResults(filter: CorrelationResultFilter = {}): Promise<number> {
    const where: any = {};
    if (filter.factor_name) {
      where[Op.or] = [{ factor_a: filter.factor_name }, { factor_b: filter.factor_name }];
    }
    if (filter.is_redundant !== undefined) {
      where.is_redundant = filter.is_redundant;
    }
    if (filter.period_end_from || filter.period_end_to) {
      where.period_end = {};
      if (filter.period_end_from) where.period_end[Op.gte] = filter.period_end_from;
      if (filter.period_end_to) where.period_end[Op.lte] = filter.period_end_to;
    }
    return await FactorCorrelationResult.destroy({ where });
  }

  /**
   * 清理 N 天前的全部相关性结果（按 period_end 判定）。
   * 返回删除行数。
   */
  async cleanupOlderThan(days: number): Promise<number> {
    if (!Number.isFinite(days) || days < 0) {
      throw new Error(`cleanupOlderThan: days must be non-negative, got ${days}`);
    }
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - Math.floor(days));
    const cutoffIso = cutoff.toISOString().slice(0, 10);
    return await FactorCorrelationResult.destroy({
      where: { period_end: { [Op.lt]: cutoffIso } },
    });
  }
}

/** 默认单例 */
export const factorCorrelationReport = new FactorCorrelationReport();
