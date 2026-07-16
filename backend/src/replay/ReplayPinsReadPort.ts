import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import {
  ReplayContractError,
  parseReplayPins,
  type ReplayMarketScope,
  type ReplayPins,
  type ReplayProfile,
} from './ReplayContract';

export interface ReplayPinsQuery {
  trading_day: string;
  profile: ReplayProfile;
  market_scope: ReplayMarketScope;
}

export interface ReplayPinsReadPort {
  resolve(query: ReplayPinsQuery): Promise<ReplayPins>;
}

export class ReplayPinsNotFoundError extends Error {
  constructor() {
    super('Replay source capture not found');
    this.name = 'ReplayPinsNotFoundError';
  }
}

export class ReplayPinsConflictError extends Error {
  constructor() {
    super('Replay source capture is ambiguous');
    this.name = 'ReplayPinsConflictError';
  }
}

export class ReplayPinsStoreUnavailableError extends Error {
  constructor() {
    super('Replay source capture store is unavailable');
    this.name = 'ReplayPinsStoreUnavailableError';
  }
}

export class SequelizeReplayPinsReadAdapter implements ReplayPinsReadPort {
  constructor(private readonly sequelize: Sequelize) {}

  async resolve(query: ReplayPinsQuery): Promise<ReplayPins> {
    let rows: Record<string, unknown>[];
    try {
      rows = await this.sequelize.query<Record<string, unknown>>(
        `SELECT trading_day::TEXT AS trading_day,
                TO_CHAR(
                  as_of_utc AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS"Z"'
                ) AS as_of,
                profile,
                market_scope,
                profile_version,
                contract_version,
                input_fingerprint,
                strategy_version,
                pipeline_version
           FROM ai_replay_typed_source_capture
          WHERE trading_day = CAST(:trading_day AS DATE)
            AND profile = :profile
            AND market_scope = :market_scope
          ORDER BY capture_id ASC
          LIMIT 2`,
        {
          replacements: {
            trading_day: query.trading_day,
            profile: query.profile,
            market_scope: query.market_scope,
          },
          type: QueryTypes.SELECT,
        }
      );
    } catch (_error) {
      throw new ReplayPinsStoreUnavailableError();
    }

    if (rows.length === 0) throw new ReplayPinsNotFoundError();
    if (rows.length !== 1) throw new ReplayPinsConflictError();
    try {
      return parseReplayPins(rows[0]);
    } catch (error: unknown) {
      if (error instanceof ReplayContractError) {
        throw new ReplayPinsStoreUnavailableError();
      }
      throw error;
    }
  }
}
