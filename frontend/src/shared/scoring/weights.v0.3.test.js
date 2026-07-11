import { describe, expect, test } from '@jest/globals';
import { getWeights, validateWeightsSum } from './weights';

const EXPECTED_REGISTRY = {
  us_preferred: {
    quality: 0.2,
    growth: 0.2,
    valuation: 0.15,
    moat: 0.2,
    trend: 0.15,
    risk: 0.1,
  },
  multibagger: {
    quality: 0.1,
    growth: 0.3,
    valuation: 0.1,
    moat: 0.15,
    trend: 0.2,
    risk: 0.15,
  },
  japan_blue_chip: {
    quality: 0.25,
    growth: 0.15,
    valuation: 0.15,
    moat: 0.2,
    trend: 0.15,
    risk: 0.1,
  },
  korea_semiconductor_chain: {
    quality: 0.15,
    growth: 0.3,
    valuation: 0.1,
    moat: 0.15,
    trend: 0.2,
    risk: 0.1,
  },
  japan_multibagger: {
    quality: 0.1,
    growth: 0.25,
    valuation: 0.1,
    moat: 0.15,
    trend: 0.25,
    risk: 0.15,
  },
  korea_multibagger: {
    quality: 0.1,
    growth: 0.3,
    valuation: 0.1,
    moat: 0.1,
    trend: 0.25,
    risk: 0.15,
  },
};

describe('scoring v0.3 weight registry', () => {
  test.each(Object.entries(EXPECTED_REGISTRY))(
    '%s matches D1 and sums to one',
    (profile, expected) => {
      const weights = getWeights(profile);
      expect(weights).toEqual(expected);
      expect(() => validateWeightsSum(weights)).not.toThrow();
    }
  );

  test('custom has no invented registry default', () => {
    expect(() => getWeights('custom')).toThrow('Unknown weight profile: custom');
  });
});
