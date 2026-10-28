import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { BackupItem } from '@laris/shared';
import { testItem } from '../../../core/backups/testing';
import type { ItemLabel, ItemRow } from '../backups.model';
import { BackupItems } from './backup-items';

const ITEM = '0193a000-0000-7000-8000-000000000003';

const row = (change: Partial<BackupItem> = {}): ItemRow => ({
  item: testItem({ id: ITEM, path: '/srv/laris/docs', ...change }),
  name: null,
});

@Component({
  imports: [BackupItems],
  template: `<laris-backup-items
    [active]="active()"
    [removed]="removed()"
    [labels]="labels"
    (remove)="removals.push($event)"
  />`,
})
class Host {
  readonly active = signal<ItemRow[]>([row()]);
  readonly removed = signal<ItemRow[]>([]);
  readonly labels = new Map<string, ItemLabel>([[ITEM, { text: '/srv/laris/docs', ltr: true }]]);
  readonly removals: { itemId: string; deleteArchives: boolean }[] = [];
}

const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]')!;

describe('BackupItems', () => {
  afterEach(() => document.querySelectorAll('[role="alertdialog"]').forEach((d) => d.remove()));

  it('removes an item after a confirmation, keeping its backups unless asked', async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    el.querySelector<HTMLButtonElement>('button[aria-label^="Actions for"]')!.click();
    await vi.waitFor(() => expect(document.querySelector('[role="menuitem"]')).not.toBeNull());
    const items = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    items.find((i) => i.textContent?.includes('Remove from backups'))!.click();
    await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull());
    expect(dialog().textContent).toContain('existing backups are kept');
    [...dialog().querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === 'Remove')!
      .click();
    await fixture.whenStable();
    expect(fixture.componentInstance.removals).toEqual([{ itemId: ITEM, deleteArchives: false }]);
  });

  it('deletes the backups of a removed item only after its own confirmation', async () => {
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.active.set([]);
    fixture.componentInstance.removed.set([row({ removed: true })]);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    [...el.querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === 'Delete backups')!
      .click();
    await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull());
    expect(dialog().textContent).toContain("This can't be undone.");
    [...dialog().querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === 'Delete backups')!
      .click();
    await fixture.whenStable();
    expect(fixture.componentInstance.removals).toEqual([{ itemId: ITEM, deleteArchives: true }]);
  });
});
