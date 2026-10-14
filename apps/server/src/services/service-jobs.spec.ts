import type { DockerService } from '../docker/docker.service.js';
import type { ServiceJob as ServiceJobRow } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { OperationSlot } from '../jobs/operation-slot.js';
import { ServiceJobs } from './service-jobs.js';

const row = (id: string, change: Partial<ServiceJobRow> = {}): ServiceJobRow => ({
  id,
  serviceId: 's1',
  kind: 'deploy',
  status: 'running',
  phase: null,
  errorCode: null,
  errorField: null,
  output: '',
  startedById: null,
  startedAt: new Date('2026-10-13T10:00:00Z'),
  finishedAt: null,
  ...change,
});

// Saving a result needs the database (service-manager.int-spec.ts); the slot and the output don't.
const jobs = (slot = new OperationSlot()) =>
  new ServiceJobs({} as PrismaService, {} as DockerService, slot);

describe('ServiceJobs', () => {
  it('runs one job at a time, and frees the slot of a request that failed before starting', () => {
    const service = jobs();
    const first = service.claim('deploy');
    expect(() => service.claim('deploy')).toThrow(expect.objectContaining({ status: 409 }));
    first.release();
    expect(() => service.claim('deploy')).not.toThrow();
  });

  it('shares the slot with backups: busy while a restore or a backup run holds it', () => {
    const slot = new OperationSlot();
    const release = slot.claim('restore');
    expect(() => jobs(slot).claim('deploy')).toThrow(expect.objectContaining({ status: 409 }));
    release();
    slot.followExternal(() => 'backup');
    expect(() => jobs(slot).claim('remove')).toThrow(expect.objectContaining({ status: 409 }));
  });

  it('shows the running job live from memory: phase and the last lines', () => {
    const service = jobs();
    const changes = vi.fn();
    service.onChange(changes);
    service.claim('deploy').start('j1', 's1');
    const { onPhase, onOutput } = service.callbacks();
    onPhase('pulling');
    for (let i = 1; i <= 60; i++) onOutput(`line ${i}`);
    const view = service.view(row('j1'), 50);
    expect(view.phase).toBe('pulling');
    expect(view.output).toHaveLength(50);
    expect(view.output.at(-1)).toBe('line 60');
    expect(view.omitted).toBe(10);
    expect(changes).toHaveBeenCalledTimes(62); // start, phase, 60 lines
  });

  it('keeps at most 256 KB of output, dropping the oldest lines', () => {
    const service = jobs();
    service.claim('deploy').start('j1', 's1');
    const line = 'x'.repeat(1023); // 1 KB with its newline
    for (let i = 0; i < 300; i++) service.appendOutput(line);
    const view = service.view(row('j1'));
    expect(view.output).toHaveLength(256);
    expect(view.omitted).toBe(44);
  });

  it('shows a finished job from its saved output', () => {
    const view = jobs().view(
      row('j9', { status: 'failed', output: 'a\nb\nc', errorCode: 'compose_failed' }),
      2,
    );
    expect(view).toMatchObject({
      status: 'failed',
      output: ['b', 'c'],
      omitted: 1,
      errorCode: 'compose_failed',
    });
  });

  it('turns an executor that couldn’t audit into audit_unavailable', async () => {
    const outcome = await jobs().execute(async () => {
      throw new Error('audit table missing');
    });
    expect(outcome).toEqual({ ok: false, code: 'audit_unavailable', field: null });
  });
});
