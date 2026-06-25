import dayjs from 'dayjs';
import { CreateBacktestPayload } from '../../services/labService';

export type EasyQuantTemplateId = 'steady_trend' | 'breakout_ma' | 'low_vol_value';

export interface EasyQuantTemplate {
  id: EasyQuantTemplateId;
  name: string;
  strategy_key: string;
  risk_label: '低风险' | '中低风险' | '中风险';
  holding_period_label: string;
  beginner_summary: string;
  best_for: string;
  default_universe: 'favorites' | 'all';
  default_initial_capital: number;
  default_lookback_years: number;
  default_candidate_limit: number;
  default_max_positions: number;
  default_position_pct: number;
  default_benchmark_symbol: string;
}

export const EASY_QUANT_TEMPLATES: EasyQuantTemplate[] = [
  {
    id: 'steady_trend',
    name: '稳健趋势',
    strategy_key: 'ma_trend',
    risk_label: '中低风险',
    holding_period_label: '1 到 3 个月',
    beginner_summary: '跟随较稳定的趋势，不追求每天都有交易。',
    best_for: '适合第一次跑量化回测的用户。',
    default_universe: 'favorites',
    default_initial_capital: 200000,
    default_lookback_years: 2,
    default_candidate_limit: 80,
    default_max_positions: 8,
    default_position_pct: 0.12,
    default_benchmark_symbol: 'sh.000300',
  },
  {
    id: 'breakout_ma',
    name: '均线突破',
    strategy_key: 'breakout_atr',
    risk_label: '中风险',
    holding_period_label: '1 到 4 周',
    beginner_summary: '等待价格突破关键区间，再用波动控制仓位。',
    best_for: '适合想理解买点如何产生的用户。',
    default_universe: 'favorites',
    default_initial_capital: 200000,
    default_lookback_years: 2,
    default_candidate_limit: 80,
    default_max_positions: 6,
    default_position_pct: 0.1,
    default_benchmark_symbol: 'sh.000300',
  },
  {
    id: 'low_vol_value',
    name: '低波价值',
    strategy_key: 'low_volatility_quality',
    risk_label: '低风险',
    holding_period_label: '3 到 12 个月',
    beginner_summary: '偏向波动较小、质量较稳的股票，交易频率较低。',
    best_for: '适合希望先观察稳健组合的用户。',
    default_universe: 'favorites',
    default_initial_capital: 200000,
    default_lookback_years: 3,
    default_candidate_limit: 120,
    default_max_positions: 10,
    default_position_pct: 0.1,
    default_benchmark_symbol: 'sh.000300',
  },
];

export function getEasyQuantTemplate(id: EasyQuantTemplateId): EasyQuantTemplate {
  return EASY_QUANT_TEMPLATES.find(item => item.id === id) || EASY_QUANT_TEMPLATES[0];
}

export function buildEasyQuantBacktestPayload(template: EasyQuantTemplate): CreateBacktestPayload {
  const end = dayjs();
  const start = end.subtract(template.default_lookback_years, 'year');

  return {
    task_name: `简易版-${template.name}-${end.format('YYYYMMDD-HHmm')}`,
    universe: template.default_universe,
    strategy_keys: [template.strategy_key],
    start_date: start.format('YYYY-MM-DD'),
    end_date: end.format('YYYY-MM-DD'),
    initial_capital: template.default_initial_capital,
    candidate_limit: template.default_candidate_limit,
    max_positions: template.default_max_positions,
    position_pct: template.default_position_pct,
    execution_timing: 'next_open',
    enable_t_plus_one: true,
    benchmark_symbol: template.default_benchmark_symbol,
    async: true,
  };
}
