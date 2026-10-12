/** Runtime configuration from environment variables. */
export function loadConfig(env = process.env) {
  const timeoutSeconds = env.TIMEOUT_SECONDS === undefined ? 5 : Number(env.TIMEOUT_SECONDS);
  const retries = env.RETRIES === undefined ? 3 : Number.parseInt(env.RETRIES, 10);
  return {
    baseUrl: env.BASE_URL || 'http://localhost:8080',
    timeoutMs: timeoutSeconds * 1000,
    retries,
  };
}
