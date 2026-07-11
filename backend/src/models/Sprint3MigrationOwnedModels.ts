import { BacktestPitHolding } from './BacktestPitHolding';
import { BacktestPitSnapshot } from './BacktestPitSnapshot';
import { JpkrDailyKline } from './JpkrDailyKline';
import { JpkrDisclosureEvent } from './JpkrDisclosureEvent';
import { JpkrFinancialSnapshot } from './JpkrFinancialSnapshot';
import { JpkrFxObservation } from './JpkrFxObservation';
import { JpkrSecurityMaster } from './JpkrSecurityMaster';
import { MultibaggerCandidateSnapshot } from './MultibaggerCandidateSnapshot';
import { MultibaggerTextHit } from './MultibaggerTextHit';
import { MultibaggerUniverse } from './MultibaggerUniverse';

/**
 * Canonical Sprint 3 tables are owned exclusively by the paired SQL migration.
 *
 * sequelize.sync({ alter: true }) cannot faithfully express composite foreign
 * keys, generated columns, ownership fingerprints, or all PostgreSQL checks.
 * Models remain registered for CRUD but their sync method is a deliberate
 * no-op, preventing bulk development alter-sync from weakening the schema.
 */
export const SPRINT3_MIGRATION_OWNED_MODELS = [
  JpkrSecurityMaster,
  JpkrDailyKline,
  JpkrDisclosureEvent,
  JpkrFinancialSnapshot,
  JpkrFxObservation,
  MultibaggerUniverse,
  MultibaggerTextHit,
  MultibaggerCandidateSnapshot,
  BacktestPitSnapshot,
  BacktestPitHolding,
] as const;

for (const model of SPRINT3_MIGRATION_OWNED_MODELS) {
  Object.defineProperty(model, 'sync', {
    configurable: false,
    writable: false,
    value: async () => model,
  });
}
