import {
  Component,
  DOCUMENT,
  effect,
  type ElementRef,
  inject,
  linkedSignal,
  signal,
  viewChild,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideChevronDown, lucideCircleCheck, lucideCircleX, lucideX } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmAlertDialogImports } from '@ui/alert-dialog';
import { HlmButton } from '@ui/button';
import { HlmProgressImports } from '@ui/progress';
import { joinPath } from '../../core/files/files-paths';
import type { UploadClash } from '../../core/files/files.model';
import { UploadsStore } from '../../core/files/uploads-store';
import { PANEL_HEIGHT_PROPERTY } from './uploads-panel.constants';

/**
 * The uploads on every page, at the bottom end corner while the list isn't empty: each file's
 * progress, and the question before replacing files whose name was taken. While a file uploads,
 * leaving the site asks first (the browser's own "Leave site?").
 */
@Component({
  selector: 'ilex-uploads-panel',
  imports: [HlmAlertDialogImports, HlmButton, HlmProgressImports, NgIcon, TranslatePipe],
  providers: [provideIcons({ lucideChevronDown, lucideCircleCheck, lucideCircleX, lucideX })],
  templateUrl: './uploads-panel.html',
})
export class UploadsPanel {
  protected readonly uploadsStore = inject(UploadsStore);
  private readonly document = inject(DOCUMENT);
  private readonly panel = viewChild<ElementRef<HTMLElement>>('panel');

  protected readonly collapsed = signal(false);
  /** The clashes asked about, kept while the question closes (so it doesn't go blank). */
  protected readonly shownClashes = linkedSignal<UploadClash[], UploadClash[]>({
    source: this.uploadsStore.clashes,
    computation: (clashes, previous) => (clashes.length ? clashes : (previous?.value ?? [])),
  });
  protected readonly pathOf = (clash: UploadClash) => joinPath(clash.folder, clash.file.name);

  constructor() {
    // Only while uploading: a `beforeunload` listener keeps some browsers from caching the page.
    effect((onCleanup) => {
      if (!this.uploadsStore.running()) return;
      const window = this.document.defaultView;
      const ask = (event: BeforeUnloadEvent) => event.preventDefault();
      window?.addEventListener('beforeunload', ask);
      onCleanup(() => window?.removeEventListener('beforeunload', ask));
    });

    // The toasts sit in the same corner: styles.css lifts them by the panel's height.
    effect((onCleanup) => {
      const panel = this.panel()?.nativeElement;
      const root = this.document.documentElement;
      if (!panel || typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(() =>
        root.style.setProperty(PANEL_HEIGHT_PROPERTY, `${panel.offsetHeight}px`),
      );
      observer.observe(panel);
      onCleanup(() => {
        observer.disconnect();
        root.style.removeProperty(PANEL_HEIGHT_PROPERTY);
      });
    });
  }

  /** Closed without Replace (Keep, Escape): kept — as soon as it starts closing. */
  protected clashQuestionChanged(state: 'open' | 'closed'): void {
    if (state === 'closed' && this.uploadsStore.clashes().length)
      this.uploadsStore.answerClashes(false);
  }
}
