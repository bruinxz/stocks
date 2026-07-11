/**
 * V3RecommendationCard 单测 — 覆盖纯函数 helpers (dimensionScoreColor /
 * marketCapBucketLabel / orderDimensions).
 *
 * 项目未安装 @testing-library/react, 不做组件 render 验; 改测 helper 决策语义,
 * 这些 helper 决定 4 维大字颜色 / 市值 tag 文案 / 维度排序 — 错了卡片信息会跑偏.
 */

import {
  dimensionScoreColor,
  marketCapBucketLabel,
  orderDimensions,
  playbookVerdictColor,
} from '../V3RecommendationCard';
import type { V3DimensionItem } from '../../../services/v3RecommendationService';
import { describe, expect, test } from '@jest/globals';

describe('V3RecommendationCard / dimensionScoreColor', () => {
  test('≥80 红强', () => {
    expect(dimensionScoreColor(80)).toBe('#dc2626');
    expect(dimensionScoreColor(95)).toBe('#dc2626');
    expect(dimensionScoreColor(100)).toBe('#dc2626');
  });

  test('60-79 橙中', () => {
    expect(dimensionScoreColor(60)).toBe('#fa8c16');
    expect(dimensionScoreColor(70)).toBe('#fa8c16');
    expect(dimensionScoreColor(79)).toBe('#fa8c16');
  });

  test('40-59 灰平', () => {
    expect(dimensionScoreColor(40)).toBe('#8c8c8c');
    expect(dimensionScoreColor(50)).toBe('#8c8c8c');
    expect(dimensionScoreColor(59)).toBe('#8c8c8c');
  });

  test('<40 绿弱', () => {
    expect(dimensionScoreColor(0)).toBe('#16a34a');
    expect(dimensionScoreColor(39)).toBe('#16a34a');
  });

  test('null / NaN / undefined 兜底灰', () => {
    expect(dimensionScoreColor(null)).toBe('#8c8c8c');
    expect(dimensionScoreColor(undefined)).toBe('#8c8c8c');
    expect(dimensionScoreColor(NaN)).toBe('#8c8c8c');
    expect(dimensionScoreColor(Infinity)).toBe('#8c8c8c');
  });
});

describe('V3RecommendationCard / marketCapBucketLabel', () => {
  test('≥ 1000 亿 超大市值', () => {
    expect(marketCapBucketLabel(1.5e11, null)).toBe('超大市值');
    expect(marketCapBucketLabel(1e11, null)).toBe('超大市值');
  });

  test('[500亿, 1000亿) 千亿大盘', () => {
    expect(marketCapBucketLabel(8e10, null)).toBe('千亿大盘');
    expect(marketCapBucketLabel(5e10, null)).toBe('千亿大盘');
  });

  test('[100亿, 500亿) 中盘股', () => {
    expect(marketCapBucketLabel(3e10, null)).toBe('中盘股');
    expect(marketCapBucketLabel(1e10, null)).toBe('中盘股');
  });

  test('< 100亿 小盘股', () => {
    expect(marketCapBucketLabel(5e9, null)).toBe('小盘股');
    expect(marketCapBucketLabel(1, null)).toBe('小盘股');
  });

  test('circulating 优先, 缺则 total', () => {
    expect(marketCapBucketLabel(null, 1.5e11)).toBe('超大市值');
    expect(marketCapBucketLabel(8e10, 1.5e11)).toBe('千亿大盘'); // 应该用 circ
  });

  test('两个都 null/0/NaN 返 null', () => {
    expect(marketCapBucketLabel(null, null)).toBeNull();
    expect(marketCapBucketLabel(0, 0)).toBeNull();
    expect(marketCapBucketLabel(NaN, NaN)).toBeNull();
    expect(marketCapBucketLabel(-100, null)).toBeNull();
  });
});

describe('V3RecommendationCard / orderDimensions', () => {
  const mkDim = (key: V3DimensionItem['key'], bar: number): V3DimensionItem => ({
    key,
    label:
      key === 'popularity'
        ? '人气'
        : key === 'logic'
          ? '逻辑'
          : key === 'capital'
            ? '资金'
            : '结构',
    bar_value: bar,
    raw_score: bar,
    confidence: 0.8,
    subs_present: 2,
  });

  test('按 fixed 顺序 人气→逻辑→资金→结构 排序', () => {
    const input: V3DimensionItem[] = [
      mkDim('structure', 40),
      mkDim('capital', 86),
      mkDim('popularity', 50),
      mkDim('logic', 80),
    ];
    const out = orderDimensions(input);
    expect(out.map(d => d?.key)).toEqual(['popularity', 'logic', 'capital', 'structure']);
    expect(out.map(d => d?.bar_value)).toEqual([50, 80, 86, 40]);
  });

  test('缺的维度位置返 null', () => {
    const input: V3DimensionItem[] = [mkDim('popularity', 50), mkDim('capital', 86)];
    const out = orderDimensions(input);
    expect(out[0]?.key).toBe('popularity');
    expect(out[1]).toBeNull(); // logic 缺
    expect(out[2]?.key).toBe('capital');
    expect(out[3]).toBeNull(); // structure 缺
  });

  test('空数组返 4 个 null', () => {
    const out = orderDimensions([]);
    expect(out).toEqual([null, null, null, null]);
  });

  test('未知 key 静默丢弃 (不破坏渲染)', () => {
    const input: any[] = [
      mkDim('popularity', 50),
      {
        key: 'unknown_dim',
        bar_value: 99,
        label: '?',
        raw_score: 0,
        confidence: 0,
        subs_present: 0,
      },
    ];
    const out = orderDimensions(input);
    expect(out[0]?.key).toBe('popularity');
    // unknown_dim 不出现
    expect(out.filter(d => d !== null).length).toBe(1);
  });

  test('重复 key 后者覆盖前者 (Map.set 语义)', () => {
    const input: V3DimensionItem[] = [mkDim('popularity', 50), mkDim('popularity', 99)];
    const out = orderDimensions(input);
    expect(out[0]?.bar_value).toBe(99);
  });
});

describe('V3RecommendationCard / playbookVerdictColor (CA-2)', () => {
  test('buy 红 / hold 橙 / observe 蓝 / avoid 绿', () => {
    expect(playbookVerdictColor('buy')).toBe('#dc2626');
    expect(playbookVerdictColor('hold')).toBe('#fa8c16');
    expect(playbookVerdictColor('observe')).toBe('#1890ff');
    expect(playbookVerdictColor('avoid')).toBe('#16a34a');
  });

  test('未知 verdict 兜底灰', () => {
    expect(playbookVerdictColor('xxx' as any)).toBe('#8c8c8c');
  });
});
