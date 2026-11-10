import { TestBed } from '@angular/core/testing';
import type { BackupsStatus } from '@ilex/shared';
import { BackupHeader } from './backup-header';

const status: BackupsStatus = {
  configured: true,
  warnings: ['lowSpace'],
  lastSuccessAt: null,
  nextRunAt: null,
  running: null,
  lastRun: null,
  items: [],
  restore: null,
  lastCheck: null,
};

async function render(path: string) {
  const fixture = TestBed.createComponent(BackupHeader);
  fixture.componentRef.setInput('status', status);
  fixture.componentRef.setInput('destinationPath', path);
  await fixture.whenStable();
  return fixture.nativeElement as HTMLElement;
}

describe('BackupHeader', () => {
  it('names a long disk path by its last folder, the whole path below it (no hover needed)', async () => {
    const el = await render('/media/anna/WD Elements 2TB/backups');
    const path = el.querySelector('#disk-title [title]')!;
    expect(path.textContent).toBe('…/backups');
    expect(path.getAttribute('title')).toBe('/media/anna/WD Elements 2TB/backups');
    expect(el.querySelector('[data-disk-tile]')!.textContent).toContain(
      '/media/anna/WD Elements 2TB/backups',
    );
    expect((await render('/mnt/usb')).querySelector('#disk-title [title]')!.textContent).toBe(
      '/mnt/usb',
    );
  });

  it('says a missing disk, and the warnings in a band', async () => {
    const el = await render('/mnt/usb');
    expect(el.querySelector('[data-disk-tile]')!.textContent).toContain('Not connected');
    expect(el.querySelector('[role="alert"]')!.textContent).toContain(
      'The backup disk is almost full',
    );
  });
});
