import { fileURLToPath } from 'node:url';
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

/** The proxy's socket in production: one plain file name under /run/ilex/, no `..`. */
export const PROXY_SOCKET = /^unix:\/\/\/run\/ilex\/(?:[a-z0-9-]+\/)?[a-z0-9-]+\.sock$/;

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
    /**
     * Unset: `loopback` in production — a proxy in front (whichever the person chose) reaches the
     * app on 127.0.0.1, so it's on this machine; browsers on the HTTPS port connect directly, with
     * their own addresses. None otherwise.
     */
    TRUST_PROXY: trustProxySchema.optional(),
    SETUP_TOKEN_FILE: z.string().trim().min(1).optional(),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    /**
     * The address the app listens on. Production: 127.0.0.1 unless set — only the HTTPS proxy in
     * front of it reaches it. Development: every interface (the dev server's proxy may use IPv6
     * for "localhost").
     */
    HOST: z.union([z.ipv4(), z.ipv6()]).optional(),
    /**
     * Where browsers on the network reach the app over HTTPS with its own certificate
     * (ilex-https.socket; the installer writes 0.0.0.0 unless told --local-only). Unset or empty:
     * off — this machine only, through the person's own proxy.
     */
    HTTPS_HOST: z.preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      z.union([z.ipv4(), z.ipv6()]).optional(),
    ),
    HTTPS_PORT: z.coerce.number().int().min(1).max(65535).default(3443),
    /** The HTTPS certificate and its key (PEM): the installer's self-signed one, or the person's. */
    TLS_CERT_FILE: z.string().trim().startsWith('/').optional(),
    TLS_KEY_FILE: z.string().trim().startsWith('/').optional(),
    /**
     * The Docker API: always the socket proxy, never Docker's own socket — tcp:// or http://
     * (development), or the proxy's Unix socket under /run/ilex/ (production: only the app's
     * group can reach it). Any other unix:// path is refused.
     */
    DOCKER_HOST: z
      .string()
      .trim()
      .default('tcp://127.0.0.1:2375')
      .refine((value) => PROXY_SOCKET.test(value) || isProxyUrl(value), {
        error:
          'Must be a tcp:// or http:// URL of the Docker socket proxy, or unix:///run/ilex/<name>.sock',
      }),
    /**
     * The built web app (its index.html and files), served by the app on the same origin as the
     * API (production). Unset: not served (development: the Angular dev server does).
     */
    WEB_ROOT: z.string().trim().startsWith('/').optional(),
    /** The key that encrypts services' secrets (32 random bytes, base64). Created in development. */
    MASTER_KEY_FILE: z.string().trim().min(1).optional(),
    /**
     * The root programs' config (root-owned in production) — the app reads the same file, so the
     * two never disagree.
     */
    WRAPPER_CONFIG_FILE: z.string().trim().min(1).optional(),
    /** The app templates (catalog/): installed with Ilexarium, the repository's own in development. */
    CATALOG_DIR: z.string().trim().startsWith('/').optional(),
    /**
     * How the root programs (ilex-backup, ilex-disk) are started: `sudo` — through the signed-in
     * person's own sudo, by their helper (production) — or `direct`: the repository's program as
     * the developer, without sudo (development and tests only).
     */
    ROOT_PROGRAMS: z.enum(['sudo', 'direct']).optional(),
    /**
     * The health alerts' watcher runs all the time; `off` only for
     * tests that open and close alerts themselves.
     */
    ALERTS_WATCH: z.enum(['on', 'off']).default('on'),
    /**
     * The machine's own SSH server, for the Linux sign-in and the file explorer:
     * always on this machine (127.0.0.1). Port 22 in
     * production; development uses the stand-in container (dev/sshd, 2222).
     */
    SSH_PORT: z.coerce.number().int().min(1).max(65535).optional(),
    /** The folder whose `ssh_host_*_key.pub` are pinned: only that server is trusted. */
    SSH_HOST_KEYS: z.string().trim().min(1).optional(),
    /**
     * The helper the server starts in each Linux session, as that
     * account: where the installer puts it, also in the dev SSH container. SSH runs it as one
     * command line, so a plain absolute path only.
     */
    LINUX_HELPER: z
      .string()
      .regex(/^(?:\/[\w.-]+)+$/, 'An absolute path of letters, digits, "_", "." and "-"')
      .refine((path) => !path.split('/').includes('..'), 'No ".." in the path')
      .default('/opt/ilex/libexec/ilex-helper.mts'),
  })
  .transform((env) => {
    const production = env.NODE_ENV === 'production';
    return {
      ...env,
      SETUP_TOKEN_FILE:
        env.SETUP_TOKEN_FILE ?? (production ? '/var/lib/ilex/app/setup-token' : '.dev/setup-token'),
      MASTER_KEY_FILE:
        env.MASTER_KEY_FILE ?? (production ? '/etc/ilex/master.key' : '.dev/master.key'),
      WRAPPER_CONFIG_FILE:
        env.WRAPPER_CONFIG_FILE ?? (production ? '/etc/ilex/wrappers.json' : '.dev/wrappers.json'),
      ROOT_PROGRAMS: env.ROOT_PROGRAMS ?? (production ? 'sudo' : 'direct'),
      CATALOG_DIR:
        env.CATALOG_DIR ??
        (production
          ? '/opt/ilex/catalog'
          : fileURLToPath(new URL('../../../../catalog', import.meta.url))),
      HOST: env.HOST ?? (production ? '127.0.0.1' : undefined),
      TLS_CERT_FILE:
        env.TLS_CERT_FILE ?? (production ? '/etc/ilex/tls/cert.pem' : '.dev/tls/cert.pem'),
      TLS_KEY_FILE: env.TLS_KEY_FILE ?? (production ? '/etc/ilex/tls/key.pem' : '.dev/tls/key.pem'),
      TRUST_PROXY: env.TRUST_PROXY ?? (production ? ['loopback'] : false),
      SSH_PORT: env.SSH_PORT ?? (production ? 22 : 2222),
      SSH_HOST_KEYS: env.SSH_HOST_KEYS ?? (production ? '/etc/ssh' : '.dev/sshd'),
    };
  })
  .refine((env) => env.NODE_ENV !== 'production' || env.ROOT_PROGRAMS === 'sudo', {
    path: ['ROOT_PROGRAMS'],
    error: 'Must be "sudo" in production: "direct" runs the root programs without sudo',
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
