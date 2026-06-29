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
  buy_logic_label: string;
  sell_logic_label: string;
  risk_note: string;
  default_hypothesis: string;
  default_universe: 'favorites' | 'all';
  default_initial_capital: number;
  default_lookback_years: number;
  default_candidate_limit: number;
  default_max_positions: number;
  default_position_pct: number;
  default_benchmark_symbol: string;
}

export interface EasyQuantRunConfig {
  initial_capital: number;
  lookback_years: 1 | 2 | 3;
  universe: 'favorites' | 'all';
  candidate_limit: number;
  max_positions: number;
  position_pct: number;
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
    buy_logic_label: '趋势走稳且评分靠前时买入。',
    sell_logic_label: '趋势转弱、触发退出信号或仓位到期时卖出。',
    risk_note: '交易频率适中，重点看回撤是否稳定。',
    default_hypothesis: '验证稳健趋势模板在近两年自选股池里是否有可观察的稳定收益。',
    default_universe: 'favorites',
    default_initial_capital: 200000,
    default_lookback_years: 2,
    default_candidate_limit: 80,
    default_max_positions: 8,
    default_position_pct: 12,
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
    buy_logic_label: '价格突破区间并有成交确认时买入。',
    sell_logic_label: '突破失效、回落或触发止盈止损时卖出。',
    risk_note: '更依赖行情延续性，震荡市里容易出现来回试错。',
    default_hypothesis: '验证均线突破信号在近两年是否能避开无效震荡并捕捉趋势。',
    default_universe: 'favorites',
    default_initial_capital: 200000,
    default_lookback_years: 2,
    default_candidate_limit: 80,
    default_max_positions: 6,
    default_position_pct: 10,
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
    buy_logic_label: '低波动和质量评分靠前时分散买入。',
    sell_logic_label: '质量评分走弱、组合再平衡或风险约束触发时卖出。',
    risk_note: '节奏慢，适合看长期稳定性，不适合验证短线买点。',
    default_hypothesis: '验证低波价值模板在三年窗口里是否能用更小回撤换取稳健收益。',
    default_universe: 'favorites',
    default_initial_capital: 200000,
    default_lookback_years: 3,
    default_candidate_limit: 120,
    default_max_positions: 10,
    default_position_pct: 10,
    default_benchmark_symbol: 'sh.000300',
  },
];

export function getEasyQuantTemplate(id: EasyQuantTemplateId): EasyQuantTemplate {
  return EASY_QUANT_TEMPLATES.find(item => item.id === id) || EASY_QUANT_TEMPLATES[0];
}

export function buildDefaultEasyQuantRunConfig(template: EasyQuantTemplate): EasyQuantRunConfig {
  return {
    initial_capital: template.default_initial_capital,
    lookback_years: template.default_lookback_years as EasyQuantRunConfig['lookback_years'],
    universe: template.default_universe,
    candidate_limit: template.default_candidate_limit,
    max_positions: template.default_max_positions,
    position_pct: template.default_position_pct,
  };
}

export function buildEasyQuantBacktestPayload(
  template: EasyQuantTemplate,
  hypothesis = template.default_hypothesis,
  runConfig: EasyQuantRunConfig = buildDefaultEasyQuantRunConfig(template)
): CreateBacktestPayload {
  const end = dayjs();
  const start = end.subtract(runConfig.lookback_years, 'year');

  return {
    task_name: `简易版-${template.name}-${end.format('YYYYMMDD-HHmm')}`,
    easy_mode: true,
    template_id: template.id,
    hypothesis,
    universe: runConfig.universe,
    strategy_keys: [template.strategy_key],
    start_date: start.format('YYYY-MM-DD'),
    end_date: end.format('YYYY-MM-DD'),
    initial_capital: runConfig.initial_capital,
    candidate_limit: runConfig.candidate_limit,
    max_positions: runConfig.max_positions,
    position_pct: runConfig.position_pct,
    execution_timing: 'next_open',
    enable_t_plus_one: true,
    benchmark_symbol: template.default_benchmark_symbol,
    data_policy_json: {
      point_in_time: true,
      disclosure_date_required: true,
      missing_policy: 'insufficient',
    },
    constraint_policy_json: {
      market: 'A_SHARE',
      t_plus_one: true,
      block_limit_up: true,
      block_limit_down: true,
      block_suspended: true,
      lot_size: 100,
    },
    async: true,
  };
}
