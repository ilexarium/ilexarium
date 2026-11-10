import { Component, signal, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { BackupArchive, BackupItem } from '@ilex/shared';
import { testAppItem, testItem } from '../../../core/backups/testing';
import type { ItemLabel, ItemRow, RestoreChoice } from '../backups.model';
import { RestoreDialog } from './restore-dialog';

const ITEM = '0193a000-0000-7000-8000-000000000002';

const row = (kind: BackupItem['kind'], appRemoved = false): ItemRow => ({
  item:
    kind === 'app'
      ? testAppItem('immich', { id: ITEM, appRemoved })
      : testItem({ id: ITEM, kind, path: kind === 'folder' ? '/srv/x' : null }),
  name: 'immich',
  icon: null,
});

@Component({
  imports: [RestoreDialog],
  template: `<ilex-restore-dialog
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

const folderInput = () => dialog().querySelector<HTMLInputElement>('input[dir="ltr"]')!;

describe('RestoreDialog', () => {
  afterEach(() => document.querySelectorAll('[role="alertdialog"]').forEach((d) => d.remove()));

  it('restores an app back where it was by default, from the newest backup', async () => {
    const fixture = await open(row('app'));
    expect(dialog().textContent).toContain('current folders are set aside');
    // The folders it replaces: the item's in the plan now.
    expect(dialog().textContent).toContain('Replaces these folders');
    expect(dialog().textContent).toContain('/home/anna/apps/immich/data');
    button('Restore in place').click();
    await fixture.whenStable();
    expect(fixture.componentInstance.chosen()).toEqual({
      itemId: ITEM,
      archive: `${ITEM}-2026-10-14T03:00:00`,
      target: null,
    });
  });

  it('restores an older backup into a chosen folder — never a system folder', async () => {
    const fixture = await open(row('app'));
    dialog().querySelectorAll<HTMLInputElement>('input[name="archive"]')[1].click();
    dialog().querySelectorAll<HTMLInputElement>('input[name="target"]')[1].click();
    await fixture.whenStable();
    folderInput().value = '/etc/restored';
    folderInput().dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(button('Restore').disabled).toBe(true);
    expect(dialog().textContent).toContain('system folder');
    folderInput().value = ' /home/anna/restored ';
    folderInput().dispatchEvent(new Event('input'));
    await fixture.whenStable();
    button('Restore').click();
    await fixture.whenStable();
    expect(fixture.componentInstance.chosen()).toEqual({
      itemId: ITEM,
      archive: `${ITEM}-2026-10-13T03:00:00`,
      target: '/home/anna/restored',
    });
  });

  it('offers this app’s own data only a folder', async () => {
    await open(row('platform'));
    expect(dialog().querySelectorAll('input[name="target"]')).toHaveLength(1);
    expect(dialog().textContent).not.toContain('Back in place');
  });
});
