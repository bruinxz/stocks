import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, test } from '@jest/globals';
import { parseB5DailyReport, parseB5ReportHistory } from '../b5ProjectionAdapter';

function committedGolden(name: string): unknown {
  return JSON.parse(
    readFileSync(
      path.resolve(process.cwd(), '..', 'strategy', 'reporting', 'fixtures', name),
      'utf8'
    )
  ) as unknown;
}

describe('merged B5 immutable golden compatibility', () => {
  test('daily golden passes the strict adapter and preserves the full wire', () => {
    const wire = committedGolden('daily_report_us_v031.golden.json');
    const view = parseB5DailyReport(wire);
    expect(view.wire).toEqual(wire);
    expect(view.snapshot.items).toEqual(view.wire.entries);
    expect(view.source_snapshot_ids).toEqual([view.wire.source_snapshot_id]);
  });

  test('history golden passes the strict adapter and preserves the full wire', () => {
    const wire = committedGolden('report_history_us_v031.golden.json');
    const view = parseB5ReportHistory(wire);
    expect(view.wire).toEqual(wire);
    expect(view.total).toBe(view.wire.entries.length);
    expect(view.entries[0].wire).toEqual(view.wire.entries[0]);
  });
});
