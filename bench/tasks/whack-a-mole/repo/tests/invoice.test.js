import { test } from 'node:test';
import assert from 'node:assert/strict';
import { invoiceTotal } from '../src/invoice.js';

test('sums simple amounts', () => {
  assert.equal(invoiceTotal([{ amount: '$10.00', qty: 2 }, { amount: '$5.50', qty: 1 }]), 25.5);
});
test('handles thousands separators', () => {
  assert.equal(invoiceTotal([{ amount: '$1,234.50', qty: 2 }]), 2469);
});
