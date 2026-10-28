import { computed, inject } from '@angular/core';
import {
  patchState,
  signalStore,
  withComputed,
  withHooks,
  withMethods,
  withState,
} from '@ngrx/signals';
import {
  FILES_ERROR_CODES,
  type LinuxSignInRequest,
  type Process,
  type ProcessesUpdate,
  processKey,
} from '@laris/shared';
import { toast } from '@spartan-ng/brain/sonner';
import { firstValueFrom } from 'rxjs';
import { Translator } from '../../../core/i18n/translator';
import { LinuxSessionStore } from '../../../core/linux/linux-session-store';
import { ProcessesApi } from '../../../core/processes/processes-api';
import { RealtimeService } from '../../../core/realtime/realtime-service';
import { apiErrorCode, apiErrorText } from '../../../shared/forms/submission-errors';
import type {
  EndAs,
  EndRequest,
  LoadLevel,
  ProcessGroup,
  ProcessGroupId,
  ProcessSort,
} from '../processes.model';
import {
  DESCENDING_FIRST,
  GROUPS_SHOWN,
  LOAD_LEVELS,
  SHOWN_FIRST,
  SORT_ORDER,
} from './processes-page.constants';

interface ProcessesPageState {
  /** The latest from the topic; null until the first. */
  latest: ProcessesUpdate | null;
  /** What the page shows: the latest, or the one from when it was paused. */
  shown: ProcessesUpdate | null;
  paused: boolean;
  search: string;
  sort: ProcessSort;
  descending: boolean;
  showSystem: boolean;
  /** Only one group's processes ("Where it goes"), or null. */
  group: ProcessGroupId | null;
  /** Only zombies and processes waiting for the disk ("Needs attention"). */
  attention: boolean;
  /** All rows, not just the first `SHOWN_FIRST`. */
  showAll: boolean;
  /** Processes being signalled, for pending buttons. */
  pending: string[];
  /** Processes sent TERM: marked "still running" while they are. */
  asked: string[];
  /** When the latest update arrived. */
  now: number;
}

const initialState: ProcessesPageState = {
  latest: null,
  shown: null,
  paused: false,
  search: '',
  sort: 'cpu',
  descending: true,
  showSystem: false,
  group: null,
  attention: false,
  showAll: false,
  pending: [],
  asked: [],
  now: 0,
};

function groupOf(process: Process): ProcessGroupId {
  if (process.container) {
    return process.container.catalogId
      ? { kind: 'service', name: process.container.catalogId }
      : { kind: 'container', name: process.container.name ?? '' };
  }
  if (process.system) return { kind: 'system', name: '' };
  return { kind: 'person', name: process.user ?? String(process.uid) };
}

const sameGroup = (a: ProcessGroupId, b: ProcessGroupId) => a.kind === b.kind && a.name === b.name;
const needsAttention = (process: Process) =>
  process.state === 'zombie' || process.state === 'waiting';

/**
 * The Processes page's data, provided by the page and gone with it: every process (the
 * `processes` topic while the page is open) with the header's summary, searching, sorting,
 * filtering, pausing — and ending one as the signed-in Linux account (`LinuxSessionStore`), another
 * account's through its sudo, with its toasts. Linux decides what the account may end.
 */
export const ProcessesPageStore = signalStore(
  withState<ProcessesPageState>(initialState),
  withComputed((store, linuxSessionStore = inject(LinuxSessionStore)) => ({
    /** The Linux session processes are ended with; null until signed in. */
    linux: linuxSessionStore.session,
    loaded: computed(() => store.shown() !== null),
    partial: computed(() => store.shown()?.partial ?? false),
    summary: computed(() => store.shown()?.summary ?? null),
    /** Searched, filtered and sorted. */
    rows: computed(() => {
      const query = store.search().trim().toLowerCase();
      const group = store.group();
      const order = SORT_ORDER[store.sort()];
      const direction = store.descending() ? -1 : 1;
      return (store.shown()?.processes ?? [])
        .filter((p) =>
          group
            ? sameGroup(groupOf(p), group)
            : store.attention() || store.showSystem() || !p.system,
        )
        .filter((p) => !store.attention() || needsAttention(p))
        .filter(
          (p) =>
            !query ||
            p.name.toLowerCase().includes(query) ||
            p.command.toLowerCase().includes(query) ||
            (p.user ?? '').toLowerCase().includes(query),
        )
        .sort((a, b) => direction * order(a, b));
    }),
    /** "Where it goes": CPU (share of the machine) and memory by service, person and system. */
    groups: computed<ProcessGroup[]>(() => {
      const update = store.shown();
      if (!update) return [];
      const groups = new Map<string, ProcessGroup>();
      for (const process of update.processes) {
        const id = groupOf(process);
        const key = `${id.kind}:${id.name}`;
        const group = groups.get(key) ?? { ...id, cpuPercent: 0, memoryBytes: 0, count: 0 };
        group.cpuPercent += process.cpuPercent / update.summary.cores;
        group.memoryBytes += process.memoryBytes;
        group.count++;
        groups.set(key, group);
      }
      return [...groups.values()]
        .sort((a, b) => b.cpuPercent - a.cpuPercent || b.memoryBytes - a.memoryBytes)
        .slice(0, GROUPS_SHOWN);
    }),
    /** Zombies, and processes waiting for the disk: counts for "Needs attention". */
    attentionCounts: computed(() => {
      const processes = store.shown()?.processes ?? [];
      return {
        zombie: processes.filter((p) => p.state === 'zombie').length,
        waiting: processes.filter((p) => p.state === 'waiting').length,
      };
    }),
    loadLevel: computed<LoadLevel>(() => {
      const summary = store.shown()?.summary;
      const perCore = summary ? summary.load[0] / summary.cores : 0;
      return LOAD_LEVELS.find(({ from }) => perCore >= from)!.level;
    }),
    /** Processes sent TERM that still run. */
    stillRunning: computed(() => {
      const running = new Set((store.latest()?.processes ?? []).map(processKey));
      return store.asked().filter((key) => running.has(key));
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
  withMethods(
    (
      store,
      processesApi = inject(ProcessesApi),
      linuxSessionStore = inject(LinuxSessionStore),
      translator = inject(Translator),
    ) => {
      const ended = (request: EndRequest) => {
        const key = processKey(request.process);
        const name = request.process.name;
        if (request.signal === 'TERM') {
          patchState(store, { asked: [...store.asked().filter((k) => k !== key), key] });
          toast.success(translator.t('processes.ended', { name }));
        } else {
          toast.success(translator.t('processes.forced', { name }));
        }
      };
      const pending = (key: string, on: boolean) =>
        patchState(store, {
          pending: on ? [...store.pending(), key] : store.pending().filter((p) => p !== key),
        });
      const endAs = (process: Process): EndAs => {
        const uid = store.linux()?.uid;
        return uid === null || uid === undefined || uid === process.uid ? 'own' : 'administrator';
      };

      return {
        update(update: ProcessesUpdate): void {
          const running = new Set(update.processes.map(processKey));
          patchState(store, {
            latest: update,
            asked: store.asked().filter((key) => running.has(key)),
            now: Date.now(),
            ...(!store.paused() && { shown: update }),
          });
        },

        /** Signs in as a Linux user; rejects with the server's error (the form shows it). */
        signIn: (request: LinuxSignInRequest): Promise<void> => linuxSessionStore.signIn(request),

        /** Whether the account ends it as its own, or needs its sudo (another's process). */
        endAs,

        setSearch(search: string): void {
          patchState(store, { search });
        },
        /** A column again turns its direction around; another starts with its usual one. */
        setSort(sort: ProcessSort): void {
          patchState(store, {
            sort,
            descending: store.sort() === sort ? !store.descending() : DESCENDING_FIRST[sort],
          });
        },
        showEverything(): void {
          patchState(store, { showAll: true });
        },
        setShowSystem(showSystem: boolean): void {
          patchState(store, { showSystem });
        },
        /** Only this group's processes; the same again shows all. */
        toggleGroup(group: ProcessGroupId): void {
          const current = store.group();
          patchState(store, { group: current && sameGroup(current, group) ? null : group });
        },
        toggleAttention(): void {
          patchState(store, { attention: !store.attention() });
        },
        clearFilters(): void {
          patchState(store, { group: null, attention: false, search: '' });
        },
        togglePause(): void {
          const paused = !store.paused();
          patchState(store, { paused, ...(!paused && { shown: store.latest() }) });
        },

        /**
         * Ends a process as the account (already confirmed): asked to stop (TERM), or forced
         * (KILL). Another account's through its sudo: the password asked while locked.
         */
        async end(request: EndRequest): Promise<void> {
          const key = processKey(request.process);
          const { pid, startTicks } = request.process;
          const send = async () => {
            await firstValueFrom(processesApi.signal({ pid, startTicks, signal: request.signal }));
            return true;
          };
          pending(key, true);
          try {
            const done =
              endAs(request.process) === 'own'
                ? await send()
                : await linuxSessionStore.withSudo(send);
            if (done) ended(request);
          } catch (error) {
            if (apiErrorCode(error) === FILES_ERROR_CODES.linuxSessionRequired) {
              linuxSessionStore.ended();
            }
            toast.error(translator.t('processes.endFailed'), {
              description: translator.t(...apiErrorText(error)),
            });
          } finally {
            pending(key, false);
          }
        },
      };
    },
  ),
  withHooks(
    (
      store,
      realtimeService = inject(RealtimeService),
      linuxSessionStore = inject(LinuxSessionStore),
    ) => {
      let stop: (() => void) | null = null;
      return {
        onInit() {
          linuxSessionStore.check();
          stop = realtimeService.subscribe('processes', (message) => {
            if (message.event === 'processes:snapshot' || message.event === 'processes:update') {
              store.update(message.data);
            }
          });
        },
        onDestroy() {
          stop?.();
        },
      };
    },
  ),
);
