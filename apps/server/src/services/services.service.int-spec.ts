import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { PublicUser } from '@homelab/shared';
import { resetDatabase } from '../../test/database.js';
import { loadCatalog } from '../catalog/catalog-loader.js';
import type { CatalogService } from '../catalog/catalog.service.js';
import type { CatalogEntry } from '../catalog/catalog.model.js';
import { ConfigModule } from '../config/config.module.js';
import type { Env } from '../config/env.schema.js';
import type { DockerService } from '../docker/docker.service.js';
import type { ComposeOutcome, ComposeRequest } from '../executor/executor.model.js';
import type { ExecutorService } from '../executor/executor.service.js';
import type { WrapperConfigService } from '../executor/wrapper-config.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SecretsService } from '../secrets/secrets.service.js';
import { SystemReader } from '../host/system-reader.js';
import { ServiceJobs } from './service-jobs.js';
import { ServiceSecrets } from './service-secrets.js';
import { ServicesService } from './services.service.js';

const FIXTURES = fileURLToPath(new URL('../../test/fixtures/catalog', import.meta.url));

/** A fake executor: each call waits until the test settles it. */
class FakeExecutor {
  readonly up: ComposeRequest[] = [];
  readonly down: ComposeRequest[] = [];
  private pending: ((outcome: ComposeOutcome | Error) => void)[] = [];

  composeUp = vi.fn((request: ComposeRequest) => this.call(this.up, request));
  composeDown = vi.fn((request: ComposeRequest) => this.call(this.down, request));

  /** Settles the oldest waiting call. */
  settle(outcome: ComposeOutcome | Error): void {
    this.pending.shift()!(outcome);
  }

  private call(log: ComposeRequest[], request: ComposeRequest): Promise<ComposeOutcome> {
    log.push(request);
    return new Promise((resolve, reject) =>
      this.pending.push((outcome) =>
        outcome instanceof Error ? reject(outcome) : resolve(outcome),
      ),
    );
  }
}

describe('ServicesService (database)', () => {
  let prisma: PrismaService;
  let close: () => Promise<void>;
  let entry: CatalogEntry;
  let dir: string;
  let secrets: SecretsService;
  let executor: FakeExecutor;
  let containers: { composeProject: string; state: string }[];
  let services: ServicesService;
  let jobs: ServiceJobs;
  let user: PublicUser;
  const actor = () => ({ user, ip: '127.0.0.1' });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, PrismaModule],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    close = () => moduleRef.close();
    [entry] = await loadCatalog(FIXTURES);
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    const created = await prisma.user.create({ data: { username: 'owner', passwordHash: 'x' } });
    user = { id: created.id, username: 'owner', createdAt: created.createdAt.toISOString() };
    dir = mkdtempSync(join(tmpdir(), 'services-int-'));
    const config = {
      get: (name: string) => (name === 'MASTER_KEY_FILE' ? join(dir, 'master.key') : 'test'),
    } as unknown as ConfigService<Env, true>;
    secrets = new SecretsService(config);
    await secrets.onModuleInit();
    executor = new FakeExecutor();
    containers = [];
    const wrapperConfig = {
      config: {
        catalogDir: FIXTURES,
        storageRoots: [dir],
        serviceRoot: dir,
        reservedPorts: [22, 18099],
        protectedPaths: [],
        dockerBin: '/usr/bin/docker',
      },
    } as unknown as WrapperConfigService;
    jobs = new ServiceJobs(prisma, {
      listContainers: async () => containers,
    } as unknown as DockerService);
    services = new ServicesService(
      prisma,
      {
        get: (id: string) => (id === entry.meta.id ? entry : undefined),
        list: () => [entry],
      } as unknown as CatalogService,
      executor as unknown as ExecutorService,
      jobs,
      new ServiceSecrets(secrets),
      wrapperConfig,
      new SystemReader(),
    );
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  afterAll(() => close());

  const values = () => ({ WEB_PORT: 18090, SITE_DIR: join(dir, 'test-hello', 'site') });
  const finished = (jobId: string) =>
    vi.waitFor(async () => {
      const job = await prisma.serviceJob.findUniqueOrThrow({ where: { id: jobId } });
      expect(job.status).not.toBe('running');
      return job;
    });

  it('installs: settings plain, the generated secret encrypted, one job at a time', async () => {
    const { serviceId, jobId } = await services.deploy(
      { catalogId: 'test-hello', values: values() },
      actor(),
    );
    expect((await prisma.service.findUniqueOrThrow({ where: { id: serviceId } })).status).toBe(
      'installing',
    );

    // While it runs, nothing else may start.
    await expect(
      services.deploy({ catalogId: 'test-hello', values: values() }, actor()),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'busy' },
    });

    const request = executor.up[0];
    expect(request.values).toEqual({
      ...values(),
      TOKEN: expect.stringMatching(/^[A-Za-z0-9]{32}$/),
    });
    expect(request.secrets).toEqual([request.values!['TOKEN']]);
    expect(request.audit).toEqual({ catalogVersion: '1', settings: values() });
    request.onPhase('starting');
    request.onOutput('Container hl-test-hello-web-1 Started');
    executor.settle({ ok: true });

    const job = await finished(jobId);
    expect(job).toMatchObject({
      status: 'succeeded',
      phase: 'starting',
      output: 'Container hl-test-hello-web-1 Started',
    });
    const service = await prisma.service.findUniqueOrThrow({
      where: { id: serviceId },
      include: { secrets: true },
    });
    expect(service).toMatchObject({ status: 'installed', settings: values() });
    expect(secrets.decrypt(service.secrets[0].value, `service:${serviceId}:TOKEN`)).toBe(
      request.values!['TOKEN'],
    );
    expect(await services.list()).toEqual([
      expect.objectContaining({ catalogId: 'test-hello', status: 'installed', webPort: 18090 }),
    ]);
  });

  it('cleans up a failed first install where Compose ran, keeping the service as failed', async () => {
    const { serviceId, jobId } = await services.deploy(
      { catalogId: 'test-hello', values: values() },
      actor(),
    );
    executor.settle({ ok: false, code: 'compose_failed', field: null });
    await vi.waitFor(() => expect(executor.down).toHaveLength(1));
    expect(executor.down[0].secrets).toEqual(executor.up[0].secrets);
    executor.settle({ ok: true });
    expect(await finished(jobId)).toMatchObject({ status: 'failed', errorCode: 'compose_failed' });
    expect((await prisma.service.findUniqueOrThrow({ where: { id: serviceId } })).status).toBe(
      'failed',
    );
  });

  it('doesn’t clean up after a refusal (nothing was created), and keeps the field', async () => {
    const { jobId } = await services.deploy({ catalogId: 'test-hello', values: values() }, actor());
    executor.settle({ ok: false, code: 'port_in_use', field: 'WEB_PORT' });
    expect(await finished(jobId)).toMatchObject({
      status: 'failed',
      errorCode: 'port_in_use',
      errorField: 'WEB_PORT',
    });
    expect(executor.composeDown).not.toHaveBeenCalled();
  });

  it('fails the job when the audit log can’t record the request (nothing ran)', async () => {
    const { jobId } = await services.deploy({ catalogId: 'test-hello', values: values() }, actor());
    executor.settle(new Error('audit table missing'));
    expect(await finished(jobId)).toMatchObject({
      status: 'failed',
      errorCode: 'audit_unavailable',
    });
  });

  it('removes, keeps settings and secrets, and reinstalls with the same generated secret', async () => {
    const first = await services.deploy({ catalogId: 'test-hello', values: values() }, actor());
    executor.settle({ ok: true });
    await finished(first.jobId);

    const removal = await services.remove(first.serviceId, actor());
    executor.settle({ ok: true });
    expect(await finished(removal.jobId)).toMatchObject({ kind: 'remove', status: 'succeeded' });
    expect(
      (await prisma.service.findUniqueOrThrow({ where: { id: first.serviceId } })).status,
    ).toBe('removed');
    expect(await services.list()).toEqual([]);
    await expect(services.remove(first.serviceId, actor())).rejects.toMatchObject({ status: 409 });

    const details = await services.catalogDetails('test-hello');
    expect(details).toMatchObject({ status: 'removed', suggested: values() });

    const second = await services.deploy({ catalogId: 'test-hello', values: values() }, actor());
    expect(second.serviceId).toBe(first.serviceId);
    expect(executor.up[1].values!['TOKEN']).toBe(executor.up[0].values!['TOKEN']);
    executor.settle({ ok: true });
    await finished(second.jobId);
  });

  it('refuses values the schema or the pre-checks don’t accept, with errors on the fields', async () => {
    await expect(
      services.deploy(
        { catalogId: 'test-hello', values: { ...values(), WEB_PORT: 18099 } },
        actor(),
      ),
    ).rejects.toMatchObject({
      status: 400,
      response: { errors: [{ field: 'WEB_PORT', code: 'port_reserved' }] },
    });
    await expect(
      services.deploy(
        { catalogId: 'test-hello', values: { ...values(), SITE_DIR: '/etc' } },
        actor(),
      ),
    ).rejects.toMatchObject({
      status: 400,
      response: { errors: [{ field: 'SITE_DIR', code: 'path_not_allowed' }] },
    });
    await expect(
      services.deploy(
        { catalogId: 'test-hello', values: { ...values(), TOKEN: 'chosen by me' } },
        actor(),
      ),
    ).rejects.toMatchObject({ status: 400 });
    // A refused request releases the slot.
    const { jobId } = await services.deploy({ catalogId: 'test-hello', values: values() }, actor());
    executor.settle({ ok: true });
    await finished(jobId);
  });

  it.each([
    ['deploy', [{ composeProject: 'hl-test-hello', state: 'running' }], 'installed'],
    ['deploy', [], 'failed'],
    ['remove', [], 'removed'],
    ['remove', [{ composeProject: 'hl-test-hello', state: 'running' }], 'installed'],
  ] as const)(
    'after a restart, a %s job is interrupted and the service read back from Docker (%j → %s)',
    async (kind, running, expected) => {
      const service = await prisma.service.create({
        data: {
          catalogId: 'test-hello',
          catalogVersion: '1',
          status: kind === 'deploy' ? 'installing' : 'removing',
          settings: values(),
        },
      });
      const job = await prisma.serviceJob.create({
        data: { serviceId: service.id, kind, status: 'running' },
      });
      containers = [...running];
      await jobs.onApplicationBootstrap();
      expect(await prisma.serviceJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
        status: 'interrupted',
        errorCode: 'interrupted',
      });
      expect((await prisma.service.findUniqueOrThrow({ where: { id: service.id } })).status).toBe(
        expected,
      );
    },
  );
});
