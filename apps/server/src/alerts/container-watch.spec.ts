import type { OpenAlert } from './alerts.model.js';
import { DOWN_AFTER_MS, EXPECTED_FOR_MS } from './alerts.constants.js';
import { ContainerWatch } from './container-watch.js';

const MINUTE = 60_000;
const kinds = (watch: ContainerWatch, now: number) =>
  watch.conditions(now).map((c) => `${c.kind}:${c.subject}:${c.severity}`);

describe('ContainerWatch', () => {
  let watch: ContainerWatch;
  beforeEach(() => {
    watch = new ContainerWatch();
    watch.seen([{ name: 'immich', catalogId: 'immich', running: true, health: 'healthy' }], 0);
  });

  describe('service down', () => {
    it('opens when a container died by itself and stays down for 30 s', () => {
      watch.died('immich', 'immich', 1_000);
      expect(kinds(watch, 1_000 + DOWN_AFTER_MS - 1)).toEqual([]);
      expect(kinds(watch, 1_000 + DOWN_AFTER_MS)).toEqual(['serviceDown:immich:critical']);
    });

    it('closes when it runs again', () => {
      watch.died('immich', 'immich', 0);
      expect(kinds(watch, DOWN_AFTER_MS)).toHaveLength(1);
      watch.started('immich', 'immich', 0);
      expect(kinds(watch, DOWN_AFTER_MS + 1)).toEqual([]);
    });

    it('doesn’t open when a restart policy brings it back within 30 s', () => {
      watch.died('immich', 'immich', 0);
      watch.started('immich', 'immich', 0);
      expect(kinds(watch, DOWN_AFTER_MS * 2)).toEqual([]);
    });

    it('doesn’t count a container stopped or restarted from the app', () => {
      watch.expect('immich', 0);
      watch.died('immich', 'immich', 1_000);
      expect(kinds(watch, 10 * MINUTE)).toEqual([]);
    });

    it('counts a crash soon after a restart from the app (it ran again in between)', () => {
      watch.expect('immich', 0);
      watch.died('immich', 'immich', 1_000);
      watch.started('immich', 'immich', 2_000);
      watch.died('immich', 'immich', 20_000);
      expect(kinds(watch, 20_000 + DOWN_AFTER_MS)).toEqual(['serviceDown:immich:critical']);
    });

    it('counts a death once the app’s stop is no longer expected', () => {
      watch.expect('immich', 0);
      watch.died('immich', 'immich', EXPECTED_FOR_MS);
      expect(kinds(watch, EXPECTED_FOR_MS + DOWN_AFTER_MS)).toEqual([
        'serviceDown:immich:critical',
      ]);
    });

    it('doesn’t count a container stopped on purpose (an install, a backup)', () => {
      watch.stoppedOnPurpose('immich', 'immich', 0);
      expect(kinds(watch, 10 * MINUTE)).toEqual([]);
    });

    it('a list asked for before the death doesn’t undo it', () => {
      watch.died('immich', 'immich', 1_000);
      watch.seen([{ name: 'immich', catalogId: 'immich', running: true, health: 'healthy' }], 500);
      expect(kinds(watch, 1_000 + DOWN_AFTER_MS)).toEqual(['serviceDown:immich:critical']);
      watch.seen(
        [{ name: 'immich', catalogId: 'immich', running: true, health: 'healthy' }],
        2_000,
      );
      expect(kinds(watch, 1_000 + DOWN_AFTER_MS)).toEqual([]);
    });

    it('a list showing stopped what ran before: its death was missed — it counts', () => {
      watch.seen([{ name: 'immich', catalogId: 'immich', running: false, health: 'none' }], MINUTE);
      expect(kinds(watch, MINUTE + DOWN_AFTER_MS)).toEqual(['serviceDown:immich:critical']);
    });

    it('a list showing it stopped doesn’t count when the app stopped it, or on purpose', () => {
      watch.expect('immich', 0);
      watch.seen(
        [{ name: 'immich', catalogId: 'immich', running: false, health: 'none' }],
        5 * MINUTE,
      );
      expect(kinds(watch, 10 * MINUTE)).toEqual([]);

      const other = new ContainerWatch();
      other.seen([{ name: 'immich', catalogId: 'immich', running: true, health: 'none' }], 0);
      other.seen(
        [{ name: 'immich', catalogId: 'immich', running: false, health: 'none' }],
        MINUTE,
        true,
      );
      expect(kinds(other, 10 * MINUTE)).toEqual([]);
    });

    it('a container already stopped when first seen doesn’t count (crash or on purpose: unknown)', () => {
      const fresh = new ContainerWatch();
      fresh.seen([{ name: 'immich', catalogId: 'immich', running: false, health: 'none' }], 0);
      expect(kinds(fresh, 10 * MINUTE)).toEqual([]);
    });

    it('forgets a container no longer listed (removed): its alerts close', () => {
      watch.died('immich', 'immich', 0);
      expect(kinds(watch, DOWN_AFTER_MS)).toHaveLength(1);
      watch.seen([], DOWN_AFTER_MS);
      expect(kinds(watch, DOWN_AFTER_MS)).toEqual([]);
    });
  });

  describe('restarting over and over', () => {
    it('opens at 3 deaths within 10 minutes', () => {
      for (const at of [0, 3 * MINUTE]) {
        watch.died('immich', 'immich', at);
        watch.started('immich', 'immich', at);
      }
      expect(kinds(watch, 4 * MINUTE)).toEqual([]);
      watch.died('immich', 'immich', 6 * MINUTE);
      watch.started('immich', 'immich', 6 * MINUTE);
      expect(kinds(watch, 6 * MINUTE)).toEqual(['restartLoop:immich:critical']);
    });

    it('doesn’t open for 3 deaths spread over more than 10 minutes', () => {
      for (const at of [0, 6 * MINUTE, 12 * MINUTE]) {
        watch.died('immich', 'immich', at);
        watch.started('immich', 'immich', at);
      }
      expect(kinds(watch, 12 * MINUTE)).toEqual([]);
    });

    it('closes after 10 minutes without a death', () => {
      for (const at of [0, MINUTE, 2 * MINUTE]) {
        watch.died('immich', 'immich', at);
        watch.started('immich', 'immich', at);
      }
      expect(kinds(watch, 2 * MINUTE)).toHaveLength(1);
      expect(kinds(watch, 12 * MINUTE - 1)).toHaveLength(1);
      expect(kinds(watch, 12 * MINUTE)).toEqual([]);
    });
  });

  describe('unhealthy', () => {
    it('opens when its health check fails for more than 2 minutes, closes when healthy', () => {
      watch.health('immich', 'immich', 'unhealthy', 0);
      expect(kinds(watch, 2 * MINUTE - 1)).toEqual([]);
      expect(kinds(watch, 2 * MINUTE)).toEqual(['unhealthy:immich:warning']);
      watch.health('immich', 'immich', 'healthy', 3 * MINUTE);
      expect(kinds(watch, 3 * MINUTE)).toEqual([]);
    });

    it('counts from the first failure, not from each list', () => {
      watch.health('immich', 'immich', 'unhealthy', 0);
      watch.seen(
        [{ name: 'immich', catalogId: 'immich', running: true, health: 'unhealthy' }],
        MINUTE,
      );
      expect(kinds(watch, 2 * MINUTE)).toEqual(['unhealthy:immich:warning']);
    });
  });

  it('out of memory: open for an hour', () => {
    watch.outOfMemory('immich', 'immich', 0);
    expect(kinds(watch, 59 * MINUTE)).toEqual(['outOfMemory:immich:warning']);
    expect(kinds(watch, 60 * MINUTE)).toEqual([]);
  });

  it('names the catalog entry; none for the platform’s own containers', () => {
    watch.died('laris-postgres', null, 0);
    watch.died('immich', 'immich', 0);
    const conditions = watch.conditions(DOWN_AFTER_MS);
    expect(conditions.find((c) => c.subject === 'immich')!.details).toEqual({
      catalogId: 'immich',
    });
    expect(conditions.find((c) => c.subject === 'laris-postgres')!.details).toEqual({});
  });

  it('picks up alerts still open from before a restart', () => {
    const open = (kind: OpenAlert['kind'], openedAt: number): OpenAlert => ({
      id: kind,
      kind,
      subject: 'immich',
      severity: 'critical',
      details: { catalogId: 'immich' },
      openedAt: new Date(openedAt),
      acknowledgedAt: null,
      lastSentAt: null,
    });
    const fresh = new ContainerWatch();
    const now = 100 * MINUTE;
    fresh.restore(
      [
        open('serviceDown', now - 5 * MINUTE),
        open('unhealthy', now - MINUTE),
        open('outOfMemory', now - 30 * MINUTE),
      ],
      now,
    );
    expect(kinds(fresh, now).sort()).toEqual([
      'outOfMemory:immich:warning',
      'serviceDown:immich:critical',
      'unhealthy:immich:warning',
    ]);
    // The first list shows it running and healthy: those close.
    fresh.seen([{ name: 'immich', catalogId: 'immich', running: true, health: 'healthy' }], now);
    expect(kinds(fresh, now)).toEqual(['outOfMemory:immich:warning']);
  });
});
