import { readJob } from './update-jobs.js';
import { JOB_STALE_MS, OUTPUT_LINES_KEPT } from './updates.constants.js';

const ID = '3b241101-e2bb-4255-8caf-4136c566a962';
const lines = (...events: object[]) => events.map((e) => JSON.stringify(e)).join('\n');
const now = Date.parse('2026-11-04T12:00:00Z');

describe('readJob (ilex-update’s job file)', () => {
  it('follows an update: phases, the download, the installer’s lines, its end', () => {
    const text = lines(
      { type: 'start', from: '0.1.0', to: '0.2.0', at: '2026-11-04T11:59:00Z' },
      { type: 'phase', phase: 'check' },
      { type: 'phase', phase: 'download', total: 1000 },
      { type: 'progress', bytes: 500, total: 1000 },
      { type: 'phase', phase: 'install' },
      { type: 'line', text: '==> Checking this machine' },
      { type: 'phase', phase: 'stopped' },
    );
    const job = readJob(ID, text, now, now)!;
    expect(job).toEqual({
      id: ID,
      from: '0.1.0',
      to: '0.2.0',
      startedAt: '2026-11-04T11:59:00Z',
      phase: 'stopped',
      download: { bytes: 500, total: 1000 },
      output: ['==> Checking this machine'],
      done: null,
    });
    const ended = readJob(
      ID,
      `${text}\n${lines({ type: 'done', outcome: 'rolled_back', version: '0.1.0', error: 'install_failed' })}\n`,
      now,
      now,
    )!;
    expect(ended.done).toEqual({
      outcome: 'rolled_back',
      version: '0.1.0',
      error: 'install_failed',
    });
  });

  it('skips what it doesn’t know and keeps only the last lines', () => {
    const text = lines(
      { type: 'start', from: '0.1.0', to: '0.2.0' },
      { type: 'phase', phase: 'format-disk' },
      { type: 'done', outcome: 'exploded', version: '0.2.0' },
      ...Array.from({ length: OUTPUT_LINES_KEPT + 5 }, (_, i) => ({
        type: 'line',
        text: `line ${i}`,
      })),
    );
    const job = readJob(ID, `${text}\n{not json`, now, now)!;
    expect(job.phase).toBeNull();
    expect(job.done).toBeNull();
    expect(job.output).toHaveLength(OUTPUT_LINES_KEPT);
    expect(job.output.at(-1)).toBe(`line ${OUTPUT_LINES_KEPT + 4}`);
  });

  it('is nothing without its start', () => {
    expect(readJob(ID, lines({ type: 'phase', phase: 'check' }), now, now)).toBeNull();
  });

  it('an update without an end long past its time limit was interrupted', () => {
    const text = lines({ type: 'start', from: '0.1.0', to: '0.2.0' });
    expect(readJob(ID, text, now - JOB_STALE_MS - 1, now)!.done).toEqual({
      outcome: 'failed',
      version: '0.1.0',
      error: 'interrupted',
    });
  });
});
