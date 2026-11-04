import { z } from 'zod';

/**
 * Is this machine set up the way Laris needs (docs/plans/machine_check.md)? The checks done as the
 * signed-in person through their helper; signing in and sudo are checked by their own routes.
 */

export const MACHINE_CHECK_HELPER = ['ok', 'unavailable', 'wrong_account'] as const;
export type MachineCheckHelper = (typeof MACHINE_CHECK_HELPER)[number];

/**
 * How this account's apps reach Docker: its user units with the docker group, or system units
 * through sudo — also while it's in the group but its user systemd started before (until restarted).
 */
export const MACHINE_CHECK_DOCKER = ['user_units', 'system_units', 'restart_needed'] as const;
export type MachineCheckDocker = (typeof MACHINE_CHECK_DOCKER)[number];

/** `POST /api/machine-check/person`: codes only, never values. Null: not checked (an earlier step failed). */
export const personCheckSchema = z.object({
  helper: z.enum(MACHINE_CHECK_HELPER),
  userUnits: z.boolean().nullable(),
  docker: z.enum(MACHINE_CHECK_DOCKER).nullable(),
});
export type PersonCheck = z.infer<typeof personCheckSchema>;
