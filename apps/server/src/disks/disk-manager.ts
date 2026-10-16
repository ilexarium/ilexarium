import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  type ApiErrorResponse,
  DISK_ERROR_CODES,
  type DiskErrorCode,
  type DiskMountRequest,
  type DisksStatus,
} from '@homelab/shared';
import { type Observable, Subject } from 'rxjs';
import type { DiskOutcome, ExecutorActor } from '../executor/executor.model.js';
import { ExecutorService } from '../executor/executor.service.js';
import { WrapperConfigService } from '../executor/wrapper-config.js';
import { SystemReader } from '../host/system-reader.js';
import { OperationSlot } from '../jobs/operation-slot.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { disksStatus } from './disk-status.js';

/** Production places; development reads and writes under the config's pretend host. */
const ROOT_PLACES = { host: '/', mountRoot: '/mnt', unitDir: '/etc/systemd/system' };

/**
 * Disks (docs/plans/disk_management.md): what's connected and mounted, read from the host without
 * privileges; mounting one at `/mnt/<name>` (kept after a restart) and unmounting one mounted
 * here — through the executor and the disk wrapper, which checks everything again. The friendly
 * checks here come first; one privileged operation at a time (`OperationSlot`).
 */
@Injectable()
export class DiskManager {
  private readonly logger = new Logger(DiskManager.name);
  private readonly changed = new Subject<void>();

  /** A disk was mounted or unmounted here. */
  readonly changes$: Observable<void> = this.changed.asObservable();

  constructor(
    private readonly prisma: PrismaService,
    private readonly executor: ExecutorService,
    private readonly wrapperConfig: WrapperConfigService,
    private readonly reader: SystemReader,
    private readonly slot: OperationSlot,
  ) {}

  /** Where the pretend host is in development; `/` in production. */
  get places(): { host: string; mountRoot: string; unitDir: string } {
    const dev = this.wrapperConfig.config.disk?.dev;
    return dev ? { host: dev.root, mountRoot: dev.mountRoot, unitDir: dev.unitDir } : ROOT_PLACES;
  }

  async status(): Promise<DisksStatus> {
    const { host, unitDir } = this.places;
    const reader = this.reader.within(host);
    const [devices, mounts, swaps, units, plan] = await Promise.all([
      reader.blockDevices(),
      reader.mountPoints(),
      reader.swaps(),
      // In development the unit folder is outside the pretend host.
      this.reader.diskUnits(unitDir),
      this.prisma.backupPlan.findUnique({ where: { id: 1 }, select: { destination: true } }),
    ]);
    return disksStatus({
      devices,
      mounts,
      swaps,
      units,
      backupDestination: plan?.destination ?? null,
    });
  }

  async mount(request: DiskMountRequest, actor: ExecutorActor): Promise<{ mountPoint: string }> {
    const status = await this.status();
    const partition = status.disks
      .flatMap((disk) => disk.partitions)
      .find((p) => p.uuid === request.uuid);
    // (Every device with that UUID is listed; the first is enough to judge.)
    if (!partition) throw diskError(DISK_ERROR_CODES.diskNotFound);
    const refused: Partial<Record<string, DiskErrorCode>> = {
      system: DISK_ERROR_CODES.systemDisk,
      mounted: DISK_ERROR_CODES.diskInUse,
      inUse: DISK_ERROR_CODES.diskInUse,
      unsupported: DISK_ERROR_CODES.unsupportedFilesystem,
    };
    const code = refused[partition.state];
    if (code) throw diskError(code);
    if (partition.duplicateUuid) throw diskError(DISK_ERROR_CODES.duplicateUuid);
    const where = `${this.places.mountRoot}/${request.name}`;
    const taken =
      status.disconnected.some((d) => d.name === request.name) ||
      status.disks.some((d) =>
        d.partitions.some((p) => p.managedName === request.name || p.mountPoint === where),
      );
    if (taken) throw diskError(DISK_ERROR_CODES.nameTaken, 'name');
    const outcome = await this.privileged(() => this.executor.diskMount(request, actor));
    if (!outcome.ok) {
      throw diskError(outcome.code, outcome.code === DISK_ERROR_CODES.nameTaken ? 'name' : null);
    }
    return outcome.result;
  }

  async unmount(name: string, actor: ExecutorActor): Promise<void> {
    const status = await this.status();
    const managed =
      status.disconnected.find((d) => d.name === name) ??
      status.disks.flatMap((d) => d.partitions).find((p) => p.managedName === name);
    if (!managed) throw diskError(DISK_ERROR_CODES.notManaged);
    if (managed.usedForBackups) throw diskError(DISK_ERROR_CODES.usedForBackups);
    const outcome = await this.privileged(() => this.executor.diskUnmount(name, actor));
    if (!outcome.ok) throw diskError(outcome.code);
  }

  /** The slot claimed before the first await; a change announced either way. */
  private async privileged<T>(run: () => Promise<DiskOutcome<T>>): Promise<DiskOutcome<T>> {
    const release = this.slot.claim('disk');
    try {
      return await run();
    } catch (failure) {
      this.logger.error('Could not record the request in the audit log; nothing ran', failure);
      return { ok: false, code: DISK_ERROR_CODES.auditUnavailable };
    } finally {
      release();
      this.changed.next();
    }
  }
}

/** A refused or failed disk action as an HTTP error the web app can word. */
export function diskError(code: DiskErrorCode, field: string | null = null): HttpException {
  const status: Partial<Record<DiskErrorCode, HttpStatus>> = {
    [DISK_ERROR_CODES.diskNotFound]: HttpStatus.NOT_FOUND,
    [DISK_ERROR_CODES.notManaged]: HttpStatus.NOT_FOUND,
    [DISK_ERROR_CODES.diskInUse]: HttpStatus.CONFLICT,
    [DISK_ERROR_CODES.duplicateUuid]: HttpStatus.CONFLICT,
    [DISK_ERROR_CODES.nameTaken]: HttpStatus.CONFLICT,
    [DISK_ERROR_CODES.usedForBackups]: HttpStatus.CONFLICT,
    [DISK_ERROR_CODES.busy]: HttpStatus.CONFLICT,
    [DISK_ERROR_CODES.diskBusy]: HttpStatus.CONFLICT,
    [DISK_ERROR_CODES.systemDisk]: HttpStatus.UNPROCESSABLE_ENTITY,
    [DISK_ERROR_CODES.unsupportedFilesystem]: HttpStatus.UNPROCESSABLE_ENTITY,
    [DISK_ERROR_CODES.invalidRequest]: HttpStatus.BAD_REQUEST,
    [DISK_ERROR_CODES.timedOut]: HttpStatus.GATEWAY_TIMEOUT,
    [DISK_ERROR_CODES.executorUnavailable]: HttpStatus.SERVICE_UNAVAILABLE,
    [DISK_ERROR_CODES.auditUnavailable]: HttpStatus.SERVICE_UNAVAILABLE,
  };
  const body: ApiErrorResponse = field
    ? {
        message: 'Validation failed',
        errors: [{ field, code, message: 'This name is in use' }],
      }
    : { message: 'The disk action could not be done', code };
  return new HttpException(body, status[code] ?? HttpStatus.INTERNAL_SERVER_ERROR);
}
