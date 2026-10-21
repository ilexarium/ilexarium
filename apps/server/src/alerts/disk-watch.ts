import { ALERT_LIMITS, type DiskUsage } from '@laris/shared';
import type { AlertCondition, OpenAlert } from './alerts.model.js';

const FULL_FOR_MS = ALERT_LIMITS.diskFullMinutes * 60_000;

/** How full a disk is, in whole percent (rounded down: 89.9 % isn't 90 %). */
export function usedPercent(disk: Pick<DiskUsage, 'sizeBytes' | 'usedBytes'>): number {
  return disk.sizeBytes > 0 ? Math.floor((disk.usedBytes / disk.sizeBytes) * 100) : 0;
}

/**
 * The "disk filling up" rule (docs/plans/health_alerts.md): above 90 % for 5 minutes opens it —
 * critical from 97 %, a warning again below 95 % — and it closes below 85 % (so a disk at 90 %
 * doesn't open and close all day, nor one at 97 % send a message each time it crosses). A disk no longer mounted closes it (a disk mounted here has "disk missing" for that).
 */
export class DiskWatch {
  /** Mount point → when it went above the threshold. */
  private readonly fullSince = new Map<string, number>();
  private readonly open = new Set<string>();
  /** Mount points whose alert is critical. */
  private readonly critical = new Set<string>();

  restore(open: OpenAlert[]): void {
    for (const alert of open) {
      if (alert.kind !== 'diskFull') continue;
      this.open.add(alert.subject);
      if (alert.severity === 'critical') this.critical.add(alert.subject);
    }
  }

  /** The latest usage of every disk: the alerts that should be open now. */
  update(disks: DiskUsage[], now: number): AlertCondition[] {
    const found: AlertCondition[] = [];
    const mounted = new Set(disks.map((d) => d.mount));
    for (const mount of [...this.open, ...this.fullSince.keys()]) {
      if (!mounted.has(mount)) {
        this.open.delete(mount);
        this.critical.delete(mount);
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
      if (!this.open.has(disk.mount)) {
        this.critical.delete(disk.mount);
        continue;
      }
      if (percent >= ALERT_LIMITS.diskCriticalPercent) this.critical.add(disk.mount);
      else if (percent < ALERT_LIMITS.diskCriticalClearPercent) this.critical.delete(disk.mount);
      found.push({
        kind: 'diskFull',
        subject: disk.mount,
        severity: this.critical.has(disk.mount) ? 'critical' : 'warning',
        details: { percent },
      });
    }
    return found;
  }
}
