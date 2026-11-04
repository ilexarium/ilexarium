import type { UpdateJob, UpdatesStatus } from '@laris/shared';

export function updatesStatus(change: Partial<UpdatesStatus> = {}): UpdatesStatus {
  return {
    configured: true,
    installed: '0.1.0',
    available: null,
    newestPublished: '2026-11-01T10:00:00Z',
    checkedAt: '2026-11-04T10:00:00.000Z',
    checkError: null,
    checkAutomatically: true,
    job: null,
    ...change,
  };
}

export function updateJob(change: Partial<UpdateJob> = {}): UpdateJob {
  return {
    id: '3b241101-e2bb-4255-8caf-4136c566a962',
    from: '0.1.0',
    to: '0.2.0',
    startedAt: '2026-11-04T12:00:00.000Z',
    phase: null,
    download: null,
    output: [],
    done: null,
    ...change,
  };
}
