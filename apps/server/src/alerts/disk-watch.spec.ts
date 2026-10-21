import type { DiskUsage } from '@laris/shared';
import { DiskWatch, usedPercent } from './disk-watch.js';

const MINUTE = 60_000;
const disk = (mount: string, percent: number): DiskUsage => ({
  device: '/dev/sdb1',
  mount,
  fsType: 'ext4',
  sizeBytes: 1000,
  usedBytes: percent * 10,
});

describe('DiskWatch', () => {
  it('opens after 5 minutes above 90 %, with how full it is', () => {
    const watch = new DiskWatch();
    expect(watch.update([disk('/mnt/usb', 91)], 0)).toEqual([]);
    expect(watch.update([disk('/mnt/usb', 92)], 5 * MINUTE - 1)).toEqual([]);
    expect(watch.update([disk('/mnt/usb', 93)], 5 * MINUTE)).toEqual([
      { kind: 'diskFull', subject: '/mnt/usb', severity: 'warning', details: { percent: 93 } },
    ]);
  });

  it('starts counting again when it dips below 90 % before the 5 minutes', () => {
    const watch = new DiskWatch();
    watch.update([disk('/', 95)], 0);
    watch.update([disk('/', 89)], 3 * MINUTE);
    watch.update([disk('/', 95)], 4 * MINUTE);
    expect(watch.update([disk('/', 95)], 6 * MINUTE)).toEqual([]);
    expect(watch.update([disk('/', 95)], 9 * MINUTE)).toHaveLength(1);
  });

  it('is critical above 97 %', () => {
    const watch = new DiskWatch();
    watch.update([disk('/', 98)], 0);
    expect(watch.update([disk('/', 98)], 5 * MINUTE)[0].severity).toBe('critical');
  });

  it('stays critical down to 95 %, so hovering at 97 % doesn’t flip it', () => {
    const watch = new DiskWatch();
    watch.update([disk('/', 98)], 0);
    const severity = (percent: number, at: number) =>
      watch.update([disk('/', percent)], at)[0].severity;
    expect(severity(97, 5 * MINUTE)).toBe('critical');
    expect(severity(96, 6 * MINUTE)).toBe('critical');
    expect(severity(97, 7 * MINUTE)).toBe('critical');
    expect(severity(95, 8 * MINUTE)).toBe('critical');
    expect(severity(94, 9 * MINUTE)).toBe('warning');
    expect(severity(96, 10 * MINUTE)).toBe('warning');
  });

  it('stays open down to 85 % and closes below it', () => {
    const watch = new DiskWatch();
    watch.update([disk('/', 95)], 0);
    watch.update([disk('/', 95)], 5 * MINUTE);
    expect(watch.update([disk('/', 86)], 6 * MINUTE)).toHaveLength(1);
    expect(watch.update([disk('/', 85)], 7 * MINUTE)).toHaveLength(1);
    expect(watch.update([disk('/', 84)], 8 * MINUTE)).toEqual([]);
  });

  it('closes for a disk no longer mounted', () => {
    const watch = new DiskWatch();
    watch.update([disk('/mnt/usb', 95)], 0);
    watch.update([disk('/mnt/usb', 95)], 5 * MINUTE);
    expect(watch.update([], 6 * MINUTE)).toEqual([]);
  });

  it('keeps an alert open from before a restart until the disk has space', () => {
    const watch = new DiskWatch();
    watch.restore([
      {
        id: 'a',
        kind: 'diskFull',
        subject: '/',
        severity: 'warning',
        details: { percent: 91 },
        openedAt: new Date(0),
        acknowledgedAt: null,
        lastSentAt: null,
      },
    ]);
    expect(watch.update([disk('/', 88)], 0)).toHaveLength(1);
    expect(watch.update([disk('/', 50)], MINUTE)).toEqual([]);
  });

  it('rounds down (89.9 % isn’t 90 %)', () => {
    expect(usedPercent({ sizeBytes: 1000, usedBytes: 899 })).toBe(89);
    expect(usedPercent({ sizeBytes: 0, usedBytes: 0 })).toBe(0);
  });
});
