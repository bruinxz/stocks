/**
 * OverfitMetrics — Walk-Forward 验证的过拟合诊断指标 (Phase 1 / US-039+)
 *
 * 提供两个学术界推荐的过拟合检测指标，把 walk-forward 输出从
 * "测试夏普 = 1.4 看起来不错" 升级到 "经过样本长度 / 试验次数 /
 * 偏斜度修正的统计置信度"。
 *
 * **DSR (Deflated Sharpe Ratio)** — Bailey & López de Prado (2014)
 *   修正 sharpe 因多次试验、样本长度、偏斜度、峰度引入的过拟合偏差。
 *   DSR < 0.95 表示该 sharpe 大概率来自过拟合而非真实 edge。
 *
 * **PBO (Probability of Backtest Overfitting)** — López de Prado (2018)
 *   在 CPCV 多路径下，统计 "in-sample 最优策略 → out-of-sample 排名 <
 *   median" 的频率。PBO > 0.5 表示策略过拟合的可能性大于一半。
 *
 * **设计选择**：与 BayesianOptimizer 同款"自实现纯数学而非 npm 依赖"：
 *   - DSR 公式所需 standardNormalCdf / standardNormalInverseCdf 都不超过
 *     30 行 + 误差 < 1e-7
 *   - 所有函数都是 export pure function，无 DB / 无 I/O，单测覆盖率应 100%
 *   - 没有任何全局 state，可被 WalkForwardValidator 在 fold 循环中无限调用
 *
 * **与既有模块的关系**：
 *   - 不依赖 QuantBacktestEngine / QuantBacktestService 任何运行时
 *   - 不依赖 sequelize / DB
 *   - 仅 import logger (可选)
 *   - 被 WalkForwardValidator.validate() 在 summary 阶段调用
 *   - 被 QuantStrategyParamVersionService promotion 门禁间接消费（通过
 *     OptimizationRun.metadata_json.wf_summary.dsr 字段读取）
 */

// ============================================================
// 公开常量
// ============================================================

/** Euler-Mascheroni 常数，用于 DSR 的 expected max SR 项 */
export const EULER_MASCHERONI = 0.5772156649015329;

/** DSR 的 PASS 阈值（高于此值认为 sharpe 不是过拟合所致） */
export const DSR_PASS_THRESHOLD = 0.95;

/** PBO 的 FAIL 阈值（高于此值认为大概率过拟合） */
export const PBO_FAIL_THRESHOLD = 0.5;

// ============================================================
// 标准正态 CDF / 逆 CDF（自实现，纯函数，无依赖）
// ============================================================

/**
 * 标准正态分布 CDF —— Φ(x)
 *
 * 用 Abramowitz & Stegun (1964) 的多项式逼近（误差 < 1.5e-7）。
 * 算法 7.1.26（complementary error function 系数）。
 *
 * @param x 任意实数
 * @returns Φ(x) ∈ (0, 1)
 */
export function standardNormalCdf(x: number): number {
  if (!Number.isFinite(x)) {
    if (x === Number.POSITIVE_INFINITY) return 1;
    if (x === Number.NEGATIVE_INFINITY) return 0;
    return Number.NaN;
  }
  // 用 0.5 * (1 + erf(x / sqrt(2)))
  const SQRT_2 = Math.SQRT2;
  return 0.5 * (1 + erf(x / SQRT_2));
}

/**
 * Error function erf(x) —— Abramowitz & Stegun 7.1.26 多项式逼近
 * 误差 < 1.5e-7
 */
function erf(x: number): number {
  // 系数（来自 A&S 表 7.1.26）
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + p * ax);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

/**
 * 标准正态分布 逆 CDF —— Φ⁻¹(p)
 *
 * 用 Beasley-Springer-Moro (1977) 算法。p ∈ (0, 1)。
 * 误差 < 3e-9，远好于 DSR 公式自身的近似误差。
 *
 * @param p 概率 ∈ (0, 1)；边界 0 → -Infinity, 1 → +Infinity
 * @returns Φ⁻¹(p) — 即满足 Φ(z) = p 的 z
 */
export function standardNormalInverseCdf(p: number): number {
  if (!Number.isFinite(p) || p <= 0 || p >= 1) {
    if (p === 0) return Number.NEGATIVE_INFINITY;
    if (p === 1) return Number.POSITIVE_INFINITY;
    return Number.NaN;
  }

  // 系数（来自 Beasley-Springer-Moro 1977 / Wichura 1988）
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  let q: number;
  let r: number;

  if (p < pLow) {
    // 左尾
    q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  } else if (p <= pHigh) {
    // 中段
    q = p - 0.5;
    r = q * q;
    return (
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    );
  } else {
    // 右尾
    q = Math.sqrt(-2 * Math.log(1 - p));
    return (
      -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
}

// ============================================================
// Deflated Sharpe Ratio
// ============================================================

/**
 * Deflated Sharpe Ratio (DSR) — Bailey & López de Prado (2014)
 *
 * **公式**:
 * ```
 *   sr_std         = sqrt( (1 - skew*SR + (kurt - 1)/4 * SR²) / (T - 1) )
 *   expected_max_SR = Φ⁻¹(1 - 1/N) * (1 - γ) + γ * Φ⁻¹(1 - 1/(N*e))
 *   DSR            = Φ( (SR - expected_max_SR) / sr_std )
 * ```
 *
 * 其中：
 *   - `SR` = observedSharpe (年化夏普；如果你的 sharpe 是日级，先乘 √252)
 *   - `T` = sampleLength（夏普计算样本数；通常是回测期总交易日）
 *   - `N` = numTrials（多少次"试验"，即跑了多少参数组合 / strategy 候选）
 *   - `skew` = sample skewness（默认 0）
 *   - `kurt` = sample kurtosis（默认 3，正态分布峰度的"非 excess"约定）
 *   - `γ` = Euler-Mascheroni 常数 ≈ 0.5772
 *   - `e` = Euler's number
 *
 * **解读**：
 *   - DSR ∈ (0, 1)，表示"真实 sharpe 大于 0 的概率（已修正多次试验偏差）"
 *   - DSR ≥ 0.95：策略大概率有真实 edge（推荐 promote）
 *   - DSR < 0.95：sharpe 可能来自参数过拟合，需要更多验证或拒绝
 *
 * **峰度约定**：
 *   公式默认 `kurt=3`（正态分布峰度，非 excess kurtosis）。如果你的统计源
 *   返回的是 excess kurtosis（kurt-3），调用前手动 +3。
 *
 * **边界 case**：
 *   - sampleLength <= 1 → 抛错（公式 (T-1) 分母为 0）
 *   - numTrials <= 0 → 抛错
 *   - sr_std == 0 → 返回 NaN（信号完全无噪音，DSR 无意义）
 *   - observedSharpe NaN / Infinity → 返回 NaN
 *
 * @param input.observedSharpe 观测到的年化夏普
 * @param input.numTrials 多少次试验（参数组合数 / 候选策略数）
 * @param input.sampleLength 样本长度（回测期日数）
 * @param input.skew 样本偏斜度，默认 0
 * @param input.kurt 样本峰度（非 excess），默认 3
 * @returns DSR ∈ [0, 1]，或 NaN（无效输入）
 */
export function deflatedSharpeRatio(input: {
  observedSharpe: number;
  numTrials: number;
  sampleLength: number;
  skew?: number;
  kurt?: number;
}): number {
  const { observedSharpe: sr, numTrials: n, sampleLength: t } = input;
  const skew = input.skew ?? 0;
  const kurt = input.kurt ?? 3;

  // 边界
  if (!Number.isFinite(sr)) return Number.NaN;
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`deflatedSharpeRatio: numTrials must be > 0, got ${n}`);
  }
  if (!Number.isFinite(t) || t <= 1) {
    throw new Error(`deflatedSharpeRatio: sampleLength must be > 1, got ${t}`);
  }

  // sr_std: standard error of the Sharpe estimator
  // = sqrt( (1 - skew*SR + (kurt - 1)/4 * SR²) / (T - 1) )
  const variance = (1 - skew * sr + ((kurt - 1) / 4) * sr * sr) / (t - 1);
  if (variance <= 0) return Number.NaN;
  const srStd = Math.sqrt(variance);

  // expected_max_SR (假设 N 次试验下 max sharpe 的期望值)
  // = Φ⁻¹(1 - 1/N) * (1 - γ) + γ * Φ⁻¹(1 - 1/(N*e))
  // 当 N=1 时，Φ⁻¹(0) = -Infinity → expected_max_SR = -Infinity → DSR = 1
  // (单次试验下"最大值"就是它自己，DSR 应该等于 normal P-value)
  let expectedMaxSr: number;
  if (n === 1) {
    // 单次试验：max-correction 退化为 0，DSR 等同于普通 t-test P-value
    expectedMaxSr = 0;
  } else {
    const term1 = standardNormalInverseCdf(1 - 1 / n) * (1 - EULER_MASCHERONI);
    const term2 = EULER_MASCHERONI * standardNormalInverseCdf(1 - 1 / (n * Math.E));
    expectedMaxSr = term1 + term2;
  }

  // DSR = Φ( (SR - expected_max_SR) / sr_std )
  const z = (sr - expectedMaxSr) / srStd;
  return standardNormalCdf(z);
}

// ============================================================
// Probability of Backtest Overfitting (CPCV-based)
// ============================================================

/**
 * 单条 CPCV path 的样本内 / 样本外 rank 对照数据
 */
export interface CpcvPathRanks {
  /**
   * 该 path 下，每个 candidate strategy / param-combo 在 in-sample (train 集)
   * 的 sharpe rank。约定：rank 1 = 最高 sharpe（最好），rank N = 最低。
   * 数组长度 = 候选总数。
   */
  inSampleRanks: number[];
  /**
   * 同一组 candidates 在 out-of-sample (test 集) 的 sharpe rank。
   * 与 inSampleRanks 数组索引一一对应（同一 candidate）。
   */
  outOfSampleRanks: number[];
}

/**
 * Probability of Backtest Overfitting (PBO) — López de Prado (2018) ch.8
 *
 * **思想**：跑 C(N,k) 条 CPCV 路径，每条路径下：
 *   1. 在 in-sample (train 部分) 跑所有候选 strategy，记录哪个 sharpe 最高
 *      （rank 1）
 *   2. 看这个 "IS 冠军" 在 out-of-sample (test 部分) 的 rank — 是否 < median？
 *   3. 如果 IS 冠军在 OOS 排名 < median (即 OOS rank > N/2)，说明它在样本外表
 *      现不如样本内体现的好，记为 1 个 "overfit event"
 *
 * **公式**：
 *   PBO = (overfit_events_count) / (total_paths_count)
 *
 * **解读**：
 *   - PBO ∈ [0, 1]
 *   - PBO = 0：每条路径下 IS 冠军在 OOS 也是 top-half → 完全没有过拟合
 *   - PBO = 0.5：随机水平（IS 冠军在 OOS 有 50% 概率 top-half、50% bottom-half）
 *   - PBO > 0.5：策略大概率过拟合
 *   - PBO = 1：每条路径下 IS 冠军在 OOS 都 bottom-half → 严重反向过拟合
 *
 * **边界 case**：
 *   - paths 为空数组 → 返回 NaN
 *   - 任何一条 path 的 inSampleRanks 和 outOfSampleRanks 长度不一致 → 抛错
 *   - candidates 数 < 2（无法定义"top-half"）→ 抛错
 *
 * @param input.paths CPCV 各路径的 rank 数据
 * @returns PBO ∈ [0, 1] 或 NaN
 */
export function probabilityOfBacktestOverfitting(input: { paths: CpcvPathRanks[] }): number {
  const { paths } = input;
  if (!Array.isArray(paths) || paths.length === 0) return Number.NaN;

  // 检查所有 path 都合法
  for (let p = 0; p < paths.length; p++) {
    const path = paths[p];
    if (
      !Array.isArray(path.inSampleRanks) ||
      !Array.isArray(path.outOfSampleRanks) ||
      path.inSampleRanks.length !== path.outOfSampleRanks.length
    ) {
      throw new Error(
        `probabilityOfBacktestOverfitting: path[${p}] inSampleRanks (${path.inSampleRanks?.length}) ` +
          `!= outOfSampleRanks (${path.outOfSampleRanks?.length})`
      );
    }
    if (path.inSampleRanks.length < 2) {
      throw new Error(
        `probabilityOfBacktestOverfitting: path[${p}] needs >= 2 candidates, got ${path.inSampleRanks.length}`
      );
    }
  }

  // 对每条 path 计算 IS 冠军是否 OOS bottom-half
  let overfitEvents = 0;
  for (const path of paths) {
    const n = path.inSampleRanks.length;
    // IS 冠军 = inSampleRanks 数组里 rank=1 的那个 candidate 的索引
    const isChampionIdx = path.inSampleRanks.indexOf(Math.min(...path.inSampleRanks));
    // 该 candidate 在 OOS 的 rank
    const oosRank = path.outOfSampleRanks[isChampionIdx];
    // 是否 bottom-half: oosRank > n / 2 即排在后一半
    // (用严格 > 来兼容 odd n; ranks 都是 1..n 整数)
    if (oosRank > n / 2) {
      overfitEvents++;
    }
  }

  return overfitEvents / paths.length;
}

// ============================================================
// Verdict helper
// ============================================================

/**
 * 综合 DSR + PBO 给出最终判断
 *
 * **规则**：
 *   - PASS: DSR ≥ 0.95 且 (PBO 未计算 或 PBO < 0.5)
 *   - FAIL: DSR < 0.95 或 PBO >= 0.5
 *   - INSUFFICIENT: DSR 或 PBO 为 NaN（数据不足）
 *
 * @param input.dsr Deflated Sharpe Ratio
 * @param input.pbo Probability of Backtest Overfitting (CPCV scheme 才有；否则传 null)
 * @returns 'PASS' | 'FAIL' | 'INSUFFICIENT'
 */
export function deriveWalkForwardVerdict(input: {
  dsr: number;
  pbo: number | null;
}): 'PASS' | 'FAIL' | 'INSUFFICIENT' {
  const { dsr, pbo } = input;
  if (!Number.isFinite(dsr)) return 'INSUFFICIENT';
  if (pbo !== null && !Number.isFinite(pbo)) return 'INSUFFICIENT';

  const dsrPass = dsr >= DSR_PASS_THRESHOLD;
  const pboPass = pbo === null || pbo < PBO_FAIL_THRESHOLD;

  return dsrPass && pboPass ? 'PASS' : 'FAIL';
}
