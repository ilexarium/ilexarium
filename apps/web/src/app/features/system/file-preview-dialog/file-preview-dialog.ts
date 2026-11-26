import { Component, computed, inject, input, linkedSignal, output } from '@angular/core';
import { FILES_LIMITS } from '@ilex/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideDownload, lucideFileX } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButton } from '@ui/button';
import { HlmDialogImports } from '@ui/dialog';
import { Formatter } from '../../../shared/format/formatter';
import type { FilePreview } from '../files.model';

/**
 * A file shown read-only: an image scaled to fit, text as machine text in its own scroll area,
 * or why it can't be shown — always with Download. Presentational: the page store loads it.
 */
@Component({
  selector: 'ilex-file-preview-dialog',
  imports: [HlmButton, HlmDialogImports, NgIcon, TranslatePipe],
  providers: [provideIcons({ lucideDownload, lucideFileX })],
  templateUrl: './file-preview-dialog.html',
})
export class FilePreviewDialog {
  readonly preview = input<FilePreview | null>(null);
  /** Closed in any way (Close, Escape, the X): the parent clears `preview`. */
  readonly closed = output<void>();
  readonly imageLoaded = output<void>();
  readonly imageFailed = output<void>();

  /**
   * Follows whether there's a preview (not each new one: content arriving while it closes mustn't
   * open it again); set false here to close (the dialog then says `closed` once).
   */
  protected readonly shown = linkedSignal(computed(() => this.preview() !== null));
  /** The last preview, kept while the dialog closes so it doesn't go blank. */
  protected readonly shownPreview = linkedSignal<FilePreview | null, FilePreview | null>({
    source: this.preview,
    computation: (preview, previous) => preview ?? previous?.value ?? null,
  });

  private readonly formatter = inject(Formatter);
  protected readonly size = computed(() => {
    const preview = this.shownPreview();
    return preview ? this.formatter.bytes(preview.entry.size) : '';
  });
  protected readonly textLimit = this.formatter.bytes(FILES_LIMITS.previewTextMaxBytes);
  protected readonly imageLimit = this.formatter.bytes(FILES_LIMITS.previewImageMaxBytes);
}
