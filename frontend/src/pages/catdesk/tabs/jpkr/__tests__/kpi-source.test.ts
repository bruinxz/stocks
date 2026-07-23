import { formatKpiSourceLabel } from '../JpKrKpiStrip';

test('maps authoritative KPI source kinds to user-facing provenance labels', () => {
  expect(formatKpiSourceLabel('naver-public')).toBe('Naver 公开行情');
  expect(formatKpiSourceLabel('BOK')).toBe('韩国央行');
  expect(formatKpiSourceLabel('reviewed-provider')).toBe('reviewed-provider');
});
