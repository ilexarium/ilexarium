import type { BackupRunStatus, DiskUsage, InstalledService } from '@laris/shared';
import type { ServiceRuntime } from '../../core/services/services.model';

/** A text to translate: a key with its params, and a count when it has plural forms. */
export interface Text {
  key: string;
  params?: Record<string, unknown>;
  count?: number;
}

/** A status light: green, amber, red, the primary colour while something runs, grey while unknown. */
export type Light = 'ok' | 'warn' | 'fail' | 'busy' | 'idle';

/** One of the rack's three units: what it's about, its light, what it says, where it leads. */
export interface RackUnit {
  id: 'apps' | 'backups' | 'space';
  light: Light;
  text: Text;
  sub: Text | null;
  link: string;
}

export interface AppTile {
  service: InstalledService;
  /** Null while the containers aren't known yet (or Docker isn't reachable). */
  runtime: ServiceRuntime | null;
  /** Its containers that aren't running: what Start starts. */
  stopped: string[];
  /** One of them is being started (or stopped) right now. */
  pending: boolean;
  /** Ollama: its button opens the Assistant instead of its own page. */
  assistant: boolean;
}

/** One day of the backups' strip: its worst outcome, or null without a run. */
export interface BackupDay {
  date: string;
  outcome: Exclude<BackupRunStatus, 'running'> | null;
}

export type DiskKind = 'system' | 'backup' | 'other';

export interface DiskRow extends DiskUsage {
  kind: DiskKind;
  percent: number;
}
