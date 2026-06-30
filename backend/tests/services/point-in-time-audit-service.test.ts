/**
 * PointInTimeAuditService tests — phase 1 data visibility audit.
 */
import {
  auditDisclosureVisibility,
  auditHistoricalMembershipVisibility,
  buildPointInTimeArtifact,
} from '../../src/services/research/PointInTimeAuditService';

let passed = 0;
let failed = 0;

function assert(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

console.log('\n## PointInTimeAuditService');

const disclosure = auditDisclosureVisibility({
  source_name: 'earnings_forecast',
  as_of_date: '2026-04-15',
  rows: [
    {
      stock_code: '600519',
      report_period: '2026Q1',
      report_date: '2026-03-31',
      announce_date: '2026-04-10',
    },
    {
      stock_code: '000001',
      report_period: '2026Q1',
      report_date: '2026-03-31',
      announce_date: '2026-04-30',
    },
  ],
});

assert('disclosure audit rejects future announce_date', disclosure.status === 'reject');
assert('disclosure audit keeps visible row count', disclosure.visible_count === 1);
assert('disclosure audit reports hidden future rows', disclosure.future_rows.length === 1);
assert(
  'disclosure audit names the blocked symbol',
  disclosure.future_rows[0].stock_code === '000001'
);

const missingDisclosure = auditDisclosureVisibility({
  source_name: 'shareholder_count',
  as_of_date: '2026-04-15',
  rows: [{ stock_code: '600519', report_date: '2026-03-31' }],
  disclosure_date_required: true,
});

assert('missing announce_date is insufficient', missingDisclosure.status === 'insufficient');
assert('missing announce_date is counted', missingDisclosure.missing_disclosure_count === 1);

const dateObjectDisclosure = auditDisclosureVisibility({
  source_name: 'earnings_forecast',
  as_of_date: '2026-04-15',
  rows: [
    {
      stock_code: '600519',
      report_period: '2026Q1',
      report_date: new Date('2026-03-31T00:00:00.000Z'),
      announce_date: new Date('2026-04-10T00:00:00.000Z'),
    },
  ],
});
assert('disclosure audit handles Date objects as ISO dates', dateObjectDisclosure.status === 'pass');

const membership = auditHistoricalMembershipVisibility({
  source_name: 'CSI300',
  as_of_date: '2026-05-01',
  rows: [
    { symbol: 'A', effective_date: '2026-01-01', end_date: '2026-03-31' },
    { symbol: 'B', effective_date: '2026-04-01', end_date: null },
    { symbol: 'C', effective_date: '2026-07-01', end_date: null },
  ],
});

assert('historical membership keeps active symbol only', membership.active_symbols.join(',') === 'B');
assert('future universe rows are visible audit issues', membership.future_rows[0].symbol === 'C');
assert('expired universe rows are separated', membership.expired_rows[0].symbol === 'A');

const pitArtifact = buildPointInTimeArtifact({
  data_policy_json: { point_in_time: true, disclosure_date_required: true },
  disclosure_checks: [disclosure],
  universe_checks: [membership],
});

assert('PIT artifact rejects any future leakage', pitArtifact.status === 'reject');
assert('PIT artifact exposes issue slots', Array.isArray(pitArtifact.payload_json?.issue_slots));
assert(
  'PIT artifact keeps disclosure slot',
  pitArtifact.payload_json?.issue_slots.some((slot: any) => slot.key === 'disclosure_date')
);
assert(
  'PIT artifact keeps universe slot',
  pitArtifact.payload_json?.issue_slots.some((slot: any) => slot.key === 'universe_visibility')
);

const insufficientPitArtifact = buildPointInTimeArtifact({
  data_policy_json: { point_in_time: true, disclosure_date_required: true },
  disclosure_checks: [missingDisclosure],
  universe_checks: [],
});

assert('PIT artifact marks missing data insufficient', insufficientPitArtifact.status === 'insufficient');

const noSamplePitArtifact = buildPointInTimeArtifact({
  data_policy_json: {
    point_in_time: true,
    disclosure_date_required: true,
    universe_as_of_required: true,
  },
  disclosure_checks: [],
  universe_checks: [],
});
assert('PIT artifact does not pass only from declared coverage', noSamplePitArtifact.status === 'insufficient');

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
