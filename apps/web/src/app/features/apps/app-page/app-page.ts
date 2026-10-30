import { Component, DOCUMENT, computed, effect, inject, signal, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { type AppRemovalItem, FILES_ERROR_CODES } from '@laris/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowLeft,
  lucideExternalLink,
  lucidePlay,
  lucideRefreshCw,
  lucideSquare,
  lucideTrash2,
} from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButton } from '@ui/button';
import { HlmCardImports } from '@ui/card';
import { HlmLabel } from '@ui/label';
import { HlmSkeleton } from '@ui/skeleton';
import { HlmTextarea } from '@ui/textarea';
import { Formatter } from '../../../shared/format/formatter';
import { StatusBadge } from '../../../shared/status-badge/status-badge';
import { AppFields } from '../app-fields/app-fields';
import { APP_STATE_TONES } from '../apps.constants';
import type { FieldChange } from '../apps.model';
import { RemoveDialog } from '../remove-dialog/remove-dialog';
import { TaskOutput } from '../task-output/task-output';
import { AppPageStore } from './app-page-store';

/** One app: state, Open, Start/Stop, settings (form and files), update, backup, removal. */
@Component({
  selector: 'laris-app-page',
  imports: [
    AppFields,
    HlmButton,
    HlmCardImports,
    HlmLabel,
    HlmSkeleton,
    HlmTextarea,
    NgIcon,
    RemoveDialog,
    RouterLink,
    StatusBadge,
    TaskOutput,
    TranslatePipe,
  ],
  providers: [
    AppPageStore,
    provideIcons({
      lucideArrowLeft,
      lucideExternalLink,
      lucidePlay,
      lucideRefreshCw,
      lucideSquare,
      lucideTrash2,
    }),
  ],
  templateUrl: './app-page.html',
})
export class AppPage {
  protected readonly appPageStore = inject(AppPageStore);
  protected readonly formatter = inject(Formatter);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly location = inject(DOCUMENT).location;
  private readonly removeDialog = viewChild.required(RemoveDialog);
  protected readonly tones = APP_STATE_TONES;
  protected readonly codes = FILES_ERROR_CODES;
  protected readonly backupFirst = signal(true);
  private readonly params = toSignal(this.route.paramMap, { requireSync: true });
  private readonly query = toSignal(this.route.queryParamMap, { requireSync: true });

  protected readonly openUrl = computed(() => {
    const summary = this.appPageStore.summary();
    return summary?.webPort && summary.state !== 'none'
      ? `http://${this.location.hostname}:${summary.webPort}/`
      : null;
  });

  constructor() {
    effect(() => {
      this.appPageStore.open(this.params().get('name') ?? '', this.query().get('folder'));
    });
    effect(() => {
      if (this.appPageStore.removed()) void this.router.navigate(['/apps']);
    });
  }

  protected text(event: Event): string {
    return (event.target as HTMLTextAreaElement).value;
  }

  protected change(change: FieldChange): void {
    this.appPageStore.setValue(change.key, change.value);
  }

  protected askRemove(): void {
    this.removeDialog().open();
    void this.appPageStore.openRemoval();
  }

  protected remove(items: AppRemovalItem[]): void {
    void this.appPageStore.remove(items);
  }
}
