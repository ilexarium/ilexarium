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
  type AppField,
  type AppNameCheck,
  type AppTask,
  type BackupMode,
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
import { NAME_CHECK_MS } from '../apps.constants';
import { followTask } from '../task-follower';

interface NewAppState {
  step: 'choose' | 'setup' | 'installing';
  template: Template | null;
  compose: string;
  env: string;
  /** A template's form (a pasted file has none). */
  fields: AppField[] | null;
  name: string;
  nameCheck: AppNameCheck | null;
  /** Null: `~/apps/<name>`. */
  folder: string | null;
  backup: { include: boolean; mode: BackupMode; skip: string[] };
  /** What Compose said when it refused the files. */
  problem: string | null;
  task: AppTask | null;
  installed: { name: string; folder: string } | null;
}

const initialState: NewAppState = {
  step: 'choose',
  template: null,
  compose: '',
  env: '',
  fields: null,
  name: '',
  nameCheck: null,
  folder: null,
  backup: { include: true, mode: 'stop', skip: [] },
  problem: null,
  task: null,
  installed: null,
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
  withComputed((store, appsStore = inject(AppsStore), backupsStore = inject(BackupsStore)) => ({
    templates: appsStore.templates,
    values: computed(() => parseEnv(store.env())),
    backupsConfigured: backupsStore.configured,
    nameValid: computed(() => /^[a-z0-9][a-z0-9_-]{0,62}$/.test(store.name())),
  })),
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

        async usePasted(compose: string): Promise<void> {
          patchState(store, { ...initialState, step: 'setup', compose });
          await suggestName(composeName(compose) ?? 'app');
        },

        back(): void {
          patchState(store, initialState);
        },

        setName(name: string): void {
          patchState(store, { name, nameCheck: null });
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
        },

        setEnv(env: string): void {
          patchState(store, { env, problem: null });
        },

        setBackup(change: Partial<NewAppState['backup']>): void {
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
