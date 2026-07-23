import assert from 'assert';
import {
  assessAShareFreshness,
  expectedCompletedTradeDate,
  PageFreshnessService,
} from '../../src/services/PageFreshnessService';

async function main() {
  const queryLog: string[] = [];
  const service = new PageFreshnessService(async sql => {
    queryLog.push(sql);
    if (sql.includes('ai_recommendation_snapshot')) {
      throw new Error('relation "ai_recommendation_snapshot" does not exist');
    }
    if (sql.includes('daily_bars')) {
      return [
        {
          latest_data_at: '2026-07-23T10:00:00.000Z',
          latest_data_date: '2026-07-23',
        },
      ];
    }
    return [{ latest_data_at: null, latest_data_date: null }];
  });

  const response = await service.getPageFreshness(new Date('2026-07-24T01:00:00.000Z'));
  assert.equal(queryLog.length, 6, 'each physical source should be queried once');
  assert.deepEqual(
    Object.keys(response.pages).sort(),
    ['backtest', 'daily', 'history', 'jpkr', 'market', 'morning', 'multi', 'us'].sort(),
    'one unavailable optional table must not remove other page watermarks'
  );
  assert.equal(response.pages.market.status, 'fresh');
  assert.equal(response.pages.market.latest_data_date, '2026-07-23');
  assert.equal(response.pages.morning.status, 'missing');
  assert.equal(response.pages.daily.status, 'missing');
  assert.equal(response.pages.history.status, 'missing');
  assert.equal(
    response.pages.morning.source,
    'ai_recommendation_snapshot/cn_a',
    'missing pages should retain the source needed for diagnosis'
  );

  const delayed = assessAShareFreshness('2026-07-20', new Date('2026-07-24T01:00:00.000Z'));
  assert.equal(delayed.reference_trade_date, '2026-07-23');
  assert.equal(delayed.status, 'delayed');
  assert.equal(delayed.lag_days, 3);

  const missing = assessAShareFreshness(null, new Date('2026-07-24T01:00:00.000Z'));
  assert.equal(missing.status, 'missing');
  assert.equal(missing.lag_days, null);

  assert.equal(
    expectedCompletedTradeDate(new Date('2026-07-24T08:59:00.000Z')),
    '2026-07-23',
    'before the 17:00 Shanghai close watermark, recovery must target the previous trade day'
  );
  assert.equal(
    expectedCompletedTradeDate(new Date('2026-07-24T09:01:00.000Z')),
    '2026-07-24',
    'after the close watermark, recovery may target the current trade day'
  );
  assert.equal(
    expectedCompletedTradeDate(new Date('2026-07-26T04:00:00.000Z')),
    '2026-07-24',
    'weekend recovery must target the last completed trade day'
  );

  console.log('page freshness service: 17 assertions passed');
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
