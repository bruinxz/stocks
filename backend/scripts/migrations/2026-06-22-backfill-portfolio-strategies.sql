-- Batch BA-2025: 回填 17 个 portfolio 的 strategy_keys + enabled_factors
-- 用户截图发现 UI 显示 "策略/因子都空" - 真因: AT-1 migration 加字段时默认 []
-- 这些盘的名字暗示了真实意图 (趋势突破/动量轮动/均值回归等), 按名字映射回填

DO $$
DECLARE
  default_factors jsonb := '[
    "value","quality","quality_high","growth","momentum","momentum_reversal",
    "low_vol","liquidity","money_flow","northbound","dragon_tiger",
    "analyst_consensus","earnings_surprise","fund_consensus","industry_momentum",
    "gradual_breakout","insider_trade","margin_flow","east_money_qa",
    "shareholder_concentration","block_trade_signal","concept_heat"
  ]'::jsonb;
BEGIN
  UPDATE paper_trading_portfolios
  SET enabled_factors = default_factors
  WHERE enabled_factors = '[]'::jsonb OR enabled_factors IS NULL;

  UPDATE paper_trading_portfolios SET strategy_keys = '["multi_factor_alpha","multi_factor_ranking","relative_strength_momentum"]'::jsonb
    WHERE (strategy_keys = '[]'::jsonb OR strategy_keys IS NULL) AND name LIKE '%纯量化%';
  UPDATE paper_trading_portfolios SET strategy_keys = '["multi_factor_alpha","quality_momentum_blend","dual_momentum_rotation"]'::jsonb
    WHERE (strategy_keys = '[]'::jsonb OR strategy_keys IS NULL) AND name LIKE '%参数实验%';
  UPDATE paper_trading_portfolios SET strategy_keys = '["breakout_strategy","breakout_atr","minervini_trend_template","volatility_contraction_breakout","turtle_breakout"]'::jsonb
    WHERE (strategy_keys = '[]'::jsonb OR strategy_keys IS NULL) AND name LIKE '%趋势突破%';
  UPDATE paper_trading_portfolios SET strategy_keys = '["dual_momentum_rotation","cta100_momentum","sector_rotation_leader","relative_strength_momentum"]'::jsonb
    WHERE (strategy_keys = '[]'::jsonb OR strategy_keys IS NULL) AND name LIKE '%动量轮动%';
  UPDATE paper_trading_portfolios SET strategy_keys = '["bollinger_reversion","rsi_reversion","left_side_reversal","trend_pullback_reentry"]'::jsonb
    WHERE (strategy_keys = '[]'::jsonb OR strategy_keys IS NULL) AND name LIKE '%均值回归%';
  UPDATE paper_trading_portfolios SET strategy_keys = '["multi_factor_alpha","quality_momentum_blend","garp_strategy","high_dividend_value"]'::jsonb
    WHERE (strategy_keys = '[]'::jsonb OR strategy_keys IS NULL) AND name LIKE '%多因子质量%';
  UPDATE paper_trading_portfolios SET strategy_keys = '["low_volatility_quality","high_dividend_value","garp_strategy"]'::jsonb
    WHERE (strategy_keys = '[]'::jsonb OR strategy_keys IS NULL) AND name LIKE '%低波防守%';
  UPDATE paper_trading_portfolios SET strategy_keys = '["volume_price_confirmation","macd_trend","ma_trend","donchian_trend"]'::jsonb
    WHERE (strategy_keys = '[]'::jsonb OR strategy_keys IS NULL) AND name LIKE '%量价确认%';
  UPDATE paper_trading_portfolios SET strategy_keys = '["multi_factor_alpha","dragon_head_momentum","breakout_strategy"]'::jsonb
    WHERE (strategy_keys = '[]'::jsonb OR strategy_keys IS NULL) AND name LIKE '%系统观测%';

  -- 兜底: 仍是 []/null 的盘用默认
  UPDATE paper_trading_portfolios SET strategy_keys = '["multi_factor_alpha","dragon_head_momentum"]'::jsonb
    WHERE strategy_keys = '[]'::jsonb OR strategy_keys IS NULL;
END $$;
