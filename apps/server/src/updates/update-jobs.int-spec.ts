import { Test } from '@nestjs/testing';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetDatabase } from '../../test/database.js';
import { AuditService } from '../audit/audit.service.js';
import { ConfigModule } from '../config/config.module.js';
import { ChangesUnderway } from '../jobs/changes-underway.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UpdateJobs } from './update-jobs.js';
import type { UpdatePlaces } from './update-places.js';

const ID = '3b241101-e2bb-4255-8caf-4136c566a962';
const OWNER = { id: '0199f000-0000-7000-8000-000000000001', username: 'owner' };

describe('UpdateJobs (database)', () => {
  let prisma: PrismaService;
  let close: () => Promise<void>;
  let dir: string;
  let jobs: UpdateJobs;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, PrismaModule],
      providers: [AuditService],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    const auditService = moduleRef.get(AuditService);
    close = () => moduleRef.close();
    dir = mkdtempSync(join(tmpdir(), 'update-jobs-'));
    jobs = new UpdateJobs(
      { jobsDir: dir } as UpdatePlaces,
      prisma,
      auditService,
      new ChangesUnderway(),
    );
  });

  beforeEach(() => resetDatabase(prisma));

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await close();
  });

  const write = (...events: object[]) =>
    writeFileSync(join(dir, `${ID}.jsonl`), events.map((e) => `${JSON.stringify(e)}\n`).join(''));

  it('records an update’s end once — its run and the audit log — as the person who started it', async () => {
    await prisma.updateRun.create({
      data: {
        id: ID,
        fromVersion: '0.1.0',
        toVersion: '0.2.0',
        userId: OWNER.id,
        username: OWNER.username,
      },
    });
    write({ type: 'start', from: '0.1.0', to: '0.2.0' }, { type: 'phase', phase: 'stopped' });
    await jobs.refresh();
    expect(jobs.running()).toBe(true);

    write(
      { type: 'start', from: '0.1.0', to: '0.2.0' },
      { type: 'done', outcome: 'rolled_back', version: '0.1.0', error: 'install_failed' },
    );
    await jobs.refresh();
    await jobs.refresh();
    expect(jobs.running()).toBe(false);
    const run = await prisma.updateRun.findUniqueOrThrow({ where: { id: ID } });
    expect(run).toMatchObject({ outcome: 'rolled_back', error: 'install_failed' });
    expect(run.finishedAt).not.toBeNull();
    const audit = await prisma.auditEvent.findMany({ where: { action: 'laris.update_result' } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      outcome: 'failure',
      userId: OWNER.id,
      details: { from: '0.1.0', to: '0.2.0', result: 'rolled_back', reason: 'install_failed' },
    });
  });
});
