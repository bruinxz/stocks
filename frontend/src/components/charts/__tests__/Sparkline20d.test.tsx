/**
 * Sparkline20d 单测 — 覆盖纯函数 helpers (sanitizeSparklineData / pickSparklineColor).
 *
 * 不渲染 React 组件 (项目未安装 @testing-library/react), 用 jest 直接测 helpers.
 * 这两个 helper 是 Sparkline 颜色决策 + 数据清洗的核心, 错了 polyline 会断 / 串色.
 */

import { describe, expect, test } from '@jest/globals';
import { sanitizeSparklineData, pickSparklineColor, Sparkline20dPoint } from '../Sparkline20d';

describe('Sparkline20d / sanitizeSparklineData', () => {
  test('空数组返空', () => {
    expect(sanitizeSparklineData([])).toEqual([]);
    expect(sanitizeSparklineData(null)).toEqual([]);
    expect(sanitizeSparklineData(undefined)).toEqual([]);
  });

  test('全 valid 数据原样保留', () => {
    const input: Sparkline20dPoint[] = [
      { date: '2026-06-20', close: 100 },
      { date: '2026-06-21', close: 102 },
      { date: '2026-06-22', close: 101 },
    ];
    expect(sanitizeSparklineData(input)).toEqual(input);
  });

  test('NaN 用前一个 valid 兜底', () => {
    const input: Sparkline20dPoint[] = [
      { date: '2026-06-20', close: 100 },
      { date: '2026-06-21', close: NaN as any },
      { date: '2026-06-22', close: 102 },
    ];
    expect(sanitizeSparklineData(input)).toEqual([
      { date: '2026-06-20', close: 100 },
      { date: '2026-06-21', close: 100 }, // 兜底
      { date: '2026-06-22', close: 102 },
    ]);
  });

  test('Infinity 用前一个 valid 兜底', () => {
    const input: Sparkline20dPoint[] = [
      { date: '2026-06-20', close: 100 },
      { date: '2026-06-21', close: Infinity as any },
    ];
    expect(sanitizeSparklineData(input)).toEqual([
      { date: '2026-06-20', close: 100 },
      { date: '2026-06-21', close: 100 },
    ]);
  });

  test('前导无效点直接丢弃 (不能用 0 兜底)', () => {
    const input: Sparkline20dPoint[] = [
      { date: '2026-06-20', close: NaN as any },
      { date: '2026-06-21', close: 100 },
    ];
    expect(sanitizeSparklineData(input)).toEqual([{ date: '2026-06-21', close: 100 }]);
  });

  test('缺 date 字段的项被丢弃', () => {
    const input: any[] = [{ close: 100 }, { date: '2026-06-21', close: 102 }, null];
    expect(sanitizeSparklineData(input)).toEqual([{ date: '2026-06-21', close: 102 }]);
  });
});

describe('Sparkline20d / pickSparklineColor', () => {
  test('上涨 (末 > 首) 返红', () => {
    expect(
      pickSparklineColor([
        { date: 'd1', close: 100 },
        { date: 'd2', close: 110 },
      ])
    ).toBe('#dc2626');
  });

  test('下跌 (末 < 首) 返绿', () => {
    expect(
      pickSparklineColor([
        { date: 'd1', close: 110 },
        { date: 'd2', close: 100 },
      ])
    ).toBe('#16a34a');
  });

  test('平 (末 = 首) 返蓝', () => {
    expect(
      pickSparklineColor([
        { date: 'd1', close: 100 },
        { date: 'd2', close: 100 },
      ])
    ).toBe('#1677ff');
  });

  test('单点 / 空返蓝 (无方向)', () => {
    expect(pickSparklineColor([])).toBe('#1677ff');
    expect(pickSparklineColor([{ date: 'd1', close: 100 }])).toBe('#1677ff');
  });

  test('NaN 数据兜底蓝', () => {
    expect(
      pickSparklineColor([
        { date: 'd1', close: NaN as any },
        { date: 'd2', close: 100 },
      ])
    ).toBe('#1677ff');
  });
});
