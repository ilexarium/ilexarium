import { BACKUP_REPOSITORY_FOLDER, isBackupFolder } from '@laris/shared';
import { inside, notSystem } from '../host/folders.js';
import type { ProgramConfig } from '../root-programs/root-programs.model.js';
import { ARCHIVE_TIME_LENGTH, MOUNT_INFO, STATE_DIR } from './backups.constants.js';

/**
 * Where things may be, as the app checks them — friendly errors before anything runs. The backup
 * program checks all of it again, with its own code (system/programs/laris-backup.mts).
 */

/** A folder that may be backed up or restored into: anywhere but a system or platform folder. */
export function isAllowedFolder(config: ProgramConfig, path: string): boolean {
  return isBackupFolder(path) && notSystem(config, path);
}

/** A skip: inside one of the folders. */
export const skipInside = (skip: string, folders: readonly string[]) =>
  folders.some((folder) => skip.startsWith(`${folder}/`));

export const overlaps = (a: string, b: string) => inside(a, b) || inside(b, a);

/** Development: the pretend disks' folder; production: none (every disk that isn't a system disk). */
export function destinationRoots(config: ProgramConfig): string[] | null {
  return config.backup?.dev?.destinationRoots ?? null;
}

export const repositoryPath = (destination: string) => `${destination}/${BACKUP_REPOSITORY_FOLDER}`;

/** The mount table the program reads. */
export function mountInfoFile(config: ProgramConfig): string {
  return config.backup?.dev?.mountInfo ?? MOUNT_INFO;
}

/** The program's state folder: runs.jsonl, current.jsonl and restores/, readable by the app. */
export function stateDir(config: ProgramConfig): string {
  const dev = config.backup?.dev?.dir;
  return dev ? `${dev}/state` : STATE_DIR;
}

/** An archive's time, from its name (`<item id>-<UTC time>`). */
export function archiveTime(name: string): string {
  return `${name.slice(-ARCHIVE_TIME_LENGTH)}.000Z`;
}
