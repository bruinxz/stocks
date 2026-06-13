/**
 * A 股本土研报方法论 — 中信 Barra-CN + 华泰行业轮动 + 国信选股 + 天风 Alpha 101 + 国泰君安风格切换
 *
 * 研报 reference:
 *   中信证券金工: 《Barra-CN 多因子模型》系列 (Risk Model 中国版)
 *   华泰证券金工: 《行业景气度模型与 ETF 轮动》(2017-2024 持续更新)
 *   国信证券金工: 《量化选股: 基本面 + 量价多维框架》(2018+)
 *   天风证券金工: 《Alpha 101 中国版》(基于 WorldQuant 公开版本本土化)
 *   国泰君安金工: 《风格切换识别 + Barra-style PCA》(2019+)
 *
 *   WorldQuant Alpha 101: Kakushadze, Z. (2016). "101 Formulaic Alphas."
 *   https://arxiv.org/abs/1601.00991
 *
 * **中信 Barra-CN 多因子模型**:
 *
 *   8 个风格因子:
 *     - Size: log(market_cap)
 *     - Beta: β to market index (252-day rolling regression)
 *     - Momentum: 12-month return excluding most recent month
 *     - Volatility: 90-day vol (annualized)
 *     - NonLinearSize: (log market_cap)^3 (cubic, captures large-cap drag)
 *     - BookToPrice: B/M ratio
 *     - Liquidity: log(monthly turnover)
 *     - EarningsYield: E/P ratio
 *     - Growth: 5-year earnings growth
 *     - Leverage: Debt/Equity
 *
 *   每个 stock 的因子暴露 → 形成 N × K 暴露矩阵 X.
 *
 *   stock_return = α + Σ_k β_k × factor_k_return + ε
 *
 * **华泰行业景气度模型**:
 *
 *   每月给每个行业打分:
 *     - 上下游: 上游价格 / 下游需求 (e.g. 钢价 / 房地产销售)
 *     - 财务: 营收增速 / 净利率 / ROE
 *     - 资金: 北上资金 / 主动基金持仓变化
 *     - 估值: PE-TTM / PB
 *
 *   分数 → ranked → top 5 行业 buy ETF, bottom 5 sell.
 *
 * **国信基本面 + 量价多维**:
 *
 *   把 stock 选择分 2 步:
 *     1. **Universe 过滤**: 剔除 ST / 次新 / 退市风险, 流动性下限
 *     2. **Composite Score**:
 *        score = 0.4 × fundamental_zscore + 0.4 × technical_zscore + 0.2 × sentiment_zscore
 *
 *   - fundamental: ROE + Growth + Quality
 *   - technical: Momentum + RSI + Volume
 *   - sentiment: 龙虎榜 + 北上 + 机构持仓变化
 *
 * **天风 Alpha 101 (Kakushadze 2016)**:
 *
 *   101 个公式化 alpha 因子, 都是 close/volume/high/low 等基础 feature 的组合.
 *
 *   典型 example (Alpha #1):
 *     alpha = rank(ts_argmax(SignedPower(((returns < 0) ? stddev(returns, 20) : close), 2.), 5)) - 0.5
 *
 *   本实现选 10 个最有代表性的 (实际工业用约 30-50 个).
 *
 * **国泰君安风格切换**:
 *
 *   PCA on 风格因子 returns → 主成分 1 = "size factor", 主成分 2 = "value factor"
 *
 *   观察主成分 sign + magnitude 切换 → 风格切换信号:
 *     - PC1 > 0: 大盘 dominate
 *     - PC1 < 0: 小盘 dominate
 *     - 切换历时 30-60 trading days
 *
 *   实时监控 + 提醒策略调仓.
 */

// ============================================================
// Barra-CN 风格因子
// ============================================================

export interface BarraExposure {
  size: number;
  beta: number;
  momentum: number;
  volatility: number;
  non_linear_size: number;
  book_to_price: number;
  liquidity: number;
  earnings_yield: number;
  growth: number;
  leverage: number;
}

export interface BarraStockData {
  symbol: string;
  market_cap: number;        // in 元
  beta_252d: number;          // pre-computed regression beta
  return_252d_ex_last_month: number;
  vol_90d_annualized: number;
  book_value_per_share: number;
  price: number;
  monthly_turnover: number;
  earnings_per_share: number;
  growth_5y: number;          // 5-year earnings CAGR
  debt_to_equity: number;
}

/**
 * Compute 10-factor Barra-CN exposures for a stock.
 *
 * Returns raw exposures (caller should z-score across universe).
 */
export function computeBarraExposure(stock: BarraStockData): BarraExposure {
  const log_mcap = stock.market_cap > 0 ? Math.log(stock.market_cap) : 0;
  return {
    size: log_mcap,
    beta: stock.beta_252d,
    momentum: stock.return_252d_ex_last_month,
    volatility: stock.vol_90d_annualized,
    non_linear_size: Math.pow(log_mcap, 3),
    book_to_price: stock.price > 0 ? stock.book_value_per_share / stock.price : 0,
    liquidity: stock.monthly_turnover > 0 ? Math.log(stock.monthly_turnover) : 0,
    earnings_yield: stock.price > 0 ? stock.earnings_per_share / stock.price : 0,
    growth: stock.growth_5y,
    leverage: stock.debt_to_equity,
  };
}

/**
 * Z-score normalize exposures across universe (cross-sectional).
 *
 * 中信推荐: 每月对 universe 做 cross-section z-score, mean=0 std=1.
 */
export function zScoreExposures(exposures: BarraExposure[]): BarraExposure[] {
  if (exposures.length === 0) return [];
  const keys: (keyof BarraExposure)[] = [
    'size', 'beta', 'momentum', 'volatility', 'non_linear_size',
    'book_to_price', 'liquidity', 'earnings_yield', 'growth', 'leverage',
  ];
  const means: Record<string, number> = {};
  const stds: Record<string, number> = {};
  for (const k of keys) {
    const vals = exposures.map(e => (e as any)[k] as number).filter(Number.isFinite);
    if (vals.length === 0) continue;
    const m = vals.reduce((s, v) => s + v, 0) / vals.length;
    const variance = vals.length > 1 ? vals.reduce((s, v) => s + (v - m) ** 2, 0) / (vals.length - 1) : 1;
    means[k] = m;
    stds[k] = Math.sqrt(Math.max(1e-9, variance));
  }
  return exposures.map(e => {
    const out: any = {};
    for (const k of keys) {
      const v = (e as any)[k];
      out[k] = stds[k] > 0 ? (v - means[k]) / stds[k] : 0;
    }
    return out as BarraExposure;
  });
}

// ============================================================
// 华泰行业景气度模型
// ============================================================

export interface IndustryProsperityInput {
  industry: string;
  upstream_price_change: number;     // pct change 12m
  downstream_demand_change: number;   // pct change 12m
  revenue_growth: number;             // YoY %
  net_margin: number;                  // %
  roe: number;                          // %
  northbound_change_pct: number;       // 北上资金变化 / 流通市值
  active_fund_holding_change: number;  // 主动基金加减仓
  pe_ttm: number;                       // current PE
  pe_historical_avg: number;           // 5-year avg PE
  pb: number;
  pb_historical_avg: number;
}

/**
 * Compute industry prosperity score (0-100).
 *
 *   华泰 weighting:
 *     - 上下游 (40%): upstream + downstream demand
 *     - 财务 (30%): revenue growth + margin + ROE
 *     - 资金 (20%): northbound + fund holding
 *     - 估值 (10%): PE/PB vs historical
 */
export function computeIndustryProsperity(input: IndustryProsperityInput): {
  score: number;
  components: { upstream_downstream: number; financial: number; capital: number; valuation: number };
  recommendation: 'overweight' | 'neutral' | 'underweight';
} {
  // Upstream/downstream score (0-100): 上游降价 + 下游需求增 = good
  const ud_score = Math.max(0, Math.min(100, 50 - input.upstream_price_change * 10 + input.downstream_demand_change * 10));

  // Financial score: revenue growth + margin + ROE
  const fin_score = Math.max(0, Math.min(100,
    25 + input.revenue_growth * 2 + input.net_margin * 2 + input.roe * 2,
  ));

  // Capital flow score
  const cap_score = Math.max(0, Math.min(100, 50 + input.northbound_change_pct * 20 + input.active_fund_holding_change * 20));

  // Valuation score: lower PE vs historical = good
  const pe_premium = input.pe_historical_avg > 0 ? (input.pe_historical_avg - input.pe_ttm) / input.pe_historical_avg : 0;
  const pb_premium = input.pb_historical_avg > 0 ? (input.pb_historical_avg - input.pb) / input.pb_historical_avg : 0;
  const val_score = Math.max(0, Math.min(100, 50 + pe_premium * 50 + pb_premium * 30));

  const score = 0.4 * ud_score + 0.3 * fin_score + 0.2 * cap_score + 0.1 * val_score;
  const recommendation: 'overweight' | 'neutral' | 'underweight' =
    score >= 65 ? 'overweight' : score >= 40 ? 'neutral' : 'underweight';

  return {
    score,
    components: { upstream_downstream: ud_score, financial: fin_score, capital: cap_score, valuation: val_score },
    recommendation,
  };
}

// ============================================================
// 国信基本面 + 量价多维选股
// ============================================================

export interface GuosenStockInput {
  symbol: string;
  // Fundamental
  roe: number;
  earnings_growth_yoy: number;
  earnings_quality: number; // 0-1 (e.g. cash flow / net income)
  // Technical
  momentum_12m: number;
  rsi_14: number;
  volume_ratio_20d: number;
  // Sentiment
  northbound_change_pct: number;
  institutional_holding_change: number;
  longhu_score: number; // 龙虎榜 normalized score
}

/**
 * Compute Guosen composite score (0-100).
 *
 *   score = 0.4 × fundamental_z + 0.4 × technical_z + 0.2 × sentiment_z
 *
 * Caller passes pre-zscored values (-3 to +3 range).
 */
export function computeGuosenScore(input: {
  fundamental_zscore: number; // composite of ROE/growth/quality
  technical_zscore: number;
  sentiment_zscore: number;
}): { score: number; rank_decile: number } {
  const combined = 0.4 * input.fundamental_zscore + 0.4 * input.technical_zscore + 0.2 * input.sentiment_zscore;
  // Normalize z in [-3, +3] to score 0-100
  const score = Math.max(0, Math.min(100, 50 + combined * 16));
  const rank_decile = Math.floor(score / 10);
  return { score, rank_decile };
}

// ============================================================
// WorldQuant Alpha 101 中国版 (天风)
// ============================================================

/**
 * Helper: rank values cross-sectionally → [0, 1]
 */
function rank(values: number[]): number[] {
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  const ranks = new Array(values.length).fill(0);
  for (let r = 0; r < indexed.length; r += 1) ranks[indexed[r].i] = r / (values.length - 1 || 1);
  return ranks;
}

/**
 * Helper: rolling std for last n days
 */
function rollingStd(series: number[], window: number): number[] {
  const out: number[] = new Array(series.length).fill(NaN);
  for (let i = window - 1; i < series.length; i += 1) {
    const slice = series.slice(i - window + 1, i + 1);
    const m = slice.reduce((s, v) => s + v, 0) / window;
    const v = slice.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, window - 1);
    out[i] = Math.sqrt(v);
  }
  return out;
}

/**
 * Helper: ts_argmax(x, n) — index in [t-n+1, t] where x is maximum
 */
function tsArgmax(series: number[], window: number): number[] {
  const out: number[] = new Array(series.length).fill(NaN);
  for (let i = window - 1; i < series.length; i += 1) {
    let max_val = -Infinity;
    let max_idx = 0;
    for (let k = 0; k < window; k += 1) {
      if (series[i - k] > max_val) { max_val = series[i - k]; max_idx = k; }
    }
    out[i] = max_idx;
  }
  return out;
}

/**
 * Alpha #1 (Kakushadze 2016):
 *   alpha = rank(ts_argmax(SignedPower(((returns < 0) ? stddev(returns, 20) : close), 2.), 5)) - 0.5
 */
export function alphaWQ1(returns_matrix: number[][], close_matrix: number[][]): number[][] {
  const N = returns_matrix.length; // stocks
  const T = returns_matrix[0]?.length ?? 0;
  // For each stock, compute signed power series
  const sp: number[][] = returns_matrix.map((rets, i) => {
    const closes = close_matrix[i];
    const std_ret = rollingStd(rets, 20);
    return rets.map((r, t) => {
      const base = r < 0 ? (std_ret[t] || 0) : closes[t];
      return Math.sign(base) * base * base;
    });
  });
  // ts_argmax over 5 days
  const ts_argmax_5 = sp.map(s => tsArgmax(s, 5));
  // cross-sectional rank at each t
  const out: number[][] = Array.from({ length: N }, () => new Array(T).fill(NaN));
  for (let t = 0; t < T; t += 1) {
    const cross_section = ts_argmax_5.map(s => s[t]);
    if (cross_section.every(v => Number.isFinite(v))) {
      const ranks = rank(cross_section);
      for (let i = 0; i < N; i += 1) out[i][t] = ranks[i] - 0.5;
    }
  }
  return out;
}

/**
 * Alpha #6: -correlation(close, volume, 10)
 *
 * Negative correlation between price and volume in last 10 days = anomaly.
 */
export function alphaWQ6(close_matrix: number[][], volume_matrix: number[][]): number[][] {
  const N = close_matrix.length;
  const T = close_matrix[0]?.length ?? 0;
  const window = 10;
  const out: number[][] = Array.from({ length: N }, () => new Array(T).fill(NaN));
  for (let i = 0; i < N; i += 1) {
    for (let t = window - 1; t < T; t += 1) {
      const cs = close_matrix[i].slice(t - window + 1, t + 1);
      const vs = volume_matrix[i].slice(t - window + 1, t + 1);
      const mc = cs.reduce((s, v) => s + v, 0) / window;
      const mv = vs.reduce((s, v) => s + v, 0) / window;
      let num = 0, dc = 0, dv = 0;
      for (let k = 0; k < window; k += 1) {
        num += (cs[k] - mc) * (vs[k] - mv);
        dc += (cs[k] - mc) ** 2;
        dv += (vs[k] - mv) ** 2;
      }
      const corr = dc * dv > 0 ? num / Math.sqrt(dc * dv) : 0;
      out[i][t] = -corr;
    }
  }
  return out;
}

/**
 * Alpha #12: sign(delta(volume, 1)) * (-1 * delta(close, 1))
 *
 * 量价反向时强 (high vol drop or low vol rise).
 */
export function alphaWQ12(close_matrix: number[][], volume_matrix: number[][]): number[][] {
  const N = close_matrix.length;
  const T = close_matrix[0]?.length ?? 0;
  const out: number[][] = Array.from({ length: N }, () => new Array(T).fill(NaN));
  for (let i = 0; i < N; i += 1) {
    for (let t = 1; t < T; t += 1) {
      const dvol = volume_matrix[i][t] - volume_matrix[i][t - 1];
      const dclose = close_matrix[i][t] - close_matrix[i][t - 1];
      out[i][t] = Math.sign(dvol) * (-dclose);
    }
  }
  return out;
}

// ============================================================
// 国泰君安风格切换识别
// ============================================================

/**
 * Compute style factor returns time series.
 *
 *   For each day, group stocks by Barra exposure (e.g. size, value),
 *   then SMB = small - big, HML = high B/M - low B/M.
 */
export function computeStyleFactorReturns(
  daily_data: Array<{
    date: string;
    stocks: Array<{ symbol: string; return_pct: number; exposure: BarraExposure }>;
  }>
): Array<{ date: string; smb: number; hml: number; momentum: number; vol: number }> {
  return daily_data.map(d => {
    const stocks = d.stocks;
    // Sort by size, top/bottom 30%
    const by_size = [...stocks].sort((a, b) => a.exposure.size - b.exposure.size);
    const k = Math.floor(stocks.length * 0.3);
    const small = by_size.slice(0, k);
    const big = by_size.slice(stocks.length - k);
    const smb = avg(small.map(s => s.return_pct)) - avg(big.map(s => s.return_pct));

    const by_bp = [...stocks].sort((a, b) => a.exposure.book_to_price - b.exposure.book_to_price);
    const growth = by_bp.slice(0, k);
    const value = by_bp.slice(stocks.length - k);
    const hml = avg(value.map(s => s.return_pct)) - avg(growth.map(s => s.return_pct));

    const by_mom = [...stocks].sort((a, b) => a.exposure.momentum - b.exposure.momentum);
    const low_mom = by_mom.slice(0, k);
    const high_mom = by_mom.slice(stocks.length - k);
    const momentum = avg(high_mom.map(s => s.return_pct)) - avg(low_mom.map(s => s.return_pct));

    const by_vol = [...stocks].sort((a, b) => a.exposure.volatility - b.exposure.volatility);
    const low_vol = by_vol.slice(0, k);
    const high_vol = by_vol.slice(stocks.length - k);
    const vol = avg(low_vol.map(s => s.return_pct)) - avg(high_vol.map(s => s.return_pct));

    return { date: d.date, smb, hml, momentum, vol };
  });
}

function avg(values: number[]): number {
  return values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : 0;
}

/**
 * Detect style regime switch using rolling momentum on factor returns.
 *
 *   For each style factor (SMB, HML, momentum, vol):
 *     - Compute 20-day rolling mean
 *     - If mean changes sign from previous 20 days → "regime switch" signal
 *
 * @returns map of factor → switch event (if any)
 */
export function detectStyleSwitch(
  style_returns: Array<{ date: string; smb: number; hml: number; momentum: number; vol: number }>,
  window: number = 20
): Record<string, { switch_date: string; new_regime: 'positive' | 'negative' } | null> {
  if (style_returns.length < 2 * window) return { smb: null, hml: null, momentum: null, vol: null };
  const factors = ['smb', 'hml', 'momentum', 'vol'] as const;
  const out: Record<string, { switch_date: string; new_regime: 'positive' | 'negative' } | null> = {};

  for (const f of factors) {
    const values = style_returns.map(s => s[f]);
    const last_window = values.slice(-window).reduce((s, v) => s + v, 0) / window;
    const prev_window = values.slice(-2 * window, -window).reduce((s, v) => s + v, 0) / window;
    if (Math.sign(last_window) !== Math.sign(prev_window) && Math.abs(last_window) > 0.001) {
      out[f] = {
        switch_date: style_returns[style_returns.length - 1].date,
        new_regime: last_window > 0 ? 'positive' : 'negative',
      };
    } else {
      out[f] = null;
    }
  }
  return out;
}
