import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { DiskUsage } from '@ilex/shared';
import { shownDisks } from '../dashboard-page/dashboard-status';
import { DiskList } from './disk-list';

const GB = 1e9;
const disk = (mount: string, usedGb: number, sizeGb = 100): DiskUsage => ({
  device: `/dev/${mount.replace(/\W/g, '') || 'root'}`,
  mount,
  fsType: 'ext4',
  sizeBytes: sizeGb * GB,
  usedBytes: usedGb * GB,
});

async function render(disks: DiskUsage[], backupDestination: string | null = null) {
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(DiskList);
  fixture.componentRef.setInput('disks', shownDisks(disks, backupDestination));
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  return { el, items: () => [...el.querySelectorAll<HTMLLIElement>('li')] };
}

describe('DiskList', () => {
  it('shows each disk by name, with used, total, percentage and free space', async () => {
    const { items } = await render([disk('/', 40), disk('/mnt/photos', 10, 1000)], '/mnt/photos');
    const [root, photos] = items();
    expect(root.textContent).toContain('System disk');
    expect(root.textContent).toContain('40 GB of 100 GB used (40%)');
    expect(root.textContent).toContain('60 GB free');
    const bar = root.querySelector('hlm-progress')!;
    expect(bar.getAttribute('aria-label')).toBe('Space used on /');
    expect(bar.getAttribute('aria-valuenow')).toBe('40');
    expect(photos.textContent).toContain('Backup disk');
    expect(photos.textContent).toContain('/mnt/photos');
  });

  it('names other disks by their folder, left to right', async () => {
    const [, other] = (await render([disk('/', 1), disk('/mnt/music', 1)])).items();
    const name = other.querySelector('[dir="ltr"]')!;
    expect(name.textContent).toBe('music');
  });

  it('says in words when a disk is filling up (80%) or almost full (90%), not only by colour', async () => {
    const { items } = await render([disk('/', 79), disk('/mnt/a', 80), disk('/mnt/b', 90)]);
    const [root, filling, full] = items();
    expect(root.hasAttribute('data-level')).toBe(false);
    expect(filling.textContent).toContain('Filling up');
    expect(filling.querySelector('ilex-status-badge')!.getAttribute('data-tone')).toBe('warning');
    expect(filling.querySelector('hlm-progress-indicator')!.className).toContain('bg-warning');
    expect(full.textContent).toContain('Almost full');
    expect(full.querySelector('ilex-status-badge')!.getAttribute('data-tone')).toBe('failed');
    expect(full.querySelector('hlm-progress-indicator')!.className).toContain('bg-destructive');
  });

  it('links to freeing Docker’s unused data only while the system disk is filling up', async () => {
    const link = (el: HTMLElement) =>
      [...el.querySelectorAll('a')].find((a) => a.textContent?.trim() === 'Free space');
    expect(link((await render([disk('/', 79), disk('/mnt/usb', 95)])).el)).toBeUndefined();
    TestBed.resetTestingModule();
    const free = link((await render([disk('/', 85)])).el)!;
    expect(free.getAttribute('href')).toBe('/containers#free-space');
  });

  it('says so when there are no disks', async () => {
    const { el } = await render([]);
    expect(el.textContent).toContain('No disks found.');
  });
});
