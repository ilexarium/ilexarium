import { Component, signal, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { UpdateDialog } from './update-dialog';

@Component({
  imports: [UpdateDialog],
  template: `<ilex-update-dialog
    name="music"
    [inBackups]="inBackups()"
    [lastBackup]="lastBackup()"
    [backupRunning]="backupRunning()"
    [appBackingUp]="appBackingUp()"
    (backUp)="chosen.set('backUp')"
    (update)="chosen.set('update')"
  />`,
})
class Host {
  readonly dialog = viewChild.required(UpdateDialog);
  readonly inBackups = signal(true);
  readonly lastBackup = signal<string | null>(new Date(Date.now() - 3 * 3600_000).toISOString());
  readonly backupRunning = signal(false);
  readonly appBackingUp = signal(false);
  readonly chosen = signal<'backUp' | 'update' | null>(null);
}

const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
const button = (label: string) =>
  [...dialog()!.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === label,
  );
const lastLine = () => dialog()!.querySelector('[data-last-backup]')!.textContent!.trim();

async function open(change: (host: Host) => void = () => undefined) {
  const fixture = TestBed.createComponent(Host);
  change(fixture.componentInstance);
  await fixture.whenStable();
  fixture.componentInstance.dialog().open();
  await vi.waitFor(() => expect(dialog()).not.toBeNull());
  await fixture.whenStable();
  return fixture;
}

describe('UpdateDialog', () => {
  afterEach(() => document.querySelectorAll('[role="alertdialog"]').forEach((d) => d.remove()));

  it('says when it was last backed up; Update confirms', async () => {
    const fixture = await open();
    expect(lastLine()).toMatch(/^Last backed up .*3 hours ago/);
    expect(button('Update')!.disabled).toBe(false);
    button('Update')!.click();
    await fixture.whenStable();
    expect(fixture.componentInstance.chosen()).toBe('update');
  });

  it('Back up now is its own choice: it starts the backup, not the update', async () => {
    const fixture = await open();
    button('Back up now')!.click();
    await fixture.whenStable();
    expect(fixture.componentInstance.chosen()).toBe('backUp');
  });

  it('never backed up: says so', async () => {
    await open((host) => host.lastBackup.set(null));
    expect(lastLine()).toBe('Not backed up yet.');
  });

  it('not in the backups: says so, no Back up now', async () => {
    await open((host) => host.inBackups.set(false));
    expect(lastLine()).toContain('Not in the backups');
    expect(button('Back up now')).toBeUndefined();
    expect(button('Update')!.disabled).toBe(false);
  });

  it('its backup running: no update meanwhile, and no second backup', async () => {
    await open((host) => {
      host.backupRunning.set(true);
      host.appBackingUp.set(true);
    });
    expect(lastLine()).toContain('Its backup is running');
    expect(button('Update')!.disabled).toBe(true);
    expect(button('Back up now')!.disabled).toBe(true);
  });

  it('another backup running: Update still offered, Back up now not', async () => {
    await open((host) => host.backupRunning.set(true));
    expect(button('Update')!.disabled).toBe(false);
    expect(button('Back up now')!.disabled).toBe(true);
  });
});
