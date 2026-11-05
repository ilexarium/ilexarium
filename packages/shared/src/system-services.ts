import { z } from 'zod';

/**
 * The host's systemd services (docs/plans/system_services.md): read as the signed-in Linux account
 * (systemd lets anyone read them), started, stopped and restarted through its unlocked sudo.
 * States are systemd's own words, shown as they are.
 */

/**
 * A service unit's name, as systemd writes it (`getty@tty1.service`, escapes like `\x2d`); never a
 * leading `-` (it would read as an option). The helper checks the same (rules-match-app.spec.ts).
 */
export const SYSTEM_SERVICE_NAME_PATTERN = /^(?!-)[A-Za-z0-9:_.\\@-]{1,240}\.service$/;
export const systemServiceNameSchema = z.string().regex(SYSTEM_SERVICE_NAME_PATTERN);

/**
 * Laris's own, and what it runs on — restarting Docker restarts Laris's platform and then Laris
 * (their `Requires=`), the system bus and a person's own units (apps run as them) take others
 * down: never started, stopped or restarted from here (like `laris.protected` containers).
 */
const LARIS_UNITS = /^(?:laris(?:-[^/]+)?|docker|containerd|dbus|dbus-broker|user@[^/]+)\.service$/;
/** What Laris needs to sign in to the machine (SSH, systemd's own): never stopped. */
const ESSENTIAL_UNITS = /^(?:ssh|sshd|systemd-[^/]+)\.service$/;

export const SYSTEM_SERVICE_PROTECTIONS = ['laris', 'essential'] as const;
export const systemServiceProtectionSchema = z.enum(SYSTEM_SERVICE_PROTECTIONS);
export type SystemServiceProtection = z.infer<typeof systemServiceProtectionSchema>;

/** How a unit is protected, by any of its names (an alias protects like its unit). */
export function systemServiceProtection(names: string[]): SystemServiceProtection | null {
  if (names.some((name) => LARIS_UNITS.test(name))) return 'laris';
  if (names.some((name) => ESSENTIAL_UNITS.test(name))) return 'essential';
  return null;
}

export const SYSTEM_SERVICE_ACTIONS = ['start', 'stop', 'restart'] as const;
export const systemServiceActionSchema = z.enum(SYSTEM_SERVICE_ACTIONS);
export type SystemServiceAction = z.infer<typeof systemServiceActionSchema>;

/** What a protection still allows. */
export function systemServiceActionAllowed(
  protection: SystemServiceProtection | null,
  action: SystemServiceAction,
): boolean {
  if (protection === 'laris') return false;
  if (protection === 'essential') return action !== 'stop';
  return true;
}

export const systemServiceSchema = z.object({
  name: z.string(),
  description: z.string(),
  /** systemd's words: `loaded`, `not-found`, `masked`, … */
  load: z.string(),
  /** `active`, `inactive`, `failed`, `activating`, `deactivating`, `reloading`, … */
  active: z.string(),
  /** The finer state: `running`, `exited`, `dead`, `failed`, … */
  sub: z.string(),
  /** Its unit file's state (`enabled`, `disabled`, `static`, …); null without one. */
  enabled: z.string().nullable(),
  protection: systemServiceProtectionSchema.nullable(),
});
export type SystemService = z.infer<typeof systemServiceSchema>;

/** `GET /system/services`: every service unit systemd knows. */
export const systemServicesResponseSchema = z.object({
  services: z.array(systemServiceSchema),
  /** More than the helper passes on: the failed and active ones are kept first. */
  truncated: z.boolean(),
});
export type SystemServicesResponse = z.infer<typeof systemServicesResponseSchema>;

/** `GET /system/services/:name`. */
export const systemServiceDetailsSchema = systemServiceSchema.extend({
  /** When it last changed state; null if never. */
  since: z.iso.datetime().nullable(),
  /** Its main process; null when none runs. */
  mainPid: z.number().int().positive().nullable(),
  /** Memory its processes use; null where systemd doesn't count it. */
  memoryBytes: z.number().nonnegative().nullable(),
  /** How it last ended: `success`, `exit-code`, `signal`, `timeout`, … */
  result: z.string(),
  /** The main process's exit status; null if it never ran. */
  exitStatus: z.number().int().nullable(),
  /** How often systemd restarted it on its own. */
  restarts: z.number().int().nonnegative().nullable(),
  /** Its unit file; null without one. */
  unitFile: z.string().nullable(),
});
export type SystemServiceDetails = z.infer<typeof systemServiceDetailsSchema>;

export const systemServiceParamsSchema = z.strictObject({ name: systemServiceNameSchema });
export type SystemServiceParams = z.infer<typeof systemServiceParamsSchema>;

export const systemServiceActionParamsSchema = z.strictObject({
  name: systemServiceNameSchema,
  action: systemServiceActionSchema,
});
export type SystemServiceActionParams = z.infer<typeof systemServiceActionParamsSchema>;

export const systemServicePath = (name: string) =>
  `/api/system/services/${encodeURIComponent(name)}`;

export const SYSTEM_SERVICE_ERROR_CODES = {
  notFound: 'service_not_found',
  /** Laris's own, or one it needs (stop): not from here. */
  protected: 'service_protected',
  /** systemctl said no (the unit failed to start, or the job was refused). */
  actionFailed: 'service_action_failed',
  /** Still starting or stopping after the helper's wait: its state says how it went. */
  timedOut: 'service_timed_out',
  /** systemctl couldn't be asked (missing, or no answer). */
  unavailable: 'services_unavailable',
  auditUnavailable: 'audit_unavailable',
} as const;
export type SystemServiceErrorCode =
  (typeof SYSTEM_SERVICE_ERROR_CODES)[keyof typeof SYSTEM_SERVICE_ERROR_CODES];
