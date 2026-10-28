import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import {
  type ApiErrorResponse,
  DISK_ERROR_CODES,
  type DiskErrorCode,
  type DiskMountRequest,
  type DisksStatus,
} from '@laris/shared';
import { type Observable, Subject } from 'rxjs';
import { LinuxSessions } from '../linux-sessions/linux-sessions.js';
import { SystemReader } from '../host/system-reader.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProgramConfigService } from '../root-programs/program-config.js';
import type { DiskOutcome, RootActor } from '../root-programs/root-programs.model.js';
import { RootPrograms } from '../root-programs/root-programs.js';
import { disksStatus } from './disk-status.js';
import { MOUNT_REFUSED, ROOT_PLACES } from './disks.constants.js';

/**
 * Disks (docs/plans/disk_management.md, acting_as_you.md): what's connected and mounted, read from
 * the host without privileges; mounting one at a folder of the person's choice (kept after a
 * restart) and unmounting one mounted here — through the person's sudo and the disk program,
 * which checks everything again. The friendly checks here come first.
 */
@Injectable()
export class DiskManager {
  private readonly changed = new Subject<void>();

  /** A disk was mounted or unmounted here. */
  readonly changes$: Observable<void> = this.changed.asObservable();

  constructor(
    private readonly prisma: PrismaService,
    private readonly rootPrograms: RootPrograms,
    private readonly programConfigService: ProgramConfigService,
    private readonly systemReader: SystemReader,
    private readonly linuxSessions: LinuxSessions,
  ) {}

  /** Where the pretend host is in development; `/` in production. */
  get places(): { host: string; mountRoot: string; unitDir: string } {
    const dev = this.programConfigService.config.disk?.dev;
    return dev ? { host: dev.root, mountRoot: dev.mountRoot, unitDir: dev.unitDir } : ROOT_PLACES;
  }

  async status(): Promise<DisksStatus> {
    const { host, unitDir } = this.places;
    const reader = this.systemReader.within(host);
    const [devices, mounts, swaps, units, plan] = await Promise.all([
      reader.blockDevices(),
      reader.mountPoints(),
      reader.swaps(),
      // In development the unit folder is outside the pretend host.
      this.systemReader.diskUnits(unitDir),
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

  async mount(request: DiskMountRequest, actor: RootActor): Promise<{ mountPoint: string }> {
    const status = await this.status();
    const partition = status.disks
      .flatMap((disk) => disk.partitions)
      .find((p) => p.uuid === request.uuid);
    // (Every device with that UUID is listed; the first is enough to judge.)
    if (!partition) throw diskError(DISK_ERROR_CODES.diskNotFound);
    const code = MOUNT_REFUSED[partition.state];
    if (code) throw diskError(code);
    if (partition.duplicateUuid) throw diskError(DISK_ERROR_CODES.duplicateUuid);
    const taken =
      status.disconnected.some((d) => d.mountPoint === request.mountPoint) ||
      status.disks.some((d) => d.partitions.some((p) => p.mountPoint === request.mountPoint));
    if (taken) throw diskError(DISK_ERROR_CODES.mountPointInUse, 'mountPoint');
    let owner: { uid: number; gid: number } | null = null;
    if (request.makeMine) {
      const { uid, gid } = this.linuxSessions.account(actor.appSessionId);
      if (uid !== null) owner = { uid, gid: gid ?? uid };
    }
    const outcome = await this.changing(() =>
      this.rootPrograms.diskMount({ uuid: request.uuid, mountPoint: request.mountPoint, owner }, actor),
    );
    if (!outcome.ok) {
      const field = outcome.code === DISK_ERROR_CODES.mountPointInUse ? 'mountPoint' : null;
      throw diskError(outcome.code, field);
    }
    return outcome.result;
  }

  async unmount(mountPoint: string, actor: RootActor): Promise<void> {
    const status = await this.status();
    const managed =
      status.disconnected.find((d) => d.mountPoint === mountPoint) ??
      status.disks.flatMap((d) => d.partitions).find((p) => p.managed && p.mountPoint === mountPoint);
    if (!managed) throw diskError(DISK_ERROR_CODES.notManaged);
    if (managed.usedForBackups) throw diskError(DISK_ERROR_CODES.usedForBackups);
    const outcome = await this.changing(() => this.rootPrograms.diskUnmount(mountPoint, actor));
    if (!outcome.ok) throw diskError(outcome.code);
  }

  /** A change announced either way (sudo refusals and an unavailable audit log are thrown). */
  private async changing<T>(run: () => Promise<DiskOutcome<T>>): Promise<DiskOutcome<T>> {
    try {
      return await run();
    } finally {
      this.changed.next();
    }
  }
}

const DISK_ERROR_STATUS: Partial<Record<DiskErrorCode, HttpStatus>> = {
  [DISK_ERROR_CODES.diskNotFound]: HttpStatus.NOT_FOUND,
  [DISK_ERROR_CODES.notManaged]: HttpStatus.NOT_FOUND,
  [DISK_ERROR_CODES.diskInUse]: HttpStatus.CONFLICT,
  [DISK_ERROR_CODES.duplicateUuid]: HttpStatus.CONFLICT,
  [DISK_ERROR_CODES.mountPointInUse]: HttpStatus.CONFLICT,
  [DISK_ERROR_CODES.usedForBackups]: HttpStatus.CONFLICT,
  [DISK_ERROR_CODES.busy]: HttpStatus.CONFLICT,
  [DISK_ERROR_CODES.diskBusy]: HttpStatus.CONFLICT,
  [DISK_ERROR_CODES.systemDisk]: HttpStatus.UNPROCESSABLE_ENTITY,
  [DISK_ERROR_CODES.unsupportedFilesystem]: HttpStatus.UNPROCESSABLE_ENTITY,
  [DISK_ERROR_CODES.invalidRequest]: HttpStatus.BAD_REQUEST,
  [DISK_ERROR_CODES.timedOut]: HttpStatus.GATEWAY_TIMEOUT,
  [DISK_ERROR_CODES.programUnavailable]: HttpStatus.SERVICE_UNAVAILABLE,
  [DISK_ERROR_CODES.auditUnavailable]: HttpStatus.SERVICE_UNAVAILABLE,
};

/** A refused or failed disk action as an HTTP error the web app can word. */
export function diskError(code: DiskErrorCode, field: string | null = null): HttpException {
  const body: ApiErrorResponse = field
    ? {
        message: 'Validation failed',
        errors: [{ field, code, message: 'This folder is in use' }],
      }
    : { message: 'The disk action could not be done', code };
  return new HttpException(body, DISK_ERROR_STATUS[code] ?? HttpStatus.INTERNAL_SERVER_ERROR);
}
