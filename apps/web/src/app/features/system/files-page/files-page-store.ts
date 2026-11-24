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
  defer,
  EMPTY,
  filter,
  firstValueFrom,
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
import { joinPath, renameTarget } from '../../../core/files/files-paths';
import { UploadsStore } from '../../../core/files/uploads-store';
import type { FileDeletion } from '../files.model';

interface FilesPageState {
  list: FileList | null;
  loading: boolean;
  /** Paths being renamed or deleted, for pending buttons. */
  pending: string[];
  /** The delete waiting for its confirmation. */
  deleting: FileDeletion | null;
}

const initialState: FilesPageState = {
  list: null,
  loading: false,
  pending: [],
  deleting: null,
};

/**
 * The Files page's data, provided by the page and gone with it:
 * the folder shown and every action with its toast — in the Linux session (`LinuxSessionStore`,
 * shared with the other pages and the top bar). A Linux session that ended (idle, the app's
 * sign-out, closed elsewhere) shows the sign-in again. Uploads are `UploadsStore`'s, so they keep
 * going when the page closes; the folder reloads when one lands in it.
 */
export const FilesPageStore = signalStore(
  withState<FilesPageState>(initialState),
  withComputed((_, linuxSessionStore = inject(LinuxSessionStore)) => ({
    checked: linuxSessionStore.checked,
    session: linuxSessionStore.session,
  })),
  withMethods((store, linuxSessionStore = inject(LinuxSessionStore)) => ({
    /** The Linux session ended (the error says so): back to the sign-in. */
    _sessionEnded(error: unknown): void {
      if (apiErrorCode(error) === FILES_ERROR_CODES.linuxSessionRequired) {
        linuxSessionStore.ended();
        patchState(store, { list: null, loading: false });
      }
    },
  })),
  withMethods((store, translator = inject(Translator)) => ({
    /** A failure in a toast — or, when the Linux session ended, back to the sign-in. */
    _failed(error: unknown): void {
      store._sessionEnded(error);
      toast.error(translator.t('files.actionFailed'), {
        description: translator.t(...apiErrorText(error)),
      });
    },

    _folder(): string {
      return store.list()?.path ?? store.session()?.home ?? '/';
    },
  })),
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
      uploadsStore = inject(UploadsStore),
    ) => ({
      /** Signs in as a Linux user; rejects with the server's error (the form shows it). */
      signIn: (request: LinuxSignInRequest): Promise<void> => linuxSessionStore.signIn(request),

      signOut: rxMethod<void>(tap(() => linuxSessionStore.signOut())),

      /** The Linux session changed: its home opened, or (gone) nothing of it left. */
      sessionChanged(home: string | null): void {
        if (home) store.open(home);
        else patchState(store, { list: null, loading: false, deleting: null });
      },

      refresh(): void {
        store.open(store._folder());
      },

      downloadUrl(entry: FileEntry): string {
        return filesApi.downloadUrl(joinPath(store._folder(), entry.name));
      },

      /** The name dialog's submission; rejects with the server's refusal (the dialog shows it). */
      async newFolder(name: string): Promise<void> {
        try {
          await firstValueFrom(filesApi.newFolder(store._folder(), name));
        } catch (error) {
          store._sessionEnded(error);
          throw error;
        }
        toast.success(translator.t('files.created', { name }));
        await lastValueFrom(store._reload(), { defaultValue: undefined });
      },

      /** The name dialog's submission; rejects with the server's refusal (the dialog shows it). */
      async rename(entry: FileEntry, input: string): Promise<void> {
        const from = joinPath(store._folder(), entry.name);
        patchState(store, { pending: [...store.pending(), from] });
        try {
          await firstValueFrom(filesApi.rename(from, renameTarget(store._folder(), input)));
        } catch (error) {
          store._sessionEnded(error);
          throw error;
        } finally {
          patchState(store, { pending: store.pending().filter((p) => p !== from) });
        }
        toast.success(translator.t('files.renamed'));
        await lastValueFrom(store._reload(), { defaultValue: undefined });
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

      /** Into the folder shown; the uploads go on when the page closes. */
      upload: rxMethod<File[]>(
        tap((files) => uploadsStore.upload({ folder: store._folder(), files, replace: false })),
      ),

      /** An upload batch finished: the folder again, if it's the one shown. */
      _uploadFinished: rxMethod<string>(
        pipe(
          filter((folder) => !!store.session() && store._folder() === folder),
          switchMap(() => store._reload()),
        ),
      ),
    }),
  ),
  withHooks(
    (
      store,
      linuxSessionStore = inject(LinuxSessionStore),
      uploadsStore = inject(UploadsStore),
    ) => ({
      onInit() {
        linuxSessionStore.check();
        store._uploadFinished(uploadsStore.finished$);
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
    }),
  ),
);
