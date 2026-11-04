import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { DockerCleanup } from '@laris/shared';
import { stubScreenWidth } from '../../../layout/testing';
import { FreeSpace } from './free-space';

const CLEANUP: DockerCleanup = {
  images: [
    { id: 'aaaaaaaaaaaa', tags: ['debian:13'], bytes: 2e8, created: '2026-10-01T00:00:00.000Z' },
    { id: 'bbbbbbbbbbbb', tags: [], bytes: 4e7, created: null },
    {
      id: 'cccccccccccc',
      tags: [`ghcr.io/immich-app/immich-server@sha256:${'d'.repeat(64)}`],
      bytes: 1e9,
      created: null,
    },
  ],
  imagesBytes: 2.2e8,
  buildCacheBytes: 1e9,
  volumes: [
    { name: 'navidrome_data', app: 'navidrome', anonymous: false, created: null },
    { name: 'f'.repeat(64), app: null, anonymous: true, created: null },
  ],
};

@Component({
  imports: [FreeSpace],
  template: `<laris-free-space
    [cleanup]="cleanup()"
    [volumeSizes]="sizes()"
    [pruning]="pruning()"
    (prune)="pruned.set(true)"
    (removeVolume)="removed.set($event)"
  />`,
})
class Host {
  readonly cleanup = signal(CLEANUP);
  readonly sizes = signal<Record<string, number | null> | null>(null);
  readonly pruning = signal(false);
  readonly pruned = signal(false);
  readonly removed = signal<string | null>(null);
}

const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]')!;
const button = (root: ParentNode, text: string) =>
  [...root.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === text,
  )!;

async function render() {
  const fixture = TestBed.createComponent(Host);
  await fixture.whenStable();
  return { fixture, el: fixture.nativeElement as HTMLElement, host: fixture.componentInstance };
}

describe('FreeSpace', () => {
  afterEach(() => document.querySelectorAll('[role="alertdialog"]').forEach((d) => d.remove()));

  it('lists unused images, the build cache and one button for both', async () => {
    const { el } = await render();
    expect(el.textContent).toContain('3 unused images');
    expect(el.textContent).toContain('debian:13');
    expect(el.textContent).toContain('bbbbbbbbbbbb'); // untagged: its ID
    expect(el.textContent).toContain(`immich-server@sha256:${'d'.repeat(12)}…`);
    expect(el.textContent).not.toContain('d'.repeat(13));
    expect(el.textContent).toContain('And 1.0 GB of build cache');
    expect(button(el, 'Free 1.2 GB')).toBeDefined();
  });

  it('frees only after confirming, listing what goes', async () => {
    const { fixture, el, host } = await render();
    button(el, 'Free 1.2 GB').click();
    await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull());
    await fixture.whenStable();
    expect(dialog().textContent).toContain('Free 1.2 GB?');
    expect(dialog().textContent).toContain('debian:13');
    expect(dialog().textContent).toContain('Build cache');
    expect(host.pruned()).toBe(false);
    button(dialog(), 'Free space').click();
    expect(host.pruned()).toBe(true);
  });

  it('shows the volumes, sizes as they arrive, and deletes one after its own dialog', async () => {
    const { fixture, el, host } = await render();
    expect(el.textContent).toContain('2 volumes no container uses');
    expect(el.textContent).toContain('Made for navidrome');
    expect(el.textContent).toContain('Made by a container, without a name');
    expect(el.querySelectorAll('.sr-only')[0].textContent).toContain('Calculating size');
    host.sizes.set({ navidrome_data: 2.1e9, ['f'.repeat(64)]: null });
    await fixture.whenStable();
    expect(el.textContent).toContain('2.1 GB');
    expect(el.textContent).toContain('Size unknown');

    el.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete volume navidrome_data"]',
    )!.click();
    await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull());
    await fixture.whenStable();
    expect(dialog().textContent).toContain('navidrome_data');
    expect(dialog().textContent).toContain('(2.1 GB)');
    expect(dialog().textContent).toContain('unless a backup has them');
    button(dialog(), 'Delete volume').click();
    expect(host.removed()).toBe('navidrome_data');
  });

  it('says when there is nothing to free', async () => {
    const { fixture, el, host } = await render();
    host.cleanup.set({ images: [], imagesBytes: 0, buildCacheBytes: 0, volumes: [] });
    await fixture.whenStable();
    expect(el.textContent).toContain('Docker keeps nothing unused right now.');
    expect(el.querySelector('button')).toBeNull();
  });

  it('shows freeing as pending', async () => {
    const { fixture, el, host } = await render();
    host.pruning.set(true);
    await fixture.whenStable();
    expect(button(el, 'Freeing space…').disabled).toBe(true);
  });

  it('keeps long names inside the card on phones', async () => {
    const restore = stubScreenWidth(375);
    try {
      const { el } = await render();
      const name = [...el.querySelectorAll('[dir="ltr"]')].find((n) =>
        n.textContent?.includes('f'.repeat(64)),
      )!;
      expect(name.className).toContain('break-all');
    } finally {
      restore();
    }
  });
});
