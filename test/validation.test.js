import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults, validatePolicy } from '../src/validation.js';

test('accepts a motion capture policy and normalizes known keys', () => {
  assert.deepEqual(validatePolicy({ ...defaults, enabled: true, offsets: [0, 5, 15, 30], ignored: 'no' }),
    { ...defaults, enabled: true });
});
test('rejects excessive, repeated and nonzero initial capture offsets', () => {
  for (const offsets of [[2, 5], [0, 2, 2], [0, 601], Array.from({length: 11}, (_, n) => n)])
    assert.throws(() => validatePolicy({ ...defaults, offsets }));
});
test('rejects invalid retention and analysis mode', () => {
  assert.throws(() => validatePolicy({ ...defaults, retention_days: 0 }));
  assert.throws(() => validatePolicy({ ...defaults, analysis_mode: 'anything' }));
});
