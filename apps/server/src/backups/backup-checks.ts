import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import {
  type ApiErrorResponse,
  BACKUP_ERROR_CODES,
  BACKUP_FILESYSTEMS,
  BACKUP_LIMITS,
  type BackupDestination,
  type BackupFoldersResponse,
  type BackupItemRequest,
  type FieldError,
  isPlainAbsolutePath,
} from '@laris/shared';
import { CatalogService } from '../catalog/catalog.service.js';
import { WrapperConfigService } from '../executor/wrapper-config.js';
import { SystemReader } from '../host/system-reader.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { apiError } from './backup-errors.js';
import { inside } from '../host/folders.js';
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
    private readonly catalog: CatalogService,
    private readonly wrapperConfig: WrapperConfigService,
    private readonly reader: SystemReader,
  ) {}

  /** Mounted disks under /mnt and /media, with their free space and the same-disk warning. */
  async destinations(): Promise<BackupDestination[]> {
    const config = this.wrapperConfig.config;
    const mounts = new Map<string, string>();
    for (const point of await this.reader.mountPoints(mountInfoFile(config))) {
      if (isDestinationPath(config, point.mount)) mounts.set(point.mount, point.fsType);
    }
    const dataDevices = new Set(
      (
        await Promise.all([...config.storageRoots, '/home'].map((p) => this.reader.device(p)))
      ).filter((d): d is number => d !== null),
    );
    const destinations = await Promise.all(
      [...mounts].map(async ([mountPoint, filesystem]): Promise<BackupDestination> => {
        const [space, device, repository] = await Promise.all([
          this.reader.space(mountPoint),
          this.reader.device(mountPoint),
          this.reader.folder(repositoryPath(mountPoint)),
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
    const config = this.wrapperConfig.config;
    const entry = (p: string, name: string) => ({
      name,
      path: p,
      allowed: isAllowedFolder(config, p),
    });
    if (path === undefined) {
      const homes = (await this.reader.subfolders('/home')) ?? [];
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
    const children = await this.reader.subfolders(path);
    return {
      path,
      parent: isAllowedFolder(config, parent) ? parent : null,
      readable: children !== null,
      folders: (children ?? []).map((child) => entry(child.path, child.name)),
    };
  }

  async destinationMounted(destination: string): Promise<boolean> {
    const config = this.wrapperConfig.config;
    try {
      return (await this.reader.mountPoints(mountInfoFile(config))).some(
        (p) => p.mount === destination,
      );
    } catch {
      return false;
    }
  }

  /** A mounted, supported disk under /mnt or /media. */
  async checkDestination(destination: string): Promise<void> {
    const found = (await this.destinations()).find((d) => d.mountPoint === destination);
    if (!isPlainAbsolutePath(destination) || !found || !found.supported) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: [
          {
            field: 'destination',
            code: BACKUP_ERROR_CODES.destinationNotAllowed,
            message: 'Not a usable disk',
          },
        ],
      } satisfies ApiErrorResponse);
    }
  }

  /** New items, checked: services installed and with a backup in their recipe, folders allowed and there. */
  async checkNewItems(requests: BackupItemRequest[], destination: string): Promise<NewItemRow[]> {
    const config = this.wrapperConfig.config;
    const problems: FieldError[] = [];
    const rows: NewItemRow[] = [];
    const active = await this.prisma.backupItem.findMany({ where: { removedAt: null } });
    for (const [i, request] of requests.entries()) {
      const field = `items.${i}`;
      if (request.kind === 'service') {
        const service = await this.prisma.service.findUnique({ where: { id: request.serviceId } });
        if (!service || service.status !== 'installed') {
          problems.push({ field, code: 'service_not_installed', message: 'Not installed' });
          continue;
        }
        if (!this.catalog.get(service.catalogId)?.meta.backup) {
          problems.push({
            field,
            code: BACKUP_ERROR_CODES.serviceNotBackedUp,
            message: 'Has no backup',
          });
          continue;
        }
        const excluded = request.excludedFields ?? [];
        this.checkExcluded(service.catalogId, excluded);
        const onDisk = this.serviceFolders(service.catalogId, service.settings, excluded).some(
          (folder) => inside(folder, destination) || inside(destination, folder),
        );
        if (onDisk) {
          problems.push({ field, code: BACKUP_ERROR_CODES.pathNotAllowed, message: 'On the disk' });
          continue;
        }
        if (
          active.some((a) => a.serviceId === service.id) ||
          rows.some((r) => r.kind === 'service' && r.serviceId === service.id)
        ) {
          problems.push({
            field,
            code: BACKUP_ERROR_CODES.itemExists,
            message: 'Already backed up',
          });
          continue;
        }
        rows.push({
          id: randomUUID(),
          kind: 'service',
          serviceId: service.id,
          excludedFields: excluded,
        });
      } else {
        const path = request.path;
        if (
          !isAllowedFolder(config, path) ||
          inside(path, destination) ||
          inside(destination, path)
        ) {
          problems.push({ field, code: BACKUP_ERROR_CODES.pathNotAllowed, message: 'Not allowed' });
          continue;
        }
        const state = await this.reader.folder(path);
        // Another user's home: the app may not look, root can read it.
        if (state === 'missing' || state === 'other') {
          problems.push({
            field,
            code: BACKUP_ERROR_CODES.pathNotFound,
            message: 'No such folder',
          });
          continue;
        }
        if (
          active.some((a) => a.path === path) ||
          rows.some((r) => r.kind === 'folder' && r.path === path)
        ) {
          problems.push({
            field,
            code: BACKUP_ERROR_CODES.itemExists,
            message: 'Already backed up',
          });
          continue;
        }
        rows.push({ id: randomUUID(), kind: 'folder', path });
      }
    }
    if (problems.length > 0) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: problems,
      } satisfies ApiErrorResponse);
    }
    if (active.length + rows.length > BACKUP_LIMITS.maxItems) {
      throw new BadRequestException(apiError('Too many items', BACKUP_ERROR_CODES.itemExists));
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
    if (folders.some((f) => inside(f, destination) || inside(destination, f))) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: [
          {
            field: 'destination',
            code: BACKUP_ERROR_CODES.pathNotAllowed,
            message: 'Something backed up is on this disk',
          },
        ],
      } satisfies ApiErrorResponse);
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
    const backup = this.catalog.get(catalogId)?.meta.backup;
    const fields = backup?.folders.map((f) => f.field) ?? [];
    if (!excluded.every((field) => fields.includes(field)) || excluded.length >= fields.length) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: [
          {
            field: 'excludedFields',
            code: BACKUP_ERROR_CODES.pathNotAllowed,
            message: 'Not a folder of this service, or all of them',
          },
        ],
      } satisfies ApiErrorResponse);
    }
  }

  /** A service's folders that are backed up: its recipe's backup folders, as installed, minus those switched off. */
  private serviceFolders(catalogId: string, settings: unknown, excluded: string[]): string[] {
    const backup = this.catalog.get(catalogId)?.meta.backup;
    const values = (settings ?? {}) as Record<string, unknown>;
    return (backup?.folders ?? [])
      .filter(({ field }) => !excluded.includes(field))
      .map(({ field }) => values[field])
      .filter((value): value is string => typeof value === 'string');
  }
}
