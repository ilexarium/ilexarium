import { z } from 'zod';

/**
 * The process list (docs/plans/process_list.md): what runs on the machine, like `htop`, read
 * from /proc without privileges; a person's runaway process can be ended through the process
 * wrapper (as that person, never as root).
 */

export const PROCESS_LIMITS = {
  /** People's accounts start here (Debian, Ubuntu, Fedora, Arch: `UID_MIN` in login.defs). */
  minUid: 1000,
  /** …and end here (`UID_MAX`): above it `nobody` (65534) and the like. */
  maxUid: 60000,
  /** A command line is cut after this many characters. */
  commandMax: 1024,
  /** "Force end" is offered this long after "End" if the process still runs. */
  forceAfterSeconds: 5,
} as const;

export const PROCESS_SIGNALS = ['TERM', 'KILL'] as const;
export const processSignalSchema = z.enum(PROCESS_SIGNALS);
export type ProcessSignal = z.infer<typeof processSignalSchema>;

/**
 * Its start time since boot in clock ticks (field 22 of /proc/<pid>/stat), as digits: with the
 * PID it names one process — a PID used again later has another start time.
 */
export const processStartTicksSchema = z.string().regex(/^\d{1,20}$/);

/** The kernel's states: running, sleeping, disk sleep (D), zombie, stopped, idle, … */
export const PROCESS_STATES = [
  'running',
  'sleeping',
  'waiting',
  'zombie',
  'stopped',
  'idle',
  'other',
] as const;
export const processStateSchema = z.enum(PROCESS_STATES);
export type ProcessState = z.infer<typeof processStateSchema>;

export const processSchema = z.object({
  pid: z.number().int().positive(),
  startTicks: processStartTicksSchema,
  /** The kernel's short name (`comm`, at most 15 characters). */
  name: z.string(),
  /** The command line, cut at `commandMax`; empty for kernel threads. May contain secrets. */
  command: z.string(),
  uid: z.number().int().nonnegative(),
  /** The account's name, or null if /etc/passwd doesn't know it. */
  user: z.string().nullable(),
  state: processStateSchema,
  /** Share of the whole machine (all cores together), 0–100. */
  cpuPercent: z.number().min(0).max(100),
  memoryBytes: z.number().nonnegative(),
  /** Share of the machine's memory, 0–100. */
  memoryPercent: z.number().min(0).max(100),
  startedAt: z.iso.datetime().nullable(),
  /** A kernel thread (no program of its own). */
  kernel: z.boolean(),
  /** Hidden at first: kernel threads, and system accounts' processes outside containers. */
  system: z.boolean(),
  /** The container it runs in, or null. */
  container: z
    .object({
      name: z.string().nullable(),
      /** The catalog entry, for a service installed here. */
      catalogId: z.string().nullable(),
    })
    .nullable(),
  /** Can be ended here: a person's process (not the app's own, not in a container). */
  endable: z.boolean(),
});
export type Process = z.infer<typeof processSchema>;

/** A process's identity across readings: a PID used again later has another start time. */
export const processKey = (p: { pid: number; startTicks: string }) => `${p.pid}:${p.startTicks}`;

/** The `processes` topic's snapshot and updates: every process, every 2 s. */
export const processesUpdateSchema = z.object({
  processes: z.array(processSchema),
  /** /proc hides other users' processes (`hidepid`): the list is incomplete. */
  partial: z.boolean(),
});
export type ProcessesUpdate = z.infer<typeof processesUpdateSchema>;

/** `POST /processes/signal`: end a process (TERM), or force it (KILL). */
export const processSignalRequestSchema = z.strictObject({
  pid: z.number().int().positive().max(4_194_304),
  startTicks: processStartTicksSchema,
  signal: processSignalSchema,
});
export type ProcessSignalRequest = z.infer<typeof processSignalRequestSchema>;

export const PROCESS_ERROR_CODES = {
  /** Gone (ended meanwhile, or the PID now names another process). */
  processNotFound: 'process_not_found',
  /** Not a person's process: root, a system account, the app's own, in a container, PID 1. */
  processProtected: 'process_protected',
  signalFailed: 'signal_failed',
  invalidRequest: 'invalid_request',
  timedOut: 'timed_out',
  executorUnavailable: 'executor_unavailable',
  auditUnavailable: 'audit_unavailable',
} as const;
export type ProcessErrorCode = (typeof PROCESS_ERROR_CODES)[keyof typeof PROCESS_ERROR_CODES];
