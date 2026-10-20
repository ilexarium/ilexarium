import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LANGUAGE_NAMES } from '@homelab/i18n';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideKeyRound, lucideLogOut, lucidePencil } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmAlertDialogImports } from '@ui/alert-dialog';
import { HlmButton } from '@ui/button';
import { HlmCardImports } from '@ui/card';
import { AuthStore } from '../../../core/auth/auth-store';
import { ProfileStore } from '../../../core/profile/profile-store';
import { LanguageService } from '../../../core/i18n/language';
import { Formatter } from '../../../shared/format/formatter';
import { ProfileDialog } from '../../../shared/profile-dialog/profile-dialog';
import { displayNameOf, UserAvatar } from '../../../shared/user-avatar/user-avatar';
import { ProfilePageStore } from './profile-page-store';

/**
 * The signed-in person's profile (`/profile`, titled "Profile"): who they are, their language,
 * and their security — the password, signing out everywhere. Reached from the user menu.
 */
@Component({
  selector: 'app-profile-page',
  imports: [
    HlmAlertDialogImports,
    HlmButton,
    HlmCardImports,
    NgIcon,
    ProfileDialog,
    RouterLink,
    TranslatePipe,
    UserAvatar,
  ],
  providers: [ProfilePageStore, provideIcons({ lucideKeyRound, lucideLogOut, lucidePencil })],
  host: { class: 'mx-auto grid w-full max-w-3xl gap-6' },
  templateUrl: './profile-page.html',
})
export class ProfilePage {
  protected readonly auth = inject(AuthStore);
  protected readonly store = inject(ProfilePageStore);
  protected readonly languages = inject(LanguageService);
  protected readonly profile = inject(ProfileStore);
  private readonly format = inject(Formatter);
  protected readonly names = LANGUAGE_NAMES;
  protected readonly editing = signal(false);

  protected readonly name = computed(() => displayNameOf(this.auth.user()));
  protected readonly memberSince = computed(() => {
    const createdAt = this.auth.user()?.createdAt;
    return createdAt ? this.format.date(createdAt) : '';
  });
}
