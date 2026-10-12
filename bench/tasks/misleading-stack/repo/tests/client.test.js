import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { backoffSchedule, describeClient } from '../src/client.js';

test('defaults produce a sane schedule', () => {
  assert.deepEqual(backoffSchedule(loadConfig({})), [100, 200, 400]);
});
test('env overrides are respected', () => {
  const cfg = loadConfig({ RETRIES: '2', TIMEOUT_SECONDS: '0.15' });
  assert.deepEqual(backoffSchedule(cfg), [100, 150]);
});
test('description is human readable', () => {
  assert.equal(describeClient(loadConfig({})), 'http://localhost:8080 (timeout 5000ms, retries at 100/200/400ms)');
});
