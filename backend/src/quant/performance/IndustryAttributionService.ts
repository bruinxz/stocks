/**
 * IndustryAttributionService — 分行业归因分析（US-046）
 *
 * 对一次完成的回测（QuantBacktestResult.id 或 in-memory trades + initial_capital）
 * 按行业分组计算每个行业的：
 *   - **contribution_pct**：行业贡献百分比 = 行业累计 pnl / 初始资本 × 100
 *   - **win_rate**：行业内已完成交易胜率（pnl > 0 算胜）
 *   - **avg_hold_days**：行业内平均持仓天数
 *   - **trade_count**：行业内已完成交易数
 *   - **total_pnl** / **winning_count** / **losing_count** / **total_volume**：诊断字段
 *
 * **为什么需要行业归因**：
 *   单看策略 sharpe=1.5 / annual=15% 看不出来 alpha 是哪些行业贡献的。把策略
 *   总收益拆到行业层面 — 一眼回答「这个策略到底在 银行/半导体/医药 哪些行业
 *   赚到钱」。这是判定策略稳定性 / 风格 / 集中度风险的最直观工具。
 *
 *   典型解读：
 *     - 银行 +5% / 半导体 +8% / 医药 +2%（多行业平均贡献） → alpha 真而稳健
 *     - 半导体 +18% / 其他全负（单一行业撑盘） → 高集中度风险（半导体回调=系统性下跌）
 *     - 全部行业接近 0%（贡献分散过细） → 策略可能没有真 alpha 只是 beta
 *
 * **公共接口**：
 *   - `computeAttribution(input, options?)` — 异步执行一次行业归因；选择性写入
 *     IndustryAttributionResult；返回 { attributions, persisted_ids }。
 *   - `getRun(id)` — 查某 id 的结果。
 *   - `getResultsForRun(run_id)` — 按 run_id 查全部行业归因。
 *   - `listRecentRuns(limit)` — 列出最近 N 个归因结果（按 created_at 倒序）。
 *   - `deleteRun(id)` — 删除某 id 的结果。
 *   - `deleteRunByRunId(run_id)` — 按 run_id 删除整套（所有行业）。
 *   - `cleanupOlderThan(days)` — 删除 N 天前的全部结果。
 *
 * **5 个纯函数 helper（独立单测，完全脱离 DB）**：
 *   - `normalizeIndustryName(name)` — 中文名 trim + null/empty → "其他"。
 *   - `isClosedTrade(trade)` — 已完成交易判定（sell_date 非空 + pnl 是数字）。
 *   - `aggregateTradesByIndustry(trades, industryMap)` — 把 trade 列表按行业归组累加。
 *   - `computeContributionMetrics(group, initialCapital)` — 单行业 metrics 计算。
 *   - `sortAttributionsByContribution(attributions)` — 按 |contribution_pct| 降序排序。
 *
 * **DataSource DI 模式**（与 GridSearchOptimizer.BacktestRunner /
 * RegimeSegmentedBacktest.RegimeSource / MonteCarloStressTest.TradeReturnSource /
 * PortfolioOptimizer.StrategyReturnSource / BenchmarkAttributionService 同款）：
 *   - 生产默认 `PRODUCTION_INDUSTRY_DATA_SOURCE` — lazy require 从
 *     QuantBacktestTrade + QuantBacktestResult + Stock 读数据；
 *   - 测试注入 fake source 完全脱离 DB；同时支持 in-memory 模式直接传入
 *     trades + initial_capital + symbol_to_industry Map（单测 / 嵌入式调用方都用得上）。
 *
 * **关键约束**：
 *   - **trade 归属以 sell_date 为准**（与 US-040 RegimeSegmentedBacktest 同款判据）。
 *     段内成交统计反映「该段实际兑现的盈亏」。未平仓 trade（sell_date 未定义）不计入。
 *   - **未识别行业归为 "其他"**：Stock.industry 缺失或 trim 后为空 → 归到 "其他" 类别，
 *     不丢失数据。让 ops 看到「有多少 pnl 没法归到具体行业」。
 *   - **win_rate 阈值**：pnl > 0 算胜，pnl ≤ 0 算负（pnl=0 偏保守归到 losing）；
 *     trade_count = 0 时 win_rate = null。
 *   - **不复用 OptimizationRun 父表**（与 US-040/US-041/US-042/US-043/US-044/US-045 判据一致）。
 *
 * **设计取舍**：
 *   - **contribution_pct 分母用 initial_capital 而非总成交金额**：
 *     industry_contribution = industry_pnl / initial_capital × 100，所有行业相加 =
 *     策略总收益率（近似，不考虑费率），符合「贡献分解」直觉。
 *   - **industry_code = industry_name（中文名）当前实现**：Stock 模型只有 industry
 *     字段没有 industry_code 列。未来引入独立 BK 编码后切换 DataSource 内部 join 逻辑即可。
 *   - **per-industry 失败隔离不显式做**：与 BenchmarkAttributionService 不同 — 行业归因
 *     的「失败」只能发生在 industry 字符串处理层，没有外部数据源调用，所以无需 try/catch
 *     per industry。Trade 数据缺失会让该行业 trade_count=0 + 全 null。
 *
 * 主要消费方：
 *   - QuantBacktestService 完成 hook（每次回测完成后异步触发，与 US-045 并列）
 *   - run-industry-attribution CLI（US-046）
 *   - 未来 US-016 策略实验室 "行业归因" tab（行业 alpha 雷达图 / 贡献柱状图）
 *   - 未来 US-085 行业集中度告警 用历史 contribution 序列判定是否过度依赖某行业
 */

import { Op } from 'sequelize';
import { logger } from '../../utils/logger';
import { IndustryAttributionResult } from '../../models/IndustryAttributionResult';

// ============================================================
// 常量
// ============================================================

/** 未识别行业的统一归类 */
export const UNKNOWN_INDUSTRY_LABEL = '其他';

/** 持久化默认 source */
export const DEFAULT_SOURCE = 'industry_attribution_service';

// ============================================================
// Types
// ============================================================

/**
 * Trade-like 输入：从 QuantBacktestTrade 抽取必要字段，让 in-memory 模式 / fake 数据
 * 都能直接构造。
 */
export interface TradeRecord {
  symbol: string;
  buy_date: string;
  sell_date?: string | null;
  pnl?: number | null;
  amount: number;
  /** 持仓天数（QuantBacktestTrade.holding_days），缺则由 service 自动从 buy/sell 派生 */
  holding_days?: number | null;
}

/**
 * 单行业归因结果。
 *
 * - `industry_code` / `industry_name`：US-046 当前实现两者相同 = Stock.industry 中文名；
 *   未来引入 BK 编码后 industry_code 变为 'BK1024' 形式，industry_name 仍是中文。
 * - `contribution_pct`：行业累计 pnl / initial_capital × 100。
 * - `total_pnl`：行业累计盈亏（元）。
 * - `win_rate`：胜率 (0..1)；trade_count=0 时 null。
 * - `avg_hold_days`：平均持仓天数；trade_count=0 时 null。
 * - `trade_count`：已完成交易数（sell_date 非空 + pnl 有效）。
 * - `winning_count` / `losing_count`：胜负数（trade_count = winning + losing）。
 * - `total_volume`：累计成交金额（buy + sell 总和）。
 */
export interface IndustryAttribution {
  industry_code: string;
  industry_name: string;
  contribution_pct: number;
  total_pnl: number;
  win_rate: number | null;
  avg_hold_days: number | null;
  trade_count: number;
  winning_count: number;
  losing_count: number;
  total_volume: number;
}

/**
 * `computeAttribution()` 输入。三种入参形态：
 *
 * (1) `quant_backtest_result_id`：从 DB 读 QuantBacktestResult + 关联的 QuantBacktestTrade
 *     + Stock。最常见的入参方式（CLI / hook / UI 都按 result_id 触发）。
 *
 * (2) `trades` + `initial_capital`：纯 in-memory 模式 — 单测 / 嵌入式调用方已经手上有 trade 数据。
 *     需配合 `symbol_to_industry` 显式 Map 才能 attribute（in-memory 没 Stock 表）。
 *
 * 优先级：(2) > (1)。同时提供时取 in-memory。
 */
export interface IndustryAttributionInput {
  quant_backtest_result_id?: number;
  trades?: TradeRecord[];
  initial_capital?: number;
  /** symbol → industry name 映射；in-memory 模式必需 */
  symbol_to_industry?: Record<string, string>;
  /** 物化进 IndustryAttributionResult 行的 strategy_key（与父结果保持一致） */
  strategy_key?: string;
  /** 区间起止；in-memory 模式必需（DB 模式自动从 QuantBacktestTask 派生） */
  period_start?: string;
  period_end?: string;
}

/**
 * IndustryDataSource 抽象。让测试可以注入 fake source 完全脱离 DB。
 *
 * 接口设计：每个 result_id 一次性返回 attribution 所需 4 个字段
 * (trades / initial_capital / period_start/end / strategy_key / symbol_to_industry)；
 * 让 caller 不必拆成多个调用（实际生产实现是 3 个 DB 查询 — Result / Trades / Stocks，
 * 但接口暴露为单个调用提高可测性）。
 */
export interface IndustryDataSource {
  loadAttributionContext(quant_backtest_result_id: number): Promise<{
    trades: TradeRecord[];
    initial_capital: number;
    period_start: string;
    period_end: string;
    strategy_key: string;
    symbol_to_industry: Record<string, string>;
  } | null>;
}

/**
 * 生产默认 IndustryDataSource：lazy require QuantBacktestResult + QuantBacktestTrade +
 * QuantBacktestTask + Stock，避免单测拉重量级 DB stack。
 *
 * 返回 null 时（result_id 不存在 / 缺关键字段）由 caller 抛错。
 */
export const PRODUCTION_INDUSTRY_DATA_SOURCE: IndustryDataSource = {
  async loadAttributionContext(quant_backtest_result_id: number) {
    try {
      // lazy require — 同 BenchmarkAttributionService.PRODUCTION_BENCHMARK_RETURN_SOURCE 范式
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { QuantBacktestResult } = require('../../models/QuantBacktestResult');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { QuantBacktestTrade } = require('../../models/QuantBacktestTrade');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { QuantBacktestTask } = require('../../models/QuantBacktestTask');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Stock } = require('../../models/Stock');

      const result = await QuantBacktestResult.findByPk(quant_backtest_result_id);
      if (!result) {
        logger.warn(
          `[industry-attribution] QuantBacktestResult #${quant_backtest_result_id} 不存在`
        );
        return null;
      }

      const task = await QuantBacktestTask.findByPk(result.task_id);
      if (!task) {
        logger.warn(
          `[industry-attribution] QuantBacktestResult #${quant_backtest_result_id} 关联的 task ${result.task_id} 不存在`
        );
        return null;
      }

      // 关联 trades（按 task_id + strategy_key 过滤，与 QuantBacktestService 保存模式一致）
      const trades = await QuantBacktestTrade.findAll({
        where: { task_id: result.task_id, strategy_key: result.strategy_key },
        attributes: ['symbol', 'buy_date', 'sell_date', 'pnl', 'amount', 'holding_days'],
        order: [['buy_date', 'ASC']],
        raw: true,
      });

      // 收集涉及到的 symbol → 查 Stock.industry
      const symbols = Array.from(
        new Set(
          (trades as Array<{ symbol: string }>)
            .map(t => t.symbol)
            .filter(s => typeof s === 'string')
        )
      );

      const symbol_to_industry: Record<string, string> = {};
      if (symbols.length > 0) {
        const stocks = await Stock.findAll({
          where: { symbol: { [Op.in]: symbols } },
          attributes: ['symbol', 'industry'],
          raw: true,
        });
        for (const s of stocks as Array<{ symbol: string; industry?: string }>) {
          if (typeof s.symbol === 'string') {
            symbol_to_industry[s.symbol] = normalizeIndustryName(s.industry);
          }
        }
      }

      // 派生区间起止：优先 task.parameters.start_date / end_date，否则用 trades 范围
      const taskParams = (task.parameters || {}) as Record<string, unknown>;
      let period_start = typeof taskParams.start_date === 'string' ? taskParams.start_date : '';
      let period_end = typeof taskParams.end_date === 'string' ? taskParams.end_date : '';
      if (!period_start || !period_end) {
        const buyDates = (trades as Array<{ buy_date: string; sell_date?: string }>).map(
          t => t.buy_date
        );
        const sellDates = (trades as Array<{ buy_date: string; sell_date?: string }>)
          .map(t => t.sell_date)
          .filter((d): d is string => typeof d === 'string' && d.length > 0);
        const allDates = [...buyDates, ...sellDates].filter(d => typeof d === 'string' && d);
        if (allDates.length > 0) {
          allDates.sort();
          period_start = period_start || allDates[0];
          period_end = period_end || allDates[allDates.length - 1];
        }
      }

      // initial_capital：QuantBacktestResult.initial_capital 或 task.parameters.initial_capital
      const initial_capital =
        Number(result.initial_capital ?? taskParams.initial_capital ?? 0) || 0;

      return {
        trades: trades as TradeRecord[],
        initial_capital,
        period_start,
        period_end,
        strategy_key: result.strategy_key,
        symbol_to_industry,
      };
    } catch (err) {
      logger.warn(
        `[industry-attribution] PRODUCTION_INDUSTRY_DATA_SOURCE 加载 result_id=${quant_backtest_result_id} 失败: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return null;
    }
  },
};

/**
 * `computeAttribution()` 选项。
 *
 * - `persist`：true → 写入 IndustryAttributionResult；false → 仅返回结果。
 * - `replace_existing`：true → 覆盖同 (run_id, industry_code, period_start, period_end)
 *   的已有行；false → 跳过已存在行。默认 true（与 BenchmarkAttributionService 一致）。
 * - `source`：写入 IndustryAttributionResult.source 字段（如 'backtest_hook' / 'cli'）。
 * - `data_source`：override 默认 PRODUCTION_INDUSTRY_DATA_SOURCE（单测注入 fake）。
 */
export interface IndustryAttributionOptions {
  persist?: boolean;
  replace_existing?: boolean;
  source?: string;
  data_source?: IndustryDataSource;
}

/**
 * `computeAttribution()` 返回。
 *
 * - `run_id`：父回测 id；in-memory 模式（无 result_id）= null。
 * - `strategy_key`：input.strategy_key 或从 DB 派生；in-memory 没传时 'unknown'。
 * - `attributions`：按 |contribution_pct| 降序排序的行业归因数组。
 * - `total_contribution_pct`：所有行业 contribution_pct 之和（应近似 = 策略总收益率）。
 * - `persisted_ids`：与 attributions 一一对应的写入 id；persist=false 时全 null。
 * - `duration_ms`：本次归因总耗时。
 */
export interface IndustryAttributionRunResult {
  run_id: number | null;
  strategy_key: string;
  attributions: IndustryAttribution[];
  total_contribution_pct: number;
  persisted_ids: Array<number | null>;
  duration_ms: number;
}

// ============================================================
// 纯函数 helpers（独立单测，完全脱离 DB）
// ============================================================

/**
 * 中文行业名标准化：trim + null/empty → "其他"。
 *
 * 让 ops 看到「有多少 pnl 没法归到具体行业」而不是丢失数据。
 */
export function normalizeIndustryName(name: unknown): string {
  if (name === null || name === undefined) return UNKNOWN_INDUSTRY_LABEL;
  if (typeof name !== 'string') return UNKNOWN_INDUSTRY_LABEL;
  const trimmed = name.trim();
  if (trimmed.length === 0) return UNKNOWN_INDUSTRY_LABEL;
  return trimmed;
}

/**
 * 已完成 trade 判定：sell_date 非空且非 null/undefined + pnl 是有效数字。
 *
 * 未平仓 trade（持仓中）不计入归因 — 浮盈在 equity_curve 里已经反映，重复计算成
 * trade 会双计（与 US-040 RegimeSegmentedBacktest 同款判据）。
 */
export function isClosedTrade(trade: TradeRecord): boolean {
  if (
    trade.sell_date === null ||
    trade.sell_date === undefined ||
    typeof trade.sell_date !== 'string' ||
    trade.sell_date.length === 0
  ) {
    return false;
  }
  if (trade.pnl === null || trade.pnl === undefined) return false;
  const pnl = Number(trade.pnl);
  if (!Number.isFinite(pnl)) return false;
  return true;
}

/**
 * 自然日差值（sell_date - buy_date）。
 *
 * 优先使用 trade.holding_days（QuantBacktestService 写入时已计算），缺则派生。
 * 任一日期非法返回 0；负差值（sell < buy 异常）clamp 到 0。
 */
export function deriveHoldingDays(trade: TradeRecord): number {
  if (
    trade.holding_days !== null &&
    trade.holding_days !== undefined &&
    Number.isFinite(Number(trade.holding_days))
  ) {
    return Math.max(0, Number(trade.holding_days));
  }
  if (!trade.sell_date || !trade.buy_date) return 0;
  const buyMs = Date.parse(`${trade.buy_date}T00:00:00.000Z`);
  const sellMs = Date.parse(`${trade.sell_date}T00:00:00.000Z`);
  if (!Number.isFinite(buyMs) || !Number.isFinite(sellMs)) return 0;
  const diffDays = Math.floor((sellMs - buyMs) / (24 * 60 * 60 * 1000));
  return Math.max(0, diffDays);
}

/**
 * 单行业 group 累加状态（service 内部使用，便于后续单测）。
 */
export interface IndustryGroup {
  industry_code: string;
  industry_name: string;
  total_pnl: number;
  trade_count: number;
  winning_count: number;
  losing_count: number;
  total_volume: number;
  total_holding_days: number;
}

/**
 * 按行业分组累加 trades。
 *
 * 关键约束：
 *   - 仅 isClosedTrade(trade) 通过的 trade 计入（未平仓忽略）。
 *   - symbol 不在 industry_map 中 → 归到 UNKNOWN_INDUSTRY_LABEL（"其他"）。
 *   - industry_map 值经 normalizeIndustryName 标准化。
 *   - total_volume 是 buy + sell 总和（amount * 2 近似）；amount 是 buy 端金额。
 */
export function aggregateTradesByIndustry(
  trades: TradeRecord[],
  industry_map: Record<string, string>
): Map<string, IndustryGroup> {
  const groups = new Map<string, IndustryGroup>();
  for (const trade of trades) {
    if (!isClosedTrade(trade)) continue;
    const rawIndustry = industry_map[trade.symbol];
    const industryName = normalizeIndustryName(rawIndustry);
    const industryCode = industryName; // US-046: code == name; 未来引入 BK 后改这里

    let group = groups.get(industryCode);
    if (!group) {
      group = {
        industry_code: industryCode,
        industry_name: industryName,
        total_pnl: 0,
        trade_count: 0,
        winning_count: 0,
        losing_count: 0,
        total_volume: 0,
        total_holding_days: 0,
      };
      groups.set(industryCode, group);
    }
    const pnl = Number(trade.pnl);
    const amount = Number(trade.amount);
    group.trade_count += 1;
    group.total_pnl += pnl;
    if (pnl > 0) group.winning_count += 1;
    else group.losing_count += 1;
    // total_volume = buy + sell 总和（amount 是 buy 端金额，sell 端约等 amount + pnl）
    if (Number.isFinite(amount)) {
      group.total_volume += amount + (Number.isFinite(amount + pnl) ? amount + pnl : amount);
    }
    group.total_holding_days += deriveHoldingDays(trade);
  }
  return groups;
}

/**
 * 把单行业 group → IndustryAttribution（计算 contribution_pct / win_rate / avg_hold_days）。
 *
 * - `contribution_pct = total_pnl / initial_capital × 100`；initial_capital ≤ 0 时 = 0。
 * - `win_rate = winning_count / trade_count`；trade_count = 0 时 null。
 * - `avg_hold_days = total_holding_days / trade_count`；trade_count = 0 时 null。
 */
export function computeContributionMetrics(
  group: IndustryGroup,
  initial_capital: number
): IndustryAttribution {
  const tc = group.trade_count;
  const contributionPct =
    initial_capital > 0 && Number.isFinite(initial_capital)
      ? (group.total_pnl / initial_capital) * 100
      : 0;
  const winRate = tc > 0 ? group.winning_count / tc : null;
  const avgHoldDays = tc > 0 ? group.total_holding_days / tc : null;
  return {
    industry_code: group.industry_code,
    industry_name: group.industry_name,
    contribution_pct: roundTo(contributionPct, 4),
    total_pnl: roundTo(group.total_pnl, 4),
    win_rate: winRate === null ? null : roundTo(winRate, 4),
    avg_hold_days: avgHoldDays === null ? null : roundTo(avgHoldDays, 2),
    trade_count: tc,
    winning_count: group.winning_count,
    losing_count: group.losing_count,
    total_volume: roundTo(group.total_volume, 4),
  };
}

/**
 * 按 |contribution_pct| 降序排序（绝对贡献大的在前），同绝对值时 industry_code ASC 稳定。
 *
 * UI 展示「贡献最大的行业」/「拖累最大的行业」一目了然；
 * 同绝对值（如 +5% 和 -5%）按 industry_code ASC 保证 deterministic。
 */
export function sortAttributionsByContribution(
  attributions: IndustryAttribution[]
): IndustryAttribution[] {
  return [...attributions].sort((a, b) => {
    const absDiff = Math.abs(b.contribution_pct) - Math.abs(a.contribution_pct);
    if (absDiff !== 0) return absDiff;
    return a.industry_code.localeCompare(b.industry_code);
  });
}

/**
 * 4 位小数 round（避免浮点累计误差让 DB DECIMAL 列写入失败）。
 *
 * 同 BenchmarkAttributionService.roundTo 范式；不导出（service-internal helper）。
 */
function roundTo(n: number, decimals: number): number {
  if (!Number.isFinite(n)) return 0;
  const factor = Math.pow(10, decimals);
  return Math.round(n * factor) / factor;
}

// ============================================================
// 主类
// ============================================================

export class IndustryAttributionService {
  /**
   * 对一次回测执行行业归因。
   *
   * 三种入参形态优先级：
   *   (1) trades + initial_capital + symbol_to_industry（in-memory）
   *   (2) quant_backtest_result_id（从 DB 读）
   * 同时提供时取 in-memory。
   *
   * 流程：
   *   1. 解析入参 → trades / initial_capital / symbol_to_industry / period
   *   2. aggregateTradesByIndustry → Map<industry_code, IndustryGroup>
   *   3. computeContributionMetrics per group → IndustryAttribution[]
   *   4. sortAttributionsByContribution → 排序
   *   5. 累计 total_contribution_pct（应近似 = 策略总收益率）
   *   6. 可选持久化（upsert by 4-tuple PK）
   *
   * 返回 IndustryAttributionRunResult 不抛错（除入参完全无效）；具体行业失败由 DataSource 决定。
   */
  async computeAttribution(
    input: IndustryAttributionInput,
    options: IndustryAttributionOptions = {}
  ): Promise<IndustryAttributionRunResult> {
    const startTime = Date.now();
    const persist = options.persist !== false; // 默认 true
    const replaceExisting = options.replace_existing !== false; // 默认 true
    const source = options.source || DEFAULT_SOURCE;
    const dataSource = options.data_source || PRODUCTION_INDUSTRY_DATA_SOURCE;

    // (1) 解析入参 — in-memory 优先
    let trades: TradeRecord[];
    let initialCapital: number;
    let symbolToIndustry: Record<string, string>;
    let periodStart: string;
    let periodEnd: string;
    let strategyKey: string;
    let runId: number | null = null;

    if (input.trades && input.trades.length >= 0) {
      // in-memory 模式
      trades = input.trades;
      initialCapital = Number(input.initial_capital ?? 0) || 0;
      symbolToIndustry = input.symbol_to_industry || {};
      periodStart = input.period_start || '';
      periodEnd = input.period_end || '';
      strategyKey = input.strategy_key || 'unknown';
      runId = input.quant_backtest_result_id ?? null;
      if (initialCapital <= 0) {
        throw new Error('IndustryAttributionService: in-memory 模式必需提供 initial_capital > 0');
      }
      if (!periodStart || !periodEnd) {
        // 派生 period 从 trades
        const dates = trades
          .flatMap(t => [t.buy_date, t.sell_date])
          .filter((d): d is string => typeof d === 'string' && d.length > 0)
          .sort();
        if (dates.length === 0) {
          throw new Error(
            'IndustryAttributionService: in-memory 模式 period_start/end 未提供且无法从 trades 派生（trades 为空或日期缺失）'
          );
        }
        periodStart = periodStart || dates[0];
        periodEnd = periodEnd || dates[dates.length - 1];
      }
    } else if (input.quant_backtest_result_id !== undefined) {
      const ctx = await dataSource.loadAttributionContext(input.quant_backtest_result_id);
      if (!ctx) {
        throw new Error(
          `IndustryAttributionService: 加载 quant_backtest_result_id=${input.quant_backtest_result_id} 失败（result 不存在或缺关键字段）`
        );
      }
      trades = ctx.trades;
      initialCapital = ctx.initial_capital;
      symbolToIndustry = ctx.symbol_to_industry;
      periodStart = ctx.period_start;
      periodEnd = ctx.period_end;
      strategyKey = input.strategy_key || ctx.strategy_key;
      runId = input.quant_backtest_result_id;
      if (initialCapital <= 0) {
        throw new Error(
          `IndustryAttributionService: result_id=${input.quant_backtest_result_id} 加载的 initial_capital=${initialCapital} 无效（必须 > 0）`
        );
      }
      if (!periodStart || !periodEnd) {
        throw new Error(
          `IndustryAttributionService: result_id=${input.quant_backtest_result_id} 无法派生 period_start/end（task.parameters 缺失且 trades 为空）`
        );
      }
    } else {
      throw new Error(
        'IndustryAttributionService: 必须提供 quant_backtest_result_id 或 trades + initial_capital'
      );
    }

    // (2) 按行业累加
    const groups = aggregateTradesByIndustry(trades, symbolToIndustry);

    // (3) 计算 metrics
    const rawAttributions: IndustryAttribution[] = [];
    for (const group of groups.values()) {
      rawAttributions.push(computeContributionMetrics(group, initialCapital));
    }

    // (4) 排序
    const attributions = sortAttributionsByContribution(rawAttributions);

    // (5) 累计 total_contribution_pct
    const totalContribution = attributions.reduce((sum, a) => sum + a.contribution_pct, 0);

    // (6) 可选写库
    const persistedIds: Array<number | null> = [];
    if (persist && runId !== null) {
      for (const attr of attributions) {
        try {
          const id = await this.persistAttribution(
            runId,
            strategyKey,
            attr,
            periodStart,
            periodEnd,
            source,
            replaceExisting
          );
          persistedIds.push(id);
        } catch (err) {
          logger.warn(
            `[industry-attribution] 持久化 ${attr.industry_code} 失败: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
          persistedIds.push(null);
        }
      }
    } else {
      for (let i = 0; i < attributions.length; i += 1) persistedIds.push(null);
    }

    return {
      run_id: runId,
      strategy_key: strategyKey,
      attributions,
      total_contribution_pct: roundTo(totalContribution, 4),
      persisted_ids: persistedIds,
      duration_ms: Date.now() - startTime,
    };
  }

  private async persistAttribution(
    runId: number,
    strategyKey: string,
    attr: IndustryAttribution,
    periodStart: string,
    periodEnd: string,
    source: string,
    replaceExisting: boolean
  ): Promise<number | null> {
    const where = {
      run_id: runId,
      industry_code: attr.industry_code,
      period_start: periodStart,
      period_end: periodEnd,
    };
    const existing = await IndustryAttributionResult.findOne({ where });
    const payload = {
      run_id: runId,
      strategy_key: strategyKey,
      industry_code: attr.industry_code,
      industry_name: attr.industry_name,
      period_start: periodStart,
      period_end: periodEnd,
      contribution_pct: attr.contribution_pct,
      total_pnl: attr.total_pnl,
      win_rate: attr.win_rate ?? undefined,
      avg_hold_days: attr.avg_hold_days ?? undefined,
      trade_count: attr.trade_count,
      winning_count: attr.winning_count,
      losing_count: attr.losing_count,
      total_volume: attr.total_volume,
      computed_at: new Date(),
      source,
    };
    if (existing) {
      if (!replaceExisting) return existing.id;
      await existing.update(payload);
      return existing.id;
    }
    const created = await IndustryAttributionResult.create(payload as any);
    return created.id;
  }

  // ============================================================
  // Admin 方法（与 BenchmarkAttributionService / PortfolioOptimizer 同款 5 件套）
  // ============================================================

  /** 查某 id 的结果 */
  async getRun(id: number): Promise<IndustryAttributionResult | null> {
    return IndustryAttributionResult.findByPk(id);
  }

  /** 按 run_id 查全部行业归因（一次回测 → N 行业） */
  async getResultsForRun(run_id: number): Promise<IndustryAttributionResult[]> {
    return IndustryAttributionResult.findAll({
      where: { run_id },
      order: [['contribution_pct', 'DESC']],
    });
  }

  /** 列出最近 N 个归因结果（按 created_at 倒序） */
  async listRecentRuns(limit = 30): Promise<IndustryAttributionResult[]> {
    return IndustryAttributionResult.findAll({
      order: [['created_at', 'DESC']],
      limit,
    });
  }

  /** 删除某 id 的结果 */
  async deleteRun(id: number): Promise<{ deleted: number }> {
    const count = await IndustryAttributionResult.destroy({ where: { id } });
    return { deleted: count };
  }

  /** 按 run_id 删除整套（所有行业） */
  async deleteRunByRunId(run_id: number): Promise<{ deleted: number }> {
    const count = await IndustryAttributionResult.destroy({ where: { run_id } });
    return { deleted: count };
  }

  /** 删除 N 天前的全部结果 */
  async cleanupOlderThan(days: number): Promise<{ deleted: number }> {
    if (!Number.isFinite(days) || days <= 0) {
      throw new Error(`cleanupOlderThan: days 必须为正数，收到 ${days}`);
    }
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const count = await IndustryAttributionResult.destroy({
      where: { created_at: { [Op.lt]: cutoff } },
    });
    return { deleted: count };
  }
}

export const industryAttributionService = new IndustryAttributionService();
