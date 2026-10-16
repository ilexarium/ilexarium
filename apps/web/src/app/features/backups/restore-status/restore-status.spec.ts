import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { BackupRestore } from '@homelab/shared';
import { RestoreStatus } from './restore-status';

const restore = (target: BackupRestore['target']): BackupRestore => ({
  id: '0193a000-0000-7000-8000-0000000000d1',
  itemId: '0193a000-0000-7000-8000-0000000000d2',
  archive: 'a',
  target,
  targetPath: null,
  setAside: [],
  setAsideDeleted: false,
  job: {
    id: '0193a000-0000-7000-8000-0000000000d1',
    kind: 'restore',
    status: 'running',
    phase: 'restoring',
    errorCode: null,
    errorField: null,
    startedAt: '2026-10-14T10:00:00.000Z',
    finishedAt: null,
    output: [],
    omitted: 0,
  },
});

@Component({
  imports: [RestoreStatus],
  template: `<app-restore-status [restore]="restore()" />`,
})
class Host {
  readonly restore = signal(restore('newFolder'));
}

async function steps(target: BackupRestore['target']) {
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.restore.set(restore(target));
  await fixture.whenStable();
  return [...(fixture.nativeElement as HTMLElement).querySelectorAll('li')].map((li) =>
    li.textContent!.trim(),
  );
}

describe('RestoreStatus', () => {
  it('shows only restoring for a restore to a new folder (nothing is stopped or started)', async () => {
    expect(await steps('newFolder')).toEqual(['Restoring', 'Restored']);
  });

  it('shows stopping and starting the service for a restore in place', async () => {
    expect(await steps('inPlace')).toEqual(['Stopping', 'Restoring', 'Starting', 'Restored']);
  });
});
