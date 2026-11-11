import { computed, DOCUMENT, effect, inject, untracked } from '@angular/core';
import {
  patchState,
  signalStore,
  withComputed,
  withHooks,
  withMethods,
  withState,
} from '@ngrx/signals';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import {
  FILES_ERROR_CODES,
  FILES_LIMITS,
  JOURNAL_ERROR_CODES,
  JOURNAL_LIMITS,
  type JournalAccess,
  type JournalBootInfo,
  type JournalLine,
} from '@ilex/shared';
import { catchError, EMPTY, exhaustMap, firstValueFrom, pipe, switchMap, tap } from 'rxjs';
import { LinuxSessionStore } from '../../../core/linux/linux-session-store';
import { SystemJournalApi } from '../../../core/system-journal/system-journal-api';
import type { JournalRequest } from '../../../core/system-journal/system-journal.model';
import { SystemServicesApi } from '../../../core/system-services/system-services-api';
import { apiErrorCode, TRANSLATED_ERROR_CODES } from '../../../shared/forms/submission-errors';
import type { LogViewEntry } from '../../../shared/log-view/log-view.model';
import type { BootChoice, JournalFilters } from '../system-journal.model';

interface JournalPageState {
  filters: JournalFilters;
  /** Read through the account's sudo (it chose "Read as administrator"). */
  administrator: boolean;
  /** Oldest first. */
  lines: JournalLine[];
  /** The first read for these filters has answered. */
  loaded: boolean;
  /** Why the journal couldn't be read (an API code), or null. */
  loadError: string | null;
  access: JournalAccess | null;
  /** There are older lines than the first one shown. */
  olderMore: boolean;
  loadingOlder: boolean;
  /** Every boot the journal holds, newest first; null: not read, or journalctl can't list them. */
  boots: JournalBootInfo[] | null;
  /** The services, for the unit menu. */
  units: string[];
  /**
   * As administrator, following stops this long after the person last did something here: the
   * page's reads would otherwise keep sudo unlocked for as long as it's open.
   */
  followStopped: boolean;
}

const initialFilters: JournalFilters = { unit: null, priority: 'info', boot: null };

const initialState: JournalPageState = {
  filters: initialFilters,
  administrator: false,
  lines: [],
  loaded: false,
  loadError: null,
  access: null,
  olderMore: false,
  loadingOlder: false,
  boots: null,
  units: [],
  followStopped: false,
};

/** A code with its own text, or "the journal couldn't be read". */
const errorOf = (error: unknown) => {
  const code = apiErrorCode(error);
  return code && TRANSLATED_ERROR_CODES.includes(code) ? code : JOURNAL_ERROR_CODES.unavailable;
};

const toEntry = (line: JournalLine): LogViewEntry => {
  const who = line.identifier ?? line.unit;
  return {
    id: line.cursor,
    at: line.at,
    text: line.text,
    priority: line.priority,
    source: who ? (line.pid ? `${who}[${line.pid}]` : who) : null,
  };
};

/**
 * The Logs page's data, provided by the page and gone with it: the
 * journal's lines for the filters, read as the signed-in Linux account — or as administrator
 * through its sudo —, what's newer asked for every 2 s while the page is shown (the cursor: nothing
 * missed or doubled), older lines 500 at a time.
 */
export const JournalPageStore = signalStore(
  withState<JournalPageState>(initialState),
  withComputed((store, linuxSessionStore = inject(LinuxSessionStore)) => ({
    /** No Linux session to read with: the page asks for the sign-in. */
    signInNeeded: computed(
      () =>
        store.loadError() === FILES_ERROR_CODES.linuxSessionRequired ||
        (linuxSessionStore.checked() && !linuxSessionStore.session()),
    ),
    entries: computed(() => store.lines().map(toEntry)),
    canLoadOlder: computed(
      () => store.olderMore() && store.lines().length < JOURNAL_LIMITS.maxLinesInView,
    ),
    /** Only its own lines: the notice offers reading as administrator. */
    ownOnly: computed(() => store.access() === 'own' && !store.administrator()),
    bootChoices: computed<BootChoice[]>(() => {
      const boots = store.boots();
      if (boots) {
        return boots.map((boot) => ({
          value: boot.offset === 0 ? null : boot.id,
          offset: boot.offset,
          first: boot.first,
          last: boot.last,
        }));
      }
      return [
        { value: null, offset: 0, first: null, last: null },
        { value: '-1', offset: -1, first: null, last: null },
      ];
    }),
    unitChoices: computed(() => {
      const unit = store.filters().unit;
      return unit && !store.units().includes(unit) ? [unit, ...store.units()] : store.units();
    }),
  })),
  withMethods(
    (
      store,
      systemJournalApi = inject(SystemJournalApi),
      systemServicesApi = inject(SystemServicesApi),
      linuxSessionStore = inject(LinuxSessionStore),
    ) => {
      /** Bumped by every new read: an answer for earlier filters is dropped. */
      let generation = 0;
      let lastAction = Date.now();
      const request = (extra: Partial<JournalRequest> = {}): JournalRequest => ({
        ...store.filters(),
        administrator: store.administrator(),
        ...extra,
      });
      /** sudo locked meanwhile ("Lock now", its idle end): the notice offers unlocking again. */
      const locked = (error: unknown) =>
        store.administrator() && apiErrorCode(error) === FILES_ERROR_CODES.sudoRequired;
      const failed = (error: unknown) => {
        const code = errorOf(error);
        if (code === FILES_ERROR_CODES.linuxSessionRequired) linuxSessionStore.ended();
        patchState(store, { loadError: code });
        return EMPTY;
      };
      const trim = (lines: JournalLine[]) =>
        lines.length > JOURNAL_LIMITS.maxLinesInView
          ? lines.slice(lines.length - JOURNAL_LIMITS.maxLinesInView)
          : lines;

      const read = rxMethod<void>(
        pipe(
          switchMap(() => {
            const run = ++generation;
            patchState(store, {
              lines: [],
              loaded: false,
              loadError: null,
              olderMore: false,
              loadingOlder: false,
            });
            return systemJournalApi.read(request()).pipe(
              tap(({ lines, more, access }) => {
                if (run === generation) {
                  patchState(store, { lines, olderMore: more, access, loaded: true });
                }
              }),
              catchError((error: unknown) => {
                if (run !== generation) return EMPTY;
                if (locked(error)) {
                  patchState(store, { followStopped: true });
                  return EMPTY;
                }
                return failed(error);
              }),
            );
          }),
        ),
      );

      // One at a time; when there's more than one answer holds, the next asks again at once.
      const newer = rxMethod<void>(
        pipe(
          exhaustMap(() => {
            const run = generation;
            const after = store.lines().at(-1)?.cursor;
            return systemJournalApi.read(request(after ? { after } : {})).pipe(
              tap(({ lines, more, access }) => {
                if (run !== generation) return;
                // Nothing new (most polls): nothing changes, nothing is drawn again. An answer
                // ending on the cursor itself ignored it (the newest lines again): never added,
                // never asked again at once.
                if (after && (lines.length === 0 || lines.at(-1)!.cursor === after)) {
                  if (store.loadError() !== null || store.access() !== access) {
                    patchState(store, { access, loadError: null });
                  }
                  return;
                }
                const all = after ? [...store.lines(), ...lines] : lines;
                patchState(store, {
                  lines: trim(all),
                  // Read from the newest (the view was empty): `more` means older ones.
                  olderMore: after
                    ? store.olderMore() || all.length > JOURNAL_LIMITS.maxLinesInView
                    : more,
                  access,
                  loadError: null,
                });
                if (after && more) queueMicrotask(() => newer());
              }),
              catchError((error: unknown) => {
                if (run !== generation) return EMPTY;
                if (locked(error)) {
                  patchState(store, { followStopped: true });
                  return EMPTY;
                }
                return failed(error);
              }),
            );
          }),
        ),
      );

      const older = rxMethod<void>(
        pipe(
          exhaustMap(() => {
            const run = generation;
            const before = store.lines()[0]?.cursor;
            if (!before) return EMPTY;
            patchState(store, { loadingOlder: true });
            return systemJournalApi.read(request({ before })).pipe(
              tap(({ lines, more }) => {
                if (run !== generation) return;
                patchState(store, {
                  lines: [...lines, ...store.lines()],
                  olderMore: more,
                  loadingOlder: false,
                });
              }),
              catchError((error: unknown) => {
                if (run !== generation) return EMPTY;
                patchState(store, { loadingOlder: false });
                if (locked(error)) {
                  patchState(store, { followStopped: true });
                  return EMPTY;
                }
                return failed(error);
              }),
            );
          }),
        ),
      );

      const loadBoots = rxMethod<void>(
        pipe(
          switchMap(() =>
            systemJournalApi.boots(store.administrator()).pipe(
              tap(({ boots }) => patchState(store, { boots })),
              catchError(() => EMPTY),
            ),
          ),
        ),
      );

      const loadUnits = rxMethod<void>(
        pipe(
          switchMap(() =>
            systemServicesApi.list().pipe(
              tap(({ services }) =>
                patchState(store, {
                  units: services.map((service) => service.name).sort((a, b) => a.localeCompare(b)),
                }),
              ),
              catchError(() => EMPTY),
            ),
          ),
        ),
      );

      const touched = () => {
        lastAction = Date.now();
        patchState(store, { followStopped: false });
      };

      return {
        /** Everything again: the lines for the filters, the boots and the units. */
        load(): void {
          touched();
          read();
          loadBoots();
          loadUnits();
        },

        /** Signs in to Linux (the shell's prompt), then reads. */
        async signIn(): Promise<void> {
          await linuxSessionStore.asPerson(async () => true);
        },

        /** What's newer, while shown, read and following. */
        poll(): void {
          if (!linuxSessionStore.session() || !store.loaded() || store.followStopped()) return;
          const idle = Date.now() - lastAction > FILES_LIMITS.sudoIdleMinutes * 60_000;
          if (store.administrator() && idle) {
            patchState(store, { followStopped: true });
            return;
          }
          newer();
        },

        loadOlder(): void {
          touched();
          older();
        },

        setFilters(filters: Partial<JournalFilters>): void {
          const next = { ...store.filters(), ...filters };
          const current = store.filters();
          if (
            next.unit === current.unit &&
            next.priority === current.priority &&
            next.boot === current.boot
          ) {
            return;
          }
          touched();
          patchState(store, { filters: next });
          if (linuxSessionStore.session()) read();
        },

        /** Through the account's sudo: its password asked for while locked. */
        async readAsAdministrator(): Promise<void> {
          const boots = await linuxSessionStore
            .asPerson(() => firstValueFrom(systemJournalApi.boots(true)))
            .catch((error: unknown) => {
              patchState(store, { loadError: errorOf(error) });
              return null;
            });
          if (!boots) return;
          touched();
          patchState(store, { administrator: true, boots: boots.boots });
          read();
        },

        /** Following again (as administrator, after it stopped): sudo unlocked again if needed. */
        async follow(): Promise<void> {
          if (store.administrator()) {
            const ok = await linuxSessionStore
              .withSudo(() => firstValueFrom(systemJournalApi.boots(true)))
              .catch(() => null);
            if (!ok) return;
          }
          touched();
          // The read that sudo stopped: again.
          if (!store.loaded()) read();
        },
      };
    },
  ),
  withHooks((store, linuxSessionStore = inject(LinuxSessionStore), document = inject(DOCUMENT)) => {
    let timer: ReturnType<typeof setInterval> | undefined;
    return {
      onInit() {
        linuxSessionStore.check();
        // Signed in (now, or later through any prompt): the journal follows. Not again for each
        // refresh of the same session.
        const signedIn = computed(() => linuxSessionStore.session() !== null);
        effect(() => {
          if (signedIn()) untracked(() => store.load());
        });
        timer = setInterval(() => {
          if (document.visibilityState === 'visible') store.poll();
        }, JOURNAL_LIMITS.pollMs);
      },
      onDestroy() {
        clearInterval(timer);
      },
    };
  }),
);
