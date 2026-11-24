import { computed, effect, inject } from '@angular/core';
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
import { FILES_ERROR_CODES } from '@ilex/shared';
import { toast } from '@spartan-ng/brain/sonner';
import {
  catchError,
  concat,
  concatMap,
  defer,
  EMPTY,
  from,
  ignoreElements,
  map,
  pipe,
  Subject,
  takeUntil,
  tap,
} from 'rxjs';
import { apiErrorCode, apiErrorText } from '../../shared/forms/submission-errors';
import { AuthStore } from '../auth/auth-store';
import { Translator } from '../i18n/translator';
import { LinuxSessionStore } from '../linux/linux-session-store';
import type { Upload, UploadClash, UploadRequest } from './files.model';
import { FilesService } from './services/files-service';

interface UploadsState {
  uploads: Upload[];
  /** Names taken where they went: one question for all of them. */
  clashes: UploadClash[];
}

const initialState: UploadsState = { uploads: [], clashes: [] };

let nextUpload = 0;

/**
 * Uploads for the whole signed-in session, so they keep going when the person leaves Files.
 * They're the Linux account's: when its session ends or another account signs in, running
 * uploads end and the list and the questions go — as at the app's sign-out.
 */
export const UploadsStore = signalStore(
  { providedIn: 'root' },
  withState<UploadsState>(initialState),
  withProps(() => ({ _finished: new Subject<string>(), _reset: new Subject<void>() })),
  withProps((store) => ({
    /** The folder of each batch that put a file there (Files reloads it when it's shown). */
    finished$: store._finished.asObservable(),
  })),
  withComputed((store) => ({
    running: computed(() =>
      store.uploads().some((u) => u.state === 'waiting' || u.state === 'uploading'),
    ),
    position: computed(() => {
      const uploads = store.uploads();
      const finished = uploads.filter((u) => u.state === 'done' || u.state === 'failed').length;
      return { current: Math.min(finished + 1, uploads.length), total: uploads.length };
    }),
  })),
  withMethods((store) => ({
    _set(id: number, change: Partial<Upload>): void {
      patchState(store, {
        uploads: store.uploads().map((u) => (u.id === id ? { ...u, ...change } : u)),
      });
    },

    reset(): void {
      // The list first: the next batch, started as the running one ends, finds its files gone.
      patchState(store, initialState);
      store._reset.next();
    },
  })),
  withMethods(
    (
      store,
      filesService = inject(FilesService),
      linuxSessionStore = inject(LinuxSessionStore),
      translator = inject(Translator),
    ) => ({
      /** Batch after batch, file after file; a batch's files are listed as waiting at once. */
      upload: rxMethod<UploadRequest>(
        pipe(
          map((request) => {
            const queued = request.files.map((file) => ({ file, id: nextUpload++ }));
            patchState(store, {
              uploads: [
                ...store.uploads(),
                ...queued.map(({ file, id }) => ({
                  id,
                  name: file.name,
                  progress: 0,
                  state: 'waiting' as const,
                })),
              ],
            });
            return { ...request, queued };
          }),
          concatMap(({ folder, replace, queued }) => {
            const taken: UploadClash[] = [];
            let landed = 0;
            const uploads = from(queued).pipe(
              concatMap(({ file, id }) => {
                // Gone from the list: reset before its turn.
                if (!store.uploads().some((u) => u.id === id)) return EMPTY;
                store._set(id, { state: 'uploading' });
                return filesService.upload(folder, file, replace).pipe(
                  tap({
                    next: (progress) => store._set(id, { progress }),
                    complete: () => {
                      landed++;
                      store._set(id, { progress: 1, state: 'done' });
                    },
                  }),
                  catchError((error: unknown) => {
                    const code = apiErrorCode(error);
                    if (code === FILES_ERROR_CODES.exists && !replace) {
                      patchState(store, { uploads: store.uploads().filter((u) => u.id !== id) });
                      taken.push({ folder, file });
                      return EMPTY;
                    }
                    store._set(id, { state: 'failed' });
                    toast.error(translator.t('uploads.failedToast', { name: file.name }), {
                      description: translator.t(...apiErrorText(error)),
                    });
                    // The rest would be refused too: one toast, and the uploads end here.
                    if (code === FILES_ERROR_CODES.linuxSessionRequired) {
                      linuxSessionStore.ended();
                      store.reset();
                    }
                    return EMPTY;
                  }),
                );
              }),
              ignoreElements(),
            );
            return concat(
              uploads,
              defer(() => {
                if (landed) store._finished.next(folder);
                if (taken.length) patchState(store, { clashes: [...store.clashes(), ...taken] });
                return EMPTY;
              }),
            ).pipe(takeUntil(store._reset));
          }),
        ),
      ),

      /** Not while a file is still on its way. */
      clear(): void {
        if (!store.running()) patchState(store, { uploads: [] });
      },
    }),
  ),
  withMethods((store) => ({
    answerClashes(replace: boolean): void {
      const clashes = store.clashes();
      patchState(store, { clashes: [] });
      if (!replace) return;
      // Each into the folder it was asked about.
      for (const folder of new Set(clashes.map((c) => c.folder)))
        store.upload({
          folder,
          files: clashes.filter((c) => c.folder === folder).map((c) => c.file),
          replace: true,
        });
    },
  })),
  withHooks(
    (store, authStore = inject(AuthStore), linuxSessionStore = inject(LinuxSessionStore)) => ({
      onInit() {
        effect(() => {
          if (!authStore.isAuthenticated()) store.reset();
        });
        let account: string | null = null;
        effect(() => {
          const session = linuxSessionStore.session();
          const now = session ? `${session.username}:${session.home}` : null;
          if (account !== null && now !== account) store.reset();
          account = now;
        });
      },
    }),
  ),
);
