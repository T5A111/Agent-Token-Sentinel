import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refundTotal } from '../src/refund.js';
import { parseAmount } from '../src/money.js';

test('negative amounts', () => {
  assert.equal(refundTotal(['-$5.00', '-$1,000.00']), -1005);
});
test('accounting-style negatives', () => {
  assert.equal(refundTotal(['(5.00)', '($2.50)']), -7.5);
});
test('garbage is rejected, not silently NaN', () => {
  assert.throws(() => parseAmount('abc'), TypeError);
});
