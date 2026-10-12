import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify, titleCase, truncate, countWords } from '../src/strings.js';

test('slugify collapses separators and trims dashes', () => {
  assert.equal(slugify('  Hello,  World! '), 'hello-world');
});
test('titleCase lowercases the rest and tolerates extra spaces', () => {
  assert.equal(titleCase('hELLO  wORLD'), 'Hello  World');
});
test('truncate keeps the result within max, ellipsis included', () => {
  assert.equal(truncate('abcdefghij', 5), 'abcd…');
  assert.equal(truncate('abc', 5), 'abc');
});
test('countWords handles empty and padded input', () => {
  assert.equal(countWords(''), 0);
  assert.equal(countWords('  two words  '), 2);
});
