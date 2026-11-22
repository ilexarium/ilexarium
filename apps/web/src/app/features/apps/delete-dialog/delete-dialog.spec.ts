import { Component, signal, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { AppRemovalItem } from '@ilex/shared';
import { RemoveDialog } from './remove-dialog';

const FOLDER = '/home/anna/apps/music';
const ITEMS: AppRemovalItem[] = [
  { kind: 'settings', path: FOLDER, bytes: null, outside: false },
  { kind: 'folder', path: `${FOLDER}/data`, bytes: 2e9, outside: false },
  { kind: 'folder', path: '/srv/music', bytes: 5e10, outside: true },
  { kind: 'volume', path: 'music_cache', bytes: null, outside: false },
];

@Component({
  imports: [RemoveDialog],
  template: `<ilex-remove-dialog name="music" [items]="items()" (remove)="chosen.set($event)" />`,
})
class Host {
  readonly dialog = viewChild.required(RemoveDialog);
  readonly items = signal<AppRemovalItem[] | null>(ITEMS);
  readonly chosen = signal<AppRemovalItem[] | null>(null);
}

const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]')!;
const boxes = () => [...dialog().querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
const confirm = () =>
  [...dialog().querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    b.textContent?.trim().startsWith('Remove'),
  )!;

async function open() {
  const fixture = TestBed.createComponent(Host);
  await fixture.whenStable();
  fixture.componentInstance.dialog().open();
  await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull());
  await fixture.whenStable();
  return fixture;
}

describe('RemoveDialog', () => {
  afterEach(() => document.querySelectorAll('[role="alertdialog"]').forEach((d) => d.remove()));

  it('lists everything it could delete, nothing ticked: removing deletes nothing', async () => {
    const fixture = await open();
    expect(boxes()).toHaveLength(4);
    expect(boxes().every((b) => !b.checked)).toBe(true);
    expect(dialog().textContent).toContain("Outside the app's folder");
    expect(dialog().textContent).toContain('Its backups stay.');
    expect(confirm().textContent?.trim()).toBe('Remove');
    confirm().click();
    await fixture.whenStable();
    expect(fixture.componentInstance.chosen()).toEqual([]);
  });

  it('deletes what was ticked, warning when a folder outside the app’s is', async () => {
    const fixture = await open();
    boxes()[1].click();
    await fixture.whenStable();
    expect(dialog().querySelector('[role="alert"]')).toBeNull();
    boxes()[2].click();
    await fixture.whenStable();
    expect(dialog().querySelector('[role="alert"]')!.textContent).toContain('make sure nothing');
    expect(confirm().textContent?.trim()).toBe('Remove and delete 2 items');
    confirm().click();
    await fixture.whenStable();
    expect(fixture.componentInstance.chosen()).toEqual([ITEMS[1], ITEMS[2]]);
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
