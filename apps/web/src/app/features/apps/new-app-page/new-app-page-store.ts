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
  type AppTask,
  parseEnv,
  setEnvValues,
  type Template,
} from '@laris/shared';
import { toast } from '@spartan-ng/brain/sonner';
import { catchError, debounceTime, EMPTY, firstValueFrom, map, pipe, switchMap, tap } from 'rxjs';
import { AppsApi } from '../../../core/apps/apps-api';
import { AppsStore } from '../../../core/apps/apps-store';
import { BackupsApi } from '../../../core/backups/backups-api';
import { BackupsStore } from '../../../core/backups/backups-store';
import { Translator } from '../../../core/i18n/translator';
import { LinuxSessionStore } from '../../../core/linux/linux-session-store';
import { apiErrorText } from '../../../shared/forms/submission-errors';
import { NAME_CHECK_MS, TEMPLATE_SEARCH_FROM } from '../apps.constants';
import type { BackupChoice } from '../apps.model';
import { followTask } from '../task-follower';

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
const composeName = (text: string) => /^name:\s*['"]?([a-z0-9][a-z0-9_-]*)/m.exec(text)?.[1];

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
      backupsApi = inject(BackupsApi),
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

      /** Starts with the name the file or template suggests, made free. */
      const suggestName = (wanted: string) =>
        firstValueFrom(appsApi.checkName(wanted)).then(
          (check) =>
            patchState(store, { name: check.suggestion, nameCheck: { ...check, free: true } }),
          () => patchState(store, { name: wanted }),
        );

      const follow = rxMethod<{ name: string; folder: string }>(
        pipe(
          switchMap(({ name, folder }) =>
            followTask(appsApi, name, folder).pipe(map((task) => ({ task, name, folder }))),
          ),
          tap(({ task, name, folder }) => {
            patchState(store, { task });
            if (task.state === 'succeeded') void finished(name, folder);
          }),
        ),
      );

      /** Installed: into the backups if asked (as the person, through their sudo). */
      const finished = async (name: string, folder: string) => {
        const { include, mode, skip } = store.backup();
        if (include && store.backupsConfigured()) {
          try {
            await linuxSessionStore.asPerson(() =>
              firstValueFrom(
                backupsApi.addItem({
                  kind: 'app',
                  project: name,
                  folders: [],
                  skip: skip.map((s) => `${folder}/${s}`),
                  mode,
                }),
              ),
            );
          } catch (error) {
            failed('apps.new.backupFailed', error);
          }
        }
        toast.success(translator.t('apps.new.installed', { name }));
        patchState(store, { installed: { name, folder } });
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
          await suggestName('app');
        },

        back(): void {
          patchState(store, { ...initialState, search: store.search() });
        },

        setSearch(search: string): void {
          patchState(store, { search });
        },

        setName(name: string): void {
          patchState(store, { name, nameTyped: true, nameCheck: null });
          checkName(name);
        },

        setFolder(folder: string): void {
          patchState(store, { folder: folder.trim() || null });
        },

        setValue(key: string, value: string): void {
          patchState(store, { env: setEnvValues(store.env(), { [key]: value }) });
        },

        async setCompose(compose: string): Promise<void> {
          patchState(store, { compose, problem: null });
          const own = !store.template() && !store.nameTyped() && composeName(compose);
          if (own && own !== store.name()) await suggestName(own);
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
            follow({ name: started.name, folder: started.folder });
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
