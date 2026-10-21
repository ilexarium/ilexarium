import { ALERT_LIMITS, type ContainerHealth } from '@laris/shared';
import type { AlertCondition, OpenAlert, WatchedContainer } from './alerts.model.js';

/** A container that died and didn't come back within this long has stopped (a restart policy brings it back sooner). */
export const DOWN_AFTER_MS = 30_000;
/** A stop or restart from the app: its `die` within this long doesn't count. */
export const EXPECTED_FOR_MS = 60_000;
const RESTART_WINDOW_MS = ALERT_LIMITS.restartWindowMinutes * 60_000;
const UNHEALTHY_MS = ALERT_LIMITS.unhealthyMinutes * 60_000;
const OUT_OF_MEMORY_MS = ALERT_LIMITS.outOfMemoryHours * 3_600_000;

/** The kinds this watch decides. */
export const CONTAINER_ALERT_KINDS = [
  'serviceDown',
  'restartLoop',
  'unhealthy',
  'outOfMemory',
] as const;

interface ContainerState {
  catalogId: string | null;
  /** Null until a list or an event says. */
  running: boolean | null;
  health: ContainerHealth;
  /** When it died by itself, while it hasn't run again. */
  diedAt: number | null;
  /** Its unexpected deaths within the restart window. */
  deaths: number[];
  looping: boolean;
  unhealthySince: number | null;
  outOfMemoryAt: number | null;
  /** A stop or restart from the app until then. */
  expectedUntil: number;
  /** When an event last said something about it: a list taken before that is older news. */
  eventAt: number;
  /** Stopped or restarted from the app, and not started since: a list showing it stopped is no news. */
  appStopped: boolean;
}

/**
 * The container rules (docs/plans/health_alerts.md), without Docker or time of its own: the
 * watcher feeds it events and lists, then asks which alerts should be open.
 *
 * - **Service down**: it died by itself and hasn't run again for 30 s. Not when stopped from the
 *   app (`expect`); the watcher leaves out deaths during installs, removals, restores and backups.
 * - **Restarting over and over**: 3 deaths within 10 minutes; closes after 10 minutes without one.
 * - **Unhealthy**: its health check failing for more than 2 minutes.
 * - **Out of memory**: the kernel killed it; closes after an hour.
 */
export class ContainerWatch {
  private readonly containers = new Map<string, ContainerState>();

  /** Picks up the alerts still open from before a restart, so they don't close at once. */
  restore(open: OpenAlert[], now: number): void {
    for (const alert of open) {
      const state = this.state(alert.subject, alert.details.catalogId ?? null);
      const openedAt = alert.openedAt.getTime();
      if (alert.kind === 'serviceDown') state.diedAt = openedAt - DOWN_AFTER_MS;
      if (alert.kind === 'restartLoop') {
        state.looping = true;
        state.deaths = [now];
      }
      if (alert.kind === 'unhealthy') {
        state.health = 'unhealthy';
        state.unhealthySince = openedAt - UNHEALTHY_MS;
      }
      if (alert.kind === 'outOfMemory') state.outOfMemoryAt = openedAt;
    }
  }

  /** The app is about to stop or restart it. */
  expect(name: string, now: number): void {
    const state = this.state(name, null);
    state.expectedUntil = now + EXPECTED_FOR_MS;
    state.appStopped = true;
  }

  /** It stopped (`die`). Counts unless the app stopped it. */
  died(name: string, catalogId: string | null, now: number): void {
    const state = this.state(name, catalogId);
    state.running = false;
    state.unhealthySince = null;
    state.eventAt = now;
    if (now < state.expectedUntil) return;
    state.diedAt ??= now;
    state.deaths.push(now);
  }

  /** It stopped, but not by itself (an install, a removal, a backup): forget it died. */
  stoppedOnPurpose(name: string, catalogId: string | null, now: number): void {
    const state = this.state(name, catalogId);
    state.eventAt = now;
    state.running = false;
    state.diedAt = null;
    state.unhealthySince = null;
  }

  /** It runs (again): the app's stop or restart is over — a death from now on counts. */
  started(name: string, catalogId: string | null, now: number): void {
    const state = this.state(name, catalogId);
    state.eventAt = now;
    state.running = true;
    state.diedAt = null;
    state.expectedUntil = 0;
    state.appStopped = false;
  }

  outOfMemory(name: string, catalogId: string | null, now: number): void {
    this.state(name, catalogId).outOfMemoryAt = now;
  }

  health(name: string, catalogId: string | null, health: ContainerHealth, now: number): void {
    const state = this.state(name, catalogId);
    state.eventAt = now;
    state.health = health;
    if (health !== 'unhealthy') state.unhealthySince = null;
    else state.unhealthySince ??= now;
  }

  /**
   * A list of the containers watched, asked for at `takenAt`: their states — except of those an
   * event has said something about since (the list is older news). One no longer there
   * (removed) is forgotten, and its alerts close. One last seen running and now stopped died —
   * its `die` event was missed (the events stream reconnecting) — unless the app stopped it or
   * `onPurpose` (an install, removal, restore or backup running). One already stopped when first
   * seen isn't counted: nothing tells whether it crashed or was stopped on purpose.
   */
  seen(list: WatchedContainer[], takenAt: number, onPurpose = false): void {
    const names = new Set(list.map((c) => c.name));
    for (const [name, state] of this.containers) {
      // Kept while the app's own stop is expected, or after news newer than the list.
      if (!names.has(name) && takenAt >= state.expectedUntil && takenAt >= state.eventAt) {
        this.containers.delete(name);
      }
    }
    for (const container of list) {
      const state = this.state(container.name, container.catalogId);
      state.catalogId = container.catalogId;
      if (state.eventAt > takenAt) continue;
      if (container.running) {
        if (state.running !== true) this.started(container.name, container.catalogId, takenAt);
      } else if (state.running === true && !state.appStopped && !onPurpose) {
        state.diedAt ??= takenAt;
      }
      state.running = container.running;
      const health = container.running ? container.health : 'none';
      state.health = health;
      if (health !== 'unhealthy') state.unhealthySince = null;
      else state.unhealthySince ??= takenAt;
    }
  }

  /** The alerts that should be open now. */
  conditions(now: number): AlertCondition[] {
    const found: AlertCondition[] = [];
    for (const [name, state] of this.containers) {
      const details = state.catalogId ? { catalogId: state.catalogId } : {};
      const add = (kind: AlertCondition['kind'], severity: AlertCondition['severity']) =>
        found.push({ kind, subject: name, severity, details });

      if (state.diedAt !== null && state.running !== true && now - state.diedAt >= DOWN_AFTER_MS) {
        add('serviceDown', 'critical');
      }
      state.deaths = state.deaths.filter((at) => now - at < RESTART_WINDOW_MS);
      // Opens at 3 within the window; stays open while the last one is within it.
      state.looping =
        state.deaths.length >= ALERT_LIMITS.restarts || (state.looping && state.deaths.length > 0);
      if (state.looping) add('restartLoop', 'critical');
      if (state.unhealthySince !== null && now - state.unhealthySince >= UNHEALTHY_MS) {
        add('unhealthy', 'warning');
      }
      if (state.outOfMemoryAt !== null && now - state.outOfMemoryAt < OUT_OF_MEMORY_MS) {
        add('outOfMemory', 'warning');
      }
    }
    return found;
  }

  private state(name: string, catalogId: string | null): ContainerState {
    let state = this.containers.get(name);
    if (!state) {
      state = {
        catalogId,
        running: null,
        health: 'none',
        diedAt: null,
        deaths: [],
        looping: false,
        unhealthySince: null,
        outOfMemoryAt: null,
        expectedUntil: 0,
        eventAt: 0,
        appStopped: false,
      };
      this.containers.set(name, state);
    }
    if (catalogId !== null) state.catalogId = catalogId;
    return state;
  }
}
