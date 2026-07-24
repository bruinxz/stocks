import assert from 'assert';
import {
  RESEARCH_QUALIFICATION_CONTRACT_VERSION,
  evaluateResearchStrategyQualification,
  summarizeResearchStrategyQualifications,
  type ResearchPitEvidence,
  type ResearchQualificationAudit,
} from '../../src/services/ResearchStrategyQualificationService';

const evidenceHash = 'a'.repeat(64);

function pit(overrides: Partial<ResearchPitEvidence> = {}): ResearchPitEvidence {
  return {
    strategy_key: 'us_preferred',
    snapshot_count: 27,
    first_day: '2025-01-02',
    last_day: '2026-07-23',
    cumulative_return_pct: 18,
    sharpe_ratio: 1.2,
    max_drawdown_pct: 12,
    win_rate_pct: 54,
    evidence_hash: evidenceHash,
    ...overrides,
  };
}

function audit(overrides: Partial<ResearchQualificationAudit> = {}): ResearchQualificationAudit {
  return {
    strategy_key: 'us_preferred',
    verdict: 'PASS',
    created_at: '2026-07-24T03:00:00.000Z',
    metadata: {
      qualification: {
        qualification_contract_version: RESEARCH_QUALIFICATION_CONTRACT_VERSION,
        point_in_time_ready: true,
        oos_trading_days: 252,
        after_cost_annual_return_pct: 12,
        benchmark_excess_return_pct: 4,
        max_drawdown_pct: 12,
        walk_forward_verdict: 'PASS',
        overfit_score: 0.2,
        double_cost_total_return_pct: 6,
        evidence_hash: evidenceHash,
      },
    },
    ...overrides,
  };
}

function testCompleteEvidencePasses() {
  const result = evaluateResearchStrategyQualification({
    source: 'morning_brief',
    pit: pit(),
    audit: audit(),
    evaluated_at: new Date('2026-07-24T04:00:00.000Z'),
  });
  assert.equal(result.status, 'pass');
  assert.equal(result.eligible_for_new_positions, true);
  assert.deepEqual(result.blockers, []);
}

function testObservedLossAlwaysFailsClosed() {
  const result = evaluateResearchStrategyQualification({
    source: 'morning_brief',
    pit: pit({
      cumulative_return_pct: -30.7,
      sharpe_ratio: -1.85,
      max_drawdown_pct: 35.13,
      win_rate_pct: 29.6,
    }),
    audit: null,
  });
  assert.equal(result.status, 'fail');
  assert.equal(result.eligible_for_new_positions, false);
  assert(result.blockers.some(item => item.code === 'pit_after_cost_return_non_positive'));
  assert(result.blockers.some(item => item.code === 'pit_sharpe_non_positive'));
  assert(result.blockers.some(item => item.code === 'pit_drawdown_too_high'));
  assert(result.blockers.some(item => item.code === 'qualification_audit_missing'));
}

function testMissingOrMismatchedAuditIsInsufficient() {
  const missing = evaluateResearchStrategyQualification({
    source: 'multibagger',
    pit: null,
    audit: null,
  });
  assert.equal(missing.status, 'insufficient');
  assert.equal(missing.eligible_for_new_positions, false);

  const mismatched = evaluateResearchStrategyQualification({
    source: 'morning_brief',
    pit: pit(),
    audit: audit({
      metadata: {
        qualification: {
          ...(audit().metadata.qualification as Record<string, unknown>),
          evidence_hash: 'b'.repeat(64),
        },
      },
    }),
  });
  assert.equal(mismatched.status, 'insufficient');
  assert(mismatched.blockers.some(item => item.code === 'qualification_evidence_hash_invalid'));
}

function testSummarySupportsPartialQualification() {
  const morning = evaluateResearchStrategyQualification({
    source: 'morning_brief',
    pit: pit(),
    audit: audit(),
  });
  const multibagger = evaluateResearchStrategyQualification({
    source: 'multibagger',
    pit: null,
    audit: null,
  });
  const result = summarizeResearchStrategyQualifications({
    qualifications: { morning_brief: morning, multibagger },
  });
  assert.equal(result.status, 'partial');
  assert.equal(result.eligible_source_count, 1);
  assert.equal(result.allows_new_positions, true);
}

function main() {
  testCompleteEvidencePasses();
  testObservedLossAlwaysFailsClosed();
  testMissingOrMismatchedAuditIsInsufficient();
  testSummarySupportsPartialQualification();
  console.log('research strategy qualification service tests passed');
}

main();
