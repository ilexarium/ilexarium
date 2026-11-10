import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { BackupFoldersResponse } from '@ilex/shared';
import { FolderPicker } from './folder-picker';

const listing: BackupFoldersResponse = {
  path: '/srv/ilex',
  parent: null,
  readable: true,
  folders: [{ name: 'docs', path: '/srv/ilex/docs', allowed: true }],
};

@Component({
  imports: [FolderPicker],
  template: `<ilex-folder-picker
    [open]="open()"
    [listing]="listing"
    (choose)="chosen.push($event); open.set(false)"
    (cancel)="cancelled = cancelled + 1; open.set(false)"
  />`,
})
class Host {
  readonly open = signal(false);
  readonly listing = listing;
  readonly chosen: string[] = [];
  cancelled = 0;
}

const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
const button = (text: string) =>
  [...dialog()!.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === text,
  )!;

async function render() {
  const fixture = TestBed.createComponent(Host);
  await fixture.whenStable();
  fixture.componentInstance.open.set(true);
  await vi.waitFor(() => expect(dialog()).not.toBeNull());
  return fixture;
}

describe('FolderPicker', () => {
  afterEach(() => document.querySelectorAll('[role="alertdialog"]').forEach((d) => d.remove()));

  it('closes on Cancel, and says so', async () => {
    const fixture = await render();
    button('Cancel').click();
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(fixture.componentInstance.cancelled).toBe(1);
  });

  it('opens again after a Cancel', async () => {
    const fixture = await render();
    button('Cancel').click();
    await vi.waitFor(() => expect(dialog()).toBeNull());
    fixture.componentInstance.open.set(true);
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
  });

  it('closes when a folder is chosen, without reporting a cancel', async () => {
    const fixture = await render();
    button('Choose this folder').click();
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(fixture.componentInstance.chosen).toEqual(['/srv/ilex']);
    expect(fixture.componentInstance.cancelled).toBe(0);
  });
});
