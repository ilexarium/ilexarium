import { Component, signal, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { BackupArchive, BackupItem } from '@homelab/shared';
import type { ItemLabel, ItemRow, RestoreChoice } from '../backups.model';
import { RestoreDialog } from './restore-dialog';

const ITEM = '0193a000-0000-7000-8000-000000000002';

const row = (kind: BackupItem['kind'], removed = false): ItemRow => ({
  item: {
    id: ITEM,
    kind,
    serviceId: null,
    catalogId: kind === 'service' ? 'immich' : null,
    path: kind === 'folder' ? '/srv/x' : null,
    excludedFields: [],
    removed,
    lastSuccessAt: null,
    lastResult: null,
  },
  name: 'Immich',
  folders: [],
});

@Component({
  imports: [RestoreDialog],
  template: `<app-restore-dialog
    [archives]="archives()"
    [labels]="labels"
    (restore)="chosen.set($event)"
  />`,
})
class Host {
  readonly dialog = viewChild.required(RestoreDialog);
  readonly archives = signal<BackupArchive[] | null>(null);
  readonly labels = new Map<string, ItemLabel>([[ITEM, { text: 'Immich', ltr: false }]]);
  readonly chosen = signal<RestoreChoice | null>(null);
}

const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]')!;
const button = (text: string) =>
  [...dialog().querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === text,
  )!;

async function open(r: ItemRow) {
  const fixture = TestBed.createComponent(Host);
  await fixture.whenStable();
  fixture.componentInstance.dialog().open(r);
  await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull());
  fixture.componentInstance.archives.set([
    { name: `${ITEM}-2026-10-14T03:00:00`, createdAt: '2026-10-14T03:00:00.000Z' },
    { name: `${ITEM}-2026-10-13T03:00:00`, createdAt: '2026-10-13T03:00:00.000Z' },
  ]);
  await fixture.whenStable();
  return fixture;
}

describe('RestoreDialog', () => {
  afterEach(() => document.querySelectorAll('[role="alertdialog"]').forEach((d) => d.remove()));

  it('restores a service in place by default, from the newest backup', async () => {
    const fixture = await open(row('service'));
    expect(dialog().textContent).toContain('current folders are set aside');
    button('Restore in place').click();
    await fixture.whenStable();
    expect(fixture.componentInstance.chosen()).toEqual({
      itemId: ITEM,
      archive: `${ITEM}-2026-10-14T03:00:00`,
      target: 'inPlace',
    });
  });

  it('restores an older backup to a new folder when chosen', async () => {
    const fixture = await open(row('service'));
    dialog().querySelectorAll<HTMLInputElement>('input[name="archive"]')[1].click();
    dialog().querySelectorAll<HTMLInputElement>('input[name="target"]')[1].click();
    await fixture.whenStable();
    button('Restore').click();
    await fixture.whenStable();
    expect(fixture.componentInstance.chosen()).toEqual({
      itemId: ITEM,
      archive: `${ITEM}-2026-10-13T03:00:00`,
      target: 'newFolder',
    });
  });

  it('offers folders only a new folder', async () => {
    await open(row('folder'));
    expect(dialog().querySelectorAll('input[name="target"]')).toHaveLength(1);
    expect(dialog().textContent).not.toContain('Back in place');
  });

  it('says to install a removed service again after restoring it', async () => {
    await open(row('service', true));
    expect(dialog().textContent).toContain('Then install the service again');
  });
});
