/** A container as the process list names it: by its full ID. */
export interface ContainerName {
  name: string;
  /** The catalog entry, for a service installed here (Compose project `hl-<id>`). */
  catalogId: string | null;
}

/** What turning raw processes into the list needs besides them. */
export interface ProcessContext {
  users: Map<number, string>;
  /** When the machine booted, seconds since 1970; null if unknown. */
  bootTime: number | null;
  memoryTotalBytes: number;
  /** CPU ticks of the whole machine (all cores) since the previous reading; 0 for the first. */
  cpuTotalTicks: number;
  /** Each process's CPU ticks at the previous reading, by PID and start time. */
  previousTicks: Map<string, number>;
  containers: Map<string, ContainerName>;
  rules: EndRules;
}

/** Whose processes may be ended: the same values the process wrapper reads (wrappers.json). */
export interface EndRules {
  /** The app's own user: never. */
  appUid: number;
  /** People's accounts start here. */
  minUid: number;
}
