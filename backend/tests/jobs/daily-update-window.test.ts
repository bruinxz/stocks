import assert from 'assert';
import { resolveDailyUpdateWindow } from '../../src/jobs/dailyUpdateWindow';

const normal = resolveDailyUpdateWindow('2026-07-23', '2026-07-22');
assert.deepEqual(normal, {
  start_date: '2026-07-16',
  target_date: '2026-07-23',
  market_coverage_date: '2026-07-22',
  lag_days: 1,
  catchup_mode: false,
});

const boundary = resolveDailyUpdateWindow('2026-07-23', '2026-07-16');
assert.equal(boundary.start_date, '2026-07-16');
assert.equal(boundary.catchup_mode, false);

const firstCatchupDay = resolveDailyUpdateWindow('2026-07-23', '2026-07-15');
assert.equal(firstCatchupDay.start_date, '2026-07-16');
assert.equal(firstCatchupDay.catchup_mode, true);

const severe = resolveDailyUpdateWindow('2026-07-23', '2026-04-17');
assert.deepEqual(severe, {
  start_date: '2026-04-18',
  target_date: '2026-07-23',
  market_coverage_date: '2026-04-17',
  lag_days: 97,
  catchup_mode: true,
});

const capped = resolveDailyUpdateWindow('2026-07-23', '2025-01-01');
assert.equal(capped.start_date, '2026-01-24');
assert.equal(capped.catchup_mode, true);

const unknown = resolveDailyUpdateWindow('2026-07-23', null);
assert.equal(unknown.start_date, '2026-07-16');
assert.equal(unknown.catchup_mode, false);

console.log('daily update window: 10 assertions passed');
