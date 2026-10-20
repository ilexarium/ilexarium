import { Component, computed, input } from '@angular/core';
import type { PublicUser } from '@homelab/shared';
import { HlmAvatarImports } from '@ui/avatar';

/**
 * A person's avatar: their picture, or their initials (from the display name, else the
 * username) while there is none or it doesn't load. Decorative: the name is always next to it.
 */
@Component({
  selector: 'app-user-avatar',
  imports: [HlmAvatarImports],
  // The size and the initials' text size come from the place it's used (`class="size-7 text-xs"`).
  host: { class: 'inline-flex shrink-0' },
  templateUrl: './user-avatar.html',
})
export class UserAvatar {
  readonly user = input.required<PublicUser | null>();
  /** A picture chosen but not saved yet (the edit dialog's preview) — shown instead. */
  readonly preview = input<string | null>(null);

  protected readonly picture = computed(() => this.preview() ?? this.user()?.avatar ?? null);
  protected readonly initials = computed(() => initialsOf(this.user()));
}

/** How a person is named in the app: their display name, else their username. */
export function displayNameOf(user: PublicUser | null): string {
  return user?.displayName?.trim() || user?.username || '';
}

/** Two letters: the first of the first and last word of the name, or the username's first two. */
export function initialsOf(user: PublicUser | null): string {
  const words = (user?.displayName ?? '').trim().split(/\s+/u).filter(Boolean);
  const letters =
    words.length > 1
      ? [...words[0]][0] + [...words.at(-1)!][0]
      : [...(words[0] ?? user?.username ?? '?')].slice(0, 2).join('');
  return letters.toLocaleUpperCase();
}
