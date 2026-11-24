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
  /** Uploads whose name was taken there: one question for all of them. */
  clashes: UploadClash[];
}

const initialState: UploadsState = { uploads: [], clashes: [] };

let nextUpload = 0;

/**
 * Uploads for the whole signed-in session, so they keep going when the person leaves Files: the
 * queue with each file's progress, and the names taken where they went (the uploads panel asks
 * about them). Reset on sign-out like every global store: running uploads end there.
 */
export const UploadsStore = signalStore(
  { providedIn: 'root' },
  withState<UploadsState>(initialState),
  withProps(() => ({ _finished: new Subject<string>(), _reset: new Subject<void>() })),
  withProps((store) => ({
    /** The folder of each upload batch that finished (Files reloads it when it's shown). */
    finished$: store._finished.asObservable(),
  })),
  withComputed((store) => ({
    running: computed(() =>
      store.uploads().some((u) => u.state === 'waiting' || u.state === 'uploading'),
    ),
    /** "Uploading 2 of 5": the file on its way, of all in the list. */
    position: computed(() => {
      const uploads = store.uploads();
      const finished = uploads.filter((u) => u.state === 'done' || u.state === 'failed').length;
      return { current: Math.min(finished + 1, uploads.length), total: uploads.length };
    }),
  })),
  withMethods(
    (store, linuxSessionStore = inject(LinuxSessionStore), translator = inject(Translator)) => ({
      _set(id: number, change: Partial<Upload>): void {
        patchState(store, {
          uploads: store.uploads().map((u) => (u.id === id ? { ...u, ...change } : u)),
        });
      },

      _failed(name: string, error: unknown): void {
        if (apiErrorCode(error) === FILES_ERROR_CODES.linuxSessionRequired)
          linuxSessionStore.ended();
        toast.error(translator.t('uploads.failedToast', { name }), {
          description: translator.t(...apiErrorText(error)),
        });
      },
    }),
  ),
  withMethods((store, filesService = inject(FilesService)) => ({
    /**
     * Uploads files into their folder, batch after batch and file after file. They're listed as
     * waiting at once; names taken there already (`replace` false) become `clashes`.
     */
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
          let started = 0;
          const uploads = from(queued).pipe(
            concatMap(({ file, id }) => {
              // Gone from the list: the store was reset (signed out) before its turn.
              if (!store.uploads().some((u) => u.id === id)) return EMPTY;
              store._set(id, { state: 'uploading' });
              started++;
              return filesService.upload(folder, file, replace).pipe(
                tap({
                  next: (progress) => store._set(id, { progress }),
                  complete: () => store._set(id, { progress: 1, state: 'done' }),
                }),
                catchError((error: unknown) => {
                  if (apiErrorCode(error) === FILES_ERROR_CODES.exists && !replace) {
                    patchState(store, { uploads: store.uploads().filter((u) => u.id !== id) });
                    taken.push({ folder, file });
                  } else {
                    store._set(id, { state: 'failed' });
                    store._failed(file.name, error);
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
              if (started > taken.length) store._finished.next(folder);
              if (taken.length) patchState(store, { clashes: [...store.clashes(), ...taken] });
              return EMPTY;
            }),
          ).pipe(takeUntil(store._reset));
        }),
      ),
    ),

    /** The finished list closed; not while a file is still on its way. */
    clear(): void {
      if (!store.running()) patchState(store, { uploads: [] });
    },

    /** Ends running uploads and forgets them (sign-out). */
    reset(): void {
      // The list first: the next batch, started as the running one ends, finds its files gone.
      patchState(store, initialState);
      store._reset.next();
    },
  })),
  withMethods((store) => ({
    /** The clash question answered: replaced (uploaded again) or kept. */
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
  withHooks((store, authStore = inject(AuthStore)) => ({
    onInit() {
      effect(() => {
        if (!authStore.isAuthenticated()) store.reset();
      });
    },
  })),
);
