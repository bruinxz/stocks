export const riskLimitKeyLabels: Record<string, string> = {
  min_cash_reserve_pct: '现金底线',
  max_total_exposure_pct: '总仓位上限',
  max_industry_exposure_pct: '行业集中上限',
  max_portfolio_drawdown_pct: '组合回撤上限',
  max_position_correlation: '持仓相关性上限',
  max_portfolio_var_pct: '组合VaR上限',
  max_single_stock_volatility_pct: '单票波动上限',
  risk_threshold_stability_min_consecutive_same_action: '连续同向建议',
  risk_threshold_stability_min_actionable_samples: '可执行样本',
  risk_threshold_stability_min_protected_runs: '最少保护触发',
  risk_threshold_stability_tighten_min_delta_pct: '收紧保护差值',
  risk_threshold_stability_relax_max_delta_pct: '放松保护差值',
  risk_threshold_field_stability_min_consecutive_same_action: '字段连续同向',
  risk_threshold_field_min_confidence: '字段最小置信度',
  risk_threshold_field_min_sample_count: '字段最小样本',
  risk_threshold_field_min_triggered_count: '字段最小触发',
  risk_threshold_field_gate_update_source: '字段门槛来源',
};

export const riskLimitKeyPriority: Record<string, number> = {
  min_cash_reserve_pct: 1,
  max_total_exposure_pct: 2,
  max_portfolio_drawdown_pct: 3,
  max_industry_exposure_pct: 4,
  max_position_correlation: 5,
  max_portfolio_var_pct: 6,
  max_single_stock_volatility_pct: 7,
};

export const getRiskLimitKeyLabel = (key?: string) => riskLimitKeyLabels[key || ''] || key || '-';
