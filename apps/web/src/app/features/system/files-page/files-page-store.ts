import { HttpErrorResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { patchState, signalStore, withHooks, withMethods, withState } from '@ngrx/signals';
import {
  FILES_ERROR_CODES,
  type FileEntry,
  type FileList,
  type FileSummary,
  type LinuxSession,
  type LinuxSignInRequest,
} from '@laris/shared';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import { toast } from '@spartan-ng/brain/sonner';
import {
  catchError,
  EMPTY,
  exhaustMap,
  firstValueFrom,
  lastValueFrom,
  pipe,
  switchMap,
  tap,
} from 'rxjs';
import { FilesApi } from '../../../core/files/files-api';
import { Translator } from '../../../core/i18n/translator';
import { apiErrorText } from '../../../shared/forms/submission-errors';
import { joinPath, renameTarget } from '../files-paths';
import type { Upload } from '../files.model';

const codeOf = (error: unknown) =>
  error instanceof HttpErrorResponse ? (error.error as { code?: string } | null)?.code : undefined;

interface FilesPageState {
  /** Asked the server whether a Linux session is open. */
  checked: boolean;
  session: LinuxSession | null;
  list: FileList | null;
  loading: boolean;
  uploads: Upload[];
  /** Paths being renamed or deleted, for pending buttons. */
  pending: string[];
}

const initialState: FilesPageState = {
  checked: false,
  session: null,
  list: null,
  loading: false,
  uploads: [],
  pending: [],
};

let nextUpload = 0;

/**
 * The Files page's data, provided by the page and gone with it (docs/plans/files_and_terminal.md):
 * the Linux session, the folder shown, uploads with their progress, and every action with its
 * toast. A Linux session that ended (idle, the app's sign-out) shows the sign-in again.
 */
export const FilesPageStore = signalStore(
  withState<FilesPageState>(initialState),
  withMethods((store, filesApi = inject(FilesApi), translator = inject(Translator)) => {
    /** A failure in a toast — or, when the Linux session ended, back to the sign-in. */
    const failed = (error: unknown) => {
      if (codeOf(error) === FILES_ERROR_CODES.linuxSessionRequired) {
        patchState(store, { session: null, list: null, loading: false });
      }
      toast.error(translator.t('files.actionFailed'), {
        description: translator.t(...apiErrorText(error)),
      });
    };
    const folder = () => store.list()?.path ?? store.session()?.home ?? '/';

    // A click on another folder while one loads: the latest wins.
    const open = rxMethod<string>(
      pipe(
        tap(() => patchState(store, { loading: true })),
        switchMap((path) =>
          filesApi.list(path).pipe(
            tap((list) => patchState(store, { list, loading: false })),
            catchError((error: unknown) => {
              patchState(store, { loading: false });
              failed(error);
              return EMPTY;
            }),
          ),
        ),
      ),
    );
    const refresh = () => open(folder());
    /**
     * The folder shown, again after a change (the action waits for it). Not through `open`: it
     * mustn't cancel a folder clicked meanwhile, and that folder wins over it.
     */
    const reload = async (): Promise<void> => {
      const path = folder();
      try {
        const list = await firstValueFrom(filesApi.list(path));
        if (!store.loading() && folder() === path) patchState(store, { list });
      } catch (error) {
        failed(error);
      }
    };

    return {
      check: rxMethod<void>(
        pipe(
          exhaustMap(() =>
            filesApi.session().pipe(
              tap(({ session }) => {
                patchState(store, { session, checked: true });
                if (session) open(session.home);
              }),
              catchError((error: unknown) => {
                patchState(store, { checked: true });
                failed(error);
                return EMPTY;
              }),
            ),
          ),
        ),
      ),

      /** Signs in as a Linux user; rejects with the server's error (the form shows it). */
      async signIn(request: LinuxSignInRequest): Promise<void> {
        const session = await firstValueFrom(filesApi.signIn(request));
        patchState(store, { session });
        open(session.home);
      },

      async signOut(): Promise<void> {
        try {
          await firstValueFrom(filesApi.signOut());
          patchState(store, { session: null, list: null, uploads: [] });
          toast.success(translator.t('files.closed'));
        } catch (error) {
          failed(error);
        }
      },

      open,
      refresh,

      downloadUrl(entry: FileEntry): string {
        return filesApi.downloadUrl(joinPath(folder(), entry.name));
      },

      async newFolder(name: string): Promise<boolean> {
        try {
          await firstValueFrom(filesApi.newFolder(folder(), name));
          toast.success(translator.t('files.created', { name }));
          await reload();
          return true;
        } catch (error) {
          failed(error);
          return false;
        }
      },

      async rename(entry: FileEntry, input: string): Promise<boolean> {
        const from = joinPath(folder(), entry.name);
        patchState(store, { pending: [...store.pending(), from] });
        try {
          await firstValueFrom(filesApi.rename(from, renameTarget(folder(), input)));
          toast.success(translator.t('files.renamed'));
          await reload();
          return true;
        } catch (error) {
          failed(error);
          return false;
        } finally {
          patchState(store, { pending: store.pending().filter((p) => p !== from) });
        }
      },

      /** What deleting it would remove (for the confirmation); a failure says why in a toast. */
      async summary(entry: FileEntry): Promise<FileSummary> {
        try {
          return await firstValueFrom(filesApi.summary(joinPath(folder(), entry.name)));
        } catch (error) {
          failed(error);
          throw error;
        }
      },

      async delete(entry: FileEntry): Promise<void> {
        const path = joinPath(folder(), entry.name);
        patchState(store, { pending: [...store.pending(), path] });
        try {
          await firstValueFrom(filesApi.delete(path));
          toast.success(translator.t('files.deleted', { name: entry.name }));
        } catch (error) {
          failed(error);
        } finally {
          patchState(store, { pending: store.pending().filter((p) => p !== path) });
        }
        // Not after the Linux session ended (the sign-in is shown).
        if (store.session()) await reload();
      },

      /**
       * Uploads files into the folder shown, one after another. Returns the ones whose name is
       * taken there already (`replace` false): the page asks before replacing them.
       */
      async upload(files: File[], replace = false): Promise<File[]> {
        const target = folder();
        const taken: File[] = [];
        for (const file of files) {
          const id = nextUpload++;
          const set = (change: Partial<Upload>) =>
            patchState(store, {
              uploads: store.uploads().map((u) => (u.id === id ? { ...u, ...change } : u)),
            });
          patchState(store, {
            uploads: [...store.uploads(), { id, name: file.name, progress: 0, state: 'uploading' }],
          });
          try {
            await lastValueFrom(
              filesApi.upload(target, file, replace).pipe(tap((progress) => set({ progress }))),
              { defaultValue: 1 },
            );
            set({ progress: 1, state: 'done' });
          } catch (error) {
            if (codeOf(error) === FILES_ERROR_CODES.exists && !replace) {
              patchState(store, { uploads: store.uploads().filter((u) => u.id !== id) });
              taken.push(file);
            } else {
              set({ state: 'failed' });
              failed(error);
            }
          }
        }
        if (files.length > taken.length) await reload();
        return taken;
      },
    };
  }),
  withHooks((store) => ({
    onInit() {
      store.check();
    },
  })),
);
