export const DEFAULT_AUTONOMOUS_INITIAL_CAPITAL = 200000;
export const AUTONOMOUS_PORTFOLIO_NAME = 'Codex自主荐股模拟盘（20W）';
export const QUANT_ONLY_PORTFOLIO_NAME = 'Codex纯量化模拟盘（20W）';
export const QUANT_AGENT_FUSION_PORTFOLIO_NAME = 'Codex量化Agent融合模拟盘（20W）';
export const AGENT_ONLY_PORTFOLIO_NAME = 'Codex Agent独立模拟盘（20W）';
export const PARAM_EXPERIMENT_PORTFOLIO_NAME = 'Codex参数实验模拟盘（20W）';

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
] as const;

export type PaperPortfolioFamily = (typeof PAPER_PORTFOLIO_FAMILIES)[number];
