import { loadConfig } from './config.js';

/** Exponential backoff delays (ms) for each retry, capped at the timeout. */
export function backoffSchedule(config = loadConfig()) {
  return Array.from({ length: config.retries }, (_, i) => Math.min(100 * 2 ** i, config.timeoutMs));
}

export function describeClient(config = loadConfig()) {
  const schedule = backoffSchedule(config);
  return `${config.baseUrl} (timeout ${config.timeoutMs}ms, retries at ${schedule.join('/')}ms)`;
}
