import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { BackupItem } from '@laris/shared';
import { testAppItem } from '../../../core/backups/testing';
import { formatBytes } from '../../../shared/format/format';
import type { ItemRow } from '../backups.model';
import { ItemCard } from './item-card';

const ITEM = '0193a000-0000-7000-8000-000000000002';
const result = (status: 'ok' | 'failed'): BackupItem['lastResult'] => ({
  itemId: ITEM,
  status,
  errorCode: status === 'failed' ? 'source_missing' : null,
  archive: 'a',
  originalBytes: 718e3,
  addedBytes: 1e3,
  warnings: [],
});

@Component({
  imports: [ItemCard],
  template: `<laris-item-card
    [row]="row()"
    [label]="{ text: 'immich', ltr: false }"
    [backingUp]="backingUp()"
    (open)="events.push('open')"
    (runNow)="events.push('run')"
    (restore)="events.push('restore')"
    (remove)="events.push('remove')"
  />`,
})
class Host {
  readonly row = signal<ItemRow>({
    item: testAppItem('immich', {
      id: ITEM,
      lastSuccessAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
      lastResult: result('ok'),
    }),
    name: 'immich',
    icon: '/catalog/immich/icon.svg',
  });
  readonly backingUp = signal(false);
  readonly events: string[] = [];
}

async function render() {
  const fixture = TestBed.createComponent(Host);
  await fixture.whenStable();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

describe('ItemCard', () => {
  it('shows the icon, the name, its state and when it was last backed up, how big', async () => {
    const { el } = await render();
    expect(el.querySelector('img')!.getAttribute('src')).toBe('/catalog/immich/icon.svg');
    expect(el.querySelector('h3')!.textContent!.trim()).toBe('immich');
    expect(el.querySelector('laris-status-dot')!.textContent!.trim()).toBe('OK');
    expect(el.textContent).toContain('Backed up 3 hours ago');
    expect(el.textContent).toContain(formatBytes(718e3));
  });

  it('pulses while it is backed up, says a failure and its reason', async () => {
    const { fixture, el } = await render();
    fixture.componentInstance.backingUp.set(true);
    await fixture.whenStable();
    expect(el.querySelector('laris-status-dot')!.textContent!.trim()).toBe('Running');
    fixture.componentInstance.backingUp.set(false);
    fixture.componentInstance.row.update((r) => ({
      ...r,
      item: { ...r.item, lastResult: result('failed') },
    }));
    await fixture.whenStable();
    expect(el.querySelector('laris-status-dot')!.textContent!.trim()).toBe('Failed');
    expect(el.textContent).toContain('A folder to back up is missing.');
  });

  it('opens its sheet; "⋯" backs up, restores, removes', async () => {
    const { fixture, el } = await render();
    el.querySelector<HTMLButtonElement>('[data-open-sheet]')!.click();
    el.querySelector<HTMLButtonElement>('button[aria-label="Actions for immich"]')!.click();
    await vi.waitFor(() => expect(document.querySelector('[role="menuitem"]')).not.toBeNull());
    const items = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    expect(items.map((i) => i.textContent!.trim())).toEqual([
      'Back up now',
      'Restore…',
      'Remove from backups',
    ]);
    items[1].click();
    expect(fixture.componentInstance.events).toEqual(['open', 'restore']);
  });
});
