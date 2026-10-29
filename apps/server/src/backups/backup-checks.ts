import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import {
  BACKUP_ERROR_CODES,
  BACKUP_FILESYSTEMS,
  BACKUP_LIMITS,
  type BackupDestination,
  type BackupFoldersResponse,
  type BackupItemRequest,
  type BackupItemUpdate,
  type FieldError,
  isPlainAbsolutePath,
} from '@laris/shared';
import { DockerService } from '../docker/docker.service.js';
import { SystemReader } from '../host/system-reader.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProgramConfigService } from '../root-programs/program-config.js';
import { SYSTEM_MOUNTS } from '../disks/disks.constants.js';
import { apiError, validationFailed } from './backup-errors.js';
import type { NewItemRow } from './backups.model.js';
import {
  destinationRoots,
  isAllowedFolder,
  mountInfoFile,
  overlaps,
  repositoryPath,
  skipInside,
} from './backup-paths.js';
import { DESTINATION_SOURCE, FOLDER_PLACES } from './backups.constants.js';

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

  /** The folder picker: the starting places (homes, /srv, the disks), or the folders inside one. */
  async folders(path?: string): Promise<BackupFoldersResponse> {
    const config = this.programConfigService.config;
    const entry = (p: string, name: string) => ({
      name,
      path: p,
      allowed: isAllowedFolder(config, p),
    });
    if (path === undefined) {
      const homes = (await this.systemReader.subfolders('/home')) ?? [];
      const disks = (await this.destinations()).map((d) => d.mountPoint);
      const places = [...homes.map((home) => home.path), ...FOLDER_PLACES, ...disks];
      const existing = await Promise.all(
        [...new Set(places)].map(async (p) =>
          (await this.systemReader.folder(p)) === 'missing' ? null : p,
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
    const children = await this.systemReader.subfolders(path);
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

  /** New items, checked: apps Docker knows, folders that may be backed up — off the disk. */
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
          ? this.appProblem(request, destination, apps)
          : await this.folderProblem(request.path, destination);
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
              folders: [...new Set(this.appFoldersOf(request, apps))],
              excludedFolders: [...new Set(request.excludedFolders ?? [])],
              skip: [...new Set(request.skip)],
              mode: request.mode,
            }
          : { id: randomUUID(), kind: 'folder', path: request.path },
      );
    }
    if (problems.length > 0) throw validationFailed(problems);
    // Counted as the program counts the plan: removed items too (their backups are kept), and
    // the platform item setup adds (no items yet: this is setup).
    const total = items.length + rows.length + (items.length === 0 ? 1 : 0);
    if (total > BACKUP_LIMITS.maxItems) {
      throw new BadRequestException(apiError('Too many items', BACKUP_ERROR_CODES.tooManyItems));
    }
    return rows;
  }

  /** An app item's change: its folders allowed and off the disk, its skips inside them. */
  checkAppChange(
    current: { folders: string[]; skip: string[] },
    change: BackupItemUpdate,
    destination: string,
  ): void {
    const folders = change.folders ?? current.folders;
    const problem = this.appFieldsProblem(folders, change.skip ?? current.skip, destination);
    if (problem) throw validationFailed([{ field: 'folders', ...problem }]);
  }

  /** A new disk mustn't hold what's backed up onto it (the program refuses that plan). */
  async checkItemsOffDisk(destination: string): Promise<void> {
    const items = await this.prisma.backupItem.findMany({ where: { removedAt: null } });
    const folders = items.flatMap((item) =>
      item.kind === 'folder' && item.path ? [item.path] : item.folders,
    );
    if (folders.some((folder) => overlaps(folder, destination))) {
      throw validationFailed([
        {
          field: 'destination',
          code: BACKUP_ERROR_CODES.pathNotAllowed,
          message: 'Something backed up is on this disk',
        },
      ]);
    }
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

  /** A restore's own folder: allowed, off the backup disk. */
  checkRestoreTarget(target: string, destination: string): void {
    if (
      !isAllowedFolder(this.programConfigService.config, target) ||
      overlaps(target, destination)
    ) {
      throw validationFailed([
        { field: 'target', code: BACKUP_ERROR_CODES.pathNotAllowed, message: 'Not allowed' },
      ]);
    }
  }

  /** The folders asked for; none asked: every folder Docker says the app uses, but those left out. */
  private appFoldersOf(
    request: Extract<BackupItemRequest, { kind: 'app' }>,
    apps: ReadonlyMap<string, string[]>,
  ): string[] {
    if (request.folders.length > 0) return request.folders;
    const excluded = request.excludedFolders ?? [];
    return (apps.get(request.project) ?? []).filter((folder) => !excluded.includes(folder));
  }

  private appProblem(
    request: Extract<BackupItemRequest, { kind: 'app' }>,
    destination: string,
    apps: ReadonlyMap<string, string[]>,
  ): Omit<FieldError, 'field'> | null {
    if (!apps.has(request.project)) {
      return { code: BACKUP_ERROR_CODES.itemNotFound, message: 'No such app' };
    }
    return this.appFieldsProblem(this.appFoldersOf(request, apps), request.skip, destination);
  }

  private appFieldsProblem(
    folders: string[],
    skip: string[],
    destination: string,
  ): Omit<FieldError, 'field'> | null {
    const config = this.programConfigService.config;
    if (folders.length === 0)
      return { code: BACKUP_ERROR_CODES.sourceMissing, message: 'No folders' };
    if (!folders.every((folder) => isAllowedFolder(config, folder))) {
      return { code: BACKUP_ERROR_CODES.pathNotAllowed, message: 'Not allowed' };
    }
    if (folders.some((folder) => overlaps(folder, destination))) {
      return { code: BACKUP_ERROR_CODES.pathNotAllowed, message: 'On the disk' };
    }
    if (!skip.every((path) => skipInside(path, folders))) {
      return { code: BACKUP_ERROR_CODES.pathNotAllowed, message: 'A skip outside its folders' };
    }
    return null;
  }

  /** Why a folder can't be added, or null. */
  private async folderProblem(
    path: string,
    destination: string,
  ): Promise<Omit<FieldError, 'field'> | null> {
    if (!isAllowedFolder(this.programConfigService.config, path) || overlaps(path, destination)) {
      return { code: BACKUP_ERROR_CODES.pathNotAllowed, message: 'Not allowed' };
    }
    // Another user's home: the app may not look, root can read it.
    const state = await this.systemReader.folder(path);
    if (state === 'missing' || state === 'other') {
      return { code: BACKUP_ERROR_CODES.pathNotFound, message: 'No such folder' };
    }
    return null;
  }
}
