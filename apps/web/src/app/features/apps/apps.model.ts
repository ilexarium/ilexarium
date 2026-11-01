import type { AppTask, BackupMode } from '@laris/shared';
import type { SparklineSeries } from '../../shared/charts/sparkline/sparkline.model';

/** A field's change in the form. */
export interface FieldChange {
  key: string;
  value: string;
}

/** A task with the app it belongs to, as the task panel follows it. */
export interface FollowedTask {
  name: string;
  folder: string;
  task: AppTask;
}

/** An app's CPU and memory, summed over its containers; the histories oldest first. */
export interface AppStats {
  cpuPercent: number;
  memoryUsedBytes: number;
  cpuHistory: number[];
  memoryHistory: number[];
}

/** An app's CPU and memory as small lines; null without enough points. */
export interface AppTrends {
  cpu: { series: SparklineSeries[]; max: number } | null;
  memory: SparklineSeries[] | null;
}

/** The Apps page's sentence: a plural key, its count and the total. */
export interface AppsHeadline {
  key: string;
  count: number;
  total: number;
}

/** What a new app's backup will be. */
export interface BackupChoice {
  include: boolean;
  mode: BackupMode;
  /** Subfolders of the app's folder, relative to it. */
  skip: string[];
}

export type AppTab = 'overview' | 'settings';
