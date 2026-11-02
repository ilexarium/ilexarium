import { Component, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { BackupItem } from '@laris/shared';
import { testItem } from '../../../core/backups/testing';
import type { ItemLabel, ItemRemoval, ItemRow } from '../backups.model';
import { RemoveItemDialog } from './remove-item-dialog';

const ITEM = '0193a000-0000-7000-8000-000000000003';

const row = (change: Partial<BackupItem> = {}): ItemRow => ({
  item: testItem({ id: ITEM, path: '/srv/laris/docs', ...change }),
  name: null,
  icon: null,
});

@Component({
  imports: [RemoveItemDialog],
  template: `<laris-remove-item-dialog [labels]="labels" (remove)="removals.push($event)" />`,
})
class Host {
  readonly dialog = viewChild.required(RemoveItemDialog);
  readonly labels = new Map<string, ItemLabel>([[ITEM, { text: '/srv/laris/docs', ltr: true }]]);
  readonly removals: ItemRemoval[] = [];
}

const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]')!;
const confirm = (text: string) =>
  [...dialog().querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!.click();

async function open(item: ItemRow) {
  const fixture = TestBed.createComponent(Host);
  await fixture.whenStable();
  fixture.componentInstance.dialog().open(item);
  await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull());
  return fixture;
}

describe('RemoveItemDialog', () => {
  afterEach(() => document.querySelectorAll('[role="alertdialog"]').forEach((d) => d.remove()));

  it('removes an item, keeping its backups unless asked', async () => {
    const fixture = await open(row());
    expect(dialog().textContent).toContain('Stop backing up /srv/laris/docs?');
    expect(dialog().textContent).toContain('existing backups are kept');
    confirm('Remove');
    await fixture.whenStable();
    expect(fixture.componentInstance.removals).toEqual([{ itemId: ITEM, deleteArchives: false }]);
  });

  it('deletes its backups too when ticked', async () => {
    const fixture = await open(row());
    dialog().querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
    await fixture.whenStable();
    confirm('Delete backups');
    await fixture.whenStable();
    expect(fixture.componentInstance.removals).toEqual([{ itemId: ITEM, deleteArchives: true }]);
  });

  it('only deletes the backups of an item removed earlier', async () => {
    const fixture = await open(row({ removed: true }));
    expect(dialog().textContent).toContain("This can't be undone.");
    expect(dialog().querySelector('input[type="checkbox"]')).toBeNull();
    confirm('Delete backups');
    await fixture.whenStable();
    expect(fixture.componentInstance.removals).toEqual([{ itemId: ITEM, deleteArchives: true }]);
  });
});
