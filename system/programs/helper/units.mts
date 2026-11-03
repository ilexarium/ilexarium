// The machine's service units (docs/plans/system_services.md). Read as this account — systemd lets
// anyone read them —, started, stopped and restarted by laris-root. Only systemd's machine output:
// JSON for the lists, `key=value` for one unit's fixed properties.

import { BAD_REQUEST, ok, refused, said, type Answer, type Request } from './answers.mts';
import {
  MESSAGE_MAX,
  PROGRAMS,
  QUICK_TIMEOUT_MS,
  SERVICE_COMMANDS,
  SERVICE_PATTERN,
  SERVICE_PROPERTIES,
  UNIT_CONTROL_TIMEOUT_MS,
  UNITS_ANSWER_MAX,
  UNITS_OUTPUT_MAX,
  UNIT_TEXT_MAX,
} from './config.mts';
import { run, type RunResult } from './run.mts';

const service = (unit: unknown): unit is string =>
  typeof unit === 'string' && SERVICE_PATTERN.test(unit);

const text = (value: unknown) => (typeof value === 'string' ? value.slice(0, UNIT_TEXT_MAX) : '');

function refusal(result: RunResult): Answer {
  if (result.timedOut) return refused('timed_out');
  if (result.missing) return refused('unavailable');
  return refused('failed');
}

function jsonArray(output: string): Record<string, unknown>[] | null {
  try {
    const parsed = JSON.parse(output) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(
          (entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object',
        )
      : null;
  } catch {
    return null;
  }
}

/** Failed first, then active, then the rest: what's kept when not all of them fit. */
const rank = (active: string) => (active === 'failed' ? 0 : active === 'inactive' ? 2 : 1);

/** Every service unit systemd knows, with its unit file's state. */
export async function listUnits(): Promise<Answer> {
  const options = { timeoutMs: QUICK_TIMEOUT_MS, outputMax: UNITS_OUTPUT_MAX };
  const [units, files] = await Promise.all([
    run(
      PROGRAMS.systemctl,
      ['list-units', '--type=service', '--all', '--output=json', '--no-pager'],
      options,
    ),
    run(
      PROGRAMS.systemctl,
      ['list-unit-files', '--type=service', '--output=json', '--no-pager'],
      options,
    ),
  ]);
  if (units.code !== 0) return refusal(units);
  const listed = jsonArray(units.stdout);
  if (!listed) return refused('failed');
  // Without the files' states the list still helps: they're left empty.
  const states = new Map<string, string>();
  for (const file of (files.code === 0 && jsonArray(files.stdout)) || []) {
    if (service(file['unit_file']) && typeof file['state'] === 'string') {
      states.set(file['unit_file'], text(file['state']));
    }
  }
  const all = listed
    .filter((unit) => service(unit['unit']))
    .map((unit) => ({
      unit: unit['unit'] as string,
      load: text(unit['load']),
      active: text(unit['active']),
      sub: text(unit['sub']),
      description: text(unit['description']),
      enabled: states.get(unit['unit'] as string) ?? null,
    }))
    .sort((a, b) => rank(a.active) - rank(b.active));
  const kept = [];
  let size = 0;
  for (const unit of all) {
    size += JSON.stringify(unit).length + 1;
    if (size > UNITS_ANSWER_MAX) break;
    kept.push(unit);
  }
  return ok({ units: kept, truncated: kept.length < all.length });
}

/** One unit's fixed properties, as systemd says them (an unknown unit: `LoadState=not-found`). */
export async function showUnit(request: Request): Promise<Answer> {
  const unit = request['unit'];
  if (!service(unit)) return BAD_REQUEST;
  const result = await run(
    PROGRAMS.systemctl,
    [
      'show',
      '--timestamp=unix',
      '--no-pager',
      `--property=${SERVICE_PROPERTIES.join(',')}`,
      '--',
      unit,
    ],
    { timeoutMs: QUICK_TIMEOUT_MS },
  );
  if (result.code !== 0) return refusal(result);
  const properties: Record<string, string> = {};
  for (const line of result.stdout.split('\n')) {
    const equals = line.indexOf('=');
    const key = line.slice(0, equals);
    if (equals > 0 && (SERVICE_PROPERTIES as readonly string[]).includes(key)) {
      properties[key] = text(line.slice(equals + 1));
    }
  }
  return ok({ properties });
}

/**
 * Starts, stops or restarts a unit — laris-root's (as the account, systemctl would ask polkit).
 * It waits for systemd's job; past the wait the job goes on, and its state says how it went.
 */
export async function controlUnit(request: Request): Promise<Answer> {
  const { unit, command } = request;
  if (!service(unit)) return BAD_REQUEST;
  if (!SERVICE_COMMANDS.includes(command as (typeof SERVICE_COMMANDS)[number])) {
    return BAD_REQUEST;
  }
  const result = await run(
    PROGRAMS.systemctl,
    [command as string, '--no-ask-password', '--', unit],
    { timeoutMs: UNIT_CONTROL_TIMEOUT_MS },
  );
  if (result.code === 0) return ok();
  if (result.timedOut || result.missing) return refusal(result);
  return { ok: false, error: 'failed', message: said(result).slice(-MESSAGE_MAX) } as Answer;
}
