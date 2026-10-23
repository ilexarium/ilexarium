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
  type FieldError,
  isPlainAbsolutePath,
  SERVICE_ERROR_CODES,
} from '@laris/shared';
import { CatalogService } from '../catalog/catalog.service.js';
import { WrapperConfigService } from '../executor/wrapper-config.js';
import { inside } from '../host/folders.js';
import { SystemReader } from '../host/system-reader.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { apiError, validationFailed } from './backup-errors.js';
import {
  isAllowedFolder,
  isDestinationPath,
  mountInfoFile,
  repositoryPath,
} from './backup-paths.js';

/** A checked new item, ready to be saved. */
export type NewItemRow =
  | { id: string; kind: 'service'; serviceId: string; excludedFields: string[] }
  | { id: string; kind: 'folder'; path: string };

/**
 * Where backups can go and what can be backed up: the disk and folder pickers, and the app's
 * friendly checks before a change goes to the wrapper (which checks it all again, its own way).
 */
@Injectable()
export class BackupChecks {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalogService: CatalogService,
    private readonly wrapperConfigService: WrapperConfigService,
    private readonly systemReader: SystemReader,
  ) {}

  /** Mounted disks under /mnt and /media, with their free space and the same-disk warning. */
  async destinations(): Promise<BackupDestination[]> {
    const config = this.wrapperConfigService.config;
    const mounts = new Map<string, string>();
    for (const point of await this.systemReader.mountPoints(mountInfoFile(config))) {
      if (isDestinationPath(config, point.mount)) mounts.set(point.mount, point.fsType);
    }
    const dataDevices = new Set(
      (
        await Promise.all(
          [...config.storageRoots, '/home'].map((path) => this.systemReader.device(path)),
        )
      ).filter((device): device is number => device !== null),
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

  /** The folder picker: the starting places, or the folders inside one. */
  async folders(path?: string): Promise<BackupFoldersResponse> {
    const config = this.wrapperConfigService.config;
    const entry = (p: string, name: string) => ({
      name,
      path: p,
      allowed: isAllowedFolder(config, p),
    });
    if (path === undefined) {
      const homes = (await this.systemReader.subfolders('/home')) ?? [];
      return {
        path: null,
        parent: null,
        readable: true,
        folders: [
          ...config.storageRoots.map((root) => entry(root, root)),
          ...homes.map((home) => entry(home.path, home.path)),
        ],
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
    const config = this.wrapperConfigService.config;
    try {
      return (await this.systemReader.mountPoints(mountInfoFile(config))).some(
        (point) => point.mount === destination,
      );
    } catch {
      return false;
    }
  }

  /** A mounted, supported disk under /mnt or /media. */
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

  /** New items, checked: services installed and with a backup in their recipe, folders allowed and there. */
  async checkNewItems(requests: BackupItemRequest[], destination: string): Promise<NewItemRow[]> {
    const problems: FieldError[] = [];
    const rows: NewItemRow[] = [];
    const active = await this.prisma.backupItem.findMany({ where: { removedAt: null } });
    for (const [i, request] of requests.entries()) {
      const field = `items.${i}`;
      const problem =
        request.kind === 'service'
          ? await this.serviceProblem(request.serviceId, request.excludedFields ?? [], destination)
          : await this.folderProblem(request.path, destination);
      if (problem) {
        problems.push({ field, ...problem });
        continue;
      }
      const taken =
        request.kind === 'service'
          ? [...active, ...rows].some((r) => 'serviceId' in r && r.serviceId === request.serviceId)
          : [...active, ...rows].some((r) => 'path' in r && r.path === request.path);
      if (taken) {
        problems.push({ field, code: BACKUP_ERROR_CODES.itemExists, message: 'Already backed up' });
        continue;
      }
      rows.push(
        request.kind === 'service'
          ? {
              id: randomUUID(),
              kind: 'service',
              serviceId: request.serviceId,
              excludedFields: request.excludedFields ?? [],
            }
          : { id: randomUUID(), kind: 'folder', path: request.path },
      );
    }
    if (problems.length > 0) throw validationFailed(problems);
    if (active.length + rows.length > BACKUP_LIMITS.maxItems) {
      throw new BadRequestException(apiError('Too many items', BACKUP_ERROR_CODES.tooManyItems));
    }
    return rows;
  }

  /** A new disk mustn't hold what's backed up onto it (the wrapper refuses that plan). */
  async checkItemsOffDisk(destination: string): Promise<void> {
    const items = await this.prisma.backupItem.findMany({
      where: { removedAt: null },
      include: { service: true },
    });
    const folders = items.flatMap((item) =>
      item.kind === 'folder' && item.path
        ? [item.path]
        : item.service
          ? this.serviceFolders(item.service.catalogId, item.service.settings, item.excludedFields)
          : [],
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

  /** Switched-off folders: fields of the recipe's backup, never all of them. */
  checkExcluded(catalogId: string, excluded: string[]): void {
    const backup = this.catalogService.get(catalogId)?.meta.backup;
    const fields = backup?.folders.map((folder) => folder.field) ?? [];
    if (!excluded.every((field) => fields.includes(field)) || excluded.length >= fields.length) {
      throw validationFailed([
        {
          field: 'excludedFields',
          code: BACKUP_ERROR_CODES.pathNotAllowed,
          message: 'Not a folder of this service, or all of them',
        },
      ]);
    }
  }

  /** Why a service can't be added, or null. */
  private async serviceProblem(
    serviceId: string,
    excluded: string[],
    destination: string,
  ): Promise<Omit<FieldError, 'field'> | null> {
    const service = await this.prisma.service.findUnique({ where: { id: serviceId } });
    if (!service || service.status !== 'installed') {
      return { code: SERVICE_ERROR_CODES.notInstalled, message: 'Not installed' };
    }
    if (!this.catalogService.get(service.catalogId)?.meta.backup) {
      return { code: BACKUP_ERROR_CODES.serviceNotBackedUp, message: 'Has no backup' };
    }
    this.checkExcluded(service.catalogId, excluded);
    const folders = this.serviceFolders(service.catalogId, service.settings, excluded);
    if (folders.some((folder) => overlaps(folder, destination))) {
      return { code: BACKUP_ERROR_CODES.pathNotAllowed, message: 'On the disk' };
    }
    return null;
  }

  /** Why a folder can't be added, or null. */
  private async folderProblem(
    path: string,
    destination: string,
  ): Promise<Omit<FieldError, 'field'> | null> {
    if (
      !isAllowedFolder(this.wrapperConfigService.config, path) ||
      overlaps(path, destination)
    ) {
      return { code: BACKUP_ERROR_CODES.pathNotAllowed, message: 'Not allowed' };
    }
    const state = await this.systemReader.folder(path);
    // Another user's home: the app may not look, root can read it.
    if (state === 'missing' || state === 'other') {
      return { code: BACKUP_ERROR_CODES.pathNotFound, message: 'No such folder' };
    }
    return null;
  }

  /** A service's folders that are backed up: its recipe's backup folders, as installed, minus those switched off. */
  private serviceFolders(catalogId: string, settings: unknown, excluded: string[]): string[] {
    const backup = this.catalogService.get(catalogId)?.meta.backup;
    const values = (settings ?? {}) as Record<string, unknown>;
    return (backup?.folders ?? [])
      .filter(({ field }) => !excluded.includes(field))
      .map(({ field }) => values[field])
      .filter((value): value is string => typeof value === 'string');
  }
}

const overlaps = (a: string, b: string) => inside(a, b) || inside(b, a);
