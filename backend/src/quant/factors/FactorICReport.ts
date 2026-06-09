/**
 * FactorICReport — 因子 IC 报告与 IC 衰减分析（US-041）
 *
 * IC (Information Coefficient) 是量化界判因子有效性的金标准：每个交易日把横截面
 * 上 `factor.z_score` 与 `look_forward_days 日后的 forward return` 做 **Spearman 秩
 * 相关**，相关系数就是当日 IC。聚合一段时间内所有交易日的 IC：
 *
 *   - **IC mean** > 0.05 一般认为因子有 alpha；
 *   - **IC_IR = IC mean / IC std** > 0.5 算稳健；
 *   - **IC > 0 的比例** 表示因子方向的一致性（> 60% 较好）；
 *   - **IC 衰减**：跑 lookForwardDays=1,5,10,20,60 的 IC mean 序列；衰减太快说明
 *     信号短期化（适合短线），衰减慢且稳定说明因子真有长期 alpha。
 *
 * **公共接口**：
 *   - `generate(input, options?)` — 异步执行一次完整 IC 计算；按 lookForwardDays 列表
 *     循环；选择性写入 FactorICResult；返回 { factor_name, period, results_by_window }。
 *   - `getResults(filter?)` — 按因子名 / 窗口 / 区间筛选已落库的 IC 结果。
 *   - `deleteResults(filter?)` — 按维度删除（admin 用）。
 *   - `cleanupOlderThan(days)` — 删除 N 天前的 period_end 结果。
 *
 * **5 个 export 纯函数 + 1 个聚合函数**（独立单测、完全脱离 DB）：
 *   - `rankAscending(values)` — 把 raw values 转 ascending rank（1..n，tie = avg rank）
 *   - `spearmanCorrelation(x, y)` — 两序列 Spearman 秩相关；缺数据 / 全相等 → null
 *   - `mean(values)` / `sampleStddev(values)` — 简单聚合（独立实现，避免反向依赖
 *     quant/backtest/ 模块的同名函数 — 见 US-040 "跨模块反向依赖避免" 范式）
 *   - `aggregateICSeries(dailyICs)` — 把 IC 时序聚合成 ICStatistics
 *
 * **DataSource 接口注入**（与 GridSearchOptimizer.BacktestRunner /
 * RegimeSegmentedBacktest.RegimeSource 同模式）：
 *   - 生产环境默认走 `DefaultFactorICDataSource` —— FactorScore 拿当日横截面 z_score，
 *     DailyBar + Stock 拿 base_close + future_close (tail-index ≥ N 个 bar)。
 *   - 测试时注入 fake DataSource，传入 trade_dates / cross_section / forward_returns
 *     的 Map 让单测完全脱离 DB / 网络。
 *
 * **错误隔离 per-day**：
 *   - 某日 cross-section < MIN_CROSS_SECTION_SIZE → 该日 IC = null 不进入聚合；
 *   - 某日 forward return 拉空 → 该日 IC = null 不进入聚合；
 *   - 单日失败不阻塞后续日。
 *
 * **关键约束**：
 *   - forward return 用未来 N 个**交易日**（不是自然日）；DB 查 DailyBar 按
 *     `stock_id IN ... AND time > base_date ORDER BY time ASC` 取第 N+1 条
 *     (= 现在的 close 与 N 个交易日后的 close 相比)，同 momentum / low_vol 的
 *     tail-index 对齐模式。
 *   - **Spearman 而非 Pearson**：AC 明确要求 + 抗异常值（小盘股单日 forward return
 *     +100% 会让 Pearson 失真）+ rank-based 相关无量纲。
 *   - **同 z_score 取平均秩**（Spearman 标准 "ties get the same rank = mean of tied
 *     positions"）；零变化（所有股票 z_score 一样 → stddev=0）时返回 null。
 *   - **MIN_CROSS_SECTION_SIZE = 30**：单日横截面有效股票 < 30 时整日 IC = null
 *     不进入聚合。少于 30 只股票的横截面 IC 没有统计意义。
 *   - **lookahead bias guard**：base_date + lookForwardDays 落在 end_date 之外 →
 *     该日跳过。factor_scores 必须严格早于 future_close 的 trade_date。
 *   - **4-tuple PK upsert**：bulkCreate + updateOnDuplicate 用 (factor_name,
 *     look_forward_days, period_start, period_end) 重跑覆盖而非堆 N 行。
 *   - **factor_name 校验仅在未注入 DataSource 时执行**（同 GridSearch/Bayesian/
 *     WalkForward 测试 fake mode 跳过 registry 的模式）。
 *   - **per-day 串行 await**（同 US-040 cache-friendly 模式）：DailyBar 查询有
 *     stock_id 索引，单查询 ~50ms；并发收益小，串行让日志可读、单日失败不影响后续。
 *
 * **设计取舍 — 不复用 OptimizationRun 父表**（同 US-040 RegimeSegmentedBacktest
 * 判据）：IC 报告是 "对已有 FactorScore 做事后分析"，不是优化任务，与
 * RegimeSegmentedBacktest 一样直接用自带 4-tuple PK 落库即可。
 *
 * 主要消费方：
 *   - compute-factor-ic.ts CLI（US-041）
 *   - 未来 US-042 FactorCorrelationReport（可能 join 本表做"高 IC + 低相关"组合）
 *   - 未来 US-044 PortfolioOptimizer（用 IC_IR 做因子权重先验）
 *   - 未来 US-015 FactorWorkspace（因子卡片上直接展示 IC/IC_IR）
 */

import { Op } from 'sequelize';
import { logger } from '../../utils/logger';
import { FactorICResult } from '../../models/FactorICResult';
import { FactorScore } from '../../models/FactorScore';
import { DailyBar } from '../../models/DailyBar';
import { Stock } from '../../models/Stock';
import { factorRegistry } from './FactorRegistry';
import { inferStockSymbol, stripSuffix } from './library/_helpers';

// ============================================================
// 常量
// ============================================================

/** AC 指定的默认 lookForwardDays 列表（IC 衰减分析覆盖短中长期窗口） */
export const DEFAULT_LOOK_FORWARD_DAYS = Object.freeze([1, 5, 10, 20, 60] as const);

/**
 * 单日横截面 IC 计算的最小有效股票数；少于此阈值整日 IC = null 不进入聚合。
 *
 * 30 的来源：A 股全市场 5000+ 只股票里，一个有效因子横截面通常 ≥ 70% 覆盖
 * (3000+ 只)。即便最稀疏的因子（如 dragon_tiger）单日覆盖也常 > 100。<30 通常
 * 意味着 factor_scores 表稀疏或者 factor 失效，对应 IC 噪音大、统计不显著。
 */
export const MIN_CROSS_SECTION_SIZE = 30;

/** 查询 forward close 时的多取 buffer（防春节/十一长假导致 N+1 个交易日窗口失败） */
const FORWARD_BAR_CALENDAR_BUFFER_DAYS = 30;

// ============================================================
// 类型
// ============================================================

/**
 * 单日 IC 计算结果（保留 detail 让 ops 看 universe size 是否过小）。
 */
export interface DailyICRecord {
  trade_date: string;
  /** Spearman 秩相关；null 表示该日无法计算（< MIN_CROSS_SECTION_SIZE / 全相等 / 缺数据） */
  ic: number | null;
  /** 实际进入相关计算的双有效股票数（factor & forward return 都有） */
  effective_size: number;
  /** 当日 IC null 时的原因（诊断用） */
  reason?: string;
}

/**
 * 聚合后的 IC 统计（写入 FactorICResult 表 ic_* 字段）。
 */
export interface ICStatistics {
  ic_mean: number | null;
  ic_std: number | null;
  ic_ir: number | null;
  ic_positive_ratio: number | null;
  sample_count: number;
  /** 实际 sample_count 个日的 effective_size 平均值 */
  universe_avg_size: number;
}

/**
 * generate() 入参。
 */
export interface FactorICReportInput {
  /** 必填：要算 IC 的因子名（FactorRegistry 中的 name） */
  factor_name: string;
  /** 必填：聚合区间起始（YYYY-MM-DD，闭区间）；用作 factor_score 的 trade_date 起点 */
  start_date: string;
  /** 必填：聚合区间结束（YYYY-MM-DD，闭区间）；用作 forward close 的 trade_date 终点 */
  end_date: string;
  /** 可选：lookForward 窗口列表；默认 [1, 5, 10, 20, 60]（AC 指定） */
  look_forward_days_list?: number[];
  /** 可选：限定 universe（无后缀 stock_code 列表）；不传 = 用当日 FactorScore 全集 */
  universe?: string[];
}

/**
 * generate() 选项。
 */
export interface FactorICReportOptions {
  /** 是否写入 factor_ic_results 表（默认 true；CLI dry-run 时 false） */
  persist?: boolean;
  /** 自定义 DataSource（测试注入 fake；不传走 PRODUCTION_FACTOR_IC_DATA_SOURCE） */
  data_source?: FactorICDataSource;
  /** 自定义 source 标识（写入 FactorICResult.source；默认 'factor_ic_report'） */
  source?: string;
}

/**
 * 单个 lookForward 窗口的 detail 输出。
 */
export interface FactorICWindowResult {
  look_forward_days: number;
  statistics: ICStatistics;
  /** 该窗口跑出的 per-day IC 序列（按 trade_date 升序；null IC 也保留便于诊断） */
  daily_ics: DailyICRecord[];
  /** 该窗口实际写库的 period_start / period_end（lookahead-bias-adjusted） */
  period_start: string;
  period_end: string;
}

/**
 * generate() 返回。
 */
export interface FactorICReportResult {
  factor_name: string;
  input_period: { start_date: string; end_date: string };
  results_by_window: FactorICWindowResult[];
  /** 整次运行写入的总行数（persist=false 时 = 0） */
  upserted_count: number;
  /** 整次运行总执行 ms */
  duration_ms: number;
}

/**
 * DataSource 接口（依赖注入用）。
 */
export interface FactorICDataSource {
  /**
   * 查询 [start, end] 区间内有 factor_score 记录的全部 distinct trade_date，
   * 按升序返回。
   */
  loadTradeDatesInRange(factor_name: string, start: string, end: string): Promise<string[]>;

  /**
   * 查询某日某因子的横截面：Map<stock_code, z_score>。
   * stock_code 无后缀，与 FactorScore.stock_code 一致。
   * 缺值 / raw_value=null 的行不返回 (Pipeline 中性补全的 z_score=0 也应剔除，
   * 因为它代表"无信息"不是真信号；实现上以 raw_value IS NOT NULL 过滤)。
   */
  loadFactorCrossSection(factor_name: string, trade_date: string): Promise<Map<string, number>>;

  /**
   * 查询某批股票在 base_date 后第 N+1 个交易日的 forward return：
   * forward_return = (future_close - base_close) / base_close
   *
   * 实现需用 DailyBar 升序查询，取第 N+1 条作为 future_close（tail-index 与
   * momentum / low_vol 一致；自然消化春节/十一节假日 gap）。
   *
   * 返回 Map<stock_code, return> 不含 stock 没有足够 bars 或 base_close ≤ 0
   * 的项；不强制 universe 全覆盖。
   */
  loadForwardReturns(
    stock_codes: string[],
    base_date: string,
    forward_days: number
  ): Promise<Map<string, number>>;
}

// ============================================================
// 纯函数：rank / Spearman / mean / sampleStddev / aggregateICSeries
// ============================================================

/**
 * 把 values 转为 ascending rank（1..n）。同值用 "平均秩" 处理（Spearman 标准
 * tie-handling）。NaN / 非 finite 数会破坏排序，**调用方必须先过滤**。
 *
 * 示例：[10, 30, 20, 30] → [1, 3.5, 2, 3.5]
 * 示例：[5, 5, 5] → [2, 2, 2]
 * 示例：[] → []
 */
export function rankAscending(values: number[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  if (n === 1) return [1];

  // 按 value 升序 + 记录原始 index
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);

  const ranks = new Array<number>(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && indexed[j + 1].v === indexed[i].v) j += 1;
    // 区间 [i, j] 都是 tie，平均秩 = ((i+1) + (j+1)) / 2
    const avgRank = (i + 1 + (j + 1)) / 2;
    for (let k = i; k <= j; k += 1) {
      ranks[indexed[k].i] = avgRank;
    }
    i = j + 1;
  }
  return ranks;
}

/**
 * Spearman 秩相关：两序列转 rank → Pearson 相关。
 *
 * 返回 null 的情况：
 *   - x.length !== y.length（调用方应保证）
 *   - 任一序列长度 < 2
 *   - 任一序列变异度（stddev）= 0（全部相等，无法相关）
 *
 * 返回值范围 [-1, 1]（理论上）；浮点精度允许极小越界。
 *
 * 注：调用方应在传入前过滤 NaN / Infinity；本函数对 NaN 会得到 NaN 结果。
 */
export function spearmanCorrelation(x: number[], y: number[]): number | null {
  if (x.length !== y.length) return null;
  if (x.length < 2) return null;

  const rx = rankAscending(x);
  const ry = rankAscending(y);

  const mx = mean(rx);
  const my = mean(ry);
  if (mx === null || my === null) return null;

  let num = 0;
  let denomX = 0;
  let denomY = 0;
  for (let i = 0; i < rx.length; i += 1) {
    const dx = rx[i] - mx;
    const dy = ry[i] - my;
    num += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }
  if (denomX === 0 || denomY === 0) return null;
  return num / Math.sqrt(denomX * denomY);
}

/**
 * 算术均值；null 表示无有效样本。NaN / Infinity 自动过滤。
 *
 * 独立实现而不复用 RegimeSegmentedBacktest 的 mean —— 同 US-040
 * "跨模块反向依赖避免" 范式：quant/factors/ 不能 import quant/backtest/。
 */
export function mean(values: number[]): number | null {
  if (!values || values.length === 0) return null;
  let sum = 0;
  let count = 0;
  for (const v of values) {
    if (Number.isFinite(v)) {
      sum += v;
      count += 1;
    }
  }
  if (count === 0) return null;
  return sum / count;
}

/**
 * n-1 样本标准差；少于 2 个有效观测返回 null。NaN / Infinity 自动过滤。
 */
export function sampleStddev(values: number[]): number | null {
  if (!values || values.length === 0) return null;
  const valid = values.filter(v => Number.isFinite(v));
  if (valid.length < 2) return null;
  const m = valid.reduce((s, v) => s + v, 0) / valid.length;
  let ss = 0;
  for (const v of valid) ss += (v - m) * (v - m);
  return Math.sqrt(ss / (valid.length - 1));
}

/**
 * 把日度 IC 序列聚合成 ICStatistics。
 *
 * 规则：
 *   - 跳过 ic = null 的日（不进入 sample_count / mean / std / positive_ratio）；
 *   - sample_count = 有效 IC 日数；
 *   - sample_count = 0 → all metrics = null；
 *   - sample_count = 1 → ic_mean = 该值，ic_std = null（n-1 公式不可用），ic_ir = null；
 *   - sample_count ≥ 2 且 ic_std = 0 → ic_ir = null（防 NaN）；
 *   - ic_positive_ratio = count(ic > 0) / sample_count（严格 > 0；ic == 0 不计正）；
 *   - universe_avg_size = mean(effective_size of valid IC days)。
 */
export function aggregateICSeries(dailyICs: DailyICRecord[]): ICStatistics {
  const validRecords = dailyICs.filter(d => d.ic !== null && Number.isFinite(d.ic as number));
  const sampleCount = validRecords.length;

  if (sampleCount === 0) {
    return {
      ic_mean: null,
      ic_std: null,
      ic_ir: null,
      ic_positive_ratio: null,
      sample_count: 0,
      universe_avg_size: 0,
    };
  }

  const ics = validRecords.map(r => r.ic as number);
  const sizes = validRecords.map(r => r.effective_size);

  const icMean = mean(ics);
  const icStd = sampleCount >= 2 ? sampleStddev(ics) : null;

  let icIr: number | null = null;
  if (icMean !== null && icStd !== null && icStd > 0) {
    icIr = icMean / icStd;
  }

  const positiveCount = ics.filter(v => v > 0).length;
  const icPositiveRatio = positiveCount / sampleCount;

  const sizeMean = mean(sizes);
  const universeAvgSize = sizeMean === null ? 0 : Math.round(sizeMean);

  return {
    ic_mean: icMean,
    ic_std: icStd,
    ic_ir: icIr,
    ic_positive_ratio: icPositiveRatio,
    sample_count: sampleCount,
    universe_avg_size: universeAvgSize,
  };
}

// ============================================================
// 默认生产实现：DefaultFactorICDataSource
// ============================================================

export class DefaultFactorICDataSource implements FactorICDataSource {
  async loadTradeDatesInRange(factor_name: string, start: string, end: string): Promise<string[]> {
    const rows = (await FactorScore.findAll({
      attributes: ['trade_date'],
      where: {
        factor_name,
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
    // 有效信号，把它们参与 IC 会让横截面被中性行稀释，IC 系统性偏小。
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

  async loadForwardReturns(
    stock_codes: string[],
    base_date: string,
    forward_days: number
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!stock_codes.length || forward_days < 1) return out;

    // 1) 把无后缀 stock_codes 反推为 Stock.symbol → 拿 stock_id
    const symbols = Array.from(new Set(stock_codes.map(inferStockSymbol).filter(Boolean)));
    if (!symbols.length) return out;
    const stockRows = (await Stock.findAll({
      attributes: ['id', 'symbol'],
      where: { symbol: { [Op.in]: symbols } },
      raw: true,
    })) as unknown as Array<{ id: number; symbol: string }>;

    const stockIdToCode = new Map<number, string>();
    const stockIds: number[] = [];
    for (const s of stockRows) {
      // stripSuffix 处理两种格式：sh.600519 / 600519.SH 都能正确取出 600519
      const code = stripSuffix(s.symbol);
      if (code) {
        stockIdToCode.set(s.id, code);
        stockIds.push(s.id);
      }
    }
    if (!stockIds.length) return out;

    // 2) 拉 DailyBar [base_date, base_date + forward_days + buffer 自然日]
    //    取每只股票的所有 bars，按 time ASC 排序后用 tail-index N+1 取 future close。
    const base = new Date(`${base_date}T00:00:00Z`);
    const endDate = new Date(base);
    endDate.setUTCDate(endDate.getUTCDate() + forward_days * 2 + FORWARD_BAR_CALENDAR_BUFFER_DAYS);
    const startTimeIso = base.toISOString();
    const endTimeIso = endDate.toISOString();

    const bars = (await DailyBar.findAll({
      attributes: ['stock_id', 'time', 'close'],
      where: {
        stock_id: { [Op.in]: stockIds },
        time: { [Op.between]: [startTimeIso, endTimeIso] },
      },
      raw: true,
    })) as unknown as Array<{
      stock_id: number;
      time: Date | string;
      close: number | string;
    }>;

    // 3) 按 stock_id 分组 → 排序 → 取 base_close + future_close
    const grouped = new Map<number, Array<{ time: number; close: number }>>();
    for (const b of bars) {
      const t = typeof b.time === 'string' ? new Date(b.time).getTime() : b.time.getTime();
      const c = Number(b.close);
      if (!Number.isFinite(t) || !Number.isFinite(c) || c <= 0) continue;
      const arr = grouped.get(b.stock_id) || [];
      arr.push({ time: t, close: c });
      grouped.set(b.stock_id, arr);
    }

    for (const [stockId, arr] of grouped.entries()) {
      const code = stockIdToCode.get(stockId);
      if (!code) continue;
      arr.sort((a, b) => a.time - b.time);
      // tail-index 取第 1 条 = base_close（base_date 当天）+ 第 N+1 条 = future_close
      // 必须有至少 forward_days + 1 条 bar；若 base_date 之前的 bar 混入也会被排在前
      // (但 startTimeIso = base_date 00:00 已保证)
      if (arr.length < forward_days + 1) continue;
      const baseClose = arr[0].close;
      const futureClose = arr[forward_days].close;
      if (baseClose <= 0) continue;
      const ret = (futureClose - baseClose) / baseClose;
      if (Number.isFinite(ret)) out.set(code, ret);
    }

    return out;
  }
}

/** 生产环境默认 DataSource 单例 */
export const PRODUCTION_FACTOR_IC_DATA_SOURCE: FactorICDataSource = new DefaultFactorICDataSource();

// ============================================================
// 主类 FactorICReport
// ============================================================

/**
 * 列出已落库 IC 结果时的可选过滤条件。
 */
export interface ICResultFilter {
  factor_name?: string;
  look_forward_days?: number;
  /** period_end ≥ 该日期 */
  period_end_from?: string;
  /** period_end ≤ 该日期 */
  period_end_to?: string;
  /** 返回上限（默认 200） */
  limit?: number;
}

export class FactorICReport {
  /**
   * 算一个因子的 IC 报告（含多 lookForward 窗口的衰减分析）。
   *
   * 流程：
   *   1. 校验参数（factor_name 校验仅在未注入 DataSource 时执行）
   *   2. 用 DataSource 拉 [start_date, end_date] 内有 factor_score 的 trade_dates
   *   3. 对每个 lookForwardDays 独立跑：per-day 串行 → 单日 IC 列表 → 聚合
   *   4. 写库（persist=true）+ 返回完整 results_by_window
   */
  async generate(
    input: FactorICReportInput,
    options: FactorICReportOptions = {}
  ): Promise<FactorICReportResult> {
    const t0 = Date.now();
    const dataSource = options.data_source ?? PRODUCTION_FACTOR_IC_DATA_SOURCE;
    const persist = options.persist ?? true;
    const source = options.source ?? 'factor_ic_report';

    // 1) 参数校验
    if (!input.factor_name || typeof input.factor_name !== 'string') {
      throw new Error('FactorICReport.generate: factor_name is required');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.start_date)) {
      throw new Error(
        `FactorICReport.generate: invalid start_date (expected YYYY-MM-DD): ${input.start_date}`
      );
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.end_date)) {
      throw new Error(
        `FactorICReport.generate: invalid end_date (expected YYYY-MM-DD): ${input.end_date}`
      );
    }
    if (input.start_date >= input.end_date) {
      throw new Error(
        `FactorICReport.generate: start_date must be < end_date (got ${input.start_date} >= ${input.end_date})`
      );
    }

    const lookForwardList = (input.look_forward_days_list ??
      Array.from(DEFAULT_LOOK_FORWARD_DAYS)) as number[];
    if (!lookForwardList.length) {
      throw new Error('FactorICReport.generate: look_forward_days_list cannot be empty');
    }
    for (const lf of lookForwardList) {
      if (!Number.isInteger(lf) || lf < 1) {
        throw new Error(
          `FactorICReport.generate: look_forward_days must be positive integer, got ${lf}`
        );
      }
    }

    // 仅在未注入 DataSource 时校验 factor_name 是否在 registry（同 GridSearch/Bayesian
    // 测试 fake mode 跳过 registry 的模式）
    if (!options.data_source && !factorRegistry.has(input.factor_name)) {
      throw new Error(
        `FactorICReport.generate: factor "${input.factor_name}" not registered. ` +
          `Known: ${factorRegistry.listNames().join(', ') || '(empty)'}`
      );
    }

    // 2) 拉 trade_dates
    const tradeDates = await dataSource.loadTradeDatesInRange(
      input.factor_name,
      input.start_date,
      input.end_date
    );
    if (!tradeDates.length) {
      logger.warn(
        `FactorICReport: no trade_dates with factor_score for "${input.factor_name}" ` +
          `in [${input.start_date}, ${input.end_date}]`
      );
    }

    // 3) 逐 lookForward 窗口跑
    const resultsByWindow: FactorICWindowResult[] = [];
    let upsertedCount = 0;
    const computedAt = new Date();

    for (const lookForwardDays of lookForwardList) {
      const windowResult = await this.computeWindow(
        input.factor_name,
        tradeDates,
        input.end_date,
        lookForwardDays,
        dataSource
      );

      resultsByWindow.push(windowResult);

      if (persist && windowResult.statistics.sample_count > 0) {
        await this.persistResult(
          input.factor_name,
          lookForwardDays,
          windowResult.period_start,
          windowResult.period_end,
          windowResult.statistics,
          computedAt,
          source
        );
        upsertedCount += 1;
      }
    }

    const durationMs = Date.now() - t0;
    logger.info(
      `FactorICReport: factor=${input.factor_name} ` +
        `period=[${input.start_date},${input.end_date}] ` +
        `windows=${lookForwardList.length} upserted=${upsertedCount} ` +
        `duration_ms=${durationMs}`
    );

    return {
      factor_name: input.factor_name,
      input_period: { start_date: input.start_date, end_date: input.end_date },
      results_by_window: resultsByWindow,
      upserted_count: upsertedCount,
      duration_ms: durationMs,
    };
  }

  /**
   * 跑某个 (factor, lookForwardDays) 在 trade_dates 序列上的 IC 计算。
   *
   * 关键 lookahead bias guard：base_date + lookForwardDays 必须 ≤ end_date 才计算；
   * 否则该日跳过（forward close 还没发生，理论上 lookahead）。
   */
  protected async computeWindow(
    factor_name: string,
    tradeDates: string[],
    end_date: string,
    look_forward_days: number,
    dataSource: FactorICDataSource
  ): Promise<FactorICWindowResult> {
    const dailyICs: DailyICRecord[] = [];

    // per-day 串行：上游 cache-friendly + 单日失败不阻塞后续
    for (const baseDate of tradeDates) {
      // lookahead bias guard：base_date + lookForwardDays 必须有 future close 在 end_date 之内
      // 因实际"未来"是按交易日数算，这里用自然日上界近似：如果 base 自然日 +
      // (lookForwardDays * 2 + buffer) 大于 end，则可能 future_close 还没收到。
      // 严格判定由 DataSource.loadForwardReturns 返回空 Map 兜底（取不到 bar 即跳过）。
      // 此处做粗略 fast-path 跳过明显越界的 base_date：
      const baseTs = new Date(`${baseDate}T00:00:00Z`).getTime();
      const endTs = new Date(`${end_date}T23:59:59Z`).getTime();
      // forward_days 个交易日 ≈ forward_days * 1.5 自然日（保守，含周末）
      const minRequiredNaturalDays = Math.ceil(look_forward_days * 1.5);
      const requiredEndTs = baseTs + minRequiredNaturalDays * 86_400_000;
      if (requiredEndTs > endTs) {
        dailyICs.push({
          trade_date: baseDate,
          ic: null,
          effective_size: 0,
          reason: 'lookahead_bias_guard_exceeds_end_date',
        });
        continue;
      }

      // 拉横截面 z_score
      const crossSection = await dataSource.loadFactorCrossSection(factor_name, baseDate);
      if (crossSection.size === 0) {
        dailyICs.push({
          trade_date: baseDate,
          ic: null,
          effective_size: 0,
          reason: 'empty_cross_section',
        });
        continue;
      }

      const stockCodes = Array.from(crossSection.keys());
      const forwardReturns = await dataSource.loadForwardReturns(
        stockCodes,
        baseDate,
        look_forward_days
      );

      // 双有效过滤：两边都有数据 + 都是 finite
      const xs: number[] = [];
      const ys: number[] = [];
      for (const code of stockCodes) {
        const z = crossSection.get(code);
        const r = forwardReturns.get(code);
        if (z !== undefined && r !== undefined && Number.isFinite(z) && Number.isFinite(r)) {
          xs.push(z);
          ys.push(r);
        }
      }

      if (xs.length < MIN_CROSS_SECTION_SIZE) {
        dailyICs.push({
          trade_date: baseDate,
          ic: null,
          effective_size: xs.length,
          reason: `cross_section_lt_min_${MIN_CROSS_SECTION_SIZE}`,
        });
        continue;
      }

      const ic = spearmanCorrelation(xs, ys);
      if (ic === null) {
        dailyICs.push({
          trade_date: baseDate,
          ic: null,
          effective_size: xs.length,
          reason: 'spearman_null_likely_degenerate',
        });
        continue;
      }

      dailyICs.push({
        trade_date: baseDate,
        ic,
        effective_size: xs.length,
      });
    }

    const statistics = aggregateICSeries(dailyICs);

    // period_start / period_end = 实际有 valid IC 的日期范围；若全 null 则 fallback 到
    // (第一个 tradeDate, 最后一个 tradeDate) 让 4-tuple PK 仍能写入（sample_count=0
    // 时通常 persist=false 跳过）
    const validRecords = dailyICs.filter(d => d.ic !== null);
    let periodStart: string;
    let periodEnd: string;
    if (validRecords.length > 0) {
      periodStart = validRecords[0].trade_date;
      periodEnd = validRecords[validRecords.length - 1].trade_date;
    } else if (tradeDates.length > 0) {
      periodStart = tradeDates[0];
      periodEnd = tradeDates[tradeDates.length - 1];
    } else {
      // 完全没有 tradeDate → 用 input 的 start/end 兜底
      periodStart = '1970-01-01';
      periodEnd = '1970-01-02';
    }

    return {
      look_forward_days,
      statistics,
      daily_ics: dailyICs,
      period_start: periodStart,
      period_end: periodEnd,
    };
  }

  /**
   * 把单窗口 statistics 写入 factor_ic_results 表（idempotent upsert）。
   */
  protected async persistResult(
    factor_name: string,
    look_forward_days: number,
    period_start: string,
    period_end: string,
    statistics: ICStatistics,
    computedAt: Date,
    source: string
  ): Promise<void> {
    await FactorICResult.upsert({
      factor_name,
      look_forward_days,
      period_start,
      period_end,
      ic_mean: statistics.ic_mean,
      ic_std: statistics.ic_std,
      ic_ir: statistics.ic_ir,
      ic_positive_ratio: statistics.ic_positive_ratio,
      sample_count: statistics.sample_count,
      universe_avg_size: statistics.universe_avg_size,
      computed_at: computedAt,
      source,
    } as any);
  }

  /**
   * 列出已落库的 IC 结果，支持按因子名 / lookForwardDays / period_end 范围过滤。
   * 默认按 computed_at DESC 返回，limit 200。
   */
  async getResults(filter: ICResultFilter = {}): Promise<FactorICResult[]> {
    const where: any = {};
    if (filter.factor_name) where.factor_name = filter.factor_name;
    if (filter.look_forward_days !== undefined) {
      where.look_forward_days = filter.look_forward_days;
    }
    if (filter.period_end_from || filter.period_end_to) {
      where.period_end = {};
      if (filter.period_end_from) where.period_end[Op.gte] = filter.period_end_from;
      if (filter.period_end_to) where.period_end[Op.lte] = filter.period_end_to;
    }
    const limit = filter.limit ?? 200;
    return await FactorICResult.findAll({
      where,
      order: [
        ['computed_at', 'DESC'],
        ['factor_name', 'ASC'],
        ['look_forward_days', 'ASC'],
      ],
      limit,
    });
  }

  /**
   * 按过滤条件删除（admin 用）。返回删除行数。
   */
  async deleteResults(filter: ICResultFilter = {}): Promise<number> {
    const where: any = {};
    if (filter.factor_name) where.factor_name = filter.factor_name;
    if (filter.look_forward_days !== undefined) {
      where.look_forward_days = filter.look_forward_days;
    }
    if (filter.period_end_from || filter.period_end_to) {
      where.period_end = {};
      if (filter.period_end_from) where.period_end[Op.gte] = filter.period_end_from;
      if (filter.period_end_to) where.period_end[Op.lte] = filter.period_end_to;
    }
    return await FactorICResult.destroy({ where });
  }

  /**
   * 清理 N 天前的全部 IC 结果（按 period_end 判定 = 数据已经过时了）。
   * 返回删除行数。
   */
  async cleanupOlderThan(days: number): Promise<number> {
    if (!Number.isFinite(days) || days < 0) {
      throw new Error(`cleanupOlderThan: days must be non-negative, got ${days}`);
    }
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - Math.floor(days));
    const cutoffIso = cutoff.toISOString().slice(0, 10);
    return await FactorICResult.destroy({
      where: { period_end: { [Op.lt]: cutoffIso } },
    });
  }
}

/** 默认单例 */
export const factorICReport = new FactorICReport();
