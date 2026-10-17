import { computed, inject } from '@angular/core';
import {
  patchState,
  signalStore,
  withComputed,
  withHooks,
  withMethods,
  withState,
} from '@ngrx/signals';
import { PROCESS_LIMITS, type Process, type ProcessesUpdate, processKey } from '@homelab/shared';
import { toast } from '@spartan-ng/brain/sonner';
import { Translator } from '../../../core/i18n/translator';
import { ProcessesApi } from '../../../core/processes/processes-api';
import { RealtimeService } from '../../../core/realtime/realtime-service';
import { apiErrorText } from '../../../shared/forms/submission-errors';
import type { EndRequest, ProcessSort } from '../processes.model';

/** Rows shown at first (the busiest, as sorted): a long list is slow and endless on a phone. */
export const SHOWN_FIRST = 50;

interface ProcessesPageState {
  /** The latest from the topic; null until the first. */
  latest: ProcessesUpdate | null;
  /** What the page shows: the latest, or the one from when it was paused. */
  shown: ProcessesUpdate | null;
  paused: boolean;
  search: string;
  sort: ProcessSort;
  showSystem: boolean;
  /** All rows, not just the first `SHOWN_FIRST`. */
  showAll: boolean;
  /** Processes being signalled, for pending buttons. */
  pending: string[];
  /** Processes asked to stop (TERM), and when: "Force end" is offered once they ignore it. */
  asked: Record<string, number>;
  /** When the latest update arrived. */
  now: number;
}

const initialState: ProcessesPageState = {
  latest: null,
  shown: null,
  paused: false,
  search: '',
  sort: 'cpu',
  showSystem: false,
  showAll: false,
  pending: [],
  asked: {},
  now: 0,
};

const compare: Record<ProcessSort, (a: Process, b: Process) => number> = {
  cpu: (a, b) => b.cpuPercent - a.cpuPercent || b.memoryBytes - a.memoryBytes,
  memory: (a, b) => b.memoryBytes - a.memoryBytes,
  name: (a, b) => a.name.localeCompare(b.name) || a.pid - b.pid,
  pid: (a, b) => a.pid - b.pid,
};

/**
 * The Processes page's data, provided by the page and gone with it: every process (the
 * `processes` topic while the page is open), searching, sorting, pausing, and ending one — with
 * its toasts. A process asked to stop that still runs 5 s later can be forced.
 */
export const ProcessesPageStore = signalStore(
  withState<ProcessesPageState>(initialState),
  withComputed((store) => ({
    loaded: computed(() => store.shown() !== null),
    partial: computed(() => store.shown()?.partial ?? false),
    /** Searched, filtered (system processes only when asked) and sorted. */
    rows: computed(() => {
      const query = store.search().trim().toLowerCase();
      return (store.shown()?.processes ?? [])
        .filter((p) => store.showSystem() || !p.system)
        .filter(
          (p) =>
            !query ||
            p.name.toLowerCase().includes(query) ||
            p.command.toLowerCase().includes(query) ||
            (p.user ?? '').toLowerCase().includes(query),
        )
        .sort(compare[store.sort()]);
    }),
    /** Processes asked to stop that still run after the wait: offered "Force end". */
    forceable: computed(() => {
      const running = new Set((store.latest()?.processes ?? []).map(processKey));
      const wait = PROCESS_LIMITS.forceAfterSeconds * 1000;
      return Object.entries(store.asked())
        .filter(([key, at]) => running.has(key) && store.now() - at >= wait)
        .map(([key]) => key);
    }),
  })),
  withComputed((store) => ({
    /** The rows on the page: the first 50 unless all were asked for. */
    shownRows: computed(() =>
      store.showAll() ? store.rows() : store.rows().slice(0, SHOWN_FIRST),
    ),
    /** Rows not shown yet. */
    moreRows: computed(() =>
      store.showAll() ? 0 : Math.max(0, store.rows().length - SHOWN_FIRST),
    ),
  })),
  withMethods((store, api = inject(ProcessesApi), translator = inject(Translator)) => ({
    update(update: ProcessesUpdate): void {
      const running = new Set(update.processes.map(processKey));
      // Forget asked processes that have ended.
      const asked = Object.fromEntries(
        Object.entries(store.asked()).filter(([key]) => running.has(key)),
      );
      patchState(store, {
        latest: update,
        asked,
        now: Date.now(),
        ...(!store.paused() && { shown: update }),
      });
    },

    setSearch(search: string): void {
      patchState(store, { search });
    },
    setSort(sort: ProcessSort): void {
      patchState(store, { sort });
    },
    showEverything(): void {
      patchState(store, { showAll: true });
    },
    setShowSystem(showSystem: boolean): void {
      patchState(store, { showSystem });
    },
    togglePause(): void {
      const paused = !store.paused();
      patchState(store, { paused, ...(!paused && { shown: store.latest() }) });
    },

    /** Ends a process (already confirmed): asked to stop (TERM), or forced (KILL). */
    async end({ process, signal }: EndRequest): Promise<void> {
      const key = processKey(process);
      patchState(store, { pending: [...store.pending(), key] });
      try {
        await api.signal({ pid: process.pid, startTicks: process.startTicks, signal });
        if (signal === 'TERM') {
          patchState(store, { asked: { ...store.asked(), [key]: Date.now() } });
          toast.success(translator.t('processes.ended', { name: process.name }));
        } else {
          toast.success(translator.t('processes.forced', { name: process.name }));
        }
      } catch (error) {
        toast.error(translator.t('processes.endFailed'), {
          description: translator.t(...apiErrorText(error)),
        });
      } finally {
        patchState(store, { pending: store.pending().filter((p) => p !== key) });
      }
    },
  })),
  withHooks((store, realtime = inject(RealtimeService)) => {
    let stop: (() => void) | null = null;
    return {
      onInit() {
        stop = realtime.subscribe('processes', (message) => {
          if (message.event === 'processes:snapshot' || message.event === 'processes:update') {
            store.update(message.data);
          }
        });
      },
      onDestroy() {
        stop?.();
      },
    };
  }),
);
