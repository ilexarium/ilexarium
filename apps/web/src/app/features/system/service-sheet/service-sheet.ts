import { Component, computed, inject, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { SystemServiceDetails } from '@laris/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideScrollText } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButton } from '@ui/button';
import { HlmSheetImports } from '@ui/sheet';
import { HlmSkeleton } from '@ui/skeleton';
import { LanguageService } from '../../../core/i18n/language';
import { Formatter } from '../../../shared/format/formatter';
import { StatusDot } from '../../../shared/status-dot/status-dot';
import type { ServiceRow } from '../system-services.model';

/** A service's details in a side sheet, open while `row` is set. UI only: `closed` when it closes. */
@Component({
  selector: 'laris-service-sheet',
  imports: [HlmButton, HlmSheetImports, HlmSkeleton, NgIcon, RouterLink, StatusDot, TranslatePipe],
  providers: [provideIcons({ lucideScrollText })],
  templateUrl: './service-sheet.html',
})
export class ServiceSheet {
  /** The service as the list knows it; null: closed. */
  readonly row = input<ServiceRow | null>(null);
  /** Its details once read; null until then. */
  readonly details = input<SystemServiceDetails | null>(null);
  /** Why they couldn't be read (an API code), or null. */
  readonly error = input<string | null>(null);
  readonly closed = output<void>();

  protected readonly formatter = inject(Formatter);
  private readonly languageService = inject(LanguageService);
  protected readonly side = computed(() =>
    this.languageService.dir() === 'rtl' ? 'left' : 'right',
  );

  protected dismissed(): void {
    if (this.row()) this.closed.emit();
  }
}
