/** The proxy the e2e tests use (vitest.config.e2e.ts), as host and port. */
export const proxy = (() => {
  const url = new URL(process.env.DOCKER_HOST ?? 'tcp://127.0.0.1:2375');
  return { host: url.hostname, port: Number(url.port || 2375), http: `http://${url.host}` };
})();

/** Whether the dev proxy (npm run db:up) answers; tests that need it are skipped otherwise. */
export async function proxyReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${proxy.http}/_ping`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}
