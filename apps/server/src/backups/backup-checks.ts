import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { dirname } from 'node:path';
import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import {
  BACKUP_ERROR_CODES,
  BACKUP_FILESYSTEMS,
  type BackupDestination,
  type BackupFoldersResponse,
  type BackupItemRequest,
  type BackupItemUpdate,
  type FieldError,
  isPlainAbsolutePath,
  isSkipInFolders,
  pathsOverlap,
} from '@ilex/shared';
import { DockerService } from '../docker/docker.service.js';
import { SystemReader } from '../host/system-reader.js';
import { LinuxSessions } from '../linux-sessions/linux-sessions.js';
import type { Sftp } from '../linux-sessions/sftp.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProgramConfigService } from '../root-programs/program-config.js';
import { SYSTEM_MOUNTS } from '../disks/disks.constants.js';
import { apiError, validationFailed } from './backup-errors.js';
import type { NewItemRow } from './backups.model.js';
import {
  destinationRoots,
  isAllowedFolder,
  mountInfoFile,
  repositoryPath,
} from './backup-paths.js';
import {
  DESTINATION_SOURCE,
  FOLDER_PLACES,
  ON_BACKUP_DISK,
  SUBFOLDERS_MAX,
} from './backups.constants.js';

/**
 * Where backups can go and what can be backed up: the disk and folder pickers, and the app's
 * friendly checks before a change goes to the backup program (which checks it all again, its own
 * way).
 */
@Injectable()
export class BackupChecks {
  constructor(
    private readonly prisma: PrismaService,
    private readonly programConfigService: ProgramConfigService,
    private readonly systemReader: SystemReader,
    private readonly dockerService: DockerService,
    private readonly linuxSessions: LinuxSessions,
  ) {}

  /**
   * Every mounted disk that isn't a system disk, wherever it's mounted (development: the pretend
   * ones), with its free space and the same-disk warning.
   */
  async destinations(): Promise<BackupDestination[]> {
    const config = this.programConfigService.config;
    const roots = destinationRoots(config);
    const mounts = new Map<string, string>();
    for (const point of await this.systemReader.mountPoints(mountInfoFile(config))) {
      const usable = roots
        ? roots.some((root) => point.mount.startsWith(`${root}/`))
        : DESTINATION_SOURCE.test(point.source) &&
          !SYSTEM_MOUNTS.includes(point.mount) &&
          isAllowedFolder(config, point.mount);
      if (usable) mounts.set(point.mount, point.fsType);
    }
    const dataDevices = new Set(
      (await Promise.all(['/', '/home'].map((path) => this.systemReader.device(path)))).filter(
        (device): device is number => device !== null,
      ),
    );
    const destinations = await Promise.all(
      [...mounts].map(async ([mountPoint, filesystem]): Promise<BackupDestination> => {
        const [space, device, repository] = await Promise.all([
          this.systemReader.space(mountPoint),
          this.systemReader.device(mountPoint),
          this.systemReader.folder(repositoryPath(mountPoint)),
        ]);
        return {
          mountPoint,
          filesystem,
          supported: (BACKUP_FILESYSTEMS as readonly string[]).includes(filesystem),
          totalBytes: space?.totalBytes ?? 0,
          freeBytes: space?.freeBytes ?? 0,
          sameDiskAsData: device !== null && dataDevices.has(device),
          hasRepository: repository !== 'missing',
        };
      }),
    );
    return destinations.sort((a, b) => a.mountPoint.localeCompare(b.mountPoint));
  }

  /**
   * The folder picker: the starting places (homes, /srv, the disks), or the folders inside one —
   * read as the signed-in Linux account (its SFTP), so it shows what that account may see: its own
   * private home too. Without a Linux session: 403 `linux_session_required` (the page signs in).
   */
  async folders(appSessionId: string, path?: string): Promise<BackupFoldersResponse> {
    const config = this.programConfigService.config;
    const { sftp } = this.linuxSessions.sftp(appSessionId);
    const entry = (p: string, name: string) => ({
      name,
      path: p,
      allowed: isAllowedFolder(config, p),
    });
    if (path === undefined) {
      const homes = (await subfolders(sftp, '/home')) ?? [];
      const disks = (await this.destinations()).map((d) => d.mountPoint);
      const places = [...homes.map((home) => home.path), ...FOLDER_PLACES, ...disks];
      const existing = await Promise.all(
        [...new Set(places)].map(async (p) =>
          (await sftp.statOrNull(p).catch(() => null)) ? p : null,
        ),
      );
      return {
        path: null,
        parent: null,
        readable: true,
        folders: existing.filter((p): p is string => p !== null).map((p) => entry(p, p)),
      };
    }
    if (!isAllowedFolder(config, path)) {
      throw new BadRequestException(
        apiError('Not a folder that can be backed up', BACKUP_ERROR_CODES.pathNotAllowed),
      );
    }
    const parent = dirname(path);
    const children = await subfolders(sftp, path);
    return {
      path,
      parent: isAllowedFolder(config, parent) ? parent : null,
      readable: children !== null,
      folders: (children ?? []).map((child) => entry(child.path, child.name)),
    };
  }

  async destinationMounted(destination: string): Promise<boolean> {
    const config = this.programConfigService.config;
    try {
      return (await this.systemReader.mountPoints(mountInfoFile(config))).some(
        (point) => point.mount === destination,
      );
    } catch {
      return false;
    }
  }

  /** A mounted, supported disk that isn't a system disk. */
  async checkDestination(destination: string): Promise<void> {
    const found = (await this.destinations()).find((d) => d.mountPoint === destination);
    if (!isPlainAbsolutePath(destination) || !found?.supported) {
      throw validationFailed([
        {
          field: 'destination',
          code: BACKUP_ERROR_CODES.destinationNotAllowed,
          message: 'Not a usable disk',
        },
      ]);
    }
  }

  /**
   * New items, checked: apps Docker knows, folders that may be backed up, none on the backup disk
   * (`destination`) or holding it. The rest (skips inside the folders, how many) the backup
   * program refuses.
   */
  async checkNewItems(requests: BackupItemRequest[], destination: string): Promise<NewItemRow[]> {
    const problems: FieldError[] = [];
    const rows: NewItemRow[] = [];
    const items = await this.prisma.backupItem.findMany();
    const active = items.filter((item) => !item.removedAt);
    const apps = (await this.appFolders()) ?? new Map<string, string[]>();
    for (const [i, request] of requests.entries()) {
      const field = `items.${i}`;
      const problem =
        request.kind === 'app'
          ? this.appProblem(request, apps, destination)
          : ((await this.folderProblem(request.path, destination)) ??
            skipsProblem(request.skip ?? [], request.path));
      if (problem) {
        problems.push({ field, ...problem });
        continue;
      }
      const taken =
        request.kind === 'app'
          ? [...active, ...rows].some((r) => 'project' in r && r.project === request.project)
          : [...active, ...rows].some((r) => 'path' in r && r.path === request.path);
      if (taken) {
        problems.push({ field, code: BACKUP_ERROR_CODES.itemExists, message: 'Already backed up' });
        continue;
      }
      rows.push(
        request.kind === 'app'
          ? {
              id: randomUUID(),
              kind: 'app',
              project: request.project,
              folders: [...new Set(this.appFoldersOf(request, apps, destination))],
              skip: [...new Set(request.skip)],
              mode: request.mode,
            }
          : {
              id: randomUUID(),
              kind: 'folder',
              path: request.path,
              skip: [...new Set(request.skip ?? [])],
            },
      );
    }
    if (problems.length > 0) throw validationFailed(problems);
    return rows;
  }

  /** An app item's change: its folders allowed. */
  checkAppChange(
    current: { folders: string[] },
    change: BackupItemUpdate,
    destination: string,
  ): void {
    const problem = this.appFoldersProblem(change.folders ?? current.folders, destination);
    if (problem) throw validationFailed([{ field: 'folders', ...problem }]);
  }

  checkFolderChange(path: string | null, change: BackupItemUpdate): void {
    const problem = path
      ? skipsProblem(change.skip ?? [], path)
      : { code: BACKUP_ERROR_CODES.itemFixed, message: 'A folder item without its folder' };
    if (problem) throw validationFailed([{ field: 'skip', ...problem }]);
  }

  /** An item's backups can't be deleted while a restore's set-aside folders depend on its record. */
  async checkNoSetAside(itemId: string): Promise<void> {
    const waiting = await this.prisma.backupRestore.count({
      where: { itemId, setAsideDeletedAt: null, NOT: { setAside: { isEmpty: true } } },
    });
    if (waiting > 0) {
      throw new ConflictException(
        apiError(
          'Delete the previous version kept by a restore first',
          BACKUP_ERROR_CODES.setAsideKept,
        ),
      );
    }
  }

  /**
   * Each app's folders as Docker sees them, only those a backup may hold — not a system path an
   * app mounts too (`/etc/localtime`, the Docker socket). Null: Docker didn't answer.
   */
  async appFolders(): Promise<Map<string, string[]> | null> {
    const config = this.programConfigService.config;
    const apps = await this.dockerService.appFolders().catch(() => null);
    if (!apps) return null;
    return new Map(
      [...apps].map(([project, folders]) => [
        project,
        folders.filter((folder) => isAllowedFolder(config, folder)),
      ]),
    );
  }

  /** A restore's own folder: allowed, and not on the backup disk. */
  checkRestoreTarget(target: string, destination: string): void {
    if (!isAllowedFolder(this.programConfigService.config, target)) {
      throw validationFailed([
        { field: 'target', code: BACKUP_ERROR_CODES.pathNotAllowed, message: 'Not allowed' },
      ]);
    }
    if (pathsOverlap(target, destination)) {
      throw validationFailed([{ field: 'target', ...ON_BACKUP_DISK }]);
    }
  }

  /** Moving the backups to another disk: no item may be on it or hold it. */
  async checkItemsOffDisk(destination: string): Promise<void> {
    const items = await this.prisma.backupItem.findMany({ where: { removedAt: null } });
    const onDisk = items.some((item) =>
      (item.kind === 'folder' ? [item.path ?? ''] : item.folders).some(
        (path) => path && pathsOverlap(path, destination),
      ),
    );
    if (onDisk) throw validationFailed([{ field: 'destination', ...ON_BACKUP_DISK }]);
  }

  /**
   * The folders asked for; none asked: every folder Docker says the app uses, except those on the
   * backup disk (left out like a system path, not a reason to refuse the app).
   */
  private appFoldersOf(
    request: Extract<BackupItemRequest, { kind: 'app' }>,
    apps: ReadonlyMap<string, string[]>,
    destination: string,
  ): string[] {
    if (request.folders.length > 0) return request.folders;
    return (apps.get(request.project) ?? []).filter((path) => !pathsOverlap(path, destination));
  }

  private appProblem(
    request: Extract<BackupItemRequest, { kind: 'app' }>,
    apps: ReadonlyMap<string, string[]>,
    destination: string,
  ): Omit<FieldError, 'field'> | null {
    if (!apps.has(request.project)) {
      return { code: BACKUP_ERROR_CODES.itemNotFound, message: 'No such app' };
    }
    return this.appFoldersProblem(this.appFoldersOf(request, apps, destination), destination);
  }

  private appFoldersProblem(
    folders: string[],
    destination: string,
  ): Omit<FieldError, 'field'> | null {
    const config = this.programConfigService.config;
    if (folders.length === 0)
      return { code: BACKUP_ERROR_CODES.sourceMissing, message: 'No folders' };
    if (!folders.every((folder) => isAllowedFolder(config, folder))) {
      return { code: BACKUP_ERROR_CODES.pathNotAllowed, message: 'Not allowed' };
    }
    if (folders.some((folder) => pathsOverlap(folder, destination))) return ON_BACKUP_DISK;
    return null;
  }

  /** Why a folder can't be added, or null. */
  private async folderProblem(
    path: string,
    destination: string,
  ): Promise<Omit<FieldError, 'field'> | null> {
    if (!isAllowedFolder(this.programConfigService.config, path)) {
      return { code: BACKUP_ERROR_CODES.pathNotAllowed, message: 'Not allowed' };
    }
    if (pathsOverlap(path, destination)) return ON_BACKUP_DISK;
    // Another user's home: the app may not look, root can read it.
    const state = await this.systemReader.folder(path);
    if (state === 'missing' || state === 'other') {
      return { code: BACKUP_ERROR_CODES.pathNotFound, message: 'No such folder' };
    }
    return null;
  }
}

/** The backup program checks them again, its own way. */
function skipsProblem(skips: string[], folder: string): Omit<FieldError, 'field'> | null {
  return skips.every((skip) => isSkipInFolders(skip, [folder]))
    ? null
    : { code: BACKUP_ERROR_CODES.pathNotAllowed, message: 'A skip outside the folder' };
}

/** The folders in `path` (not links), sorted, at most SUBFOLDERS_MAX; null when it can't be read. */
async function subfolders(
  sftp: Sftp,
  path: string,
): Promise<{ name: string; path: string }[] | null> {
  try {
    return (await sftp.entries(path))
      .filter(({ attrs }) => (attrs.mode & constants.S_IFMT) === constants.S_IFDIR)
      .map(({ filename }) => filename)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, SUBFOLDERS_MAX)
      .map((name) => ({ name, path: path === '/' ? `/${name}` : `${path}/${name}` }));
  } catch {
    return null;
  }
}
