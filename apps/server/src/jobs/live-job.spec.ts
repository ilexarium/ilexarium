import type { JobRow } from './jobs.model.js';
import { jobView, LiveJob } from './live-job.js';

const row = (change: Partial<JobRow> = {}): JobRow => ({
  id: 'j1',
  kind: 'restore',
  status: 'running',
  phase: null,
  errorCode: null,
  errorField: null,
  output: '',
  startedAt: new Date('2026-10-14T10:00:00Z'),
  finishedAt: null,
  ...change,
});

describe('LiveJob', () => {
  it('keeps the newest 256 KB, and notes what it dropped when saved', () => {
    const live = new LiveJob();
    for (let i = 0; i < 300; i++) live.append('x'.repeat(1023));
    expect(live.lines).toHaveLength(256);
    expect(live.omitted).toBe(44);
    expect(live.savedOutput().split('\n')[0]).toBe('[… 44 earlier lines not kept]');
  });
});

describe('jobView', () => {
  it('shows the running job from memory, a finished one from its row', () => {
    const live = new LiveJob();
    live.id = 'j1';
    live.phase = 'restoring';
    live.append('a');
    expect(jobView(row(), live)).toMatchObject({ phase: 'restoring', output: ['a'] });
    expect(jobView(row({ id: 'j2', output: 'x\ny\nz', phase: 'done' }), live, 2)).toMatchObject({
      id: 'j2',
      phase: 'done',
      output: ['y', 'z'],
      omitted: 1,
    });
  });
});
