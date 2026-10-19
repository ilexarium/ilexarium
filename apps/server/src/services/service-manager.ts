import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  type ApiErrorResponse,
  type CatalogEntryDetails,
  type CatalogEntrySummary,
  type DeployRequest,
  type DeployResponse,
  type FieldError,
  type FieldValues,
  type InstalledService,
  type RemoveResponse,
  SERVICE_ERROR_CODES,
  type ServiceErrorCode,
  type Job,
  TEXT_PATTERNS,
  valuesSchema,
} from '@homelab/shared';
import { BackupPlanManager } from '../backups/backup-plan-manager.js';
import { CatalogService } from '../catalog/catalog.service.js';
import type { CatalogEntry } from '../catalog/catalog.model.js';
import type { ExecutorActor } from '../executor/executor.model.js';
import { ExecutorService } from '../executor/executor.service.js';
import { WrapperConfigService } from '../executor/wrapper-config.js';
import type { Prisma } from '../generated/prisma/client.js';
import { SystemReader } from '../host/system-reader.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { checkFolder, checkPort, localFolder } from './host-checks.js';
import { ServiceJobs } from './service-jobs.js';
import { ServiceSecrets } from './service-secrets.js';

/** Output lines the topic carries per running job. */
const TOPIC_LINES = 50;
/** Failures where Compose may have created something: a first install is cleaned up after them. */
const CLEAN_UP_AFTER: readonly ServiceErrorCode[] = [
  SERVICE_ERROR_CODES.composeFailed,
  SERVICE_ERROR_CODES.timedOut,
];

/**
 * Installing and removing catalog services (docs/plans/service_deploys.md) — the orchestration:
 * checks the values (the shared schema plus friendly port and folder pre-checks), stores settings
 * and encrypted secrets (`ServiceSecrets`), and runs one job at a time (`ServiceJobs`) through the
 * executor — which audits and runs the root wrapper. A service's runtime state comes from the
 * `containers` topic (Compose project `hl-<id>`).
 */
@Injectable()
export class ServiceManager {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
    private readonly executor: ExecutorService,
    private readonly jobs: ServiceJobs,
    private readonly serviceSecrets: ServiceSecrets,
    private readonly wrapperConfig: WrapperConfigService,
    private readonly host: SystemReader,
    private readonly backups: BackupPlanManager,
  ) {}

  // Catalog.

  async listCatalog(): Promise<CatalogEntrySummary[]> {
    const services = await this.prisma.service.findMany({
      select: { catalogId: true, status: true },
    });
    const status = new Map(services.map((s) => [s.catalogId, s.status]));
    return this.catalog.list().map(({ meta }) => ({
      id: meta.id,
      name: meta.name,
      category: meta.category,
      status: status.get(meta.id) ?? null,
      backupFolders: meta.backup?.folders.map((f) => f.field) ?? [],
      backupRestoreNote: meta.backup?.restoreNote === true,
    }));
  }

  async catalogDetails(id: string): Promise<CatalogEntryDetails> {
    const entry = this.requireEntry(id);
    const existing = await this.prisma.service.findUnique({
      where: { catalogId: id },
      include: { secrets: { select: { key: true } } },
    });
    const config = this.wrapperConfig.config;
    const taken = await this.takenPorts(existing?.id);
    const suggested: FieldValues = {};
    for (const field of entry.meta.fields) {
      if (field.type === 'path') {
        suggested[field.key] = localFolder(field.default, config);
      } else if (field.type === 'port') {
        suggested[field.key] = this.freePortFrom(field.default, taken);
      } else if (field.type === 'text' && field.pattern === 'timezone') {
        const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (zone && TEXT_PATTERNS.timezone.test(zone)) suggested[field.key] = zone;
      }
    }
    // A previous install's settings come first: its data was set up with them.
    Object.assign(suggested, (existing?.settings as FieldValues | undefined) ?? {});
    return {
      meta: entry.meta,
      images: entry.images,
      volumes: entry.volumes,
      suggested,
      keptSecrets: this.serviceSecrets.keptKeys(entry, existing?.secrets.map((s) => s.key) ?? []),
      status: existing?.status ?? null,
    };
  }

  icon(id: string): Buffer {
    return this.requireEntry(id).icon;
  }

  // Installed services.

  async list(): Promise<InstalledService[]> {
    const services = await this.prisma.service.findMany({
      where: { status: { not: 'removed' } },
      orderBy: { createdAt: 'asc' },
      include: { jobs: { orderBy: { startedAt: 'desc' }, take: 1 } },
    });
    return services.map((service) => {
      const entry = this.catalog.get(service.catalogId);
      const settings = service.settings as FieldValues;
      const webPort = entry?.meta.webPort ? settings[entry.meta.webPort] : undefined;
      const latest = service.jobs[0];
      return {
        id: service.id,
        catalogId: service.catalogId,
        name: entry?.meta.name ?? service.catalogId,
        status: service.status,
        settings,
        webPort: typeof webPort === 'number' ? webPort : null,
        job: latest ? this.jobs.view(latest, TOPIC_LINES) : null,
        updatedAt: service.updatedAt.toISOString(),
      };
    });
  }

  async job(id: string): Promise<Job> {
    const job = await this.prisma.serviceJob.findUnique({ where: { id } });
    if (!job)
      throw new NotFoundException(error('No such job', SERVICE_ERROR_CODES.serviceNotFound));
    return this.jobs.view(job);
  }

  async deploy(
    { catalogId, values, includeInBackups }: DeployRequest,
    actor: ExecutorActor,
  ): Promise<DeployResponse> {
    const entry = this.requireEntry(catalogId);
    const claim = this.jobs.claim('deploy');
    try {
      const existing = await this.prisma.service.findUnique({
        where: { catalogId },
        include: { secrets: true },
      });
      if (existing && ['installing', 'installed', 'removing'].includes(existing.status)) {
        throw new ConflictException(
          error('Already installed', SERVICE_ERROR_CODES.alreadyInstalled),
        );
      }
      const stored = new Map(existing?.secrets.map((s) => [s.key, s.value]) ?? []);
      const checked = valuesSchema(entry.meta, {
        keptSecrets: this.serviceSecrets.keptKeys(entry, [...stored.keys()]),
      }).safeParse(values);
      if (!checked.success) {
        throw new BadRequestException(
          fieldErrors(
            checked.error.issues.map((i) => [String(i.path[0] ?? ''), i.code, i.message]),
          ),
        );
      }
      const problems = await this.preCheck(entry, checked.data, existing?.id);
      if (problems.length > 0) throw new BadRequestException(fieldErrors(problems));

      const { settings, secretValues } = this.serviceSecrets.resolve(
        entry,
        checked.data,
        existing ? { serviceId: existing.id, values: stored } : null,
      );

      const { service, job } = await this.prisma.$transaction(async (tx) => {
        const data = {
          catalogVersion: entry.meta.version,
          status: 'installing' as const,
          settings: settings as Prisma.InputJsonValue,
        };
        const service = await tx.service.upsert({
          where: { catalogId },
          create: { catalogId, ...data, createdById: actor.user.id },
          update: data,
        });
        await tx.serviceSecret.deleteMany({ where: { serviceId: service.id } });
        await tx.serviceSecret.createMany({
          data: this.serviceSecrets.rows(service.id, secretValues),
        });
        const job = await tx.serviceJob.create({
          data: {
            serviceId: service.id,
            kind: 'deploy',
            status: 'running',
            startedById: actor.user.id,
          },
        });
        return { service, job };
      });

      claim.start(job.id, service.id);
      // Always true today (an installed service can't be deployed again, see above). Kept for a
      // later "change settings" or update: a failed deploy must not remove a running service.
      const firstInstall = !existing || existing.status !== 'installed';
      void this.runDeploy(entry, service.id, settings, secretValues, actor, firstInstall).then(
        (installed) => {
          if (installed && includeInBackups)
            void this.backups.includeInstalledService(service.id, actor);
        },
      );
      return { serviceId: service.id, jobId: job.id };
    } catch (failure) {
      claim.release();
      throw failure;
    }
  }

  async remove(serviceId: string, actor: ExecutorActor): Promise<RemoveResponse> {
    const service = await this.prisma.service.findUnique({ where: { id: serviceId } });
    if (!service)
      throw new NotFoundException(error('No such service', SERVICE_ERROR_CODES.serviceNotFound));
    if (service.status !== 'installed' && service.status !== 'failed') {
      throw new ConflictException(error('Not installed', SERVICE_ERROR_CODES.notInstalled));
    }
    const entry = this.requireEntry(service.catalogId);
    const claim = this.jobs.claim('remove');
    try {
      const job = await this.prisma.$transaction(async (tx) => {
        await tx.service.update({ where: { id: serviceId }, data: { status: 'removing' } });
        return tx.serviceJob.create({
          data: { serviceId, kind: 'remove', status: 'running', startedById: actor.user.id },
        });
      });
      claim.start(job.id, serviceId);
      void this.runRemove(entry, serviceId, service.status, actor);
      return { jobId: job.id };
    } catch (failure) {
      claim.release();
      throw failure;
    }
  }

  // Jobs.

  private async runDeploy(
    entry: CatalogEntry,
    serviceId: string,
    settings: FieldValues,
    secretValues: Record<string, string>,
    actor: ExecutorActor,
    firstInstall: boolean,
  ): Promise<boolean> {
    const secrets = Object.values(secretValues);
    const outcome = await this.jobs.execute(() =>
      this.executor.composeUp({
        ...this.jobs.callbacks(),
        catalogId: entry.meta.id,
        serviceId,
        values: { ...settings, ...secretValues },
        secrets,
        fields: entry.meta.fields.map((f) => f.key),
        actor,
        audit: { catalogVersion: entry.meta.version, settings: settings as Prisma.InputJsonValue },
      }),
    );
    if (!outcome.ok && firstInstall && CLEAN_UP_AFTER.includes(outcome.code)) {
      // No half-created containers left behind (volumes and folders stay).
      this.jobs.appendOutput('— cleaning up —');
      await this.jobs.execute(() =>
        this.executor.composeDown({
          ...this.jobs.callbacks(),
          ...this.downRequest(entry, serviceId, secrets, actor),
        }),
      );
    }
    await this.jobs.finish(outcome, outcome.ok ? 'installed' : 'failed');
    return outcome.ok;
  }

  private async runRemove(
    entry: CatalogEntry,
    serviceId: string,
    previous: 'installed' | 'failed',
    actor: ExecutorActor,
  ): Promise<void> {
    const outcome = await this.jobs.execute(() =>
      this.executor.composeDown({
        ...this.jobs.callbacks(),
        ...this.downRequest(entry, serviceId, [], actor),
      }),
    );
    await this.jobs.finish(outcome, outcome.ok ? 'removed' : previous);
  }

  private downRequest(
    entry: CatalogEntry,
    serviceId: string,
    secrets: string[],
    actor: ExecutorActor,
  ) {
    return {
      catalogId: entry.meta.id,
      serviceId,
      secrets,
      fields: entry.meta.fields.map((f) => f.key),
      actor,
      audit: { catalogVersion: entry.meta.version },
    };
  }

  // Checks.

  private requireEntry(id: string): CatalogEntry {
    const entry = this.catalog.get(id);
    if (!entry)
      throw new NotFoundException(
        error('No such catalog entry', SERVICE_ERROR_CODES.catalogEntryNotFound),
      );
    return entry;
  }

  private async preCheck(
    entry: CatalogEntry,
    values: FieldValues,
    ownServiceId: string | undefined,
  ): Promise<[string, string, string][]> {
    const config = this.wrapperConfig.config;
    const taken = await this.takenPorts(ownServiceId);
    const problems: [string, string, string][] = [];
    const seen = new Set<number>();
    for (const field of entry.meta.fields) {
      const value = values[field.key];
      let code: ServiceErrorCode | null = null;
      if (field.type === 'port') {
        code =
          checkPort(value as number, config, taken) ??
          (seen.has(value as number) ? SERVICE_ERROR_CODES.portInUse : null);
        seen.add(value as number);
      } else if (field.type === 'path') {
        const path = value as string;
        code = checkFolder(path, entry.meta.id, config, await this.host.folder(path));
      }
      if (code) problems.push([field.key, code, `errors.${code}`]);
    }
    return problems;
  }

  /** Ports something listens on, plus those other installed services were given (even if stopped). */
  private async takenPorts(exceptServiceId?: string): Promise<Set<number>> {
    const taken = await this.host.listeningTcpPorts();
    const others = await this.prisma.service.findMany({
      where: {
        status: { in: ['installing', 'installed', 'removing'] },
        id: { not: exceptServiceId },
      },
    });
    for (const other of others) {
      const entry = this.catalog.get(other.catalogId);
      const settings = other.settings as FieldValues;
      for (const field of entry?.meta.fields ?? []) {
        if (field.type === 'port' && typeof settings[field.key] === 'number')
          taken.add(settings[field.key] as number);
      }
    }
    return taken;
  }

  private freePortFrom(port: number, taken: ReadonlySet<number>): number {
    const config = this.wrapperConfig.config;
    for (let candidate = port; candidate < port + 100 && candidate <= 65535; candidate++) {
      if (!checkPort(candidate, config, taken)) return candidate;
    }
    return port;
  }
}

function error(message: string, code: ServiceErrorCode): ApiErrorResponse {
  return { message, code };
}

/** A 400 with one error per field (`field` is the catalog field's key, as in the form). */
function fieldErrors(problems: [field: string, code: string, message: string][]): ApiErrorResponse {
  const errors: FieldError[] = problems.map(([field, code, message]) => ({ field, code, message }));
  return { message: 'Validation failed', code: SERVICE_ERROR_CODES.invalidValues, errors };
}
