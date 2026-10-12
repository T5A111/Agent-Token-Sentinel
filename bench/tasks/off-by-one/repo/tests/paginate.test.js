import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paginate } from '../src/paginate.js';

const items = Array.from({ length: 23 }, (_, i) => i + 1);

test('first page starts at the first item', () => {
  assert.deepEqual(paginate(items, 1, 10).items, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});
test('last page holds the remainder', () => {
  assert.deepEqual(paginate(items, 3, 10).items, [21, 22, 23]);
});
test('totalPages counts a partial last page', () => {
  assert.equal(paginate(items, 1, 10).totalPages, 3);
  assert.equal(paginate([], 1, 10).totalPages, 0);
});
