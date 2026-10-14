/** What an installed service's containers are doing (from the `containers` topic). */
export type ServiceRuntime = 'running' | 'partial' | 'stopped' | 'unhealthy';

/** A service's backups, on its card: not in the plan, backed up (when), never yet, or failing. */
export type ServiceBackup =
  | { state: 'none' }
  | { state: 'never' }
  | { state: 'ok'; at: string }
  | { state: 'failed'; at: string | null };
