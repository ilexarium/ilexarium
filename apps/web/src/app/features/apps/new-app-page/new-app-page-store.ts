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
import { catchError, debounceTime, EMPTY, firstValueFrom, map, pipe, switchMap, tap } from 'rxjs';
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
    (store, appActionsService = inject(AppActionsService), translator = inject(Translator)) => {
      const failed = (key: string, error: unknown) =>
        toast.error(translator.t(key), { description: translator.t(...apiErrorText(error)) });

      /** The install's output while the page is open; succeeded: on to the app's page. */
      const followInstall = rxMethod<AppStarted>(
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
      );

      /** The template's form; every field's value written to `.env` (defaults, new secrets). */
      const loadFields = rxMethod<string>(
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
            appActionsService.checkName(name).pipe(
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
        return firstValueFrom(appActionsService.checkName(wanted)).then(
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

      return {
        async chooseTemplate(id: string): Promise<void> {
          try {
            const { template, compose } = await firstValueFrom(appActionsService.template(id));
            patchState(store, {
              ...initialState,
              search: store.search(),
              step: 'setup',
              template,
              compose,
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

        /** Installs as the person; a refused install shows what Compose said. */
        async install(): Promise<void> {
          patchState(store, { problem: null });
          const request = {
            name: store.name(),
            folder: store.folder(),
            template: store.template()?.id ?? null,
            compose: store.compose(),
            env: store.env(),
          };
          try {
            const started = await appActionsService.install(request);
            if (!started) return;
            patchState(store, { step: 'installing', task: started.task });
            followInstall(started);
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
