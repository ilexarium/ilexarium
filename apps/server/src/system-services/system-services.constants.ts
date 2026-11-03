import { HttpStatus } from '@nestjs/common';
import {
  FILES_ERROR_CODES,
  type FilesErrorCode,
  SYSTEM_SERVICE_ERROR_CODES,
  type SystemServiceAction,
  type SystemServiceErrorCode,
} from '@laris/shared';
import { z } from 'zod';

type ApiCode = SystemServiceErrorCode | FilesErrorCode;

/** Per IP, for starting, stopping and restarting; reading is the page's every 10 s. */
export const ACTION_LIMIT = { default: { limit: 20, ttl: 60_000 } };
/** Above the helper's own: 30 s for systemctl's lists, 100 s for a start or stop. */
export const READ_TIMEOUT_MS = 35_000;
export const CONTROL_TIMEOUT_MS = 110_000;

/** The helper's refusals, as the API says them (sudo's: the Linux session's). */
export const HELPER_ERRORS: Record<string, ApiCode> = {
  failed: SYSTEM_SERVICE_ERROR_CODES.actionFailed,
  timed_out: SYSTEM_SERVICE_ERROR_CODES.timedOut,
  unavailable: SYSTEM_SERVICE_ERROR_CODES.unavailable,
  sudo_required: FILES_ERROR_CODES.sudoRequired,
  sudo_not_allowed: FILES_ERROR_CODES.sudoNotAllowed,
  sudo_unavailable: FILES_ERROR_CODES.sudoNotAllowed,
  ended: FILES_ERROR_CODES.helperUnavailable,
};

/** `units.list`'s answer (system/programs/helper/units.mts). */
export const helperUnitsSchema = z.object({
  units: z.array(
    z.object({
      unit: z.string(),
      load: z.string(),
      active: z.string(),
      sub: z.string(),
      description: z.string(),
      enabled: z.string().nullable(),
    }),
  ),
  truncated: z.boolean(),
});

/** `units.show`'s answer: systemd's properties as it wrote them. */
export const helperPropertiesSchema = z.object({ properties: z.record(z.string(), z.string()) });

/** systemd's "no limit" for a byte count (2^64 − 1). */
export const UNSET_BYTES = '18446744073709551615';

/** Never 401: that means the app session is gone (the Linux side's rule). */
export const ERROR_STATUS: Record<SystemServiceErrorCode, HttpStatus> = {
  [SYSTEM_SERVICE_ERROR_CODES.notFound]: HttpStatus.NOT_FOUND,
  [SYSTEM_SERVICE_ERROR_CODES.protected]: HttpStatus.FORBIDDEN,
  [SYSTEM_SERVICE_ERROR_CODES.actionFailed]: HttpStatus.BAD_GATEWAY,
  [SYSTEM_SERVICE_ERROR_CODES.timedOut]: HttpStatus.GATEWAY_TIMEOUT,
  [SYSTEM_SERVICE_ERROR_CODES.unavailable]: HttpStatus.SERVICE_UNAVAILABLE,
  [SYSTEM_SERVICE_ERROR_CODES.auditUnavailable]: HttpStatus.SERVICE_UNAVAILABLE,
};

export const ACTION_FAILED_MESSAGES: Record<SystemServiceAction, string> = {
  start: 'The service was not started',
  stop: 'The service was not stopped',
  restart: 'The service was not restarted',
};
