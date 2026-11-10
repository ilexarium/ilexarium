import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { AppSummary, BackupItem } from '@ilex/shared';
import { testAppItem, testItem } from '../../../core/backups/testing';
import type { ItemLabel, ItemRow } from '../backups.model';
import { BackupItems } from './backup-items';

const FOLDER = '0193a000-0000-7000-8000-000000000003';
const IMMICH = '0193a000-0000-7000-8000-000000000002';

const row = (item: BackupItem): ItemRow => ({ item, name: item.project, icon: null });

@Component({
  imports: [BackupItems],
  template: `<ilex-backup-items
    [active]="active()"
    [removed]="removed()"
    [addable]="addable"
    [labels]="labels"
    (openItem)="events.push('open:' + $event)"
    (remove)="events.push('remove:' + $event.item.id)"
    (addApp)="events.push('add:' + $event)"
    (browse)="events.push('browse')"
  />`,
})
class Host {
  readonly active = signal<ItemRow[]>([
    row(testAppItem('immich', { id: IMMICH })),
    row(testItem({ id: FOLDER, path: '/srv/docs' })),
  ]);
  readonly removed = signal<ItemRow[]>([]);
  readonly addable = [{ name: 'notes' } as AppSummary];
  readonly labels = new Map<string, ItemLabel>([
    [IMMICH, { text: 'immich', ltr: false }],
    [FOLDER, { text: '/srv/docs', ltr: true }],
  ]);
  readonly events: string[] = [];
}

async function render() {
  const fixture = TestBed.createComponent(Host);
  await fixture.whenStable();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

const menuItems = () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];

describe('BackupItems', () => {
  it('shows a card per item; a card opens its sheet', async () => {
    const { fixture, el } = await render();
    const cards = [...el.querySelectorAll('ilex-item-card')];
    expect(cards.map((c) => c.querySelector('h3')!.textContent!.trim())).toEqual([
      'immich',
      '/srv/docs',
    ]);
    el.querySelectorAll<HTMLButtonElement>('[data-open-sheet]')[1].click();
    expect(fixture.componentInstance.events).toEqual([`open:${FOLDER}`]);
  });

  it('offers the apps not in yet and a folder in the add tile', async () => {
    const { fixture, el } = await render();
    el.querySelector<HTMLButtonElement>('[data-add-tile]')!.click();
    await vi.waitFor(() => expect(menuItems()).toHaveLength(2));
    expect(menuItems().map((i) => i.textContent!.trim())).toEqual(['notes', 'A folder…']);
    menuItems()[0].click();
    expect(fixture.componentInstance.events).toEqual(['add:notes']);
    el.querySelector<HTMLButtonElement>('[data-add-tile]')!.click();
    await vi.waitFor(() => expect(menuItems()).toHaveLength(2));
    menuItems()[1].click();
    expect(fixture.componentInstance.events).toEqual(['add:notes', 'browse']);
  });

  it('lists removed apps quietly below, with their backups to delete', async () => {
    const { fixture, el } = await render();
    fixture.componentInstance.removed.set([row(testItem({ id: FOLDER, removed: true }))]);
    await fixture.whenStable();
    const removed = el.querySelector('section[aria-labelledby="removed-title"]')!;
    expect(removed.textContent).toContain('Their backups are kept');
    [...removed.querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === 'Delete backups')!
      .click();
    expect(fixture.componentInstance.events).toEqual([`remove:${FOLDER}`]);
  });
});
