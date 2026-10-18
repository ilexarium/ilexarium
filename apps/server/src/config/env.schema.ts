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

/** The proxy's socket in production: one plain file name under /run/homelab/, no `..`. */
export const PROXY_SOCKET = /^unix:\/\/\/run\/homelab\/(?:[a-z0-9-]+\/)?[a-z0-9-]+\.sock$/;

function isProxyUrl(value: string): boolean {
  try {
    return /^(tcp|http):$/.test(new URL(value).protocol);
  } catch {
    return false;
  }
}

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/, error: 'Must be a postgresql:// URL' }),
    TRUST_PROXY: trustProxySchema,
    SETUP_TOKEN_FILE: z.string().trim().min(1).optional(),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    /**
     * The address the app listens on. Production: 127.0.0.1 unless set — only the HTTPS proxy in
     * front of it (tailscale serve) reaches it. Development: every interface (the dev server's
     * proxy may use IPv6 for "localhost").
     */
    HOST: z.union([z.ipv4(), z.ipv6()]).optional(),
    /**
     * The Docker API: always the socket proxy, never Docker's own socket — tcp:// or http://
     * (development), or the proxy's Unix socket under /run/homelab/ (production: only the app's
     * group can reach it). Any other unix:// path is refused.
     */
    DOCKER_HOST: z
      .string()
      .trim()
      .default('tcp://127.0.0.1:2375')
      .refine((value) => PROXY_SOCKET.test(value) || isProxyUrl(value), {
        error:
          'Must be a tcp:// or http:// URL of the Docker socket proxy, or unix:///run/homelab/<name>.sock',
      }),
    /**
     * The built web app (its index.html and files), served by the app on the same origin as the
     * API (production). Unset: not served (development: the Angular dev server does).
     */
    WEB_ROOT: z.string().trim().startsWith('/').optional(),
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
        env.SETUP_TOKEN_FILE ??
        (production ? '/var/lib/homelab/app/setup-token' : '.dev/setup-token'),
      MASTER_KEY_FILE:
        env.MASTER_KEY_FILE ?? (production ? '/etc/homelab/master.key' : '.dev/master.key'),
      WRAPPER_CONFIG_FILE:
        env.WRAPPER_CONFIG_FILE ??
        (production ? '/etc/homelab/wrappers.json' : '.dev/wrappers.json'),
      EXECUTOR_MODE: env.EXECUTOR_MODE ?? (production ? 'sudo' : 'direct'),
      HOST: env.HOST ?? (production ? '127.0.0.1' : undefined),
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
