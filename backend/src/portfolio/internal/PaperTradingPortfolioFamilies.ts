export const DEFAULT_AUTONOMOUS_INITIAL_CAPITAL = 200000;
export const AUTONOMOUS_PORTFOLIO_NAME = 'Codex自主荐股模拟盘（20W）';
export const QUANT_ONLY_PORTFOLIO_NAME = 'Codex纯量化模拟盘（20W）';
export const QUANT_AGENT_FUSION_PORTFOLIO_NAME = 'Codex量化Agent融合模拟盘（20W）';
export const AGENT_ONLY_PORTFOLIO_NAME = 'Codex Agent独立模拟盘（20W）';
export const PARAM_EXPERIMENT_PORTFOLIO_NAME = 'Codex参数实验模拟盘（20W）';
export const QUANT_TREND_PORTFOLIO_NAME = 'Codex趋势突破模拟盘（20W）';
export const QUANT_MOMENTUM_PORTFOLIO_NAME = 'Codex动量轮动模拟盘（20W）';
export const QUANT_MEAN_REVERSION_PORTFOLIO_NAME = 'Codex均值回归模拟盘（20W）';
export const QUANT_MULTI_FACTOR_PORTFOLIO_NAME = 'Codex多因子质量模拟盘（20W）';
export const QUANT_LOW_VOL_PORTFOLIO_NAME = 'Codex低波防守模拟盘（20W）';
export const QUANT_VOLUME_PRICE_PORTFOLIO_NAME = 'Codex量价确认模拟盘（20W）';

export const PAPER_PORTFOLIO_EXPERIMENT_FAMILIES = [
  {
    key: 'quant_trend_breakout',
    label: '趋势突破盘',
    name: QUANT_TREND_PORTFOLIO_NAME,
    description: '只跟随趋势/突破类策略，验证右侧趋势和平台突破是否能跑赢综合盘。',
    strategy_keys: [
      'ma_trend',
      'macd_trend',
      'breakout_atr',
      'donchian_trend',
      'turtle_breakout',
      'minervini_trend_template',
      'volatility_contraction_breakout',
    ],
    default_position_pct: 3,
    max_position_pct: 6,
    trade_limit: 3,
    max_positions: 8,
    min_score: 66,
    allowed_risk_levels: ['low', 'medium', 'high'],
    risk_profile_gate: {
      experiment_family: 'quant_trend_breakout',
      action: 'observe',
      reason: '趋势突破盘独立小仓对照，接受高波动策略但限制单票仓位',
      position_multiplier: 0.75,
    },
  },
  {
    key: 'quant_momentum_rotation',
    label: '动量轮动盘',
    name: QUANT_MOMENTUM_PORTFOLIO_NAME,
    description: '只跟随相对强弱、双动量和量价资金确认，验证强势主线轮动收益。',
    strategy_keys: [
      'relative_strength_momentum',
      'dual_momentum_rotation',
      'volume_price_confirmation',
    ],
    default_position_pct: 3,
    max_position_pct: 6,
    trade_limit: 3,
    max_positions: 8,
    min_score: 65,
    allowed_risk_levels: ['low', 'medium'],
    risk_profile_gate: {
      experiment_family: 'quant_momentum_rotation',
      action: 'observe',
      reason: '动量轮动盘独立小仓对照，优先验证中短期强势延续',
      position_multiplier: 0.8,
    },
  },
  {
    key: 'quant_mean_reversion',
    label: '均值回归盘',
    name: QUANT_MEAN_REVERSION_PORTFOLIO_NAME,
    description: '只跟随RSI/布林和趋势回踩低吸，验证震荡市与强势股回调修复能力。',
    strategy_keys: ['rsi_reversion', 'bollinger_reversion', 'trend_pullback_reentry'],
    default_position_pct: 2.5,
    max_position_pct: 5,
    trade_limit: 3,
    max_positions: 8,
    min_score: 62,
    allowed_risk_levels: ['low', 'medium'],
    risk_profile_gate: {
      experiment_family: 'quant_mean_reversion',
      action: 'observe',
      reason: '均值回归盘独立小仓对照，避免把反弹策略和趋势策略混在一起',
      position_multiplier: 0.75,
    },
  },
  {
    key: 'quant_multi_factor_quality',
    label: '多因子质量盘',
    name: QUANT_MULTI_FACTOR_PORTFOLIO_NAME,
    description: '只跟随多因子排序和质量动量融合，验证因子综合评分的稳定赚钱能力。',
    strategy_keys: ['multi_factor_ranking', 'quality_momentum_blend'],
    default_position_pct: 3.5,
    max_position_pct: 7,
    trade_limit: 3,
    max_positions: 8,
    min_score: 64,
    allowed_risk_levels: ['low', 'medium'],
    risk_profile_gate: {
      experiment_family: 'quant_multi_factor_quality',
      action: 'observe',
      reason: '多因子质量盘独立小仓对照，重点验证质量/估值/资金流合成效果',
      position_multiplier: 0.85,
    },
  },
  {
    key: 'quant_low_vol_defensive',
    label: '低波防守盘',
    name: QUANT_LOW_VOL_PORTFOLIO_NAME,
    description: '只跟随低波质量防守策略，验证低回撤、低换手的稳健收益。',
    strategy_keys: ['low_volatility_quality'],
    default_position_pct: 4,
    max_position_pct: 8,
    trade_limit: 2,
    max_positions: 6,
    min_score: 62,
    allowed_risk_levels: ['low', 'medium'],
    risk_profile_gate: {
      experiment_family: 'quant_low_vol_defensive',
      action: 'observe',
      reason: '低波防守盘独立对照，允许略高单票仓位但只吃低波质量信号',
      position_multiplier: 0.9,
    },
  },
  {
    key: 'quant_volume_price',
    label: '量价确认盘',
    name: QUANT_VOLUME_PRICE_PORTFOLIO_NAME,
    description: '只跟随量价确认策略，单独观察成交量、换手率和资金承接是否有效。',
    strategy_keys: ['volume_price_confirmation'],
    default_position_pct: 3,
    max_position_pct: 6,
    trade_limit: 2,
    max_positions: 6,
    min_score: 64,
    allowed_risk_levels: ['low', 'medium'],
    risk_profile_gate: {
      experiment_family: 'quant_volume_price',
      action: 'observe',
      reason: '量价确认盘独立对照，验证资金确认类信号的真实模拟收益',
      position_multiplier: 0.8,
    },
  },
] as const;

export const PAPER_PORTFOLIO_FAMILIES = [
  {
    key: 'legacy_autonomous',
    label: '自主荐股综合盘',
    name: AUTONOMOUS_PORTFOLIO_NAME,
    description: '历史兼容综合账户，保留早期 AI/量化混合跟单样本。',
  },
  {
    key: 'quant_only',
    label: '纯量化指标盘',
    name: QUANT_ONLY_PORTFOLIO_NAME,
    description: '只跟随量化指标/多策略共识直接归档的信号，用来验证指标本身赚钱能力。',
  },
  {
    key: 'quant_agent_fusion',
    label: '量化+Agent融合盘',
    name: QUANT_AGENT_FUSION_PORTFOLIO_NAME,
    description: '量化先筛选，再由 TradingAgents 复核后跟单，用来验证融合是否提升胜率。',
  },
  {
    key: 'agent_only',
    label: 'Agent独立研判盘',
    name: AGENT_ONLY_PORTFOLIO_NAME,
    description: 'TradingAgents 独立荐股样本，用作与量化指标的对照组。',
  },
  {
    key: 'param_experiment',
    label: '参数实验盘',
    name: PARAM_EXPERIMENT_PORTFOLIO_NAME,
    description: '专门承接参数 A/B 小仓验证，避免短期冠军参数直接放大风险。',
  },
  ...PAPER_PORTFOLIO_EXPERIMENT_FAMILIES,
] as const;

export type PaperPortfolioFamily = (typeof PAPER_PORTFOLIO_FAMILIES)[number];
export type PaperPortfolioExperimentFamily = (typeof PAPER_PORTFOLIO_EXPERIMENT_FAMILIES)[number];
