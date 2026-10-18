import { TestBed } from '@angular/core/testing';
import type { DiskUsage } from '@homelab/shared';
import { DiskList } from './disk-list';

const GB = 1e9;
const disk = (mount: string, usedGb: number, sizeGb = 100): DiskUsage => ({
  device: `/dev/${mount.replace(/\W/g, '') || 'root'}`,
  mount,
  fsType: 'ext4',
  sizeBytes: sizeGb * GB,
  usedBytes: usedGb * GB,
});

async function render(disks: DiskUsage[]) {
  const fixture = TestBed.createComponent(DiskList);
  fixture.componentRef.setInput('disks', disks);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  return { el, items: () => [...el.querySelectorAll<HTMLLIElement>('li')] };
}

describe('DiskList', () => {
  it('shows each disk with used, total, percentage and free space', async () => {
    const { items } = await render([disk('/', 40)]);
    const [root] = items();
    expect(root.textContent).toContain('/dev/root · ext4');
    expect(root.textContent).toContain('40 GB of 100 GB used (40%)');
    expect(root.textContent).toContain('60 GB free');
    const bar = root.querySelector('hlm-progress')!;
    expect(bar.getAttribute('aria-label')).toBe('Space used on /');
    expect(bar.getAttribute('aria-valuenow')).toBe('40');
  });

  it('flags disks at 90% or more as almost full — in words, not only colour', async () => {
    const { items } = await render([disk('/', 89.9), disk('/data', 90), disk('/backup', 99)]);
    const [root, data, backup] = items();
    expect(root.textContent).not.toContain('Almost full');
    expect(root.hasAttribute('data-warning')).toBe(false);
    for (const item of [data, backup]) expect(item.textContent).toContain('Almost full');
    // A warning, then red from the alerts' critical limit (97%), like the alert it raises.
    expect(data.querySelector('app-status-badge')!.getAttribute('data-tone')).toBe('warning');
    expect(data.querySelector('hlm-progress-indicator')!.className).toContain('bg-warning');
    expect(backup.querySelector('app-status-badge')!.getAttribute('data-tone')).toBe('failed');
    expect(backup.querySelector('hlm-progress-indicator')!.className).toContain('bg-destructive');
  });

  it('says so when there are no disks', async () => {
    const { el } = await render([]);
    expect(el.textContent).toContain('No disks found.');
  });
});
