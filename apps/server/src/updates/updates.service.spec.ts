import { HttpException } from '@nestjs/common';
import { UPDATE_ERROR_CODES } from '@laris/shared';
import { LARIS_VERSION } from '../common/laris-version.js';
import type { ChangesUnderway } from '../jobs/changes-underway.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { RootPrograms } from '../root-programs/root-programs.js';
import type { RootActor } from '../root-programs/root-programs.model.js';
import type { ReleaseCheck } from './release-check.js';
import type { UpdateJobs } from './update-jobs.js';
import { UpdatesService } from './updates.service.js';

const [major, minor] = LARIS_VERSION.split('.').map(Number);
const NEWER = `${major}.${minor! + 1}.0`;
const actor = {
  user: { id: 'u1', username: 'owner' },
  ip: '127.0.0.1',
  appSessionId: 's1',
} as RootActor;

function setup({
  configured = true,
  available = NEWER as string | null,
  running = false,
  appsChanging = false,
  started = { ok: true } as Awaited<ReturnType<RootPrograms['updateStart']>>,
} = {}) {
  const prisma = {
    updateCheck: {
      findUnique: vi.fn().mockResolvedValue({
        id: 1,
        checkAutomatically: true,
        checkedAt: null,
        checkError: null,
        newestPublished: null,
        availableVersion: available,
        availablePublished: '2026-11-20T10:00:00Z',
        availableNotes: null,
      }),
      upsert: vi.fn(),
    },
    updateRun: { create: vi.fn(), delete: vi.fn() },
  };
  const releaseCheck = { source: vi.fn().mockResolvedValue(configured ? { url: 'x' } : null) };
  const updateJobs = { latest: () => null, running: () => running, refresh: vi.fn() };
  const rootPrograms = { updateStart: vi.fn().mockResolvedValue(started) };
  const changesUnderway = { anyApp: () => appsChanging };
  const service = new UpdatesService(
    prisma as unknown as PrismaService,
    releaseCheck as unknown as ReleaseCheck,
    updateJobs as unknown as UpdateJobs,
    rootPrograms as unknown as RootPrograms,
    changesUnderway as unknown as ChangesUnderway,
  );
  return { service, prisma, rootPrograms };
}

async function refusal(promise: Promise<unknown>): Promise<[number, string]> {
  const error = (await promise.catch((e: unknown) => e)) as HttpException;
  return [error.getStatus(), (error.getResponse() as { code: string }).code];
}

describe('UpdatesService.start', () => {
  it('starts the newest checked release through the person’s sudo, its run recorded first', async () => {
    const { service, prisma, rootPrograms } = setup();
    const { id } = await service.start(NEWER, actor);
    expect(prisma.updateRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id,
        fromVersion: LARIS_VERSION,
        toVersion: NEWER,
        userId: 'u1',
      }),
    });
    expect(rootPrograms.updateStart).toHaveBeenCalledWith(id, NEWER, actor);
    expect(prisma.updateRun.create.mock.invocationCallOrder[0]).toBeLessThan(
      rootPrograms.updateStart.mock.invocationCallOrder[0]!,
    );
  });

  it.each([
    ['without an update source', { configured: false }, NEWER, UPDATE_ERROR_CODES.notConfigured],
    ['another version than the one found', {}, '99.0.0', UPDATE_ERROR_CODES.notAvailable],
    ['nothing found', { available: null }, NEWER, UPDATE_ERROR_CODES.notAvailable],
    // A running update tells ChangesUnderway too (UpdateJobs follows it).
    ['while an update runs', { appsChanging: true }, NEWER, UPDATE_ERROR_CODES.busy],
    ['while an app is being changed', { appsChanging: true }, NEWER, UPDATE_ERROR_CODES.busy],
  ])('refuses %s', async (_, options, version, code) => {
    const { service, rootPrograms } = setup(options);
    expect(await refusal(service.start(version, actor))).toEqual([409, code]);
    expect(rootPrograms.updateStart).not.toHaveBeenCalled();
  });

  it('forgets the run when laris-update refuses (a backup holds the lock)', async () => {
    const { service, prisma } = setup({ started: { ok: false, code: UPDATE_ERROR_CODES.busy } });
    expect(await refusal(service.start(NEWER, actor))).toEqual([409, UPDATE_ERROR_CODES.busy]);
    expect(prisma.updateRun.delete).toHaveBeenCalled();
  });
});

describe('UpdatesService.status', () => {
  it('shows a found release only while it’s newer than the installed one', async () => {
    expect((await setup().service.status()).available?.version).toBe(NEWER);
    expect((await setup({ available: LARIS_VERSION }).service.status()).available).toBeNull();
  });
});
