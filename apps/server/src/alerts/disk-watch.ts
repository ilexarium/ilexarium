import { ALERT_LIMITS, type DiskUsage } from '@homelab/shared';
import type { AlertCondition, OpenAlert } from './alerts.model.js';

const FULL_FOR_MS = ALERT_LIMITS.diskFullMinutes * 60_000;

/** How full a disk is, in whole percent (rounded down: 89.9 % isn't 90 %). */
export function usedPercent(disk: Pick<DiskUsage, 'sizeBytes' | 'usedBytes'>): number {
  return disk.sizeBytes > 0 ? Math.floor((disk.usedBytes / disk.sizeBytes) * 100) : 0;
}

/**
 * The "disk filling up" rule (docs/plans/health_alerts.md): above 90 % for 5 minutes opens it —
 * critical above 97 % — and it closes below 85 % (so a disk at 90 % doesn't open and close all
 * day). A disk no longer mounted closes it (a disk mounted here has "disk missing" for that).
 */
export class DiskWatch {
  /** Mount point → when it went above the threshold. */
  private readonly fullSince = new Map<string, number>();
  private readonly open = new Set<string>();

  restore(open: OpenAlert[]): void {
    for (const alert of open) if (alert.kind === 'diskFull') this.open.add(alert.subject);
  }

  /** The latest usage of every disk: the alerts that should be open now. */
  update(disks: DiskUsage[], now: number): AlertCondition[] {
    const found: AlertCondition[] = [];
    const mounted = new Set(disks.map((d) => d.mount));
    for (const mount of [...this.open, ...this.fullSince.keys()]) {
      if (!mounted.has(mount)) {
        this.open.delete(mount);
        this.fullSince.delete(mount);
      }
    }
    for (const disk of disks) {
      const percent = usedPercent(disk);
      if (percent >= ALERT_LIMITS.diskFullPercent) {
        if (!this.fullSince.has(disk.mount)) this.fullSince.set(disk.mount, now);
        if (now - this.fullSince.get(disk.mount)! >= FULL_FOR_MS) this.open.add(disk.mount);
      } else {
        this.fullSince.delete(disk.mount);
        if (percent < ALERT_LIMITS.diskClearPercent) this.open.delete(disk.mount);
      }
      if (this.open.has(disk.mount)) {
        found.push({
          kind: 'diskFull',
          subject: disk.mount,
          severity: percent >= ALERT_LIMITS.diskCriticalPercent ? 'critical' : 'warning',
          details: { percent },
        });
      }
    }
    return found;
  }
}
