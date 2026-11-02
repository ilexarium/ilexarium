import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { testAppItem } from '../../../core/backups/testing';
import type { ItemChange, ItemRow } from '../backups.model';
import { ItemSheet } from './item-sheet';

const ITEM = '0193a000-0000-7000-8000-000000000002';

const immich = (): ItemRow => ({
  item: testAppItem('immich', {
    id: ITEM,
    folders: ['/home/anna/apps/immich/data'],
    otherFolders: ['/home/anna/apps/immich/cache'],
    skip: ['/home/anna/apps/immich/data/thumbs'],
  }),
  name: 'immich',
  icon: null,
});

@Component({
  imports: [ItemSheet],
  template: `<laris-item-sheet
    [row]="row()"
    [label]="{ text: 'immich', ltr: false }"
    (change)="changes.push($event)"
    (closed)="closed = closed + 1"
  />`,
})
class Host {
  readonly row = signal<ItemRow | null>(null);
  readonly changes: ItemChange[] = [];
  closed = 0;
}

const sheet = () => document.querySelector<HTMLElement>('[data-item-sheet]');

describe('ItemSheet', () => {
  afterEach(() => document.querySelectorAll('[data-item-sheet]').forEach((s) => s.remove()));

  it('opens with the item: its folders, how and what is skipped; changes go out', async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    expect(sheet()).toBeNull();
    fixture.componentInstance.row.set(immich());
    await vi.waitFor(() => expect(sheet()).not.toBeNull());
    expect(sheet()!.querySelector('h2')!.textContent!.trim()).toBe('immich');
    const boxes = [...sheet()!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(boxes.map((b) => b.checked)).toEqual([false, true]);
    // The last folder backed up stays on.
    expect(boxes[1].disabled).toBe(true);
    expect(sheet()!.textContent).toContain('not backed up');
    boxes[0].click();
    expect(fixture.componentInstance.changes).toEqual([
      {
        itemId: ITEM,
        change: { folders: ['/home/anna/apps/immich/data', '/home/anna/apps/immich/cache'] },
      },
    ]);
    const select = sheet()!.querySelector<HTMLSelectElement>('#item-mode')!;
    select.value = 'live';
    select.dispatchEvent(new Event('change'));
    [...sheet()!.querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === 'Back up')!
      .click();
    expect(fixture.componentInstance.changes.slice(1)).toEqual([
      { itemId: ITEM, change: { mode: 'live' } },
      { itemId: ITEM, change: { skip: [] } },
    ]);
  });

  it('says when it closed itself (Escape), not when the page closed it', async () => {
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.row.set(immich());
    await vi.waitFor(() => expect(sheet()).not.toBeNull());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    sheet()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await vi.waitFor(() => expect(fixture.componentInstance.closed).toBe(1));
    fixture.componentInstance.row.set(null);
    await fixture.whenStable();
    expect(fixture.componentInstance.closed).toBe(1);
  });
});
