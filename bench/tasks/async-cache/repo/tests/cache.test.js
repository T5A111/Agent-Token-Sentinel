import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cache } from '../src/cache.js';

test('concurrent gets share a single load', async () => {
  let calls = 0;
  const cache = new Cache(async (k) => { calls++; return k.toUpperCase(); });
  const [a, b] = await Promise.all([cache.get('x'), cache.get('x')]);
  assert.equal(a, 'X');
  assert.equal(b, 'X');
  assert.equal(calls, 1);
});

test('a failed load is retried on the next get', async () => {
  let calls = 0;
  const cache = new Cache(async () => {
    calls++;
    if (calls === 1) throw new Error('network down');
    return 'ok';
  });
  await assert.rejects(cache.get('k'), /network down/);
  assert.equal(await cache.get('k'), 'ok');
  assert.equal(calls, 2);
});

test('loader errors thrown synchronously still reject', async () => {
  const cache = new Cache(() => { throw new Error('boom'); });
  await assert.rejects(cache.get('k'), /boom/);
});
