import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { testAppItem, testItem } from '../../../core/backups/testing';
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
  template: `<ilex-item-sheet
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
    // Shown once saved: the folders come back with the item.
    expect(boxes[0].checked).toBe(false);
    expect(fixture.componentInstance.changes).toEqual([
      {
        itemId: ITEM,
        change: { folders: ['/home/anna/apps/immich/data', '/home/anna/apps/immich/cache'] },
      },
    ]);
    const select = sheet()!.querySelector<HTMLSelectElement>('#item-mode')!;
    select.value = 'live';
    select.dispatchEvent(new Event('change'));
    expect(select.value).toBe('stop');
    [...sheet()!.querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === 'Back up')!
      .click();
    expect(fixture.componentInstance.changes.slice(1)).toEqual([
      { itemId: ITEM, change: { mode: 'live' } },
      { itemId: ITEM, change: { skip: [] } },
    ]);
  });

  it('adds a subfolder to skip below a folder backed up; refuses one that leaves it', async () => {
    const fixture = TestBed.createComponent(Host);
    const two = immich();
    two.item.folders = ['/home/anna/apps/immich/data', '/home/anna/apps/immich/db'];
    two.item.skip = [];
    fixture.componentInstance.row.set(two);
    await vi.waitFor(() => expect(sheet()).not.toBeNull());
    const input = sheet()!.querySelector<HTMLInputElement>(
      'input[aria-label="A subfolder to skip"]',
    )!;
    const add = () =>
      [...sheet()!.querySelectorAll('button')]
        .find((b) => b.textContent?.trim() === 'Skip')!
        .click();
    const type = async (text: string) => {
      input.value = text;
      input.dispatchEvent(new Event('input'));
      await fixture.whenStable();
    };

    await type('../../secrets');
    add();
    await fixture.whenStable();
    expect(sheet()!.textContent).toContain('A path below the folder, without .. or brackets.');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(fixture.componentInstance.changes).toEqual([]);

    const folder = sheet()!.querySelector<HTMLSelectElement>('#skip-folder')!;
    folder.value = '/home/anna/apps/immich/db';
    folder.dispatchEvent(new Event('change'));
    await type('./cache/*.tmp');
    add();
    await fixture.whenStable();
    expect(fixture.componentInstance.changes).toEqual([
      { itemId: ITEM, change: { skip: ['/home/anna/apps/immich/db/cache/*.tmp'] } },
    ]);
    expect(input.value).toBe('');
    expect(sheet()!.textContent).not.toContain('without .. or brackets');

    // The chosen folder no longer backed up: below the first one instead.
    fixture.componentInstance.row.update((r) => ({
      ...r!,
      item: { ...r!.item, folders: ['/home/anna/apps/immich/data'] },
    }));
    await fixture.whenStable();
    await type('thumbs');
    add();
    expect(fixture.componentInstance.changes.at(-1)).toEqual({
      itemId: ITEM,
      change: { skip: ['/home/anna/apps/immich/data/thumbs'] },
    });
  });

  it('lets a folder item skip below its folder, without folders or a mode', async () => {
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.row.set({
      item: testItem({ id: ITEM, path: '/srv/docs', skip: ['/srv/docs/tmp'] }),
      name: null,
      icon: null,
    });
    await vi.waitFor(() => expect(sheet()).not.toBeNull());
    expect(sheet()!.querySelector('input[type="checkbox"]')).toBeNull();
    expect(sheet()!.querySelector('#item-mode')).toBeNull();
    expect(sheet()!.querySelector('#skip-folder')).toBeNull();
    expect(sheet()!.textContent).toContain('/srv/docs/tmp');
    const input = sheet()!.querySelector<HTMLInputElement>(
      'input[aria-label="A subfolder to skip"]',
    )!;
    const add = async (text: string) => {
      input.value = text;
      input.dispatchEvent(new Event('input'));
      [...sheet()!.querySelectorAll('button')]
        .find((b) => b.textContent?.trim() === 'Skip')!
        .click();
      await fixture.whenStable();
    };

    await add('../etc');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(fixture.componentInstance.changes).toEqual([]);
    await add('*.bak');
    [...sheet()!.querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === 'Back up')!
      .click();
    expect(fixture.componentInstance.changes).toEqual([
      { itemId: ITEM, change: { skip: ['/srv/docs/tmp', '/srv/docs/*.bak'] } },
      { itemId: ITEM, change: { skip: [] } },
    ]);
  });

  it('says why a pattern is refused below a folder whose name has brackets', async () => {
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.row.set({
      item: testItem({ id: ITEM, path: '/srv/old [1]' }),
      name: null,
      icon: null,
    });
    await vi.waitFor(() => expect(sheet()).not.toBeNull());
    const input = sheet()!.querySelector<HTMLInputElement>(
      'input[aria-label="A subfolder to skip"]',
    )!;
    const add = async (text: string) => {
      input.value = text;
      input.dispatchEvent(new Event('input'));
      [...sheet()!.querySelectorAll('button')]
        .find((b) => b.textContent?.trim() === 'Skip')!
        .click();
      await fixture.whenStable();
    };
    await add('*.tmp');
    expect(sheet()!.querySelector('#skip-error')!.textContent).toContain("can't be used below");
    expect(fixture.componentInstance.changes).toEqual([]);
    await add('cache');
    expect(fixture.componentInstance.changes).toEqual([
      { itemId: ITEM, change: { skip: ['/srv/old [1]/cache'] } },
    ]);
  });

  it('shows no skips for the platform', async () => {
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.row.set({
      item: testItem({ id: ITEM, kind: 'platform', path: null }),
      name: null,
      icon: null,
    });
    await vi.waitFor(() => expect(sheet()).not.toBeNull());
    expect(sheet()!.querySelector('input[aria-label="A subfolder to skip"]')).toBeNull();
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
