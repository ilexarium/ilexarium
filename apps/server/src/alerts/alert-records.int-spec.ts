import { Test } from '@nestjs/testing';
import { resetDatabase } from '../../test/database.js';
import { ConfigModule } from '../config/config.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AlertRecords, NEVER_SENT_AFTER_MS } from './alert-records.js';
import type { AlertCondition, AlertEvent } from './alerts.model.js';

const down = (subject: string, catalogId = subject): AlertCondition => ({
  kind: 'serviceDown',
  subject,
  severity: 'critical',
  details: { catalogId },
});
const full = (percent: number): AlertCondition => ({
  kind: 'diskFull',
  subject: '/mnt/usb',
  severity: percent >= 97 ? 'critical' : 'warning',
  details: { percent },
});
const OWNER = { id: '0199f000-0000-7000-8000-000000000001', username: 'owner' };

describe('AlertRecords (database)', () => {
  let prisma: PrismaService;
  let records: AlertRecords;
  let events: AlertEvent[];
  let close: () => Promise<void>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, PrismaModule],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    close = () => moduleRef.close();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    records = new AlertRecords(prisma);
    await records.onModuleInit();
    events = [];
    records.events$.subscribe((event) => events.push(event));
  });

  afterAll(() => close());

  const types = () => events.map((e) => `${e.type}:${e.alert.kind}:${e.alert.subject}`);

  it('opens an alert for a new problem, once — repeated reports don’t pile up', async () => {
    await records.reconcile(['serviceDown'], [down('immich')]);
    await records.reconcile(['serviceDown'], [down('immich')]);
    await records.reconcile(['serviceDown'], [down('immich'), down('immich')]);
    expect(await prisma.alert.count()).toBe(1);
    expect(types()).toEqual(['opened:serviceDown:immich']);
    const { open } = await records.view();
    expect(open).toEqual([
      expect.objectContaining({
        kind: 'serviceDown',
        subject: 'immich',
        severity: 'critical',
        catalogId: 'immich',
        closedAt: null,
      }),
    ]);
  });

  it('closes alerts of the reported kinds that are no longer seen, and only those', async () => {
    await records.reconcile(['serviceDown'], [down('immich'), down('jellyfin')]);
    await records.reconcile(['diskFull'], [full(91)]);
    await records.reconcile(['serviceDown'], [down('jellyfin')]);
    expect(types()).toEqual([
      'opened:serviceDown:immich',
      'opened:serviceDown:jellyfin',
      'opened:diskFull:/mnt/usb',
      'closed:serviceDown:immich',
    ]);
    const { open, closed } = await records.view();
    expect(open.map((a) => a.subject).sort()).toEqual(['/mnt/usb', 'jellyfin']);
    expect(closed.map((a) => a.subject)).toEqual(['immich']);
    expect(closed[0].closedAt).not.toBeNull();
  });

  it('opens a new alert when a closed problem comes back', async () => {
    await records.reconcile(['serviceDown'], [down('immich')]);
    await records.reconcile(['serviceDown'], []);
    await records.reconcile(['serviceDown'], [down('immich')]);
    expect(await prisma.alert.count()).toBe(2);
    expect(await prisma.alert.count({ where: { closedAt: null } })).toBe(1);
  });

  it('updates how full a disk is quietly; a more serious alert is an event', async () => {
    await records.reconcile(['diskFull'], [full(91)]);
    await records.reconcile(['diskFull'], [full(93)]);
    await records.reconcile(['diskFull'], [full(98)]);
    await records.reconcile(['diskFull'], [full(94)]);
    expect(types()).toEqual(['opened:diskFull:/mnt/usb', 'escalated:diskFull:/mnt/usb']);
    const { open } = await records.view();
    expect(open[0]).toMatchObject({ severity: 'warning', percent: 94 });
  });

  it('lists critical alerts first', async () => {
    await records.reconcile(['diskFull'], [full(91)]);
    await records.reconcile(['serviceDown'], [down('immich')]);
    await records.reconcile(
      ['backup'],
      [{ kind: 'backup', subject: 'lowSpace', severity: 'warning', details: {} }],
    );
    const { open } = await records.view();
    expect(open.map((a) => a.severity)).toEqual(['critical', 'warning', 'warning']);
    expect(open.find((a) => a.kind === 'backup')!.warning).toBe('lowSpace');
  });

  it('picks up the open alerts after a restart', async () => {
    await records.reconcile(['serviceDown'], [down('immich')]);
    const again = new AlertRecords(prisma);
    await again.onModuleInit();
    expect((await again.open()).map((a) => a.subject)).toEqual(['immich']);
    const seen: AlertEvent[] = [];
    again.events$.subscribe((event) => seen.push(event));
    await again.reconcile(['serviceDown'], [down('immich')]);
    expect(seen).toEqual([]);
    expect(await prisma.alert.count()).toBe(1);
  });

  it('acknowledges an open alert, with who did it', async () => {
    await records.reconcile(['serviceDown'], [down('immich')]);
    const [alert] = (await records.view()).open;
    expect(await records.acknowledge(alert.id, OWNER)).toBe(true);
    expect((await records.view()).open[0]).toMatchObject({ acknowledgedBy: 'owner' });
    expect((await records.view()).open[0].acknowledgedAt).not.toBeNull();
    expect(await records.acknowledge('0199f000-0000-7000-8000-00000000dead', OWNER)).toBe(false);
  });

  it('reminds of critical alerts sent more than a day ago, not acknowledged ones', async () => {
    await records.reconcile(['serviceDown'], [down('immich'), down('jellyfin')]);
    await records.reconcile(['diskFull'], [full(91)]);
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 86_400_000);
    for (const alert of await records.open()) await records.markSent(alert.id, dayAgo);
    const jellyfin = (await records.open()).find((a) => a.subject === 'jellyfin')!;
    await records.acknowledge(jellyfin.id, OWNER);
    expect((await records.dueReminders(now)).map((a) => a.subject)).toEqual(['immich']);
    expect(await records.dueReminders(new Date(now.getTime() - 1_000))).toEqual([]);
  });

  it('reminds of a critical alert never sent (no channel then), once it’s been open a while', async () => {
    await records.reconcile(['serviceDown'], [down('immich')]);
    const now = new Date();
    expect(await records.dueReminders(now)).toEqual([]);
    const later = new Date(now.getTime() + NEVER_SENT_AFTER_MS);
    expect((await records.dueReminders(later)).map((a) => a.subject)).toEqual(['immich']);
  });

  it('deletes alerts closed more than 30 days ago', async () => {
    await records.reconcile(['serviceDown'], [down('old'), down('recent')]);
    await records.reconcile(['serviceDown'], []);
    await prisma.alert.updateMany({
      where: { subject: 'old' },
      data: { closedAt: new Date(Date.now() - 31 * 86_400_000) },
    });
    await records.prune(new Date());
    expect((await prisma.alert.findMany()).map((a) => a.subject)).toEqual(['recent']);
  });
});
