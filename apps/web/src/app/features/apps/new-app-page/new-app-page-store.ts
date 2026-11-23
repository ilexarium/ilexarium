import { computed, inject } from '@angular/core';
import {
  patchState,
  signalStore,
  withComputed,
  withHooks,
  withMethods,
  withProps,
  withState,
} from '@ngrx/signals';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import {
  APP_NAME_PATTERN,
  type AppField,
  type AppNameCheck,
  type AppStarted,
  type AppTask,
  parseEnv,
  setEnvValues,
  type Template,
} from '@ilex/shared';
import { toast } from '@spartan-ng/brain/sonner';
import {
  catchError,
  debounceTime,
  EMPTY,
  exhaustMap,
  filter,
  map,
  of,
  pipe,
  Subject,
  switchMap,
  takeUntil,
  tap,
} from 'rxjs';
import { AppsStore } from '../../../core/apps/apps-store';
import { AppActionsService } from '../../../core/apps/services/app-actions-service';
import { Translator } from '../../../core/i18n/translator';
import { LinuxSessionStore } from '../../../core/linux/linux-session-store';
import { apiErrorText } from '../../../shared/forms/submission-errors';
import { NAME_CHECK_MS, TEMPLATE_SEARCH_FROM } from '../apps.constants';

interface NewAppState {
  step: 'choose' | 'setup' | 'installing';
  template: Template | null;
  compose: string;
  env: string;
  /** A template's form (a pasted file has none). */
  fields: AppField[] | null;
  name: string;
  /** Typed by hand: no longer suggested from the file. */
  nameTyped: boolean;
  nameCheck: AppNameCheck | null;
  /** Null: `~/apps/<name>`. */
  folder: string | null;
  /** What Compose said when it refused the files. */
  problem: string | null;
  /** The install's task, as last read. */
  task: AppTask | null;
  /** Installed: its page is next. */
  installed: { name: string; folder: string } | null;
  /** The template search, as typed. */
  search: string;
  /** Your own file's `name:` last suggested (each suggested once). */
  _suggestedFromFile: string | null;
}

const initialState: NewAppState = {
  step: 'choose',
  template: null,
  compose: '',
  env: '',
  fields: null,
  name: '',
  nameTyped: false,
  nameCheck: null,
  folder: null,
  problem: null,
  task: null,
  installed: null,
  search: '',
  _suggestedFromFile: null,
};

/** A Compose file's own `name:` (a pasted file may have one). */
const composeName = (text: string): string | undefined =>
  /^name:\s*['"]?([a-z0-9][a-z0-9_-]*)/m.exec(text)?.[1];

/**
 * Adding an app: a template or a pasted Compose file, then the name (checked while typing) and
 * the template's form (a pasted file: its two files as they are) — then the install as the person,
 * its output live while the page is open. Docker checks the file (`docker compose config`),
 * nothing else. Adding it to the backups is a step of its own, on the app's page.
 */
export const NewAppPageStore = signalStore(
  withState<NewAppState>(initialState),
  /** The setup started again or left: a template still loading is no longer wanted. */
  withProps(() => ({ _setupChanged: new Subject<void>() })),
  withComputed(
    (
      store,
      appsStore = inject(AppsStore),
      linuxSessionStore = inject(LinuxSessionStore),
      translator = inject(Translator),
    ) => ({
      templates: appsStore.templates,
      searchable: computed(() => (appsStore.templates()?.length ?? 0) >= TEMPLATE_SEARCH_FROM),
      /** Those whose name or description has every word typed. */
      shownTemplates: computed(() => {
        const templates = appsStore.templates();
        const words = store.search().toLocaleLowerCase().split(/\s+/).filter(Boolean);
        if (!templates || words.length === 0) return templates;
        return templates.filter((template) => {
          const text =
            `${template.name} ${translator.t(`catalog.${template.id}.description`)}`.toLocaleLowerCase();
          return words.every((word) => text.includes(word));
        });
      }),
      values: computed(() => parseEnv(store.env())),
      nameValid: computed(() => APP_NAME_PATTERN.test(store.name())),
      /** Whose the app will be: the Linux account signed in, if one is. */
      account: computed(() => linuxSessionStore.session()?.username ?? null),
      canInstall: computed(
        () =>
          APP_NAME_PATTERN.test(store.name()) &&
          store.nameCheck()?.free !== false &&
          store.compose().trim() !== '',
      ),
    }),
  ),
  withMethods(
    (store, appActionsService = inject(AppActionsService), translator = inject(Translator)) => ({
      _failed(key: string, error: unknown): void {
        toast.error(translator.t(key), { description: translator.t(...apiErrorText(error)) });
      },

      /** The install's output while the page is open; succeeded: on to the app's page. */
      _followInstall: rxMethod<AppStarted>(
        pipe(
          switchMap(({ name, folder }) =>
            appActionsService.followTask(name, folder).pipe(
              tap({
                next: (task) => {
                  patchState(store, { task });
                  if (task.state !== 'succeeded') return;
                  toast.success(translator.t('apps.new.installed', { name }));
                  patchState(store, { installed: { name, folder } });
                },
                // Given up while it ran: its page reads the task with the files.
                complete: () => {
                  if (store.task()?.state === 'running')
                    patchState(store, { installed: { name, folder } });
                },
              }),
            ),
          ),
        ),
      ),

      _checkName: rxMethod<string>(
        pipe(
          debounceTime(NAME_CHECK_MS),
          switchMap((name) =>
            appActionsService.checkName(name).pipe(
              tap((nameCheck) => {
                // Not for a name since changed, or a setup since left.
                if (store.name() === name && store.step() === 'setup')
                  patchState(store, { nameCheck });
              }),
              catchError(() => EMPTY),
            ),
          ),
        ),
      ),

      /**
       * The name the file or template suggests, made free. Only the latest suggestion lands, and
       * none once a name was typed or the setup left.
       */
      _suggestName: rxMethod<string>(
        pipe(
          switchMap((wanted) =>
            appActionsService.checkName(wanted).pipe(
              map((check) => ({ name: check.suggestion, nameCheck: { ...check, free: true } })),
              catchError(() => of({ name: wanted })),
              tap((suggested) => {
                if (!store.nameTyped() && store.step() === 'setup') patchState(store, suggested);
              }),
            ),
          ),
        ),
      ),
    }),
  ),
  withMethods((store, appActionsService = inject(AppActionsService)) => ({
    /** The template's form; every field's value written to `.env` (defaults, new secrets). */
    _loadFields: rxMethod<string>(
      pipe(
        switchMap((template) =>
          appActionsService.fields(template).pipe(
            tap(({ fields }) => {
              // Answered after Back or another choice: not this setup's.
              if (store.template()?.id !== template) return;
              const values: Record<string, string> = {};
              const known = parseEnv(store.env());
              for (const field of fields) {
                if (!known.has(field.key)) values[field.key] = field.value;
              }
              patchState(store, { fields, env: setEnvValues(store.env(), values) });
            }),
            catchError((error: unknown) => {
              store._failed('apps.new.fieldsFailed', error);
              return EMPTY;
            }),
          ),
        ),
      ),
    ),

    /** Your own file's `name:`, once typing stops, each name suggested once. */
    _suggestFromFile: rxMethod<string>(
      pipe(
        debounceTime(NAME_CHECK_MS),
        // Only the file as it is now (not one typed in a setup since left).
        filter((compose) => compose === store.compose()),
        map(composeName),
        tap((wanted) => {
          if (
            !wanted ||
            wanted === store._suggestedFromFile() ||
            store.template() ||
            store.nameTyped()
          )
            return;
          patchState(store, { _suggestedFromFile: wanted });
          store._suggestName(wanted);
        }),
      ),
    ),
  })),
  withMethods((store, appActionsService = inject(AppActionsService)) => ({
    /** The latest template clicked wins. */
    chooseTemplate: rxMethod<string>(
      pipe(
        switchMap((id) =>
          appActionsService.template(id).pipe(
            takeUntil(store._setupChanged),
            tap(({ template, compose }) => {
              patchState(store, {
                ...initialState,
                search: store.search(),
                step: 'setup',
                template,
                compose,
              });
              store._loadFields(id);
              store._suggestName(id);
            }),
            catchError((error: unknown) => {
              store._failed('apps.new.templateFailed', error);
              return EMPTY;
            }),
          ),
        ),
      ),
    ),

    /** Your own Compose file: pasted in its Files section (its `name:` then suggested). */
    useOwnFile(): void {
      store._setupChanged.next();
      patchState(store, { ...initialState, step: 'setup', search: store.search() });
      store._suggestName('app');
    },

    back(): void {
      store._setupChanged.next();
      patchState(store, { ...initialState, search: store.search() });
    },

    setSearch(search: string): void {
      patchState(store, { search });
    },

    setName(name: string): void {
      patchState(store, { name, nameTyped: true, nameCheck: null });
      store._checkName(name);
    },

    setFolder(folder: string): void {
      patchState(store, { folder: folder.trim() || null });
    },

    setValue(key: string, value: string): void {
      patchState(store, { env: setEnvValues(store.env(), { [key]: value }) });
    },

    setCompose(compose: string): void {
      patchState(store, { compose, problem: null });
      store._suggestFromFile(compose);
    },

    setEnv(env: string): void {
      patchState(store, { env, problem: null });
    },

    /** Installs as the person; a refused install shows what Compose said. */
    install: rxMethod<void>(
      pipe(
        exhaustMap(() => {
          patchState(store, { problem: null });
          return appActionsService
            .install({
              name: store.name(),
              folder: store.folder(),
              template: store.template()?.id ?? null,
              compose: store.compose(),
              env: store.env(),
            })
            .pipe(
              tap((started) => {
                if (!started) return;
                patchState(store, { step: 'installing', task: started.task });
                store._followInstall(started);
              }),
              catchError((error: unknown) => {
                const detail = (error as { error?: { detail?: unknown } }).error?.detail;
                if (typeof detail === 'string') patchState(store, { problem: detail });
                store._failed('apps.new.installFailed', error);
                return EMPTY;
              }),
            );
        }),
      ),
    ),
  })),
  withHooks((_store, linuxSessionStore = inject(LinuxSessionStore)) => ({
    onInit() {
      linuxSessionStore.check();
    },
  })),
);
