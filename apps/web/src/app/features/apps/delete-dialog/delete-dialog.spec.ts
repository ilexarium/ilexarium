import { Component, signal, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { AppRemovalItem } from '@ilex/shared';
import { DeleteDialog } from './delete-dialog';

const FOLDER = '/home/anna/apps/music';
const ITEMS: AppRemovalItem[] = [
  { kind: 'settings', path: FOLDER, bytes: null, outside: false },
  { kind: 'folder', path: `${FOLDER}/data`, bytes: 2e9, outside: false },
  { kind: 'folder', path: '/srv/music', bytes: 5e10, outside: true },
  { kind: 'volume', path: 'music_cache', bytes: null, outside: false },
];

@Component({
  imports: [DeleteDialog],
  template: `<ilex-delete-dialog name="music" [items]="items()" (delete)="chosen.set($event)" />`,
})
class Host {
  readonly dialog = viewChild.required(DeleteDialog);
  readonly items = signal<AppRemovalItem[] | null>(ITEMS);
  readonly chosen = signal<AppRemovalItem[] | null>(null);
}

const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]')!;
const boxes = () => [...dialog().querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
const confirm = () =>
  [...dialog().querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    b.textContent?.trim().startsWith('Delete'),
  )!;

async function open(items: AppRemovalItem[] | null = ITEMS) {
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.items.set(items);
  await fixture.whenStable();
  fixture.componentInstance.dialog().open();
  await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull());
  await fixture.whenStable();
  return fixture;
}

describe('DeleteDialog', () => {
  afterEach(() => document.querySelectorAll('[role="alertdialog"]').forEach((d) => d.remove()));

  it('lists everything it could delete, nothing ticked: nothing to confirm yet', async () => {
    await open();
    expect(dialog().textContent).toContain('Delete files of');
    expect(boxes()).toHaveLength(4);
    expect(boxes().every((b) => !b.checked)).toBe(true);
    expect(dialog().textContent).toContain("Outside the app's folder");
    expect(dialog().textContent).toContain('Its backups stay.');
    expect(confirm().textContent?.trim()).toBe('Delete');
    expect(confirm().disabled).toBe(true);
  });

  it('deletes what was ticked, warning when a folder outside the app’s is', async () => {
    const fixture = await open();
    boxes()[1].click();
    await fixture.whenStable();
    expect(dialog().querySelector('[role="alert"]')).toBeNull();
    expect(confirm().textContent?.trim()).toBe('Delete 1 item');
    boxes()[2].click();
    await fixture.whenStable();
    expect(dialog().querySelector('[role="alert"]')!.textContent).toContain('make sure nothing');
    expect(confirm().textContent?.trim()).toBe('Delete 2 items');
    confirm().click();
    await fixture.whenStable();
    expect(fixture.componentInstance.chosen()).toEqual([ITEMS[1], ITEMS[2]]);
  });

  it('while the list loads: a placeholder, nothing to confirm', async () => {
    await open(null);
    expect(dialog().querySelector('[role="status"]')).not.toBeNull();
    expect(confirm().disabled).toBe(true);
  });

  it('opens with nothing ticked again', async () => {
    const fixture = await open();
    boxes()[0].click();
    await fixture.whenStable();
    fixture.componentInstance.dialog().open();
    await fixture.whenStable();
    expect(boxes().every((b) => !b.checked)).toBe(true);
  });
});
