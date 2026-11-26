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
  exhaustMap,
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
import { UNOPENABLE } from './files-page-store.constants';

interface FilesPageState {
  list: FileList | null;
  loading: boolean;
  /** Files as administrator: every request as root, through the unlocked sudo. Off each visit. */
  asRoot: boolean;
  /** Paths being renamed or deleted, for pending buttons. */
  pending: string[];
  /** The delete waiting for its confirmation. */
  deleting: FileDeletion | null;
  /** A folder asked for that doesn't open (gone, not allowed, not a folder): the page goes home. */
  failed: string | null;
}

const initialState: FilesPageState = {
  list: null,
  loading: false,
  asRoot: false,
  pending: [],
  deleting: null,
  failed: null,
};

/**
 * The Files page's data, provided by the page and gone with it:
 * the folder shown and every action with its toast — in the Linux session (`LinuxSessionStore`,
 * shared with the other pages and the top bar). A Linux session that ended (idle, the app's
 * sign-out, closed elsewhere) shows the sign-in again. Uploads are `UploadsStore`'s, so they keep
 * going when the page closes; the folder reloads when one lands in it. As administrator (unlocked
 * with sudo, off on every visit), every request goes as root, until it's locked again or sudo locks.
 * Which folder is open is the page's (the address): it asks `open`, and goes home on `failed`.
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
        patchState(store, { list: null, loading: false, asRoot: false });
      }
    },

    /** A root request went through: sudo's minutes start again, as on the server. */
    _usedRoot(root: boolean): void {
      if (root) linuxSessionStore.sudoUsed();
    },

    /**
     * The error says sudo is locked: so it is, for every page and the top bar — and, working as
     * root, the page goes back to the account (the hook following sudo's minutes, with its toast).
     */
    _sudoEnded(error: unknown): boolean {
      if (apiErrorCode(error) !== FILES_ERROR_CODES.sudoRequired) return false;
      linuxSessionStore.sudoEnded();
      return true;
    },
  })),
  withMethods((store, translator = inject(Translator)) => ({
    /** sudo locked while working as root: back to the account, said in a toast. */
    _rootLocked(): boolean {
      if (!store.asRoot()) return false;
      patchState(store, { asRoot: false });
      toast.info(
        translator.t('files.admin.lockedToast', { account: store.session()?.username ?? '' }),
      );
      return true;
    },
  })),
  withMethods((store, translator = inject(Translator)) => ({
    /** A failure in a toast — or, when the Linux session ended, back to the sign-in. */
    _failed(error: unknown): void {
      store._sessionEnded(error);
      // Working as root: the toast that Files is the account's again says it.
      if (store.asRoot() && store._sudoEnded(error)) return;
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
        tap(() => patchState(store, { loading: true, failed: null })),
        switchMap((path) => {
          const root = store.asRoot();
          return filesApi.list(path, root).pipe(
            tap((list) => {
              // Locked or unlocked meanwhile: that mode's own listing is on its way.
              if (store.asRoot() !== root) return;
              store._usedRoot(root);
              patchState(store, { list, loading: false });
            }),
            catchError((error: unknown) => {
              patchState(store, { loading: false });
              store._failed(error);
              if (UNOPENABLE.includes(apiErrorCode(error) ?? ''))
                patchState(store, { failed: path });
              return EMPTY;
            }),
          );
        }),
      ),
    ),

    /**
     * The folder shown, again after a change. Not through `open`: it mustn't cancel a folder
     * clicked meanwhile, and that folder wins over it.
     */
    _reload(): Observable<unknown> {
      return defer(() => {
        const path = store._folder();
        const root = store.asRoot();
        return filesApi.list(path, root).pipe(
          tap((list) => {
            store._usedRoot(root);
            if (!store.loading() && store._folder() === path && store.asRoot() === root)
              patchState(store, { list });
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
  withMethods((store, filesApi = inject(FilesApi)) => ({
    /** Back to the account: its folder again — one it may not open is `failed`, without a toast. */
    _openAsAccount: rxMethod<string>(
      switchMap((path) => {
        patchState(store, { loading: true, failed: null });
        return filesApi.list(path).pipe(
          tap((list) => patchState(store, { list, loading: false })),
          catchError((error: unknown) => {
            patchState(store, { loading: false });
            if (apiErrorCode(error) === FILES_ERROR_CODES.permissionDenied) {
              patchState(store, { failed: path });
            } else store._failed(error);
            return EMPTY;
          }),
        );
      }),
    ),

    refresh(): void {
      store.open(store._folder());
    },
  })),
  withMethods((store) => ({
    /** Back to the account: the folder shown again as it — home (the page) when it may not open it. */
    lockRoot(): void {
      if (!store.asRoot()) return;
      patchState(store, { asRoot: false });
      store._openAsAccount(store._folder());
    },

    /** sudo locked elsewhere (the top bar, its time ran out) while working as root. */
    sudoLocked(): void {
      if (store._rootLocked()) store._openAsAccount(store._folder());
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

      /** The Linux session changed: as the account again (the page opens its folder), or gone. */
      sessionChanged(signedIn: boolean): void {
        patchState(store, { asRoot: false, failed: null });
        if (!signedIn) patchState(store, { list: null, loading: false, deleting: null });
      },

      /**
       * Files as administrator: the folder shown, as root — through the sudo prompt while locked
       * (one prompt opens both). Not available on this machine: said in a toast, still locked.
       */
      unlockRoot: rxMethod<void>(
        exhaustMap(() => {
          const path = store._folder();
          return linuxSessionStore
            .withSudo$(() => filesApi.list(path, true))
            .pipe(
              tap((list) => {
                if (!list) return;
                patchState(store, { asRoot: true, list, loading: false });
              }),
              catchError((error: unknown) => {
                store._failed(error);
                return EMPTY;
              }),
            );
        }),
      ),

      downloadUrl(entry: FileEntry): string {
        return filesApi.downloadUrl(joinPath(store._folder(), entry.name), store.asRoot());
      },

      /** The name dialog's submission; rejects with the server's refusal (the dialog shows it). */
      async newFolder(name: string): Promise<void> {
        const root = store.asRoot();
        try {
          await firstValueFrom(filesApi.newFolder(store._folder(), name, root));
        } catch (error) {
          store._sessionEnded(error);
          store._sudoEnded(error);
          throw error;
        }
        store._usedRoot(root);
        toast.success(translator.t('files.created', { name }));
        await lastValueFrom(store._reload(), { defaultValue: undefined });
      },

      /** The name dialog's submission; rejects with the server's refusal (the dialog shows it). */
      async rename(entry: FileEntry, input: string): Promise<void> {
        const from = joinPath(store._folder(), entry.name);
        const root = store.asRoot();
        patchState(store, { pending: [...store.pending(), from] });
        try {
          await firstValueFrom(filesApi.rename(from, renameTarget(store._folder(), input), root));
        } catch (error) {
          store._sessionEnded(error);
          store._sudoEnded(error);
          throw error;
        } finally {
          patchState(store, { pending: store.pending().filter((p) => p !== from) });
        }
        store._usedRoot(root);
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
            filesApi.summary(joinPath(store._folder(), entry.name), store.asRoot()).pipe(
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
            const root = store.asRoot();
            return concat(
              filesApi.delete(path, root).pipe(
                tap({
                  subscribe: () => patchState(store, { pending: [...store.pending(), path] }),
                  complete: () => {
                    store._usedRoot(root);
                    toast.success(translator.t('files.deleted', { name: entry.name }));
                  },
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
        tap((files) =>
          uploadsStore.upload({
            folder: store._folder(),
            files,
            replace: false,
            root: store.asRoot(),
          }),
        ),
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
        // Signed in here or elsewhere (the top bar, another page), or gone.
        let shown: string | null = null;
        effect(() => {
          const session = store.session();
          const key = session ? `${session.username}:${session.home}` : null;
          if (key === shown) return;
          shown = key;
          untracked(() => store.sessionChanged(session !== null));
        });
        // "Lock now" in the top bar, or sudo's time ran out, while working as root.
        effect(() => {
          if (linuxSessionStore.sudoMinutes() === null && untracked(store.asRoot))
            untracked(() => store.sudoLocked());
        });
      },
    }),
  ),
);
