/** A container as the process list names it: by its full ID. */
export interface ContainerName {
  name: string;
  /** Its app (Compose project). */
  app: string | null;
}

/** What turning raw processes into the list needs besides them. */
export interface ProcessContext {
  users: Map<number, string>;
  /** When the machine booted, seconds since 1970; null if unknown. */
  bootTime: number | null;
  memoryTotalBytes: number;
  cores: number;
  /** CPU ticks of the whole machine (all cores) since the previous reading; 0 for the first. */
  cpuTotalTicks: number;
  /** Each process's CPU ticks at the previous reading, by PID and start time. */
  previousTicks: Map<string, number>;
  containers: Map<string, ContainerName>;
}
