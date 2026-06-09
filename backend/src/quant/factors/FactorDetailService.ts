/**
 * FactorDetailService — 因子详情聚合服务（US-094）
 *
 * 给前端因子卡片"点击 → 弹出抽屉"提供 3 段数据：
 *   1. 因子描述（从 FactorRegistry 拿 name / description / category）
 *   2. IC 历史曲线（从 factor_ic_results 表按 lookForward=1 取最近 N 个 period_end）
 *   3. 5 等分组合累计净值曲线（Q1/Q2/Q3/Q4/Q5）—— 每日按 z_score 分位将股票切 5 等分，
 *      用次日真实 forward 1-day return 累乘得到分组净值；起点 1.0；返回 series 顺序
 *      与 trade_date ASC 对齐，让前端用 Recharts 一个 data array 多条 Line。
 *
 * **设计要点**：
 *   - 5 等分逻辑：单日横截面按 z_score 升序排，等分到 5 桶（Q1=低分=空头组、
 *     Q5=高分=多头组）。同 IC 报告标注的 "为什么 Spearman 而非 Pearson"
 *     一脉相承——用 percentile 而非 raw z 切桶让分布尾部不至于失真。
 *   - 累计净值 = ∏(1 + group_avg_return) 从 1.0 起；某日某桶为空（缺数据）
 *     当日 return=0 保持净值不变。
 *   - 跑日窗口 = 最近 ~120 个 trade_date（约半年），覆盖 IC 持久性观察 + 不超过 DB 压力；
 *     可由 query param `limit_days` 覆盖。
 *   - 复用 FactorICReport.DefaultFactorICDataSource.loadForwardReturns 同款 tail-index
 *     语义（forward_days=1 = 次个交易日 close 与今日 close 的比率），不需要"自然日"换算。
 *   - lookahead bias guard：base_date 的 forward return 必须实际存在（DailyBar 后续
 *     有第 N+1 条 bar），否则该日跳过这只股票（不参与该桶 avg）。
 *
 * **DataSource 接口注入**（与 FactorICReport 同模式）：
 *   - 生产环境默认走 `DefaultFactorDetailDataSource` —— FactorScore 拿 z_score 横截面、
 *     DailyBar + Stock 拿 forward return（用 inferStockSymbol 还原 .SH/.SZ 后缀）。
 *   - 测试时注入 fake DataSource，传入 cross_section + forward_returns 让单测脱 DB。
 *
 * **5 个 export 纯函数**（独立单测、完全脱离 DB）：
 *   - `splitIntoQuintiles(zMap)` → Map<stock_code, 1|2|3|4|5>（同款 ties 按 stock_code 排稳定）
 *   - `quintileAverageReturn(quintileMap, returnMap, q)` → 桶平均 return（缺数据 → 0）
 *   - `accumulateNetValue(returns)` → 累乘从 1.0 起的净值序列（与日期 array 等长）
 *   - `buildQuintileTimeSeries(perDayBuckets, perDayReturns)` → { Q1: number[], …, Q5: number[] }
 *   - `formatTradeDate(value)` → 'YYYY-MM-DD' 兼容 string / Date / null
 *
 * **错误隔离 per-day**：
 *   - 某日横截面 < MIN_QUINTILE_CROSS_SECTION 该日整桶 return=0；
 *   - 某日 forward returns 拉空 → 该日整桶 return=0；
 *   - 单日失败不阻塞后续日（净值线"平台"显示）。
 */

import { Op } from 'sequelize';
import { FactorScore } from '../../models/FactorScore';
import { FactorICResult } from '../../models/FactorICResult';
import { DailyBar } from '../../models/DailyBar';
import { Stock } from '../../models/Stock';
import { factorRegistry } from './FactorRegistry';
import { inferStockSymbol } from './library/_helpers';

// ============================================================
// 常量
// ============================================================

/** 默认抓取的 trade_date 数（约 ~半年 A 股交易日），可被 query param `limit_days` 覆盖。 */
export const DEFAULT_DETAIL_TRADE_DAYS = 120;
/** Limit 硬上限：避免前端误传 limit_days=10000 让后端 OOM。 */
export const MAX_DETAIL_TRADE_DAYS = 250;
/** 单日横截面少于此阈值整日不计入 quintile（return=0），同 IC 报告 MIN 30 一致但放宽到 25 */
export const MIN_QUINTILE_CROSS_SECTION = 25;
/** 跑分组净值用的 forward 窗口（恒 1 个交易日） */
export const QUINTILE_FORWARD_DAYS = 1;
/** 默认抓取的 IC 历史条数（按 period_end DESC 取最近 N 条） */
export const DEFAULT_IC_HISTORY_LIMIT = 60;

// ============================================================
// 类型
// ============================================================

/** 5 等分桶编号：1 = 低分（空头），5 = 高分（多头） */
export type Quintile = 1 | 2 | 3 | 4 | 5;

/** 单条 IC 历史记录（前端绘 IC 时序曲线） */
export interface ICHistoryPoint {
  /** 'YYYY-MM-DD' — 取 period_end 作 X 轴 */
  period_end: string;
  ic_mean: number | null;
  ic_ir: number | null;
  look_forward_days: number;
}

/** 单条净值曲线点（含 5 桶 + 日期；前端 Recharts 共享 X 轴单 data array 模式） */
export interface QuintileNetValuePoint {
  trade_date: string;
  Q1: number;
  Q2: number;
  Q3: number;
  Q4: number;
  Q5: number;
}

/** 因子详情完整响应 */
export interface FactorDetailResponse {
  name: string;
  description: string;
  category: string;
  /** 数据计算窗口的起止日期（实际有数据的最早/最晚 trade_date；空表 → null） */
  period_start: string | null;
  period_end: string | null;
  /** 实际计入分组净值的有效交易日数（≤ limit_days，扣除缺数据日） */
  effective_trade_days: number;
  /** IC 历史（按 period_end ASC；取 lookForward=1 优先，否则全部） */
  ic_history: ICHistoryPoint[];
  /** 5 等分净值曲线（按 trade_date ASC；起点 1.0） */
  quintile_curves: QuintileNetValuePoint[];
  /** factor_scores 表为空 / 无可用 IC 时的解释（前端在抽屉里显示） */
  note?: string;
}

/** DataSource 接口（依赖注入用） */
export interface FactorDetailDataSource {
  /** 取因子最近 limit 个 trade_date（按 ASC 返回，便于上层连贯使用） */
  loadRecentTradeDates(factor_name: string, limit: number): Promise<string[]>;

  /** 单日某因子的横截面 Map<stock_code, z_score>（已过滤 raw_value IS NOT NULL） */
  loadFactorCrossSection(factor_name: string, trade_date: string): Promise<Map<string, number>>;

  /** 一组 stock_code 在 base_date 后第 N+1 个交易日的 forward return（同 IC 报告 tail-index） */
  loadForwardReturns(
    stock_codes: string[],
    base_date: string,
    forward_days: number
  ): Promise<Map<string, number>>;

  /** 按因子名取最近 limit 条 IC 历史（按 period_end ASC 返回，便于绘制时间序列） */
  loadICHistory(factor_name: string, limit: number): Promise<ICHistoryPoint[]>;
}

// ============================================================
// 纯函数 helpers
// ============================================================

/**
 * 把 (stock_code → z_score) 横截面按 z 升序排，等分到 5 桶。返回
 * Map<stock_code, 1|2|3|4|5>。空入 → 空出。
 *
 * **桶边界**：n 只股票 → 每桶 ⌊n/5⌋ 只；前 (n mod 5) 桶各多 1 只，多余的全部
 * 落在低分桶（Q1）让"多头组 Q5 始终最少最干净"——避免末位股票把"高分组"
 * 拉低。例如 n=23 → Q1=5, Q2=5, Q3=5, Q4=4, Q5=4。
 *
 * **稳定 tie-break**：同 z_score 的股票按 stock_code.localeCompare 排序——与
 * MFA 的 candidate sort 同款，让 audit / replay / 跨次调用桶分配一致。
 *
 * **空入处理**：empty Map → empty Map（调用方自己判桶为空时跳过该日计算）。
 */
export function splitIntoQuintiles(zMap: Map<string, number>): Map<string, Quintile> {
  const out = new Map<string, Quintile>();
  const entries: Array<[string, number]> = [];
  for (const [code, z] of zMap.entries()) {
    if (typeof z === 'number' && Number.isFinite(z)) {
      entries.push([code, z]);
    }
  }
  const n = entries.length;
  if (n === 0) return out;

  // ascending z, ties by stock_code.localeCompare（稳定）
  entries.sort((a, b) => {
    if (a[1] !== b[1]) return a[1] - b[1];
    return a[0].localeCompare(b[0]);
  });

  // 5 桶配额：前 n%5 桶各 +1 只
  const base = Math.floor(n / 5);
  const remainder = n % 5;
  const sizes: number[] = [];
  for (let q = 0; q < 5; q += 1) {
    sizes.push(base + (q < remainder ? 1 : 0));
  }

  let cursor = 0;
  for (let q = 0; q < 5; q += 1) {
    const size = sizes[q];
    for (let i = 0; i < size; i += 1) {
      const [code] = entries[cursor];
      out.set(code, (q + 1) as Quintile);
      cursor += 1;
    }
  }
  return out;
}

/**
 * 算单日单桶的平均 return：把 quintileMap 中等于 q 的 stock_code 拿出来，
 * 在 returnMap 里查 forward return，缺数据的不计入分母（同 IC 报告"双有效"过滤）。
 *
 * 返回 0 的情况：
 *   - 桶为空（quintileMap 中没有等于 q 的 code）；
 *   - 桶里所有 code 都缺 return；
 *   - 调用方应理解 0 = "今日该桶净值不变"（不是真"零收益"——区分语义靠 effective_size）。
 *
 * 注：本函数算"等权"avg；未来若要扩"市值加权"在 returnMap 外再传 weight Map。
 */
export function quintileAverageReturn(
  quintileMap: Map<string, Quintile>,
  returnMap: Map<string, number>,
  q: Quintile
): number {
  let sum = 0;
  let count = 0;
  for (const [code, bucket] of quintileMap.entries()) {
    if (bucket !== q) continue;
    const r = returnMap.get(code);
    if (r === undefined || !Number.isFinite(r)) continue;
    sum += r;
    count += 1;
  }
  return count > 0 ? sum / count : 0;
}

/**
 * 把日度 return 序列累乘成净值序列（起点 1.0）。
 *
 * 示例：returns=[0.01, -0.02, 0.03] → netValues=[1.01, 0.9898, 1.0195]
 *       returns=[0, 0, 0]            → netValues=[1.0, 1.0, 1.0]
 *       returns=[]                   → netValues=[]
 *
 * 数值精度：每一步保留 6 位小数（toFixed(6) → Number）避免长期累乘 floating
 * point drift；前端图表显示 4 位即可，6 位富余两位。
 */
export function accumulateNetValue(returns: number[]): number[] {
  const out: number[] = [];
  let nv = 1.0;
  for (const r of returns) {
    const safeR = Number.isFinite(r) ? r : 0;
    nv = nv * (1 + safeR);
    out.push(Number(nv.toFixed(6)));
  }
  return out;
}

/**
 * 把 per-day 桶分配 + per-day return 拼成 5 桶时序：返回 {Q1: number[], …, Q5: number[]}，
 * 每个 array 长度 = days.length，对齐 days[]。
 *
 * 每天对 5 个桶各算一次 quintileAverageReturn 然后累乘——若想加效率可一日扫一次
 * 同时算 5 桶，这里为可读性逐桶处理；天数 ~120 + 5 桶 = 600 次纯内存运算，可忽略。
 */
export function buildQuintileTimeSeries(
  perDayQuintiles: Array<Map<string, Quintile>>,
  perDayReturns: Array<Map<string, number>>
): { Q1: number[]; Q2: number[]; Q3: number[]; Q4: number[]; Q5: number[] } {
  if (perDayQuintiles.length !== perDayReturns.length) {
    throw new Error(
      `buildQuintileTimeSeries: perDayQuintiles.length (${perDayQuintiles.length}) ` +
        `!= perDayReturns.length (${perDayReturns.length})`
    );
  }
  const out = {
    Q1: [] as number[],
    Q2: [] as number[],
    Q3: [] as number[],
    Q4: [] as number[],
    Q5: [] as number[],
  };
  for (const q of [1, 2, 3, 4, 5] as Quintile[]) {
    const dailyReturns: number[] = [];
    for (let i = 0; i < perDayQuintiles.length; i += 1) {
      dailyReturns.push(quintileAverageReturn(perDayQuintiles[i], perDayReturns[i], q));
    }
    const key = `Q${q}` as 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';
    out[key] = accumulateNetValue(dailyReturns);
  }
  return out;
}

/** Date | string | null → 'YYYY-MM-DD' | null（与 FactorController.normalizeDateIso 一致） */
export function formatTradeDate(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return value.slice(0, 10);
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    return null;
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  return null;
}

// ============================================================
// 默认生产实现：DefaultFactorDetailDataSource
// ============================================================

export class DefaultFactorDetailDataSource implements FactorDetailDataSource {
  async loadRecentTradeDates(factor_name: string, limit: number): Promise<string[]> {
    // 取 DESC limit 条 再 reverse —— group + order DESC 后 slice ASC 给上层
    const rows = (await FactorScore.findAll({
      attributes: ['trade_date'],
      where: { factor_name },
      group: ['trade_date'],
      order: [['trade_date', 'DESC']],
      limit,
      raw: true,
    })) as unknown as Array<{ trade_date: string | Date }>;
    const dates = rows
      .map(r => formatTradeDate(r.trade_date))
      .filter((d): d is string => d !== null);
    // ASC for caller convenience
    dates.reverse();
    return dates;
  }

  async loadFactorCrossSection(
    factor_name: string,
    trade_date: string
  ): Promise<Map<string, number>> {
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
    // 实现同 FactorICReport.DefaultFactorICDataSource.loadForwardReturns — tail-index 取第 N+1 条
    const out = new Map<string, number>();
    if (!stock_codes.length || forward_days < 1) return out;

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
      const code = s.symbol.split('.')[0];
      if (code) {
        stockIdToCode.set(s.id, code);
        stockIds.push(s.id);
      }
    }
    if (!stockIds.length) return out;

    // 拉 base_date 起 ~forward_days * 2 + 30 自然日的 bars，按 stock_id 分组 tail-index
    const base = new Date(`${base_date}T00:00:00Z`);
    const endDate = new Date(base);
    endDate.setUTCDate(endDate.getUTCDate() + forward_days * 2 + 30);
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
      if (arr.length < forward_days + 1) continue;
      const baseClose = arr[0].close;
      const futureClose = arr[forward_days].close;
      if (baseClose <= 0) continue;
      const ret = (futureClose - baseClose) / baseClose;
      if (Number.isFinite(ret)) out.set(code, ret);
    }

    return out;
  }

  async loadICHistory(factor_name: string, limit: number): Promise<ICHistoryPoint[]> {
    // 优先取 look_forward_days=1（与本 service 分组净值口径一致：日度收益 ↔ 1 日 IC），
    // 取不到再 fallback 所有窗口（即 IC 计算时只跑了 5/10/20，没跑 1）。
    let rows = (await FactorICResult.findAll({
      attributes: ['period_end', 'ic_mean', 'ic_ir', 'look_forward_days'],
      where: { factor_name, look_forward_days: 1 },
      order: [['period_end', 'DESC']],
      limit,
      raw: true,
    })) as unknown as Array<{
      period_end: string | Date;
      ic_mean: number | string | null;
      ic_ir: number | string | null;
      look_forward_days: number;
    }>;
    if (rows.length === 0) {
      rows = (await FactorICResult.findAll({
        attributes: ['period_end', 'ic_mean', 'ic_ir', 'look_forward_days'],
        where: { factor_name },
        order: [['period_end', 'DESC']],
        limit,
        raw: true,
      })) as unknown as typeof rows;
    }
    const out: ICHistoryPoint[] = [];
    for (const r of rows) {
      const pe = formatTradeDate(r.period_end);
      if (!pe) continue;
      out.push({
        period_end: pe,
        ic_mean: r.ic_mean === null ? null : Number(r.ic_mean),
        ic_ir: r.ic_ir === null ? null : Number(r.ic_ir),
        look_forward_days: Number(r.look_forward_days),
      });
    }
    // ASC for chart
    out.reverse();
    return out;
  }
}

/** 生产环境默认 DataSource 单例 */
export const PRODUCTION_FACTOR_DETAIL_DATA_SOURCE: FactorDetailDataSource =
  new DefaultFactorDetailDataSource();

// ============================================================
// 主类 FactorDetailService
// ============================================================

export interface FactorDetailOptions {
  /** 抓取的 trade_date 数（默认 120；上限 250） */
  limit_days?: number;
  /** 抓取的 IC 历史条数（默认 60） */
  ic_limit?: number;
  /** 注入 DataSource（测试用；不传走生产默认） */
  data_source?: FactorDetailDataSource;
}

export class FactorDetailService {
  /**
   * 算因子详情。
   *
   * 流程：
   *   1. 校验 factor_name 已注册（未注入 DataSource 时；与 FactorICReport 同模式）
   *   2. 取最近 limit_days 个 trade_date
   *   3. 对每个 trade_date：拉横截面 z_score → splitIntoQuintiles → 拉次日 forward return
   *   4. buildQuintileTimeSeries 累乘成 5 桶净值
   *   5. 取 IC 历史（按 period_end ASC）
   *   6. 返回完整响应（含 note 兜底空表）
   */
  async getDetail(
    factor_name: string,
    options: FactorDetailOptions = {}
  ): Promise<FactorDetailResponse> {
    const dataSource = options.data_source ?? PRODUCTION_FACTOR_DETAIL_DATA_SOURCE;
    const limitDays = clampLimitDays(options.limit_days);
    const icLimit = clampICLimit(options.ic_limit);

    // 校验 name（注入 DataSource 时跳过——同 FactorICReport 测试 fake mode）
    if (!options.data_source && !factorRegistry.has(factor_name)) {
      throw new Error(
        `FactorDetailService.getDetail: factor "${factor_name}" not registered. ` +
          `Known: ${factorRegistry.listNames().join(', ') || '(empty)'}`
      );
    }

    // 拿描述（注入 mode 下因子可能不在 registry，用空字符串兜底）
    let description = '';
    let category = 'other';
    if (factorRegistry.has(factor_name)) {
      const f = factorRegistry.get(factor_name);
      description = f.description || '';
      category = (f.category as string) || 'other';
    }

    // 1) 拉最近 N 个 trade_date
    const tradeDates = await dataSource.loadRecentTradeDates(factor_name, limitDays);

    if (tradeDates.length === 0) {
      const icHistory = await dataSource.loadICHistory(factor_name, icLimit);
      return {
        name: factor_name,
        description,
        category,
        period_start: null,
        period_end: null,
        effective_trade_days: 0,
        ic_history: icHistory,
        quintile_curves: [],
        note: `factor_scores 表无 ${factor_name} 的数据 — 请先运行 npm run compute:factors`,
      };
    }

    // 2) per-day 串行：拉横截面 + 桶分配 + 次日 forward return
    //    （per-day 串行 = cache-friendly + 单日失败不阻塞后续，同 FactorICReport.computeWindow 范式）
    const perDayQuintiles: Array<Map<string, Quintile>> = [];
    const perDayReturns: Array<Map<string, number>> = [];
    let effectiveDays = 0;

    for (const date of tradeDates) {
      const crossSection = await dataSource.loadFactorCrossSection(factor_name, date);
      if (crossSection.size < MIN_QUINTILE_CROSS_SECTION) {
        // 该日 cross-section 太小，跳过——桶分配空 + return 空让累乘 *1 净值不变
        perDayQuintiles.push(new Map());
        perDayReturns.push(new Map());
        continue;
      }
      const quintiles = splitIntoQuintiles(crossSection);
      const codes = Array.from(crossSection.keys());
      const returns = await dataSource.loadForwardReturns(codes, date, QUINTILE_FORWARD_DAYS);
      perDayQuintiles.push(quintiles);
      perDayReturns.push(returns);
      effectiveDays += 1;
    }

    // 3) build quintile time series
    const curves = buildQuintileTimeSeries(perDayQuintiles, perDayReturns);

    // 4) 拼合到 QuintileNetValuePoint[]
    const quintileCurves: QuintileNetValuePoint[] = [];
    for (let i = 0; i < tradeDates.length; i += 1) {
      quintileCurves.push({
        trade_date: tradeDates[i],
        Q1: curves.Q1[i] ?? 1.0,
        Q2: curves.Q2[i] ?? 1.0,
        Q3: curves.Q3[i] ?? 1.0,
        Q4: curves.Q4[i] ?? 1.0,
        Q5: curves.Q5[i] ?? 1.0,
      });
    }

    // 5) IC history
    const icHistory = await dataSource.loadICHistory(factor_name, icLimit);

    const note =
      effectiveDays === 0
        ? `${factor_name} 在最近 ${tradeDates.length} 个交易日上横截面均 < ${MIN_QUINTILE_CROSS_SECTION} 只——无法分组`
        : undefined;

    return {
      name: factor_name,
      description,
      category,
      period_start: tradeDates[0],
      period_end: tradeDates[tradeDates.length - 1],
      effective_trade_days: effectiveDays,
      ic_history: icHistory,
      quintile_curves: quintileCurves,
      note,
    };
  }
}

/** clamp limit_days 到 [1, MAX_DETAIL_TRADE_DAYS]，非整数兜底默认 */
export function clampLimitDays(value: unknown): number {
  if (value === null || value === undefined || value === '') return DEFAULT_DETAIL_TRADE_DAYS;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return DEFAULT_DETAIL_TRADE_DAYS;
  if (n > MAX_DETAIL_TRADE_DAYS) return MAX_DETAIL_TRADE_DAYS;
  return n;
}

/** clamp ic_limit 到 [1, 200]，非整数兜底默认 60 */
export function clampICLimit(value: unknown): number {
  if (value === null || value === undefined || value === '') return DEFAULT_IC_HISTORY_LIMIT;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return DEFAULT_IC_HISTORY_LIMIT;
  if (n > 200) return 200;
  return n;
}

/** 默认单例 */
export const factorDetailService = new FactorDetailService();
