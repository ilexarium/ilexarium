import { computed, inject } from '@angular/core';
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
  firstValueFrom,
  map,
  type Observable,
  pipe,
  switchMap,
  tap,
} from 'rxjs';
import { AppsApi } from '../../../core/apps/apps-api';
import { AppTasksStore } from '../../../core/apps/app-tasks-store';
import type { AppFollowed } from '../../../core/apps/apps.model';
import { AppsStore } from '../../../core/apps/apps-store';
import { buildAppBackupItem } from '../../../core/backups/app-backup-item';
import { BackupsStore } from '../../../core/backups/backups-store';
import { Translator } from '../../../core/i18n/translator';
import { LinuxSessionStore } from '../../../core/linux/linux-session-store';
import { apiErrorText } from '../../../shared/forms/submission-errors';
import { NAME_CHECK_MS, TEMPLATE_SEARCH_FROM } from '../apps.constants';
import type { BackupChoice } from '../apps.model';

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
  backup: BackupChoice;
  /** What Compose said when it refused the files. */
  problem: string | null;
  task: AppTask | null;
  installed: { name: string; folder: string } | null;
  /** The template search, as typed. */
  search: string;
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
  backup: { include: true, mode: 'stop', skip: [] },
  problem: null,
  task: null,
  installed: null,
  search: '',
};

/** A Compose file's own `name:` (a pasted file may have one). */
const composeName = (text: string): string | undefined =>
  /^name:\s*['"]?([a-z0-9][a-z0-9_-]*)/m.exec(text)?.[1];

/**
 * Adding an app: a template or a pasted Compose file, then the name (checked while typing), the
 * template's form (a pasted file: its two files as they are), the backup — then the install as the
 * person, its output live. Docker checks the file (`docker compose config`), nothing else.
 */
export const NewAppPageStore = signalStore(
  withState<NewAppState>(initialState),
  withComputed(
    (
      store,
      appsStore = inject(AppsStore),
      backupsStore = inject(BackupsStore),
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
      backupsConfigured: backupsStore.configured,
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
    (
      store,
      appsApi = inject(AppsApi),
      appTasksStore = inject(AppTasksStore),
      linuxSessionStore = inject(LinuxSessionStore),
      translator = inject(Translator),
    ) => {
      const failed = (key: string, error: unknown) =>
        toast.error(translator.t(key), { description: translator.t(...apiErrorText(error)) });

      /** The template's form; every field's value written to `.env` (defaults, new secrets). */
      const loadFields = rxMethod<string>(
        pipe(
          switchMap((template) =>
            appsApi.fields({ template }).pipe(
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
                failed('apps.new.fieldsFailed', error);
                return EMPTY;
              }),
            ),
          ),
        ),
      );

      const checkName = rxMethod<string>(
        pipe(
          debounceTime(NAME_CHECK_MS),
          switchMap((name) =>
            appsApi.checkName(name).pipe(
              tap((nameCheck) => patchState(store, { nameCheck })),
              catchError(() => EMPTY),
            ),
          ),
        ),
      );

      /**
       * Starts with the name the file or template suggests, made free. Only the latest suggestion
       * lands, and none once a name was typed or the setup left.
       */
      let suggestion = 0;
      const suggestName = (wanted: string) => {
        const asked = ++suggestion;
        const stale = () => asked !== suggestion || store.nameTyped() || store.step() !== 'setup';
        return firstValueFrom(appsApi.checkName(wanted)).then(
          (check) => {
            if (!stale())
              patchState(store, { name: check.suggestion, nameCheck: { ...check, free: true } });
          },
          () => {
            if (!stale()) patchState(store, { name: wanted });
          },
        );
      };

      /** Your own file's `name:`, once typing stops, each name suggested once. */
      let fromFile: string | null = null;
      const suggestFromFile = rxMethod<string>(
        pipe(
          debounceTime(NAME_CHECK_MS),
          map(composeName),
          tap((wanted) => {
            if (!wanted || wanted === fromFile || store.template() || store.nameTyped()) return;
            fromFile = wanted;
            void suggestName(wanted);
          }),
        ),
      );

      // Adding it to the backups is the global store's: it runs even if the page is left.
      // The stream inside an object: a plain value, not one rxMethod would subscribe to itself.
      const show = rxMethod<{ followed$: Observable<AppFollowed>; started: AppStarted }>(
        pipe(
          switchMap(({ followed$, started }) =>
            followed$.pipe(map((followed) => ({ ...followed, started }))),
          ),
          tap(({ task, after, started: { name, folder } }) => {
            patchState(store, { task });
            if (after === 'done') patchState(store, { installed: { name, folder } });
          }),
        ),
      );

      // The follow-up (adding it to the backups) is the global store's, started here and not inside
      // the page's stream: the page may have been left while the install was starting.
      const follow = (started: AppStarted) => {
        const { include, ...preset } = store.backup();
        const backup = include ? buildAppBackupItem(started.name, started.folder, preset) : null;
        const followed$ = appTasksStore.follow(started, { kind: 'install', backup });
        show({ followed$, started });
      };

      return {
        async chooseTemplate(id: string): Promise<void> {
          try {
            const { template, compose } = await firstValueFrom(appsApi.template(id));
            patchState(store, {
              ...initialState,
              search: store.search(),
              step: 'setup',
              template,
              compose,
              backup: {
                include: true,
                mode: template.backup?.mode ?? 'stop',
                skip: template.backup?.skip ?? [],
              },
            });
            loadFields(id);
            await suggestName(id);
          } catch (error) {
            failed('apps.new.templateFailed', error);
          }
        },

        /** Your own Compose file: pasted in its Files section (its `name:` then suggested). */
        async useOwnFile(): Promise<void> {
          patchState(store, { ...initialState, step: 'setup', search: store.search() });
          fromFile = null;
          await suggestName('app');
        },

        back(): void {
          patchState(store, { ...initialState, search: store.search() });
        },

        setSearch(search: string): void {
          patchState(store, { search });
        },

        setName(name: string): void {
          suggestion++;
          patchState(store, { name, nameTyped: true, nameCheck: null });
          checkName(name);
        },

        setFolder(folder: string): void {
          patchState(store, { folder: folder.trim() || null });
        },

        setValue(key: string, value: string): void {
          patchState(store, { env: setEnvValues(store.env(), { [key]: value }) });
        },

        setCompose(compose: string): void {
          patchState(store, { compose, problem: null });
          suggestFromFile(compose);
        },

        setEnv(env: string): void {
          patchState(store, { env, problem: null });
        },

        setBackup(change: Partial<BackupChoice>): void {
          patchState(store, { backup: { ...store.backup(), ...change } });
        },

        /** Installs as the person: their Linux sign-in, their sudo if Docker needs it. */
        async install(): Promise<void> {
          patchState(store, { problem: null });
          try {
            const started = await linuxSessionStore.asPerson(() =>
              firstValueFrom(
                appsApi.install({
                  name: store.name(),
                  folder: store.folder(),
                  template: store.template()?.id ?? null,
                  compose: store.compose(),
                  env: store.env(),
                }),
              ),
            );
            if (!started) return;
            patchState(store, { step: 'installing', task: started.task });
            follow(started);
          } catch (error) {
            const detail = (error as { error?: { detail?: unknown } }).error?.detail;
            if (typeof detail === 'string') patchState(store, { problem: detail });
            failed('apps.new.installFailed', error);
          }
        },
      };
    },
  ),
  withHooks((_store, linuxSessionStore = inject(LinuxSessionStore)) => ({
    onInit() {
      linuxSessionStore.check();
    },
  })),
);
