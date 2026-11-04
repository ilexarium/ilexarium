import type { PublicUser } from '@laris/shared';
import type { AuditService } from '../audit/audit.service.js';
import type { AuditEntry } from '../audit/audit.model.js';
import { CleanupError, type DockerControl } from '../docker/docker-control.js';
import type { DockerService } from '../docker/docker.service.js';
import type { ChangesUnderway } from '../jobs/changes-underway.js';
import { DockerCleanupService } from './docker-cleanup.service.js';

const USER: PublicUser = {
  id: 'u1',
  username: 'owner',
  createdAt: '2026-10-12T00:00:00.000Z',
  displayName: null,
  email: null,
  language: null,
  avatar: null,
};
const ACTOR = { user: USER, ip: '127.0.0.1' };

const IMAGE = { id: 'aaaaaaaaaaaa', tags: ['debian:13'], bytes: 300, created: null };
const VOLUMES = [
  { name: 'laris_cache', composeProject: 'laris', anonymous: false, created: null },
  { name: 'music_cache', composeProject: 'music', anonymous: false, created: null },
  { name: 'f'.repeat(64), composeProject: null, anonymous: true, created: null },
];

/** Everything in call order: audit entries and Docker calls, so the order can be checked. */
function setup({ changing = false } = {}) {
  const calls: string[] = [];
  const entries: AuditEntry[] = [];
  const docker = {
    diskUsage: vi.fn(async () => ({ images: [IMAGE], imagesBytes: 300, buildCacheBytes: 15 })),
    unusedVolumes: vi.fn(async () => VOLUMES),
    protectedProjects: vi.fn(async () => new Set(['laris'])),
    volumeSizes: vi.fn(
      async () =>
        new Map<string, number | null>([
          ['laris_cache', 1],
          ['music_cache', 2100],
          ['in_use', 5],
        ]),
    ),
  };
  const control = {
    pruneImages: vi.fn(async () => {
      calls.push('docker prune images');
      // An image's own ID and one of its layers'.
      return {
        bytesFreed: 3000,
        deleted: [`sha256:${'a'.repeat(64)}`, `sha256:${'b'.repeat(64)}`],
      };
    }),
    pruneBuildCache: vi.fn(async () => {
      calls.push('docker prune build cache');
      return { bytesFreed: 500, deleted: ['c1'] };
    }),
    removeVolume: vi.fn(async (name: string) => {
      calls.push(`docker remove ${name}`);
    }),
  };
  const record = (entry: AuditEntry) => {
    calls.push(`audit ${entry.outcome}`);
    entries.push(entry);
  };
  const audit = {
    record: vi.fn(async (entry: AuditEntry) => record(entry)),
    tryRecord: vi.fn(async (entry: AuditEntry) => record(entry)),
  };
  const changes = { anyApp: vi.fn(() => changing) };
  const service = new DockerCleanupService(
    docker as unknown as DockerService,
    control as unknown as DockerControl,
    audit as unknown as AuditService,
    changes as unknown as ChangesUnderway,
  );
  return { service, docker, control, audit, calls, entries };
}

describe('DockerCleanupService', () => {
  describe('reading', () => {
    it('lists unused images, the build cache and unused volumes — not the platform’s own', async () => {
      const { service } = setup();
      await expect(service.overview()).resolves.toEqual({
        images: [IMAGE],
        imagesBytes: 300,
        buildCacheBytes: 15,
        volumes: [
          { name: 'music_cache', app: 'music', anonymous: false, created: null },
          { name: 'f'.repeat(64), app: null, anonymous: true, created: null },
        ],
      });
    });

    it('sizes only the volumes it lists', async () => {
      const { service } = setup();
      await expect(service.volumeSizes()).resolves.toEqual({
        sizes: { music_cache: 2100, ['f'.repeat(64)]: null },
      });
    });

    it('answers 503 when Docker cannot be asked', async () => {
      const { service, docker } = setup();
      docker.diskUsage.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
      await expect(service.overview()).rejects.toMatchObject({
        status: 503,
        response: { code: 'docker_unavailable' },
      });
      docker.volumeSizes.mockRejectedValueOnce(new Error('timeout'));
      await expect(service.volumeSizes()).rejects.toMatchObject({ status: 503 });
    });
  });

  describe('prune', () => {
    it('records the request (failing closed), removes images then the cache, records what was freed', async () => {
      const { service, audit, calls, entries } = setup();
      await expect(service.prune(ACTOR)).resolves.toEqual({ bytesFreed: 3500, images: 1 });
      expect(calls).toEqual([
        'audit requested',
        'docker prune images',
        'docker prune build cache',
        'audit success',
      ]);
      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(entries[0]).toEqual({
        action: 'docker.prune',
        outcome: 'requested',
        userId: 'u1',
        username: 'owner',
        ip: '127.0.0.1',
        details: {},
      });
      expect(entries[1]).toMatchObject({
        action: 'docker.prune',
        outcome: 'success',
        details: { bytesFreed: 3500, images: 1 },
      });
    });

    it('does not touch Docker when the request cannot be recorded', async () => {
      const { service, audit, control } = setup();
      audit.record.mockRejectedValueOnce(new Error('database down'));
      await expect(service.prune(ACTOR)).rejects.toThrow('database down');
      expect(control.pruneImages).not.toHaveBeenCalled();
      expect(audit.tryRecord).not.toHaveBeenCalled();
    });

    it('refuses while apps are being changed: a new image may not have its container yet', async () => {
      const { service, control, calls, entries } = setup({ changing: true });
      await expect(service.prune(ACTOR)).rejects.toMatchObject({
        status: 409,
        response: { code: 'changes_underway' },
      });
      expect(control.pruneImages).not.toHaveBeenCalled();
      expect(calls).toEqual(['audit failure']);
      expect(entries[0].details).toEqual({ reason: 'changes_underway' });
    });

    it('answers 503 without a request when Docker cannot be asked first', async () => {
      const { service, docker, control, calls } = setup();
      docker.diskUsage.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
      await expect(service.prune(ACTOR)).rejects.toMatchObject({ status: 503 });
      expect(control.pruneImages).not.toHaveBeenCalled();
      expect(calls).toEqual(['audit failure']);
    });

    it.each([
      [new CleanupError('failed'), 502, 'cleanup_failed'],
      [new CleanupError('unavailable'), 503, 'docker_unavailable'],
      [new Error('unexpected'), 502, 'cleanup_failed'],
    ])(
      'answers with an error when the images can’t be removed (%s)',
      async (failure, status, code) => {
        const { service, control, entries } = setup();
        control.pruneImages.mockRejectedValueOnce(failure);
        await expect(service.prune(ACTOR)).rejects.toMatchObject({ status, response: { code } });
        expect(control.pruneBuildCache).not.toHaveBeenCalled();
        expect(entries[1]).toMatchObject({ outcome: 'failure', details: { reason: code } });
      },
    );

    it('still says what was freed when only the build cache fails', async () => {
      const { service, control, entries } = setup();
      control.pruneBuildCache.mockRejectedValueOnce(new CleanupError('failed'));
      await expect(service.prune(ACTOR)).resolves.toEqual({
        bytesFreed: 3000,
        images: 1,
        buildCacheFailed: true,
      });
      expect(entries[1]).toMatchObject({
        outcome: 'failure',
        details: { bytesFreed: 3000, images: 1, reason: 'cleanup_failed' },
      });
    });
  });

  describe('removeVolume', () => {
    it('records the request, removes the volume, records the outcome', async () => {
      const { service, calls, entries } = setup();
      await service.removeVolume('music_cache', ACTOR);
      expect(calls).toEqual(['audit requested', 'docker remove music_cache', 'audit success']);
      expect(entries[0]).toEqual({
        action: 'docker.volume.remove',
        outcome: 'requested',
        userId: 'u1',
        username: 'owner',
        ip: '127.0.0.1',
        details: { volume: 'music_cache' },
      });
    });

    it('refuses the platform’s own volumes', async () => {
      const { service, control, calls, entries } = setup();
      await expect(service.removeVolume('laris_cache', ACTOR)).rejects.toMatchObject({
        status: 403,
        response: { code: 'volume_protected' },
      });
      expect(control.removeVolume).not.toHaveBeenCalled();
      expect(calls).toEqual(['audit failure']);
      expect(entries[0].details).toEqual({ volume: 'laris_cache', reason: 'volume_protected' });
    });

    it('refuses while apps are being changed', async () => {
      const { service, control } = setup({ changing: true });
      await expect(service.removeVolume('music_cache', ACTOR)).rejects.toMatchObject({
        status: 409,
        response: { code: 'changes_underway' },
      });
      expect(control.removeVolume).not.toHaveBeenCalled();
    });

    it('leaves a volume it doesn’t list to Docker: in use or gone', async () => {
      const { service, control } = setup();
      control.removeVolume.mockRejectedValueOnce(new CleanupError('in_use'));
      await expect(service.removeVolume('pgdata', ACTOR)).rejects.toMatchObject({
        status: 409,
        response: { code: 'volume_in_use' },
      });
      control.removeVolume.mockRejectedValueOnce(new CleanupError('not_found'));
      await expect(service.removeVolume('nope', ACTOR)).rejects.toMatchObject({
        status: 404,
        response: { code: 'volume_not_found' },
      });
    });

    it('answers 503 when Docker cannot be asked about protection', async () => {
      const { service, docker, control } = setup();
      docker.protectedProjects.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
      await expect(service.removeVolume('music_cache', ACTOR)).rejects.toMatchObject({
        status: 503,
        response: { code: 'docker_unavailable' },
      });
      expect(control.removeVolume).not.toHaveBeenCalled();
    });

    it('does not touch Docker when the request cannot be recorded', async () => {
      const { service, audit, control } = setup();
      audit.record.mockRejectedValueOnce(new Error('database down'));
      await expect(service.removeVolume('music_cache', ACTOR)).rejects.toThrow('database down');
      expect(control.removeVolume).not.toHaveBeenCalled();
    });
  });
});
