import {
  AIInvestmentSignal,
  AISignalDecision,
  AISignalSourceType,
} from '../models/AIInvestmentSignal';
import { AiRecommendationItem } from '../models/AiRecommendationItem';
import { AiRecommendationSnapshot } from '../models/AiRecommendationSnapshot';
import { getEast8DateString } from '../utils/timezone';
import { normalizeSymbol } from '../utils/stockSymbol';

export interface RecommendationProjectionItem {
  item_id: string;
  snapshot_id: string;
  ticker: string;
  rank: number;
  rating_band: string;
  conviction_final: number;
  risk_gate_status: string;
  size_hint_tier: string;
  recommendation: Record<string, any>;
}

export interface RecommendationProjectionSnapshot {
  snapshot_id: string;
  trading_day: string;
  profile: string;
  market_scope: string;
  as_of: Date;
  items: RecommendationProjectionItem[];
}

export interface RecommendationSignalProjectionRepository {
  loadSnapshot(trading_day: string): Promise<RecommendationProjectionSnapshot | null>;
  upsertSignal(payload: Record<string, any>): Promise<'created' | 'updated'>;
}

function objectValue(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

function finite(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sizePct(item: RecommendationProjectionItem): number {
  const plan = objectValue(item.recommendation.entry_plan);
  const hint = objectValue(plan.size_hint);
  const explicit = finite(hint.pct, 0);
  if (explicit > 0) return Math.min(explicit, 12);
  const byTier: Record<string, number> = {
    TIER_5: 5,
    TIER_3: 3,
    TIER_2: 2,
    TIER_1: 1,
  };
  return byTier[item.size_hint_tier] || 1;
}

function midpoint(value: unknown): number | null {
  const range = objectValue(value);
  const low = finite(range.low, NaN);
  const high = finite(range.high, NaN);
  if (Number.isFinite(low) && Number.isFinite(high) && low > 0 && high > 0) {
    return (low + high) / 2;
  }
  return null;
}

export function buildRecommendationSignalPayload(
  snapshot: RecommendationProjectionSnapshot,
  item: RecommendationProjectionItem,
  expires_at: string
): Record<string, any> {
  const recommendation = objectValue(item.recommendation);
  const explanation = objectValue(recommendation.explanation);
  const entryPlan = objectValue(recommendation.entry_plan);
  const entryMidpoint = midpoint(entryPlan.entry);
  const stop = finite(objectValue(entryPlan.stop).value, 0);
  const targets = Array.isArray(entryPlan.targets) ? entryPlan.targets : [];
  const firstTarget = finite(objectValue(targets[0]).value, 0);
  const conviction = Math.max(
    finite(item.conviction_final, 0),
    finite(objectValue(recommendation.conviction).final, 0),
    finite(objectValue(recommendation.score).total, 0)
  );
  const strong = item.rating_band === 'A' || conviction >= 85;
  const symbol = normalizeSymbol(item.ticker);
  const recommendedSize = sizePct(item);

  return {
    source_type: AISignalSourceType.RECOMMENDATION_SNAPSHOT,
    source_id: item.item_id,
    symbol,
    name:
      recommendation.name || recommendation.security_name || recommendation.company_name || symbol,
    signal_date: snapshot.trading_day,
    decision: strong ? 'A股早报高确信推荐' : 'A股早报推荐',
    normalized_decision: strong ? AISignalDecision.STRONG_BUY : AISignalDecision.BUY,
    confidence_score: Math.min(Math.max(conviction, 0), 100),
    risk_level: item.rating_band === 'A' || item.rating_band === 'B' ? 'low' : 'medium',
    rationale: explanation.headline || explanation.body || '来自当日 A 股早报规范快照',
    detail: explanation.body || null,
    current_price: entryMidpoint,
    action: 'BUY',
    recommended_size_pct: recommendedSize,
    entry_price_strategy: 'observe_15min',
    stop_loss_pct:
      entryMidpoint && stop > 0
        ? Math.max(0, ((entryMidpoint - stop) / entryMidpoint) * 100)
        : null,
    take_profit_pct:
      entryMidpoint && firstTarget > 0
        ? Math.max(0, ((firstTarget - entryMidpoint) / entryMidpoint) * 100)
        : null,
    gate_pass: true,
    gate_reason: 'recommendation_snapshot_green_gate',
    metadata: {
      action: 'buy',
      canonical_source: true,
      snapshot_id: snapshot.snapshot_id,
      item_id: item.item_id,
      profile: snapshot.profile,
      market_scope: snapshot.market_scope,
      trading_day: snapshot.trading_day,
      rank: item.rank,
      rating_band: item.rating_band,
      conviction_final: conviction,
      risk_gate_status: item.risk_gate_status,
      size_hint_tier: item.size_hint_tier,
      suggested_position_pct: recommendedSize,
      expires_at,
      recommendation_hash: recommendation.recommendation_hash || null,
      explanation: {
        headline: explanation.headline || null,
        body: explanation.body || null,
      },
    },
  };
}

export class SequelizeRecommendationSignalProjectionRepository
  implements RecommendationSignalProjectionRepository
{
  async loadSnapshot(trading_day: string): Promise<RecommendationProjectionSnapshot | null> {
    const snapshot = await AiRecommendationSnapshot.findOne({
      where: { tradingDay: trading_day, profile: 'us_preferred', marketScope: 'cn_a' },
      order: [['asOfUtc', 'DESC']],
    });
    if (!snapshot) return null;
    const items = await AiRecommendationItem.findAll({
      where: { snapshotId: snapshot.snapshotId },
      order: [['sortRank', 'ASC']],
    });
    return {
      snapshot_id: snapshot.snapshotId,
      trading_day: snapshot.tradingDay,
      profile: snapshot.profile,
      market_scope: snapshot.marketScope,
      as_of: snapshot.asOfUtc,
      items: items.map(item => ({
        item_id: item.itemId,
        snapshot_id: item.snapshotId,
        ticker: item.ticker,
        rank: item.sortRank,
        rating_band: item.ratingBand,
        conviction_final: Number(item.convictionFinal),
        risk_gate_status: item.riskGateStatus,
        size_hint_tier: item.sizeHintTier,
        recommendation: item.recommendationJson || {},
      })),
    };
  }

  async upsertSignal(payload: Record<string, any>): Promise<'created' | 'updated'> {
    const [signal, created] = await AIInvestmentSignal.findOrCreate({
      where: { source_type: payload.source_type, source_id: payload.source_id },
      defaults: payload as any,
    });
    if (created) return 'created';
    const currentMetadata = objectValue(signal.metadata);
    await signal.update({
      ...payload,
      metadata: {
        ...currentMetadata,
        ...payload.metadata,
        paper_trading: currentMetadata.paper_trading,
        paper_trading_by_portfolio: currentMetadata.paper_trading_by_portfolio,
      },
    });
    return 'updated';
  }
}

export class RecommendationSnapshotSignalProjectionService {
  constructor(
    private readonly repository: RecommendationSignalProjectionRepository = new SequelizeRecommendationSignalProjectionRepository()
  ) {}

  async projectTradingDay(options: { trading_day?: string; now?: Date } = {}) {
    const now = options.now || new Date();
    const trading_day = options.trading_day || getEast8DateString(now);
    if (trading_day !== getEast8DateString(now)) {
      return {
        trading_day,
        snapshot_id: null,
        scanned: 0,
        projected: 0,
        skipped: 0,
        reason: 'not_today',
      };
    }
    const snapshot = await this.repository.loadSnapshot(trading_day);
    if (!snapshot) {
      return {
        trading_day,
        snapshot_id: null,
        scanned: 0,
        projected: 0,
        skipped: 0,
        reason: 'snapshot_missing',
      };
    }
    const expiresAt = new Date(`${trading_day}T15:30:00+08:00`);
    if (now.getTime() >= expiresAt.getTime()) {
      return {
        trading_day,
        snapshot_id: snapshot.snapshot_id,
        scanned: snapshot.items.length,
        projected: 0,
        skipped: snapshot.items.length,
        reason: 'snapshot_expired',
      };
    }

    let created = 0;
    let updated = 0;
    let skipped = 0;
    for (const item of snapshot.items) {
      if (item.risk_gate_status !== 'GREEN' || item.size_hint_tier === 'SKIP') {
        skipped += 1;
        continue;
      }
      const payload = buildRecommendationSignalPayload(snapshot, item, expiresAt.toISOString());
      if (!payload.symbol) {
        skipped += 1;
        continue;
      }
      const result = await this.repository.upsertSignal(payload);
      if (result === 'created') created += 1;
      else updated += 1;
    }
    return {
      trading_day,
      snapshot_id: snapshot.snapshot_id,
      scanned: snapshot.items.length,
      projected: created + updated,
      created,
      updated,
      skipped,
      expires_at: expiresAt.toISOString(),
      reason: null,
    };
  }
}

export const recommendationSnapshotSignalProjectionService =
  new RecommendationSnapshotSignalProjectionService();
