/** What fills a template's `@account` and `@timezone` defaults. */
export interface FieldContext {
  /** `<uid>:<gid>` of the signed-in account; empty before a Linux sign-in (filled at install). */
  account: string;
  timezone: string;
}

/** `.laris/task.json`: the app's latest task, written by the helper as it starts it. */
export interface TaskRecord {
  unit: string;
  system: boolean;
  action: 'up' | 'update' | 'down';
  /** Its log's name in `.laris/tasks/`. */
  log: string;
  startedAt: string;
}

/** How this account runs Docker: as a user unit with its group, or as a system unit through sudo. */
export interface DockerAccess {
  /** Long tasks as system units through sudo. */
  system: boolean;
  /** Quick commands (deleting volumes) directly, or through sudo. */
  quick: 'direct' | 'sudo';
  /** In the docker group, but its user systemd started before: a restart (or logging out) makes it take effect. */
  restartNeeded: boolean;
}

/** What Compose says a folder's files mount, and the template label they carry. */
export interface ComposeFacts {
  /** Bind-mounted host paths. */
  folders: string[];
  /** Named volumes, by Docker's name (external ones left out). */
  volumes: string[];
  template: { id: string; version: string } | null;
}

/** The helper's `compose.check` answer: Compose's mounts, volumes and labels, never values. */
export interface ComposeCheckAnswer {
  mounts: { type: string; source: string | null }[];
  volumes: { key: string; name: string | null; external: boolean }[];
  templates: string[];
}
