import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { BackupRestore } from '@laris/shared';
import { RestoreStatus } from './restore-status';

const restore = (change: Partial<BackupRestore> = {}): BackupRestore => ({
  id: '0193a000-0000-7000-8000-0000000000d1',
  itemId: '0193a000-0000-7000-8000-0000000000d2',
  archive: 'a',
  targetPath: null,
  setAside: [],
  setAsideDeleted: false,
  status: 'running',
  phase: 'restoring',
  errorCode: null,
  startedAt: '2026-10-14T10:00:00.000Z',
  finishedAt: null,
  output: [],
  ...change,
});

@Component({
  imports: [RestoreStatus],
  template: `<laris-restore-status
    [restore]="restore()"
    [note]="note()"
    (discard)="discarded = discarded + 1"
  />`,
})
class Host {
  readonly restore = signal(restore());
  readonly note = signal<string | null>(null);
  discarded = 0;
}

async function show(change: Partial<BackupRestore>, note: string | null = null) {
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.restore.set(restore(change));
  fixture.componentInstance.note.set(note);
  await fixture.whenStable();
  return fixture;
}

const text = (fixture: { nativeElement: HTMLElement }) => fixture.nativeElement.textContent!;

describe('RestoreStatus', () => {
  it('shows the phase and output while it runs', async () => {
    const fixture = await show({ phase: 'stopping', output: ['stopping immich'] });
    expect(text(fixture)).toContain('Stopping the app…');
    expect(fixture.nativeElement.querySelector('pre')!.textContent).toContain('stopping immich');
  });

  it('a restore into a folder: where it went', async () => {
    const fixture = await show({ status: 'succeeded', phase: 'done', targetPath: '/home/anna/r' });
    expect(text(fixture)).toContain('Restored.');
    expect(text(fixture)).toContain('/home/anna/r');
    expect(fixture.nativeElement.querySelector('pre')).toBeNull();
  });

  it('back where it was: the template’s note, and the previous version until deleted', async () => {
    const fixture = await show(
      {
        status: 'succeeded',
        phase: 'done',
        setAside: ['/home/anna/apps/immich/data.before-restore'],
      },
      'backups.restore.succeeded',
    );
    expect(fixture.nativeElement.querySelector('[role="note"]')).not.toBeNull();
    expect(text(fixture)).toContain('data.before-restore');
    [...(fixture.nativeElement as HTMLElement).querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === 'Delete previous version')!
      .click();
    expect(fixture.componentInstance.discarded).toBe(1);
  });

  it('says it failed, with its output', async () => {
    const fixture = await show({ status: 'failed', output: ['borg: no such archive'] });
    expect(fixture.nativeElement.querySelector('[role="alert"]')!.textContent).toContain(
      'The restore failed.',
    );
    expect(text(fixture)).toContain('borg: no such archive');
  });
});
