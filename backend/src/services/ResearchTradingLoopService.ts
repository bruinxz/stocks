import { Op, QueryTypes, Transaction } from 'sequelize';
import sequelize from '../config/database';
import {
  AIInvestmentSignal,
  AISignalDecision,
  AISignalSourceType,
} from '../models/AIInvestmentSignal';
import { AiRecommendationItem } from '../models/AiRecommendationItem';
import { AiRecommendationSnapshot } from '../models/AiRecommendationSnapshot';
import { PaperTradingPortfolio } from '../models/PaperTradingPortfolio';
import { PaperTradingPosition } from '../models/PaperTradingPosition';
import { PaperTradingSnapshot } from '../models/PaperTradingSnapshot';
import { PaperTradingTrade } from '../models/PaperTradingTrade';
import { RealtimeQuote } from '../models/RealtimeQuote';
import { Stock } from '../models/Stock';
import { logger } from '../utils/logger';
import { normalizeSymbol } from '../utils/stockSymbol';
import { getEast8DateString } from '../utils/timezone';
import { checkAShareTradingHours } from '../utils/tradingCalendar';
import { expectedCompletedTradeDate } from './PageFreshnessService';

export const RESEARCH_LOOP_PORTFOLIO_NAME = '研究闭环模拟盘';
export const RESEARCH_LOOP_INITIAL_CAPITAL = 200000;
export const RESEARCH_LOOP_MAX_POSITIONS = 6;
export const RESEARCH_LOOP_HARD_STOP_PCT = 8;

export type ResearchLoopAction = 'BUY' | 'HOLD' | 'SELL';

export interface ResearchCandidateSource {
  source: 'morning_brief' | 'multibagger';
  source_id: string;
  score: number;
  rating: string | null;
  risk_gate_status: string;
  rank?: number;
  stage?: string;
  conclusion?: string;
}

export interface ResearchLoopCandidate {
  symbol: string;
  name: string;
  sources: ResearchCandidateSource[];
  combined_score: number;
  target_weight_pct: number;
}

export interface ResearchBundle {
  expected_research_day: string;
  morning: {
    snapshot_id: string | null;
    research_day: string | null;
    as_of: string | null;
    candidates: ResearchCandidateSourceRow[];
  };
  multibagger: {
    as_of: string | null;
    research_day: string | null;
    candidates: ResearchCandidateSourceRow[];
  };
}

export interface ResearchCandidateSourceRow {
  source_id: string;
  symbol: string;
  name: string;
  score: number;
  rating: string | null;
  risk_gate_status: string;
  size_hint_tier?: string;
  rank?: number;
  stage?: string;
  conclusion?: string;
}

export interface ResearchLoopPositionRow {
  id: number;
  symbol: string;
  name: string;
  quantity: number;
  avg_cost: number;
  current_price: number;
  created_at: Date;
}

export interface ResearchLoopDecision {
  symbol: string;
  name: string;
  action: ResearchLoopAction;
  combined_score: number | null;
  target_weight_pct: number | null;
  sources: ResearchCandidateSource[];
  reason: string;
}

export interface ResearchLoopPrice {
  symbol: string;
  name: string;
  price: number;
  quote_time: Date;
  trade_date: string;
}

export interface ResearchLoopPortfolioRow {
  id: number;
  user_id: number;
  name: string;
  initial_capital: number;
  current_cash: number;
  total_value: number;
}

export interface ResearchLoopRunRow {
  id: number;
  user_id: number;
  portfolio_id: number;
  trading_day: string;
  research_day: string;
  status: string;
}

export interface ResearchTradingLoopRepository {
  ensureLoopPortfolios(): Promise<void>;
  loadLoopPortfolios(user_id?: number): Promise<ResearchLoopPortfolioRow[]>;
  loadResearchBundle(now: Date): Promise<ResearchBundle>;
  loadPositions(portfolio_id: number): Promise<ResearchLoopPositionRow[]>;
  loadPrices(symbols: string[], trading_day: string): Promise<Map<string, ResearchLoopPrice>>;
  claimRun(input: {
    portfolio: ResearchLoopPortfolioRow;
    trading_day: string;
    research_day: string;
    bundle: ResearchBundle;
  }): Promise<ResearchLoopRunRow | null>;
  executeDecision(input: {
    run: ResearchLoopRunRow;
    portfolio: ResearchLoopPortfolioRow;
    decision: ResearchLoopDecision;
    price: ResearchLoopPrice | null;
  }): Promise<{ status: string; trade_id?: number; signal_id?: number; quantity?: number }>;
  markToMarket(
    portfolio_id: number,
    prices: Map<string, ResearchLoopPrice>,
    trading_day: string
  ): Promise<void>;
  completeRun(
    run_id: number,
    status: 'completed' | 'failed' | 'skipped',
    summary: Record<string, unknown>
  ): Promise<void>;
  loadDashboard(user_id: number): Promise<Record<string, unknown> | null>;
}

export function canSellPositionOnTradingDay(created_at: Date, trading_day: string): boolean {
  return getEast8DateString(created_at) < trading_day;
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

function finite(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sourceIsEligible(source: ResearchCandidateSourceRow): boolean {
  if (String(source.risk_gate_status || '').toUpperCase() !== 'GREEN') return false;
  if (source.size_hint_tier === 'SKIP') return false;
  if (source.conclusion === 'SKIP') return false;
  return true;
}

function sourceWeight(sources: ResearchCandidateSource[]): number {
  const names = new Set(sources.map(source => source.source));
  if (names.size > 1) return 12;
  return names.has('morning_brief') ? 9 : 6;
}

/**
 * 合并两个研究源并生成每日目标池。两个源同时命中时优先，避免“各看各的”。
 * 高倍潜力是长周期研究，单独命中时用 0.9 可靠度折扣；共同命中额外 +5 分。
 */
export function mergeResearchCandidates(bundle: ResearchBundle): ResearchLoopCandidate[] {
  const merged = new Map<string, ResearchLoopCandidate>();
  const add = (source: 'morning_brief' | 'multibagger', row: ResearchCandidateSourceRow) => {
    if (!sourceIsEligible(row)) return;
    const symbol = normalizeSymbol(row.symbol);
    if (!symbol) return;
    const current = merged.get(symbol) || {
      symbol,
      name: row.name || symbol,
      sources: [],
      combined_score: 0,
      target_weight_pct: 0,
    };
    current.name = current.name === current.symbol && row.name ? row.name : current.name;
    current.sources.push({
      source,
      source_id: row.source_id,
      score: row.score,
      rating: row.rating,
      risk_gate_status: row.risk_gate_status,
      rank: row.rank,
      stage: row.stage,
      conclusion: row.conclusion,
    });
    merged.set(symbol, current);
  };
  bundle.morning.candidates.forEach(row => add('morning_brief', row));
  bundle.multibagger.candidates.forEach(row => add('multibagger', row));

  for (const candidate of merged.values()) {
    const morning = candidate.sources.find(source => source.source === 'morning_brief');
    const multibagger = candidate.sources.find(source => source.source === 'multibagger');
    candidate.combined_score = Math.min(
      100,
      Math.round(
        (morning && multibagger
          ? morning.score * 0.65 + multibagger.score * 0.35 + 5
          : morning
          ? morning.score
          : finite(multibagger?.score) * 0.9) * 100
      ) / 100
    );
    candidate.target_weight_pct = sourceWeight(candidate.sources);
  }
  return [...merged.values()].sort((a, b) => {
    const sourceDiff = b.sources.length - a.sources.length;
    if (sourceDiff !== 0) return sourceDiff;
    const scoreDiff = b.combined_score - a.combined_score;
    return scoreDiff !== 0 ? scoreDiff : a.symbol.localeCompare(b.symbol);
  });
}

export function buildResearchLoopDecisions(input: {
  bundle: ResearchBundle;
  positions: ResearchLoopPositionRow[];
  prices: Map<string, ResearchLoopPrice>;
  max_positions?: number;
  hard_stop_pct?: number;
}): ResearchLoopDecision[] {
  const maxPositions = input.max_positions || RESEARCH_LOOP_MAX_POSITIONS;
  const hardStopPct = input.hard_stop_pct || RESEARCH_LOOP_HARD_STOP_PCT;
  const candidates = mergeResearchCandidates(input.bundle);
  const bySymbol = new Map(candidates.map(candidate => [candidate.symbol, candidate]));
  const target = new Set(candidates.slice(0, maxPositions).map(candidate => candidate.symbol));
  const positions = new Map(
    input.positions.map(position => [normalizeSymbol(position.symbol), position])
  );
  const decisions: ResearchLoopDecision[] = [];

  for (const position of input.positions) {
    const symbol = normalizeSymbol(position.symbol);
    const candidate = bySymbol.get(symbol);
    const price = input.prices.get(symbol)?.price || finite(position.current_price);
    const lossPct =
      position.avg_cost > 0 && price > 0
        ? ((price - position.avg_cost) / position.avg_cost) * 100
        : 0;
    if (lossPct <= -hardStopPct) {
      decisions.push({
        symbol,
        name: position.name || symbol,
        action: 'SELL',
        combined_score: candidate?.combined_score ?? null,
        target_weight_pct: 0,
        sources: candidate?.sources || [],
        reason: `硬止损：当前收益 ${lossPct.toFixed(2)}% ≤ -${hardStopPct}%`,
      });
    } else if (!candidate) {
      decisions.push({
        symbol,
        name: position.name || symbol,
        action: 'SELL',
        combined_score: null,
        target_weight_pct: 0,
        sources: [],
        reason: 'A股早报与高倍潜力今日均不再支持，退出目标池',
      });
    } else if (!target.has(symbol)) {
      decisions.push({
        symbol,
        name: position.name || candidate.name,
        action: 'SELL',
        combined_score: candidate.combined_score,
        target_weight_pct: 0,
        sources: candidate.sources,
        reason: `联合评分 ${candidate.combined_score.toFixed(
          1
        )} 已跌出前 ${maxPositions} 名保留区间`,
      });
    } else {
      decisions.push({
        symbol,
        name: position.name || candidate.name,
        action: 'HOLD',
        combined_score: candidate.combined_score,
        target_weight_pct: candidate.target_weight_pct,
        sources: candidate.sources,
        reason: `${candidate.sources.length} 个研究源继续支持，保持持仓`,
      });
    }
  }

  for (const candidate of candidates.slice(0, maxPositions)) {
    if (positions.has(candidate.symbol) || !target.has(candidate.symbol)) continue;
    decisions.push({
      symbol: candidate.symbol,
      name: candidate.name,
      action: 'BUY',
      combined_score: candidate.combined_score,
      target_weight_pct: candidate.target_weight_pct,
      sources: candidate.sources,
      reason:
        candidate.sources.length > 1
          ? `A股早报与高倍潜力共同命中，联合评分 ${candidate.combined_score.toFixed(1)}`
          : `${
              candidate.sources[0].source === 'morning_brief' ? 'A股早报' : '高倍潜力'
            }新进入目标池，评分 ${candidate.combined_score.toFixed(1)}`,
    });
  }

  return decisions.sort((a, b) => {
    const order: Record<ResearchLoopAction, number> = { SELL: 0, HOLD: 1, BUY: 2 };
    return order[a.action] - order[b.action] || a.symbol.localeCompare(b.symbol);
  });
}

export class SequelizeResearchTradingLoopRepository implements ResearchTradingLoopRepository {
  async ensureLoopPortfolios(): Promise<void> {
    await sequelize.query(
      `INSERT INTO paper_trading_portfolios (
         user_id, name, initial_capital, current_cash, total_value, is_active,
         description, strategy_keys, enabled_factors, risk_profile_overrides,
         auto_trade_enabled, portfolio_type, created_at, updated_at
       )
       SELECT u.id, :name, :capital, :capital, :capital, TRUE,
              'A股早报 + 高倍潜力每日联合决策；只由研究闭环执行器维护。',
              '[]'::jsonb, '[]'::jsonb,
              '{"max_positions":6,"max_single_weight_pct":12,"hard_stop_loss_pct":8}'::jsonb,
              TRUE, 'research_loop', NOW(), NOW()
         FROM users u
        WHERE NOT EXISTS (
          SELECT 1 FROM paper_trading_portfolios p
           WHERE p.user_id = u.id AND p.portfolio_type = 'research_loop' AND p.is_active = TRUE
        )
       ON CONFLICT DO NOTHING`,
      {
        replacements: {
          name: RESEARCH_LOOP_PORTFOLIO_NAME,
          capital: RESEARCH_LOOP_INITIAL_CAPITAL,
        },
      }
    );
  }

  async loadLoopPortfolios(user_id?: number): Promise<ResearchLoopPortfolioRow[]> {
    const where: any = { is_active: true, portfolio_type: 'research_loop' };
    if (user_id) where.user_id = user_id;
    const rows = await PaperTradingPortfolio.findAll({ where, order: [['id', 'ASC']] });
    return rows.map(row => ({
      id: row.id,
      user_id: row.user_id,
      name: row.name,
      initial_capital: finite(row.initial_capital),
      current_cash: finite(row.current_cash),
      total_value: finite(row.total_value),
    }));
  }

  async loadResearchBundle(now: Date): Promise<ResearchBundle> {
    const expected = expectedCompletedTradeDate(now);
    const snapshot = await AiRecommendationSnapshot.findOne({
      where: { profile: 'us_preferred', marketScope: 'cn_a', asOfUtc: { [Op.lte]: now } },
      order: [
        ['tradingDay', 'DESC'],
        ['asOfUtc', 'DESC'],
      ],
    });
    const morningItems = snapshot
      ? await AiRecommendationItem.findAll({
          where: { snapshotId: snapshot.snapshotId },
          order: [['sortRank', 'ASC']],
        })
      : [];

    const multiRows = await sequelize.query<any>(
      `WITH latest_batch AS (
         SELECT MAX(as_of_utc) AS as_of_utc
           FROM multibagger_candidate_snapshot
          WHERE market_scope = 'cn_a' AND available_at_utc <= :now
       )
       SELECT c.multibagger_candidate_snapshot_id AS source_id,
              c.ticker AS symbol,
              COALESCE(u.fundamental_snapshot->>'name', u.features->>'name', c.ticker) AS name,
              COALESCE((c.score->>'total')::numeric, 0) AS score,
              c.rating,
              COALESCE(c.risk_gate->>'gate', 'UNKNOWN') AS risk_gate_status,
              c.stage,
              c.conclusion,
              c.as_of_utc,
              regexp_replace(u.source_version, '^live-', '') AS research_day
         FROM multibagger_candidate_snapshot c
         JOIN latest_batch batch ON batch.as_of_utc = c.as_of_utc
         LEFT JOIN LATERAL (
           SELECT source_version, features, fundamental_snapshot
             FROM multibagger_universe source
            WHERE source.market_scope = c.market_scope
              AND source.exchange = c.exchange
              AND source.ticker = c.ticker
              AND c.source_fact_hashes ? source.fact_hash
            ORDER BY source.available_at_utc DESC, source.created_at DESC
            LIMIT 1
         ) u ON TRUE
        WHERE c.market_scope = 'cn_a'
        ORDER BY COALESCE((c.score->>'total')::numeric, 0) DESC, c.ticker ASC`,
      { replacements: { now }, type: QueryTypes.SELECT }
    );
    const names = await this.loadNames([
      ...morningItems.map(item => normalizeSymbol(item.ticker)),
      ...multiRows.map(row => normalizeSymbol(row.symbol)),
    ]);
    const multiResearchDay = multiRows[0]?.research_day || null;
    return {
      expected_research_day: expected,
      morning: {
        snapshot_id: snapshot?.snapshotId || null,
        research_day: snapshot?.tradingDay || null,
        as_of: snapshot?.asOfUtc?.toISOString() || null,
        candidates: morningItems.map(item => ({
          source_id: item.itemId,
          symbol: normalizeSymbol(item.ticker),
          name: names.get(normalizeSymbol(item.ticker)) || item.ticker,
          score: finite(record(item.recommendationJson).score?.total, finite(item.convictionFinal)),
          rating: item.ratingBand,
          risk_gate_status: item.riskGateStatus,
          size_hint_tier: item.sizeHintTier,
          rank: item.sortRank,
        })),
      },
      multibagger: {
        as_of: multiRows[0]?.as_of_utc ? new Date(multiRows[0].as_of_utc).toISOString() : null,
        research_day: multiResearchDay,
        candidates: multiRows.map(row => ({
          source_id: String(row.source_id),
          symbol: normalizeSymbol(row.symbol),
          name: names.get(normalizeSymbol(row.symbol)) || row.name || row.symbol,
          score: finite(row.score),
          rating: row.rating || null,
          risk_gate_status: row.risk_gate_status,
          stage: row.stage,
          conclusion: row.conclusion,
        })),
      },
    };
  }

  private async loadNames(symbols: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(symbols.filter(Boolean))];
    if (!unique.length) return new Map();
    const stocks = await Stock.findAll({ where: { symbol: { [Op.in]: unique } } });
    return new Map(stocks.map(stock => [normalizeSymbol(stock.symbol), stock.name]));
  }

  async loadPositions(portfolio_id: number): Promise<ResearchLoopPositionRow[]> {
    const rows = await PaperTradingPosition.findAll({
      where: { portfolio_id, quantity: { [Op.gt]: 0 } },
      order: [['symbol', 'ASC']],
    });
    return rows.map(row => ({
      id: row.id,
      symbol: normalizeSymbol(row.symbol),
      name: row.name,
      quantity: finite(row.quantity),
      avg_cost: finite(row.avg_cost),
      current_price: finite(row.current_price),
      created_at: row.created_at,
    }));
  }

  async loadPrices(
    symbols: string[],
    trading_day: string
  ): Promise<Map<string, ResearchLoopPrice>> {
    const unique = [...new Set(symbols.map(normalizeSymbol).filter(Boolean))];
    if (!unique.length) return new Map();
    const rows = await RealtimeQuote.findAll({
      where: { symbol: { [Op.in]: unique }, trade_date: trading_day },
      order: [['quote_time', 'DESC']],
    });
    const prices = new Map<string, ResearchLoopPrice>();
    for (const row of rows) {
      const symbol = normalizeSymbol(row.symbol);
      const price = finite(row.current_price);
      if (!prices.has(symbol) && price > 0) {
        prices.set(symbol, {
          symbol,
          name: row.name || symbol,
          price,
          quote_time: row.quote_time,
          trade_date: row.trade_date,
        });
      }
    }
    return prices;
  }

  async claimRun(input: {
    portfolio: ResearchLoopPortfolioRow;
    trading_day: string;
    research_day: string;
    bundle: ResearchBundle;
  }): Promise<ResearchLoopRunRow | null> {
    const rows = await sequelize.query<ResearchLoopRunRow>(
      `INSERT INTO research_trading_loop_runs (
         user_id, portfolio_id, trading_day, research_day, status,
         morning_snapshot_id, multibagger_as_of, started_at, created_at, updated_at
       ) VALUES (
         :user_id, :portfolio_id, :trading_day, :research_day, 'running',
         :morning_snapshot_id, :multibagger_as_of, NOW(), NOW(), NOW()
       )
       ON CONFLICT (user_id, trading_day) DO UPDATE
         SET status = 'running', portfolio_id = EXCLUDED.portfolio_id,
             research_day = EXCLUDED.research_day,
             morning_snapshot_id = EXCLUDED.morning_snapshot_id,
             multibagger_as_of = EXCLUDED.multibagger_as_of,
             started_at = NOW(), completed_at = NULL, updated_at = NOW()
       WHERE research_trading_loop_runs.status IN ('failed', 'skipped')
       RETURNING id, user_id, portfolio_id, trading_day, research_day, status`,
      {
        replacements: {
          user_id: input.portfolio.user_id,
          portfolio_id: input.portfolio.id,
          trading_day: input.trading_day,
          research_day: input.research_day,
          morning_snapshot_id: input.bundle.morning.snapshot_id,
          multibagger_as_of: input.bundle.multibagger.as_of,
        },
        type: QueryTypes.SELECT,
      }
    );
    return rows[0] || null;
  }

  async executeDecision(input: {
    run: ResearchLoopRunRow;
    portfolio: ResearchLoopPortfolioRow;
    decision: ResearchLoopDecision;
    price: ResearchLoopPrice | null;
  }): Promise<{ status: string; trade_id?: number; signal_id?: number; quantity?: number }> {
    const signal = await this.upsertSignal(input);
    const decisionId = await this.insertDecision(input, signal.id);
    if (input.decision.action === 'HOLD') {
      await this.updateDecision(decisionId, { status: 'held' });
      return { status: 'held', signal_id: signal.id };
    }
    if (!input.price || Date.now() - input.price.quote_time.getTime() > 30 * 60_000) {
      await this.updateDecision(decisionId, {
        status: 'skipped',
        metadata: { skip_reason: 'fresh_realtime_quote_missing' },
      });
      return { status: 'skipped', signal_id: signal.id };
    }

    try {
      const execution = await sequelize.transaction(async transaction =>
        input.decision.action === 'SELL'
          ? this.executeSell(input, signal.id, transaction)
          : this.executeBuy(input, signal.id, transaction)
      );
      await this.updateDecision(decisionId, {
        status: execution.status,
        trade_id: execution.trade_id,
        quantity: execution.quantity,
        reference_price: input.price.price,
        metadata: execution.metadata || {},
      });
      return { ...execution, signal_id: signal.id };
    } catch (error: any) {
      await this.updateDecision(decisionId, {
        status: 'failed',
        reference_price: input.price.price,
        metadata: { error: error?.message || String(error) },
      });
      logger.warn(
        `[ResearchTradingLoop] ${input.decision.action} ${input.decision.symbol} failed: ${
          error?.message || error
        }`
      );
      return { status: 'failed', signal_id: signal.id };
    }
  }

  private async upsertSignal(input: {
    run: ResearchLoopRunRow;
    portfolio: ResearchLoopPortfolioRow;
    decision: ResearchLoopDecision;
    price: ResearchLoopPrice | null;
  }) {
    const decision = input.decision;
    const normalized =
      decision.action === 'BUY'
        ? AISignalDecision.BUY
        : decision.action === 'SELL'
        ? AISignalDecision.SELL
        : AISignalDecision.HOLD;
    const payload: any = {
      source_type: AISignalSourceType.RESEARCH_LOOP,
      source_id: `${input.run.trading_day}:${input.portfolio.id}:${decision.symbol}:${decision.action}`,
      loop_run_id: `research-loop-${input.run.id}`,
      symbol: decision.symbol,
      name: decision.name,
      signal_date: input.run.trading_day,
      decision: decision.reason,
      normalized_decision: normalized,
      confidence_score: decision.combined_score,
      risk_level: decision.action === 'SELL' ? 'medium' : 'low',
      rationale: decision.reason,
      current_price: input.price?.price || null,
      action: decision.action,
      metadata: {
        canonical_source: true,
        portfolio_id: input.portfolio.id,
        target_weight_pct: decision.target_weight_pct,
        sources: decision.sources,
        research_day: input.run.research_day,
        trading_day: input.run.trading_day,
      },
    };
    const [signal, created] = await AIInvestmentSignal.findOrCreate({
      where: { source_type: payload.source_type, source_id: payload.source_id },
      defaults: payload,
    });
    if (!created) await signal.update(payload);
    return signal;
  }

  private async insertDecision(input: any, signal_id: number): Promise<number> {
    const rows = await sequelize.query<{ id: number }>(
      `INSERT INTO research_trading_loop_decisions (
         run_id, portfolio_id, signal_id, symbol, name, action, status,
         combined_score, target_weight_pct, sources, reason, metadata, created_at, updated_at
       ) VALUES (
         :run_id, :portfolio_id, :signal_id, :symbol, :name, :action, 'planned',
         :combined_score, :target_weight_pct, CAST(:sources AS jsonb), :reason,
         CAST(:metadata AS jsonb), NOW(), NOW()
       )
       ON CONFLICT (run_id, symbol) DO UPDATE
         SET signal_id = EXCLUDED.signal_id, action = EXCLUDED.action, status = 'planned',
             combined_score = EXCLUDED.combined_score,
             target_weight_pct = EXCLUDED.target_weight_pct, sources = EXCLUDED.sources,
             reason = EXCLUDED.reason, metadata = EXCLUDED.metadata, updated_at = NOW()
       RETURNING id`,
      {
        replacements: {
          run_id: input.run.id,
          portfolio_id: input.portfolio.id,
          signal_id,
          symbol: input.decision.symbol,
          name: input.decision.name,
          action: input.decision.action,
          combined_score: input.decision.combined_score,
          target_weight_pct: input.decision.target_weight_pct,
          sources: JSON.stringify(input.decision.sources),
          reason: input.decision.reason,
          metadata: JSON.stringify({}),
        },
        type: QueryTypes.SELECT,
      }
    );
    return rows[0].id;
  }

  private async updateDecision(id: number, patch: Record<string, any>): Promise<void> {
    const fields: string[] = [`updated_at = NOW()`];
    const replacements: Record<string, any> = { id };
    for (const key of ['status', 'trade_id', 'quantity', 'reference_price']) {
      if (patch[key] !== undefined) {
        fields.push(`${key} = :${key}`);
        replacements[key] = patch[key];
      }
    }
    if (patch.metadata !== undefined) {
      fields.push('metadata = CAST(:metadata AS jsonb)');
      replacements.metadata = JSON.stringify(patch.metadata);
    }
    await sequelize.query(
      `UPDATE research_trading_loop_decisions SET ${fields.join(', ')} WHERE id = :id`,
      { replacements }
    );
  }

  private async executeBuy(input: any, signal_id: number, transaction: Transaction) {
    const portfolio = await PaperTradingPortfolio.findByPk(input.portfolio.id, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!portfolio) throw new Error('研究闭环模拟盘不存在');
    const existing = await PaperTradingPosition.findOne({
      where: { portfolio_id: portfolio.id, symbol: input.decision.symbol },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (existing?.quantity > 0) return { status: 'held', quantity: existing.quantity };
    const price = input.price.price;
    const executePrice = price * 1.001;
    const targetAmount =
      (finite(portfolio.total_value) * finite(input.decision.target_weight_pct)) / 100;
    const quantity = Math.floor(targetAmount / executePrice / 100) * 100;
    if (quantity < 100) return { status: 'skipped', metadata: { skip_reason: 'below_one_lot' } };
    const amount = executePrice * quantity;
    const commission = Math.max(5, amount * 0.0003);
    const transferFee = amount * 0.00001;
    const totalCost = amount + commission + transferFee;
    if (finite(portfolio.current_cash) < totalCost) {
      return { status: 'skipped', metadata: { skip_reason: 'insufficient_cash' } };
    }
    const avgCost = totalCost / quantity;
    const position = await PaperTradingPosition.create(
      {
        portfolio_id: portfolio.id,
        symbol: input.decision.symbol,
        name: input.decision.name,
        quantity,
        avg_cost: avgCost,
        current_price: price,
        market_value: price * quantity,
        unrealized_pnl: (price - avgCost) * quantity,
        stop_loss_price: avgCost * (1 - RESEARCH_LOOP_HARD_STOP_PCT / 100),
        take_profit_price: null,
        highest_price: avgCost,
        trailing_stop_pct: null,
        trailing_stop_price: null,
      } as any,
      { transaction }
    );
    const trade = await PaperTradingTrade.create(
      {
        portfolio_id: portfolio.id,
        symbol: input.decision.symbol,
        name: input.decision.name,
        direction: 'BUY',
        execute_price: executePrice,
        quantity,
        amount,
        commission: commission + transferFee,
        realized_pnl: null,
        trade_reason: {
          source: 'research_loop',
          signal_id,
          evidence: input.decision.sources,
          key_reasons: [input.decision.reason],
          target_weight_pct: input.decision.target_weight_pct,
        },
        trade_reason_summary: `研究闭环买入 · ${input.decision.reason}`,
      } as any,
      { transaction }
    );
    portfolio.current_cash = finite(portfolio.current_cash) - totalCost;
    await portfolio.save({ transaction });
    return { status: 'executed', trade_id: trade.id, quantity: position.quantity };
  }

  private async executeSell(input: any, signal_id: number, transaction: Transaction) {
    const portfolio = await PaperTradingPortfolio.findByPk(input.portfolio.id, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!portfolio) throw new Error('研究闭环模拟盘不存在');
    const position = await PaperTradingPosition.findOne({
      where: { portfolio_id: portfolio.id, symbol: input.decision.symbol },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!position || position.quantity <= 0) {
      return { status: 'skipped', metadata: { skip_reason: 'position_missing' } };
    }
    if (!canSellPositionOnTradingDay(position.created_at, input.run.trading_day)) {
      return { status: 'skipped', metadata: { skip_reason: 't_plus_1' } };
    }
    const quantity = finite(position.quantity);
    const executePrice = input.price.price * (1 - 0.001);
    const amount = executePrice * quantity;
    const commission = Math.max(5, amount * 0.0003);
    const transferFee = amount * 0.00001;
    const stampDuty = amount * 0.0005;
    const totalFees = commission + transferFee + stampDuty;
    const netRevenue = amount - totalFees;
    const realizedPnl = netRevenue - finite(position.avg_cost) * quantity;
    const trade = await PaperTradingTrade.create(
      {
        portfolio_id: portfolio.id,
        symbol: input.decision.symbol,
        name: position.name || input.decision.name,
        direction: 'SELL',
        execute_price: executePrice,
        quantity,
        amount,
        commission: totalFees,
        realized_pnl: realizedPnl,
        trade_reason: {
          source: 'research_loop',
          signal_id,
          evidence: input.decision.sources,
          key_reasons: [input.decision.reason],
          risk_trigger: input.decision.reason.startsWith('硬止损') ? 'hard_stop' : undefined,
        },
        trade_reason_summary: `研究闭环卖出 · ${input.decision.reason}`,
      } as any,
      { transaction }
    );
    portfolio.current_cash = finite(portfolio.current_cash) + netRevenue;
    await portfolio.save({ transaction });
    await position.destroy({ transaction });
    return { status: 'executed', trade_id: trade.id, quantity };
  }

  async markToMarket(
    portfolio_id: number,
    prices: Map<string, ResearchLoopPrice>,
    trading_day: string
  ): Promise<void> {
    await sequelize.transaction(async transaction => {
      const portfolio = await PaperTradingPortfolio.findByPk(portfolio_id, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!portfolio) return;
      const positions = await PaperTradingPosition.findAll({
        where: { portfolio_id, quantity: { [Op.gt]: 0 } },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      let positionValue = 0;
      for (const position of positions) {
        const price =
          prices.get(normalizeSymbol(position.symbol))?.price || finite(position.current_price);
        const marketValue = price * finite(position.quantity);
        position.current_price = price;
        position.market_value = marketValue;
        position.unrealized_pnl = (price - finite(position.avg_cost)) * finite(position.quantity);
        await position.save({ transaction });
        positionValue += marketValue;
      }
      portfolio.total_value = finite(portfolio.current_cash) + positionValue;
      await portfolio.save({ transaction });
      await PaperTradingSnapshot.upsert(
        {
          portfolio_id,
          date: trading_day,
          total_value: portfolio.total_value,
          current_cash: portfolio.current_cash,
          position_value: positionValue,
        } as any,
        { transaction }
      );
    });
  }

  async completeRun(
    run_id: number,
    status: 'completed' | 'failed' | 'skipped',
    summary: Record<string, unknown>
  ): Promise<void> {
    await sequelize.query(
      `UPDATE research_trading_loop_runs
          SET status = :status,
              target_count = :target_count,
              buy_count = :buy_count,
              hold_count = :hold_count,
              sell_count = :sell_count,
              skipped_count = :skipped_count,
              summary = CAST(:summary AS jsonb),
              completed_at = NOW(), updated_at = NOW()
        WHERE id = :run_id`,
      {
        replacements: {
          run_id,
          status,
          target_count: finite(summary.target_count),
          buy_count: finite(summary.buy_count),
          hold_count: finite(summary.hold_count),
          sell_count: finite(summary.sell_count),
          skipped_count: finite(summary.skipped_count),
          summary: JSON.stringify(summary),
        },
      }
    );
  }

  async loadDashboard(user_id: number): Promise<Record<string, unknown> | null> {
    const rows = await sequelize.query<any>(
      `SELECT r.*, p.name AS portfolio_name, p.total_value, p.current_cash,
              COALESCE((
                SELECT jsonb_agg(to_jsonb(d) ORDER BY
                  CASE d.action WHEN 'SELL' THEN 0 WHEN 'BUY' THEN 1 ELSE 2 END,
                  d.combined_score DESC NULLS LAST, d.symbol)
                  FROM research_trading_loop_decisions d WHERE d.run_id = r.id
              ), '[]'::jsonb) AS decisions
         FROM research_trading_loop_runs r
         JOIN paper_trading_portfolios p ON p.id = r.portfolio_id
        WHERE r.user_id = :user_id
        ORDER BY r.trading_day DESC, r.id DESC LIMIT 1`,
      { replacements: { user_id }, type: QueryTypes.SELECT }
    );
    return rows[0] || null;
  }
}

export class ResearchTradingLoopService {
  constructor(
    private readonly repository: ResearchTradingLoopRepository = new SequelizeResearchTradingLoopRepository()
  ) {}

  async run(options: { user_id?: number; now?: Date } = {}) {
    const now = options.now || new Date();
    const tradingDay = getEast8DateString(now);
    const marketHours = checkAShareTradingHours(now);
    if (!marketHours.allowed) {
      return {
        trading_day: tradingDay,
        status: 'skipped',
        reason: 'market_closed',
        message: marketHours.reason,
        users: [],
      };
    }
    await this.repository.ensureLoopPortfolios();
    const bundle = await this.repository.loadResearchBundle(now);
    const fresh =
      bundle.morning.research_day === bundle.expected_research_day &&
      bundle.multibagger.research_day === bundle.expected_research_day;
    if (!fresh) {
      return {
        trading_day: tradingDay,
        expected_research_day: bundle.expected_research_day,
        status: 'skipped',
        reason: 'research_not_fresh',
        morning_research_day: bundle.morning.research_day,
        multibagger_research_day: bundle.multibagger.research_day,
        users: [],
      };
    }
    const portfolios = await this.repository.loadLoopPortfolios(options.user_id);
    const allSymbols = [
      ...bundle.morning.candidates.map(row => row.symbol),
      ...bundle.multibagger.candidates.map(row => row.symbol),
    ];
    const users: any[] = [];
    for (const portfolio of portfolios) {
      const positions = await this.repository.loadPositions(portfolio.id);
      const symbols = [...allSymbols, ...positions.map(position => position.symbol)];
      const prices = await this.repository.loadPrices(symbols, tradingDay);
      const run = await this.repository.claimRun({
        portfolio,
        trading_day: tradingDay,
        research_day: bundle.expected_research_day,
        bundle,
      });
      if (!run) {
        users.push({ user_id: portfolio.user_id, portfolio_id: portfolio.id, status: 'deduped' });
        continue;
      }
      const decisions = buildResearchLoopDecisions({ bundle, positions, prices });
      const outcomes: any[] = [];
      try {
        for (const decision of decisions) {
          outcomes.push({
            ...decision,
            ...(await this.repository.executeDecision({
              run,
              portfolio,
              decision,
              price: prices.get(decision.symbol) || null,
            })),
          });
        }
        await this.repository.markToMarket(portfolio.id, prices, tradingDay);
        const summary = {
          target_count: mergeResearchCandidates(bundle).slice(0, RESEARCH_LOOP_MAX_POSITIONS)
            .length,
          buy_count: outcomes.filter(row => row.action === 'BUY' && row.status === 'executed')
            .length,
          hold_count: outcomes.filter(row => row.action === 'HOLD').length,
          sell_count: outcomes.filter(row => row.action === 'SELL' && row.status === 'executed')
            .length,
          skipped_count: outcomes.filter(row => ['skipped', 'failed'].includes(row.status)).length,
          decisions: outcomes,
        };
        await this.repository.completeRun(run.id, 'completed', summary);
        users.push({
          user_id: portfolio.user_id,
          portfolio_id: portfolio.id,
          run_id: run.id,
          status: 'completed',
          ...summary,
        });
      } catch (error: any) {
        await this.repository.completeRun(run.id, 'failed', {
          target_count: decisions.length,
          buy_count: 0,
          hold_count: 0,
          sell_count: 0,
          skipped_count: decisions.length,
          error: error?.message || String(error),
        });
        users.push({
          user_id: portfolio.user_id,
          portfolio_id: portfolio.id,
          run_id: run.id,
          status: 'failed',
          error: error?.message || String(error),
        });
      }
    }
    return {
      trading_day: tradingDay,
      research_day: bundle.expected_research_day,
      status: users.some(row => row.status === 'failed') ? 'partial' : 'completed',
      morning_snapshot_id: bundle.morning.snapshot_id,
      multibagger_as_of: bundle.multibagger.as_of,
      users,
    };
  }

  async getDashboard(user_id: number, now = new Date()) {
    const bundle = await this.repository.loadResearchBundle(now);
    const dashboard = await this.repository.loadDashboard(user_id);
    const latestRun = dashboard
      ? {
          ...dashboard,
          is_current:
            String(dashboard.trading_day || '') === getEast8DateString(now) &&
            String(dashboard.research_day || '') === bundle.expected_research_day,
        }
      : null;
    return {
      research: {
        expected_research_day: bundle.expected_research_day,
        morning: {
          snapshot_id: bundle.morning.snapshot_id,
          research_day: bundle.morning.research_day,
          as_of: bundle.morning.as_of,
          candidate_count: bundle.morning.candidates.length,
          fresh: bundle.morning.research_day === bundle.expected_research_day,
        },
        multibagger: {
          as_of: bundle.multibagger.as_of,
          research_day: bundle.multibagger.research_day,
          candidate_count: bundle.multibagger.candidates.length,
          fresh: bundle.multibagger.research_day === bundle.expected_research_day,
        },
        merged_target_count: mergeResearchCandidates(bundle).slice(0, RESEARCH_LOOP_MAX_POSITIONS)
          .length,
      },
      latest_run: latestRun,
    };
  }
}

export const researchTradingLoopService = new ResearchTradingLoopService();
