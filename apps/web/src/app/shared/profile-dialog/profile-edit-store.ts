import { inject } from '@angular/core';
import { patchState, signalStore, withHooks, withMethods, withState } from '@ngrx/signals';
import type { ProfileForm, ProfileUpdate } from '@laris/shared';
import { toast } from '@spartan-ng/brain/sonner';
import { AuthStore } from '../../core/auth/auth-store';
import { Translator } from '../../core/i18n/translator';
import { ProfileApi } from '../../core/profile/profile-api';
import { PICTURE_ENCODER } from './picture';
import { SOURCE_MAX_BYTES } from './profile-dialog.constants';
import type { PictureChange, PictureProblem } from './profile-dialog.model';

interface ProfileEditState {
  picture: PictureChange;
  pictureProblem: PictureProblem | null;
  /** A chosen file is being drawn. */
  preparing: boolean;
}

const initialState: ProfileEditState = {
  picture: { kind: 'keep' },
  pictureProblem: null,
  preparing: false,
};

/**
 * The edit dialog's data, provided by the dialog and gone with it: the picture chosen (drawn at
 * 600×600 in the browser, previewed, sent only on save) and saving — the picture first, then the
 * fields that changed. The saved user goes to `AuthStore`, so the top bar and the page show it.
 */
export const ProfileEditStore = signalStore(
  withState<ProfileEditState>(initialState),
  withMethods(
    (
      store,
      auth = inject(AuthStore),
      api = inject(ProfileApi),
      encode = inject(PICTURE_ENCODER),
      translator = inject(Translator),
    ) => {
      const forgetPreview = () => {
        const picture = store.picture();
        if (picture.kind === 'set') URL.revokeObjectURL(picture.url);
      };
      return {
        /** Back to the saved profile (the dialog opens again). */
        reset(): void {
          forgetPreview();
          patchState(store, initialState);
        },
        async choosePicture(file: File): Promise<void> {
          if (file.size > SOURCE_MAX_BYTES) {
            patchState(store, { pictureProblem: 'tooLarge' });
            return;
          }
          patchState(store, { preparing: true, pictureProblem: null });
          try {
            const picture = await encode(file);
            forgetPreview();
            patchState(store, {
              picture: { kind: 'set', picture, url: URL.createObjectURL(picture) },
            });
          } catch {
            patchState(store, { pictureProblem: 'unreadable' });
          } finally {
            patchState(store, { preparing: false });
          }
        },
        removePicture(): void {
          forgetPreview();
          patchState(store, { picture: { kind: 'remove' }, pictureProblem: null });
        },
        /** Saves what changed; rejects with the server's error (shown on the form). */
        async save(form: ProfileForm): Promise<void> {
          const picture = store.picture();
          if (picture.kind === 'set') {
            auth.updated((await api.setAvatar(picture.picture)).user);
          } else if (picture.kind === 'remove' && auth.user()?.avatar) {
            auth.updated((await api.removeAvatar()).user);
          }
          // Saved: if the fields fail now, trying again doesn't send the picture again.
          forgetPreview();
          patchState(store, { picture: { kind: 'keep' } });
          const user = auth.user();
          const update: ProfileUpdate = {};
          const displayName = form.displayName.trim();
          const email = form.email.trim();
          if (displayName !== (user?.displayName ?? '')) update.displayName = displayName;
          if (email !== (user?.email ?? '')) update.email = email;
          if (Object.keys(update).length > 0) auth.updated((await api.update(update)).user);
          forgetPreview();
          patchState(store, initialState);
          toast.success(translator.t('profile.saved'));
        },
      };
    },
  ),
  withHooks((store) => ({
    onDestroy() {
      store.reset();
    },
  })),
);
