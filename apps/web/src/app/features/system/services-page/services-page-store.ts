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
  SYSTEM_SERVICE_ERROR_CODES,
  type SystemService,
  type SystemServiceDetails,
  type SystemServicesResponse,
} from '@ilex/shared';
import { toast } from '@spartan-ng/brain/sonner';
import {
  catchError,
  EMPTY,
  exhaustMap,
  finalize,
  map,
  mergeMap,
  of,
  pipe,
  switchMap,
  tap,
} from 'rxjs';
import { Translator } from '../../../core/i18n/translator';
import { LinuxSessionStore } from '../../../core/linux/linux-session-store';
import { SystemServicesApi } from '../../../core/system-services/system-services-api';
import {
  apiErrorCode,
  apiErrorText,
  TRANSLATED_ERROR_CODES,
} from '../../../shared/forms/submission-errors';
import type { DotTone } from '../../../shared/status-dot/status-dot.model';
import type { ServiceActionRequest, ServiceGroup, ServiceRow } from '../system-services.model';
import { GROUP_ORDER, REFRESH_MS } from './services-page.constants';

interface ServicesPageState {
  list: SystemServicesResponse | null;
  /** Why the list couldn't be read (an API code), or null. */
  loadError: string | null;
  search: string;
  showInactive: boolean;
  /** Only this group (the summary's counts), or null. */
  group: ServiceGroup | null;
  /** The service whose details are open, or null. */
  selected: string | null;
  details: SystemServiceDetails | null;
  detailsError: string | null;
  /** Services with an action running. */
  pending: string[];
}

const initialState: ServicesPageState = {
  list: null,
  loadError: null,
  search: '',
  showInactive: false,
  group: null,
  selected: null,
  details: null,
  detailsError: null,
  pending: [],
};

/** A code with its own text, or "systemd couldn't be asked". */
const errorOf = (error: unknown) => {
  const code = apiErrorCode(error);
  return code && TRANSLATED_ERROR_CODES.includes(code)
    ? code
    : SYSTEM_SERVICE_ERROR_CODES.unavailable;
};

function groupOf(service: SystemService): ServiceGroup {
  if (service.active === 'failed') return 'failed';
  return service.active === 'inactive' ? 'inactive' : 'active';
}

function dotOf(service: SystemService): DotTone {
  switch (service.active) {
    case 'failed':
      return 'fail';
    case 'inactive':
      return 'idle';
    case 'active':
      return service.sub === 'running' ? 'live' : 'ok';
    case 'activating':
    case 'deactivating':
    case 'reloading':
    case 'refreshing':
      return 'busy';
    default:
      return 'warn';
  }
}

/**
 * The Services page's data, provided by the page and gone with it:
 * the host's service units, read as the signed-in Linux account and asked again every 10 s while
 * the page is shown; a unit's details; starting, stopping and restarting through the account's
 * sudo (`LinuxSessionStore.asPerson` asks for what's missing), with their toasts.
 */
export const ServicesPageStore = signalStore(
  withState<ServicesPageState>(initialState),
  withComputed((store, linuxSessionStore = inject(LinuxSessionStore)) => {
    const all = computed<ServiceRow[]>(() =>
      (store.list()?.services ?? [])
        .map((service) => ({
          service,
          group: groupOf(service),
          dot: dotOf(service),
          state: service.sub ? `${service.active} (${service.sub})` : service.active,
          pending: store.pending().includes(service.name),
        }))
        .sort(
          (a, b) =>
            GROUP_ORDER[a.group] - GROUP_ORDER[b.group] ||
            a.service.name.localeCompare(b.service.name),
        ),
    );
    return {
      loaded: computed(() => store.list() !== null),
      /** No Linux session to read them with: the page asks for the sign-in. */
      signInNeeded: computed(
        () =>
          store.loadError() === FILES_ERROR_CODES.linuxSessionRequired ||
          (linuxSessionStore.checked() && !linuxSessionStore.session()),
      ),
      truncated: computed(() => store.list()?.truncated ?? false),
      counts: computed(() => {
        const counts: Record<ServiceGroup, number> = { failed: 0, active: 0, inactive: 0 };
        for (const row of all()) counts[row.group]++;
        return counts;
      }),
      /** Searched and filtered; inactive ones only when asked for. */
      rows: computed(() => {
        const query = store.search().trim().toLowerCase();
        const group = store.group();
        return all()
          .filter((row) =>
            group ? row.group === group : store.showInactive() || row.group !== 'inactive',
          )
          .filter(
            (row) =>
              !query ||
              row.service.name.toLowerCase().includes(query) ||
              row.service.description.toLowerCase().includes(query),
          );
      }),
      /** The open service as the list knows it, until its details arrive. */
      selectedRow: computed(
        () => all().find((row) => row.service.name === store.selected()) ?? null,
      ),
    };
  }),
  withMethods(
    (
      store,
      systemServicesApi = inject(SystemServicesApi),
      linuxSessionStore = inject(LinuxSessionStore),
      translator = inject(Translator),
    ) => {
      // The latest wins: a reload after an action must not be dropped for a refresh still on its way.
      const load = rxMethod<void>(
        pipe(
          switchMap(() =>
            systemServicesApi.list().pipe(
              tap((list) => patchState(store, { list, loadError: null })),
              catchError((error: unknown) => {
                const code = errorOf(error);
                if (code === FILES_ERROR_CODES.linuxSessionRequired) linuxSessionStore.ended();
                patchState(store, { loadError: code });
                return EMPTY;
              }),
            ),
          ),
        ),
      );
      const loadDetails = rxMethod<string>(
        pipe(
          switchMap((name) =>
            systemServicesApi.details(name).pipe(
              tap((details) => {
                if (store.selected() === name) patchState(store, { details, detailsError: null });
              }),
              catchError((error: unknown) => {
                if (store.selected() === name) {
                  patchState(store, { detailsError: errorOf(error) });
                }
                return EMPTY;
              }),
            ),
          ),
        ),
      );
      const pending = (name: string, on: boolean) =>
        patchState(store, {
          pending: on ? [...store.pending(), name] : store.pending().filter((p) => p !== name),
        });

      return {
        load,

        /** Signs in to Linux (the shell's prompt), then reads the list. */
        signInAndLoad: rxMethod<void>(
          pipe(
            exhaustMap(() =>
              linuxSessionStore
                .asPerson$(() => of(true))
                .pipe(
                  tap((signedIn) => {
                    if (signedIn) load();
                  }),
                  catchError(() => EMPTY),
                ),
            ),
          ),
        ),

        /** Again, while the page is shown and signed in; quietly (nothing changes until it answers). */
        refresh(): void {
          if (linuxSessionStore.session()) {
            load();
            const selected = store.selected();
            if (selected) loadDetails(selected);
          }
        },

        setSearch(search: string): void {
          patchState(store, { search });
        },
        setShowInactive(showInactive: boolean): void {
          patchState(store, { showInactive });
        },
        /** Only this group; the same again shows all. */
        toggleGroup(group: ServiceGroup): void {
          patchState(store, { group: store.group() === group ? null : group });
        },

        open(name: string): void {
          patchState(store, { selected: name, details: null, detailsError: null });
          loadDetails(name);
        },
        close(): void {
          patchState(store, { selected: null, details: null, detailsError: null });
        },

        /** Starts, stops or restarts (already confirmed), through the account's sudo. */
        act: rxMethod<ServiceActionRequest>(
          pipe(
            // Services side by side; a repeat for one while it runs is ignored.
            mergeMap(({ name, action }) => {
              if (store.pending().includes(name)) return EMPTY;
              return linuxSessionStore
                .asPerson$(() => systemServicesApi.act(name, action).pipe(map(() => true)))
                .pipe(
                  tap({
                    subscribe: () => pending(name, true),
                    next: (done) => {
                      if (done)
                        toast.success(translator.t(`systemServices.done.${action}`, { name }));
                    },
                  }),
                  catchError((error: unknown) => {
                    toast.error(translator.t(`systemServices.failed.${action}`, { name }), {
                      description: translator.t(...apiErrorText(error)),
                    });
                    return EMPTY;
                  }),
                  finalize(() => {
                    pending(name, false);
                    load();
                    if (store.selected() === name) loadDetails(name);
                  }),
                );
            }),
          ),
        ),
      };
    },
  ),
  withHooks((store, linuxSessionStore = inject(LinuxSessionStore), document = inject(DOCUMENT)) => {
    let timer: ReturnType<typeof setInterval> | undefined;
    return {
      onInit() {
        linuxSessionStore.check();
        // Signed in (now, or later through any prompt): the list follows.
        effect(() => {
          if (linuxSessionStore.session()) untracked(() => store.load());
        });
        timer = setInterval(() => {
          if (document.visibilityState === 'visible') store.refresh();
        }, REFRESH_MS);
      },
      onDestroy() {
        clearInterval(timer);
      },
    };
  }),
);
