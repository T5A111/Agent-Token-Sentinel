/** Runtime configuration from environment variables. */
export function loadConfig(env = process.env) {
  return {
    baseUrl: env.BASE_URL || 'http://localhost:8080',
    timeoutMs: Number(env.TIMEOUT_SECONDS) * 1000,
    retries: env.RETRIES ?? 3,
  };
}
