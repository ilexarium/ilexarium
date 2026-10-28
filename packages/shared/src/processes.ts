import { z } from 'zod';

/**
 * The process list (docs/plans/process_list.md): what runs on the machine, like `htop`, read
 * from /proc without privileges; ended over the person's own Linux session — Linux decides what
 * they may end, the app has no rights of its own here.
 */

export const PROCESS_LIMITS = {
  /** People's accounts start here (Debian, Ubuntu, Fedora, Arch: `UID_MIN` in login.defs). */
  minUid: 1000,
  /** …and end here (`UID_MAX`): above it `nobody` (65534) and the like. */
  maxUid: 60000,
  /** A command line is cut after this many characters. */
  commandMax: 1024,
  /** The kernel's largest PID (`pid_max` at most 2^22). */
  maxPid: 4_194_304,
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
  /** Per core, like `htop`: up to 100 for each core (400 on four). */
  cpuPercent: z.number().nonnegative(),
  /** Its CPU time so far, user and system together (htop's TIME+). */
  cpuSeconds: z.number().nonnegative(),
  /** The kernel's priority and the nice value (htop's PRI and NI). */
  priority: z.number().int(),
  nice: z.number().int(),
  /** Resident (RES), virtual (VIRT) and shared (SHR: files and shared memory) bytes. */
  memoryBytes: z.number().nonnegative(),
  virtualBytes: z.number().nonnegative(),
  sharedBytes: z.number().nonnegative(),
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
});
export type Process = z.infer<typeof processSchema>;

/** A process's identity across readings: a PID used again later has another start time. */
export const processKey = (p: { pid: number; startTicks: string }) => `${p.pid}:${p.startTicks}`;

/** The page's header: how busy the machine is, and whether anything waits. */
export const processesSummarySchema = z.object({
  cores: z.number().int().positive(),
  /** Share of the whole machine (all cores together), 0–100. */
  cpuPercent: z.number().min(0).max(100),
  /** Load average over 1, 5 and 15 minutes. */
  load: z.tuple([z.number(), z.number(), z.number()]),
  memory: z.object({
    totalBytes: z.number().nonnegative(),
    availableBytes: z.number().nonnegative(),
    swapTotalBytes: z.number().nonnegative(),
    swapUsedBytes: z.number().nonnegative(),
  }),
  /**
   * Share of the last minute some processes waited for CPU, memory or disk (`/proc/pressure`,
   * `some avg60`), 0–100; null where the kernel keeps no pressure data.
   */
  pressure: z.object({ cpu: z.number(), memory: z.number(), io: z.number() }).nullable(),
});
export type ProcessesSummary = z.infer<typeof processesSummarySchema>;

/** The `processes` topic's snapshot and updates: every process, every 2 s. */
export const processesUpdateSchema = z.object({
  processes: z.array(processSchema),
  summary: processesSummarySchema,
  /** /proc hides other users' processes (`hidepid`): the list is incomplete. */
  partial: z.boolean(),
});
export type ProcessesUpdate = z.infer<typeof processesUpdateSchema>;

/**
 * `POST /processes/signal`: end a process (TERM), or force it (KILL), as the Linux account — through
 * its unlocked sudo when it is another account's.
 */
export const processSignalRequestSchema = z.strictObject({
  pid: z.number().int().positive().max(PROCESS_LIMITS.maxPid),
  startTicks: processStartTicksSchema,
  signal: processSignalSchema,
});
export type ProcessSignalRequest = z.infer<typeof processSignalRequestSchema>;

export const PROCESS_ERROR_CODES = {
  /** Gone (ended meanwhile, or the PID now names another process). */
  processNotFound: 'process_not_found',
  /** Never offered: PID 1, kernel threads. */
  processProtected: 'process_protected',
  /** Linux refused: the account may not signal this process. */
  processNotPermitted: 'process_not_permitted',
  signalFailed: 'signal_failed',
  timedOut: 'timed_out',
  auditUnavailable: 'audit_unavailable',
} as const;
export type ProcessErrorCode = (typeof PROCESS_ERROR_CODES)[keyof typeof PROCESS_ERROR_CODES];
