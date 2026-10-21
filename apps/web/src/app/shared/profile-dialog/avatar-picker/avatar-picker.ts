import { Component, computed, input, output } from '@angular/core';
import type { PublicUser } from '@laris/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCamera } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButton } from '@ui/button';
import { UserAvatar } from '../../user-avatar/user-avatar';
import { PICTURE_ACCEPT } from '../profile-dialog.constants';
import type { PictureProblem } from '../profile-dialog.model';

/** The picture in the edit dialog: the current one (or the chosen one), choose, remove. */
@Component({
  selector: 'laris-avatar-picker',
  imports: [HlmButton, NgIcon, TranslatePipe, UserAvatar],
  providers: [provideIcons({ lucideCamera })],
  templateUrl: './avatar-picker.html',
})
export class AvatarPicker {
  readonly user = input.required<PublicUser | null>();
  /** The chosen picture, not saved yet. */
  readonly preview = input<string | null>(null);
  /** "Remove picture" was chosen, not saved yet. */
  readonly removed = input(false);
  readonly problem = input<PictureProblem | null>(null);
  readonly preparing = input(false);

  readonly choose = output<File>();
  readonly remove = output<void>();

  protected readonly accept = PICTURE_ACCEPT;
  /** The user as the dialog would leave them: without the picture once removed. */
  protected readonly shown = computed(() => {
    const user = this.user();
    return user && this.removed() ? { ...user, avatar: null } : user;
  });
  protected readonly hasPicture = computed(() => !!this.preview() || !!this.shown()?.avatar);

  protected picked(event: Event): void {
    const field = event.target as HTMLInputElement;
    const file = field.files?.[0];
    field.value = ''; // the same file can be chosen again
    if (file) this.choose.emit(file);
  }
}
