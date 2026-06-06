/**
 * Factor (因子) 公共类型 — US-009 因子基础设施
 *
 * 一个因子 = 把一组上下文输入（K 线、北向、龙虎榜、行业流、财务、估值…）
 * 转换成 (stock_code → raw_value) 的映射的纯函数对象。
 *
 * 设计原则：
 *   1. 因子只输出 **未标准化** 的原始值（FactorPipeline 会做横截面 winsorize + z-score）。
 *      因子内部不要自己做 z-score / 标准化，否则会破坏跨因子可比性。
 *   2. 因子 compute() 必须是幂等的，且不依赖全局 mutable state——
 *      给定相同 (trade_date, universe, 数据库快照) 应得到相同输出。
 *   3. 因子可以返回稀疏 Map（部分股票无值），FactorPipeline 会为缺失股票
 *      写入 raw_value = null + z_score = 0 + percentile = 0.5 的中性行。
 *   4. 因子的 compute() 不写数据库——只读不写。所有写都由 FactorPipeline 统一做，
 *      这样测试 / debug 时可以单独跑因子拿原始结果而不污染库。
 */

/**
 * FactorContext = 给 Factor.compute() 的上下文。
 *
 * - `as_of_date`：以哪个交易日为"今天"截面（影响所有 lookback 计算）。
 *   FactorPipeline.runForDate(date, …) 时这就是 date 本身。
 * - `universe`：本次要计算因子的股票代码列表（无市场前缀，例如 "600519"）。
 *   通常 = 全 A 股活跃股票（剔除停牌、退市、新股 60 日内 等由 pipeline 决定）。
 * - `lookbackDays`：建议的回看自然日窗口。因子可以读取本字段决定查询范围，
 *   也可以忽略它使用自己的常量。FactorPipeline 默认设 250（一年自然日）。
 *
 * 数据访问：因子内部直接 import 需要的 model（DailyBar / NorthboundHolding /
 * DragonTigerBoard / IndustryFlow / StockFundamentalFactor / …）按 universe +
 * lookback 自行查询。没有强制 DataAccessor 层是为了：(a) 因子高度异构，
 * 抽公共 query 反而扩展性差；(b) Sequelize 查询天然支持 batch，因子内部
 * 自己做查询批次划分更直观。
 */
export interface FactorContext {
  /** 截面交易日 (YYYY-MM-DD) */
  as_of_date: string;
  /** 本次计算股票池（无市场前缀的 stock_code 数组） */
  universe: string[];
  /** 建议回看自然日窗口（因子可参考、也可忽略），默认 250 */
  lookbackDays?: number;
  /** 附加配置（如临时改 lookback 周期、剔除 ST 等）；由 pipeline 透传 */
  options?: Record<string, any>;
}

/**
 * FactorComputeOutput = Factor.compute() 的返回值。
 *
 * 必须返回 Map<stock_code, raw_value>。约定：
 *   - 缺失股票不出现在 Map 中（pipeline 会补中性行）。
 *   - raw_value === null 表示因子主动判定该股票 "因子不适用"（保留行但
 *     不参与 winsorize/z-score）。
 *   - raw_value 必须是 finite number（不可 NaN / ±Infinity）；
 *     pipeline 会在写库前再校验一遍。
 */
export type FactorComputeOutput = Map<string, number | null>;

/**
 * Factor 接口 — 所有因子实现的统一形状。
 *
 * 注册：`factorRegistry.register({ name, description, category?, compute })`
 *
 * 示例：
 * ```ts
 * export const valueFactor: Factor = {
 *   name: 'value',
 *   description: 'PE-TTM 倒数 + PB 倒数 合成的价值因子',
 *   category: 'value',
 *   async compute(ctx) {
 *     const rows = await StockValuationFactor.findAll({ where: {…} });
 *     const map = new Map<string, number>();
 *     for (const r of rows) {
 *       map.set(r.symbol, 1 / r.pe_ttm + 1 / r.pb);
 *     }
 *     return map;
 *   }
 * }
 * ```
 */
export interface Factor {
  /** 唯一因子名，建议蛇形 snake_case，例如 'value' / 'momentum_120_20' */
  name: string;
  /** 一句话描述，用于前端 / 报告 */
  description: string;
  /** 因子风格分类（便于 UI 分组），不参与运行时逻辑 */
  category?: FactorCategory;
  /** 计算函数：context → Map<stock_code, raw_value> */
  compute(context: FactorContext): Promise<FactorComputeOutput>;
}

export type FactorCategory =
  | 'value'
  | 'quality'
  | 'growth'
  | 'momentum'
  | 'volatility'
  | 'liquidity'
  | 'sentiment'
  | 'flow'
  | 'event'
  | 'other';
