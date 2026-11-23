import { effect, inject, untracked } from '@angular/core';
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
  type FileEntry,
  type FileList,
  type LinuxSignInRequest,
} from '@ilex/shared';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import { toast } from '@spartan-ng/brain/sonner';
import {
  catchError,
  concat,
  concatMap,
  defer,
  EMPTY,
  firstValueFrom,
  from,
  ignoreElements,
  lastValueFrom,
  mergeMap,
  type Observable,
  pipe,
  switchMap,
  tap,
} from 'rxjs';
import { FilesApi } from '../../../core/files/files-api';
import { Translator } from '../../../core/i18n/translator';
import { LinuxSessionStore } from '../../../core/linux/linux-session-store';
import { apiErrorCode, apiErrorText } from '../../../shared/forms/submission-errors';
import { joinPath, renameTarget } from '../files-paths';
import type { FileDeletion, Upload, UploadRequest } from '../files.model';

interface FilesPageState {
  list: FileList | null;
  loading: boolean;
  uploads: Upload[];
  /** Paths being renamed or deleted, for pending buttons. */
  pending: string[];
  /** The delete waiting for its confirmation. */
  deleting: FileDeletion | null;
  /** Uploads whose name is taken there: one question for all of them. */
  clashes: File[];
}

const initialState: FilesPageState = {
  list: null,
  loading: false,
  uploads: [],
  pending: [],
  deleting: null,
  clashes: [],
};

let nextUpload = 0;

/**
 * The Files page's data, provided by the page and gone with it:
 * the folder shown, uploads with their progress, and every action with its toast — in the Linux
 * session (`LinuxSessionStore`, shared with the other pages and the top bar). A Linux session
 * that ended (idle, the app's sign-out, closed elsewhere) shows the sign-in again.
 */
export const FilesPageStore = signalStore(
  withState<FilesPageState>(initialState),
  withComputed((_, linuxSessionStore = inject(LinuxSessionStore)) => ({
    checked: linuxSessionStore.checked,
    session: linuxSessionStore.session,
  })),
  withMethods(
    (
      store,
      filesApi = inject(FilesApi),
      linuxSessionStore = inject(LinuxSessionStore),
      translator = inject(Translator),
    ) => ({
      /** A failure in a toast — or, when the Linux session ended, back to the sign-in. */
      _failed(error: unknown): void {
        if (apiErrorCode(error) === FILES_ERROR_CODES.linuxSessionRequired) {
          linuxSessionStore.ended();
          patchState(store, { list: null, loading: false });
        }
        toast.error(translator.t('files.actionFailed'), {
          description: translator.t(...apiErrorText(error)),
        });
      },

      _folder(): string {
        return store.list()?.path ?? store.session()?.home ?? '/';
      },
    }),
  ),
  withMethods((store, filesApi = inject(FilesApi)) => ({
    /** A click on another folder while one loads: the latest wins. */
    open: rxMethod<string>(
      pipe(
        tap(() => patchState(store, { loading: true })),
        switchMap((path) =>
          filesApi.list(path).pipe(
            tap((list) => patchState(store, { list, loading: false })),
            catchError((error: unknown) => {
              patchState(store, { loading: false });
              store._failed(error);
              return EMPTY;
            }),
          ),
        ),
      ),
    ),

    /**
     * The folder shown, again after a change. Not through `open`: it mustn't cancel a folder
     * clicked meanwhile, and that folder wins over it.
     */
    _reload(): Observable<unknown> {
      return defer(() => {
        const path = store._folder();
        return filesApi.list(path).pipe(
          tap((list) => {
            if (!store.loading() && store._folder() === path) patchState(store, { list });
          }),
        );
      }).pipe(
        catchError((error: unknown) => {
          store._failed(error);
          return EMPTY;
        }),
      );
    },
  })),
  withMethods(
    (
      store,
      filesApi = inject(FilesApi),
      linuxSessionStore = inject(LinuxSessionStore),
      translator = inject(Translator),
    ) => ({
      /** Signs in as a Linux user; rejects with the server's error (the form shows it). */
      signIn: (request: LinuxSignInRequest): Promise<void> => linuxSessionStore.signIn(request),

      signOut: (): Promise<void> => linuxSessionStore.signOut(),

      /** The Linux session changed: its home opened, or (gone) nothing of it left. */
      sessionChanged(home: string | null): void {
        if (home) store.open(home);
        else
          patchState(store, {
            list: null,
            loading: false,
            uploads: [],
            deleting: null,
            clashes: [],
          });
      },

      refresh(): void {
        store.open(store._folder());
      },

      downloadUrl(entry: FileEntry): string {
        return filesApi.downloadUrl(joinPath(store._folder(), entry.name));
      },

      /** The name dialog's submission: true once made (the dialog closes). */
      async newFolder(name: string): Promise<boolean> {
        try {
          await firstValueFrom(filesApi.newFolder(store._folder(), name));
          toast.success(translator.t('files.created', { name }));
          await lastValueFrom(store._reload(), { defaultValue: undefined });
          return true;
        } catch (error) {
          store._failed(error);
          return false;
        }
      },

      /** The name dialog's submission: true once renamed or moved (the dialog closes). */
      async rename(entry: FileEntry, input: string): Promise<boolean> {
        const from = joinPath(store._folder(), entry.name);
        patchState(store, { pending: [...store.pending(), from] });
        try {
          await firstValueFrom(filesApi.rename(from, renameTarget(store._folder(), input)));
          toast.success(translator.t('files.renamed'));
          await lastValueFrom(store._reload(), { defaultValue: undefined });
          return true;
        } catch (error) {
          store._failed(error);
          return false;
        } finally {
          patchState(store, { pending: store.pending().filter((p) => p !== from) });
        }
      },

      /**
       * Asks before deleting: the confirmation shows, with how much is in it once counted (a
       * failed count says why in a toast and closes it). Another entry asked for meanwhile wins.
       */
      askDelete: rxMethod<FileEntry>(
        pipe(
          tap((entry) => patchState(store, { deleting: { entry, summary: null } })),
          switchMap((entry) =>
            filesApi.summary(joinPath(store._folder(), entry.name)).pipe(
              tap((summary) => {
                if (store.deleting()?.entry === entry)
                  patchState(store, { deleting: { entry, summary } });
              }),
              catchError((error: unknown) => {
                store._failed(error);
                if (store.deleting()?.entry === entry) patchState(store, { deleting: null });
                return EMPTY;
              }),
            ),
          ),
        ),
      ),

      cancelDelete(): void {
        patchState(store, { deleting: null });
      },

      /** Deletes it (confirmed); deletes of several entries run side by side. */
      delete: rxMethod<FileEntry>(
        pipe(
          mergeMap((entry) => {
            patchState(store, { deleting: null });
            const path = joinPath(store._folder(), entry.name);
            if (store.pending().includes(path)) return EMPTY;
            return concat(
              filesApi.delete(path).pipe(
                tap({
                  subscribe: () => patchState(store, { pending: [...store.pending(), path] }),
                  complete: () =>
                    toast.success(translator.t('files.deleted', { name: entry.name })),
                  finalize: () =>
                    patchState(store, { pending: store.pending().filter((p) => p !== path) }),
                }),
                catchError((error: unknown) => {
                  store._failed(error);
                  return EMPTY;
                }),
              ),
              // Not after the Linux session ended (the sign-in is shown).
              defer(() => (store.session() ? store._reload() : EMPTY)),
            );
          }),
        ),
      ),

      /**
       * Uploads files into the folder shown, one after another (and each request after the one
       * before). Names taken there already (`replace` false) become `clashes`: the page asks
       * before replacing them.
       */
      upload: rxMethod<UploadRequest>(
        pipe(
          concatMap(({ files, replace }) => {
            const target = store._folder();
            const taken: File[] = [];
            const uploads = from(files).pipe(
              concatMap((file) => {
                const id = nextUpload++;
                const set = (change: Partial<Upload>) =>
                  patchState(store, {
                    uploads: store.uploads().map((u) => (u.id === id ? { ...u, ...change } : u)),
                  });
                patchState(store, {
                  uploads: [
                    ...store.uploads(),
                    { id, name: file.name, progress: 0, state: 'uploading' },
                  ],
                });
                return filesApi.upload(target, file, replace).pipe(
                  tap({
                    next: (progress) => set({ progress }),
                    complete: () => set({ progress: 1, state: 'done' }),
                  }),
                  catchError((error: unknown) => {
                    if (apiErrorCode(error) === FILES_ERROR_CODES.exists && !replace) {
                      patchState(store, { uploads: store.uploads().filter((u) => u.id !== id) });
                      taken.push(file);
                    } else {
                      set({ state: 'failed' });
                      store._failed(error);
                    }
                    return EMPTY;
                  }),
                );
              }),
              ignoreElements(),
            );
            return concat(
              uploads,
              defer(() => (files.length > taken.length ? store._reload() : EMPTY)),
              defer(() => {
                if (taken.length) patchState(store, { clashes: taken });
                return EMPTY;
              }),
            );
          }),
        ),
      ),
    }),
  ),
  withMethods((store) => ({
    /** The clash question answered: replaced (uploaded again) or kept. */
    answerClashes(replace: boolean): void {
      const files = store.clashes();
      patchState(store, { clashes: [] });
      if (replace && files.length) store.upload({ files, replace: true });
    },
  })),
  withHooks((store, linuxSessionStore = inject(LinuxSessionStore)) => ({
    onInit() {
      linuxSessionStore.check();
      // Signed in here or elsewhere (the top bar, another page): the same account opens once.
      let shown: string | null = null;
      effect(() => {
        const session = store.session();
        const key = session ? `${session.username}:${session.home}` : null;
        if (key === shown) return;
        shown = key;
        untracked(() => store.sessionChanged(session?.home ?? null));
      });
    },
  })),
);
