import { describe, expect, test } from '@jest/globals';
import {
  ContractSchemaError,
  assertExactObject,
  jcsCanonicalize,
  sha256Text,
  strictIso8601,
} from '../contractSchema';

describe('tab 6/7 exact contract schema primitives', () => {
  test('enforces required, optional, and unknown keys uniformly', () => {
    expect(assertExactObject({ id: '1', note: 'ok' }, ['id'], ['note'], 'row')).toEqual({
      id: '1',
      note: 'ok',
    });
    expect(() => assertExactObject({ note: 'x' }, ['id'], ['note'], 'row')).toThrow(
      /missing required fields/
    );
    expect(() => assertExactObject({ id: '1', shadow: true }, ['id'], [], 'row')).toThrow(
      /unknown fields/
    );
  });

  test('validates timezone-bearing ISO8601 and rejects malformed dates', () => {
    expect(strictIso8601('2026-07-10T06:00:00Z', 'as_of')).toBe('2026-07-10T06:00:00Z');
    expect(() => strictIso8601('2026-07-10', 'as_of')).toThrow(ContractSchemaError);
    expect(() => strictIso8601('not-a-date', 'as_of')).toThrow(ContractSchemaError);
  });

  test('matches RFC SHA-256 and deterministic JCS vectors', () => {
    expect(sha256Text('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
    expect(jcsCanonicalize({ z: 0, a: [true, 'x'], omitted: undefined })).toBe(
      '{"a":[true,"x"],"z":0}'
    );
  });
});
