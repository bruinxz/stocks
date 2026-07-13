import {
  RecommendationSnapshotContractError,
  RecommendationSnapshotReadPort,
  type RecommendationMarketScope,
  type RecommendationProfile,
  type RecommendationSnapshotDetail,
} from '../recommendations/RecommendationSnapshotReadPort';
import { ProjectionCliPort, type ProjectionHistoryFilters } from './ProjectionCliClient';

type JsonObject = Record<string, unknown>;

export interface DailyReportProjectionScope {
  profile: RecommendationProfile;
  market_scope: RecommendationMarketScope;
}

export interface DailyReportProjectionDateQuery extends DailyReportProjectionScope {
  trading_day: string;
}

export interface DailyReportProjectionHistoryQuery extends ProjectionHistoryFilters {
  profile?: RecommendationProfile;
  market_scope?: RecommendationMarketScope;
}

export interface DailyReportProjectionPort {
  latest(scope: DailyReportProjectionScope): Promise<JsonObject | null>;
  byDate(query: DailyReportProjectionDateQuery): Promise<JsonObject | null>;
  history(query: DailyReportProjectionHistoryQuery): Promise<JsonObject>;
}

export interface DailyReportProjectionServiceOptions {
  history_source_limit?: number;
}

function historySourceLimit(value: number | undefined): number {
  const configured = value ?? Number(process.env.TAB67_PROJECTION_HISTORY_SOURCE_LIMIT || 365);
  if (!Number.isInteger(configured) || configured < 1 || configured > 1000) {
    return 365;
  }
  return configured;
}

/**
 * Removes the B3-only authenticated preimage field and reconstructs the exact
 * v0.3.1 RecommendationList envelope expected by the Python projection SOT.
 * No report formula, sorting, filtering, or rendering is implemented here.
 */
export function toProjectionEnvelope(snapshot: RecommendationSnapshotDetail): JsonObject {
  return {
    snapshot_id: snapshot.snapshot_id,
    as_of: snapshot.as_of,
    profile: snapshot.profile,
    market_scope: snapshot.market_scope,
    items: snapshot.items,
    output_fingerprint: snapshot.output_fingerprint,
    disclaimer: snapshot.disclaimer,
    meta: snapshot.meta,
  };
}

export class DailyReportProjectionService implements DailyReportProjectionPort {
  private readonly historyLimit: number;

  constructor(
    private readonly snapshots: RecommendationSnapshotReadPort,
    private readonly projection: ProjectionCliPort,
    options: DailyReportProjectionServiceOptions = {}
  ) {
    this.historyLimit = historySourceLimit(options.history_source_limit);
  }

  async latest(scope: DailyReportProjectionScope): Promise<JsonObject | null> {
    const snapshot = await this.snapshots.latest(scope);
    return snapshot ? this.projection.projectDaily(toProjectionEnvelope(snapshot)) : null;
  }

  async byDate(query: DailyReportProjectionDateQuery): Promise<JsonObject | null> {
    const page = await this.snapshots.byDate({
      trading_day: query.trading_day,
      profile: query.profile,
      market_scope: query.market_scope,
      page: 1,
      page_size: 1,
    });
    if (!page.entries.length) return null;
    const snapshot = await this.snapshots.detail(page.entries[0].snapshot_id);
    if (!snapshot) {
      throw new RecommendationSnapshotContractError(
        'Recommendation snapshot summary has no detail'
      );
    }
    return this.projection.projectDaily(toProjectionEnvelope(snapshot));
  }

  async history(query: DailyReportProjectionHistoryQuery): Promise<JsonObject> {
    const snapshots = await this.snapshots.history({
      profile: query.profile,
      market_scope: query.market_scope,
      from_day: query.from_day,
      to_day: query.to_day,
      limit: this.historyLimit,
    });
    return this.projection.projectHistory(snapshots.map(toProjectionEnvelope), {
      query: query.query,
      profile: query.profile,
      market_scope: query.market_scope,
      from_day: query.from_day,
      to_day: query.to_day,
    });
  }
}
