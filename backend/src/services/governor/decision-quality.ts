/**
 * Decision Quality + Trader Behavior Patterns
 *
 * 书 reference:
 *   Steenbarger, B. (2009). *The Daily Trading Coach.* Wiley.
 *   Steenbarger, B. (2003). *The Psychology of Trading.* Wiley.
 *
 *   Freeman-Shor, L. (2015). *The Art of Execution.* Harriman House.
 *   (Studies 7 distinct trader behaviour patterns based on 1,866 investments)
 *
 *   Narang, R. (2013). *Inside the Black Box: A Simple Guide to Quantitative
 *   and High Frequency Trading.* 2nd ed., Wiley.
 *
 *   Schwager, J. (1989+). *Market Wizards* series. Various editions.
 *
 * **Decision Quality Score (DQS, Steenbarger)**:
 *
 *   PnL ≠ decision quality. Could be:
 *     - 赢了 (PnL > 0) 但破纪律 → BAD quality (luck)
 *     - 输了 (PnL < 0) 但执行正确 → GOOD quality (variance)
 *
 *   DQS = weighted average of:
 *     - Did follow entry plan? (yes=10, no=0)
 *     - Did size match conviction? (5 ratio)
 *     - Did honor stop loss? (yes=10, no=0)
 *     - Did exit per plan or impulse? (5 ratio)
 *     - Recorded thesis pre-trade? (yes=5, no=0)
 *
 * **Freeman-Shor 7 Patterns** (from 1,866 best-fund-manager investments):
 *
 *   *Losers (失败 patterns)*:
 *     1. **Rabbits** (兔子): 持续 average down, 等 mean reversion
 *     2. **Assassins** (刺客): rigid stop loss at fixed % (-20%)
 *     3. **Hunters** (猎人): pre-plan to add more on -10%, -20% pullbacks
 *
 *   *Winners (成功 patterns)*:
 *     4. **Raiders** (袭击者): 5-20% gain → quickly take
 *     5. **Connoisseurs** (鉴赏家): hold winners 6+ months, scale out
 *
 *   Identify trader's behavior pattern → recommend behavioral nudges.
 *
 * **Pre-mortem Framework (Klein 2007 + Steenbarger)**:
 *
 *   Before trade, ask:
 *     - "Assume this trade goes wrong. What's the most likely cause?"
 *     - Identify pre-emptive mitigation
 *     - Set explicit exit conditions
 *
 * **Narang 6-layer quant system (Inside the Black Box)**:
 *
 *   1. Alpha model (signal generation)
 *   2. Risk model (limits)
 *   3. Transaction cost model
 *   4. Portfolio construction (sizing)
 *   5. Execution model (order routing)
 *   6. Data infrastructure
 *
 *   Use to audit own architecture coverage.
 */

// ============================================================
// Decision Quality Score
// ============================================================

export interface DecisionQualityInput {
  followed_entry_plan: boolean;
  sizing_matched_conviction: number; // 0-10
  honored_stop_loss: boolean;
  exited_per_plan: number; // 0-10 (10 = exactly plan, 0 = pure impulse)
  recorded_thesis_pre_trade: boolean;
}

export interface DecisionQualityResult {
  dqs: number; // 0-100
  category: 'excellent' | 'good' | 'fair' | 'poor';
  components: {
    entry_plan: number;
    sizing: number;
    stop_loss: number;
    exit_discipline: number;
    pre_trade_thesis: number;
  };
}

/**
 * Compute Decision Quality Score (0-100).
 *
 * Weighting:
 *   - Entry plan adherence: 25
 *   - Stop loss honored: 25
 *   - Sizing match: 15
 *   - Exit discipline: 20
 *   - Pre-trade thesis: 15
 */
export function computeDecisionQualityScore(input: DecisionQualityInput): DecisionQualityResult {
  const components = {
    entry_plan: input.followed_entry_plan ? 25 : 0,
    stop_loss: input.honored_stop_loss ? 25 : 0,
    sizing: Math.max(0, Math.min(10, input.sizing_matched_conviction)) * 1.5,
    exit_discipline: Math.max(0, Math.min(10, input.exited_per_plan)) * 2,
    pre_trade_thesis: input.recorded_thesis_pre_trade ? 15 : 0,
  };
  const dqs = components.entry_plan + components.stop_loss + components.sizing + components.exit_discipline + components.pre_trade_thesis;
  const category: 'excellent' | 'good' | 'fair' | 'poor' =
    dqs >= 80 ? 'excellent' : dqs >= 60 ? 'good' : dqs >= 40 ? 'fair' : 'poor';
  return { dqs, category, components };
}

/**
 * Combine DQS + PnL into "decision matrix" (Steenbarger).
 *
 *   matrix:                  PnL > 0           PnL ≤ 0
 *     DQS high (≥60)          ✅ true alpha       ⚠️ variance (期望管理)
 *     DQS low (< 60)          ⚠️ luck (危险)       🔴 bad execution + bad outcome
 *
 * 仅追求 PnL > 0 会强化"幸运型"行为, 长期破产.
 */
export function decisionPnlMatrix(dqs: number, pnl: number): 'true_alpha' | 'variance_loss' | 'lucky_win' | 'bad_execution' {
  const dqs_high = dqs >= 60;
  const pnl_positive = pnl > 0;
  if (dqs_high && pnl_positive) return 'true_alpha';
  if (dqs_high && !pnl_positive) return 'variance_loss';
  if (!dqs_high && pnl_positive) return 'lucky_win';
  return 'bad_execution';
}

// ============================================================
// Freeman-Shor 7 Patterns
// ============================================================

export type TraderPattern = 'rabbit' | 'assassin' | 'hunter' | 'raider' | 'connoisseur' | 'inspector' | 'squirrel';

export interface TradeOutcomeForPattern {
  /** Original buy date */
  entry_date: string;
  /** Final exit date (null = still holding) */
  exit_date: string | null;
  /** Original entry price */
  entry_price: number;
  /** Average exit price */
  exit_price: number | null;
  /** Number of times averaged down or added on dips */
  n_add_on_dips: number;
  /** Number of times added on rallies (scaled up) */
  n_add_on_rallies: number;
  /** Days held */
  days_held: number;
  /** Final return pct */
  return_pct: number | null;
  /** Was stop loss explicitly used and respected? */
  used_stop_loss: boolean;
}

/**
 * Classify a trader's pattern based on their trade history.
 *
 * @returns predominant pattern + confidence (0-1)
 */
export function classifyTraderPattern(trades: TradeOutcomeForPattern[]): {
  pattern: TraderPattern;
  confidence: number;
  pattern_scores: Record<TraderPattern, number>;
  recommendation: string;
} {
  if (trades.length === 0) {
    return {
      pattern: 'inspector',
      confidence: 0,
      pattern_scores: { rabbit: 0, assassin: 0, hunter: 0, raider: 0, connoisseur: 0, inspector: 0, squirrel: 0 },
      recommendation: '无数据',
    };
  }

  const scores: Record<TraderPattern, number> = {
    rabbit: 0, assassin: 0, hunter: 0, raider: 0, connoisseur: 0, inspector: 0, squirrel: 0,
  };

  for (const t of trades) {
    // Rabbit: average down频繁, 持仓长, 亏损还加仓
    if (t.n_add_on_dips >= 2 && (t.return_pct ?? 0) < 0) scores.rabbit += 1;

    // Assassin: stop loss 严格, 亏损时间短
    if (t.used_stop_loss && (t.return_pct ?? 0) < 0 && t.days_held < 30) scores.assassin += 1;

    // Hunter: 计划在下跌时加仓 (pre-planned dips)
    if (t.n_add_on_dips === 1 && (t.return_pct ?? 0) > 0) scores.hunter += 1; // 抄底成功

    // Raider: 小额获利就跑 (return 5-20%, days < 30)
    if (t.return_pct !== null && t.return_pct > 0.05 && t.return_pct < 0.2 && t.days_held < 30) scores.raider += 1;

    // Connoisseur: 长期持有 winner, 多次加仓 rally
    if (t.n_add_on_rallies >= 1 && t.days_held >= 180 && (t.return_pct ?? 0) > 0.2) scores.connoisseur += 1;

    // Inspector: 谨慎, 不加仓不减仓
    if (t.n_add_on_dips === 0 && t.n_add_on_rallies === 0 && t.days_held > 60) scores.inspector += 1;

    // Squirrel: 频繁开仓闭仓 (持仓 < 7 天)
    if (t.days_held < 7) scores.squirrel += 1;
  }

  // Normalize
  const max_score = Math.max(...Object.values(scores));
  let best_pattern: TraderPattern = 'inspector';
  for (const [pat, score] of Object.entries(scores)) {
    if (score === max_score && score > 0) {
      best_pattern = pat as TraderPattern;
      break;
    }
  }
  const confidence = max_score / trades.length;

  const recommendations: Record<TraderPattern, string> = {
    rabbit: '⚠️ 你倾向 average down 亏损股 — 高风险. 设硬性 stop loss, 拒绝补仓亏损.',
    assassin: '✅ 严格止损是好习惯. 但小心 "death by 1000 cuts" — 检查是否过早止损了 winner.',
    hunter: '⚠️ Pre-planned 抄底有 trap. 用 ATR-based stop, 不要把抄底变成 average down.',
    raider: '⚠️ 5-20% 就跑容易切短大鱼 (Freeman-Shor 失败 #1). 用 trailing stop 让 winner 跑长.',
    connoisseur: '✅ 持有 winner 长期 + scale up — Freeman-Shor 最佳 pattern. 继续.',
    inspector: '⚠️ 太保守可能错过加仓机会. 看历史 winner 是否应该 scale up.',
    squirrel: '⚠️ 频繁交易 (< 7 天持仓) 摩擦 cost 高. 检查是否真有 alpha.',
  };

  return {
    pattern: best_pattern,
    confidence,
    pattern_scores: scores,
    recommendation: recommendations[best_pattern],
  };
}

// ============================================================
// Pre-mortem Framework
// ============================================================

export interface PreMortemInput {
  thesis: string;
  expected_return_pct: number;
  expected_time_horizon_days: number;
  position_size_pct: number;
  // Pre-mortem questions
  most_likely_failure_cause: string;
  pre_emptive_mitigation: string;
  explicit_exit_conditions: string[];
  // Risk assessment
  worst_case_loss_pct: number;
}

export interface PreMortemResult {
  is_complete: boolean;
  quality_score: number; // 0-100
  recommendation: 'proceed' | 'revisit' | 'reject';
  warnings: string[];
}

/**
 * Score pre-mortem document quality.
 *
 *   - thesis 是否够详细 (>=20 chars): 20
 *   - 失败原因填了: 20
 *   - 缓解措施填了: 20
 *   - 至少 2 个 exit conditions: 20
 *   - worst_case_loss 在合理 (5-25%): 10
 *   - 仓位与时间一致 (大仓位短期 OK; 大仓位长期 risky): 10
 */
export function scorePreMortem(input: PreMortemInput): PreMortemResult {
  const warnings: string[] = [];
  let score = 0;

  if (input.thesis.length >= 20) score += 20;
  else warnings.push('Thesis 描述过简单 (<20 chars), 缺少 detail');

  if (input.most_likely_failure_cause.length > 0) score += 20;
  else warnings.push('未填 most likely failure cause — pre-mortem 关键步骤缺失');

  if (input.pre_emptive_mitigation.length > 0) score += 20;
  else warnings.push('未填 mitigation — 失败时无应对计划');

  if (input.explicit_exit_conditions.length >= 2) score += 20;
  else warnings.push('Exit conditions < 2 — 退出条件不足');

  if (input.worst_case_loss_pct >= 0.05 && input.worst_case_loss_pct <= 0.25) score += 10;
  else if (input.worst_case_loss_pct > 0.25) warnings.push(`Worst-case loss ${(input.worst_case_loss_pct * 100).toFixed(0)}% 过大 — 考虑减仓`);

  if (input.position_size_pct > 0.05 && input.expected_time_horizon_days > 180) {
    warnings.push('大仓位 + 长期 — high concentration risk');
  } else {
    score += 10;
  }

  const recommendation: 'proceed' | 'revisit' | 'reject' =
    score >= 80 ? 'proceed' : score >= 50 ? 'revisit' : 'reject';

  return {
    is_complete: score >= 80,
    quality_score: score,
    recommendation,
    warnings,
  };
}

// ============================================================
// Narang 6-Layer Quant Architecture Audit
// ============================================================

export interface NarangLayerCheck {
  layer: number;
  name: string;
  description: string;
  our_implementation: string[];
  gaps: string[];
}

/**
 * Audit our system vs Narang's 6-layer quant model.
 *
 * Returns coverage analysis for each layer.
 */
export function narangArchitectureAudit(): NarangLayerCheck[] {
  return [
    {
      layer: 1,
      name: 'Alpha Model',
      description: 'Signal generation from data',
      our_implementation: [
        'Strategy library (Multi-Factor Alpha, Dragon Head, Earnings Surprise, ...)',
        'AIInvestmentSignalService (LLM-augmented)',
        'MetaLabelService (v3 signal filter)',
        'GP factor discovery (v4)',
        'Black-Litterman views (v3)',
      ],
      gaps: [
        'Alpha factor decay monitoring (Grinold-Kahn IC decay 已部分覆盖)',
        'Alpha attribution by source 还可深化',
      ],
    },
    {
      layer: 2,
      name: 'Risk Model',
      description: 'Position limits, drawdown control',
      our_implementation: [
        'PositionLimitGuard, DrawdownCircuitBreaker',
        'EquityCurveGovernor (v1 5-tier + v2 Carver continuous)',
        'BlackSwanWatchdog, RestrictedShareWatchdog',
        'IndustryConcentrationGuard',
      ],
      gaps: [
        'Multi-factor risk model 部分 (v4 GK + v6 Fama-French/Barra 待 prod)',
      ],
    },
    {
      layer: 3,
      name: 'Transaction Cost Model',
      description: 'Estimate cost before / after trade',
      our_implementation: [
        'TCA framework (v4) — Perold IS decomposition',
        'Almgren-Chriss linear impact (v2)',
        'Bouchaud sqrt impact (v6)',
        'Kyle/Roll/MRR microstructure (v4)',
      ],
      gaps: [],
    },
    {
      layer: 4,
      name: 'Portfolio Construction',
      description: 'From signals + risk to weights',
      our_implementation: [
        'PortfolioConstructionService (ERC, min-var, max-sharpe, HRP)',
        'Ledoit-Wolf shrinkage cov (v2)',
        'Tikhonov regularization (v4)',
        'OSQP-style QP solver (v5)',
        'Black-Litterman posterior (v3)',
        'Bet Sizing (v7 AFML Ch.10)',
      ],
      gaps: [
        'Multi-period rebalancing optimization (未做)',
        'Robust optimization (parameter uncertainty) (未做)',
      ],
    },
    {
      layer: 5,
      name: 'Execution Model',
      description: 'Order routing, child order placement',
      our_implementation: [
        'ExecutionFeasibilityService (v1 4-component score)',
        'Almgren-Chriss optimal trajectory (v2)',
        'Q-learning execution (v5)',
        'A-share rules (涨跌停, T+1, ST, 停牌)',
      ],
      gaps: [
        'VWAP/TWAP detailed algorithms (待 Sprint 14)',
        'Smart Order Routing (待 Sprint 14)',
        'QMT/PTrade real-time bridge (待 Sprint 18)',
      ],
    },
    {
      layer: 6,
      name: 'Data Infrastructure',
      description: 'Real-time + historical data pipeline',
      our_implementation: [
        'PostgreSQL + Sequelize ORM',
        'AKShare data sources',
        'DailyBar, RealtimeQuote, FactorScore tables',
        'DataHealthStatusService monitoring',
      ],
      gaps: [
        'Tick-level data (HFT 用) — 不需要 (我们是日级)',
        'Information-driven bars (v3) — implemented but not in main pipeline',
      ],
    },
  ];
}

/**
 * Aggregate coverage score.
 *
 *   For each layer: coverage = implementations / (implementations + gaps)
 *   Overall coverage = avg across layers
 */
export function narangCoverageScore(audit: NarangLayerCheck[] = narangArchitectureAudit()): {
  overall_coverage_pct: number;
  per_layer: Array<{ layer: number; name: string; coverage_pct: number; gap_count: number }>;
} {
  const per_layer = audit.map(l => {
    const impl = l.our_implementation.length;
    const gaps = l.gaps.length;
    const coverage = impl + gaps > 0 ? (impl / (impl + gaps)) * 100 : 100;
    return { layer: l.layer, name: l.name, coverage_pct: coverage, gap_count: gaps };
  });
  const overall = per_layer.reduce((s, l) => s + l.coverage_pct, 0) / per_layer.length;
  return { overall_coverage_pct: overall, per_layer };
}
