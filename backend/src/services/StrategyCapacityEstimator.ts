/**
 * StrategyCapacityEstimator — US-124 PM-013 (WK-005)
 *
 * 估算单策略 capacity = "在不显著破坏 alpha 的前提下, 该策略最多能容纳多少
 * capital". 输出 capacity_used_pct (= 当前 deployed / capacity), 给操盘手看
 * "策略是否已经接近容量极限 → 该减权" — 周报 capacity > 80% 的策略要在
 * AI opinion 的建议清单里出现"减权"提议 (见 72_weekly_strategy_review.md
 * 验收口径 #5).
 *
 * 算法 (基于 Korajczyk & Sadka 2004 + ashare-pit-capacity.estimateStrategyCapacity):
 *   per-stock:
 *     max_daily_trade_cny = ADV × participation_rate
 *     max_position_cny    = max_daily_trade_cny × n_holding_days
 *     stock_capacity_cny  = max_position_cny / target_pos_pct (e.g. 5% → ×20)
 *
 *   strategy 总 capacity = min(stock_capacity_cny) across 该策略 universe
 *                          (bottleneck symbol — 流动性最差的那只决定上限)
 *
 *   capacity_used_pct    = strategy_deployed_cny / strategy_capacity_cny × 100
 *
 * 参数语义:
 *   - participation_rate: 单日参与率上限, 默认 0.10 (10%). A 股冲击成本论文经验
 *     不超 10-20% of ADV; 保守取 10% 让小盘股 capacity 估计更紧.
 *   - n_holding_days: 平均持仓天数, 来自策略画像 (高频策略 ~3d, 低频 ~30d).
 *     默认 5d (一周). 调大让 capacity 增大 (有更多时间慢慢建仓).
 *   - target_pos_pct: 该策略下单股目标仓位 (e.g. 0.05 = 5% portfolio). 默认 0.05.
 *     与 SizingPolicyService 默认一致, 防口径漂移.
 *   - adv_window_days: ADV 平均窗口, 默认 20 (一个月). 周报场景常用; 极短窗口
 *     (5d) 在波动大行情会让 capacity 估计漂移过快.
 *
 * 数据契约:
 *   - input.strategy_positions: 该 portfolio 当前持仓, 已按 strategy_key 分桶
 *     (来自 trade → signal.source_type 反向 lookup, 与 WeeklyReviewReport
 *     PM-011 strategy_contribution 同款 lineage). 字段:
 *       - strategy_key: AISignalSourceType 枚举值 / '__MANUAL__' / '__UNKNOWN__'
 *       - symbol: 股票代码
 *       - market_value_cny: 当前持仓市值 (含浮盈, 与 capacity 同币种)
 *   - input.stock_adv_cny: symbol → ADV (近 N 日成交额均值, 单位元). 来源:
 *     DailyBar.turnover 近 N 日 mean. 缺数据的 symbol 由 caller 在 PRODUCTION
 *     DataSource 层 fail-OPEN (该 symbol 不进 capacity, 避免一个停牌股拖整组).
 *
 * 输出契约 (CapacityRow[], WK-006 直接接到 WeeklyReviewPayload):
 *   - strategy_key: 与 strategy_contribution 同 key
 *   - strategy_label: 中文展示 (与 strategyLabel 函数同款映射)
 *   - capacity_cny: 该策略 capacity 估计 (元), Infinity → "无瓶颈"
 *   - deployed_cny: 当前已部署 (元)
 *   - capacity_used_pct: deployed / capacity × 100, capacity=0 / 缺 ADV → null
 *   - bottleneck_symbol: 决定 capacity 的最瓶颈 symbol (null = 无持仓/无 ADV)
 *   - bottleneck_adv_cny: 该 symbol 的 ADV (元)
 *   - capacity_grade: 'high' (≥10 亿) / 'medium' (≥1 亿) / 'low' (<1 亿) / 'unknown'
 *     (缺 ADV / 无持仓)
 *   - over_capacity: capacity_used_pct >= ALERT_USED_PCT (=80) → true, AI opinion
 *     从这里拉建议"减权"提议
 *
 * 排序:
 *   - capacity_used_pct 降序 (满仓策略在前 — 最需要关注)
 *   - tie → strategy_key 升序 (稳定)
 *
 * 与已有 estimateStrategyCapacity 关系: 后者是单 strategy 静态 sim (需要 caller
 * 传 stock_adv_values + 参数). 本 service 是 portfolio 视角 — 多策略并行批量
 * 输出 CapacityRow[], 真实持仓做 deployed_cny 计算, 直接进周报. estimate
 * StrategyCapacity 适合 backtest / 策略上线前评估, StrategyCapacityEstimator
 * 适合"运营中策略容量监控".
 *
 * fail-OPEN 范式 (与 WeeklyReviewReportService loadDailyCloses / loadTrade
 * StrategyMap 同款):
 *   - pure helpers 永不 throw, 缺数据返 null / 空数组 / unknown grade
 *   - PRODUCTION DataSource 层 try/catch, throw → 整段 capacity_estimates=[]
 *     (不阻塞主邮件发送)
 */

import { AISignalSourceType } from '../models/AIInvestmentSignal';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/**
 * 默认 ADV 参与率上限. 0.10 = 单日最多吃 10% ADV. A 股冲击成本经验区间是
 * 10-20%, 保守取下界让小盘策略 capacity 估计更紧 — 宁可低估提前提示减权,
 * 也不要高估满仓爆仓.
 */
export const DEFAULT_PARTICIPATION_RATE = 0.1;

/**
 * 默认平均持仓天数. 5d = 一个交易周, 与多数中频量化策略匹配. 高频策略 caller
 * 可传 n_holding_days=2; 长期价值策略可传 30.
 */
export const DEFAULT_HOLDING_DAYS = 5;

/**
 * 默认单股目标仓位 (5%). 与 SizingPolicyService 默认值口径一致, PortfolioOptimizer
 * 输出的 weights_by_signal_id 也在 5-10% 区间, 防止 capacity 用了别的口径让
 * 周报数字与下单系统口径漂移.
 */
export const DEFAULT_TARGET_POS_PCT = 0.05;

/**
 * 容量告警阈值 (%). capacity_used_pct >= 80 → over_capacity=true, AI opinion 出
 * "减权"建议. 80% 是行业惯例 — 80%-100% 这一段非线性放大冲击成本, 100% 之后
 * alpha 急速衰减.
 */
export const ALERT_USED_PCT = 80;

/**
 * 容量分级阈值 (元). 与 ashare-pit-capacity.estimateStrategyCapacity 同款门槛
 * — high ≥10 亿, medium ≥1 亿, 否则 low. 缺 ADV / 无持仓 → 'unknown'.
 */
export const CAPACITY_GRADE_THRESHOLDS = {
  HIGH_CNY: 1e9,
  MEDIUM_CNY: 1e8,
} as const;

/**
 * '__MANUAL__' / '__UNKNOWN__' sentinel — 与 WeeklyReviewReportService
 * aggregateStrategyContribution 同款. 手动下单 / 未标注策略归并到这两个 key.
 */
export const STRATEGY_SENTINEL = {
  MANUAL: '__MANUAL__',
  UNKNOWN: '__UNKNOWN__',
} as const;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/**
 * 单条持仓 (按 strategy_key 分桶后). 与 StrategyTradeRow 不同 — 后者是历史
 * trade, 本类型是 snapshot 持仓 (market_value 计入浮盈).
 */
export interface StrategyPositionRow {
  strategy_key: string;
  symbol: string;
  market_value_cny: number;
}

/**
 * Estimator 入参. 数据全部由 caller 在 PRODUCTION DataSource 层准备好;
 * pure helper 不直接访问 DB.
 */
export interface CapacityEstimatorInput {
  strategy_positions: StrategyPositionRow[];
  /** symbol → ADV (元). 缺 symbol → 该 symbol 不进 bottleneck, 但仍计入 deployed. */
  stock_adv_cny: Map<string, number>;
  /** 单日 ADV 参与率上限, 默认 DEFAULT_PARTICIPATION_RATE */
  participation_rate?: number;
  /** 平均持仓天数, 默认 DEFAULT_HOLDING_DAYS */
  n_holding_days?: number;
  /** 单股目标仓位 (0.05 = 5%), 默认 DEFAULT_TARGET_POS_PCT */
  target_pos_pct?: number;
}

/**
 * 单策略 capacity 行 — WK-006 WeeklyReviewPayload.capacity_estimates 直接接
 * 该类型.
 */
export interface CapacityRow {
  strategy_key: string;
  strategy_label: string;
  capacity_cny: number; // Infinity → 无瓶颈 (空策略)
  deployed_cny: number;
  capacity_used_pct: number | null; // null = capacity=0 / 缺 ADV 不算
  bottleneck_symbol: string | null;
  bottleneck_adv_cny: number | null;
  capacity_grade: 'high' | 'medium' | 'low' | 'unknown';
  over_capacity: boolean;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

function safeFiniteNumber(x: any, fallback = 0): number {
  const v = Number(x);
  return Number.isFinite(v) ? v : fallback;
}

function safeString(x: any): string {
  return typeof x === 'string' ? x.trim() : '';
}

/**
 * strategy_key → 中文展示标签. 与 WeeklyReviewReportService.strategyLabel
 * 同款映射 (新接 AISignalSourceType 时两处同步更新).
 */
export function strategyLabel(key: string): string {
  const labels: Record<string, string> = {
    [AISignalSourceType.QUANT_RECOMMENDATION]: '量化推荐',
    [AISignalSourceType.TRADING_AGENTS]: 'TradingAgents',
    [AISignalSourceType.DAILY_SCREENER]: 'AI每日优选',
    [AISignalSourceType.MANUAL_ANALYSIS]: '人工分析',
    [AISignalSourceType.ANALYSIS_ENGINE]: '多维分析引擎',
    [STRATEGY_SENTINEL.MANUAL]: '手动交易',
    [STRATEGY_SENTINEL.UNKNOWN]: '未标注策略',
  };
  return labels[key] || key || '未标注策略';
}

/**
 * 单股 capacity = (ADV × participation × n_days) / target_pos_pct.
 *
 * 数学含义: 该股最多日成交 (ADV × participation), 串 n_days 慢慢建仓得最大
 * 持仓 max_position; 持仓占 portfolio target_pos_pct, 反推可承载 portfolio
 * 总 NAV = max_position / target_pos_pct.
 *
 * 边界:
 *   - adv 非有限 / <=0 → null (该 symbol 不参与 bottleneck 计算)
 *   - participation / n_holding_days / target_pos_pct 非正 → 兜底默认值
 *     (let caller 不必校验, 也防把 capacity 算成 0/Infinity 后续误判)
 */
export function computeStockCapacity(
  adv_cny: number,
  participation_rate: number = DEFAULT_PARTICIPATION_RATE,
  n_holding_days: number = DEFAULT_HOLDING_DAYS,
  target_pos_pct: number = DEFAULT_TARGET_POS_PCT
): number | null {
  const adv = safeFiniteNumber(adv_cny, 0);
  if (adv <= 0) return null;
  const part = safeFiniteNumber(participation_rate, DEFAULT_PARTICIPATION_RATE);
  const days = safeFiniteNumber(n_holding_days, DEFAULT_HOLDING_DAYS);
  const pos = safeFiniteNumber(target_pos_pct, DEFAULT_TARGET_POS_PCT);
  const safePart = part > 0 ? part : DEFAULT_PARTICIPATION_RATE;
  const safeDays = days > 0 ? days : DEFAULT_HOLDING_DAYS;
  const safePos = pos > 0 ? pos : DEFAULT_TARGET_POS_PCT;
  const max_daily = adv * safePart;
  const max_position = max_daily * safeDays;
  return max_position / safePos;
}

/**
 * 容量分级 — 与 ashare-pit-capacity.estimateStrategyCapacity 同口径.
 *   capacity ≥ 10 亿 → 'high'
 *   capacity ≥ 1 亿 → 'medium'
 *   capacity > 0     → 'low'
 *   capacity = 0 / 非有限 → 'unknown'
 *   capacity = Infinity → 'high' (无瓶颈, 实际 portfolio 不可能跑到)
 */
export function gradeCapacity(capacity_cny: number): CapacityRow['capacity_grade'] {
  if (!Number.isFinite(capacity_cny)) {
    // Infinity = 无瓶颈 → 当 high; NaN / -Infinity → unknown
    return capacity_cny === Infinity ? 'high' : 'unknown';
  }
  if (capacity_cny <= 0) return 'unknown';
  if (capacity_cny >= CAPACITY_GRADE_THRESHOLDS.HIGH_CNY) return 'high';
  if (capacity_cny >= CAPACITY_GRADE_THRESHOLDS.MEDIUM_CNY) return 'medium';
  return 'low';
}

/**
 * 按 strategy_key 分桶 positions. 同 strategy 同 symbol 多笔仓位会合并
 * market_value (例如加仓 cycle).
 */
export function bucketPositionsByStrategy(
  positions: StrategyPositionRow[]
): Map<string, Map<string, number>> {
  const map = new Map<string, Map<string, number>>();
  for (const p of positions || []) {
    if (!p) continue;
    const key = safeString(p.strategy_key) || STRATEGY_SENTINEL.UNKNOWN;
    const sym = safeString(p.symbol);
    if (!sym) continue;
    const mv = safeFiniteNumber(p.market_value_cny, 0);
    if (mv <= 0) continue; // 0 / 负市值 不计入 deployed (可能 oversell 异常)
    const inner = map.get(key) || new Map<string, number>();
    inner.set(sym, (inner.get(sym) || 0) + mv);
    map.set(key, inner);
  }
  return map;
}

/**
 * 单策略 capacity 计算 — bottleneck = min(stock_capacity) across symbols.
 *
 * 边界:
 *   - 空策略 (无持仓) → capacity=Infinity / deployed=0 / used_pct=null /
 *     bottleneck=null / grade='unknown'
 *   - 所有 symbol 都缺 ADV → bottleneck=null / used_pct=null / grade='unknown',
 *     但 deployed 仍计入 (UI 提示"capacity 待估" — 数据补齐后即可重算)
 *   - 部分 symbol 缺 ADV → 只用有 ADV 的 symbol 算 bottleneck (信息缺失对该
 *     symbol 是 fail-OPEN 略过, 不污染整组)
 */
export function computeStrategyCapacity(
  symbol_to_mv: Map<string, number>,
  stock_adv_cny: Map<string, number>,
  participation_rate: number,
  n_holding_days: number,
  target_pos_pct: number
): {
  capacity_cny: number;
  deployed_cny: number;
  bottleneck_symbol: string | null;
  bottleneck_adv_cny: number | null;
} {
  let deployed = 0;
  for (const mv of symbol_to_mv.values()) {
    deployed += mv;
  }
  let minCap = Infinity;
  let bottleneck: string | null = null;
  let bottleneckAdv: number | null = null;
  // 排序 key 保证稳定性 (同 capacity 时取字母靠前的 symbol 为 bottleneck)
  const sortedSyms = Array.from(symbol_to_mv.keys()).sort();
  for (const sym of sortedSyms) {
    const adv = stock_adv_cny.get(sym);
    if (adv === undefined) continue;
    const cap = computeStockCapacity(adv, participation_rate, n_holding_days, target_pos_pct);
    if (cap === null) continue;
    if (cap < minCap) {
      minCap = cap;
      bottleneck = sym;
      bottleneckAdv = safeFiniteNumber(adv, 0);
    }
  }
  return {
    capacity_cny: minCap,
    deployed_cny: deployed,
    bottleneck_symbol: bottleneck,
    bottleneck_adv_cny: bottleneckAdv,
  };
}

/**
 * 主入口 — 多策略 batch capacity 估算.
 *
 * 输出按 capacity_used_pct 降序 (over-capacity 排前, AI opinion 直接 take(N)
 * 出建议清单), tie → strategy_key 升序 (稳定排序保 snapshot test 不抖).
 */
export function estimateCapacities(input: CapacityEstimatorInput): CapacityRow[] {
  const part = safeFiniteNumber(input.participation_rate, DEFAULT_PARTICIPATION_RATE);
  const days = safeFiniteNumber(input.n_holding_days, DEFAULT_HOLDING_DAYS);
  const pos = safeFiniteNumber(input.target_pos_pct, DEFAULT_TARGET_POS_PCT);
  const advMap = input.stock_adv_cny instanceof Map ? input.stock_adv_cny : new Map();

  const bucketed = bucketPositionsByStrategy(input.strategy_positions || []);
  const rows: CapacityRow[] = [];
  for (const [strategy_key, symMap] of bucketed.entries()) {
    const { capacity_cny, deployed_cny, bottleneck_symbol, bottleneck_adv_cny } =
      computeStrategyCapacity(symMap, advMap, part, days, pos);
    const usedPct =
      Number.isFinite(capacity_cny) && capacity_cny > 0
        ? Math.round((deployed_cny / capacity_cny) * 1000) / 10 // 1 位小数 %
        : null;
    const grade = gradeCapacity(capacity_cny);
    rows.push({
      strategy_key,
      strategy_label: strategyLabel(strategy_key),
      capacity_cny: Number.isFinite(capacity_cny)
        ? Math.round(capacity_cny * 100) / 100
        : capacity_cny,
      deployed_cny: Math.round(deployed_cny * 100) / 100,
      capacity_used_pct: usedPct,
      bottleneck_symbol,
      bottleneck_adv_cny:
        bottleneck_adv_cny === null ? null : Math.round(bottleneck_adv_cny * 100) / 100,
      capacity_grade: grade,
      over_capacity: usedPct !== null && usedPct >= ALERT_USED_PCT,
    });
  }
  // sort: capacity_used_pct desc (null = 0 等同, 排最后); tie → strategy_key asc
  rows.sort((a, b) => {
    const av = a.capacity_used_pct === null ? -1 : a.capacity_used_pct;
    const bv = b.capacity_used_pct === null ? -1 : b.capacity_used_pct;
    if (av !== bv) return bv - av;
    return a.strategy_key.localeCompare(b.strategy_key);
  });
  return rows;
}

/**
 * 从 DailyBar.turnover 行列表算 ADV (平均日成交额, 单位元).
 *
 * 输入: 同 symbol 近 N 个交易日的 turnover 行 (PRODUCTION 已 ORDER BY time
 * DESC LIMIT window_days). 缺/非有限值 skip; 空数组 → null. ≥ 1 个有效点即
 * 输出 mean — 极端缺数据 (周报当日只有 1 个 bar) 也能产出, 总比 null 让该
 * symbol 整段拿不到 capacity 强.
 *
 * 与 DailyBar.turnover_rate 区分: 前者是元 (含价), 后者是 % 换手率 (= 成交量
 * / 流通股本). capacity 要的是钱, 取 turnover.
 */
export function meanTurnoverFromBars(
  bars: Array<{ turnover?: number | string | null }>
): number | null {
  if (!Array.isArray(bars) || bars.length === 0) return null;
  let sum = 0;
  let n = 0;
  for (const b of bars) {
    const v = safeFiniteNumber(b?.turnover, 0);
    if (v > 0) {
      sum += v;
      n += 1;
    }
  }
  if (n === 0) return null;
  return sum / n;
}
