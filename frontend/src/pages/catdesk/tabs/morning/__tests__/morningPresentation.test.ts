import { describe, expect, test } from '@jest/globals';
import { formatMorningUpdateTime } from '../MorningKpiSlots';

describe('morning brief presentation', () => {
  test('renders snapshot timestamps in Asia/Shanghai instead of raw UTC', () => {
    expect(formatMorningUpdateTime('2026-07-23T22:47:32Z')).toMatch(/07.*24.*06.*47/);
  });

  test('labels invalid timestamps explicitly', () => {
    expect(formatMorningUpdateTime('not-a-date')).toBe('时间不可用');
  });
});
