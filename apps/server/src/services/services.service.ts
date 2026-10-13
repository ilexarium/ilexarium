import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
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
  type JobPhase,
  type RemoveResponse,
  SERVICE_ERROR_CODES,
  type ServiceErrorCode,
  type ServiceJob,
  serviceProject,
  TEXT_PATTERNS,
  valuesSchema,
} from '@homelab/shared';
import { CatalogService } from '../catalog/catalog.service.js';
import type { CatalogEntry } from '../catalog/catalog.model.js';
import { DockerService } from '../docker/docker.service.js';
import type { ComposeOutcome, ExecutorActor } from '../executor/executor.model.js';
import { ExecutorService } from '../executor/executor.service.js';
import { WrapperConfigService } from '../executor/wrapper-config.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SecretsService } from '../secrets/secrets.service.js';
import { checkFolder, checkPort, listeningPorts, localFolder } from './host-checks.js';
import type { ActiveJob } from './services.model.js';

/** Output kept per job (the end matters most when something failed). */
const MAX_OUTPUT_BYTES = 256 * 1024;
/** Output lines the topic carries per running job. */
const TOPIC_LINES = 50;
const JOBS_KEPT = 20;
/** Failures where Compose may have created something: a first install is cleaned up after them. */
const CLEAN_UP_AFTER: readonly ServiceErrorCode[] = [
  SERVICE_ERROR_CODES.composeFailed,
  SERVICE_ERROR_CODES.timedOut,
];

const secretContext = (serviceId: string, key: string) => `service:${serviceId}:${key}`;

/**
 * Installing and removing catalog services (docs/plans/service_deploys.md). Checks the values
 * (the shared schema plus friendly port and folder pre-checks), stores settings and encrypted
 * secrets, and runs one job at a time through the executor — which audits and runs the root
 * wrapper. Progress goes to listeners (the `services` topic). A service's runtime state comes from
 * the `containers` topic (Compose project `hl-<id>`).
 */
@Injectable()
export class ServicesService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ServicesService.name);
  /** The one job running, platform-wide (the wrapper's lock enforces the same as root). */
  private active: ActiveJob | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
    private readonly executor: ExecutorService,
    private readonly secrets: SecretsService,
    private readonly wrapperConfig: WrapperConfigService,
    private readonly docker: DockerService,
  ) {}

  /** Called on every change (job phase, output, status). Returns the unsubscribe. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Jobs the app was running when it stopped are `interrupted`; their services are read back from Docker. */
  async onApplicationBootstrap(): Promise<void> {
    const stale = await this.prisma.serviceJob.findMany({
      where: { status: 'running' },
      include: { service: true },
    });
    for (const job of stale) {
      await this.prisma.serviceJob.update({
        where: { id: job.id },
        data: {
          status: 'interrupted',
          errorCode: SERVICE_ERROR_CODES.interrupted,
          finishedAt: new Date(),
        },
      });
      const status = await this.statusFromDocker(job.service.catalogId, job.kind);
      await this.prisma.service.update({ where: { id: job.serviceId }, data: { status } });
      this.logger.warn(
        `Job ${job.id} (${job.kind} ${job.service.catalogId}) was interrupted; service is ${status}`,
      );
    }
  }

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
      keptSecrets: this.keptSecretKeys(entry, existing?.secrets.map((s) => s.key) ?? []),
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
      const webPort = entry ? settings[entry.meta.webPort] : undefined;
      const latest = service.jobs[0];
      return {
        id: service.id,
        catalogId: service.catalogId,
        name: entry?.meta.name ?? service.catalogId,
        status: service.status,
        settings,
        webPort: typeof webPort === 'number' ? webPort : null,
        job: latest ? this.jobView(latest, TOPIC_LINES) : null,
        updatedAt: service.updatedAt.toISOString(),
      };
    });
  }

  async job(id: string): Promise<ServiceJob> {
    const job = await this.prisma.serviceJob.findUnique({ where: { id } });
    if (!job)
      throw new NotFoundException(error('No such job', SERVICE_ERROR_CODES.serviceNotFound));
    return this.jobView(job);
  }

  async deploy(
    { catalogId, values }: DeployRequest,
    actor: ExecutorActor,
  ): Promise<DeployResponse> {
    const entry = this.requireEntry(catalogId);
    const claim = this.claim();
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
      const kept = new Map(existing?.secrets.map((s) => [s.key, s.value]) ?? []);
      const checked = valuesSchema(entry.meta, {
        keptSecrets: this.keptSecretKeys(entry, [...kept.keys()]),
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

      // Secrets: entered, kept from a previous install, or generated.
      const settings: FieldValues = {};
      const secretValues: Record<string, string> = {};
      for (const field of entry.meta.fields) {
        const value = checked.data[field.key];
        const previous = existing && kept.get(field.key);
        const reuse = () => this.secrets.decrypt(previous!, secretContext(existing!.id, field.key));
        if (field.type === 'secret')
          secretValues[field.key] = value === '' && previous ? reuse() : String(value);
        else if (field.type === 'generatedSecret')
          secretValues[field.key] = previous ? reuse() : this.secrets.generate();
        else settings[field.key] = value;
      }

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
          data: Object.entries(secretValues).map(([key, value]) => ({
            serviceId: service.id,
            key,
            value: new Uint8Array(this.secrets.encrypt(value, secretContext(service.id, key))),
          })),
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
      void this.runDeploy(entry, service.id, settings, secretValues, actor, firstInstall);
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
    const claim = this.claim();
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
  ): Promise<void> {
    const secrets = Object.values(secretValues);
    const outcome = await this.execute(() =>
      this.executor.composeUp({
        ...this.callbacks(),
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
      this.appendOutput('— cleaning up —');
      await this.execute(() =>
        this.executor.composeDown({
          ...this.callbacks(),
          ...this.downRequest(entry, serviceId, secrets, actor),
        }),
      );
    }
    await this.finish(outcome, outcome.ok ? 'installed' : 'failed');
  }

  private async runRemove(
    entry: CatalogEntry,
    serviceId: string,
    previous: 'installed' | 'failed',
    actor: ExecutorActor,
  ): Promise<void> {
    const outcome = await this.execute(() =>
      this.executor.composeDown({
        ...this.callbacks(),
        ...this.downRequest(entry, serviceId, [], actor),
      }),
    );
    await this.finish(outcome, outcome.ok ? 'removed' : previous);
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

  /** The executor rejects only when the audit log couldn't record the request: then nothing ran. */
  private async execute(run: () => Promise<ComposeOutcome>): Promise<ComposeOutcome> {
    try {
      return await run();
    } catch (failure) {
      this.logger.error('Could not record the request in the audit log; nothing ran', failure);
      return { ok: false, code: SERVICE_ERROR_CODES.auditUnavailable, field: null };
    }
  }

  private callbacks() {
    return {
      onPhase: (phase: JobPhase) => {
        if (this.active) this.active.phase = phase;
        this.notify();
      },
      onOutput: (line: string) => this.appendOutput(line),
    };
  }

  private appendOutput(line: string): void {
    const job = this.active;
    if (!job) return;
    job.lines.push(line);
    job.bytes += Buffer.byteLength(line) + 1;
    while (job.bytes > MAX_OUTPUT_BYTES && job.lines.length > 1) {
      job.bytes -= Buffer.byteLength(job.lines.shift()!) + 1;
      job.omitted++;
    }
    this.notify();
  }

  private async finish(
    outcome: ComposeOutcome,
    status: 'installed' | 'failed' | 'removed',
  ): Promise<void> {
    const job = this.active;
    if (!job?.id) return;
    try {
      const output = [
        ...(job.omitted > 0 ? [`[… ${job.omitted} earlier lines not kept]`] : []),
        ...job.lines,
      ].join('\n');
      await this.prisma.$transaction([
        this.prisma.serviceJob.update({
          where: { id: job.id },
          data: {
            status: outcome.ok ? 'succeeded' : 'failed',
            phase: job.phase,
            errorCode: outcome.ok ? null : outcome.code,
            errorField: outcome.ok ? null : outcome.field,
            output,
            finishedAt: new Date(),
          },
        }),
        this.prisma.service.update({ where: { id: job.serviceId! }, data: { status } }),
      ]);
      await this.pruneJobs(job.serviceId!);
    } catch (failure) {
      this.logger.error(`Could not save the result of job ${job.id}`, failure);
    } finally {
      this.active = null;
      this.notify();
    }
  }

  private async pruneJobs(serviceId: string): Promise<void> {
    const old = await this.prisma.serviceJob.findMany({
      where: { serviceId },
      orderBy: { startedAt: 'desc' },
      skip: JOBS_KEPT,
      select: { id: true },
    });
    if (old.length > 0)
      await this.prisma.serviceJob.deleteMany({ where: { id: { in: old.map((j) => j.id) } } });
  }

  /** One job at a time: claimed before any await, so two requests can't both pass. */
  private claim() {
    if (this.active)
      throw new ConflictException(
        error('Another install or removal is running', SERVICE_ERROR_CODES.busy),
      );
    const job: ActiveJob = {
      id: null,
      serviceId: null,
      phase: null,
      lines: [],
      bytes: 0,
      omitted: 0,
    };
    this.active = job;
    return {
      start: (id: string, serviceId: string) => {
        job.id = id;
        job.serviceId = serviceId;
        this.notify();
      },
      release: () => {
        if (this.active === job) this.active = null;
      },
    };
  }

  private jobView(
    job: {
      id: string;
      kind: 'deploy' | 'remove';
      status: 'running' | 'succeeded' | 'failed' | 'interrupted';
      phase: string | null;
      errorCode: string | null;
      errorField: string | null;
      output: string;
      startedAt: Date;
      finishedAt: Date | null;
    },
    lastLines?: number,
  ): ServiceJob {
    const live = this.active?.id === job.id ? this.active : null;
    const lines = live ? live.lines : job.output ? job.output.split('\n') : [];
    const shown = lastLines === undefined ? lines : lines.slice(-lastLines);
    return {
      id: job.id,
      kind: job.kind,
      status: job.status,
      phase: ((live ? live.phase : job.phase) ?? null) as JobPhase | null,
      errorCode: job.errorCode,
      errorField: job.errorField,
      startedAt: job.startedAt.toISOString(),
      finishedAt: job.finishedAt?.toISOString() ?? null,
      output: shown,
      omitted: lines.length - shown.length + (live ? live.omitted : 0),
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

  /** Secret fields (entered by the user) a previous install has a value for. */
  private keptSecretKeys(entry: CatalogEntry, stored: string[]): string[] {
    return entry.meta.fields
      .filter((f) => f.type === 'secret' && stored.includes(f.key))
      .map((f) => f.key);
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
        code = checkFolder(value as string, entry.meta.id, config);
      }
      if (code) problems.push([field.key, code, `errors.${code}`]);
    }
    return problems;
  }

  /** Ports something listens on, plus those other installed services were given (even if stopped). */
  private async takenPorts(exceptServiceId?: string): Promise<Set<number>> {
    const taken = listeningPorts();
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

  private async statusFromDocker(
    catalogId: string,
    kind: 'deploy' | 'remove',
  ): Promise<'installed' | 'failed' | 'removed'> {
    const project = serviceProject(catalogId);
    try {
      const containers = (await this.docker.listContainers()).filter(
        (c) => c.composeProject === project,
      );
      if (kind === 'remove') return containers.length === 0 ? 'removed' : 'installed';
      return containers.length > 0 && containers.every((c) => c.state === 'running')
        ? 'installed'
        : 'failed';
    } catch {
      return kind === 'remove' ? 'installed' : 'failed';
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
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
