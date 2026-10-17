import { z } from 'zod';

/** One trusted proxy: the loopback keyword, an IP address or a CIDR range. */
const trustedProxySchema = z.union([
  z.literal('loopback'),
  z.ipv4(),
  z.ipv6(),
  z.cidrv4(),
  z.cidrv6(),
]);

/**
 * Whose X-Forwarded-* headers are believed: `false` (no proxy), or a list of proxies.
 * `true` / `*` (trust every client) is rejected: any client could fake its IP and escape throttling.
 */
const trustProxySchema = z
  .string()
  .trim()
  .toLowerCase()
  .default('false')
  .refine((value) => value !== 'true' && value !== '*', {
    error:
      'Trusting every client would let anyone fake their IP. Use "loopback" or explicit IPs/CIDRs.',
  })
  .transform((value) =>
    value === 'false' || value === ''
      ? false
      : value
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean),
  )
  .pipe(z.union([z.literal(false), z.array(trustedProxySchema).min(1)]));

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/, error: 'Must be a postgresql:// URL' }),
    TRUST_PROXY: trustProxySchema,
    SETUP_TOKEN_FILE: z.string().trim().min(1).optional(),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    /**
     * The Docker API: always the read-only socket proxy, never the socket itself — so only
     * tcp:// or http:// (a unix:// socket path is refused).
     */
    DOCKER_HOST: z
      .url({
        protocol: /^(tcp|http)$/,
        error: 'Must be a tcp:// or http:// URL of the Docker socket proxy',
      })
      .default('tcp://127.0.0.1:2375'),
    /** The key that encrypts services' secrets (32 random bytes, base64). Created in development. */
    MASTER_KEY_FILE: z.string().trim().min(1).optional(),
    /**
     * The deploy wrapper's config (root-owned in production): the catalog folder, storage roots
     * and reserved ports — the app reads the same file, so the two never disagree.
     */
    WRAPPER_CONFIG_FILE: z.string().trim().min(1).optional(),
    /**
     * How the executor runs the root wrapper: `sudo` (production) or `direct` — the wrapper from
     * the repo, as the current user, for development and tests. Never `direct` in production.
     */
    EXECUTOR_MODE: z.enum(['sudo', 'direct']).optional(),
    /**
     * The health alerts' watcher (docs/plans/health_alerts.md) runs all the time; `off` only for
     * tests that open and close alerts themselves.
     */
    ALERTS_WATCH: z.enum(['on', 'off']).default('on'),
  })
  .transform((env) => {
    const production = env.NODE_ENV === 'production';
    return {
      ...env,
      SETUP_TOKEN_FILE:
        env.SETUP_TOKEN_FILE ?? (production ? '/var/lib/homelab/setup-token' : '.dev/setup-token'),
      MASTER_KEY_FILE:
        env.MASTER_KEY_FILE ?? (production ? '/etc/homelab/master.key' : '.dev/master.key'),
      WRAPPER_CONFIG_FILE:
        env.WRAPPER_CONFIG_FILE ??
        (production ? '/etc/homelab/wrappers.json' : '.dev/wrappers.json'),
      EXECUTOR_MODE: env.EXECUTOR_MODE ?? (production ? 'sudo' : 'direct'),
    };
  })
  .refine((env) => env.NODE_ENV !== 'production' || env.EXECUTOR_MODE === 'sudo', {
    path: ['EXECUTOR_MODE'],
    error: 'Must be "sudo" in production: "direct" runs the wrapper without sudo',
  });

export type Env = z.infer<typeof envSchema>;

/**
 * `ConfigModule` validate hook: fails startup with a readable list of problems.
 * Zod's messages name the variable and the rule, never the value — DATABASE_URL holds a password.
 */
export function validateEnv(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
