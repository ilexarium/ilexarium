import { Component, inject, input, output } from '@angular/core';
import type { AiLibraryDetail, AiLibraryModel } from '@homelab/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideChevronDown, lucideDownload, lucideHeart } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButton } from '@ui/button';
import { HlmSkeleton } from '@ui/skeleton';
import { EmptyState } from '../../../shared/empty-state/empty-state';
import { Formatter } from '../../../shared/format/formatter';
import { StatusBadge } from '../../../shared/status-badge/status-badge';

/**
 * Hugging Face search results: each repository with its downloads and likes; opened, the sizes
 * it offers, each with Download. Presentational: `toggle` opens or closes one, `download` asks
 * for a size.
 */
@Component({
  selector: 'app-library-results',
  imports: [EmptyState, HlmButton, HlmSkeleton, NgIcon, StatusBadge, TranslatePipe],
  providers: [provideIcons({ lucideChevronDown, lucideDownload, lucideHeart })],
  host: { class: 'block' },
  templateUrl: './library-results.html',
})
export class LibraryResults {
  readonly results = input.required<AiLibraryModel[]>();
  readonly opened = input<{ id: string; detail: AiLibraryDetail | null } | null>(null);
  /** A download is running: no other can start. */
  readonly downloading = input(false);
  /** Installed model names. */
  readonly installed = input<string[]>([]);

  readonly toggle = output<string>();
  readonly download = output<string>();

  protected readonly format = inject(Formatter);
}
